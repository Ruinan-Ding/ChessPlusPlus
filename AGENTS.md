# Agent core

ChessPlusPlus is a config-driven hex tactics game: Angular19 in `client/`,
Django Channels in `server/`, shared contracts in `shared/`. Read this core once.
Ordinary development requests and `/scrum` use [.claude/skills/scrum/SKILL.md](.claude/skills/scrum/SKILL.md):
SAFe-aligned SDD → BDD → TDD with the human Product Owner and roles on demand.

## Owner constraints

- Invoke `/ponytail` (full) for code/design. The user-scoped Claude plugin comes
  from `DietrichGebert/ponytail`: `/plugin marketplace add DietrichGebert/ponytail`,
  then `/plugin install ponytail@ponytail`. Disclose unavailable plugins rather
  than claiming invocation. Follow its rules instead of copying them here.
- Use `git.exe` for status and mutations from WSL; read-only WSL git is fine.
  Preserve existing dirty work. Commit/push/merge, migration, deployment and service
  restart require the user's applicable authorization; the workflow adds none.
- Preserve the owner's4200/frontend,8000/backend and actual database. Use spare
  test ports and stop only task-owned processes. Keep DJANGO_DEBUG=true on every
  local manage.py invocation; don't weaken production security to make tools run.
- Game mechanics, balance and public claims are the owner's decisions. Ask about
  consequential missing rules; do routine reversible implementation autonomously.
  Keep WRITTEN/verified distinct from owner-SEEN, running, published or released.

## Architecture invariants

Before changing a domain, search and read its relevant contracts in
[PROJECT_RULES.md](PROJECT_RULES.md). All former detailed AGENTS technical sections
are preserved there; current schema/config and dated accepted decisions matter.

- Unit IDs are opaque; behavior comes from config. No unit-specific engine branches.
  Shared default-config.json is the balance source; CPU policy is cpu-tuning.json.
  Stat99/rank3 remain invariants and ruleset.revision stays null until approved.
- Schema/defaults and both validators change together via
  [.claude/skills/config-sync/SKILL.md](.claude/skills/config-sync/SKILL.md).
  Keep legacy configs, saved sparse maps/effects and started-match snapshots frozen.
  Read per-match rules, never module constants; preserve explicit0 and reject null
  where invalid. Fixed behavior examples use shared/testing/balance-config.json.
- Solo and authoritative server rules must agree, including panels, active rank,
  movement/casts/combat, scoring before control expiry and command ordering.
  Wire commands express intent; the server derives outcomes. Maintain identity,
  revision/sequence checks, atomic turn drafts, Undo/reload/replay and timer races.
- Changes to board fields must survive set/move/serialization/reconnect. Rendering
  and real controls need browser evidence; unit assertions cannot establish it.

## Checks and targeted context

Use installed tooling; Windows executables are under server/venv/Scripts and
client/node_modules. See PROJECT_RULES “Commands” for native Windows launch details.

- Server: `DJANGO_DEBUG=true python manage.py test game.testsuite`; drift check:
  `python manage.py makemigrations --check --dry-run` with the same debug setting.
- Client: `npx ng test --watch=false --browsers=ChromeHeadless`, `npx ng build`.
- Cross-engine/config changes require both suites and applicable parity/schema/
  migration checks. Drive affected rendered and real socket paths, custom starts,
  Undo/reload where relevant. Run the existing full layout sweep after any
  template/style change; do not substitute unit tests. Docs/agent-only changes
  need relevant structural/link/instruction checks, not unchanged gameplay suites.

| Need | Read/search only this context |
|---|---|
| Current task | Top of SCRUM_BACKLOG.md → one contract; SCRUM_WORKFLOW.md once as lead |
| Geometry/config/combat/economy/panels | Matching heading and exact terms in PROJECT_RULES.md; CONFIGURATION.md and affected source |
| UI, solo, staging, replay, sockets, identity | Matching PROJECT_RULES section and actual callers/tests |
| Browser/live commands or Windows quirks | PROJECT_RULES.md: Commands / Known quirks |
| Delivery/source history | Search the exact checkpoint/topic in CODEX_HANDOFF.md or PUNCHLIST.md; do not read either whole |

Use `rg -n '^## ' PROJECT_RULES.md` or a concrete search, then bounded sections.
Workers get requirement IDs, owned files, constraints and expected results, not
full histories. Runtime policy controls delegation; keep one writer per file and
no recursive teams. Report unavailable independent review and unperformed checks
honestly. One contract owns evidence; backlog/handoff/punchlist link to it.
