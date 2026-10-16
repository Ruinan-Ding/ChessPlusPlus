# Claude Scrum workflow

This project uses BDD to agree observable behavior and TDD to implement it.
One cross-functional Scrum team owns a working Increment, including the client,
server, UI, tests, documentation and delivery. [AGENTS.md](AGENTS.md) remains the
source of repo constraints and owner-approved game rules. The user's current
instructions and existing authorization take precedence over this workflow.

This is the repository's engineering workflow for Claude Code. "Enterprise-style"
describes its delivery practices; it is not an Anthropic-provided Enterprise
workflow or an organization deployment. Identity, managed policies and audit/data
retention belong to the organization's administration. These project instructions
neither provision those controls nor establish that they have been verified.

## Running the team

Start Claude Code in the repository and use `/scrum <request>`, or describe the
development task normally. The [skill](.claude/skills/scrum/SKILL.md) applies the
same process. Project [settings](.claude/settings.json) enable native experimental
agent teams in-process; they change no permission rules or model selection.
Restart an already-open Claude session after first installing these agent files.
Ponytail remains a user-scoped prerequisite; use the installation instructions in
AGENTS.md if it is unavailable in this Claude installation. No project setting
installs plugins or bypasses their availability.

For substantial work with independent responsibilities, the lead delegates to
the relevant role profiles below when runtime policy permits. Prefer a native
interactive team when teammates need direct discussion and shared tasks. Ordinary
subagents suit focused investigation/review; sequential work suits dependent or
same-file changes. Native teammates require an interactive Claude session;
`claude -p` does not exercise agent teams. If a runtime cannot delegate, say so,
perform the responsibilities sequentially and disclose the missing independent
review. Do not invent teammate conversations, test results or approvals.

Activate capabilities according to the story, rather than starting nine workers
for a wording change. Keep active work within runtime capacity and coordinate
shared files before edits. Teams are not persistent workers: on resume inspect
the real branch, tasks and evidence, then re-establish necessary ownership.
Do not assume a resumed session restored its teammates or completed their work.

| Work | Practical staffing |
|---|---|
| Small docs/agent-configuration edit | One writer performs the applicable structural checks; add a reviewer when the impact warrants it. |
| Behavior in one subsystem | A developer pairs on examples/tests with quality, then a different qualified participant reviews the integrated change. The lead may implement or review, subject to that independence. |
| Client/server/UI change | Frontend and backend own disjoint implementation paths; quality pairs on acceptance and integration. Bring in UX, architecture, security and delivery for affected concerns, sequencing work to fit available capacity. |

The main conversation coordinates this process. Assigned workers follow their
role/task packet and report to that conversation; loading the Scrum skill inside
a worker does not make it another orchestrator or authorize another team.

## Accountabilities and capabilities

The **human owner is Product Owner**: product value, priorities, accepted gameplay
and balance decisions remain theirs. Analysis can be delegated; accountability
cannot. Agents may resolve routine technical choices within that intent.

The **Scrum Master** enables team effectiveness and removes impediments. The
lead can take that role; a coordinating session is not another managerial layer.

**Developers** collectively plan, build, verify and maintain the Increment.
Frontend, backend, quality, UX, architecture, security and delivery are skills
within this team, not separate departments or sequential approval gates.
Members help outside their specialty and swarm on unfinished work. The role
profiles are reusable capabilities; one participant can cover several.

There is one profile per role, with no fixed limit of one instance. Start with
one agent per needed specialty; add another developer in the same role only for
independent work within available capacity and the file-ownership contract.
Keep one Product Owner and one facilitation responsibility rather than duplicating
decision authority.

Every role is expected to exercise senior-level judgment in its specialty:
explain significant tradeoffs, verify assumptions, own acceptance evidence and
surface uncertainty early. All nine profiles are configured to inherit the lead's
model; a seniority label does not change that model's capabilities. Assess the
standard through actual results and qualified review, not a claim of "elite" status.

| Profile | Contribution to the shared outcome |
|---|---|
| [Scrum Master](.claude/agents/scrum-master.md) | Goals, facilitation, impediments, flow and improvement |
| [Product analyst](.claude/agents/product-analyst.md) | PO support, refinement, journeys and acceptance examples |
| [Architect](.claude/agents/architect.md) | Config/contracts, compatibility, minimal design and peer review |
| [Frontend developer](.claude/agents/frontend-developer.md) | Angular, solo engine, interactions and UI integration |
| [Backend developer](.claude/agents/backend-developer.md) | Authoritative engine, Channels, persistence and transactions |
| [Quality engineer](.claude/agents/quality-engineer.md) | BDD/TDD pairing, acceptance automation and exploratory testing |
| [UX/accessibility](.claude/agents/ux-accessibility.md) | Player comprehension, keyboard/focus and responsive usability |
| [Security/reliability](.claude/agents/security-reliability.md) | Trust boundaries, races, data preservation and performance |
| [Release engineer](.claude/agents/release-engineer.md) | CI, integration/build, migration/deployment readiness and evidence |

