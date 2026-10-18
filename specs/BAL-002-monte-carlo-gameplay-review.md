# BAL-002: Monte Carlo strategy and player-experience review

Status: Done for analysis and verification; unscheduled. Owner review of the
written report is not yet recorded. Source: owner's request for a large intelligent
Monte Carlo simulation, strategic use/choice analysis and gaming-UX assessment,
prioritizing avoidance of a repeatable near-automatic winning plan.

Scope: analysis tooling, current-preset legal simulations, reproducible evidence and
opinionated feedback. No gameplay/balance, preset/revision, deployment, publication,
owner database/service or sibling-repository changes.

## Requirements and evidence

- **R1/A1:** Complete seeded matches, paired seats and source identity → 448-game
  seven-style tournament, 48 fixed-script and 24 shipped-CPU comparisons. Separate
  28 overtime continuations are labelled stress branches, not new full matches.
  Scheduled IDs, plans, seeds, config and CPU tuning match their frozen metadata.
- **R2/A2:** Compare repeatable plans and probe counters → both fixed scripts won
  0/24; strongest responsive policy won 62/96 against other styles. Focused legal
  lines verify remote casualty scoring, Cast/Blitz timing, earlier prevention,
  objective/immunity counters and commander withdrawal rejection. No solved-game
  or universal winning-opening claim.
- **R3/A3:** Measure choices, casts, actors, phases and resources → machine-readable
  results and traces record usage, considered legal opportunities, assigned builds,
  own-turn arrival balances and uncertainty. Report identifies policy blind spots
  in movement/action denial and withdrawals; non-use is not called useless.
- **R4/A4:** Give prioritized gaming-UX feedback → report distinguishes measured
  outcomes from inferred enjoyment/comprehension. Owner decides any balance changes.
- **R5/A5:** Real engine, isolated execution and preservation → all 520 full games
  reproduced through whole atomic commits (20,416 side-turns; 52,363 explicit
  commands), plus all 28 late branches (538 side-turns; 2,900 commands). An extra
  448-game replay collected participant arrival balances. Calibration compared
  eight atomic turns and three tactical combinations. SQL was forbidden; analysis
  containers had no network, production volumes or published ports.

## Results / continuation

[Report](../reports/BAL-002-gameplay-review.md),
[aggregate data](../reports/BAL-002-results.json) and
[transcripts, probes and checks](../reports/BAL-002-evidence.zip) own the findings.
Important concerns are remote base-casualty VP swings, preventive timing for
Cast/Blitz, weak Phase 3 postmatch comeback agency, late CP surplus, and CPU quality.
These are analysis recommendations, not implemented mechanic changes.

Source: feature/deployment-scaffold at 16ae570 with existing deployment/recovery
work preserved. All pre-existing file hashes still match the task-start snapshot
except the intentionally updated Scrum backlog. Ruleset revision remains null.
Config and simulator hashes, execution details and reproducibility limits are in
the report/archive. Pilot, cancelled scouting and performance experiments are
excluded. No independent agent review, human playtest, fresh UI verification or
unchanged application-suite/layout rerun was claimed. Native Ponytail invocation
was unavailable; its full-mode guidance was read and followed. One lead writer.

Original logs: Windows Temp cpp-montecarlo-20261018-h5_3lyeg. No commit, push,
merge, deployment or owner service restart was performed. Future work is the
owner's prioritization of the report's proposed balance/UX experiments.

Changed-file syntax, link, whitespace, schedule/metadata, archive CRC/member hashes
and preservation checks pass. The repository-wide diff check still reports the
pre-existing PUNCHLIST.md foundation-row trailing whitespace; it was preserved.
Task-owned containers exited and the analysis image tag was removed; Docker
Desktop and unrelated workloads remain untouched.

Publication follow-up, 18 Oct 2026: the owner authorized commit/push. Analysis
source, reports and immutable evidence are committed in `a4fd964` on
`feature/deployment-scaffold`. The earlier no-publication statement describes
the analysis checkpoint. No simulations, balance release or deployment were
added by publication.
