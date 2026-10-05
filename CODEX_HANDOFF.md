# Handoff: ChessPlusPlus, 5 Oct 2026

Updated by Codex from Claude Code's 2 Oct handoff, for the next agent.
**AGENTS.md is the source of truth** for how this repo works: architecture, the rules the owner
has decided, and why. Read it first. This note covers only what AGENTS.md does not: where the
work stands, how this owner likes to work, the machine, and what is open.

This replaces the 2 Oct snapshot of `main`. That note is in the history:
`git show 7658bb3:CODEX_HANDOFF.md`. The older dev18 note is at `4d5e99f`.

## Where things stand

- **Repo:** https://github.com/Ruinan-Ding/ChessPlusPlus. It is a hex-grid tactics game: a Django
  Channels server in `server/`, an Angular 19 client in `client/`, and the shared config schema in
  `shared/`.
- **Current branch:** `feature/dev22`, tracking `origin/feature/dev22`.
  - The current unit-kit checkpoint is "Implement all eight unit veterancy kits and
    resolve review regressions" (6.79-6.80). The owner authorized commit and push on
    5 Oct. Use `git log -1` for its SHA; its CI result is not recorded in this commit.
  - The previous pushed checkpoint is `53a846c`: "Implement the first ability pairs and
    separate unit points". Its [CI run](https://github.com/Ruinan-Ding/ChessPlusPlus/actions/runs/37249563064)
    completed successfully for both server and client at this exact SHA on 4 Oct.
  - That follow-up contains the pre-ability cleanups and test audit, first four ability
    pairs, Phase 3 full heal, turn swooshes, postmatch permissions, separate UP, review
    fixes and documentation (PUNCHLIST 6.69, 6.71-6.78).
  - The earlier checkpoint `4e8413e` also passed [CI](https://github.com/Ruinan-Ding/ChessPlusPlus/actions/runs/37187378017).
    Unit-kit work and review fixes (6.79-6.80) follow that checkpoint.
    All eight kits are implemented: Vet 1 stats in both engines,
    Vet 2 passives and Vet 3 UP abilities in solo. Online ability execution remains deferred.
  - Local `main` and its tracking ref are at `7658bb3` (the 2 Oct handoff). dev22 is not merged.
  - Every feature branch through dev21 is merged except dev9. Leave dev9 and
    `copilot/analyze-game-room-code` alone. dev19-dev21 used local `--no-ff` merges.
- **Verification, with the scopes kept separate:**
  - Pushed `4e8413e`: 348 server tests, 630 client specs, the production build and the CI
    migrations check pass. The last complete layout sweep passed all 351 checks.
  - Current refactor: 635 client specs, application TypeScript checking and the production
    build pass. Thirty-four real-browser checks cover desktop, tablet and phone: all eight
    roster profiles, friendly casting before bishop healing, Undo, older saved effects and
    cooldowns, and veteran withdrawals through commit and reload. Twelve distinct deliberate
    stubs were caught and restored. No template, stylesheet, backend or config changed, so
    the full layout sweep and server suite were not rerun for this refactor.
  - Subsequent comment cleanup: 85 net source lines removed, including repetitive explanations,
    an unused type export and a redundant assertion. Application and spec TypeScript checks
    pass; the four cleaned files produce the same executable JavaScript tokens.
  - Subsequent test audit: two room regression specs cover real storage restore and turn
    messages for mixed-caster effects, legacy caster fallback, unit cooldowns and a Black
    seat's slot cooldowns. All 637 client specs pass. Four additional deliberate regression
    stubs were caught; runtime source was restored byte-for-byte. This follow-up changes
    tests and documentation only.
  - First-pool/promotion/announcement work: 649 client specs, 350 server tests and the
    production build pass. All 351 layout checks pass. Forty-two real-browser checks at
    desktop, tablet and phone sizes cover all eight ability controls, army debuff scope,
    reload/Undo, Phase 3 healing and upright full-turn/stage announcements for both seats.
    Twelve deliberate regressions (nine client, three server) were caught and source restored
    byte-for-byte, recorded with PUNCHLIST 6.72-6.74.
  - Postmatch follow-up: 655 client specs, 351 server tests, the production build and
    migration check pass. Six new client regressions and one live WebSocket consumer test
    cover both sides of every postmatch, healing, casts on moves and passes, boosted walks,
    attack rejection and Phase 3 king kills. Forty-eight real-browser checks pass across
    desktop, tablet and phone, including all eight casts, commit/reload, normal healing
    and Undo in all six postmatch halves, and Phase 3 regicide for both seats. Five deliberate
    regressions (four client, one server) were caught and source restored byte-for-byte.
    No template or stylesheet changed; the earlier 351-check layout sweep remains applicable.
  - UP/swoosh follow-up: 663 client specs, 353 server tests, a clean production build and
    migration check pass. Shared config validation includes `upAtStart`; all 372 scoring
    parity cases include UP and halftime snapshots. Sixty-one real Chrome checks pass:
    54 economy/announcement cases across desktop, tablet and phone, six four-digit wallet
    fit checks, and a real mouse selection through the centred notice. The full layout
    sweep passes all 351 checks. Twelve deliberate regressions (seven client unit, three
    server and two browser checks) were caught; source was restored byte-for-byte.
    A browser-discovered double crossing charge at handover is fixed and covered by a spec.
  - Latest review fixes: all 666 client specs and the clean production build pass.
    Thirty-seven real Chrome checks cover reserve Sap/Weakening (including combined
    effects), forecast/staging/Undo/commit/reload, advancing UP snapshots in memory and
    after reload, and first-turn restore/full-turn announcements for both seats at desktop,
    tablet and phone sizes. The full layout sweep passes all 351 checks. Six unit-level
    deliberate regressions and one compiled input-binding regression were caught; source
    and the development bundle were restored byte-for-byte. Browser runs used a static
    development build after the spare Vite server crashed on Chrome connection resets.
    Server code and config are unchanged; the earlier 353-server-test result still applies.
  - First-star unit stats (6.79): 355 server tests, 673 client specs, the clean production
    build and migration check pass. All eight profiles use one shared config field in both
    engines. Forty-seven new malformed-config cases are refused on both sides; omission
    remains compatible with old configs. Seventy-eight real Chrome checks cover both seats
    at desktop, tablet and phone sizes: eight Unit profiles, wounded reserve promotion,
    base exclusions, reloads and actual range-2 king attacks through forecast/commit/reload.
    Sixteen deliberate regressions (ten client, six server) were caught and source restored
    byte-for-byte. No template or stylesheet changed; the earlier full layout sweep still
    applies. That earlier run covered Vet 1 only; the follow-up below covers Vet 2/3.
  - Completed unit kits (6.79), 5 Oct: 702 client specs, 356 server tests, the clean
    production build and migration consistency check pass. Config parity now contains
    160 malformed cases and 15 omission cases; scoring parity has 374 fixed cases.
    Vet 2: 120 real Chrome checks across both seats on desktop/tablet/phone and ten
    deliberate stubs. Vet 3: 240 Chrome checks on those same six combinations, plus
    32 final edge checks on desktop/phone for both seats. These cover all eight casts,
    UP pricing, scopes, forecasts, commit/reload, Taunt and Cast control/action/expiry,
    original-owner refunds, movement after control returns in a foreign red base,
    controlled reserve Regenerate, and Rapid Movement withdrawals. Fourteen Vet 3
    stubs fail real assertions; all mutated source is restored byte-for-byte. Together
    with Vet 1's sixteen, forty distinct rule regressions were caught. Both complete
    layout sweeps after the Unit template updates pass all 351 checks. Browser checks
    use isolated headless Chrome profiles and a static development build on spare 4201.
    These are solo checks, not a new complete live network e2e run. The owner authorized
    this checkpoint for commit and push on 5 Oct; 6.79 is WRITTEN, not owner-SEEN.
  - Unit-kit review fixes (6.80), 5 Oct: 708 client specs and 358 server tests pass,
    with six new client regressions, two new server checks and 23 shared combat-ring
    eligibility cases. Returned Cast veterans withdraw as normal postmatch deployments;
    casts between combat and Rapid Movement resolve before the remaining walk; earlier
    panel wounds cannot re-promote later withdrawals. Bog, adjacent auras and Cast honor
    configured durations. Nine deliberate regressions fail real assertions; source is
    restored byte-for-byte. The production build is clean; migration consistency reports
    no changes. Sixty-eight focused Chrome assertions pass: 34 desktop and 34 touch-screen
    checks, both seats, covering staging, commit/reload, returned Cast withdrawals, Rapid
    Movement with intervening Strike and later Mend, configured three-turn Bog expiry,
    and zero-tier attack eligibility. The spare preview and isolated Chrome profiles are
    stopped. These are solo checks. No template or stylesheet changed in this review
    follow-up; the earlier 351-check layout run applies.
    Included in the unit-kit checkpoint authorized for push on 5 Oct; 6.80 remains
    WRITTEN, not owner-SEEN.
  - Last complete live script run, 2 Oct: `match.py` 22/22, `edges.py` 12/12 and
    `endings.py` 30/30. dev22 also has targeted socket checks recorded in PUNCHLIST 6.66.
    Do not describe those as a new complete e2e script run.
- **Migrations run to 0012.** The owner's database was last checked at 0008 on 2 Oct;
  its current migration state has not been rechecked. Don't migrate it unasked.

### Recent revisions

| Revision | Date | What | Written up in |
|---|---|---|---|
| `84faa6f` (PR #19, dev18) | 26 Sep | The postmatch, and the points, CP and ending rules | PUNCHLIST 6.24-6.38 |
| `75a46a1` (dev19) | 30 Sep | The room laid out for every screen: desktop, landscape tablet, phone, touch | PUNCHLIST 6.39-6.55 |
| `7409799` (dev20) | 1 Oct | Networking that recovers, and names that hold | AGENTS.md, historical PUNCHLIST 6.70 |
| `de6cb84` (dev21) | 2 Oct | Tripcodes, and names held to letters and numbers | PUNCHLIST 6.56, AGENTS.md |
| `4e8413e` (dev22, pushed) | 4 Oct | Unit panel, roster, healing, phase veterancy, capture permissions and layer scoring; two review fixes | PUNCHLIST 6.57-6.68, AGENTS.md |
| `53a846c` (dev22, pushed) | 4 Oct | Shared types/calculations, regression coverage, the first four ability pairs, Phase 3 veteran healing, turn announcements, postmatch permissions, UP and review fixes | PUNCHLIST 6.69, 6.71-6.78 |

**dev20 in short.** AGENTS.md has the detail and the reasons.

- **Timers survive a restart.**
  - Each absent seat's grace deadline is stored as a `GameDisconnect` row (migration 0010).
  - The turn clock reads `GameState.turn_started_at`.
  - `_resume_game_timers` re-arms both when somebody joins.
- **State is ordered.**
  - Every `GameState` write is conditional on `revision`, and every state broadcast carries that
    revision.
  - The client drops anything older (`acceptStateRevision`).
- **Replaced sockets.** A socket that another one has replaced is refused: `STALE_GAME_SOCKET` in
  a room, `NAME_RECLAIMED` in the lobby. The page then rejoins once.
- **One announcement.** A finished game is announced once, however often it resyncs.
- **Names.**
  - Each tab has its own name, kept in session storage.
  - Names are unique regardless of case (`name_key`, migration 0011).
  - No rename in a room or with an invite out or in (`NAME_LOCKED`). The lock checks the pending
    `GameChallenge` rows, because `set_status` could otherwise hide an invite.
  - A dropped player's row is kept, detached, through their grace period.
- **Security review.** A `/security-review` of the branch found nothing else that qualified once
  that `set_status` bypass was closed.
- **CI.** CI had been red since 29 Sep: `banner-fit.spec.ts` assumed Windows fonts. It now finds
  the width where the stage shrinks instead of assuming 1300px.

**dev21 in short.**

- **Base names** are 1-24 ASCII letters and digits, and nothing else. `System` stays reserved.
- **Tripcodes.** `Name#key` is held as `Name!CODE`, where the code is an HMAC under
  `DJANGO_SECRET_KEY`.
  - The key is never stored or echoed.
  - The browser that typed it keeps a signed proof instead, so a reload keeps the code.
- **Two networking fixes came with it.**
  - A network rejoin releases End Turn's latch.
  - A grace timer is replaced only by the period the database holds.
- **Who wrote it.** This code was found uncommitted in the tree on 2 Oct, the work of another
  session. Claude Code reviewed it, ran everything above, wrote the docs and committed it.

### Current role and next work

The owner has supplied the unit stats and capture rules; they are implemented in the shared
config and both engines. The four requested cleanups are complete in the dev22 follow-up:
`PieceData`/`BoardState` are shared from `game-state.service.ts`, `SelectedUnit.atk` stays numeric,
and `ability-rules.ts` owns existing solo stacking, expiry and cooldown calculations. The room
still owns targeting, staging, animation and persistence. Older saves keep their effect shape
and caster fallback. These cleanups add no new abilities or gameplay rules.

The first four pairs now use the owner's rules: Warcry/Sap, Bulwark/Weakening, Dash/Mire,
Mend/Strike. Their amounts, points, cooldowns, scopes and fixed recipient rules are in
AGENTS.md. Stat changes last until the caster's next turn; HP changes are immediate.
Warcry arms zero-base attackers, while configured healers keep their normal healing action.
Older saved rooms keep their catalogues; `legacy-abilities.fixture.json` is test-only.
New games use the specified pool. Path abilities remain to be specified.

**Current task complete: eight unit veterancy kits (6.79), awaiting owner inspection.** The owner supplied
Vet 1 stats, Vet 2 passives and Vet 3 UP abilities for pawn, archer, shieldman, rook, knight,
bishop, queen and king. AGENTS.md records the confirmed amounts and semantics. Cast is
confirmed to grant an immediate extra move/attack, hold control through the opponent's next
turn and return it at the caster's next turn; it may target kings. Preserve original
ownership separately from current control: controlling a king alone does not win; killing
it defeats its original owner, confirmed by the owner. The bishop finishes its action when casting. The controlled
unit may be buffed by the caster and attacked/debuffed by its original side. The owner
confirmed that its death is an attrition loss against the caster. It captures and
neutralizes for the caster within its normal zone permissions. It may target battlefield
and green-reserve units, excluding red bases. A controlled unit may withdraw into the
caster's red base through an open normal door. The refund goes to its original owner,
confirmed on 5 Oct. It remains there under Cast for the full turn; when Cast expires,
its original owner controls it again. The owner said it otherwise functions normally.

Vet 1 HP increases current and max HP together. Archer's Vet 3 active is Bog, triggered
by its attack. Taunt costs 1 UP/CD 1; Call costs 5 UP/CD 5. Counter/Deflect are ATK before
DEF. Cleave hits adjacent enemies around the rook with normal ATK/DEF. Charge requires an
actual counter and has no second counter. Sacrifice buffs friendly battlefield/green
units for one full turn and heals 1 immediately. Rook Bog stacks without a cap for one full turn. Queen/King auras start on their owner's turn, covering adjacent
battlefield enemies/allies respectively. Regenerate heals living battlefield/green
bishops on their owner's end turn, even without acting. Hop crosses multiple enemies and
open panel gateways. Call covers battlefield/green, with both 1 immediate enemy HP damage
and -1 ATK for the full turn. Warcry permits shieldman counters; Deflect alone does not.
Rook Bog includes counters and applies after the exchange. All required unit-kit questions are answered.

Vet 1 config and runtime edits are implemented. The new shared `veterancy` field
contains first-star additive stats and replacement attack/healing profiles; both validators
reject malformed present values and permit omission in old configs. `unit-stats.ts` and
`unit_stats.py` resolve those numbers without unit-id branches. HP promotion uses the
recorded rank to raise current/max once; reserve HP projection and wound records carry
the same rank. All eight passives and Vet 3 actives are implemented in solo. The Unit
panel shows the actual unit passive and active instead of placeholder Dash/path slots.
`unit-combat.ts` shares exchange and Taunt rules across the board, room and local engine;
`unit-control.ts` reconstructs temporary control without losing original ownership.
Cast recipient actions and ordinary actions have separate allowances. Panel movement
caps stay per physical panel; Rapid Movement supports post-attack withdrawals while
retaining both combatants' HP and the normal UP awards. Config-sync and Ponytail full
were applied to this task. The owner answered the five outstanding
questions: Cast deaths count against the caster and eligible capture follows control;
any reachable taunting shieldman may be chosen; rook Bog applies once after each exchange;
ATK buffs/drains modify archer Counter. The owner confirmed Bog has no stack cap.
The owner clarified "bog only lasts 1 full turn", superseding the earlier next-two-enemy-turns
duration. Each exchange adds one stack after damage and counters; later exchanges may stack again.
The implementation retains fixed recipients, caster expiry, staged actions, Undo, reload
and history-derived UP. Do not begin the deferred server ability system or CP path work from
this request.

Phase 3 postmatch heals living battlefield/reserve units already at vet 3 before its award;
a unit newly promoted to three stars keeps its HP. Both engines persist the heal, including
canonical panel HP records. The board briefly announces each full turn, with larger stage
names at schedule changes.

**Postmatch permission confirmed:** the owner answered *"abilities and anything can be used
but units cant attack"*. Every numbered phase's postmatch now permits all ability categories
and normal bishop healing; ordinary attacks, panel blows and enemy landings remain blocked.
Initialization still forbids casts and normal healing. Existing movement allowances, prices,
cooldowns and target rules apply, and online casts remain deferred under 6.15. An ability
killing a king settles regicide before points or overtime. See PUNCHLIST 6.75.

**Latest economy revision:** each side starts at 10 UP (`rules.upAtStart`). Unit worth,
battlefield attack/counter kill rewards, homecoming refunds and base-to-reserve wrap prices
use UP; regular ability points retain scheduled income, phase grants and overtime conversion.
Halftime turns 9, 20 and 31 add each side's own current phase VP once, as a persisted
`halftimeUp` history event. Both engines use the existing hand-over/effects path, so there is
no database migration. Past halftimes in older saves have no snapshot to recover; awards
are recorded at future eligible boundaries, never inferred from a later board. The idle CP button also displays UP. Staged transactions reconcile
against the committed history and Undo reverses their UP.

**Latest announcement revision:** 600 ms right-to-left slide, brief centre pause, a 160 ms
volume/mute-aware swoosh, and no pointer blocking. Reduced motion disables the slide.
The clock clarification is still pending: the owner said the announcement should not count
against the timer; the outstanding question asks whether to exclude those 600 ms while
units remain playable or let the independent clock keep counting. Do not infer an answer;
no deadline/timer change has been made yet. See 6.76-6.77 for the completed verification.

**Latest review resolved (6.78):** reserve defenders' supplied UIDs now resolve Sap and
Weakening in staged combat and committed local-engine bonuses. Advancing snapshots discard
expired staging before UP reconciliation; solo UI saves record their ply so valid same-turn
reloads and Undo still work. Older UI saves without a ply discard their uncommitted preview,
retaining committed history and saved ability state. Initialization announces only on a
fresh `game_started` cue, including when the board first renders at ply 0 before a restored
ply 1 arrives. Reloads stay quiet; later White full-turn transitions still announce.

For the next ability set, ask for concrete effects, targets, ranges, costs, durations and
limits in small themed batches before implementing missing behaviour. Keep the
engine config-driven and update AGENTS.md when a rule is decided. Online ability execution
remains deferred: the eventual engine must resolve a cast from its configured id and target,
validate eligibility and costs, and write with the existing revision guard. A client's supplied
stat bonuses or HP are not authoritative. Do not start that work from this handoff alone.

## How this owner works

- **Commit, push and merge only when asked.** Put new work on a branch, not straight on `main`.
- **Git identity and git from WSL.**
  - Commit as Ruinan Ding <ding.r866@gmail.com>. Never change git config.
  - Under WSL, `git` has no identity and no credentials. Commit and push with Windows git through
    `cmd.exe /c "git ..."`, which has both (credential manager).
  - Pass the message on stdin with `-F -`.
  - `git merge` will not read `-F -`. Use `git merge --no-ff --no-commit <branch>`, then
    `git commit -F -`.
- **Commit messages.** Subjects are plain-English sentences, for example "Hold a name to the
  player who has it, and only to them". Bodies say why.
- **Stub-verification discipline.** For each new or moved rule, break it on purpose, watch a test
  fail, then restore it. Report how many stubs caught something.
- **Don't touch the owner's servers** on ports 8000/4200.
  - `start.sh` takes spare ports: `BACKEND_PORT=8002 FRONTEND_PORT=4201 ./start.sh`. Stop it with
    `./start.sh -k`.
  - The e2e scripts take `E2E_PORT`.
  - To run them without touching the owner's database, start the server with a throwaway settings
    module that overrides `DATABASES['default']['NAME']`, through `DJANGO_SETTINGS_MODULE` and
    `PYTHONPATH`. Give `edges.py` the same settings, because it reads the database itself.
- **Where the owner runs things.**
  - The owner runs `./start.sh` from **WSL**.
  - `node_modules` and the venv are Windows installs, so everything goes through `cmd.exe`.
  - WSL's own `node` cannot run `ng`, because esbuild and rollup are installed as their win32
    builds.
- **The Windows toolchain, as of 2 Oct.**
  - Python 3.14.7 is installed through winget, user scope. `py` defaults to 3.14, and 3.12 is
    still installed.
  - `server/venv` was rebuilt on it: Django 6.0.6, channels 4.3.2, daphne 4.2.2.
  - Node 25. The client specs use the installed Chrome (see the commands below).
- **CI.**
  - `.github/workflows/tests.yml` runs on every push and pull request, on Ubuntu: the server
    tests, the migration check, the client specs and the production build.
  - Specs must not depend on Windows fonts.
  - `gh` is not on WSL's path. Windows has it (`cmd.exe /c "gh ..."`), but on 4 Oct it was
    not authenticated. Read-only public status checks can use GitHub's API without a login:
    `curl -s "https://api.github.com/repos/Ruinan-Ding/ChessPlusPlus/actions/runs?branch=<b>&per_page=1"`.
- **Line endings.**
  - Most source and doc files are CRLF, while `*.sh` is LF (set by `.gitattributes`), and
    `core.autocrlf=true`.
  - Never `sed -i` a CRLF file. For scripted edits, use Python with `newline=''`.
  - **`PUNCHLIST.md` has three lone CRs, on rows 3.10, 3.12 and 3.14, on purpose.** They were
    still there on 2 Oct. Editors that normalise them make git show the whole file as changed. Put
    them back if that happens.
- **Style.**
  - Comments are long, reasoned, plain English, and explain why. Match them.
  - Quote the owner verbatim, typos included.
  - Record owner decisions in PUNCHLIST.md with a date.
- **The config has three mirrors.** `shared/game-config.schema.json`,
  `server/game/engine/config_loader.py` and `client/src/app/services/config.service.ts` must change
  together. The procedure is in `.claude/skills/config-sync/SKILL.md`.
- **Per-room rules.** One server process plays every room, so read rules with
  `rule_of(config, key)` / `ruleOf(config, key)`, never from a module constant.
- **The owner's calls.** Game rules are the owner's to decide. `DJANGO_DEBUG=true` in development
  is deliberate (AGENTS.md).

**Test commands, from WSL:**

```bash
cd server && cmd.exe /c "set DJANGO_DEBUG=true&& venv\Scripts\python.exe manage.py test game.testsuite"
cd server && cmd.exe /c "set DJANGO_DEBUG=true&& venv\Scripts\python.exe manage.py makemigrations --check --dry-run"
cd client && cmd.exe /c "set CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe&& npx ng test --watch=false --browsers=ChromeHeadless"
cd client && cmd.exe /c "npx ng build"   # must be clean, with no budget warning
```

## Open items

**Owner acceptance and agent verification are separate.** Recent dev22 work in PUNCHLIST
6.57-6.69 and 6.71-6.80 remain WRITTEN, not SEEN. Agents have driven running browsers with mouse and emulated
touch, and the evidence is recorded there; that does not claim a physical-phone playtest or
owner acceptance. Nothing moves to SEEN except by the owner saying so.

**Deferred by the owner. Do not start these unasked:**

- **Server-side abilities (PUNCHLIST 6.15).** Abilities are still solo-only: a networked room
  refuses every cast.
- **A networked browser playtest, and PUNCHLIST 6.17.** Solo play is still laxer than a
  networked game.
- **A config editing UI.** This is carried over from the 23 Sep note, and nothing since says
  otherwise. Only custom mode would use it, and the owner was unsure about going that far.

**The questions in the 23 Sep note:**

- **Overtaken.** Questions 3-5 were about CP through play, when the next phase's CP arrives, and
  the turn-36 header. The owner's rules of 24 Sep overtook them (PUNCHLIST 6.25-6.29).
- **Never answered on record.** Ask before relying on either of these:
  - Question 1: can a unit that used its opening move also walk home?
  - Question 2: "once you move another unit, the previous is done". This is enforced. Is that
    intended?

**Known limits:**

- **The counted-rule validators still disagree on whole-number floats.** The client accepts `5.0`
  (`Number.isInteger`); the server refuses it (`isinstance(int)`).
- **Tripcodes hang on `DJANGO_SECRET_KEY`.** A new key changes every code and invalidates every
  remembered proof (DEPLOYMENT.md).
- **There are no accounts.** A plain name is first-come, and the per-browser secret only guards
  rejoining a name you already hold (DEPLOYMENT.md, "Before you hand the link out").
- **Already fixed:** a late or reloaded client no longer scores a phase late. The
  engines bank each phase themselves (`phase_bank`, migration 0008).

**Documentation:**

- The missing dev20 record is now PUNCHLIST 6.70, dated as a historical entry with its original
  merge evidence. The owner requested current metafiles, statuses and docs on 4 Oct.
- README.md describes current play; client/README.md describes the installed client tooling.
  CONFIG_BLUEPRINT.md remains the match-rule checklist, not a runtime config.
- IMPLEMENTATION_KICKOFF.md and CORRECTNESS_REPORT.md are historical records. Keep their
  historical findings and counts; follow AGENTS.md and this handoff for current work.
- DEPLOYMENT.md is still an untested plan. No deployment, database migration, commit, push or
  merge was performed by the documentation update.
