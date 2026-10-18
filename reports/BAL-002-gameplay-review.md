# Gameplay simulation review — 18 October 2026

Historical preset: these simulations allowed Cast on kings. The owner's subsequent
king restriction and current heuristic assessment are recorded in
[BAL-003](BAL-003-gameplay-assessment.md). Numeric results below remain evidence of
the frozen earlier preset, not post-change win rates.

The game supports meaningful tactical choices. I did **not** find a universal
winning opening among the plans tested. I did find powerful, repeatable **late
scoring combinations**, an economy that behaves very differently in quiet and
contested games, and weaknesses in the shipped CPU. These deserve attention before
calling the game balanced. Simulations cannot establish whether humans enjoy it.

No gameplay, balance, configuration or production code was changed.

## What ran

- **520 complete matches from the normal start:** a 448-game strategy tournament,
  48 fixed-script tests, and 24 comparisons with the shipped CPU.
- **28 additional overtime continuations** from one legally reached, quiet,
  resource-rich position. These are stress tests, not another 28 independent full
  matches or a representative sample of ordinary games.
- Focused legal lines and arranged tactical forks, including a sweep of **541
  Cleave centres** when checking responses to a tally combination.
- Independent atomic replay of all saved matches and continuations: **20,954
  recorded side-turns and 55,263 explicit selected commands** reproduced their
  outcomes, phase banks, loadouts and final resource balances. Search candidates
  were also validated before selection; expected refusals were discarded.

The main tournament alone evaluated **293,203 turn previews**, including **9,628
successful tactical combination extensions**. It took approximately 52 minutes.

## Is there a brainless winning plan?

Two deliberately repetitive scripts failed:

| Script | Result against capture, control and adaptive opponents, both colours |
|---|---:|
| Put the king on the home zone, heal when possible, otherwise wait | 0/24 wins |
| Hold home, follow a fixed bishop march, Cast an adjacent king when available | 0/24 wins |

Those tests reject these particular scripts, not every possible exploit. The
bishop delivery in the separate tally probes used a cooperative defender; it is
not a forced opening.

Among responsive players, **protecting the king while contesting objectives**
worked better than pure capture or indiscriminate fighting. Defense here still
moves other units and uses abilities; it is substantially different from camping.

| Policy | Wins against other styles | Paired-seed bootstrap 95% interval |
|---|---:|---:|
| King defense | 62/96 — 64.6% | 55.2–72.9% |
| Adaptive | 59/96 — 61.5% | 50.0–71.9% |
| Economy | 51/96 — 53.1% | 42.7–64.6% |
| Rush | 50/96 — 52.1% | 42.7–62.5% |
| Control | 47/96 — 49.0% | 39.6–59.4% |
| Attrition | 36/96 — 37.5% | 27.1–47.9% |
| Capture | 31/96 — 32.3% | 22.9–41.7% |

These intervals describe this experiment, not human win rates. They resample the
48 two-seat seed groups per policy; they do not justify confidently ordering
Defense above Adaptive. Even the strongest policy lost 34/96 games.

In the 448-game tournament, White won 235 and Black 213. Endings were 367 king
kills, 62 early-phase losses, 18 points wins and one overtime expiration. Median
length was **35 side-turns**, including Initialization. Only 44 games reached
Phase 3 and four reached overtime. The rules offer several routes, but these
players overwhelmingly settled games through king safety and king hunting.

## The combinations I would examine first

### Remote casualties can decide the score from anywhere

In a legally reached, otherwise tied game, Black used Onslaught's **Cleave on a
full-health red-base archer, then Strike**, on the final Phase 3 scoring turn.
The archer's 12 attrition became **36 VP**, exceeding Black's 25-point winning
margin. Black won after postmatch without a battlefield attack.

This costs **50 CP + 20 regular points** if Onslaught is already purchased, or
100 CP including activation. DEF and careful battlefield positioning do not
protect that archer from these direct-damage casts.

