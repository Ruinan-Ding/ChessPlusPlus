# AGENTS.md

Guidance for AI agents working in this repo. Human-readable too — `README.md` covers
setup, this covers the things that are easy to get wrong.

## How to work here

**Invoke the `ponytail` plugin for all code work in this repo** — `/ponytail` (default level
`full`). Source: `DietrichGebert/ponytail` marketplace; install with
`/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`.
It is currently installed at *user* scope, so a fresh clone by someone else won't have it.

The plugin is the source of truth for what "lazy" means here — don't restate its rules in
this file, just run it. Sibling skills: `/ponytail-review` (over-engineering review of a
diff), `/ponytail-audit` (whole-repo), `/ponytail-debt` (harvest `ponytail:` comments into a
ledger), `/ponytail-help`.

Two repo-specific notes that override nothing but are easy to get wrong under it:
the engine's config-driven design means a *small* diff in the wrong place silently breaks the
invariants below — read the code a change touches before picking a rung. And the game spec is
the owner's call, never a "reasonable default" (see **Game spec** below).

## What this is

A hex-grid tactical game (Fire-Emblem-style combat, chess-derived turn structure) with a
Django Channels WebSocket backend and an Angular frontend. Units have HP and attack;
combat deals damage rather than capturing outright.

## Commands

```bash
# Server (from server/)
DJANGO_DEBUG=true daphne core.asgi:application        # serve on :8000
DJANGO_DEBUG=true python manage.py test               # 89 tests
DJANGO_DEBUG=true python manage.py test game.testsuite  # 85 tests, engine + consumers + models

# Client (from client/)
ng serve                                              # serve on :4200
ng test
```

`DJANGO_DEBUG=true` is required for **every** local `manage.py` invocation. Without it
`core/settings.py` demands a real `DJANGO_SECRET_KEY`/`DJANGO_ALLOWED_HOSTS` and refuses to
start. That is deliberate — don't "fix" it.

`server/venv/` is gitignored, so a fresh clone has no venv — build one from
`server/requirements.txt`. Once it exists, either activate it (`source venv/Scripts/activate`)
or call the binaries by path without activating: `venv/Scripts/python.exe`,
`venv/Scripts/daphne.exe`. Client tooling is the same story — `ng` is not global, use `npx ng`.

## Architecture invariants

Break these and the design stops working.

**1. The engine contains no unit-specific code.** `board.py`, `move_validator.py`,
`game_logic.py` never branch on a unit id. `'king'`, `'pawn'` etc. are opaque labels; all
movement and combat behaviour is read from config data. Adding a unit type must require
zero engine changes. If you find yourself writing `if unit_id == ...`, the behaviour belongs
in the config schema instead.

**2. Config lives in three places that must stay identical.** See the `config-sync` skill.
Any change to config shape touches all three or validation rejects live configs:

| File | What |
|---|---|
| `shared/game-config.schema.json` | JSON Schema (draft-07), the contract |
| `server/game/engine/config_loader.py` | `DEFAULT_CONFIG` + `_validate_config()` |
| `client/src/app/services/config.service.ts` | `DEFAULT_GAME_CONFIG` (line ~28) + `validateGameRules()` |

**3. Movement is a single `move` stat per unit** (an adjacent-hex step budget), not a pattern
list. `move_validator.get_legal_moves()` floods outward through the six hex neighbours, through
empty hexes only — a unit can never move through or onto an occupied hex, ally or enemy. No
direction/range/canJump DSL, and no white/black mirroring: flood fill is inherently symmetric.

**4. Reveal mode must never inspect config shape.** `_handle_request_reveal_mode` /
`_handle_reveal_response` treat the config as an opaque blob so that new config sections need
no transport-layer changes. Keep it that way.

## Hex geometry

Axial coordinates `(q, r)`, flat-top, radius-N board holds every hex where
`max(|q|, |r|, |q+r|) <= N`. Default radius is 11 (12 cells per edge, 397 hexes).
Reference: https://www.redblobgames.com/grids/hexagons/

Six neighbour directions (`HEX_DIRECTIONS` in `board.py`; `board.neighbours()` /
`valid_neighbours()` reuse them). There is no diagonal direction vocabulary anymore — that only
ever existed for the deleted direction-pattern movement system. `hex_distance()` in `board.py`
is the hex metric — use it, don't re-derive it.

`buildCells()` renders **more than the battlefield**: it fills every hex whose centre falls
inside the battlefield's centre-bounds *plus half a column on each flank*, squaring the board
off with `filler` cells. 541 cells at radius 11 — 397 battlefield, 144 filler; 23 per even row,
24 per odd. Bbox 1164×980. One continuous grid, no overlays.

Three rules, all learned the hard way:

**Fill by pixel bounds, never by row count.** Padding each row to a fixed number of cells looks
equivalent and is not: odd rows are staggered half a cell, so a fixed count shifts the whole
block sideways and leaves one flank a column short — visibly, as alternating gaps down that
edge. Bounding by `|x| <= limitX` is symmetric by construction. Verify by asserting every row
has equal filler counts left and right, and that the bbox centre is 0.

**Half a column of overhang, not a whole one.** Because odd rows are staggered, `limitX += step/2`
reaches the odd rows only and leaves both parities flush at the same outer edge. A full `step`
adds a cell to *every* row, so even rows jut half a hex past odd ones — a visible alternating
overhang down both flanks. This was tried and rejected.

**Don't add rows.** Row count stays 2N+1. Adding rows to force a 1:1 pixel aspect shrinks the
hexagon and was rejected. The block is 1.188:1 and that is intended — a hex grid cannot be both
row-symmetric and pixel-square, because pointy-top rows sit 1.5·S apart vertically but √3·S
apart horizontally, so squaring needs ~1.155× more rows than columns.

The bounds are guarded with `!onBattlefield`, so tuning them can only ever trim filler. Without
that guard, narrowing `limitX` silently shaves the hexagon's own left and right vertices.

Filler hexes are the **reserve panels** (see Game spec): tinted per corner
(`.panel-tl/tr/bl/br`), and each one holds a placeholder squad that can be selected and shuffled
within its own panel. Confinement is enforced by the `zone` argument to `computeMoveCosts()` /
`computeAttackZone()`, which replaces the `isInsideBoard` bound, plus a same-panel requirement on
attack targeting - so a reserve cannot leave its panel and nothing on the battlefield can reach
into one. Battlefield units still bound themselves with `isInsideBoard`, so movement cannot leak
off the board either.

Serialised coords are `"q,r"` strings (`coord_key` / `parse_coord`). `parse_coord` raises
`ValueError` on anything malformed so callers catch one exception type.

## Config pipeline

Setup screen → `set_custom_config` WS message → `config_loader.load_config()` validates →
`GameRoom.custom_config` (DB) → `build_initial_board(config)` at game start.

This path is tested and reusable. New config sections ride it for free — no consumer changes.
Offline single player skips it entirely and builds the board from `ConfigService.getConfig()`.

## Game spec (living — grows as the owner specifies it)

The game's rules are being specified incrementally by the repo owner, decision by decision.
This section is the running record. It is **not** complete and is not meant to be.

**Never invent game behaviour to fill a gap.** If a rule you need isn't written below, stop and
ask. Anything affecting how the game plays or feels — damage numbers, ranges, turn order, what
an ability does, win conditions, costs — is the owner's call, not a reasonable default.
`IMPLEMENTATION_KICKOFF.md` says this explicitly and it still holds. Ask in small themed
batches, most architecturally expensive question first.

**When the owner specifies a new rule, record it here in the same turn.** A decision that lives
only in a chat log is one the next session will silently contradict.

**Expect these to change.** A decision below can be superseded by a later one. When that
happens, edit the entry — don't append a contradiction — and check whether already-written code
depends on the old version.

Decided so far:

- **Movement is a per-unit `move` stat** (adjacent-hex step budget), flood-filled outward
  through the six hex neighbours. **A unit walks THROUGH its own**: an ally costs a step to
  pass but is not somewhere to stop, so your own line never hems you in - only the hex a unit
  would END on has to be free. **An enemy still blocks both** the hex and the way past it, so a
  path round one costs the detour. Implemented in `move_validator.get_legal_moves()` and
  mirrored in `hex-rules.computeMoveCosts()` - **change both or the two disagree about what is
  legal**, and the client will offer moves the engine then rejects.
  - It used to be "own or enemy blocks equally". The owner's rule replaced that.
  - **The three panel crossings each did their own occupancy check**, so none of them learned
    this and a single friend on a tip or a doorway shut the whole way. All three now read the
    same rule: an **enemy** on the crossing hex shuts it (no landing, no way past); one of
    **your own** only means you cannot stop there, and the walk carries on beyond it.
    `addWrap` (base to reserve), `addGateway` (reserve to board), `addBaseEntry` (board to
    base) - if a fourth crossing is ever added, it needs the same two lines.
  - **`computeMoveCosts` reports what it walked THROUGH as well as where it may stop**, via an
    optional `passable` map. `moveCosts` alone cannot answer "how far to a hex I can only pass
    over", which is exactly what a crossing needs when a friend is standing on the tip. The
    board keeps it as `passableCosts` and asks `costAt()`, which reads either. Every unit gets 6 **except the shieldman, which gets 5** -
  the first place a unit's speed is actually part of what it is. `test_engine.py` used to pin
  every unit to 6; it now checks that each one declares a move at all, which is the thing worth
  guarding.