Every participant doing code/design work invokes Ponytail as required by
AGENTS.md; the advisory profiles include Skill access while excluding file-write
and shell tools. Read-only profiles return proposals/findings. Implementation and
verification profiles have only the tools/permissions their parent session
permits. Testing and documentation are development work, not work deferred to
someone after Done.

## Goals, backlog and events

[SCRUM_BACKLOG.md](SCRUM_BACKLOG.md) holds the Product Goal, ordered stories,
current Sprint Goal/plan, impediments and one improvement experiment. Reference
[PUNCHLIST.md](PUNCHLIST.md) for implementation/evidence checkpoints and
[CODEX_HANDOFF.md](CODEX_HANDOFF.md) for the current source/environment; do not
copy their historical ledger into another backlog. Native task lists coordinate
the current workers, while the backlog survives their sessions.

Sprints have a fixed duration of one month or less. Agree the duration and dates
with the Product Owner at the first planning event; two weeks is a suggestion,
not an already scheduled Sprint. Until dates and a goal are agreed, record the
work as an unscheduled backlog item. Never claim an agent session was a Sprint.

| Event | Participants and concrete result |
|---|---|
| Refinement, throughout | PO/analyst, Developers and quality split upcoming work and resolve examples, dependencies and risks. The PO orders it. |
| Sprint Planning, at the start | The team agrees why the Sprint matters, what it can finish and how to start. Developers select an achievable plan with capacity for verification; the PO confirms priorities. Record dates, Sprint Goal and selected stories. |
| Daily Scrum, each working day | Developers inspect progress toward the Sprint Goal, adapt the plan and expose impediments within 15 minutes. Session updates supply evidence; they do not fabricate a meeting or replace a required decision. |
| Sprint Review, at the end | Team and available stakeholders inspect a running Increment and evidence, then adapt the backlog. Record who actually participated, feedback and missing observations. A review is a working discussion, not merely a status report. |
| Retrospective, after review | Inspect collaboration, quality and flow. Select one improvement with an owner, a measure and a next-review date; inspect it in the following Sprint. |

Scale event timeboxes to Sprint length within the Scrum Guide limits: Planning
at most eight hours, Review four and Retrospective three for a one-month Sprint.
Do not wait out a timebox or create ceremonial chat when the outcome is clear.
If an event has not occurred, record that fact rather than manufactured minutes.

Use small vertical stories with a player/maintainer outcome. Each records:

- ID, request/source, outcome, in/out of scope and relevant accepted rules.
- Given/When/Then examples with IDs; questions and acceptance-to-test mapping.
- Owner/file ownership, dependencies, status and evidence links.
- Review findings, remaining gaps and product feedback where available.

Use `Ready → In progress → Review → Done`, or `Blocked` with the exact dependency.
Ready is a useful refinement check, not a mandatory approval ceremony. Missing
game rules block dependent implementation; they need not block unrelated work.
Keep one implementation slice active per writer, pull the next after finishing
or explicitly parking it, and swarm on defects before expanding WIP. Adapt the
Sprint Backlog without silently changing the Sprint Goal or product priorities.
If a goal becomes obsolete, only the Product Owner cancels the Sprint.

## Changes, defects and decisions

When the owner changes a request, update the existing story's examples and scope,
record what it supersedes and identify affected work/checks. A distinct outcome
becomes another backlog item. Developers adapt the plan within the Sprint Goal;
changes to product priorities or the goal stay with the Product Owner. Routine
clarifications and already-authorized fixes do not create another approval gate.

For a defect, record player impact, expected/actual behavior, reproduction,
mode/config/source and evidence. Separate a broken accepted rule from a proposed
balance change. For an urgent defect within the authorized scope, swarm on the
smallest reproducible fix and make any displaced work visible. Keep the normal
regression/review checks; urgency does not make an untested fix Done. Track related
defects against the story rather than opening duplicate investigations per role.

For a significant architecture, persistence or protocol decision, capture context,
chosen option, rationale, material alternatives and compatibility consequences
in the existing relevant guide or story/handoff, with links from other records.
Update superseded decisions. Routine naming edits need no separate decision
document; this does not introduce an ADR framework or a parallel game spec.

## BDD: discovery, formulation, automation

Before a behavior change, use three perspectives: product (human PO or their
recorded intent through the analyst), development and quality. This is a Three
Amigos collaboration, not a requirement for three agents to repeat each other.

