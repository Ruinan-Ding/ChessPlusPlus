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
are in `scripts/layout-sweep.mjs`.

## Rules and state

Both engines load [the shared default config](../shared/default-config.json). The client
normalizes and validates it in `src/app/services/config.service.ts`; change the schema and
both validators together when a config field changes.

`PieceData` and `BoardState` are shared from `game-state.service.ts`. Selected units carry
numeric attack tiers until display formatting. `ability-rules.ts` contains the existing pure
solo effect and cooldown calculations; the room owns targeting, staging and persistence.
The first four pairs use the specified shared catalogue. `history-rules.ts` also applies
the Phase 3 veteran full heal; the board announces full turns and schedule milestones.
Online abilities remain deferred. The [handoff](../CODEX_HANDOFF.md) records current branch,
verification and outstanding work; [AGENTS.md](../AGENTS.md) is the workflow and game-rule
source of truth.