- **Running out of time passes the turn**, it does not lose the game (superseded: the turn
  timer used to end the match against whoever was on the clock). The server owns that clock and
  passes for you; the client renders it and, if you had a turn staged, tries to commit it first.
  Timer choices are `{0, 15, 30, 60, 120, 180, 240, 300}` seconds, 0 meaning unlimited, and the
  allow-list lives in `validators.validate_game_options`.
- **One unit acts per turn**, alternating plies (confirmed — the existing chess-like turn
  plumbing stays as-is; move + attack + ability all resolve inside a single player action).
- **Attack is decoupled from movement.** Units carry `attackRange` in rings of `hex_distance`.
  Implemented — see the Combat section.
- **Damage is flat and deterministic.** No hit/dodge/crit rolls.
- **Counter-attacks:** the defender strikes back if the attacker is inside the defender's range.
- **No terrain.** Uniform board, no movement costs or defence bonuses.
- **A unit turn allows move + attack + ability.** An ultimate excludes attacking that same turn.
- **Abilities are hardcoded effects referenced by id from config JSON.** Import/export works
  immediately; there is deliberately no ability DSL yet.
- **Passive, activatable, and unit-level ultimate** abilities. Activatables recharge over N
  turns; ultimates get 1–2 charges per match.
- **Veterancy:** XP from damage dealt, damage received, and kills. Reaching a rank unlocks an
  ability or passive. Rank is *derived* from XP, never stored.
