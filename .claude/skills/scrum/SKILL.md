---
name: scrum
description: Deliver ChessPlusPlus features, fixes and reviews with the project's cross-functional Scrum team, BDD acceptance examples and TDD. Use for development work or explicit Scrum planning, refinement, review and retrospective requests in this repository; not for playing the game or general Scrum questions.
---

# Scrum delivery

Read [AGENTS.md](../../../AGENTS.md), [SCRUM_WORKFLOW.md](../../../SCRUM_WORKFLOW.md)
and the current [backlog](../../../SCRUM_BACKLOG.md). They define the repo's rules,
team responsibilities and delivery process. The user's request is `$ARGUMENTS`;
if empty, use the active request and current handoff rather than inventing work.

The main conversation orchestrates. If you are an assigned worker, apply your
role/task packet and return findings/results to the lead; do not start another
Scrum team, select unrelated backlog work or broaden the task's authorization.

1. Inspect the current branch, dirty files, handoff and actual affected code.
   Reconcile existing work before selecting a story. Preserve the user's priorities
   and previous authorization. State the goal, scope and unresolved product questions.
   Fold steering into the active story and record superseded scope/decisions.
2. Refine observable Given/When/Then examples with development and quality input.
   Map each acceptance example to meaningful checks before implementation. Ask the
   owner about missing gameplay decisions; continue independent work meanwhile.
3. Use the role profiles in `.claude/agents/`. For a substantial cross-layer story,
   delegate independent work to the relevant specialists when runtime policy permits.
   Use a native interactive agent team when peer collaboration helps; use focused
   subagents or work sequentially otherwise. Follow the workflow's ownership and
   handoff contract. Never launch every role merely to fill an organization chart.
4. Follow Red → Green → Refactor for behavior changes. Coordinate the two engines,
   UI and acceptance evidence; integrate and obtain an independent review where
   available. Give read-only reviewers the actual diff/new files and test evidence
   tied to the current source. Small docs-only tasks use structural checks, without
   fake failing tests.
   Separate baseline/environment failures from regressions; preserve failing output
   and investigate flakiness rather than rerunning until green.
5. Keep the backlog and handoff truthful. Finish the Definition of Done checks or
   name the remaining work and limits. Propose one concrete improvement at review.
   Publishing, migrations and service restarts follow the user's existing scope;
   internal Scrum events introduce no extra permission checkpoints.

SDD means specification-driven development here. It remains a future option;
do not install an SDD framework or introduce another source of game rules.
