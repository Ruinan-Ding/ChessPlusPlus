# Scrum backlog

Updated 17 Oct 2026. The human owner orders this backlog and owns product/game
decisions. [SCRUM_WORKFLOW.md](SCRUM_WORKFLOW.md) defines the process;
[CODEX_HANDOFF.md](CODEX_HANDOFF.md) records current source/environment and
[PUNCHLIST.md](PUNCHLIST.md) retains implementation checkpoints. Do not duplicate
their historical fixes here or treat this file as a second game specification.

## Current work

**WF-004 — Efficient SDD delivery: Done for scoped implementation/checks; unscheduled.** The owner requested
cheaper context loading and automatic informal-request → SDD → BDD → TDD delivery.
[Contract, acceptance and evidence](specs/WF-004-efficient-sdd.md) are canonical.
All existing dirty product work is preserved. Resume this contract only for
matching workflow work; new requests use their own contract. Read completed
entries below only for a concrete historical question.
SDD is active now; earlier “optional/future SDD” entries describe their dated state.

## Product Goal

Proposed for owner confirmation at first planning: deliver a maintainable,
configurable tactical game with consistent solo/multiplayer rules and usable,
verifiable player journeys. This proposal creates no new mechanics or release.

## Current Sprint

No Sprint dates, cadence or Sprint Goal have been agreed. No Sprint is claimed
as started or finished. At first planning, agree them and select achievable
stories; two weeks is a suggested cadence, not a scheduled commitment.

## Ordered work

### WF-001 — Establish the Claude Scrum delivery workflow

- **Source/outcome:** owner's 15 Oct request for a complete agile Scrum team,
  using TDD/BDD with possible SDD later.
- **Scope:** native project agent profiles, team configuration, `/scrum`, shared
  responsibilities/events/artifacts, acceptance/testing, review and current docs.
  No gameplay, balance, deployment or release change.
- **Owner:** current implementing session; one writer for workflow/shared docs.
- **Status:** Done for workflow configuration; native discovery and structural
  checks pass. No live-team development story or independent agent review ran.
- **Dependencies:** installed Claude Code and repo skills; native team behavior
  needs an interactive session. Other runtimes follow their own delegation policy.

| Example | Given / When / Then | Verification |
|---|---|---|
| WF-001-A | Given a fresh project Claude session, when work is requested, then the skill and relevant specialist profiles are discoverable and use the shared workflow without changing permissions/models. | Agent/skill/settings validation; session discovery check, with runtime limits stated. |
| WF-001-B | Given a behavior change, when the team refines it, then product/development/quality agree observable examples and follow Red/Green/Refactor with evidence. | Workflow and role contract review; no gameplay test required for this workflow-only change. |
| WF-001-C | Given an unspecified gameplay rule or dirty source, when work is delegated, then the owner decides that rule and workers preserve the intended source with one writer per file. | Scenario walkthrough of decision and handoff rules. |
| WF-001-D | Given a docs-only task, unavailable teammates or a later SDD request, when planning work, then checks are proportionate, missing independent review is visible and SDD is not silently enabled. | Structural checks and scenario walkthrough; no fabricated team execution. |

Verification: Claude Code 2.1.288's local `/context` reports all nine custom agents;
`/skills` shows project `scrum` and `config-sync`. YAML/JSON, skill validation,
local links, working-source preservation and ten scenario walkthroughs pass.
Walkthroughs are instruction reviews, not model behavior tests. Evidence:
Windows Temp `cpp-scrum-20261015-c8c0osf_/RESULTS.md`; implementation checkpoint
6.151 in PUNCHLIST. No gameplay tests rerun for this workflow-only change.

### WF-002 — Review enterprise scope and practical operation

- **Source/outcome:** owner's follow-up asking whether this is the enterprise
  Claude workflow and whether it makes sense in practice.
- **Scope:** clarify project versus organization controls, proportionate staffing,
  worker/orchestrator boundaries, usable read-only review inputs and evidence.
- **Owner/status:** current session; Done for the instruction/documentation scope.
- **Acceptance:** a read-only reviewer receives the actual story delta/new files
  and source-bound check evidence; a worker reports to the lead instead of starting
  another team; later edits require review/check reassessment; docs distinguish
  configured roles and current CI from unverified live collaboration/admin controls.
- **Verification:** YAML/skill/link and unchanged-frontmatter/settings checks,
  focused instruction walkthroughs and preservation of unrelated source. Evidence:
  Windows Temp `cpp-workflow-review-20261015-a979qv19/RESULTS.md`, checkpoint 6.152.
  Self-review only; no new live-team, model evaluation or gameplay run claimed.

### WF-003 — Add practical operating guidance

- **Source/outcome:** owner's follow-ups about additions, role counts and whether
  every agent works to a senior standard.
- **Scope:** handling scope changes/urgent defects, baseline and flaky-test
  failures, brief significant-decision records, reusable staffing/senior-level
  expectations and a real-story workflow trial.
- **Owner/status:** current session; Done for the instruction/documentation scope.
- **Acceptance:** changed requests update the active story; defects have concrete
  reproduction/impact and retain regression/review checks; a passing retry cannot
  erase an unresolved failure; significant decisions retain rationale in an
  existing record; the next actual story evaluates collaboration without inventing
  product work, Sprint dates or a claimed trial result. Roles can have multiple
  independent instances; senior-level expectations do not claim upgraded models
  or proven expertise from a label.
- **Verification:** skill/YAML/link checks, unchanged native frontmatter/settings,
  instruction walkthroughs and unrelated-source preservation; checkpoint 6.153.
  Evidence: Windows Temp `cpp-workflow-operations-20261015-961t3g8j/RESULTS.md`.
  Self-review only; no live-team or gameplay evaluation is claimed.