Two tested counters worked:

- White's Fortress on the preceding turn prevented the damage and scoring swing.
- White holding one additional side zone throughout the phases retained enough
  lead to win despite the cheap burst.

The larger **Ruin + Cleave + Strike** combination killed two initial base bishops,
causing 64 attrition, or **192 Phase 3 VP**. In a legal line where White held the
central zone in addition to home throughout all three phases, this reduced
White's final lead to 36: insufficient for White's 50-point margin, so the game
went to overtime. Black then won when both sides passed. That is not a forced
win against active overtime play.

This gives Ruin a genuine finishing/scoring purpose. It also creates a potential
UX problem: a player can lose a large lead through inactive bench units. Base
formation, preventive immunity and the scoring deadline matter far more than a
new player may expect. Ruin ordinarily leaves surviving friendly units at their
previous HP—damage 3, then heal 3—rather than providing a net team heal.

### Cast plus Blitz creates a timing trap

A legal White Cast just before Phase 3 tally transferred the enemy king's capture
claims. Killing the bishop afterward did not cancel control. A normal
counter-Cast restored the king before tally and prevented the score swing.

Adding **Blitz after Cast** stopped that rescue: Black's movement, attack and unit
ability responses were locked. White's Sprint activation plus discounted Blitz
cost 347 CP; Cast cost 29 UP. The defender could still use pool and CP abilities.

I tested Ruin followed by Cleave at every drawn centre, then the strongest
available lethal Strike target. Even the best tested immediate damage response
left White ahead by **150 VP** at tally. This was a conditional winning position,
not an exhaustive solver proof or a forced way to deliver the bishop.

**Earlier prevention worked:** Black's Blitz on the preceding turn blocked the
Cast, preserving a 171–171 Phase 3 tally. Attacking/denying the caster earlier is
also different from killing it after control has applied. The important
experience question is whether players recognize this threat before their last
opportunity to prevent it. Reactive counterplay after the combination is much
narrower.

Commanders cannot walk home, including while controlled. The suspected
control-and-withdraw king exploit was correctly rejected.

### Phase 3 postmatch offers little comeback agency

Default battlefield kings have reached Vet 3 and fully heal at Phase 3 postmatch.
Normal attacks are then forbidden. An arranged legal burst using Cleave, Ruin,
Strike and Call dealt **13 HP to a 60-HP king**. It did not reopen the outcome.

For an ordinary healthy king, the advertised opportunity to reverse a points
loss through regicide is therefore extremely weak. I would treat the likely
experience as a result/cleanup period unless human tests demonstrate meaningful
comebacks. This is a rule interaction, not a broken damage calculation.

## Do abilities have purposes?

Yes, but **usage is not proof of a good decision**, and non-use is particularly
misleading with these bots.

Main-tournament casts included Mend 1,085, Weakening 1,034, Warcry 667, Strike 448,
Sacrifice 323, Call 314, Leech 106, Cast 73 and Charge 35. These suggest useful
healing, favorable exchanges, recovery and control—not just one repeated spell.
Sacrifice is meaningful as a full heal, promotion and temporary boost; its
post-tally timing also avoids changing the already banked attrition score.

The model badly undervalues movement denial and future action restriction:
Mire, Trap and Taunt were never selected, despite considered legal opportunities;
Snare and Bash were each selected once. **Do not infer that these skills are
useless.** Real-engine tactical forks demonstrated:

| Tool | Verified situational use |
|---|---|
| Mire | Stops an otherwise legal queen rush; Dash overcomes the tested slowdown |
| Snare | An archer's hit prevents that queen's following rush |
| Trap | Stops the affected attacker from acting |
| Taunt | Redirects an otherwise lethal king attack to the shieldman |
| Fortress | Prevents the remote-casualty scoring swing |
| Charge / Leech / Call | Valid move → unit ability → attack combinations; representative winning traces used them |

