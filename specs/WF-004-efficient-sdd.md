# WF-004: efficient SDD delivery

Status: Done for instruction implementation and scoped verification; not owner acceptance. Source: owner's 16–17 Oct request to save tokens, activate SDD,
and translate informal/vibe requirements automatically within the Scrum/BDD/TDD team.
Scope: repository instructions and skills; existing product code and uncommitted
balance work remain outside this change. Owner is Product Owner; lead owns these files.

## Continuation

17 Oct: scoped instruction work/checks complete on `feature/dev25` over
`a64634d` plus the preserved dirty source. SDD, informal intake and all nine roles
are present; completed-contract routing and compact continuation state are fixed.
Skill/link/structure/preservation checks pass; current review is lead-only.
Next: commit/push as requested on 17 Oct, then check exact-commit CI. Service
state is unchanged; live agent behavior and actual token savings remain unmeasured.

## Requirements and acceptance

| ID | Required outcome | BDD example and verification |
|---|---|---|
| R1 | Load short core guidance and task-relevant context; preserve detailed contracts. | A1: Given a fresh session, when starting a docs task, then it can follow the core/skill without loading game or delivery history. Measure core/entry sizes and verify reference routing and preservation. |
| R2 | Translate informal requests into one concise SDD contract before implementation. | A2: Given “make it cleaner and easier on phones”, when intake runs, then it records the source intent, observable examples, assumptions, scope and checks without inventing content, mechanics or arbitrary performance targets. Evaluate a realistic intake. |
| R3 | Preserve product authority and make uncertainty explicit. | A3: Given an unspecified reward or personal claim, when drafting the contract, then the decision remains an open question; dependent work waits, independent work proceeds. Routine reversible choices need no extra approval. |
| R4 | Link SDD requirements to BDD examples, TDD checks and the final source. | A4: Given a behavior change or follow-up, when implementing, then requirement → example → test/observation → code evidence is current, with genuine Red/Green or an honest alternative; review covers drift and affected deltas. |
| R5 | Keep the full senior Scrum capabilities available at proportionate cost. | A5: Given a small task, when staffing, then the lead covers roles without launching a team; independent work/review uses bounded context, one writer per file and no recursive teams. Preserve native frontmatter/model/permission settings. |
| R6 | Keep delivery truthful and avoid repeated paperwork/checks. | A6: Given completed work, when reporting, then one contract owns evidence/next action, other records link to it, required checks remain and unrelated suites are not rerun. Structural/link checks and independent workflow exercise; no runtime claim from instruction tests. |
| R7 | Route new requests independently and resume without replaying history. | A7: Given a completed current-work pointer and an unrelated request, use a new/matching contract; given a continuation, read its short state then only relevant evidence/source. Walk through both routes and inspect the context budget. |

## Decisions

SDD means specification-driven development and is active now. Existing accepted
schema, tests and rule docs are reused as contracts; no parallel game spec or
framework is introduced. Tiny work uses an inline backlog contract; multi-file,
behavioral or resumable work uses one specs/<story-id>-<slug>.md. Drafting a contract
executes the requested workflow and does not grant product/publication authority.
The translator is implemented in the native /scrum skill's instructions, invoked
for ordinary development language; no separate user command or parser is required.

## Evidence, 16 Oct

- A1/R1: core reduced from 51,363 to 580 words (98.9% smaller);
  workflow 967 words, entry skill 185. Word counts measure context size,
  not billed tokens. Every technical byte from the prior AGENTS “What this is”
  onward remains intact in PROJECT_RULES.md; affected-reference lookup replaces
  mandatory whole-file reads. Other pre-existing product files are hash-preserved.
- A2/A3/R2/R3: one independent bounded-context reviewer produced two real intake
  artifacts: phone profile cleanup and vague battle/rewards changes. The former
  proceeds with reversible assumptions/preserved information; the latter keeps
  material product decisions pending one bundled question and continues independent
  characterization. Artifacts: Windows Temp `scrum-forward-intake-20261016-7dr93y_u`.
- A4–A6/R4–R6: spec/example/check/source mapping, superseding follow-ups, required
  checks, ownership and no recursive teams are covered by instruction review.
  Local links, YAML/skill validation, settings and all nine native role frontmatters
  pass; model/tool grants are unchanged. Reviewer findings on redundant UX approval
  wording and cross-project terminology were fixed and independently re-inspected.
- Source and reproducible structural evidence: Windows Temp `scrum-sdd-20261016-pmu8075_`.
  Installed CLI version observed: Claude Code2.1.300. Native automatic routing,
  live Claude-team execution, billed token savings and app/browser checks were
  not measured here. Instruction exercises are not runtime product verification.

No product implementation, dependency, migration or owner-service change was made.
Earlier ChessPlusPlus balance test evidence remains scoped to that source; no
unchanged gameplay suites/builds were rerun for this instruction-only task.
Ready for owner review; publication was not requested. Future tasks use the new
intake automatically, keep one contract and inspect actual context cost/quality.

## Follow-up evidence, 17 Oct

- R1/R5/R7: `/scrum` entry shrank from 185 to 154 words; the core remains
  580 words. The lead-only workflow is 1,024 words, adding explicit new-task versus
  continuation routing. Only matching contract sections/domain references are
  loaded; workers retain bounded packets and returns. These are context sizes,
  not a measured reduction in billed tokens.
- R2–R7: seven instruction walkthroughs cover new work, resume, vague UI intent,
  unspecified product decisions, steering, small-task staffing and stale evidence.
  They preserve intake → SDD → BDD → TDD without adding an approval stage.
- The skill validator, 25 local links (including the current-work anchor), YAML
  for nine profiles, native settings, CRLF and the acceptance table pass. All
  236 other existing files are hash-preserved, including the dirty game changes,
  original intake, core/domain references, roles and model/tool settings.
- Evidence: `/tmp/cpp-workflow-efficient-20261017-l26fu85v`, with `verification.json`, before/after source
  manifests and `walkthrough.md`. Integrated source/instruction review is by the
  lead; no new independent review, native-agent execution, app test/build/layout
  run or token billing measurement is claimed for this docs-only delta.

## Publication request, 17 Oct

The owner requested commit/push on `feature/dev25`, including completed balance
configuration and workflow work. All 40 balance application/config/test files
match their recorded passing verification (593 backend, 1,082 client, build,
schema/default and migration checks); later changes are documentation. Workflow
skill/link/structure checks pass. The pushed branch head and its exact-commit
Actions run supply publication identity and fresh CI evidence; the final delivery
report records those results. Preflight source hashes and command evidence:
`/tmp/cpp-publish-dev25-20261017-lk0z4z1q`.