### REL-001 — Review readiness before pushing and deploying

- **Source/outcome:** owner's request for any remaining concerns before publication.
- **Status:** readiness review complete; deployment preparation remains outstanding.
- **Evidence:** application source matches the last verified 6.150 snapshot; no
  full gameplay suites rerun. Production-default checks with synthetic key/host
  report four security warnings; the actual target/proxy remains untested.
- **Publication:** source `3df74dc` is pushed and merged into main in 6.155;
  [source CI passes](https://github.com/Ruinan-Ding/ChessPlusPlus/actions/runs/38826276661).
- **Remaining delivery work:** implement the selected hosting configuration/
  persistence, resolve production checks and
  smoke-test real solo/CPU/two-player HTTPS/WSS behavior. Publication/deployment
  was not performed by this review. Hosting scope and target are still to be set.
- **Record:** PUNCHLIST 6.154 and Windows Temp
  `cpp-release-readiness-20261015-nquio_3b/RESULTS.md`.

### REL-002 — Publish and merge the verified candidate

- **Source/outcome:** owner requested git push/merge.
- **Status:** source `3df74dc` pushed on feature/dev24 and merged into main;
  source branches retained. The merge adds publication docs only over tested code.
- **Verification:** [source CI](https://github.com/Ruinan-Ding/ChessPlusPlus/actions/runs/38826276661)
  passes both jobs; [main CI](https://github.com/Ruinan-Ding/ChessPlusPlus/actions?query=branch%3Amain)
  identifies the final merge revision. Publication/source/link checks recorded in
  PUNCHLIST 6.155 and Windows Temp `cpp-publication-20261015-yhrq3tzp/RESULTS.md`.
- **Boundary:** hosting, production hardening and target smoke checks from REL-001
  remain outstanding. No deployment or balance release is performed here.

### BAL-001 — Make balance adjustments data-driven

- **Source/outcome:** owner's 16 Oct request to fix the parameterization audit.
  Preserve shipped gameplay while exposing useful tuning controls and removing
  test/CPU assumptions that force code edits during ordinary rebalancing.
- **Status:** Done for the authorized implementation and verification scope;
  unscheduled work, with no Sprint dates or owner acceptance invented.
- **Source/ownership:** clean `feature/dev25`, base `a64634d`; lead owns the shared
  schema/defaults, domain loaders, client implementation and durable records.
  Backend and CPU specialists own disjoint implementations/tests; quality owns
  existing fixture decoupling and reviews. One writer per file, handoffs recorded.
- **Scope:** CPU JSON policy and authoritative refund ranking, frozen behavior
  test inputs, Leech/regeneration percentages, Recharge floor, independent unit
  economic values, matching validators/readers/UI and compatibility checks.
  Existing 99-stat/three-star invariants and draft balance identity stay intact.
- **Acceptance:** BAL-A: custom refunds affect both CPU candidate and beam order.
  BAL-B: shipped numeric changes do not alter fixed behavior-test arrangements;
  actual-default validation remains. BAL-C: zero/partial/omitted healing and
  cooldown fields agree across client/server and survive Undo/reload. BAL-D:
  bounty/withdrawal/wrap/attrition overrides are independent and explicit zero
  works. BAL-E: missing/empty/sparse saved maps and cast ratios retain their own
  values when the shipped preset changes. BAL-F: real controls, displayed rules,
  full suites, build, schema and migration checks cover the integrated source.
- **Verification:** initial client/backend/CPU behavioral Red preceded fixes.
  Full 593 backend and 1,082 client checks, build, schema/default round-trip and
  migration drift checks pass. Perturbed pawn value/HP/veteran HP 13/17/5 passes
  1,082 client and 592 backend checks; only the intentionally contradicted
  disk-memory equality check is excluded from that experiment. Rendered controls
  cover Recharge floor0/Undo/reload; a real two-ASGI-connection free wrap/rejoin
  retains every new field while defaults are changed. Native JSON editor/save,
  solo start/reload and four widths show no new layout fault versus base `a64634d`.
  Existing phone panel scrolling/320px unit-face collisions remain; full layout
  sweep and physical-phone/owner acceptance are not claimed.
- **Review:** backend, CPU and quality specialists reviewed disjoint integrated
  changes. Findings on sparse-map defaults, actual refund beam ordering, legacy
  max HP, tooltip accuracy and CPU misspelled keys were fixed. Reviewer usage
  limits prevented independent re-review of the final CPU-key delta; the lead
  reviewed it and reproduced six fail-fast cases. Final test-only cleanup was
  lead-reviewed. No unresolved implementation finding remains in this scope.
- **Evidence/next action:** checkpoint 6.156 and Windows Temp
  `cpp-balance-20261016-y1q2tb46/RESULTS.md` preserve commands, results and source
  identity. Ready for owner review; no publication requested for this new change.
  Earlier Ruinan-Ding publication authorization was scoped to that repository.

No further product priorities have been assigned through this workflow yet.
Append owner-requested stories in their actual priority order during refinement.

## Impediments and improvement

- First Sprint planning and Product Goal confirmation are pending; this does not
  block the authorized workflow setup.
- No stakeholder review or retrospective has been held for this new process.
- Proposed first improvement experiment: use the next owner-selected bounded
  story that changes behavior as a real workflow trial. The facilitator traces an
  accepted example through Red/Green, relevant integration and independent review where permitted,
  checks that evidence is complete and records avoidable handoff delays or missing
  capabilities. Review at the first actual retrospective and select a correction
  from observed friction. BAL-001 exercised this delivery flow with real
  delegation, TDD/BDD and reviews; final reviewer usage limits required an honest
  lead-review fallback. No Sprint events or retrospective are claimed.