These are different tactical jobs. Quantifying their true value needs players or
search that values those future restrictions better. The main policies also
made no walking-home withdrawals; the economy probes below test that omitted
strategy separately.

At Vet 2, an unbuffed archer deals only 1 HP to most armored targets at its best
ring; shields also frequently reduce ordinary hits to 1. This creates a deliberate
need for damage setup, movement control and different targets. I would examine
whether the archer feels sufficiently useful as a mobile control piece before
changing DEF globally.

## Resources: early scarcity, late surplus

Remaining balances at each participant's **own first turn** of a phase, after
previous spending, were:

| Arrival | Participant observations | Median regular points | Median UP | Median CP |
|---|---:|---:|---:|---:|
| Phase 1 | 896 | 34 | 10 | 5 |
| Phase 2 | 656 | 30 | 49 | 15 |
| Phase 3 | 88 | 28 | 84.5 | 71 |
| Overtime | 8 | 142.5 | 81.5 | 45.5 |

These are survivor-conditioned balances, **not fixed income or amounts earned in
a phase**. Overtime's natural sample is too small for a population estimate.
Own-turn sampling avoids averaging one side's new-phase grant with the other's
not-yet-paid grant.

Bastion was purchased in all 294 assigned builds. Onslaught was purchased in
134/308, Sprint in 68/294. Assigned-build win rates were respectively 61.6%,
50.3% and 38.1%. This is an association, not a controlled causal ranking: builds,
pairs and policies interact, and purchase itself depends on survival. Still,
waiting for Sprint often meant dying before obtaining a path.

Quiet play is very different. Merely holding each home zone and passing legally
yields **749 CP / 352 UP / 129 regular points** per side by Phase 3 postmatch,
before spending. Once both sides enter overtime, their accumulated VP raises
regular points to **471** each.

The 28 stress continuations started from that legal overtime position. Black won
26 and White two; 24 ended in regicide and four in overtime expiration. Across
both sides, final median balances were **292 CP, 292.5 UP and 306 regular points**.
That supports a late surplus finding under low-attrition play, not a claim that
all ordinary matches are rich.

There is also a hard spending limit. Starting overtime without a path or prior
uses, activation plus every remaining CP use can consume at most:

| Path | Maximum CP spend in overtime | Necessarily left from 749 CP |
|---|---:|---:|
| Bastion | 530 | 219 |
| Onslaught | 575 | 174 |
| Sprint, including discounts | 598 | 151 |

The caps include five utility casts, three skill uses and the single ultimate.
Even perfect spending cannot use the whole quiet-game wallet at that point.
Overtime's closed deployment gates also limit what extra UP can buy. Action
budgets, cooldowns and uses—not just affordability—become the binding constraints.

Other verified conversion opportunities:

- Strengthen then withdrawal raised a Vet 2 queen's refund from 48 to 144 UP for
  25 CP. This exceeds Convert's 50 UP per cast, but needs a veteran, positioning
  and a unit retirement.
- Withdrawing three idle veterans at Phase 2 postmatch produced 330 UP without
  attrition. They lost their rank and active service; it was not free power.
- Sprint's Recharge on a ready Warcry/Sap pair paid 60 regular points for 22 CP.
  Its use limit bounds the exchange. Some economy casts merely increased already
  unspent balances.

I would adjust the **income/spending curve**, if desired, before raising every
cost again: that could make the early shortage worse while leaving late caps and
unused wallets unchanged.

## Likely player experience and next priorities

My judgment is that the interesting part is **protecting a king while creating
local advantages and meeting scoring deadlines**. Pure waiting and pure resource
farming do not replace tactical play. Damage setup, control, healing and action
order have real uses. A median of about 10 originally deployed battlefield units
acted per side, out of 24 starters: choosing whom to activate matters, but a large
army also creates decision load before much of it participates.

