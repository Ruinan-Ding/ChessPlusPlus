# Rules checklist

**Every match rule the game plays by today, one line each, for the owner to review.** Tick a
rule that is right. Where one is wrong, change the number or write a note under it.

- **Bold** is today's value: what the game does right now.
- `code` is the name the rule would have once it is config (see [Config shape](#config-shape)).
  Rules marked *fixed* have no name: they follow from the board or the game's structure.
- Hexes are the numbers **Show Hex** draws on the radius-11 board. Black's mirror of hex n is
  hex **542 − n** (white's king on 530 mirrors to black's on 12).
- **A plan, not a config file.** Nothing reads this document. Units and abilities are kept
  separate and are not in it.

Last updated 4 Oct 2026.

---

## New since the last review

- [ ] **UP is separate from ability points:** start with **10**, spend unit value on the
  base-to-reserve crossing, receive battlefield attack/counter kill value and homecoming
  refunds. Ability and panel kills pay none. Each halftime adds a persisted snapshot of
  each side's own current phase VP to its UP. Owner confirmed, 4 Oct 2026.

- [ ] **Every postmatch permits abilities and normal unit healing; normal attacks remain
  forbidden.** This includes both sides' turns and all ability categories, with their usual
  costs, cooldowns and target rules. Online casts remain deferred. Live, 4 Oct 2026.

- [ ] **Capture and neutralization use each unit's cumulative zone permissions.** Permissions
  are in the shared unit config: home 3x, middle 2x, sides 1x and enemy 3x. Live, 4 Oct 2026.
- [ ] **Outer-ring units score only their occupied hex; inner-ring units also score adjacent
  hexes.** All eligible units still neutralize adjacent enemy claims. Live, 4 Oct 2026.
- [ ] **An unopposed centre holds all nineteen zone hexes.** Any enemy inside that zone that
  is eligible to capture or neutralize it removes the bonus; normal adjacent claims then
  apply. Ineligible enemies do not block it. Live, 4 Oct 2026.

- [ ] **Explicit attack values per ring skip percentage falloff.** Otherwise the
  existing 0.25 per extra ring still applies. Live, 3 Oct 2026. Unit values remain in
  the shared config. (See [Combat](#9-combat).)
- [ ] **Capture zones are worth 3, 2 or 1 a hex.** The zone in each side's half is 3, the
  middle one 2, and the two at the sides 1. A zone is worth the same to whichever side holds
  it - white holding the ×3 zone by black's base gets 3 a hex too (**confirmed by the owner,
  26 Sep 2026: "worth 3 a hex"**). Live in the game. (See [Victory points](#6-victory-points).)
- [ ] **The opening shows capture points but counts none of them.** The header shows what each
  side holds during turns 1-3; none of it reaches the match total or gets banked. Live.
- [ ] **CP: one award number per phase** (5, 10, 15) instead of 5 times the phase number.
  Planned; the numbers come out the same today.

Screen only, not rules: a dark line now marks where the bases and reserves meet the
battlefield; black's 3x zone is dark blue, white's light blue, and each capture centre
has a gold inset outline, with dashed outlines on the six inner-ring hexes. There are sounds for overtime's toll on a king and for a base healing. When
both happen in the same turn, the toll plays first and the heal after it.

Fixed to match the rules below (the rules did not change): a unit wrapped out of its base
into its reserve **stops healing** - it kept healing there before - and in overtime 2 and 3 a
blow into a base or reserve **no longer throws away the turn's other moves**.

---

## 1. The board

- [ ] Radius **11**: **541** hexes, **397** of them the battlefield and **36** in each of the
  four panels. `board.radius`
- [ ] Orientation **edge-up**. `board.orientation`
- [ ] White's **base** (red) is the bottom-left panel, its **reserve** (green) the
  bottom-right. Black's base is top-right and its reserve top-left. *fixed*
  - White's base: 283, 307, 330, 331, 354, 355, 377-379, 401-403, 424-427, 448-451, 471-475,
    495-499, 518-523
  - White's reserve: 306, 329, 352, 353, 375, 376, 398-400, 421-423, 444-447, 467-470,
    490-494, 513-517, 536-541
  - Black's base: 19-24, 43-47, 67-71, 91-94, 115-118, 139-141, 163-165, 187, 188, 211, 212,
    235, 259
  - Black's reserve: 1-6, 25-29, 48-52, 72-75, 95-98, 119-121, 142-144, 166, 167, 189, 190,
    213, 236
- [ ] Each side's **home rows** are its **3** rows nearest its own edge: white 476-489,
  500-512, 524-535; black 7-18, 30-42, 53-66. `panels.homeRows`
- [ ] Units come out of the reserve through the arrows on **490, 513, 536** (white) and
  **52, 29, 6** (black). *fixed*
- [ ] The way through the base is marked on **523, 499, 475** (white) and **19, 43, 67**
  (black). *fixed*

## 2. Starting squads

White's, by hex. Black's is the mirror. `setup`

- [ ] **Base:** rooks 518, 523; knights 519, 522; bishops 520, 521; shieldmen 495, 499, 472;
  archers 496, 498, 474; pawns 497, 471, 473, 475.
- [ ] **Back row (524-535):** pawn 524, archer 525, shieldman 527, queen 529, king 530,
  shieldman 532, archer 534, pawn 535.
- [ ] **Middle row (500-512):** pawn 500, rook 501, knight 503, bishop 505, bishop 507,
  knight 509, rook 511, pawn 512.
- [ ] **Front row (476-489):** shieldman 476, pawn 478, archer 480, pawn 482, pawn 483,
  archer 485, pawn 487, shieldman 489.
- [ ] **Reserves start empty.**
- [ ] **Black mirrors white** (hex n becomes 542 − n): king 12, queen 13, and so on.
  `setup.black: "mirror"`

## 3. Turns

- [ ] A turn is **white's move, then black's**. *fixed*
- [ ] The **opening** is **3** turns (1-3). `match.opening.turns`
- [ ] Then **3 phases** of **10** turns each. `match.phases[].turns`
- [ ] Each phase's **second half** starts **5** turns in: turns 9, 20 and 31.
  `match.phases[].halftimeAfter`
- [ ] Each phase ends with **one postmatch turn**: turns 14, 25 and 36.
  `match.phases[].postmatch`
- [ ] **Overtime** runs in 3 stages of **8, 5 and 1** turns: 37-44, 45-49 and 50.
  `match.overtime.stages[].turns`
- [ ] A side moves **1** unit on the battlefield a turn; in overtime **1, 2, then 3**.
  `match.boardMovesPerTurn`, `match.overtime.stages[].boardMoves`
- [ ] In overtime 2 and 3, **moving another unit ends the first unit's move**.
  `match.overtime.switchingUnitsEndsMove`
- [ ] In the opening, **a battlefield unit moves once**: it can move or walk home, not both.
  `stageRules.opening.movedUnitsLocked`
- [ ] A panel may start **3** units moving a turn, counted separately for the base and the
  reserve (a postmatch lets **5** out of the reserve). `panels.moversPerTurn`
- [ ] Turn timer **off** (0) and no turn limit (0) unless the room sets one.
  `match.turnTimeLimit`, `match.maxTurns`

## 4. What each stage allows

`stageRules`

- [ ] **Opening (1-3):** no attacks, casts or normal healing; no wrap. Up to **3** units out of the
  reserve and **3** walks home a turn.
- [ ] **First half (4-8, 15-19, 26-30):** attacks, abilities and **the wrap**. Nothing out of
  the reserve and no walking home.
- [ ] **Second half (9-13, 20-24, 31-35):** attacks and abilities. Up to **3** units out of
  the reserve a turn. No wrap and no walking home.
- [ ] **Postmatch (14, 25, 36):** abilities and normal healing, no normal attacks, no wrap. Up to **5** units out of
  the reserve and **3** walks home.
- [ ] **Overtime (37-50):** attacks and abilities. **Walking home is allowed**, within the
  turn's battlefield moves. Nothing out of the reserve and no wrap.

## 5. Points

What pool abilities are paid with. Unit transactions use UP below.

- [ ] **1** point a turn in the opening. `match.opening.pointsPerTurn`
- [ ] **1, 2 and 3** points a turn in Phases 1, 2 and 3, each new rate starting at the phase's
  **halftime** (turns 9, 20, 31). `match.phases[].pointsPerTurn`
- [ ] A **grant of 10, 20 and 30** on each side's first turn of Phases 1, 2 and 3.
  `match.phases[].grant`
- [ ] **0** points a turn in overtime. `match.overtime.pointsPerTurn`
- [ ] When overtime starts, **all** of a side's banked victory points become points.
  `match.overtime.vpToPoints`
### Unit points (UP)

- [ ] Each side starts with **10 UP**. `rules.upAtStart` is already shared config.
- [ ] Each halftime start adds **that side's current phase VP snapshot once**, including
  losses, the zero floor and the phase multiplier. The award is retained after board changes.
- [ ] A battlefield attack/counter kill pays **the dead unit's value in UP**. `economy.killPay`
  A counter kill pays **the defender**. `economy.counterKillPays`
- [ ] Ability kills and kills in either panel pay **no UP**. `economy.panelKillsPay`
- [ ] Walking home **refunds the unit's value in UP**. `economy.walkHomeRefund`
- [ ] The base-to-reserve wrap **costs the unit's value in UP**. `economy.wrapPrice`

## 6. Victory points

The score. `scoring`

- [ ] **Five capture zones** of **19** hexes each (a centre and 2 rings). `scoring.zones`
- [ ] Capture and neutralization respect **per-unit cumulative zone permissions** in the
  shared config. Omitted permissions retain unrestricted older configs. `units[].captureZones`
- [ ] A unit on the **centre holds all 19 hexes** while **no eligible enemy is inside the
  zone**. Otherwise normal adjacent claims apply. Ineligible enemies cannot neutralize it.
  `scoring.centerControl`

- [ ] **What a hex is worth to the side holding it** (new, live): `scoring.zones[].worth`

  | Zone | Centre | Worth a hex | Hexes |
  |---|---|---|---|
  | White's half | 412 | **3** | 364-366, 387-390, 410-414, 434-437, 458-460 |
  | Black's half | 130 | **3** | 82-84, 105-108, 128-132, 152-155, 176-178 |
  | Middle | 271 | **2** | 223-225, 246-249, 269-273, 293-296, 317-319 |
  | Left side | 264 | **1** | 216-218, 239-242, 262-266, 286-289, 310-312 |
  | Right side | 278 | **1** | 230-232, 253-256, 276-280, 300-303, 324-326 |

- [ ] An **outer-ring unit scores only its occupied hex**; an **inner-ring unit also scores
  adjacent zone hexes**. All eligible units **neutralize opposing claims on their own and
  adjacent hexes**, including outer-ring units. An opposed centre uses immediate neighbours.
  `scoring.claimReach`
- [ ] A hex **both sides reach counts for neither**. `scoring.contestedIsNeutral`
- [ ] A death costs its side **the dead unit's value**, in the phase it happened.
  `scoring.deathCost`
- [ ] A unit killed **in a base costs nothing**; one killed in a reserve costs its value.
  `scoring.baseDeathsCount`, `scoring.reserveDeathsCount`
- [ ] A phase scores **(worth held − deaths), never below 0, times 1, 2 or 3** for Phases 1,
  2 and 3. `scoring.floorAtZero`, `match.phases[].vpMultiplier`
- [ ] Each phase's score is **taken as its postmatch begins** (turns 14, 25, 36), from the
  board as the phase's play ended. *fixed*
- [ ] The **opening scores nothing**. The header shows what is held, but it never counts
  (new, live). *fixed*
- [ ] **Overtime scores nothing.** *fixed*

## 7. CP

- [ ] Each side **starts with 5** CP. `match.cpAtStart`
- [ ] After each phase, each side gets **5, 10 and 15** for Phases 1, 2 and 3 (planned as one
  number per phase; today it is 5 times the phase number). `match.phases[].cpAward`
- [ ] ...plus **both sides' scores** for that phase. `match.cpIncludesBothScores`
- [ ] ...plus, for the side that scored less, **the gap** between them.
  `match.cpBehindGetsGap`

## 8. How a match ends

- [ ] A side **loses when its king dies**. `match.objective` (regicide)
- [ ] After Phase 3, **white wins on points if more than 10 ahead**, **black if more than 5
  ahead**. Anything closer goes to overtime. `match.leadToWin`
- [ ] **Phase 3's postmatch is still played** when the match is already won on points.
  `match.lastPostmatchAlwaysPlayed`
- [ ] In overtime each king loses **1, 3, then 5** HP on each of its own turns. Armour does
  not reduce it. `match.overtime.stages[].kingToll`
- [ ] If **both kings still stand after turn 50, black wins**.
  `match.overtime.bothKingsStandWinner`
- [ ] Both kings dying in the **same exchange is a draw**. `match.mutualKingKillIsDraw`
- [ ] Either side may **offer a draw or forfeit at any time**. *fixed*

## 9. Combat

`combat`

- [ ] An attack without explicit per-ring values loses **0.25** of its attack for each
  ring past the first. `combat.rangeFalloff`
- [ ] A blow that lands deals **at least 1** after defence. `combat.minStrikeDamage`
- [ ] A ranged hit is **at least 1** before defence. `combat.minRangedDamage`
- [ ] A defender **strikes back** if the attacker is within its range.
  `combat.counterattacks`
- [ ] A unit **in a base never strikes back**; one in a reserve does.
  `combat.baseCounters`, `combat.reserveCounters`
- [ ] An attacker **stays where it is** after a kill. `combat.attackerAdvances`

## 10. Bases and reserves

`panels`

- [ ] A unit in a **base heals 1 HP a turn**; a reserve heals **0**.
  `panels.baseHealPerTurn`, `panels.reserveHealPerTurn`
- [ ] Crossing out of the reserve, the wrap and walking home cost **1 extra MOV**.
  `panels.crossingStepCost`
- [ ] **A king never enters a panel.** *fixed*

---

## Left out on purpose

- **Units and abilities**, including veterancy and passives: their own sections, kept
  separate for now.
- **Room settings**: timer choices, the 30 seconds before a disconnected player forfeits, 6
  idle turns before the timer stops, and the skull warning 2 turns ahead. These stay server
  settings.
- **Animation, sounds and screen sizes.**

## Config shape

How the rules above would sit in `shared/default-config.json` once built:

```
shared/default-config.json
|-- version
|-- board        radius, orientation                          there today
|-- units        each unit type's numbers                     there today - SEPARATE, not in this list
|-- abilities    the ability catalogue and its numbers        there today - SEPARATE, not in this list
|-- setup        starting squads, by hex number               there today, by q,r coordinates
|-- match        turns, phases, points, CP, how a match ends  new
|-- stageRules   what each stage allows                       new
|-- economy      kill pay, refunds, the wrap's price          new
|-- scoring      capture zones and victory points             new
|-- combat       counterattacks and damage floors             new; 2 values move in from rules
`-- panels       bases and reserves                           new; 1 value moves in from rules
```

Where today's `rules` section goes:

| In `rules` today | Moves to |
|---|---|
| `rangeFalloff`, `minStrikeDamage` | `combat` |
| `panelMoversPerTurn` | `panels.moversPerTurn` |
| `postmatchEntries`, `homecomingsPerSetupTurn` | `stageRules` (the postmatch's 5 out of the reserve, and 3 walks home) |
| `cpAtStart` | `match.cpAtStart` |
| `cpPhaseOffset` | `match.phases[].cpAward` |
| `objective`, `maxTurns`, `turnTimeLimit` | `match` |

## What building it takes

- Most of these rules are written twice, once in the Python server and once in the
  TypeScript client, and kept equal by hand. A shared test (`scoring-parity.json`) checks
  the two agree on the score.
- **The schedule is fixed when the code loads.** One server runs every room, so each room's
  own schedule has to be passed through about 40 functions in both engines. That is most of
  the work.
- A room saved before this is built would load with today's values.