- **Four reserve planes flank the battlefield** — two per player. They are drawn as *hexes in
  the same grid*, filling the hexagon's bounding square so the whole play area is one square of
  hexagons. They are not part of the battlefield: units there are out of play, and
  `get_legal_moves()` never reaches them.
  - **Left plane** = the player's pool. Completely out of the war: it cannot be attacked or
    interacted with by the opponent at all. Troops are staged *from* here.
  - **Right plane** = staged troops. Every couple of phases of the war, units here can be
    selected and deployed into the player's first row. Unlike the left plane, the right plane
    **can** be attacked, but only in very specific ways.
  - **Placeholder squads sit in all four planes** (`buildReserves()` in
    `game-board.component.ts`): five non-commander units from config per panel, white in the
    bottom pair, black in the top. They are **client-side only** - the server's board is the
    radius-N battlefield and `set_cell()` rejects anything outside it - and **confined to their
    own panel**: `computeMoveCosts()` / `computeAttackZone()` take a `zone` set that replaces
    the radius check, and attack targeting requires both hexes to share a panel, so nothing
    reaches across the wall in either direction. Shuffling a unit inside its panel is local -
    no server message, and a reload re-deals them - but it is neither free nor beyond recall:
    it comes out of a move budget, and **Undo takes it back**. A unit that has walked but is
    not finished carries a mark on its hex (`hasWalked()`), because it is neither untouched
    nor spent and would otherwise look like the former.
  - **The red plane is the base, the green one the reserve.** **Every panel unit, base and
    reserve alike, gets its own MOV per turn and no more** - spendable a few steps at a time,
    never an endless shuffle (`panelMoved` in `game-board.component.ts`, keyed by uid).
    **No panel unit attacks**, base or reserve: they walk and nothing else. A **reserve unit
    still counters when it is hit** - *specified, not built*, because nothing can reach into a
    panel yet and the engines have no reserve to resolve a counter for. Only **three units of
    a panel may be moved in a turn** (`PANEL_MOVERS_PER_TURN`, `baseMovers` / `reserveMovers`
    - a set per panel, so one panel's walks are not counted against the other's cap).
    **Both panels carry the cap, all match**: three out of the base and three out of the
    reserve, never three between them. *The reserve used to carry it only through the
    initialization and shuffle freely after; the owner asked for the base's rule on both.*
    Allowances reset each ply. Moving a panel unit is still not the turn's one board
    action - it happens alongside it. Three is the owner's placeholder ("for now").
    **A panel unit that has been started this turn is marked**: a gold dot off the plate's
    corner (`hasWalked()` / `.walked-mark`) and the **plate itself tinted gold**
    (`.panel-walked`), so which of a panel's three have been spent reads at a glance. The
    tint is on the fill, not the stroke - the stroke belongs to selection and hover, and a
    mover that lit up the same way would read as selected. A unit
    with nothing left - MOV spent, its panel's three movers used up without it, or its one
    move of the opening already taken - is **dimmed** (`isPanelSpent()`), which reads the same
    conditions the movement rules do, so the grey can never promise a move the board refuses.
    Each side greys to **its own grey** - light for white, dark for black - because opacity
    alone made a spent white plate wash out while a spent black one only went mid-grey. Only
    the side whose turn it is greys; the opponent's panels are not the player's to move.
  - **The wrap costs points.** Crossing costs the unit's **own worth** - its config `value`,
    the same number a death is scored by, so a rook is 18 - taken off the crossing side's
    points (`wrapCost()` / `wrapCrossed` in `game-board.component.ts`, spent by
    `onWrapCrossed()` in the room). **A side that cannot pay is not offered the crossing**:
    nothing beyond the tip enters the flood, so there is no hex to click. **The price is still
    drawn on the far tip, greyed and struck through** (`wrapDenied` / `.wrap-denied`) - a gap
    that simply fails to open reads as broken rather than as expensive, and the owner has
    already asked once why units could not cross when the answer was that the side was a point
    short. What it *can* afford is marked instead - every hex on the far side that the crossing
    buys carries a red **`-x`** where x is that price, because the price is for making the
    crossing, not for the hex. An ordinary shuffle inside a panel costs nothing.
  - **The two ends of the wrap are marked with an arrow**: **up** out of the base, **down**
    into the reserve - hexes **283** and **306** on white's side of the shipped board, and the
    reverse of that on black's. Assigned by colour and drawn in board space, so a solo game as
    black turns them with the board and each player still reads their own base tip as the one
    pointing up and away (`wrapMarks()`). **Each side's arrows are coloured apart** - yours
    pale cream, the opponent's the purple the board already uses for what the other side does
    (`arrowSide` on the cell, set from the seat) - so a glance says whose way in it is without
    reading which corner it sits in.
  - **Undo spans two stacks.** Panel walks are kept by the board (`panelHistory` /
    `undoPanelMove()`), staged board actions by the room; every entry is stamped, and
    `undoMove()` pops from whichever is newer - so Undo always takes back the thing just done
    rather than reaching past it. Taking a crossing back hands its price back with it.
  - **Both sides are dealt the same opening, mirrored** (`buildReserves`). Panel hexes come in
    reading order, top to bottom, so taking the first spots from it deals the two sides
    *different* shapes - white's squad landed on its own wrap tip while black's landed at the
    far end of its base, ten hexes from anything, and the opponent could never reach the wrap
    at all. Black's panels are the point mirror of white's, so black's are walked **backwards**
    and the squads come out as exact negations of each other.
  - **Every label on the board counter-rotates** (`textTransform`), or it reads upside down on
    a board flipped for a black seat. That includes the wrap's `-x`, the base's `+x` and the
    mending `+1`; all three shipped without it and were upside down for whoever sat as black.
  - **The wrap's corridor is never dealt on** (`wrapCorridor()`). Each tip is a cul-de-sac with
    exactly one hex of its own panel leading in - every other neighbour is battlefield, which a
    panel unit may not cross - so a unit on either the tip or its doorway shuts the crossing
    for the whole panel: nothing reaches the base tip, or nothing lands past the reserve one.
    The dealt squad used to sit on both, so the wrap was closed from the first turn and a
    reload re-dealt the blockage as fast as it was shuffled away.
  - **The wrap is the only way out of the base.** A unit that reaches its base's outer tip may
    step across to the reserve tip facing it, and **the crossing costs 1 MOV**; whatever is left
    carries on into the reserve. On the shipped board white's pair is hex **283** `(-12,1)` and
    hex **306** `(11,1)` - far left and far right of the same row - and black's is the point
    mirror, `(12,-1)` and `(-11,-1)`. `wrapTips()` / `addWrap()` derive both from the radius, so
    neither number is hardcoded.
  - **The turn indicator names the stage** (`stageLabel` in the room, `stageAt()` in
    `phases.ts`): `YOUR TURN - PHASE 1 HALFTIME`. Eight stages - `Initialization`,
    `Phase 1`, `Phase 1 Halftime`, ... , `Overtime` - because **a phase that breaks in the
    middle is two stages**, the second taking the halftime's name, which is the same name
    `turnHeading()` counts down to. The result replaces the stage once the three phases have
    settled one; overtime is both a stage and a verdict and reads the same either way. *It
    used to name overtime and nothing else, leaving the other seven unnamed.* Amber now, not
    the old pale gold: it sits on the light header on every turn rather than only in overtime.
  - **A panel's wounds are applied on every rebuild, not just when it is dealt**
    (`woundReserves()` on the board). The deal happens *once* - `buildReserves()` returns
    early whenever the roster and geometry are unchanged, which is what lets a reserve
    shuffled around its panel stay where it was put - and applying `panelHp` only inside that
    deal meant the skip took the wounds with it. **A blow into a reserve was struck, recorded,
    derived and handed to the board, and then never drawn**: the unit read at full HP however
    often it was hit, until a reload dealt the panel again and the wound appeared from
    nowhere. The counter-blow landed correctly the whole time, because the attacker stands on
    the battlefield and reads its HP from `boardState`. Base units were never affected -
    `absorbWithdrawn()` re-reads them from `withdrawn` on every rebuild and has no such skip -
    and it still runs *after* `woundReserves()`, because it is the authority on a base unit's
    HP: theirs has mending on top of the wound.
  - **The turn settles up as its last beat** (`pendingUpkeep` / `settleUpkeep()` on the
    board). Two things happen at the very end of a turn, together and after every other beat
    the turn had:
    - **Everything in a base mends 1 HP** (`BASE_HEAL_PER_TURN`), never past its `max_hp`.
    - **In overtime, the commander of the side that just played loses 1 HP**
      (`OVERTIME_TOLL` in `local-game.service.ts`).

    Each swells - or shrinks, for the toll - and carries its `+1` / `-1`. They are **owed**
    where they are noticed (the mending as the new board is absorbed, the toll as the ply
    turns over) and **paid** in one beat of their own once the recap has played out;
    `runPlayback` awaits it before `playbackDone`, and a turn with nothing to replay - a pass
    - settles on its own timer. Marking them where they were noticed put them on screen
    underneath the recap, while the turn's blows were still being struck.

    **Four colours, not two** - which side wears a mark matters as much as what it says, and
    a green `+1` over a unit that is not yours reads as your own until you have found the
    plate under it. `.heal-mark` is your mending (green), `.mark-theirs` theirs (blue),
    `.toll-mark` your king paying overtime (red) and both together theirs (purple). The
    swell `popUnit()` runs is tinted to match, a shade brighter so it carries as a glow.
    The CSS is ordered plain / theirs / toll / toll+theirs so the more particular selector
    is always the later one.
  - **Mending counts a side's OWN turns, not hand-overs** (`handOversBy()` in `phases.ts`).
    A base mends at the end of its owner's turn, so a unit standing through a full turn takes
    one HP back, not the two a ply count gave it before. **A unit killed in the base is never
    mended back** - the derivation drops it at 0 HP before any mending is added, so one hit on
    a unit with 1 HP left ends it and no later turn brings it back.
  - **Overtime's toll is real damage, and a commander on 1 HP dies of it** - `regicide`, the
    game over, the board left on screen. *It used to be a mark and a shake with no HP behind
    it; the owner asked for the death.* The **points bleed is unchanged and still runs beside
    it** (`overtimeTicks()`), so a side in overtime is losing a point and an HP a turn.
    - ponytail: **the browser engine's alone** (`overtimeToll()` in `local-game.service.ts`).
      The schedule that says where overtime starts lives in `phases.ts`, and porting it to
      Python would be a fourth thing to keep in step. A networked game takes no toll.
    - A **passed turn still pays it**, so the browser engine's `turn_passed` now carries a
      `boardState` and `applyTurnPassed` takes one when there is one. The networked server
      sends none and the board stands. Only a king *the toll itself felled* ends the game
      there - a pass has never looked at who is beaten and must not start.
  - **The wrap runs on a window** (`isWrapOpen()` in `phases.ts`): open through the
    initialization, through **the first half of each numbered phase**, and through overtime -
    **shut from a phase's halftime to the end of it**. On the shipped schedule that is turns
    1-8, 14-18, 24-28 and 34 on, shut for 9-13, 19-23 and 29-33. Written as *a phase with a
    halftime is open until it, a phase without one is open throughout* (`beforeHalftime()`) -
    the opening and overtime are exactly the two without - so it reads off the schedule and
    moving a phase moves the windows with it. **The same predicate names the stage**, so the
    crossing is shut exactly while the header says `Halftime` and the two can never disagree. Shut means **no target and no price**: `addWrap()` returns at
    the top, so not even the struck-through `wrapDenied` figure is drawn, because a price is
    an offer and there is nothing on offer. What says so instead is a **red cross over the
    arrow** on the tip the crossing leaves from - each side's **base** tip, hexes **283** and
    **259**, which is the one the owner reads as pointing up (`wrapOut` on the cell, set by
    `wrapMarks()`; `.gateway-shut`). Struck out rather than removed: an arrow that vanished
    for five turns and came back would read as the board losing a feature. The rest of the
    panel walk is untouched - a base unit still shuffles inside its own base while the
    crossing is shut.
  - **Three reserve hexes are the gateway onto the board** - hexes **490** `(3,9)`, **513**
    `(2,10)` and **536** `(1,11)` on white's side, mirrored for black: the three board-adjacent
    reserve hexes nearest that player's own edge (the run of board-adjacent reserve hexes
    satisfies `q + r = radius + 1`). Each is **marked with an arrow pointing at the
    battlefield** - leftward out of white's reserve, rightward out of black's, drawn in board
    space so a solo game as black rotates it and it still points inward (`gatewayHexes()` /
    `arrowPoints()`). **The passage is built** (`addGateway()`): a reserve that reaches a
    gateway steps onto a battlefield hex beside it for one more and carries on with whatever
    MOV is left, the walk to the gap being an ordinary shuffle through the panel.
  - **More than one unit crosses in a turn.** A crossing is *the reserve's* move, not the
    turn's one board action: it is charged to that unit's own MOV and to the reserve's movers,
    exactly as a shuffle is, so several come through and the board move is still there to make
    afterwards. It is **not** the opening's one board move either - `initBoardSpent` skips the
    history records a crossing writes (`entered`). A unit **does not attack on the way in**,
    and a unit that has crossed is offered nothing more that turn: the whole reach is plotted
    before the crossing is taken, and whatever MOV it did not spend getting there is forfeit.
    (513, not the 516 first mentioned: `(5,10)` touches no battlefield hex. Confirmed by the
    owner since.)
  - **A crossing is its own message, and ends no turn.** `enter_board` carries `from`, `to`
    and **the unit itself** - no engine holds the panels, so there is nothing at `from` to look
    up - and `LocalGameService.enter()` takes it on trust, the same trust it extends to a
    boost, after checking it lands somewhere real and empty. It hands the turn to nobody and
    counts no ply, which is what lets several go out for one turn. `LOCAL_GAME_TYPES` in
    `websocket.service.ts` must list it or it is posted to a server that has never heard of it.
  - **End Turn sends the crossings before the move**, because the move is what ends the turn.
    So a crossing is applied to a board where that move has not happened yet, and one plotted
    onto a hex the staged move only *appears* to have cleared would be rejected on arrival -
    losing the unit between the two pictures. The board is given both (`committedBoard`) and
    treats anything standing on either as in the way.
  - **A panel hex draws empty while its unit stands on the board**, read off `boardState` by
    uid rather than removed from the panel. So Undo, which only drops the staged board, puts
    the unit back with no second stack to unwind, and a reload re-deals the same squad without
    doubling the one that already left.
  - **Each base carries three marks of its own, and they are the way home** - hexes **19**
    `(12,-11)`, **43** `(12,-10)` and **67** `(12,-9)` on black's, and the point mirror of
    those, **523**, **499** and **475**, on white's: the run down each base's outer edge from
    that player's far corner inwards (`baseGatewayHexes()`). Each arrow points **into the
    base**, the way a unit travels through it, so black's run right and white's left - drawn
    in board space, so each player reads their own as pointing left into their own back line.
    Each **waits on the far edge from the way it points** (`arrowBack`), which is the edge
    facing the battlefield: a unit crosses from there, so the mark sits where it arrives
    rather than where it is headed. The reserve's gap is the other way about - it points at
    the battlefield and sits on the edge it leaves through - because both rules are the same
    one: the arrow waits on the boundary it is crossed at.
  - **A unit on the battlefield walks home through them** (`addBaseEntry()`), the wrap's rule
    in reverse: reaching a board hex beside a mark is an ordinary walk, stepping through costs
    one more, and it carries on inside the base with whatever MOV is left. Only ever into
    **its own** base. It is the turn's board move, staged and undone like any other.
    - **A unit walks home in range; it does not teleport in.** Out of MOV is out of reach -
      on the shipped board the king starts nine hexes from its own base and has six, so it
      cannot go home in one turn. This was briefly made free-from-anywhere and the owner
      rejected it twice: "units range can move into the base. NOT teleport into it". Do not
      make it free again.
  - **Who may fight whom. Only the battlefield ever starts a fight:**

    | unit in… | starts a fight | can be struck | strikes back |
    |---|---|---|---|
    | battlefield | anybody in range, **panels included** | yes | yes |
    | reserve | **never** | yes | **yes** |
    | base | **never** | yes | **no** |

    So a unit at the board's edge shows its attack range running on into the panel beside it -
    the owner's screenshots are exactly this - and neither panel is ever offered a target of
    its own. The reserve is a garrison that hits back; the base is a hospital that does not.
    *This has moved twice. It is not "the base is out of the fight" (it can be struck), and it
    is not "the reserve can attack" (it cannot initiate). Read the table, not the history.*
    - **The strike overlay runs on into THEIR panel, never into yours** (`strikeBounds`, a set
      per side: every hex the board draws, less that side's own panels). It is bounded by what
      the board *draws* rather than by the hexagon inside it, because a unit at the edge really
      does reach in - left on `computeAttackZone`'s own `isInsideBoard` bound it stopped dead
      at the rim, which reads as the range ending at the board. But a side's own base and
      reserve never hold anything for it to hit, so painting its range over them says nothing.
      This is REACH, not targeting: it paints whether or not anything is standing there.
    - **The reach that crossed onto the board has its own colour** (`entryTargets`,
      `.hex-entry`, sky blue - after `.hex-legal` so it wins). Stepping through the gap is not
      the same move as shuffling about a panel, and the two read as one thing while they shared
      the green. **It beats everything a landing hex can otherwise be wearing**: the home-row
      tints (`.home-mine` / `.home-theirs`, plain fills it outranks) and the capture-zone wash,
      which is drawn *over* the fill and so has to be skipped on an entry hex rather than
      out-specified. Where a reserve can land is the answer being asked for; a zone's blue or
      the violet of whoever holds it buried it.
    - **A crossing is previewed for units you may only LOOK at, theirs included** - the wrap
      out of their base, their walk home with its `+x`, their way onto the board, and a price
      struck through when they cannot pay. `refreshPreview` lends the live target maps to the
      very helpers `refreshTargets` uses and lifts the results off into `previewWrap` /
      `previewDenied` / `previewRefund` / `previewEntry`, so there is one implementation of the
      rules rather than a second copy that can drift. The template asks `wrapCostAt()`,
      `wrapDeniedAt()`, `refundAt()`, `isEntry()`, which pick the driving layer when there is
      one and the looking layer otherwise.
      - **Priced against the purse that would pay** (`pointsOf()`, `theirPoints` bound from the
        room's `theirMovePoints`). Pricing one of theirs against *your* points would show them
        a crossing they cannot make, or hide one they can.
    - **Reach on a panel is a WASH, not a fill** (`panelWash()`, `.panel-wash`). Every reach
      colour carries `!important`, so laid on a panel hex it wiped the panel's own colour out
      entirely and the hex stopped reading as a reserve or a base. The reach fills are
      suppressed on panel hexes and a translucent polygon goes over the top instead, so the two
      fuse into a third colour - the same trick `.zone-wash` already plays over a capture zone.
      One mechanism covers every overlay that lands on a panel: the strike range, an attack
      target, the wrap out of the base, the walk home's refund hexes, and a reserve's way onto
      the board.
    - **Whether a panel answers travels with the blow** (`counters` on the attack event, the
      staged action and the `panel_attack` message), because the client owns panels and the
      engine has no idea which one a unit is standing in. `onPlayerAttack` gates its preview on
      the same flag, or a base blow would show a counter it never takes.
    - No engine holds a panel, so a blow with a panel at either end goes out as its own
      **`panel_attack`** message on the `enter_board` pattern. Whichever end is in the panel
      rides with it as `unit` and is taken on trust; **`intoPanel`** says which end that is.
      The attacker is on the board and the defender's HP comes back as `defenderHp`. It ends
      the turn, like any other swing. *(There was once a mirror of this for a reserve swinging
      out - `panelAttack`, `attackerHp`, an `intoPanel` flag to tell them apart. The rule that
      needed it is gone and so is the code; `intoPanel` survives only as the message's marker.)*
    - **The panel blow is the WHOLE turn - it carries the walk too.** `panel_attack` sends
      `from`, `to` and `moveBonus` as well as the swing, because no `make_move` follows it to
      commit the walk. Sent without `to`, the engine resolved the blow from where the unit set
      off and left it standing there, which reads on screen as the attacker being teleported
      back to where it had moved from. The engine re-derives that walk exactly as `move` does,
      applies it first, and measures range - and lands the counter - from where the unit ends up.
    - **No panel is in a fight in a server game** (`entryBind`, the same line crossings draw).
      Only the browser engine holds a panel, so a server game draws them and leaves them out of
      it; offering the blow there would send a message the server has no answer for and stall
      the turn on it.
    - **Every `move_made` carries its record under `move`** - `applyMoveMade` reads that key and
      nothing else. Both panel paths once spread the record flat instead: the message looked
      complete, the board updated, and an `undefined` went onto `moveHistory`. Everything
      derived from the record (`panelHp`, `withdrawnUnits`, the score) then read nothing, and
      `panelHp` threw on the bad entry. If you add a message that ends a turn, nest the record.
    - **A panel wound survives the deal.** The panel is re-dealt from the roster on every
      rebuild, so a wound written only into the deal would heal itself.
      - **Reserve**: `panelHp` in the room derives it from the record's `defenderHp`, and
        `buildReserves()` applies it. Staged wounds ride
        on `StagedAction.panelUnitHp`, so they are dropped wherever staging is.
      - **Base**: `withdrawnUnits` keeps each unit's *last word* on its own HP and the turn it
        was said - the walk home, or a later blow that found it there - and mends from
        whichever came last. So a wound in the base heals off from where it left the unit
        rather than being ignored by the mending.
      - **0 HP means gone**: a unit killed in a panel is simply not dealt again, and is not
        mended back to life.
  - **Coming home pays.** The refund is the unit's **own worth** - the same `value` the wrap
    charges to send one out, so a unit sent out and brought home again leaves the points where
    it found them. Every base hex the walk reaches is marked with a green **`+x`**, against
    the wrap's red `-x`. *The owner left the number open ("x can be whatever you want"); the
    unit's own worth is the one already in play, and is a choice, not a specification.*
  - **A withdrawal survives in the record, not on the board.** `make_move` carries
    `withdraw: true`, the engine takes the unit off the board and writes `withdrawn` **plus
    the unit itself** into the history; the room rebuilds the base from those records
    (`withdrawnUnits`) and hands the board what it drew. That is why a reload puts the unit
    back in the base rather than losing it - nothing holds it but the history.
  - **The way home is gated with the way out** (`entryBind`): a server game draws the marks
    and walks nobody through them, because `_handle_make_move` re-derives the walk and would
    reject a landing off the board.
  - **A unit in the base mends an HP a turn** (`BASE_HEAL_PER_TURN`, the owner's placeholder -
    "1hp (for now at least)"). **Derived, not tallied**: `withdrawnUnits` reads the HP the unit
    came home with off its own history record and adds a point for every turn since, clamped
    to what it started with - so the record is never rewritten and a reload arrives at the
    same number. Every turn counts, not only that side's.
  - **A unit that left its panel never comes back to it by accident.** A panel keeps its dealt
    squad for the whole game, so "is it drawn?" cannot be answered from the live board - a
    reserve that crossed and was then killed would reappear in its old hex, whole, ready to
    cross again. `departedUids` answers it from the record of the crossing instead (which is
    why `enter_board` writes the whole unit, uid included), plus the overlay for one still
    staged.
  - **Units that came home are ordinary panel units** (`absorbWithdrawn()`): they shuffle,
    spend MOV and grey out like anything dealt there. Merged into the panel **by uid**, since
    the room re-derives the set every turn - matching by hex would deal a second copy onto the
    landing hex of one that has since been shuffled elsewhere.
  - **A unit that has crossed or come home is done for the turn.** Both are plotted in one go,
    and `refreshTargets` refuses a second walk to either - a unit standing in a panel on the
    *staged* board is not in `reserves`, so the click handler would take its next step for a
    board move, free of the wrap's price and of every panel allowance.
  - **A `+1` marks what mended.** Drawn over any unit whose HP went up as the turn ended,
    and only those - **a unit already at full earns none**, which is what a base of unhurt
    units looks like: no mark, no number moving, and nothing to tell the mending apart from
    a mending that is broken. Held by uid, so it follows a unit shuffled afterwards, and it
    clears itself after a couple of seconds.
  - *Known ceiling:* crossings are sent before the turn's move, so a crossing that lands on the
    **path** the staged move takes (only its landing hex is checked against `committedBoard`)
    makes that move illegal on arrival. The engine rejects it, which clears the staged turn -
    recoverable, since `submittedTurn` is reset on a move error and the turn can be played
    again, but the walk is lost with no explanation.
  - **Which turns and phases close the way home is undecided.** The owner has said there will
    be some. Until they are named it is open whenever a unit can reach it, and the gate
    belongs in `addBaseEntry` beside `entryBind`. Do not invent the schedule.
  - **The gap is a solo feature for now** (`entryBind`, the same shape and the same reason as
    `buffsBind`): the panels are the client's own, so the only engine that can take a unit out
    of one is this browser's. A server game draws the arrows and the gap does not open -
    offering it would stage a walk `_handle_make_move` rejects as *"No piece at source
    coordinate"*. Lifting it means a reserve model in the engine, which means the owner's real
    roster first: dealing the current placeholder squad server-side would freeze a placeholder
    into the protocol.
  - **Which turns the gap is open is still undecided.** The owner has said it closes during
    certain phases; until those are named it is open whenever the unit can reach it. Do not
    invent the schedule.
  - **Deployment is not built.** Units leave a panel two ways - the priced wrap out of the
    base and the gap out of the reserve - and come back one, the marks into the base. What is
    still missing is the **server model** behind any of it and any **roster or
    army-composition flow**: the panels hold a placeholder squad dealt from the first five
    non-commander units in config, and nothing chooses it. Do not add staging/deployment UI
    unprompted.
  - **Left and right are from each player's own perspective.** The board is drawn white-at-the
    bottom, and a solo game played as Black rotates the whole SVG 180° (`rotateBoard`) so the
    player still faces up the screen; glyphs counter-rotate through `textTransform()`. That is
    presentation only - `panelOf()` and `buildReserves()` key off unrotated geometry, so panel
    ownership never moves. Multiplayer never rotates.
  - Historically the board never flipped —
    white always sits at the bottom, black at the top, so black faces the other way and his
    left is *screen-right*. The panels therefore pair up diagonally, not by column:

    | screen corner | owner | that player's side | colour |
    |---|---|---|---|
    | bottom-left | white | left | red |
    | bottom-right | white | right | light green |
    | top-right | black | left | dark red |
    | top-left | black | right | dark green |

    Left panels are the red pair, right panels the green pair; white gets the bright shades,
    black the dark ones. Wiring the planes up later must follow this mapping — treating
    screen-left as "left plane" would silently give black the wrong two.
  - Still unspecified: plane capacity (squaring the board yields 236 filler hexes, almost
    certainly more than the real design wants), how troops enter the left plane, the exact
    deployment cadence ("a couple of phases"), what a "phase of the war" is, which first-row
    hexes a deployment can target, and the specific ways the right plane can be attacked.

- **A carried ability can be swapped out.** The green `+` beside a path's passive offers your
  carried four back: click one that is **not cooling down** and it leaves the loadout, freeing
  the slot. **What goes into a slot freed this way comes in on cooldown**, so swapping changes
  what you carry rather than handing you a ready ability mid-match. Swapping is a pick, so it
  waits for your own turn. An ability on cooldown cannot be given up.
  - *Assumed, not specified:* the refill cooldown is **3 turns**, the same a cast leaves behind
    (`game-room.component.ts`, `pickAbility`). The owner said the replacement arrives on
    cooldown but not for how long. Confirm before treating 3 as the number.
- **The host takes a side.** The setup panel's **Me** section offers Random (the default),
  White and Black, between Game Mode and the turn timer. Only the host is asked, because the
  server refuses `start_game` from anyone else - so this is the one seat in a two-player room
  that is chosen rather than tossed for. Solo settles a Random pick on the client, since the
  browser engine plays the colour it is handed; a two-player room sends the choice and lets
  the server toss, since the server owns the seating. Anything the server does not recognise
  is a coin flip, so a client that sends nothing gets what it always got.
- **Five capture zones.** The five 19-hex patches on the battlefield - one in the middle, four
  around it - are territory. A unit standing in one claims the hex under it and the zone hexes
  beside it, so the middle of a patch is worth seven and its rim rather less. Adjacency stops at
  the zone's edge; the open board around a zone is worth nothing. **A hex both sides reach is
  held by neither**, which is what cancels two lines of units meeting in a zone: their claims
  overlap along the seam and every hex in the overlap goes neutral - a cancelled hex reads
  exactly like an empty one, to the score and on the board. Geometry and claims are
  `captureZoneHexes()` / `captureClaims()` in `hex-rules.ts`, read by the board (which colours
  them, white's amber and black's violet) and by the room (which scores them), so the two can
  never disagree. Client-side only - the server does not know a zone from any other hex.
- **Each side's home rows are tinted.** The three rows nearest a side's edge - its setup area, up
  to and including the pawn wall, so `r = 9, 10, 11` for white and the mirror for black - carry a
  pale wash: green for the seat's own, red for the opponent's. `homeOf()` in
  `game-board.component.ts` reads them off the *radius* (`|r| >= radius - 2`), not off the setup
  placement, so the ground still reads as a side's own on a config that leaves some of it empty.
  Which of the two is "mine" follows `myColor`, which in a solo game follows `soloColor` - so the
  player's own rows stay the near ones under `rotateBoard`. Cosmetic: no rule reads a home row.
- **The header score is `cap - death`, and it is called VICTORY POINTS (VP)** - the owner's
  word for it. Not to be confused with the *points* that buy abilities and wrap crossings,
  which are a separate pool entirely. Each side's standing shows beside the turn indicator -
  the opponent's to its left, yours to its right - as flag, capture hexes, skull, deaths, total.
  **Cap is what you hold right now**, read off the board every time and gone the moment you walk
  away; it is not banked and it is *not* ability points. **Death accumulates**: losing a unit
  costs you its config `value` (a pawn is 5), so a total can be negative. `phaseScore(side)` in
  `game-room.component.ts`.
  - **The initialization banks no VP; each of the three phases does.** The opening is not in
    `SCORING_PHASES`, so its running `cap - death` is shown but contributes nothing to the
    match total, and nothing is banked when it ends. Confirmed by the owner - do not "fix" the
    opening into a scoring phase.
- **A full turn is white's hand-over and black's together.** The engine counts a turn per
  hand-over (`turnNumber` goes up on every one, and white plays the odd numbers), but every
  rule below is written in **full turns** - so turn 50 is hand-overs 99 and 100.
  `services/phases.ts` is the one place the two meet: `turnOf(ply)` converts, and every
  function it exports takes the engine's count and converts for you. Do not scatter the
  conversion at call sites, and do not change what the engine counts - the server mirrors it.
- **The match runs in five phases**, on a fixed turn schedule (`services/phases.ts`):

  | phase | turns | |
  |---|---|---|
  | Initialization | 1-3 | |
  | Phase 1 | 4-13 | halftime after turn 8 |
  | Phase 2 | 14-23 | halftime after turn 18 |
  | Phase 3 | 24-33 | halftime after turn 28 |
  | Overtime | 34+ | runs out the match; first hand-over is 67 (`OVERTIME_FIRST_PLY`) |

  A halftime splits a ten-turn phase evenly. These are full turns, so the initialization is
  six hand-overs and each phase is twenty. **The history header counts down to the next
  change**, in full turns: `Turn 1 - 2 Until Phase 1`. A change lands at the *end* of the turn it is counted
  to, so the turn it lands on has already moved on to the next one - turn 3 is the last of the
  initialization and reads `Turn 3 - 5 Until Phase 1 Halftime`. Past the last change it just
  says `Turn 44 - Overtime`.
- **The initialization runs on its own rules.** Through the opening three turns:
  - **Nobody attacks at all** - not on the battlefield either. No targets are offered and no
    strike layer is drawn (`isInitialization()` in `services/phases.ts`, read by
    `refreshTargets` and `refreshPreview`).
  - **No ability is CAST** - not a pool ability, not a path's skill or ultimate, not a unit's
    own - **but choosing is exactly what the opening is for.** Two gates, and the split
    matters: `canChooseAbilities()` (take a pair up, take a path, hand a pair back through
    Reselect) is open through the opening; `canUseAbilities()` is that plus "not the opening",
    and everything that spends an ability runs through it. The panels say which rule closed
    them (`abilityBlockedNote`).
  - **Three full turns each** - white's hand-over and black's, so six hand-overs (see the
    schedule table: the turns there are full turns).
  - A side may move **three base units and three reserve units a turn, and one battlefield
    unit a turn** - one per turn, not one for the whole phase. Derived from the move history
    (`initBoardSpent` in `game-room.component.ts`), so it survives a reload and reads the same
    for both players; panel walks never reach the history, so every record in it is a board
    move.
    - It *was* one for the whole phase, which left a side with nothing at all to do on its
      second and third opening turns. The owner's words: "YOU FUCKING DISABLED ALL UNITS
      DURING INITIALIZATION". Per turn. Do not put it back.
  - **A unit that has moved is out for the rest of the phase**, not just the turn. Two
    mechanisms, because there are two kinds of unit: panel units are held by `lockedUnits`
    (filled from `panelMoved` on every hand-over, emptied when the phase ends), and
    battlefield units by `initMovedHexes` in the room, derived from the history and passed to
    the board as `initMoved`. Keyed by the hex they landed on - nothing is captured in the
    opening, so a unit that has moved is still standing there, and the record carries no uid.
    So each opening turn is spent on units that have not gone yet.
  - **Sending a unit home does not lock anything**: it has left the board, so it is not in
    `initMovedHexes`.
- **Each phase is scored on its own, and the phases add up.** The header reads
  `🚩 cap - 💀 death = this phase (+ x + y = z)`: the leading total is the **running phase**,
  the parenthetical lists the phases already finished, and `z` is those plus the running one -
  so it moves with the live score rather than waiting for the phase to end. The parenthetical
  is drawn only once something is banked; before that `z` would just repeat the number beside
  it. Whoever is ahead on `z` has it **glowing**; level pegging lights neither, so a glow
  always means a lead.
  - **The opening reads a flat `🚩 0 - 💀 0 = 0`.** Nothing can be killed in it and nothing
    caps, so `cap` is forced to 0 rather than counting hexes towards a phase that banks
    nothing (`standings()`). What the owner asked for, verbatim.
  - **Overtime draws no numbers at all** (`showScore`, `isOvertime()`). It scores nothing - it
    is a deathmatch until a king falls or turn 50 runs out - so a frozen score on screen would
    only mislead. The turn indicator still says `OVERTIME`.
  - The shape across a match, as the owner set it out: opening `🚩 0 - 💀 0 = 0`; Phase 1
    `🚩 7 - 💀 0 = 7`; Phase 2 `🚩 7 - 💀 0 = 7 (+ 7 = 14)`; Phase 3
    `🚩 7 - 💀 0 = 7 (+ 7 + 7 = 21)`; overtime, nothing.
  - **Every number in the header has its own colour**, so the eye can pick out the one it
    wants without counting symbols - and each is **mirrored** across the two sides, yours
    saturated and theirs muted, so a glance still says whose row it is:

    | | ours | theirs |
    |---|---|---|
    | `a` cap | `#229954` | `#7b241c` |
    | `b` deaths | `#c0392b` | `#14532d` |
    | `c` this phase | `#1b6ca8` | `#5c7a8f` |
    | `d` banked phase 1 | `#8a5a10` amber | `#9b8763` |
    | `e` banked phase 2 | `#0f766e` teal | `#6f9490` |
    | banked phase 3 | `#9d174d` rose | `#a8798b` |
    | `f` the match | `#6b21a8` | `#8b6fa8` |
    | `f` when leading | `#b45309` both | |

    Each banked phase carries its own colour (`.banked-1/2/3`, by `*ngFor` index), or the
    parenthetical is a row of numbers in one tone with no telling which phase is which.
    Cap and deaths are mirrored on a different principle from the totals: the *same fact*
    reads as good or bad news depending on whose side it is on, so their green and red swap
    over. The three totals are just yours-vs-theirs.
    - The header is on a **light** ground. The leading glow used to be pale gold `#ffe27a`,
      which all but vanished on it; it is amber now. And the leading rule has to be written
      per side (`.phase-score.ours .match-total.leading`) or the per-side colours outrank it.
    - The two numbers still in play are the two that move: `c` **glows** (`score-glow`, a
      `currentColor` halo, so one keyframe serves both sides' inks) and `f` **waves**
      (`score-wave`, a bob - which needs `display: inline-block`, a span having no box for a
      transform to act on). Deliberately two different motions: two pulses would read as one
      effect applied twice. Both are off under `prefers-reduced-motion`.
    - The banked numbers are separated by a literal `&ngsp;`. A plain space there is a line
      break in the wrapped markup, and Angular strips those - which is how `+ 0 + 0` once
      rendered as `+ 0+ 0`.
  - **A loss counts against the phase it happened in and no other** (`deathsOf(color, phase)`).
    Cap is whatever is held right now, and a phase's score is banked as that phase's last
    board. Cumulative deaths would be charged again in every later phase and the sum would
    mean nothing.
  - **Banked, not derived** (`phaseBank`, `bankEndedPhases()`), and persisted with the rest of
    the local UI state. A phase's cap is the board as it stood when the phase ended, and that
    board is gone by the time anything asks - so it is read on the **first turn of the next
    phase**, the one moment the old position is still on screen (a turn's move lands before
    its number is handed on). *Ceiling: a client not running at that moment banks nothing for
    that phase. Deriving it instead needs a board snapshot per phase, which is the server's to
    keep.*
  - `SCORING_PHASES` names the three numbered phases: **the match is summed from those three
    and no others**. The opening banks nothing, and overtime is not a phase but a decider - it
    takes points away rather than adding a score of its own, so the running `cap - death` stops
    counting towards `z` once the third phase is in.
- **A rejection has to undo the commit.** `invalid_move` (the browser engine's refusal, the
  counterpart of the server's `error`) clears `stagedActions`, and must also reset
  `submittedTurn` and drop `recapRunning`/`glowReveal`. Leaving either set strands the room:
  the one-commit-per-turn guard makes End Turn a no-op for the rest of the turn, and the recap
  curtain leaves the board non-interactive. Together that is what "the game fails to end turn"
  looks like, and it is reachable from any rejection, not just the one that exposed it.
- **A finished match stays on screen.** `gameStarted` deliberately stays **true** through
  `game_over`: the last position keeps the panel with the result banner over it
  (`.result-banner.over-board`), the turn indicator and the score go, and abilities shut. What
  the rest of the component asks is `gameOver` (started **and** `endReason`), not `!gameStarted`
  - "started" no longer means "playable".
  - **The start button never leaves the rail**, and is the host's alone (`isInviter`). Three
    states: `Start Game` live before a match, `Start Game` **greyed** through it, and
    `Restart Game` once it is over. Swapping controls in and out under the player is what this
    replaced. `startButtonDisabled` / `startButtonHint`.
  - **Restart puts the room back to waiting, it does not re-deal.** `reset_game` (browser
    engine only - no server has a restart protocol, which is why the button is disabled for a
    finished two-player game) blanks the game while keeping mode and options, and the room
    answers `game_reset` by clearing `gameStarted`. The Game mode / seat / Turn Timer screen
    comes back so the host can change them, and `Start Game` deals the new match. The stop is
    deliberate: a straight re-deal would make those settings unreachable between matches.
- **A committed turn holds the indicator on whoever played it** (`indicatorMine`). The board
  hands over the moment a move lands, so following it would name the next player for the whole
  replay - the animation belongs to the turn being watched. While it plays, the name goes
  **yellow** and the board's backdrop leaves green and red for yellow too: bright for your own
  turn (`committing-mine`), the same colour banked down for theirs (`committing-theirs`).
- **A panel goes dark when what it shows is a readout rather than a control.** The Opponent
  panel always; the Unit panel whenever the unit on it cannot act - one of theirs, or one of
  yours with nothing left this turn (`unitPanelDim`).
  - **The board decides drivability, not the room** (`drivable()` in `game-board.component.ts`,
    handed over on `SelectedUnit`). It walks the same gates `refreshTargets` does, in the same
    order - the turn's one unit, the opening's allowances, a panel's movers - because those are
    the board's rules and two answers to that would be one too many.
  - Reaching nothing is *not* the same as being unable to act: a unit hemmed in by its own side
    is still drivable, it simply has nowhere to go.
- **Two view controls share one row under the board**, half each (`.view-controls`):
  `Show Hex (S)` and `Flip (F)`. Both are keyboard shortcuts on the same footing as R and TAB
  (`onShortcut`, gated by `shortcutsActive`).
  - **Flip is cosmetic**: `flipView` turns the board round to read it from the other side, and
    is held *apart* from the seat's own rotation rather than folded into it - `boardFlipped` is
    the two XORed, so a black seat flips back to white's view rather than to no view at all.
    It changes nothing about whose turn it is or which units answer to you.
- **One dial sets the pace of a recap** (`PLAYBACK_SPEED` in `game-board.component.ts`). Every
  beat is written at its 1x length and divided by it, so the recap keeps its shape and only
  its speed changes. Currently **1.5** - the owner's "about 50% faster".
- **The third phase ending settles the match, or sends it to overtime** (`matchVerdict`).
  White must finish **more than 5** clear to take it outright; black only **more than 3**
  (`OVERTIME_MARGIN`) - black is allowed the wider gap because white moves first. Anything
  closer than that is overtime.
  - **Overtime bleeds a point off each side per full turn**, charged **white first** - a
    point at the end of each hand-over, white's then black's (`overtimeTicks`, counted off
    `OVERTIME_FIRST_PLY` rather than tallied, so it reads the same after a reload).
  - **The toll is shown on the board as well as in the header**: the king of whoever just paid
    takes a red **`-1`** over its icon and a hit pop (`markOvertimeToll()` in
    `game-board.component.ts`, derived from the turn that ended - white plays the odd
    hand-overs, so which side paid is arithmetic and needs no input from the room). *The king
    is marked and shaken, not actually hurt: overtime takes points, not HP, and real damage
    would kill a king off around the fortieth turn of it.*
    - The mark shares one map with the base's mending `+1` (`turnMarks` / `markOf()`): same
      mark, two colours, one fade timer.
  - **The END of turn 50 gives it to black** (`OVERTIME_LAST_TURN`), however level it still
    is - turn 50 is played out first, so the verdict flips at hand-over 101, not 99.
  - *The verdict is read, not enforced.* The engine ends a game on elimination, resignation or
    the clock and knows nothing of capture zones, so this says who is winning and draws it in
    the header - it does not stop the match. Enforcing it means the score living server-side.
- **What a phase otherwise does is not decided.** No phase change fires anything else: no
  deployment opens, nothing is locked
  Do not build phase plumbing unprompted. (This is the same "phase of the war" the reserve
  planes' deployment cadence refers to; how the two line up is still unspecified.)

Assumed by an agent, **not** yet confirmed by the owner — treat as weaker than the above and
re-check before building on it:

- **No line-of-sight for ranged attacks** — range is pure `hex_distance`, and units do not block
  shots. Cheapest option; a real LOS check is the upgrade path.

Deferred, not rejected: global (army-wide) ultimates, stat growth on rank, the real config
editor UI.

Not yet specified at all: the actual unit roster (the config still ships chess-piece
placeholders), concrete stat values, ability numbers, XP thresholds, and how many charges an
ultimate gets.

## Single-player rooms (client-side, offline)

A solo game has no second player, so nothing about it needs a server: no `Game` row, no room
UUID, no access token, no socket. It runs entirely in the browser.

- `connectionStatus$` always reports the **socket**, never local mode - a page that says
  "connected" with no server behind it is the bug this used to have. `isConnected()` answers a
  different question ("can I send?") and is true in local mode; the UI keys the roster heading
  and the status line off `connectionStatus$` / `offline$` instead. Three states, not two:
  connected, deliberately offline, and disconnected-but-still-trying.
- `WebsocketService` is the switch. While **local mode** is on, `sendMessage` goes to
  `LocalGameService` instead of the socket, and that service's replies are pushed into the same
  `messages$` every component already listens to. No component knows the difference — the
  protocol is identical, only the transport changed.
- **A solo game does not mean leaving the server.** `startLocalGame()` leaves the socket up and
  points it at the `lobby` room (the solo game has no server room of its own). Only the game's
  own traffic - the `LOCAL_GAME_TYPES` set in `websocket.service.ts` - is answered by
  `LocalGameService`; lobby roster and lobby chat stay the server's whenever it is there. So the
  status line reads "Connected to Game Server" during single player, and the Lobby tab shows the
  real roster.
- **Offline** and **local game** are two different states. Offline is the player saying "stop
  chasing the server": no socket is opened, no reconnect runs, and `sendMessage` drops rather
  than queues, so entering the lobby or typing a username never drags the dialog back up. The
  status line reads "Offline" with a **Reconnect** button beside it - the only way back, and it
  is always visible whenever there is no connection.
- Local mode means **a solo game is in progress**, nothing else. It is turned on by Single
  Player in the lobby and by the connection dialog's Single Player button, remembered in
  `sessionStorage` so a reload resumes it, and turned off by leaving the room - **not** by
  reconnecting, which only lifts the deliberate silence (see The socket). Entering a room that
  is not the solo one also ends it: a game left behind by a closed tab would otherwise answer
  for a real room. Outside a solo game the app always keeps
  trying to reach the server behind the connection dialog, which is what makes the retry
  mechanism visible. A flag that suppressed the dialog left users with no way back and no
  reconnect attempts.
- The connection dialog is the whole story when there is no server: it counts attempts, offers
  **Single Player** from the first attempt (which just goes offline - the lobby's own Single
  Player button starts the game), and adds **Retry Connection** / **Back to Login** once the
  attempts run out. `connectTimeoutMs` caps a single handshake at 3s — Chrome throttles
  repeated failed WebSocket handshakes, and without the cap an attempt can hang for minutes,
  freezing the counter and never reaching the state where Retry appears.
- The room lives at `/game-room/local?token=local`. Those are literals, not identifiers.
- `LocalGameService` persists the whole game to `localStorage` on every change, so a refresh, a
  dropped connection or a server that was never up resume the same position. **Only a deliberate
  exit clears it**: `leave_game_room` is what calls `clear()`, so the game room does not send one
  on an incidental unmount (a browser Back), and `create_single_player_game` resumes a saved
  game rather than dealing over the top of it. Both used to destroy a position in progress.
- **The offline engine mirrors the server's rules**: setup, movement via `services/hex-rules.ts`,
  combat with counter-attacks, regicide, resign, draw. `hex-rules.ts` is shared by the board's
  preview and the local engine; the damage sums and the defeat check are duplicated from
  `game_logic.py` and have specs pinning them to the same numbers. A rule that lands server-side
  has to land here too, or offline play quietly diverges.
- **The mirror covers the protocol, not only the rules.** `move_made` and `turn_passed` name
  **nobody's turn** (`currentTurn: ''`) on the action that ends a game, as consumers.py does -
  naming the next player starts a clock and sounds a turn for a finished match in the moment
  before `game_over` lands. `game_started` and `game_state_update` carry the same fields the
  server sends, field for field.
- **There is no AI.** You drive both sides; the placeholder seat (`Opponent`) has no agency.

**The server has no solo path at all.** `create_single_player_game`, `singlePlayer` in
`game_options`, the `controls_both` branches, the readiness skip and the `hostColor` pick were
deleted once the client stopped reaching them: unreachable, untested code that still carried
live bugs. Every game the server runs has two real players, which is why nobody chooses their
colour there. Wanting server-side solo rooms back (persistent games across devices, say) means
writing them against the protocol `LocalGameService` already implements, not restoring that.
`_send_game_player_list` filters `gameOptions` to `GAME_OPTION_KEYS` on the way out, because a
room row written by an older build still carries keys the validator now rejects — and the client
sends that dict straight back on its next mode change.

## Combat

A unit's turn is "walk, then optionally swing", carried by one `make_move`:
`{from, to, attack?}` where `to` is where the unit ends up (possibly where it already stood)
and `attack` names the hex it strikes from there.

- **Losing**: the objective is `regicide` - a side is beaten when it has no unit flagged
  `commander: true` left (the king). `elimination` (no units at all) is the other accepted
  value, and a side with nothing on the board is out either way. Who lost is read off the
  board by `defeated_sides()`, never inferred from who moved: a counter-attack can kill the
  attacker's own commander on the attacker's turn - and can take both commanders in one
  exchange, which ends `draw_mutual` rather than crediting the survivor of a list order.
  The end reason names the objective (`regicide` / `elimination`); `find_defeated()` still
  answers "is it over" for callers that need nothing else.
- **Reach** is `units.<id>.attackRange` in rings of hex distance, ignoring obstacles. Damage
  falls off `rules.rangeFalloff` (0.25) per ring past the first, floored, never under 1 — see
  `ranged_damage()`.
- **Damage is `attack - defense`**, floored at 0: armour can absorb a hit entirely but never
  heals (`strike_damage()`).
- **The defender counter-attacks** with the same sum reversed, but only if the attacker is
  inside *its* reach — a melee unit cannot answer a bishop three rings out. A unit reduced to
  0 HP never counters.
- **The attacker holds its ground**, even on a kill. Taking the hex would be free movement, and
  attacking is what ends the unit's movement for the turn.
- `hex-rules.ts` mirrors the damage sums client-side (`strikeDamage`, `rangedDamage`,
  `attackTiers`) for the board glyphs and the offline engine. Change one, change both — the
  specs compare them against these numbers.

## Points

Placeholder economy, entirely client-side for now. Points and cooldowns both move at the **start
of a side's turn** (`beginTurnFor`): +1 point banked, and that side's ability cooldowns tick down
one. Kills are credited as they happen - +1 to whoever killed, including the defender when its
counter-swing kills the attacker. Abilities cost points from `abilityCosts` and grey out when
unaffordable or cooling down; nothing else spends them and no ability does anything yet.

## Entering a game room

Measured, so nobody re-guesses it: the server answers `join_game_room` in ~10 ms, `start_game`
in ~43 ms, `request_game_state` in ~2 ms, and the board builds its 541 cells in ~5 ms and first
paints in ~47 ms. None of that is what makes entry feel slow.

What does: **the lazy route chunk**, which used to be fetched at the moment the player clicked
into a room (cold after every dev rebuild — hence "slow sometimes, instant other times"). The
router now runs `withPreloading(PreloadAllModules)`; all four routes are small.

The lobby and the room both **rejoin on every socket connection**, not just the first. It used to `take(1)`,
so a socket that dropped and reconnected left the player in a room the server no longer had them
in — the page just sat there.

## Staged moves (Undo / End Turn)

**End Turn with nothing staged passes** - a unit turn is optional. That is a `pass_turn`
message (`_handle_pass_turn` server-side, mirrored in `LocalGameService`): same seat checks as a
move, turn number advances, board and move history untouched, broadcast as `turn_passed`.


Clicking a legal hex no longer sends anything. The move is held in `pendingMove` and shown via
`stagedBoard` (the board with the piece relocated), which is what `[boardState]` renders. **Undo**
drops it; **End Turn** sends the `make_move` that commits it — the server ends the turn on
receipt, so committing and ending the turn are the same message.

This is entirely client-side: no new server message and no change to `make_move` semantics
beyond the optional `attack` and `moveBonus` fields. **One unit per turn** is enforced by the
`movesLeftFor` check in `refreshTargets()`: once something is staged, no other unit is handed
legal targets. `canMove` (bound to `!hasAttacked`) is the separate rule that a swing ends the
unit's movement. With either in force the board still takes clicks, it just hands out no
targets. Selecting is always allowed — enemy units, or your own on the opponent's turn, are
inspect-only for the same reason.

Staging is a **stack** (`stagedActions`), oldest first, each entry holding the board as it looked
*after* that action. Undo pops one, so it walks back step by step and takes an attack back just
as cheaply - no inverse operation to get wrong. `stagedBoard` / `pendingMove` are getters over
the top of the stack.

Only the staged unit may act: with something staged, other units still select and inspect but
get no legal targets, or the staged origin and the unit on screen would drift apart.

A unit keeps its remaining steps: the top entry carries a running `used` count charged by
`computeMoveCosts` (the length of the walk, detours included - the straight-line distance
under-charges a unit that had to go round something, and the server would then reject the turn), the board
recomputes legal targets from what is left after every hop, and the Unit panel's MOV shows what
remains. Attacking is staged too - previewed with the same damage sums the server uses - and
ends the unit's movement for the turn (`canMove` goes false). End Turn sends the whole turn as
one `make_move {from, to, attack?}`.

End Turn deliberately leaves `stagedBoard` in place; the `move_made` handler clears it once the
confirmed board arrives. Clearing it at send time flashed the pre-move position for a frame,
which also dropped the selection sitting on the destination hex.

The selection is **sticky**: it follows a piece to its destination and survives the turn change,
so the Unit panel stays pinned until another unit is clicked or hovered. It only clears when the
selected hex ends up empty.

`stagedBoard` previews combat with the same sums the server uses (`strikeDamage` in
`hex-rules.ts`). The server's result is authoritative: `move_made` replaces the staged board
wholesale, so a divergence corrects itself on commit rather than persisting.

## Ability panels

Both side boxes render the same six slots. Each is live only on its own side's turn, via
`canUseAbilities('mine' | 'opponent')`. The opponent's box additionally requires
`isSinglePlayer`, so in multiplayer it is permanently disabled — you can see your opponent's
abilities but never press them. Ability effects are **client-side only**, so activation is
disabled in multiplayer entirely: nothing about them reaches the server, and a boost the
server never heard of would desync the board. The Unit panel carries one ability and the
passive, for whichever unit is selected.

- **Six slots**: four actives, then the passive (`isPassive()` — index 4) and the ultimate
  (`isUltimate()` — index 5) on their own bottom row. The passive is always on, never cast, no
  cost and no cooldown; the ultimate costs more and is once per game.
- **The passive is earned**: ★2 (`vetNeeded()`), read off the displayed unit's veterancy. The
  actives are not gated - `vetNeeded()` returns 0 for them, and `abilityHint()` leaves the
  requirement clause out entirely rather than printing an empty one.
- **Casting is click-then-target.** `selectAbility()` arms the slot rather than firing it; the
  next unit clicked on the board receives it. A friendly-target ability buffs, an enemy-target
  one damages, and clicking the wrong kind cancels. Points and cooldown are spent on landing,
  not on arming. An offensive cast **stages like a move** - it pushes onto `stagedActions`, so
  it shows through a staged step and Undo takes it back.
- **Rally (slot 7) is the owner's testing lever, not a balanced ability**: it costs **0** and
  hands out **300 points**, so any priced rule - a wrap crossing, a path, an ultimate - can be
  exercised without playing thirty turns to afford it. Leave it alone unless the owner asks;
  it was 2 points for 1 before, and that is what it goes back to when real numbers land.
- **Two currencies, split by which ability it is** (`isPathSlot()`, asked of `abilityPaths`
  rather than of the slot number, so moving a path's slots cannot quietly change what they
  cost):
  - **CP** buys the *special* abilities - the three paths and everything inside them: passive,
    skill, ultimate. `CP_PER_PHASE` (100, the owner's placeholder) is awarded **at the start of
    each of the five phases** - the opening, the three phases and overtime - so a match hands
    out 500 in all.
  - **Points** buy the eight-ability pool, and stay the board's currency besides: the wrap
    crossing charges them and coming home refunds them.
  - Everything goes through `purseFor()` / `chargeFor()` / `purseName()`, so a cost, a grant, a
    hint and an Undo all read the same currency off one place.
  - `cpOf(side)` is **derived** - `CP_PER_PHASE x phases so far, less `myCpSpent`` - rather
    than tallied, so a reload cannot collect a phase's award twice. Only what has been spent is
    persisted. Spend through `spendCp()`; a negative amount hands some back (Undo does).
  - **The Abilities panel head names whichever currency is in play**
    (`abilityPurseLabel()`): `CP: y` while a path or one of its abilities is open, `Points: x`
    otherwise - including with nothing open at all.
- **The two idle slots in each panel are readouts, not dead buttons.** They keep the blank's
  own greyed ground - the ordinary disabled look - and only the *text* is darkened (`.tally`,
  which also cancels `.blank`'s transparent text and its nbsp filler). They become real buttons
  the moment there is something to press.
  - **Unit panel**, nothing selected: `Total: x` (`liveUnits` - your units still on the
    battlefield, 24 on a fresh board) and `Opponent: y` (`opponentUnits` - theirs).
  - **Abilities panel**, nothing to do: `Points: x` on the left and `CP: y` on the right - the
    two currencies, each on the slot that would spend it. With an action available the left
    slot is that action (`Pick` / `Use`); with somewhere to go back to, the right is `Back`.
    Note that `Dash` and `Focus` and the rest of the *targeted* abilities never show `Use` at
    all - they are armed by clicking the ability and then a unit - which has been mistaken for
    a stuck button more than once.
  - **The Abilities panel HEAD says what the panel is asking for**: `Pick 2` / `Pick 1` /
    `Pick 0` with nothing open (picks, not abilities - `picksLeft()`), `Points: x` with a pool
    ability open, `CP: y` with a path or one of its abilities open (`abilityPurseLabel`).
  - Both rows are always drawn, so a panel never changes height as its contents change.
- **The pool is picked in PAIRS.** Taking one ability takes the one beside it, so four slots
  is **two picks**, not four. The pairing is the panel's own layout - `.panel-buttons` is two
  columns, so a row is a pair - which is all `partnerOf()` says (`index ^ 1`). `canPick()`
  needs room for both; `pickAbility()` adds both; `resetAbility()` gives both back, because
  half a pick would leave a slot nothing could fill.
  - **A line is drawn across the grid gap between the two** (`.pair-left::after`), so the
    pairing is visible before it is discovered.
  - **The detail says what comes with it**: "Also picks Mire." (`partnerAlsoPicked`), and only
    while it is still a choice - nothing is said about one already carried.
  - The swap button is **Reselect**, not `+`.
  - **Picking is open through the initialization** - see the opening's rules; only casting is
    not.
- **Effects are one-turn stat boosts** (`abilityEffects`, arbitrary placeholder numbers): +MOV,
  +ATK, +DEF. They live in `buffs`, keyed by hex, and expire in `beginTurnFor()` when the side
  that cast them comes round again. The Unit panel shows boosted-over-base (`statAtk` etc.), so
  a +4 on a base 26 reads `30/26`; **+MOV is real steps**, fed to the board as `unitBuffs` and
  into `movesLeft` once a step is staged.
- **Veterancy is drawn beside the name** in `unitPanelTitle` (`Pawn ★★★ - White`), the same
  placeholder rank the hex draws.
- **Boosts have to be declared on `make_move`.** Both engines re-derive the turn from where
  the unit started, off the unit's own stats, so a boosted move is rejected as illegal and a
  boosted strike lands base damage unless `endTurn()` says otherwise. It sends `moveBonus` (the
  extra steps) and `bonuses` (`{atk, def, targetAtk, targetDef}` - both units, because the
  counter reads the other side's numbers). `LocalGameService.move()` takes them, clamped;
  `strikeDamage(..., atkBonus, defBonus)` applies them **after** ring falloff, which is where
  the hex and the unit panel show them. The server ignores all of it: abilities do not exist
  server-side, so honouring the client's word for a stat is a free upgrade for anyone willing
  to edit a message. Abilities are therefore a solo feature until they live in the engine, and
  the client says so: **`buffsBind` gates every boost on the local engine being the authority**
  (`boardBuffs` feeds the board, `bonusFor()` feeds the sums). In a server game the numbers
  still show on the unit panel and change nothing - offering the extra reach there stages a
  walk the server rejects as illegal, and the extra damage forecasts a trade it contradicts.
- **Only a rejected move clears the staged turn** (`MOVE_ERROR_CODES`). A chat or invite error
  must not silently bin a turn the player has been building.
- ponytail ceiling: buffs are client-side and hex-keyed. A boost follows a *staged* move, not a
  unit the server moves for us, and a reload drops it.

## Unit identity

Every cell carries a **`uid`**, handed out in `build_initial_board()` (and mirrored by
`LocalGameService.buildBoard()`) as `<colour-initial><origin coord>`. `CellData` is an open dict
and `move()`, `to_dict()` and `from_dict()` all preserve it, so the id follows the unit for the
whole game.

Per-unit state hangs off that id, never off the hex:

- **Boosts** (`buffs` in the game room) are keyed by `uid`, so a boost survives a staged step,
  an Undo and the server's own confirmation with no re-keying anywhere.
- **Veterancy** is `placeholderVet(uid, unit_id)`. Keyed on the hex, as it first was, a unit's
  rank changed every time it walked - and rank gates its ability slots.

Anything per-unit added later (cooldowns, XP, statuses) belongs in the cell for the same reason.
Re-keying per-unit state on every move is a bug waiting for the one caller that forgets.

## The socket

`websocket.service.ts` owns the only socket. Rules it enforces, each one earned:

- **A socket being let go is detached first.** `abandon()` nulls its four handlers before
  closing. A close event fires asynchronously, so a socket left wired up runs its `onclose`
  *after* its replacement has opened - clearing the new handshake timeout, stopping the new
  heartbeat and reporting a live connection as down. `disconnect()` and `createSocket()` both
  route through it, and `disconnect()` reports the close itself since nothing else will.
- **A handshake in flight counts as connected.** `connect()` returns early for both `OPEN` and
  `CONNECTING` on the same room. Login, the lobby and the game room all ask for a connection;
  tearing the socket down on each ask is how a connection stays permanently three seconds from
  ready.
- **The send queue is capped** at `MAX_QUEUED` (32), oldest dropped first, and **heartbeats are
  never queued** - presence delivered late says nothing. Without the cap an outage builds a
  backlog of stale intentions that all land at once when the server returns.
- **`messages$` is a plain Subject**, not a BehaviorSubject: a replayed last message means a
  component entering a room re-handles whatever arrived before it existed.
- **Reconnecting does not end a solo game.** `reconnectToServer()` only clears the deliberate
  silence; the game carries on and the socket goes back to the lobby.

## Known quirks

- **Movement still cannot land on an occupied hex** — attacking is its own thing, carried by the
  optional `attack` field on `make_move` (see Combat). An "attack by moving onto an enemy" click
  does nothing; that path is gone for good.
- `server/game/tests_disabled/` is **not** disabled. Its 4 tests match Django's `test*.py`
  discovery pattern and run under a bare `manage.py test` (89 vs 85). They pass. Left as-is.
- `client/src/app/components/setup-config/setup-config.component.html` is still a raw JSON
  `<textarea>` with a "Configuration UI will be added here" placeholder.
- `abilities` exists in the schema and in `DEFAULT_CONFIG` as `{}`. The engine does not read
  it yet.
- **The roster is the six chess-piece placeholders plus two the owner asked for**: an
  **Archer** (`A`, bow-and-arrow glyph - value 8, hp 16, atk 15, def 7, range 3, move 6) and a
  **Shieldman** (`S`, shield glyph - value 9, hp 30, atk 8, def 18, range 1, move 5). Stats are
  invented on the existing scale; the owner said to make them up. They stand on the pawn row -
  **24 units a side, 48 on the board.** Rows, white's numbers (black is the point mirror
  `(q,r) -> (-q,-r)`, and every change is applied to both - a one-sided setup is never what is
  wanted):
  - row 1 `r=11`: pawn, archer, shieldman, **queen, king**, shieldman, archer, pawn - the pair
    in the middle behind a shield each, an archer outside that, a pawn on each wing tip.
  - row 2 `r=10`: pawn, rook, knight, bishop, bishop, knight, rook, pawn.
  - row 3 `r=9` : shieldman, pawn, archer, pawn, pawn, archer, pawn, shieldman.

  Nothing depends on any of them being chess pieces. **The line-up is the owner's to rearrange
  and has moved several times** - do not hardcode a hex for a unit in a test. `test_engine.py`
  looks the king up out of `config['setup']` for exactly this reason.
  - Their glyphs are the emoji with a **text-presentation selector** (`U+FE0E`), so they render
    monochrome and take the board's own `fill` - which is what tells white from black, exactly
    as the `♙`/`♟` pair does. Verified rendering monochrome in Chrome; the coloured plate behind
    them carries the side regardless.
  - **Do not assume a given hex holds a pawn.** `local-game.service.spec.ts` has had its stock
    unit moved twice by setup changes (`-9,9`, then `-7,9`); it now uses `-5,9`.
