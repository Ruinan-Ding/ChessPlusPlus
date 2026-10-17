# REL-003: Student-funded deployment plan

Status: Done for the plan and documentation checks; deployment not started; unscheduled.
Source: owner's 17 Oct request to update the original deployment plan, compare
Azure options, include a domain and spend no personal money using student benefits.
Scope: ChessPlusPlus deployment docs and current pointers only. No application,
account, DNS, service, database, migration, publication or sibling-repository change.

## Requirements and acceptance

- R1 (explicit): revise the existing plan. A1: given the unimplemented Fly/Pages
  proposal, the canonical [DEPLOYMENT.md](../DEPLOYMENT.md) replaces it with an
  architecture that preserves the current single-process/state/CPU contracts.
- R2 (explicit): $0 personal spending. A2: given an eligible student account,
  the plan distinguishes free meters and finite credit, checks all attached
  costs, retains the spending limit and documents shutdown/expiry rather than
  an implicit paid upgrade. Unknown allowances remain unknown.
- R3 (explicit): include a domain. A3: given a current student offer, confirm a
  $0 eligible checkout and disable paid renewals; show an existing-domain or
  Azure-hostname alternative when redemption/renewal cannot remain free.
- R4 (existing): truthful, scoped readiness. A4: source-bound documentation,
  local links/anchors, whitespace and preservation checks pass; no live hosting,
  payment/account readiness, game verification or cross-repo changes are claimed.

## Decision and continuation

Recommend one eligible Azure Linux VM with Caddy, the same-origin Angular client,
one Daphne process and persistent SQLite, conditional on actual free allocations,
whole-cost estimates and CPU/memory tests. Compare Static Web Apps, App Service,
Container Apps and Functions/AKS without claiming a universally free full backend.
The detailed design and current sources live in DEPLOYMENT, avoiding a second plan.

Source: clean `main` at `489d8b9`; documentation branch
`feature/student-deployment-plan`. Official benefit/limit/domain sources checked
17 Oct; account eligibility, region/SKU capacity, domain choice and checkout are
pending. Next: verify the actual student allowances/domain choice before implementing
the production package and target checks in DEPLOYMENT.
No deployment implementation is authorized by this planning request.

## Verification, 17 Oct

R1/A1: DEPLOYMENT replaces the old recipe with a conditional VM recommendation,
Azure option comparison, current-runtime mapping and ordered implementation gates.
R2/A2: sources distinguish finite credit/free meters, all resource costs, budget
notifications and the spending limit's exceptions; expiry stops service rather
than opening paid billing. The $8.33/month figure is credit arithmetic only.
R3/A3: domain routes include student first-year redemption, disabled renewal,
existing DNS and Azure-hostname alternatives; checkout/account readiness is unknown.
R4/A4: 30 local links/anchors and CRLF-aware whitespace checks pass. All 240 other
tracked files, including 207 application/configuration/test files, retain their
source hashes; the sibling Ruinan-Ding repository retains its HEAD/clean status.
No unchanged game suites/build/layout checks, native model workflow trial or new
independent review ran. Lead-reviewed plan; no application completeness claim.

Full source hashes and checks: Windows Temp `cpp-student-deployment-plan-20261017-ekx34fz0`.
Only these planning docs are uncommitted; no cloud/DNS purchase, account change,
service restart, database action, commit/push/merge or deployment occurred.

## Subsequent review

The owner supplied a completed review finding no actionable defects in this
documentation-only change. It reports 593 backend tests, 1,082 frontend specs,
migration-drift checks and the production build passing. Those are reviewer-reported
results; this continuation did not rerun the application checks.

The plan remains complete and uncommitted on `feature/student-deployment-plan`.
Dependency remediation, production configuration and actual HTTPS/WSS verification
remain implementation work in DEPLOYMENT, rather than completed deployment gates.
No cloud resources, domain or application changes accompany this review record.

## Publication follow-up

The owner asks to commit and push the reviewed plan. Scope: these five planning
and status documents on `feature/student-deployment-plan`, based on `489d8b9`.
Publish to `origin/feature/student-deployment-plan`; the matching remote tip
identifies the final commit. Earlier uncommitted/no-publication notes describe
the drafting and review stages. This follow-up includes no application changes,
merge, resource provisioning, domain registration or deployment.

Publication checks and command results are retained in Windows Temp
`cpp-student-plan-publication-d6cawxxc/RESULTS.md`. The actual account/domain preflight and production
implementation remain the next separate work described in DEPLOYMENT.