1. **Discover** the player's purpose and examples in the actual code and agreed
   rules. Separate known behavior from open decisions. Ask the owner about missing
   mechanics in small themed batches; never infer a new balance rule from a test.
2. **Formulate** concrete Given/When/Then examples with initial state, action and
   observable outcome. Include meaningful invalid actions, boundaries and affected
   solo/online, panel, custom-config, Undo/reload/replay and timing interactions.
3. **Automate** examples using existing Jasmine, Django, ASGI and browser/live
   tools. Map each example to test names or an explicit manual observation before
   implementing it; update the mapping with results after execution.

For example, a withdrawal story's examples might distinguish a configured zero
refund from no withdrawal, and then verify commit, reload and Undo in both modes.
Expected amounts must come from the selected match config and accepted rule.
Do not add Cucumber, duplicate `.feature` files or an unused DSL merely to call
this BDD. A readable example and its executable test are sufficient. Keep the
rules in their existing canonical docs/schema rather than a parallel spec.

## TDD: Red, Green, Refactor

For new behavior or a reproduced defect:

1. **Red:** add the smallest meaningful behavior test first and run it against
   the unchanged implementation. Record the command, test and expected behavioral
   failure. An import/setup error is not Red. For a cross-engine contract, arrange
   examples for both implementations before changing their behavior.
2. **Green:** implement the smallest correct production change; run the focused
   tests. Follow Ponytail and existing patterns, including config-sync when the
   config shape changes. Do not weaken assertions to fit the implementation.
3. **Refactor:** improve names, duplication and boundaries while tests remain
   green, then run the impact-appropriate regression/acceptance checks.

For a pure refactor, establish existing or missing characterization protection
first; a deliberately failing new behavior is not required. For docs, comments
and agent configuration, check links, formats and actual supported behavior;
do not manufacture a failing gameplay test. If implementation already exists,
report that honestly and prove the regression against the original source or an
isolated fault where useful; never fabricate a test-first history.

Test at the layer that can observe the defect. Unit tests cannot prove browser
reachability, socket timing, accessibility or whole-match parity. Avoid assertions
that merely mirror private implementation or make a coverage number look complete.

Establish the relevant baseline before editing and distinguish pre-existing or
environment failures from the intended Red and newly introduced regressions.
For a failed check, preserve the command/source and failing output before retrying.
Use reruns to test a cause, not to seek a lucky green result. A suspected flaky
test needs an investigation of isolation, async timing or shared state; one passing
rerun is not a fix. Keep unresolved failures visible, including those outside the
story's scope, rather than skipping checks or weakening assertions to claim Done.

## Delegation and integration contract

The lead is the integrator for the current story, not a product decision maker.
Before assigning work, read the handoff and inspect `git status`/diff. Preserve
existing uncommitted work and its intent. Every task receives this packet:

```text
Story/goal and acceptance example IDs:
Accepted rules/config and unresolved questions:
Branch/HEAD, dirty source to include, relevant paths:
Owned write paths; read-only/shared paths and integrator:
Dependencies and interface/ordering decisions:
Expected Red/Green/acceptance checks and evidence:
For review: story diff/new files, source identity and readable test evidence:
Permitted side effects and known environment limits:
Return: changed paths, results, findings, remaining work:
```

Assign one writer per file at a time, including tests and docs. Peers may discuss
directly and propose changes to each other; transfer ownership before editing
another's files. The integrator owns shared config/contracts and metadata unless
explicitly assigned otherwise. A blocked interface is settled before dependent
edits; independent exploration/testing may continue.

Route questions needing the human's decision through the lead, especially when
a worker cannot ask the user directly. Use internal task/agent communication;
the workflow does not authorize contacting people through email, chat or other
external services. Preserve existing user authorization across handoffs rather
than asking for the same permission again.

Use shared-tree parallelism only for disjoint edits. Use separate worktrees only
when each contains the intended current source, including required dirty changes;
a worktree made from HEAD alone can silently lose this repo's uncommitted fixes.
Do not commit/reset/stash someone else's work merely to make delegation convenient.
Do not make teammates recursively create another Scrum team.

Require a qualified peer who did not author the change to review the integrated
diff and acceptance evidence where delegation is available. A design author
cannot label their own sign-off independent. Triage concrete findings, fix
defects and rerun affected checks. The integrator checks the final combined source
after all writers finish; separate green branches do not establish a green merge.

Supply read-only reviewers with a readable diff and all new files, the base/HEAD
and dirty-file identity, example-to-test mapping and actual command results.
On a dirty tree, distinguish this story's delta from earlier uncommitted work.
Reviewers inspect current source themselves; a tool-limited reviewer requests the
missing bundle from the integrator rather than pretending it ran `git diff` or
tests. Quality/release can execute independent checks when needed and permitted.
If source changes after review/testing, reassess that delta and rerun affected
checks before reusing the sign-off, including when HEAD itself has not changed.

