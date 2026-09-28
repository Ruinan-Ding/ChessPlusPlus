**ChessPlusPlus correctness and readiness review — 26 September 2026**

> **Status, 26 Sep 2026: all eleven findings are fixed**, each with a regression test, in
> `2b01cb5` (merged as PR #19) - see PUNCHLIST 6.38. The readiness gaps and the recommendations
> that are not bugs (cross-engine parity for move/combat/panel histories, deployment, moving the
> rules checklist into config) are still open. The report below is unchanged.

The current working tree has a coherent game architecture and substantial automated coverage, but it is **not ready for public competitive multiplayer or an enterprise deployment**. This review found an authorization bypass, a reproducible lost-update condition, and several gameplay errors that the passing suites do not exercise.

This report reviews the working tree on `feature/dev18`, whose reviewed functional changes are now recorded in commit `4d342bf`. Findings describe current behavior across the codebase; they are not limited to bugs introduced by that commit. No application code or game rules were changed for this review.

**Scope and evidence.** I read `CONFIG_BLUEPRINT.md`, `PUNCHLIST.md`, the `CLAUDE.md` pointer, relevant `AGENTS.md` rules, `.claude/skills/config-sync/SKILL.md`, `CODEX_HANDOFF.md`, `IMPLEMENTATION_KICKOFF.md`, `README.md`, and `DEPLOYMENT.md`. The code review covered server consumers, state persistence, configuration, both rules engines, client staging and playback, browser identity, setup navigation, and build/CI settings. Parallel review passes covered server, engine, and client behavior; the findings below were consolidated against the actual source.

Ponytail was unavailable in the installed skill locations accessible to this session. Its [published full skill](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) was read and applied as review guidance; no plugin installation is claimed. Recommendations favor correcting shared decisions and existing flows over introducing a new framework.

| Check performed | Result |
|---|---|
| Angular specs, ChromeHeadless using the installed Windows toolchain | **450 passed** |
| Django `game.testsuite` using the installed Windows virtual environment | **278 passed** |
| TypeScript application and spec projects, `tsc --noEmit` | **Both passed** |
| Angular production build | **Passed, no budget warning** |
| Django `makemigrations --check --dry-run` | **No changes detected** |
| Targeted reproductions using actual methods, engine functions, and an isolated SQLite database | Confirmed the cases described below |

The initial Linux build attempt could not use the Windows esbuild installation, and the sandbox blocked Karma's listener. The successful results above came from the existing Windows toolchain with approved interop. Django's debug environment flag had to be set inside Windows Python because the first WSL invocation did not forward it. These were execution-environment issues, not application test failures.

There was no new full browser match, audio/visual acceptance session, live network e2e run, load test, or deployed-environment test in this review. A targeted TypeScript method reproduction is not a browser playthrough. Existing `SEEN`/`WRITTEN` statuses remain unchanged.

**Confirmed correctness findings.** P1 means a high-priority security, state-integrity, or substantial gameplay problem. P2 means a reproducible functional defect that should be corrected before claiming the affected behavior is complete.

1. **P1 — A rejected room join leaves an authenticated-looking username behind.**

   Source: [consumers.py](server/game/consumers.py), lines 906–929, 472–486, and 987–1056.

   `_handle_join_game_room` assigns the supplied username to `self.username` before checking the room token. An `INVALID_TOKEN` response leaves that assignment intact. `_require_seat` and the leave handler subsequently treat that username as proof of ownership.

   Reproduction: on a fresh consumer, submit a known room ID, its host's name, and an invalid token. The response is `INVALID_TOKEN`, `self.game_id` remains `None`, but `_require_seat` authorizes the room. A subsequent `leave_game_room` invokes resignation in the opponent's favor and closes the room. This was reproduced by executing the actual handlers with isolated mocked repository/broadcast dependencies; it was not a live attack against a running match.

   **Correction:** commit identity only after successful authentication, and make every room operation require a proven seat for the particular room. Test a failed join followed by leave, readiness, mode changes, and other room operations. Merely checking that a supplied name equals `self.username` is insufficient.

2. **P1 — Same-turn writes can silently erase accepted moves.**

   Source: [consumers.py](server/game/consumers.py), `_commit_deployment` at lines 2277–2303 and `_update_game_state` at lines 3028–3066.

   The conditional update checks `turn_number` and an unfinished game. Deployments and held overtime moves change board/history without advancing `turn_number`, so that condition cannot detect another write within the same ply.

   Reproduction against an isolated in-memory SQLite database: read state A and state B at ply 9, write history `[A]` from the first snapshot, then write `[B]` from the second. Both real update calls return `True`; the stored history contains only B. This is a deterministic reproduction of the stale-write interleaving, not a load test. Two tabs can produce it, and a timer working from an earlier snapshot can race a deployment in the same way.

   **Correction:** use a state revision incremented on every accepted state mutation, or equivalent serialization of each room's read/validate/write operation. Add concurrency checks for deployment/deployment and deployment/timer, not just two turn-ending moves. A ply number is a game rule, not a complete state version.

3. **P1 — A panel attack drops other staged overtime actions.**

   Source: [game-room.component.ts](client/src/app/components/game-room/game-room.component.ts), lines 5143–5177; corresponding `attackIntoPanel`/`_handle_panel_attack` commit paths in the two engines.

   `endTurn()` finds the first staged panel attack, sends one `panel_attack`, then returns before dispatching `boardMoves`. In Overtime 2 or 3, any other staged battlefield actions are lost. It does not matter whether the omitted move was staged before or after the panel attack.

   Reproduction using the actual TypeScript method: stage A attacking into a panel and B moving at ply 89. End Turn emits exactly one `panel_attack` and no `make_move`. The panel-attack engine path ends the turn, so the other staged move cannot subsequently be applied as part of it.

   **Correction:** dispatch panel attacks in the same ordered list as other battlefield actions. Both engines need the corresponding continuation/allowance behavior, with the toll and handover occurring once. Exercise panel attacks first and last in two- and three-unit turns.

4. **P1 — A heal between overtime actions is reordered and changes committed HP.**

   Source: [game-room.component.ts](client/src/app/components/game-room/game-room.component.ts), lines 5113–5136 and 5217–5219.

   HP effects are classified relative to the last staged battlefield action, then all `effectsBefore` are attached to the first dispatched move. This changes the chronology of casts made between two units' actions.

   Reproduction used the actual `endTurn` method and `LocalGameService`: a white rook starts at 10 HP, attacks a shieldman, and takes a one-point counter, leaving 9. Mend then raises it to 29. A second unit moves. End Turn sends the 29-HP effect before the rook's attack; the counter applies again and the committed rook has **28 HP**, despite the staged result being 29.

   **Correction:** preserve effects at their actual positions between battlefield actions. Do not group the entire turn's effects only around its first and last messages. Add attack → heal → second-unit-move and attack → damaging-cast → second-unit-move integration cases.

5. **P2 — The first unit's attack removes the second unit's remaining movement.**

   Source: [game-room.component.ts](client/src/app/components/game-room/game-room.component.ts), `movesLeft` at lines 4612–4620; [game-room.component.html](client/src/app/components/game-room/game-room.component.html), lines 590–591; [game-board.component.ts](client/src/app/components/game-board/game-board.component.ts), line 4302.

   `movesLeft` returns zero whenever `hasAttacked` is true anywhere in the staged turn. That still encodes the old one-unit rule. Overtime correctly allows another unit to start moving, but after its first hop the board receives zero remaining MOV for that unit.

   Executing the getter for a fresh pawn after a one-step hop, with an earlier unit's attack staged, returns **0 instead of 5**. The board consumes that value for further moves from the pawn's current hex.

   **Correction:** determine whether the currently staged unit has attacked. Test A attacking, then B walking in several increments, including B's optional attack.

6. **P2 — A wounded base unit continues healing after wrapping into reserve.**

   Source: [panels.py](server/game/engine/panels.py), `panel_hp` at lines 470–503 and `withdrawn_units` at lines 525 onward; [game-room.component.ts](client/src/app/components/game-room/game-room.component.ts), lines 1842–1886 and 2041–2067.

   HP derivation remembers whether the unit's last wound occurred in a base. Later `panelMove` records do not stop the mending interval when the unit enters reserve. The walked-home derivation has the same location-history weakness. This contradicts PUNCHLIST 1.3 and the blueprint's reserve-healing value of zero.

   Reproduction uses a valid custom setup with a white pawn at the base tip `-12,1`: a real panel attack on ply 8 leaves it at 16 HP, and the legal wrap on ply 9 moves it to reserve `11,1` for one MOV and five points. Server occupancy reports **17 HP at ply 10, 18 at ply 12, and 19 at ply 14**, although it remains in reserve. The actual client HP derivation returns the same figures. Agreement between engines therefore does not establish correctness here.

   **Correction:** derive healing only over intervals when the unit actually occupies its base, incorporating crossings and later re-entry. Cover both initially dealt units and units that walked home, subsequent wounds, reloads, and dead units.

7. **P2 — The client accepts explicit nulls that the server rejects.**

   Source: [config.service.ts](client/src/app/services/config.service.ts), `validateGameRules`, including lines 271 and 347; [config_loader.py](server/game/engine/config_loader.py), `_validate_config`, including lines 221–223 and 276–279.

   Starting from the shipped config, independently set `rules.rangeFalloff`, `rules.objective`, or `units.pawn.attackRange` to `null`. The actual client validator returns `valid: true` for each, while Python `load_config` rejects each with `ValueError`. Null survives JSON serialization, so this reaches the real custom-config transport path.

   Client validation substitutes fallback values with `??` but leaves the original null in the config. This violates the config-sync contract that everything accepted by the client must be accepted by the server. The same class of error was already fixed for `minStrikeDamage`.

   **Correction:** distinguish absent fields from explicit nulls consistently. Add cross-validator cases for the affected fields and other optional scalar fields. The documented whole-number-float difference is not used as evidence here: ordinary JavaScript serialization can normalize `5.0` to `5`.

8. **P2 — Both validators accept starting placements that erase an opposing unit.**

   Source: [config_loader.py](server/game/engine/config_loader.py), setup validation and `build_initial_board` at line 316; [config.service.ts](client/src/app/services/config.service.ts), setup validation at lines 297–339.

   A setup containing `white: {"0,0": "king"}` and `black: {"0,0": "king"}` passes validation. Board construction places black over white. The resulting board contains only the black king, and `defeated_sides` reports white defeated before any move has been made.

   **Correction:** reject collisions between starting placements using normalized coordinates. Checking that each side's input names a commander is insufficient if construction overwrites one. This enforces the existing one-unit-per-hex invariant; it requires no new gameplay rule.

9. **P2 — Recaps merge independent units into one fictional move.**

   Source: [playback.ts](client/src/app/services/playback.ts), lines 32–40 and 95–104.

   Playback maintains a single `standing` position and collapses all movement from the first origin to the last destination. It does not partition movement by unit.

   Reproduction: `buildPlayback([{from:'0,0',to:'1,0',attack:null}, {from:'5,0',to:'6,0',attack:null}], true)` returns only a move from `0,0` to `6,0`. Both genuine moves disappear into that invented path. Overtime and multiple setup homecomings can reach this case; ability animation relocation also uses the combined path. This corrupts the explanation of the turn, even where the committed board is correct.

   **Correction:** collapse each unit's own walk independently and preserve action order. Exercise multiple units, multiple homecomings, and a cast on one unit followed by another unit's move.

10. **P2 — A failed save loses the editor's route back to its game room.**

    Source: [setup-config.component.ts](client/src/app/components/setup-config/setup-config.component.ts), lines 119–155.

    `onBack()` removes `returnToGameRoom` and `gameRoomToken` before asking whether to save and before validation succeeds. If validation fails, the user stays in the editor but the return context is gone.

    Executing the actual component method reproduced: invalid JSON → Back → choose Save → remain in the editor with no room context; correct the JSON → Back → navigate to `/lobby` instead of the original room.

    **Correction:** retain return context until navigation will actually happen. Test invalid save followed by correction and retry.

11. **P2 — Browser-storage failure makes identity unstable within a running session.**

    Source: [auth.service.ts](client/src/app/services/auth.service.ts), lines 30–40.

    `getIdentitySecret()` generates a new secret whenever storage has no value. `writeStore` intentionally tolerates denied storage, but AuthService keeps no in-memory fallback. Two calls on the same service instance then return different secrets. A reconnect while the old server identity is still held cannot prove ownership with the new secret.

    This was reproduced with the real AuthService and storage reads/writes that simulate denied storage. The loss of a saved session after a reload is expected under that condition; changing identity during the same live page is avoidable.

    **Correction:** retain the generated identity secret in the service for its lifetime, with browser persistence as a separate concern. Exercise failed writes and reconnects without reloading.

**Specification and documentation assessment.** `CONFIG_BLUEPRINT.md` clearly distinguishes today's rules from the proposed configuration structure. The future `match`, `stageRules`, `economy`, `scoring`, `combat`, and `panels` sections are a plan, not missing fields that should be implemented during this review. The shared defaults, mirrored phase/scoring helpers, and scoring parity fixtures are useful foundations. The configured numbers and ownership decisions should remain the owner's call.

The following documentation conflicts can cause incorrect future changes:

- `AGENTS.md` invariant 3 still says allies block traversal, while its later game specification and both movement implementations allow passing through allies. The invariant needs the superseding rule.
- `README.md` still describes separate default configs, one point per kill, allied movement blocking, reserves unable to enter play or be attacked, and a single-message/single-unit turn. Those descriptions no longer describe the full current game.
- PUNCHLIST 3.11 retains the earlier overtime toll/payment schedule. Later decisions and the blueprint specify tolls of 1/3/5 and no recurring overtime points. Historical rows should be unmistakably superseded.
- `CODEX_HANDOFF.md` is a dated handoff. Its clean-tree claim, unresolved owner questions, and some known limitations are historical; current code and later decisions supersede them. `IMPLEMENTATION_KICKOFF.md` likewise describes an earlier engine.
- `shared/game-config.types.ts` claims to be canonical but omits current fields such as defense and attack range and describes the older ability shape. Searches found no runtime imports of it. `shared/message-types.ts` is also unused and incomplete. These files currently provide no enforcement despite their names/comments.
- `DEPLOYMENT.md` includes proposed source changes and explicitly unbuilt deployment steps. For example, current settings still use the repository SQLite path, and the current socket config has no `BACKEND_HOST` field. The document is not evidence that a deployment artifact exists or has been validated.

Preserve the distinction between decisions, implementation, automated checks, and owner acceptance. PUNCHLIST's explicit refusal to promote an item to `SEEN` merely because tests pass is a good convention.

**Good conventions worth retaining.**

- One shipped JSON config is imported by both engines. Unit behavior is driven by configuration rather than unit-ID branches. Numeric changes have a narrow, understandable home.
- Deterministic combat and largely pure geometry, schedule, history, and scoring helpers make rules reproducible. Existing shared scoring fixtures catch cross-language drift without requiring a running browser or server.
- Per-room rule lookup and frozen config snapshots avoid using one room's settings for another. Persisted phase banks and turn-start times preserve facts that cannot safely be reconstructed from only the current board.
- The server independently checks networked moves and panel actions, and deliberately refuses client-owned ability bonuses. Keeping unfinished multiplayer abilities disabled is appropriate.
- Origin validation, constant-time secret comparisons, message-size limits, rate limits, and explicit production secret/host requirements are real safeguards. They remain useful despite the authorization sequencing defect.
- Atomic name/invite claims, stale-socket cleanup protection, centralized commit paths, and standardized error responses demonstrate attention to failure cases. The same-turn revision gap needs correction within that design.
- Strict TypeScript/compiler options, both CI suites, migration checks, and production build checks are sound baseline practices. Tests cover many domain boundaries; the missing coverage is concentrated in action combinations and transitions.

**Maintainability improvements with direct payoff.** The room component is roughly 5,640 lines, the board component 4,737, and the consumer 3,182. Size alone is not a bug, but the findings show gameplay rules spread across staging, presentation, commit dispatch, history derivation, and two engines. New multi-unit behavior was implemented in some of those places while single-unit assumptions survived elsewhere.

Correct the shared decision points first: action ordering, state revisions, identity establishment, per-unit budgets, and HP/location history. Extract small pure helpers where those fixes need a shared implementation. A broad service-layer rewrite or a new ability DSL is not necessary to address these findings. Update or remove misleading unused contracts; if shared types are retained, make callers consume accurate types instead of maintaining a decorative parallel model.

Expand cross-engine checks beyond scoring to ordered movement/combat/panel histories. Add focused integration cases that combine supported actions, including switching units after an attack, casting between actions, entering/leaving healing areas, rejoining after authentication failure, and simultaneous same-ply writes. At least the multi-unit cases also need real UI-driven acceptance, because previous punch-list failures show that isolated helpers can be correct while the player cannot reach the intended behavior. Do not regenerate scoring fixtures to silence unrelated failures.

**Enterprise-readiness assessment.**

| Area | Current evidence | What is needed before a stronger readiness claim |
|---|---|---|
| Authorization and identity | Anonymous browser identity and room tokens; confirmed failed-authentication bypass | Fix the bypass and test every room boundary. Account recovery, stronger account/session controls, and administrative roles depend on the intended product requirements. |
| State integrity | Conditional writes exist, but same-ply changes are not versioned | A revision/serialization guarantee for every mutation, conflict handling, and reconnect/retry tests that include multi-message turns |
| Availability and scale | SQLite, default in-memory channel layer, process-local turn/disconnect tasks | Enforced single-process limits for an initial deployment; a shared channel layer and appropriate database for multiple workers, plus durable deadline recovery and timer ownership |
| Persistence and release compatibility | Config snapshots and phase banks persist; substantial rules still live in code | Explicit compatibility policy for active matches, replay/save versions, and deploy/restart tests. A config snapshot does not freeze rules still implemented as constants. |
| Operations | A deployment guide and application logging; no checked-in complete deployment or demonstrated restore/load procedure | A reproducible deployment, useful health/readiness checks, persistent database placement, backup/restore exercises, and actionable error/latency/timer/conflict monitoring |
| Verification | 728 tests pass; compilation/build and migration checks pass | Regression coverage for the findings, browser interaction tests, live network tests in CI or a release gate, and measured capacity/recovery behavior |
| Product completeness | Multiplayer abilities intentionally disabled; passives/progression remain documented scaffolding; solo has no AI | Define the intended release feature set explicitly. These are known product limitations, not newly discovered regressions. |

The [Channels documentation](https://channels.readthedocs.io/en/stable/topics/channel_layers.html) identifies Redis as its official production channel layer and warns that in-memory layers cannot communicate across processes. Setting `REDIS_URL` alone would not make this application's process-local timers durable or uniquely owned across workers. Database and timer coordination must be evaluated together.

Use [Django's deployment checklist](https://docs.djangoproject.com/en/6.0/howto/deployment/checklist/) against the actual production configuration, including proxy/TLS, cookie settings where sessions/admin are used, error reporting, and backups. This review did not run `check --deploy` against a production environment. [OWASP's WebSocket guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) is relevant to verifying authorization throughout a connection's lifetime, message validation, and abuse controls; origin validation by itself does not authenticate a game seat.

**Recommended repair order.** Close the failed-authentication path and the lost-update hole first. Then correct ordered multi-unit commits, cast chronology, and per-unit movement; repair location-aware healing and configuration validation; finish playback and recovery behavior. Add reproductions as regression checks, run both existing suites, and drive the affected combinations in real solo and networked games. Stabilize those semantics before migrating the blueprint's remaining rules into configuration, so the migration does not preserve known defects behind a new interface.
