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

Last updated 9 Oct 2026.

---

## New since the last review

- 9 Oct: automatic end-of-turn replay pauses solo and online timers. Online uses a
  server-derived, persisted allowance from the completed turn and shared animation
  timings; the 900 ms nonblocking turn notice is excluded too, including a fresh
  match's first turn. Reload grants no additional time. Manual Replay (Z) keeps counting.

- 9 Oct: independent battlefield/base/reserve allowances follow 1/2/3 Initialization,
  one normal, three postmatch and 1/2/3 Overtime; switching units ends the earlier
  category walk until Undo. Walks home consume battlefield actions; reserve entries end their action.
- 9 Oct: red-base deaths now count attrition VP, with no panel UP bounty.

- [ ] **Phase 3 overtime margins are White 50, Black 25**, inclusive; larger
  leads end on points after both postmatch turns. Owner revision, 9 Oct 2026.

- [ ] **Regular points start at 10**, before normal own-turn income; each numbered
  phase grants **20** on each side's first turn. Owner revision, 8 Oct 2026.

- [ ] **Unit stats have a hard maximum of 99:** current/max HP, MOV, DEF, each ATK/HEL
  tier and unit ranges, including veterancy and temporary effects in every zone.
  Cap full MOV before deducting steps already spent. Prices, points, CP, UP and VP
  retain their existing rules. Fixed limit specified 8 Oct 2026.

- [ ] **Early phase losses freeze at tally and resolve after both postmatch turns:**
  Phase 1 checks White's eligible capture-zone occupancy; Phase 2 checks Black's zero
  phase VP. Regicide takes priority. Live, 7 Oct 2026.

- [ ] **Initialization permits CP utilities only**; other casts and ordinary healing
  remain blocked. Owner phase-use revision, 7 Oct 2026. The same gates apply to authoritative online casts.

- [ ] **Timed solo turns automatically commit all staged work at expiry**, or pass if
  empty. Five final-second warnings and a hard expiry beep. Online, the server commits
  the latest validated saved draft, including during disconnect grace; a timer/browser
  race commits once. Automatic replay and the 900 ms turn notice pause both
  modes; the notice leaves controls playable. Online allowance is
  server-derived and persisted across reconnects. Manual Replay counts. Owner
  confirmed expiry on 7 Oct and replay timing on 9 Oct 2026.

- [ ] **UP is separate from ability points:** start with **10**, spend unit value on the
  base-to-reserve crossing, receive battlefield attack/counter kill value and homecoming
  refunds. Ability and panel kills pay none. Each halftime adds a persisted snapshot of
  each side's own current phase VP to its UP. Owner confirmed, 4 Oct 2026.

- [ ] **Every postmatch permits abilities and normal unit healing; normal attacks remain
  forbidden.** This includes both sides' turns and all ability categories, with their usual
  costs, cooldowns and target rules. The same gates apply to authoritative online casts. Live, 4 Oct 2026.

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
- [ ] **Fixed CP portions are 10, 20 and 30** at the three postmatch starts,
  doubling the old fixed portion; VP totals and the shortfall bonus remain.

Screen only, not rules: **Replay (Z)** replaces the visible Flip button, preserves staged
moves and zoom, and keeps the turn timer running. Flip sits to the left of Start Game;
its button and F shortcut work after the match starts, and the button is grey beforehand.
The Room tab gives its controls up to 32px more height on short portrait phones. Black panels
are lighter and ordinary battlefield hexes darker. A blue line marks where the bases and reserves meet the
battlefield; black's 3x zone is dark blue, white's light blue, and each capture centre
has a gold inset outline, with dashed outlines on the six inner-ring hexes. A gold outline
traces the outer hex edges of the complete grid, including panels; both sides' base/reserve hex edges have stronger
contrast. After replay, each side's turn announcement shows Turn N and White/Black in a matching
box. It lasts 0.9s, including about 0.5s at centre. Closed-arrow crosses use lighter red. Unlimited ability labels show remaining/total cooldown and cost; CP utilities show
remaining phase uses, CP skills and ultimates show remaining match uses; path labels separate names and CP costs with a dash. Unit details close on
a different unit selection. Multi-recipient effects animate in one shared beat; exhausted ability buttons stay grey and open their descriptions. There are sounds for overtime's toll on a king and for a base healing. When
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
- [ ] Battlefield, base and reserve each allow **1/2/3** units in Initialization turns 1/2/3,
  **1** in normal play, **3** at postmatch and **1/2/3** in Overtime stages.
  `match.boardMovesPerTurn`, `match.overtime.stages[].boardMoves`, `stageRules`
