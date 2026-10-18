# BAL-003: Cast commander immunity and updated gameplay assessment

Status: Done for requested implementation and assessment; unscheduled. Owner source: “make cast not work on king then”,
followed by a heuristic gameplay report and a question about teaching the assistant.
Supersedes the earlier permission to Cast kings for new games only.

## Contract / acceptance

- **R1/A1:** Given the current preset, Cast cannot target any configured commander,
  regardless of opaque unit ID or side. Rejection spends nothing and preserves the
  submitted turn. Ordinary battlefield/green-reserve enemies remain valid.
- **R2/A2:** Target highlighting, rendered clicks, solo commits, online authoritative
  validation and CPU candidates agree. Undo/reload retain legal non-commander Cast.
- **R3/A3:** Optional control-only `allowCommanders: false` expresses the new rule.
  Omission/true preserves legacy configs and saved/started matches. Schema and both
  validators agree; explicit null and misplaced/wrong-type flags are refused.
  No ruleset revision release, persisted-game rewrite or database migration.
- **R4/A4:** Report the changed tactical implications and remaining concerns, using
  BAL-002 as historical evidence rather than new-preset win rates. Explain learning
  through rules, annotated replays, tools and evaluations versus model training.

## Verification / continuation

- Three backend regressions failed against the original implementation before the
  change. Targeted backend checks pass (86); the earlier targeted client run passed
  315 specs. The final full client run passes all 1,085 specs, including the
  specific rejection message and real target identity for tampered solo effects.
- Full backend: 615 tests completed, 1 Windows symlink-privilege skip; the second
  run passed. The first run failed the existing CPU retreat assertion. Separate
  isolated checks passed 3/4 against current CPU and 4/4 against its pre-change
  source. This timing/quality intermittency remains open, not resolved by retry.
- Production build, migration drift and draft-07 schema checks pass. Current and
  legacy configs preserve false/true/omitted options, input snapshots and migration
  idempotence. The only preset changes are Cast eligibility and its description;
  ruleset revision remains null. Both validators run the shared refusal cases.
- Native Chrome: 28 checks pass through actual lobby/start/ability/hex/Undo/commit
  controls, descriptions, target highlights and staged reload. Real Daphne sockets:
  10 checks pass for both seats, rejected king targets, saved drafts, Undo, normal
  Cast commit and control expiry. Final browser/socket runs include the solo guard
  adjustment. Screenshot visually inspected. Task ports 4217/18127/9357 released;
  only the disposable verification database was migrated. Owner 4200/8000 and the
  application database were untouched.
- Local links, changed-file whitespace, pre-existing dirty-work preservation and
  isolated balance-delta checks pass. The unrelated pre-existing PUNCHLIST.md
  trailing whitespace remains. No template/style changed; the full layout sweep
  was not rerun. No independent agent review or new human playtest/tournament ran.

[Heuristic report](../reports/BAL-003-gameplay-assessment.md) distinguishes current
inference from [earlier simulations](BAL-002-monte-carlo-gameplay-review.md).
[Evidence archive](../reports/BAL-003-evidence.zip) contains logs, native verification
scripts, checks, screenshot and source hashes. Original logs: Windows Temp
`cpp-cast-20261018-a1juiul7`. One lead/self-review; native Ponytail unavailable,
installed full-mode guidance followed. The owner authorized commit/push on
18 Oct 2026; this branch publication includes the verified Cast implementation,
reports and current metadata. Git history records the delivery revision. No merge,
deployment or owner service restart is included. CPU quality/timing remains a
separate follow-up; report/balance acceptance by the owner is not claimed.
