# SAFe coordination on demand

This repo adapts Essential SAFe coordination with optional Lean Portfolio Management.
It is configured guidance, not certification or proof of an operating enterprise.
Read only the section needed. The existing SDD/BDD/TDD workflow and owner constraints
still apply. A model role is a capability; several specialist agents do not constitute
separate Agile Teams, an ART or human attendance.

## Choose the operating level

- **Team:** a bounded feature/fix within one team. Use its one contract; keep an
  existing parent link if useful. No epic, PI plan or additional worker is required.
- **ART coordination:** distinct teams must deliver a shared outcome, or the owner
  explicitly requests program/PI planning. A client/backend pair within one team,
  two repos or a shared workflow alone does not establish an ART. Record proposed
  teams/owners and missing operating decisions; do useful discovery meanwhile.
- **Portfolio:** the request concerns strategic initiatives, investment or value-stream
  tradeoffs. Apply the portfolio section; don't add it to routine delivery.

These are local routing choices. Formal ART/PI adoption needs real named teams,
accountabilities, capacity and an agreed cadence; leave missing facts unconfirmed.
An explicit SAFe configuration request can prepare this capability without inventing
an active train. Do not turn a small request into an organization redesign.

## Roles and authority

Keep the nine existing profiles; combine hats within real capacity. Owner assignments
remain explicit, rather than implying that an agent now holds business authority.

| Responsibility | Existing capability/support |
|---|---|
| Business Owners / portfolio investment / Product Management | Human owner or designated humans decide value, priorities, funding and guardrails; product analyst prepares options/hypotheses. |
| Team Product Owner | Human owner retains team-backlog and product decisions. |
| RTE / team coaching | Lead or Scrum Master facilitates dependencies, planning, flow and risks; this is distinct from the release engineer's deployment work. |
| System/enterprise architecture | Architect supports interfaces, NFRs and near-term architectural runway; developers implement justified enablers. |
| Epic Owner | Named coordinator, supported by analyst/lead, carries a strategic hypothesis through validation; cannot self-authorize funding. |
| Agile Teams / System Team / shared services | Existing developers, quality, UX, security and release capabilities provide integrated delivery/support when needed; not a new standing agent group. |

Workers receive only assigned objectives/IDs, interfaces, constraints and check
responsibility. No recursive teams, copied global plans or universal sign-off chain.

## ART planning and execution

Extend the existing contract/index only with relevant relationships:
`outcome → existing epic (if any) → feature/enabler → story → R → A → check/source`.
Features include a proposed benefit hypothesis, acceptance and NFRs; split work that
cannot fit the agreed planning horizon. Do not specify all downstream stories upfront.

For an actual PI, create one linked `specs/PI-<id>.md` coordination record. It owns
objectives/outcome measures, actual teams/capacity and iteration/IP allowance, feature
links, dependencies/milestones and risks. Team contracts own detailed requirements
and evidence. Until dates and commitments are agreed, mark it proposed/unscheduled.
Planning Interval cadence is not a waiting period or permission to invent a calendar.

| Coordination | Record actual outcome, using the same plan |
|---|---|
| PI Planning | Business context/vision, feasible objectives, capacity incl. quality/enablers, dependencies/owners and critical interfaces; distinguish committed/uncommitted objectives. Human Business Owners set business-value judgments; record actual confidence/participants, not invented votes. |
| Iterations / ART Sync (PO/Coach sync) | Pull achievable stories, expose changed dependencies/blockers and adapt forecasts; owner resolves priority changes. No separate status essays for each hat. |
| System Demo | Inspect integrated working behavior and acceptance/NFR evidence across teams each iteration; test counts or slides alone are not an integrated demo. Record stakeholder feedback only when received. |
| Inspect & Adapt / IP | Inspect observed outcomes/flow, resolve a concrete cause and assign one improvement; reserve learning/planning capacity, not deferred testing or a compulsory hardening phase. |

Use one dependency row: producer/consumer IDs, named owners, interface, needed-by
milestone, state and evidence. Unknown dates stay unknown; don't promise a consumer
before its dependency is ready. Record a risk with impact, owner, next action and
ROAM disposition (Resolved/Owned/Accepted/Mitigated). Acceptance requires the
appropriate human authority; mitigation needs evidence. ROAM cannot waive tests,
security or the owner's constraints. Avoid WIP expansion while dependencies block.

## Portfolio only when needed

Use a linked epic contract for the strategic hypothesis, value-stream/strategic-goal
link, success signal/baseline, smallest experiment or MVP, cost/capacity estimate,
owner, guardrails and stop/pivot/continue criteria. Label estimates and unknowns.
Use a small Kanban view in the existing backlog: intake → analysis → ready →
implementation → outcome review → done/stop/pivot. This is the local view; do not
create empty portfolio files or copy child specifications into it.

The human owner/designated decision makers set investment, WIP/capacity guardrails
and scope beyond the MVP. Existing authorization can cover those decisions; don't
require repeat approval for an already authorized step. Unknown funding/priorities
need resolution before dependent commitments, while safe independent work proceeds.

When comparable inputs exist, propose WSJF ordering:
`(user/business value + time criticality + risk reduction/opportunity enablement) / job size`.
Use identified estimates and a positive size. Missing inputs stay unknown; no made-up
scores, division by zero or agent-approved priority change. Qualitative owner ordering
is sufficient when no defensible comparison exists. Never optimize test counts or
agent/token usage as a substitute for customer outcomes and quality.

## Built-in quality and release

Preserve the existing spec→BDD→TDD and Definition of Done, with relevant NFRs,
compatibility, CI and integrated validation. Architectural enablers earn their place
through a near-term need. Exploration, integration and deployment readiness feed
release on demand; PI completion or a System Demo does not authorize commit, push,
migration, restart or release. Keep actual deployment and user acceptance distinct.

## Sources

Official guidance checked17 Oct2026; this is a concise project adaptation:
[Essential SAFe](https://framework.scaledagile.com/essential-safe),
[ART](https://framework.scaledagile.com/agile-release-train),
[RTE](https://framework.scaledagile.com/release-train-engineer),
[PI Planning](https://framework.scaledagile.com/pi-planning),
[Features](https://framework.scaledagile.com/features-and-capabilities),
[Inspect & Adapt](https://framework.scaledagile.com/inspect-and-adapt),
[Lean Portfolio Management](https://framework.scaledagile.com/lean-portfolio-management-discipline),
[WSJF](https://framework.scaledagile.com/wsjf).
