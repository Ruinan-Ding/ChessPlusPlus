# Scrum delivery with SDD, BDD and TDD

SDD (specification-driven development) is active: requirements guide the work,
BDD makes them observable, and TDD drives behavior changes. The human is Product
Owner. One cross-functional team owns the Increment; profiles express senior
capabilities and inherit models, not credentials or extra authority. This is
project guidance, not provisioned enterprise administration.

## Start small

Use `/scrum <request>` or ordinary development language. The lead reads this
workflow once and applies [AGENTS.md](AGENTS.md). Workers use their bounded task
packet and required core/domain constraints, without restarting intake or teams.
Use the existing Ponytail plugin for code/design and the relevant domain skill.

Check branch/dirty files before editing. Read only the [current-work pointer](SCRUM_BACKLOG.md#current-work).
Resume its contract only if it matches the request; otherwise create/update the
matching contract. Completed work is history, not every new task's context.
Read continuation state first, then affected requirements/evidence/source.
Search [PROJECT_RULES.md](PROJECT_RULES.md) by heading/term for applicable contracts.
Backlog history and delivery ledgers are lookup sources, not startup reading.

## Informal request → contract → examples → implementation

Automatically normalize the request before implementation. The user need not
write a spec or invoke a separate translator. For vague/vibe language, use the
[intake procedure](.claude/skills/scrum/references/intake.md); a structured request
can go straight into the same contract. Translation preserves intent and does
not invent features, gameplay, personal claims or numerical targets.

Use one contract: a small inline backlog entry for trivial work; otherwise
`specs/<story-id>-<slug>.md`. Reuse existing requirements/schema and link them;
do not copy the product specification. Keep only applicable fields:

```text
ID / status / source request / desired outcome / scope and exclusions
R1: observable requirement [explicit request | existing rule | assumption | question]
A1 → R1: Given initial state, When action, Then outcome → test/observation
Constraints, material open decisions and significant design choice
Continuation: current source/dirty scope, completed checks, gap and next action
Evidence: source/files, commands/results, review/gaps and full-log references
```

A compact contract is initially 150–350 words; clarity and safety override targets.
For resumable work keep continuation state near the top, updating it at handoff
or material changes, not every tool call. Long evidence stays below/in linked logs.
Mark inferred reversible choices as assumptions. Ask only when missing information
changes product semantics, public claims, acceptance, compatibility or irreversible
work. Continue independent work while dependent decisions wait. Preparing a spec
adds no approval gate; enough intent in the request is authorization to proceed.
Never call an inferred requirement owner-approved. Follow-up steering updates the
same requirement/example IDs and supersedes affected decisions before further edits.

Before a behavior change, product/development/quality perspectives refine the
examples; the lead can cover all three. Run the smallest meaningful behavioral
test against the unchanged implementation (Red), implement minimally (Green), then
refactor and integrate. Setup errors are not Red. For refactors use characterization;
for docs, agent configuration and static content use appropriate structural or
rendering checks. If code predates a test, report that chronology honestly.

Keep `R → A → test or observation → implementation/evidence` traceability in the
contract, without requiring IDs in every code line or creating duplicate feature
files. Review checks spec/code drift, acceptance gaps and changed contracts. A
spec update cannot silently excuse a regression or override an accepted owner rule.

## Senior Scrum team, activated by need

| Capability | Profile | Shared responsibility |
|---|---|---|
| Facilitation | [Scrum Master](.claude/agents/scrum-master.md) | Goal, WIP, impediments and improvement |
| Product analysis | [Product analyst](.claude/agents/product-analyst.md) | Intent translation, scope and examples |
| Architecture | [Architect](.claude/agents/architect.md) | Minimal design, contracts and compatibility |
| Frontend | [Frontend](.claude/agents/frontend-developer.md) | Interfaces, state and browser behavior |
| Backend | [Backend](.claude/agents/backend-developer.md) | Authoritative rules, sockets and persistence |
| Quality | [Quality](.claude/agents/quality-engineer.md) | BDD/TDD, integration and evidence |
| UX/accessibility | [UX](.claude/agents/ux-accessibility.md) | Comprehension, access and responsive use |
| Security/reliability | [Security](.claude/agents/security-reliability.md) | Trust, races, preservation and resource use |
| Delivery | [Release](.claude/agents/release-engineer.md) | CI and authorized delivery readiness |

The lead usually implements small work, covering facilitation and analysis.
For substantial independent slices use only relevant specialists within runtime
capacity/policy, plus one qualified non-author review when available. Same-file
or dependent work stays sequential. All participants own quality beyond their
specialty, explain important tradeoffs and surface uncertainty. No recursive teams.

Send a compact packet (aim ≤250 words): contract/requirement IDs, source identity,
owned paths, relevant constraints/interfaces, checks and allowed side effects.
Prefer a fresh bounded context when supported; otherwise do not repeat inherited
history. One writer per file, including tests/docs; confirm a worker is stopped
before transferring ownership after interruption. Preserve existing dirty source.
Workers return changed paths, command/results, findings and gaps (aim ≤200 words),
linking full logs instead of pasting them. Read-only reviewers need actual delta,
new files and source-bound evidence; they cannot claim unperformed execution.

## Scrum state and delivery

The backlog owns ordering and a short current-work pointer; the contract owns
acceptance, technical decisions and evidence. Use Ready → In progress → Review →
Done, or Blocked with a concrete dependency. Dates/cadence/Sprint Goal require
agreement; otherwise label work unscheduled. Refinement clarifies examples;
Planning selects a goal and feasible work; Daily Scrum adapts the plan; Review
inspects the Increment with actual feedback; Retrospective chooses an improvement.
Record these outcomes only when events occur. Session updates are not meetings.

Done requires applicable examples, meaningful regressions, required repo-specific
checks, integrated source review, truthful gaps and current relevant guides.
Cross-engine/config changes follow config-sync; template/style edits require the
existing full layout sweep. Use meaningful real control/socket paths when affected.
A missing required check stays outstanding; do not reduce coverage to save tokens.
Preserve failed output and investigate the cause before retrying. Reuse passing
checks only while source/environment and scope still match; rerun affected checks
for a fix, integration delta or unresolved failure. Summarize output; tests consume
tokens when their output is loaded, so store full logs outside the working source.

Update one canonical contract. Other records link to it with only genuinely new
status/source/publication facts; do not repeat a narrative across backlog/handoff/
punchlist. Search exact history sections only when needed. Stop only task-owned
services/workers. Commit/push/merge, migration, restart and deployment follow the
user's actual authorization. Technical Done, publication and owner acceptance
remain separate facts; source settings and runtime discovery do not prove behavior.