On interruption, save current status, paths/owners, accepted decisions, failing
checks and exact next action. Verify actual files and live workers on resume.
At completion stop only this task's workers/private services and leave the
owner's services, database, sessions and unrelated work intact.

## Definition of Done

An Increment meets all applicable conditions; mark an unperformed required check
as remaining work, not passed or silently waived:

- Accepted examples are implemented and mapped to observed evidence. Missing
  product decisions and known functional defects are resolved or explicitly
  excluded with the owner's scope; no self-approved gameplay changes.
- Red/Green/Refactor evidence exists for behavior changes, or the truthful reason
  for characterization/structural verification instead is recorded.
- Relevant unit, shared parity/contract and rendered/integration regressions
  pass. For cross-layer changes verify both engines and frozen custom configs;
  exercise meaningful UI and real socket paths when affected. Follow AGENTS.md's
  required full layout sweep for any template/style change. Regenerate scoring
  parity answers only for intentional rule changes in both engines.
- Appropriate type/build/schema/system/migration/CI checks pass on the integrated
  source. Test scope matches change risk; documentation-only work need not rerun
  unchanged gameplay suites. Evidence identifies source, environment, commands,
  results and limits, including checks that CI has not yet run.
- The integrated change is reviewed and material findings addressed. Obtain
  independent peer review when delegation is available; otherwise record that
  verification limit and any review still required for delivery. Never label
  self-review independent or hide an outstanding required review.
- Security, compatibility, data preservation, responsive/accessibility and
  performance implications have been checked for the paths changed.
- README and relevant rule/config/deployment guides, backlog, handoff and
  punchlist reflect the actual state. No unused scaffolding, temporary fixtures,
  credentials, misleading comments or unapproved dependencies are introduced.

Keep delivery evidence tied to the tested commit plus any uncommitted-file
identity. For published work, link the actual CI run/review and record the
acceptance results in the tracked handoff/backlog; private temporary logs alone
are not a durable, shared record. Before publication, keep reproducible commands
and explicit local evidence locations without claiming a shared audit archive.
Retain only the relevant outcomes in tracked docs, not raw logs or secrets.

The [existing CI](.github/workflows/tests.yml) checks backend/client suites,
migration drift, the production build and online-recording/solo playback parity.
BDD agreement, test-first chronology, role ownership and peer review depend on
the team's evidence and review; these instructions do not automatically enforce
them. Browser/live/layout checks outside those jobs must be run when applicable,
not inferred from a green CI badge. Native role discovery proves configuration
loads; a real story is needed to evaluate collaboration and delivery quality.

Technical Done does not mean published, released, migrated, running on the owner's
backend or owner-SEEN. Keep those statuses separate. Prepare a concrete reviewable
delivery before requesting any genuinely missing authorization. Follow existing
user authorization for commits/pushes/merges, deployment, migrations and restarts;
Scrum roles/events add no permission gates. Do not number the draft balance merely
because a workflow item is complete.

Measure outcomes and flow: escaped defects, blocked/cycle time, acceptance gaps
and whether the Sprint Goal was met. Use estimates to plan capacity, not to rank
agents. Do not optimize for lines of code, test count, token count or invented
velocity. Keep feedback direct, blameless and evidence-based.

Use the next owner-selected, bounded story that changes behavior as the workflow's
practical trial. Trace an accepted example through a genuine Red/Green change,
actual peer collaboration/review where permitted and the relevant integrated acceptance path.
Record missing runtime capabilities and avoidable handoff delays, then change the
process only in response to observed friction. Do not invent a game feature or
schedule a Sprint merely to test the organization chart.

## SDD later

Here SDD means **specification-driven development**. It is a future option, not
an active framework, extra approval gate or replacement for TDD/BDD. If the owner
adopts it, start from accepted BDD examples and existing config/schema/rule docs:
agree a small versioned behavior contract, trace it to tests/code and review drift.
Keep one authoritative home for each rule and distinguish proposed, accepted,
implemented and verified states. Do not install spec tooling or generate a second
game specification in advance. Clarify the acronym if the owner intends another
meaning.

## References

The [Scrum Guide](https://scrumguides.org/scrum-guide.html) defines the accountabilities,
events and commitments. Claude's [agent-team documentation](https://code.claude.com/docs/en/agent-teams)
describes the runtime and its limitations; [subagent definitions](https://code.claude.com/docs/en/sub-agents)
and [skills](https://code.claude.com/docs/en/skills) describe the project file formats.
Organization-level controls are covered separately by Claude's
[settings scopes](https://code.claude.com/docs/en/settings) and
[managed permissions](https://code.claude.com/docs/en/permissions#managed-settings).
