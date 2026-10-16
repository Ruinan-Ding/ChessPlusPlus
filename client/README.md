# Client

Angular 19 frontend. Run commands from `client/`; the Angular CLI is a local dependency,
so use `npx ng` or the npm scripts. Install with `npm install` (CI uses `npm ci`).

## Run and build

```bash
npx ng serve
npx ng build
```

Development serves at http://localhost:4200. The production build goes to
`dist/client/browser/`. See the [root README](../README.md) for the backend and `start.sh`.
Under this repo's WSL environment, Node dependencies are Windows installs; invoke commands
through `cmd.exe /c "npx ng serve"` or `cmd.exe /c "npx ng build"`.

## Checks

```bash
npx ng test --watch=false --browsers=ChromeHeadless
npx tsc --noEmit -p tsconfig.app.json
```

On the current WSL/Windows setup, the client suite uses the installed Chrome:

```bash
cmd.exe /c "set CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe&& npx ng test --watch=false --browsers=ChromeHeadless"
```

After template or stylesheet changes, run the existing layout sweep against a development
server on a spare port, as described in [AGENTS.md](../AGENTS.md). The project has no Angular
CLI `e2e` target. Live WebSocket checks are in `server/scripts/e2e/`; browser layout checks
are in `scripts/layout-sweep.mjs`. CI's server job re-records the frozen scenario in
`shared/recording/`; the client job downloads it and the rendered integration suite
compares its complete solo playback with the online result. Local runs use the
checked-in fixture.

## Rules and state

Both engines load [the shared default config](../shared/default-config.json). The client
normalizes and validates it in `src/app/services/config.service.ts`; change the schema and
both validators together when a config field changes.

`PieceData` and `BoardState` are shared from `game-state.service.ts`. Selected units carry
numeric attack tiers until display formatting. `ability-rules.ts` contains the existing pure
solo effect and cooldown calculations. `game-command.ts` separates untrusted imported
steps from validated semantic commands; `game-history.ts` models the existing history
variants. `turn-staging.ts` supplies one chronological view for command adapters and
unit-action budgets. `ReplayController` and `CpuTurnController` own lifecycle state;
the room supplies input, rendering, persistence and clock adapters. Both ability
panels use one template parameterized by side and cooldowns.
The first four pairs use the specified shared catalogue. `history-rules.ts` also applies
the Phase 3 veteran full heal; the board announces full turns and schedule milestones.
Solo uses `checkpoint_turn` / `rewind_turn` locally to reopen the previous side's
full turn, including after a result. Known turn starts store the core checkpoint;
`staged: true` saves its pre-commit UI without replacing that start. Rewind restores
the completed actions as editable staging, including the board's panel Undo stack;
R undoes them one by one, including pool/path purchases and pair returns, with
payments, cooldowns and first-pair timing restored. Reload retains that staging. Config and history stay
stored once. Snapshot loads and ordinary animations create no new checkpoints;
unrecorded turns in older saves remain unavailable.
Online turns use `save_turn_draft` / `commit_turn` when the server advertises
`turnDraftsSupported`. Staging and Undo save a private validated draft; End Turn and
timeout commit one batch. Reload binds the snapshot before restoring staged clicks.
Older servers keep the existing command path. Current servers advertise
`abilitiesSupported` and resolve pool, unit and CP abilities authoritatively from
configured IDs and targets. Automatic replay and the 900 ms nonblocking turn notice
consume no turn time; manual Replay counts. The [handoff](../CODEX_HANDOFF.md) records
current branch, verification and outstanding work; [AGENTS.md](../AGENTS.md) is the workflow and game-rule
source of truth.

Unit actions follow move → UP ability → attack; steps are optional. A unit ability
ends movement and attacking blocks later unit abilities. Archer Withdraw permits
partitioning/reordering its own movement, one attack and one unit cast within its
MOV budget. Unit casts spend their source category’s slot; switching actors closes
the earlier unit only within that category until Undo. All three gates open during
Initialization/postmatch. Opposing active Charge adds one final counter to the
second attack, with no further chain. Pool and CP casts remain separate. Long ability descriptions scroll inside their fixed box;
the left rail and its action buttons keep their positions.

`phases.ts` derives phase/overtime schedules once per resolved match-section identity.
Replace sections when config changes rather than mutating them in place. This avoids
rebuilding schedules in per-cell template queries during large-area casts.

Ability entries can limit casts with `uses`; `usesScope: "phase"` gives a separate
budget for initialization, each numbered phase (including halftime/postmatch) and
overtime. Missing scope keeps a match budget. The room saves counts by holder,
ability id and phase, and Undo restores the originating budget. CP utilities are
allowed during initialization; ordinary casts remain blocked. ATK/HEL capability
checks use the configured profile and unlocked passive, distinguishing absent stats
from temporary numeric zero. See [AGENTS.md](../AGENTS.md) for current game rules.

Match rules resolve through `game-rules.ts` and the shared draft-07 schema (`ajv`),
mirroring Python `game_rules.py` (`jsonschema`). Format-1 imports use frozen compatibility
data. See [CONFIGURATION.md](../CONFIGURATION.md) for parameters, migration and snapshot
semantics. The balance revision remains null; the JSON editor is the existing setup UI.

Portable replay files use `type: "chessplusplus-replay"`, `version: 1`, resolved
`config`, `players: {white, black}` and `actions: [{ply, color, command}]`.
`shared/replay-command-fields.json` defines the canonical input fields for both
engines. No transport tokens, private drafts or computed combat payloads are exported.
`ReplaySessionService` validates the envelope/config, writes each import under a
separate session ID in IndexedDB, and coalesces subsequent metadata/frame writes.
The header and its initial state share a transaction. `LocalGameService` swaps its
in-memory engine while replaying; ordinary solo localStorage remains untouched.

The room shares command staging with online draft restoration, then validates the
result of each input. Invalid compound inputs roll back their core/UI/panel frame.
Backward seeks restore cached frames or rebuild from config; forward playback yields
between actions and can be cancelled. Frames omit the frozen config, Q checkpoints
and duplicate recordings. Processing allows 8 MiB per computed frame; cache allows
16 MiB and at most 12 frames. Corrupt/skipped actions are omitted from branch exports.
New online matches need backend migration **0015** and the updated consumer; old
matches keep a null journal and cannot export a complete recording.

Karma's heartbeat allows 60 seconds, with a 90-second inactivity watchdog. The
rendered 100-ply `fakeAsync` integration spec can hold the browser thread around
19 seconds on Windows; the old five-second heartbeat intermittently disconnected
an otherwise passing suite. Jasmine's assertion/async test limits are unchanged.

Sacrifice refreshes one recipient’s temporary stats
without stacking; every cast still promotes and heals. Walking home uses the
departure rank for its refund, then resets stars; Undo/reload retain that reset.
Path prices are 5/50/100 CP. Onslaught boosts initiated ATK and existing HEL;
Sprint boosts base MOV and discounts all owned ability casts by 3, minimum 1,
with no healing. Prior catalogue/refund configurations retain their own rules.

CPU mode uses `CpuService` and the shared WebSocket address helper. The server
returns validated semantic commands; the room stages them through the same
recorded-command interpreter as replay, then uses normal solo End Turn. CPU
metadata is optional in local saves, and replay viewing never starts CPU jobs.
Rewind, leave and timeout cancel the request generation; obsolete queued work and
late answers or failures cannot overwrite a newer turn.
Failed staging or commit restores both engine and UI state before offering recovery.
Local engine sends return synchronous acceptance; solo batches stop at the first
refusal, before a following pass can advance an incomplete turn.
