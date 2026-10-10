# Rules checklist

**Current shipped match rules, with implemented JSON paths.** Tick a rule after owner review.
**Bold** values are the draft defaults. Nothing reads this document; both engines read
`shared/default-config.json`. Units and abilities remain outside this checklist.
See [CONFIGURATION.md](CONFIGURATION.md) for editing and compatibility. Last updated 10 Oct 2026.

## New since the last review

- Match rules now resolve from each saved configuration, including variable phase and overtime counts.
- Format **2.0** is separate from balance identity; preset **default / null (draft)** remains unreleased.
- Frozen format-1 data preserves older imports and started games; no owner database migration or restart.
- Current defaults retain the 9 Oct mechanics and income. Names below are real supported paths.

## Board and schedule

- [ ] `board.radius`: **11**, 397 battlefield hexes and 541 rendered cells including panels.
- [ ] `board.orientation`: **edge-up**; hex topology stays axial.
- [ ] `match.objective`: **regicide**; elimination is also supported.
- [ ] `match.turnTimeLimit`: **0** (unlimited); the online room choice overrides it at start.
- [ ] `match.maxTurns`: **0** (no ply limit); individual side turns, unlike full schedule turns.
- [ ] `match.opening`: **Initialization, 3 turns, 1 point per own turn, grant 0**.

| Phase | Ordinary full turns | Halftime after | Postmatch turns | Points before/after/postmatch | Grant | VP multiplier | Fixed CP |
|---|---|---|---|---|---|---|---|
| Phase 1 | **10** | **5** | **1** | **1/1/1** | **20** | **1** | **10** |
| Phase 2 | **10** | **5** | **1** | **1/2/2** | **20** | **2** | **20** |
| Phase 3 | **10** | **5** | **1** | **2/3/3** | **20** | **3** | **30** |

Paths: `match.phases[].turns`, `halftimeAfter`, `postmatchTurns`, `pointsBeforeHalftime`,
`pointsPerTurn`, `postmatchPointsPerTurn`, `grant`, `vpMultiplier`, `cpAward`.

- [ ] Shipped phase starts: **Turn 4, 15, 26**; halftimes **9, 20, 31**;
  tallies/postmatches **14, 25, 36**; overtime begins **37**. Derived from the schedule.
- [ ] `match.overtime.pointsPerTurn`: **0**, plus the once-only VP conversion.

| Overtime stage | Full turns | King HP toll per own turn | BF / reserve / base units |
|---|---|---|---|
| Overtime 1 | **8** | **1** | **1/1/1** |
| Overtime 2 | **5** | **3** | **2/2/2** |
| Overtime 3 | **1** | **5** | **3/3/3** |

Paths: `match.overtime.stages[].turns`, `kingToll`, `moves.{battlefield,reserve,base}`.

## Stage permissions and movement

| Stage | Attack | Heal | Pool | Unit | CP utility / skill / ultimate | Wrap / reserve entry / home | Each category moves |
|---|---|---|---|---|---|---|---|
| opening | **no** | **no** | **no** | **no** | **yes/no/no** | **no/yes/yes** | **1/2/3** |
| firstHalf | **yes** | **yes** | **yes** | **yes** | **yes/yes/yes** | **yes/no/no** | **1** |
| secondHalf | **yes** | **yes** | **yes** | **yes** | **yes/yes/yes** | **no/yes/no** | **1** |
| postmatch | **no** | **yes** | **yes** | **yes** | **yes/yes/yes** | **no/yes/yes** | **3** |
| overtime | **yes** | **yes** | **yes** | **yes** | **yes/yes/yes** | **no/no/yes** | **per overtime stage** |

Each flag is under `stageRules.<stage>`, with independent category allowances
`moves.{battlefield,reserve,base}`. Opening arrays need one entry per opening turn.
- [ ] `stageRules.movedUnitsLockedInOpening`: **true**.
- [ ] Switching units ends the earlier walk in that category until Undo. **Fixed action rule**.
- [ ] Entry stops in the configured home rows and ends its action. **Fixed action rule**.