- [ ] **Moving another unit in the same category ends the first unit’s move until Undo**.
  `match.overtime.switchingUnitsEndsMove`
- [ ] In the opening, **a battlefield unit moves once**: it can move or walk home, not both.
  `stageRules.opening.movedUnitsLocked`
- [ ] Base and reserve use **independent stage allowances**, separate from battlefield actions.
  `panels.moversPerTurn`
- [ ] Turn timer **off** (0) and no turn limit (0) unless the room sets one.
  `match.turnTimeLimit`, `match.maxTurns`

## 4. What each stage allows

`stageRules`

- [ ] **Opening (1-3):** CP utilities only; no attacks, other casts or normal healing; no wrap. Each category allows **1/2/3** units in turns 1/2/3.
  Walking home consumes a normal battlefield action.
- [ ] **First half (4-8, 15-19, 26-30):** attacks, abilities and **the wrap**. Nothing out of
  the reserve and no walking home.
- [ ] **Second half (9-13, 20-24, 31-35):** attacks and abilities. Up to **1** unit out of
  the reserve a turn; entry ends its action without attacking. No wrap and no walking home.
- [ ] **Postmatch (14, 25, 36):** abilities and normal healing, no normal attacks, no wrap. Each category allows **3** units;
  walking home shares the battlefield movement allowance.
- [ ] **Overtime (37-50):** attacks and abilities. **Walking home is allowed**, within the
  turn's battlefield moves. Nothing out of the reserve and no wrap.

## 5. Points

What pool abilities are paid with. Unit transactions use UP below.

- [ ] Each side starts with **10 regular points**. `rules.pointsAtStart` is shared config.
- [ ] **1** point a turn in the opening. `match.opening.pointsPerTurn`
- [ ] **1, 2 and 3** points a turn in Phases 1, 2 and 3, each new rate starting at the phase's
  **halftime** (turns 9, 20, 31). `match.phases[].pointsPerTurn`
- [ ] A **grant of 20** on each side's first turn of Phases 1, 2 and 3.
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
- [ ] Walking home refunds **`max(1, unit value - 1 - current missing HP)` UP** at departure. `economy.walkHomeRefund`
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
- [ ] A unit killed **in a base or reserve costs its value in attrition VP**; panel deaths grant no UP bounty.
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
- [ ] After each phase, each side gets **10, 20 and 30** for Phases 1, 2 and 3 (planned as one
  number per phase; today it is 10 times the phase number). `match.phases[].cpAward`
- [ ] ...plus **both sides' scores** for that phase. `match.cpIncludesBothScores`
- [ ] ...plus, for the side that scored less, **the gap** between them.
  `match.cpBehindGetsGap`

## 8. How a match ends

- [ ] **Phase 1: White loses if no eligible White unit occupies a capture-zone hex at tally.**
  Contested occupancy still qualifies; zero VP alone does not decide this phase. *fixed*
- [ ] **Phase 2: Black loses if its phase VP tallies to 0.** Eligible occupancy alone does
  not prevent this loss. *fixed*
- [ ] **Both postmatch turns finish before either pending phase loss resolves.** Freeze
  the loser at tally; a king kill during postmatch takes priority. *fixed*

- [ ] A side **loses when its king dies**. `match.objective` (regicide)
- [ ] After Phase 3, **white wins on points if more than 50 ahead**, **black if more than 25
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
| Retired `panelMoversPerTurn`, `postmatchEntries`, `homecomingsPerSetupTurn` | Mirrored stage-based category allowances; obsolete saved keys ignored |
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
