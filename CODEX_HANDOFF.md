# Handoff: ChessPlusPlus, 7 Oct 2026

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
  - The pushed unit-kit checkpoint is `82f4577`: "Implement all eight unit veterancy kits and
    resolve review regressions" (6.79-6.80). The owner authorized commit and push on
    5 Oct; its [CI run](https://github.com/Ruinan-Ding/ChessPlusPlus/actions/runs/37290954234)
    passed both jobs at this exact SHA. The coverage and browser follow-ups below
    (6.81-6.103) are verified locally and remain uncommitted; no new CI run is recorded.
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
  - Coverage follow-up (6.81), 5 Oct: 723 client specs, 363 server tests and four legacy
    server checks pass, with a clean production build and migration check. Fifteen new
    client specs and five server tests cover invalid-input refusal without state loss,
    room route reuse/reconnect/destruction, opening a saved custom config, atomic UP/CD
    refusal for all eight kits on both seats, independent unit cooldowns, control expiry,
    latest-cast precedence and current-stat preservation, lethal/disabled counters and
    Taunt's exact-ring eligibility. Thirty new shared malformed-config cases bring parity
    to 190 refusals and 15 omission cases. The new tests fail against the previous input,
    editor-baseline and room-subscription behavior; these defects are fixed. There are
    no dependency, template, stylesheet or gameplay-rule changes. This is unit/integration
    verification, not a new full browser or live-network script run. 6.81 is WRITTEN,
    not owner-SEEN. Online ability execution remains deferred; the later 6.86
    follow-up implements CP paths in solo.
  - Full end-to-end follow-up (6.82), 5 Oct: all four live scripts pass against fresh
    isolated databases on ports 8002/8003: match 28/28, edges 12/12, endings 30/30,
    panels 19/19. Match now verifies five malformed envelopes and subsequent valid
    traffic. Endings/panels assertions use current outer-ring scoring and configured
    starting HP rather than obsolete stats. No scoring or unit-stat rules changed.
    Real Chrome checks pass: 682 solo kit/pool/UP/postmatch checks, 30 bishop casting,
    healing and pool-hint checks, 23 actual two-player UI checks, 28 occupied-gateway checks
    and 78 resize checks. Capture colors, layer eligibility, move/Undo/commit/reload
    and phase banking also pass at desktop/tablet/phone sizes; four visual regressions
    were deliberately caught and restored. These targeted solo cases use arranged
    engine snapshots and real mouse/touch targets. The online flow uses real login,
    chat, invitations, config saves/refusal, moves, Undo, first-turn reloads, draws,
    resignation and return to lobby between two isolated browser profiles.
  - Responsive follow-up (6.83), 5 Oct: occupied gateway arrows and closed crosses
    pulse above unit plates, stay steady with reduced motion, and leave clicks and
    labels usable. The lobby title disappears when its actual width no longer fits;
    "Playing as" stays on one line. Desktop resizing now always preserves all three
    columns; touch screens retain their existing layouts. The updated desktop
    regression fails against the previous cutoffs and passes after the fix. All
    724 client specs and 367 server checks (363 canonical plus four legacy) pass;
    the final production build passes and migration consistency reports no changes.
    Pool tooltips also no longer claim a
    two-star requirement that their actual casts do not have; a new regression fails
    before that display fix, while unit ability rank hints remain intact.
    The final full layout sweep passes 339 checks; it covers the same sizes as the earlier 351-check run, with desktop
    tab permutations replaced by persistent-column checks. 6.82/6.83 are WRITTEN,
    not owner-SEEN. Online ability execution, custom-mode starts and online
    rematches remain deferred. CP paths subsequently landed in solo under 6.86.
    Logs, browser drivers and screenshots are in the isolated Windows Temp folder
    `cpp-e2e-20261005-9e28d24f`. The test servers, preview and isolated Chrome profiles
    are stopped. The owner's ports 8000/4200 and database were untouched.

  - UI follow-up (6.84), 5 Oct: the player name and connection status share one
    lobby row. Above 600px the action buttons stay in that row; phones place them
    below it. Connected retains "to Game Server"; mobile Disconnected keeps its
    first word beside Reconnect. The rename form opens below the controls. Both
    path-choice rows show name and cost inline. The volume percentage is at least
    12px and its slider/speaker targets at least 24px.
    All 724 client specs, 381 full layout checks, 168 focused header/path assertions,
    78 resize checks, 14 popup/text/checker checks and 23 real two-player UI checks
    pass. The focused regression run caught the original wrapping and stacked costs;
    three additional DOM regressions were caught and restored. The sweep now measures
    hidden ellipsis text by visible bounds, while detecting clipped controls.
    The final production build passes. No server/config/gameplay rule changed;
    the earlier 363 canonical plus four legacy server checks remain applicable.
    This work remains uncommitted and WRITTEN, not owner-SEEN. Evidence is in
    `cpp-e2e-20261005-9e28d24f/ui-followup-*` under Windows Temp. The isolated
    backend, preview and Chrome profiles are stopped; the owner's services were untouched.

  - Expanded UI end-to-end pass (6.85), 5 Oct: Retry Connection fits its button;
    invitation, Reveal and room-end dialogs wrap long public names and fit narrow
    screens. Short dialogs scroll their actions into reach. Leave Room remains
    clickable during a Reveal wait. The setup editor shrinks to available height,
    including with validation errors on landscape phones.
    A real outage/offline/reload/reconnect flow found a fresh offline lobby could
    reconnect to `default`, report Connected and receive no roster. The lobby now
    records `lobby` while offline; reconnect reaches the correct channel. Its new
    regression checks the real service's URL, join and displayed self row, and
    fails against the old guard with `/default/` instead of `/lobby/`.
    All 725 client specs and 490 full layout checks pass. Additional Chrome checks:
    37 live two-player flows, 13 keyboard/touch, 21 setup, 12 dialog/checker
    regressions and eight real outage/offline/reconnect assertions. The original
    short-screen editor clipping failed the sweep; four dialog regressions were
    deliberately restored, caught and removed. The final production build passes.
    Backend/config/gameplay rules are unchanged; earlier server verification applies.
    This follow-up is uncommitted and WRITTEN, not owner-SEEN. Evidence:
    Windows Temp `cpp-e2e-20261005-9e28d24f/ui-deep-*`. The isolated backend,
    preview and Chrome profiles are stopped; the owner's services were untouched.

  - CP paths and menu row (6.86-6.87), 5 Oct: all three specified paths run in
    solo, including passive scope at Vet 0, path utilities, any-hex skills and
    limited ultimates. Bishop's base HEL is 8/6 at rings 1/2; Vet 1 adds 4/2 at
    rings 3/4. Bastion Sap also changes HEL and Blitz boosts existing healers only.
    Strengthen preserves wounded current/max HP and panel rank through Undo/reload;
    Ruin kills before healing survivors; Fortress prevents the overtime king toll.
    Recharge leaves its pair targets reachable; Trap keeps drains/control while
    removing positive buffs, including positive parts of mixed effects.
    Main-menu controls share one row at all widths, with horizontal scrolling on
    narrow windows and vertical scrolling for a rename form on short screens.
    All 749 client specs, 364 server tests, 490 layout checks, schema validation,
    migration consistency and the production build pass. Chrome passed 72 CP
    checks across desktop/tablet/phone and Black-side play, plus 44 panel/overtime/
    menu checks. Six deliberate regressions were caught in an isolated source copy;
    workspace runtime files were untouched and the copy was restored and removed.
    The opening-passive and reserve-promotion tests also fail before their fixes.
    Evidence is in Windows Temp `cpp-e2e-20261005-9e28d24f/cp-*`; the production
    build is in `cp-production/browser`, kept separate from the browser test build.
    Test services/profiles are stopped; owner listeners remain 8000 (PID 1672)
    and 4200 (PID 36444). No owner database migration was run. These changes are
    uncommitted and WRITTEN, awaiting owner inspection. Online casts remain 6.15.

  - Complete verification after CP/menu work (6.88), 5 Oct: fresh runs pass all
    749 client specs, 364 canonical server tests and four legacy checks, 490 layout
    checks, shipped-schema validation, migration consistency and the production build.
    All four real-socket scripts pass on fresh isolated databases migrated through
    0012: match 28, edges 12, endings 30 and panels 19 (89 checks).
    Native Chrome passes 461 assertions: CP 72, CP panel/overtime/menu 44,
    live two-player UI 37, pool/promotion/announcements 42, postmatches 48,
    keyboard/touch 13, setup 21, dialogs/checker 12, occupied gateways 28,
    unit kits/CP interactions 108, a complete natural solo match 28 and real
    outage/offline/reload/reconnect eight. Tactical kit/CP cases arrange snapshots
    and then use actual input. The natural match uses the shipped setup and actual
    White/Black End Turn clicks through all 72 plies, without injecting turn counters
    or balances: phase promotions, weighted VP/UP snapshots, earned CP purchases,
    reload and the final points result all persist. Both seats' unit kits include
    desktop mouse and phone touch, combat, control, Undo, commit and reload.
    No runtime fixes were required by this verification. Online abilities remain
    deferred under 6.15; ordinary online flows pass. Logs, drivers and screenshots:
    Windows Temp `cpp-e2e-full-20261005-06a1a1c7`, indexed in `RESULTS.md`.
    The production output is separate from the browser's development build.
    Isolated servers/preview/Chrome profiles are stopped; owner listeners are still
    8000 (PID 1672) and 4200 (PID 36444), with no owner database migration.
    Verification and documentation are WRITTEN, not owner-SEEN; work is uncommitted.

  - Final convention/refactor review (6.89), 5 Oct: one existing recipient helper now
    serves pool, unit and CP casts; AudioService uses the existing guarded storage helpers.
    Removed dead imports, an unused service injection/subscription list, unused sound wrappers,
    an unused getter-local and stale comments. Credential-bearing lobby envelopes are no
    longer logged. Angular's framework-written ViewChild setters and engine public exports
    are retained. No new dependencies, schema shape, template, stylesheet or gameplay numbers.
    Regression fixes: protected Sacrifice removes its caster and records the death through
    commit/reload; client references require own configured IDs; Python refuses boolean board
    radii even with valid small setups; exact normalized JSON replaces the editor's lossy
    checksum and preserves own special keys. The `Aa`/`BB` name collision and `__proto__` unit
    edits now keep the unsaved prompt. Explicitly configured special-name IDs still work.
    Five new client specs, one server test and eight shared config cases cover these paths;
    parity now has 215 refusals and 18 omissions. Every defect was reproduced before its fix.
    One deliberate in-memory scope fault trips three existing tests; its temporary test file
    is removed and the normal suite passes. Workspace runtime was not mutated for this probe.
    Final checks: 754 client specs, 365 server tests, production build and migration
    consistency pass. Native Chrome passes 294 targeted assertions: CP 72, panel/overtime/menu
    44, pool/promotion/announcements 42, unit kits/CP interactions 116 and native editor input
    20. The 116 include protected Sacrifice, Undo, commit/reload and exact UP/death accounting
    for both seats. Editor checks use desktop and phone sizes. Earlier 6.88's complete network
    and 490 layout checks remain recorded; this review changed no markup or styles.
    Evidence: Windows Temp `cpp-review-20261005-b7a6d5ff/REVIEW.md`, with the review-only diff,
    before-fix failures and successful runs. Isolated services/profiles are stopped; owner
    ports 8000/4200 and database are untouched. Work is uncommitted and WRITTEN, not owner-SEEN.
    No larger refactor needs to block owner inspection. Online abilities remain deferred 6.15.

  - Persistent end-to-end test coverage audit (6.90), 6 Oct: added 28 client specs
    and three server tests. Twenty-one rendered Room integration cases use the real
    Board, WebsocketService, LocalGameService, GameStateService and storage; only
    audio and animation delays are skipped. A complete shipped 72-ply match checks
    VP/UP/CP, promotions, purchases, reload and the result. Tactical cases cover all
    eight unit actives, all CP paths, friendly pool targeting, Undo/costs/cooldowns,
    expiry, staged reload, Black controls, draws, resign, restart and deliberate exit.
    Three dialog control/subscription tests and three audio-settings tests cover
    offline/Retry/login controls and persistence/refused storage. A LocalGame test
    refuses locked panel walks, reserve deployment and panel attacks atomically,
    then accepts those same actions after unlocking.
    Two full server matches play every one of 72/100 plies over ASGI connections,
    checking both sockets against stored state, revisions, UP, rank, banks, resync
    and points/overtime endings. Another live test proves forged client stat bonuses,
    zero overrides and HP/cast packets cannot change online moves/combat/passes.
    All 782 client specs and 372 server tests (368 canonical + four legacy), the
    production build and migration consistency pass. Client lines rise 85.83% →
    89.34%, branches 77.41% → 83.04%. Two deliberate in-memory faults are caught:
    lost UI persistence fails 18 new integration cases; missing halftime UP fails
    the full-match test. Faults are restored, the temporary spec is removed and
    production sources are unchanged. No new dependency or parity regeneration.
    README and AGENTS explain CI integration versus separate browser/network/layout
    checks; this audit is not 100% coverage and did not rerun those separate scripts.
    Online abilities remain deferred 6.15. Evidence: Windows Temp
    `cpp-coverage-20261005-73c18bd7/AUDIT.md`, with before/after coverage and logs.
    Owner servers/database untouched; work is uncommitted and WRITTEN, not owner-SEEN.

  - Fresh real-browser single-player/multiplayer verification (6.91), 6 Oct:
    525 browser assertions and all 89 live socket checks pass against a fresh
    development build and newly migrated private databases. Complete solo and
    two-profile online matches play all 72 plies from the shipped deal with actual
    input/commits and no turn, health or purse injection. Rank, banks, halftime UP,
    CP where available, state/revision agreement, midmatch reload/rejoin and final
    points results persist. Two-player UI covers invites/readiness/moves/Undo/chat,
    Reveal/setup, draws, resignation and exit. Prepared server-side combat positions
    check both bishops' capped healing, attack/counter/Undo, inactive-seat gating,
    archer blind spots, green-reserve wounds/counters through rejoin and red-base
    counter suppression/healing. Solo checks cover all kits/CP/pool/postmatch effects,
    both seats, native mouse/emulated touch, Undo/commit/reload/expiry and protection.
    Stopping only the isolated backend verifies real connection failure/Retry,
    phone offline play/reload and lobby reconnection with its visible self row.
    Live scripts: match 28/28, edges 12/12, endings 30/30 (all 100 overtime plies),
    panels 19/19. No app/config/test/style changes were needed. 134 recorded hashes
    match. No repeated layout/unit/build suite is claimed by this browser/network
    pass; the preceding results remain in 6.88-6.90. Online pool/CP/unit abilities
    remain deliberately deferred 6.15. Native Chrome CDP used; Browser MCP unavailable.
    Evidence: Windows Temp `cpp-both-e2e-20261006-6512d348/RESULTS.md`, with all drivers,
    logs, screenshots and isolated database/settings files. Test services/profiles
    stopped; owner ports 8000/4200 and database untouched. Uncommitted, WRITTEN,
    not owner-SEEN.

  - Source/comment cleanup (6.92), 6 Oct: six unused helpers, two empty
    constructors, three unused observable exports, two empty Django starter files
    and 48 routine console traces removed; 275 net source lines gone. Stale
    placeholder/panel/currency/cooldown comments corrected and orphaned docblocks
    moved to their declarations. Error diagnostics, rule/security explanations,
    framework hooks, engine exports and old-save fixtures retained. All 782 client
    specs, 372 server tests, both TypeScript checks, migrations and production build
    pass. AST comparisons cover 65 TypeScript and 54 Python files with only the
    audited deletions/logs/docs excluded; generated CSS is byte-identical. Gameplay,
    config, templates and rendered styles unchanged. No fresh browser/layout run
    claimed; 6.91 remains the live evidence. Online abilities remain deferred 6.15.
    Evidence: Windows Temp `cpp-cleanup-20261006-947e4364/CLEANUP.md`.
    Owner services/database untouched; uncommitted, WRITTEN, not owner-SEEN.

  - Lobby/timer/board follow-up (6.93), 6–7 Oct: blank or whitespace entry creates a
    tab-only random name; the existing server claim handles concurrent collisions.
    Setup displays its actual configured timer (Unlimited by default), preserving
    explicit picks, edited solo configs and authoritative live snapshots. A 3px gold
    frame encloses the board/panels, White-panel hex outlines have stronger contrast,
    and turn notices hold centre for ~0.5s within a 0.9s animation. All 787 client
    specs, 372 server tests, TypeScript checks, production build and migrations pass.
    All 490 layout checks and 25 focused browser checks/observations pass. Actual
    15s online expiry passes to Black; solo expiry retains manual End Turn. One
    test-browser timeout required a separate unit rerun; harness corrections are
    logged independently. No unit/ability number or server rule changed. The notice
    deadline question and online abilities remain deferred. The owner also requested
    an opinionated mechanics assessment; a natural solo phase was played through
    ply 27, with notes outside the repo. Evidence: Windows Temp
    `cpp-play-analysis-20261006-4b7ea9d4/RESULTS.md`. Uncommitted, WRITTEN,
    not owner-SEEN; owner services/database untouched. Owner listeners restarted
    independently during the session; final cleanup preserved ports 8000 (PID 39812)
    and 4200 (PID 142892). Private test services/profiles are stopped.

  - Frame/turn/timer follow-up (6.94), 7 Oct: the frame now hugs the complete grid's
    outer hex vertices, including panels, instead of the SVG viewport letterboxing.
    Black's dark base/reserve hex outlines are clearer too. Each side gets Turn N
    above White/Black in a corresponding white/black box, after replay and upkeep,
    retaining the 0.9s duration and no pointer blocking/reload replay. The backdrop
    slowly pulses green toward white for your turn and red toward dark for theirs;
    the amber recap cue wins, and reduced motion holds steady.
    Solo timer expiry now submits the entire staged turn (or passes if empty),
    superseding its earlier manual-only expiry. Warnings sound at 5–1 seconds;
    a stronger triangle beep sounds once at zero, including server timeout messages.
    All 794 client specs and the production build pass. Twenty real Chrome checks
    verify frame geometry, both colours' actual 15s timed commits, audible-context
    warning/expiry calls, notice order/clicks, reload, flips and phone fit.
    A real two-player timing check reproduced the remaining online limitation:
    the authoritative server auto-pass can arrive before the browser submits,
    discarding the staged move. This follow-up does not claim reliable multiplayer
    timeout commits; online casts remain deferred under 6.15 too. Backend/config
    source and dependencies are unchanged; the prior 372 server checks still apply.
    Final layout/glow verification and evidence are recorded in PUNCHLIST 6.94.
    Evidence: Windows Temp `cpp-board-timer-20261007-aefdc90d/RESULTS.md`.
    Work is uncommitted, WRITTEN, not owner-SEEN.

  - Simultaneous effects/exhaustion/Recharge (6.95), 7 Oct: one cast animates all
    recipients in one beat, retaining its per-unit HP marks through staged reload
    and recap. Rook Cleave's splash lands with its direct hit before the counter.
    Exhausted skills and ultimates remain grey through hover/recent-pick styling,
    stay clickable for descriptions, show Used up and cannot activate; Undo
    restores their use. Recharge now shows its description before Use arms the
    pair selection. Both positive cooldowns drop by the configured amount (3 at this
    checkpoint, changed to 1 in 6.98), stopping at 1; ready abilities stay at 0. Its generated hint
    also corrects old saved descriptions that still say floor 0.
    All 802 client specs, app/spec TypeScript checks, the production build,
    110 native Chrome assertions, 490 complete layout checks, eight server config
    parity tests and shipped-schema validation pass. Browser checks use real
    mouse/touch casts on arranged solo snapshots at desktop/phone sizes, both
    colours; cooldowns are reset between the three-use skill checks specifically
    to isolate the use limit. Pool/CP/unit recipients, staged reload, recap,
    Undo, all six CP skill/ultimate limits, read-only exhausted descriptions,
    Recharge's 1-turn floor and same-turn refusal, and Rook splash all pass.
    Backend runtime and config shape are unchanged; online abilities and the
    separate server-first timeout staging limitation remain outstanding.
    Evidence: Windows Temp `cpp-board-timer-20261007-aefdc90d/ABILITIES.md`.
    Uncommitted, WRITTEN, not owner-SEEN. Private services/profiles are stopped
    after validation; owner services/database are preserved.

  - Hex-traced perimeter (6.96), 7 Oct: supersedes 6.94's rectangular frame with
    a gold SVG path on every exposed outer hex edge, including all base/reserve
    panels. The existing panel-seam pass also builds the perimeter, cached by
    radius/orientation; the grid and viewBox are unchanged. All 802 client specs,
    the production build and 22 native Chrome assertions pass. The regression
    spec derives expected edges from the polygons at radii 2/11 in both
    orientations. Browser checks cover desktop/tablet/phone, a closed connected
    perimeter, zoom/fit, flipping, panel selection and reduced motion; one
    intentionally missing edge was detected and restored. All 490 checks in the
    complete layout sweep hold. Evidence: Windows Temp `cpp-outline-20261007-25fbb174/RESULTS.md`.
    Uncommitted, WRITTEN, not owner-SEEN. Backend/config are unchanged.
    Private preview/browser services are stopped; owner services/database preserved.

  - Blue panel seams (6.97), 7 Oct: the battlefield boundary against every
    base/reserve panel is blue (#2563eb) and 4 SVG units wide, replacing dark
    brown. Existing seam geometry, rounded endpoints and click-through remain.
    All 160 board specs, the production build and 27 native Chrome assertions
    pass, including both orientations at desktop/tablet/phone sizes, blue seam
    styles on every boundary, zoom/fit, flipping and panel selection. Screenshots
    confirm the blue seam against both sides' red/green panels. All 490 checks
    in the complete desktop/touch layout sweep hold. The complete 802-spec result from 6.96 remains
    recorded; this cosmetic follow-up reran the board suite only.
    Evidence: Windows Temp `cpp-panel-seams-20261007-9df0934b/RESULTS.md`.
    Uncommitted, WRITTEN, not owner-SEEN. Gameplay/backend/config are unchanged.
    Private services/profiles are stopped; owner services/database preserved.

  - Unit capability/CP budget follow-up (6.98), 7 Oct: unavailable ATK/HEL shows a
    dash and cannot receive positive boosts; negative/zero-setting debuffs persist
    until expiry, including across a Shove unlock. Shove replaces Deflect's name and
    never counters, even with Warcry. Later ATK/HEL modifiers can restore an existing
    zero setter. Unit details close on different UIDs or clear selection; first-tap
    touch attack/heal confirmations now notify the Unit panel without committing.
    Screenshot review also fixed inapplicable path ATK shown as an active bonus.
    Updated pool values and Onslaught's 10 CP price live in the shared config.
    Convert/Strengthen/Recharge and Sap/Cleave/Trap have cooldown 1. Utilities get
    five uses per initialization/numbered phase/overtime; skills retain three match
    uses, ultimates one. Finite labels show remaining uses and grey while cooling
    or exhausted, staying readable. Recharge subtracts 1 with a positive floor of 1.
    Phase scope is mirrored in schema/default/both validators and omission is
    compatible. Initialization permits utilities only. Existing saved counters
    use phase keys; Undo retains the originating key and reload preserves counts.
    All 817 client specs, 372 server tests (368 canonical plus four legacy), final
    development/production builds, migration consistency and shipped-schema validation
    pass. All 490 checks after the template/style changes hold; final runtime fixes
    are verified by 88 real desktop/phone Chrome assertions across both hot-seat sides.
    These use tactical snapshots and actual input, not a new natural or online match.
    All current metafiles were audited; historical reports remain dated snapshots.
    Evidence: Windows Temp `cpp-unit-buffs-20261007-a654dd34/RESULTS.md`.
    Temporary services/profiles stopped; owner ports 4200/8000 and database preserved.
    Uncommitted, WRITTEN, not owner-SEEN. Online casts and server-first timeout staging
    remain deferred; old saved/custom catalogues retain their configured values.

  - Timeout/UX and early-ending follow-up (6.99-6.100), 7 Oct: server-held drafts
    replace the server-first timeout race. Validated private staging, Undo, reload,
    disconnected-player expiry and End Turn share the existing move handlers and one
    atomic revision/sequence-guarded commit. A browser-found first-turn restore race is
    fixed by binding the snapshot before replaying draft clicks. Cast animations follow
    recipients by UID after panel movement, avoid replacement units and cancel on Undo.
    Active-effect rows omit instant healing, explain statuses and show actual remaining
    expiry. Phase 1's eligible White occupancy and Phase 2's zero Black VP freeze pending
    losses until both postmatch halves finish; regicide still takes priority.
    All 824 client specs, 386 server tests (382 canonical plus four legacy), final
    production build and migration consistency checks pass. Two deliberate server
    regressions are caught and source restored byte-for-byte. Native Chrome passes
    61 final assertions: 46 solo desktop/touch checks and 15 real two-client checks,
    including private staging, first-turn reload, five countdown warnings/one hard beep,
    timeout/manual idempotence, disconnected-actor commit/rejoin, Undo and combined
    panel/board batch commits. Solo checks use arranged tactical snapshots and real input;
    multiplayer checks start through login/invite/ready and use the shipped setup.
    The live endings script passes 44 checks across four complete matches: points,
    overtime, Phase 1 loss and Phase 2 loss, including postmatch reconnects. No template
    or stylesheet changed; the earlier 490-check layout sweep remains applicable.
    Current docs/statuses audited; evidence is in Windows Temp
    `cpp-ui-drafts-20261007-19dcbb8c/RESULTS.md`. Migration 0013 was applied only on an
    isolated database. No commit, push, deployment or owner acceptance is claimed.
    Uncommitted, WRITTEN, not owner-SEEN. Private services/profiles are stopped after
    verification; the owner's services/database are preserved.

  - Authorized backend migration/restart (6.101), 7 Oct: the owner asked "migrate it.
    carefully work on the backend now". Only 0013 was pending on the actual database.
    With no attached players, only the backend listener was stopped. SQLite's backup
    API produced and verified `server/backups/db-before-0013-20261007T170554Z.sqlite3`.
    Migration 0013 applied normally; integrity/foreign-key checks pass. Fingerprints
    verify all existing application rows (126 rooms, 107 states, 17 unfinished states)
    are unchanged. Django's expected one content type/four permissions are separately
    verified. Updated daphne serves 8000 at PID 125284; the original frontend remains
    on 4200 at PID 142892. All 386 server tests pass, with clean system/migration checks
    and four read-only live WebSocket checks for handshake, heartbeat and new-command
    room checks. Evidence: Windows Temp `cpp-backend-migrate-20261007-4e91829a`.
    No gameplay/source changes, new dependencies or commit/push. Service is intentionally
    left running. This supersedes earlier notes that the owner's database/services were
    untouched; those statements describe the earlier isolated verification.

  - Backend test audit (6.102), 7 Oct: 20 additional tests cover saved-turn validation,
    private restore and stale sockets, revision/sequence races, combined panel entry and
    normal healing, held overtime combat, payouts, promotion and early phase endings.
    Five before-fix assertions reproduce defects: an invalid older draft can pass over
    its valid replacement or delete the next player's same-sequence draft; three lost
    writes leave a turn without a clock; a reserve entrant can act again; cleanup counts
    cascaded rows as rooms. All five are fixed in the existing helpers, without new
    gameplay rules or dependencies. The invalid-prefix test now uses actual Overtime 2
    (ply 89), so its first move is held before the later invalid command is refused.
    All 406 server tests pass (402 canonical plus four legacy), with clean Django system,
    migration consistency and applied-migration checks. A standard-library execution
    map, including async worker threads, informed the audit; it is not branch coverage
    or a claim that every possible failure is tested. All five real socket scripts pass:
    match 28/28, edges 12/12, endings 44/44, panels 19/19 and new drafts 14/14.
    The saved-turn match uses the shipped deal and real 15-second clock; tactical ASGI
    tests arrange snapshots. No client/config/schema changes or scoring-parity
    regeneration; the earlier 824-client-spec/build/layout evidence remains applicable.
    Evidence: Windows Temp `cpp-backend-audit-20261007-6afce80c/RESULTS.md`.
    Private test backend/database only; owner database fingerprints remain unchanged.
    Owner ports 8000 (PID 125284) and 4200 (PID 142892) are preserved. The source fixes
    require the owner's next normal backend restart to load on 8000; the migrated
    database remains at 0013. Work is uncommitted, WRITTEN, not owner-SEEN. Online
    ability execution remains deferred under 6.15.

  - Pre-merge review (6.103), 7 Oct: fallback timeout passes check draft absence
    atomically under the state-row lock used by saves/commits. A saved draft does not
    bump the board revision, so the revision check alone could skip acknowledged moves.
    Panel-only walks and entries now queue autosaves through selection changes; unchanged
    signatures send nothing. Finishing atomic snapshots log the completed turn and retain
    kill markers before the terminal return, without repeating them on a finished restore.
    Path-choice columns size from their content, keeping whole labels and prices on one
    line at the existing font floor. One server and three client regressions fail before
    the fixes; a native browser stub catches the former equal-width path layout.
    All 827 client specs, 407 server tests (403 canonical + four legacy), production build,
    migrations, 490 complete layout checks and 117 live socket checks pass. Twenty-two
    native Chrome assertions cover actual two-client panel-only saves/disconnected expiry/
    rejoin, both path rows with Arial/Verdana at three desktop widths, and arranged terminal
    history/kill markers/duplicate messages. Matching browser/server squads use the shipped
    battlefield and bases plus one arranged Black reserve pawn. Initial mismatched fixture
    runs are corrected and are not counted as application bugs. No new dependency, schema
    or game-rule change in this review; online abilities remain deferred. Evidence:
    Windows Temp `cpp-merge-review-20261007-60fecabd/RESULTS.md`. Owner explicitly authorized
    committing, pushing and merging dev22 into main; publication status is recorded below.
    WRITTEN, not owner-SEEN. Private services/databases only; owner ports 8000/4200 preserved.

- **The owner's database is at 0013**, checked and migrated at the owner's explicit
  request on 7 Oct 2026 (6.101). Before this operation it was at 0012. A verified SQLite
  backup is in `server/backups/db-before-0013-20261007T170554Z.sqlite3`. Integrity,
  foreign keys and all existing application rows are verified after migration.
  The backend was restarted on 8000; the frontend on 4200 was preserved.
  Future database migrations/restarts still require the owner's authorization.

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
Warcry requires an intrinsic or unlocked attack profile. Vet 2 Shove supplies shieldman
attack capability; its counter remains disabled even while Warcry is active. Configured
healers keep their normal healing action. Unavailable ATK/HEL displays a dash; numeric
zero remains buffable. Negative modifiers stay until expiry and apply on a later unlock.
Older saved rooms keep their catalogues; `legacy-abilities.fixture.json` is test-only.
New games use the specified pool. The CP paths are implemented in solo (6.86, revised 6.98):
Bastion 5 CP, Onslaught 10 CP and Sprint 20 CP. Their utilities replace Reselect;
older catalogues without `path.utility` retain its legacy behavior. Convert, Strengthen
and Recharge have cooldown 1 and five uses per initialization, numbered phase or overtime;
halftime/postmatch share their phase budget, all overtime stages share one budget.
Utilities can cast during initialization; other casts remain blocked there. Recharge
subtracts 1 from both positive pair cooldowns with a floor of 1. CP skills have cooldown 1
and three uses per match. Finite abilities show remaining uses, including ultimates `(1)`
then `(0)`; unlimited pool/unit actives show remaining/total cooldown. Cooling CP controls
remain grey and readable; selection changes close unit details and Use stays pinned to UID.
`usesScope: "phase"` is mirrored across schema and both validators. Existing count keys
get a phase suffix; staged spends retain their original key for Undo. AGENTS.md
records all confirmed targets, scopes, durations, costs and interactions; no CP
rule questions remain pending. The unit/pool/CP core is ready for owner inspection
in solo. Authoritative online ability execution remains deferred under 6.15.
The main-menu controls also remain on one row at every width (6.87).


**Unit-kit milestone complete (6.79), awaiting owner inspection.** The owner supplied
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
by its attack. Taunt costs 1 UP/CD 1; Call costs 5 UP/CD 5. Counter/Shove are ATK before
DEF. Cleave hits adjacent enemies around the rook with normal ATK/DEF. Charge requires an
actual counter and has no second counter. Sacrifice buffs friendly battlefield/green
units for one full turn and heals 1 immediately. Rook Bog stacks without a cap for one full turn. Queen/King auras start on their owner's turn, covering adjacent
battlefield enemies/allies respectively. Regenerate heals living battlefield/green
bishops on their owner's end turn, even without acting. Hop crosses multiple enemies and
open panel gateways. Call covers battlefield/green, with both 1 immediate enemy HP damage
and -1 ATK for the full turn. Shove never permits shieldman counters, including while Warcry is active.
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
Initialization permits the bought path's CP utility (6.98), while other casts and normal
healing remain blocked. Existing movement allowances, prices,
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

**Latest announcement revision:** 900 ms right-to-left slide, ~500 ms centre pause, a 160 ms
volume/mute-aware swoosh, and no pointer blocking. Both White and Black get a notice,
with Turn N above the side name in a matching white/black box, after replay completes.
Reduced motion disables the slide.
The clock clarification is still pending: the owner said the announcement should not count
against the timer; the outstanding question asks whether to exclude those 900 ms while
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
6.57-6.69 and 6.71-6.103 remain WRITTEN, not SEEN. Agents have driven running browsers with mouse and emulated
touch, and the evidence is recorded there; that does not claim a physical-phone playtest or
owner acceptance. Nothing moves to SEEN except by the owner saying so.

**Multiplayer timeout decision resolved, 7 Oct (6.99).** The owner chose "Commit the
saved moves" after disconnect. The server now validates and persists private drafts,
then commits the latest saved turn atomically at expiry, including during disconnect
grace. End Turn uses the same batch; Undo replaces the saved draft. Draft sequence and
board revision protect timer/manual races. Reload binds the incoming board before
reconstructing its staged clicks. Migration 0013 is required for the updated backend;
its initial verification used an isolated database. At the owner's later explicit
request, 6.101 applies it to the actual database and restarts the backend. Existing
records are preserved and the backup is recorded above. Online ability execution
remains deferred under 6.15.

**Early results implemented, 7 Oct (6.100).** Phase 1 checks eligible White occupancy
on a capture-zone hex, including contested occupancy. Phase 2 checks Black's phase
VP tally, not occupancy: zero freezes a pending Black loss. Both postmatch halves
still run, then the pending loss resolves at new ply 29/51. King death takes priority.
The frozen phase bank carries the result through reload. Old/late banks do not infer
historical occupancy from later boards. Both engines and 382 scoring parity cases
agree. No new config field or online ability implementation was introduced.

**Deferred by the owner. Do not start these unasked:**

- **Server-side abilities (PUNCHLIST 6.15).** Abilities are still solo-only: a networked room
  refuses every cast.
- **The remaining solo/network validation gap, PUNCHLIST 6.17.** Ordinary networked
  browser flows have been exercised (6.82, 6.85, 6.88). Authoritative online abilities
  remain the deferred work under 6.15.
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