## Economy, scoring, combat, panels and veterancy

### economy

- [ ] `economy.pointsAtStart`: **10**. Starting regular ability points, before ordinary own-turn income.
- [ ] `economy.upAtStart`: **10**. Starting unit points (UP), before deployment or unit-ability spending.
- [ ] `economy.killPayMultiplier`: **1**. UP bounty multiplier for ordinary attack/counter kills in eligible exchange zones; ability kills remain exempt.
- [ ] `economy.killPayZones`: **["battlefield"]**. Exchange target zones eligible for UP combat bounties, including its counter casualty. Empty disables these bounties.
- [ ] `economy.walkHomeRefund.valueMultiplier`: **1**. Unit-value multiplier in the withdrawal refund.
- [ ] `economy.walkHomeRefund.fee`: **1**. Fixed UP deduction from the withdrawal refund.
- [ ] `economy.walkHomeRefund.missingHpMultiplier`: **1**. UP deducted per currently missing HP at withdrawal.
- [ ] `economy.walkHomeRefund.minimum`: **1**. Minimum UP refund for a withdrawal.
- [ ] `economy.wrapPriceMultiplier`: **1**. UP multiplier on unit value when crossing from red base to green reserve.
- [ ] `economy.halftimeUpMultiplier`: **1**. Multiplier on each side's current phase VP snapshot added to UP at halftime, once.
- [ ] `economy.overtimeVpToPointsMultiplier`: **1**. Multiplier on final cumulative numbered-phase VP converted to regular points on each side's first overtime turn.
- [ ] `economy.cpOwnScoreMultiplier`: **1**. CP multiplier on this side's banked score in each numbered phase.
- [ ] `economy.cpOpponentScoreMultiplier`: **1**. CP multiplier on the opponent's banked score in each numbered phase.
- [ ] `economy.cpBehindGapMultiplier`: **1**. CP multiplier on max(0, opponent score − own score) in each numbered phase.

### scoring

- [ ] `scoring.layout.columnRatio`: **0.6363636363636364**. Side anchor columns as a fraction of board radius, rounded with Math.round semantics and kept outside the zone radius.
- [ ] `scoring.layout.rowRatio`: **0.5454545454545454**. Home anchor rows as a fraction of board radius, rounded to whole row pairs.
- [ ] `scoring.zones`: **five radius-2 zones**; centre **2 VP**, side **1 VP**, home **3 VP** per hex.
  Shipped Show Hex centres: **271**, sides **264/278**, homes **130 (Black)/412 (White)**.
  Each zone supplies `kind`, `owner`, `radius`, `worth` and exactly one `anchor` or absolute `center`.
- [ ] `scoring.floorAtZero`: **true**. Clamp capture worth minus weighted deaths to 0 before applying the phase multiplier; false permits negative VP.
- [ ] `scoring.deathCostMultiplier`: **1**. Attrition VP deduction multiplier on each dead unit's configured value.
- [ ] `scoring.deathZones`: **["battlefield", "reserve", "base"]**. Victim zones whose casualties contribute attrition; empty disables the deduction. Counters use the attacker's battlefield zone.
- [ ] `scoring.innerClaimReach`: **1**. Claim radius for eligible units on inner layers outside the centre.
- [ ] `scoring.outerClaimReach`: **0**. Claim radius for eligible units on the zone's outermost layer.
- [ ] `scoring.neutralizeReach`: **1**. Radius in which eligible units neutralize opposing normal claims.
- [ ] `scoring.centerControl`: **true**. An uncontested eligible centre occupant claims its entire zone; eligible enemies in that zone disable this bonus.

### combat

- [ ] `combat.rangeFalloff`: **0.25**. Linear loss per extra ring for scalar ATK; exact ring profiles do not use it.
- [ ] `combat.minStrikeDamage`: **1**. Minimum positive ordinary strike after DEF, capped by effective ATK; 0 lets armor absorb it fully.
- [ ] `combat.minRangedDamage`: **1**. Minimum positive scalar ATK after range falloff, capped by its original ATK.
- [ ] `combat.counterattacks`: **true**. Master counterattack permission; false suppresses all ordinary counters.
- [ ] `combat.baseCounters`: **false**. Allow red-base defenders to counter when otherwise eligible.
- [ ] `combat.reserveCounters`: **true**. Allow green-reserve defenders to counter when otherwise eligible.