The risks to enjoyment are surprise loss conditions and perceived lack of agency:
remote bench casualties, control surviving its caster, prevention needed a turn
before tally, and a postmatch where the apparent comeback is unlikely. Those are
more concerning than evidence of a single solved opening.

I would prioritize:

1. Review whether remote damage to inactive base units should be such a strong VP
   weapon. If intentional, test whether players can anticipate and counter it.
2. Human-test Cast/Blitz timing and the Phase 3 postmatch promise. Distinguish an
   exciting announced threat from a rule-knowledge trap.
3. Review late CP income against the finite ability uses, separately from early
   path accessibility and contested-game scarcity.
4. Improve/evaluate CPU turn planning before using its difficulty as evidence of
   balance. Normal won **1/16**, Hard **3/8** against the experimental opponents.
   Traces often left Initialization actions unused; its wall-clock search can
   spend its budget evaluating alternatives instead of completing a stronger turn.
5. Play targeted human sessions with archers, Taunt, Trap and deliberate withdrawal
   economies. These are blind spots of the simulation, not established dead skills.

These are recommendations for the owner's decisions, not implemented rule changes.

## Method, checks and reproduction

The main design covers seven styles, all 28 unordered matchups including mirrors,
eight seeds and both seats. Policy weights, small seeded exploration and tactical
combination search produce varied decisions. **Path preferences and pool pairs
are assigned experimental builds; they are not organic human pick rates.**
Candidates reuse the shipped CPU, with three shortlisted movements, additional
unlocked-kit combinations and one considered target per ability per iteration.
Each turn permits up to 12 incremental selections. This is a seeded Monte Carlo
policy tournament, **not Monte Carlo tree search or an optimal-game solver**.
A considered legal opportunity is a lower bound, not enumeration of all targets.

The shipped CPU comparison uses its different evaluation/search, Normal's two
seconds and Hard's five. Its choices depend on hardware/load. All players share
parts of candidate generation and analysis-only geometry memoization, so their
blind spots are correlated. Exact transcripts are preserved. No trained model,
human playtest, fresh rendered UI check or independent agent review ran.

Execution uses the authoritative turn preview in isolated containers, forbids
SQL, and has no network, production database mounts or published service ports.
The simulator's optimized state cloning passed eight atomic-turn comparisons and
three tactical fixtures. All stored transcripts passed atomic replay; a further
448-game replay collected the per-participant arrival balances. Focused expected
rejections passed. Pilot/scouting games and performance experiments are excluded.

Existing source was preserved: hashes of every pre-existing file matched the
pre-run snapshot except the intentionally updated Scrum backlog. No engine,
client, preset, production service, database or sibling repository changed.
Application suites/layout checks were not rerun for analysis-only additions.

Source: `feature/deployment-scaffold` at `16ae570` plus the pre-existing uncommitted
deployment work. Ruleset revision remains null. Config SHA-256:
`bc468cd593022ab9095f1a2e130bb794e8d97c400ee126e7f0a81e9457f36af8`.
Simulator SHA-256:
`bf448947479b13836db176dbe76c3fb147cd0027afadd2eed96bd49b292c30c5`.

- [Simulator](../server/scripts/simulate_balance.py)
- [Machine-readable results](BAL-002-results.json)
- [Raw transcripts, policies, probes and replay checks](BAL-002-evidence.zip)
- [Task contract](../specs/BAL-002-monte-carlo-gameplay-review.md)

From `server/`, using Python 3.14 and the installed Django environment:

```sh
DJANGO_DEBUG=true python scripts/simulate_balance.py --output /tmp/check.json --self-check
DJANGO_DEBUG=true python scripts/simulate_balance.py --output /tmp/tournament.jsonl --workers 8 --seeds 8 --width 3
```

The evidence archive contains holdout/probe/audit scripts. Keep them together;
when executing outside `server/`, also put the server directory on `PYTHONPATH`.
Original full logs remain in Windows Temp `cpp-montecarlo-20261018-h5_3lyeg`.
No commit, publication or deployment was performed.