### panels

- [ ] `panels.homeRows`: **3**. Depth of home battlefield rows available for reserve entry, withdrawal and existing home-row positional effects.
- [ ] `panels.crossingStepCost`: **1**. MOV cost of a doorway/wrap step; at least 1.
- [ ] `panels.baseHealPerTurn`: **1**. HP mended at each own turn end while alive in red base, capped at current maximum HP.
- [ ] `panels.reserveHealPerTurn`: **0**. HP mended at each own turn end while alive in green reserve, capped at current maximum HP.

### veterancy

- [ ] `veterancy.startingRank`: **0**. Stars assigned to each initially dealt unit in all zones.
- [ ] `veterancy.statUnlock`: **1**. Earned rank needed for the configured veterancy stat boost, 0–3.
- [ ] `veterancy.passiveUnlock`: **2**. Earned rank needed for the configured unit passive, 0–3.
- [ ] `veterancy.abilityUnlock`: **3**. Earned rank needed for the configured unit active ability, 0–3.
- [ ] `veterancy.award`: **1**. Stars added at each eligible award, capped at rank 3; 0 disables rank gain.
- [ ] `veterancy.firstPhaseStartAward`: **true**. Award both sides simultaneously at the first numbered phase start.
- [ ] `veterancy.postmatchAwards`: **true**. Award both sides simultaneously at every numbered phase's postmatch start, if that phase has a postmatch.
- [ ] `veterancy.awardZones`: **["battlefield", "reserve"]**. Zones eligible for natural awards and the configured final full heal.
- [ ] `veterancy.kitZones`: **["battlefield"]**. Zones where earned veterancy stats, passives and unit active abilities function. Stars persist outside these zones.
- [ ] `veterancy.fullHealPhase`: **"last"**. Full-heal postmatch: last means the final numbered phase, an integer selects a phase, 0 disables it.
- [ ] `veterancy.fullHealRank`: **3**. Rank required before the full-heal award, so a same-boundary promotion does not newly qualify.

## Endings and structural rules

- [ ] `match.winConditions.earlyPhaseLosses`: **Phase 1 White loses at eligible capture occupancy ≤0; Phase 2 Black loses at phase VP ≤0**.
- [ ] Pending losses freeze at tally and resolve after the complete postmatch; king death takes priority. **Fixed resolution order**.
- [ ] `match.winConditions.points.enabled`: **true**.
- [ ] `match.winConditions.points.leadToWin`: **White 50 / Black 25**, inclusive overtime margins, keyed by the leading side.
- [ ] `match.winConditions.overtimeWinner`: **black** after the last configured overtime turn.
- [ ] Mutual commander deaths produce a draw; players may offer a draw or resign. **Fixed predicates**.
- [ ] Ordinary combat is deterministic; positive attacks use configured floors and DEF. **Fixed algorithm**.
- [ ] Opening/overtime score no phase VP. **Fixed schedule structure**.
- [ ] Timeout commits staged moves or passes; server drafts are private and version-guarded. **Fixed protocol**.
- [ ] Automatic replay and the turn notice pause the timer; manual Replay does not. **Fixed playback policy**.
- [ ] Effective unit stats cap at **99** and rank at **3**. **Fixed invariants**.
- [ ] Panel units cannot initiate ordinary attacks/heals; configured active unit kits do not bypass this. **Fixed source rules**.

## Implementation contract

A number edit changes shared defaults only; started matches retain complete snapshots.
Shape changes also update the schema, both validators and refusal/parity cases.
Format 1 data lives in immutable compatibility files; retired keys do not set current limits.
Units, ability effect algorithms and visual/transport settings are deliberately kept separate.
Current verification and owner-SEEN status are recorded in CODEX_HANDOFF.md and PUNCHLIST.md.
