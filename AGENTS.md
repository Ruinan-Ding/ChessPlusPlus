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
DJANGO_DEBUG=true python manage.py test               # everything
DJANGO_DEBUG=true python manage.py test game.testsuite  # engine + consumers + models (274 tests, 25 Sep 2026)
python scripts/make_scoring_parity.py                  # rewrite the scoring parity fixtures - rules changed on purpose, in BOTH engines, only

# Live network checks - real sockets against the server above, in a second shell
python scripts/e2e/match.py    # one full match: lobby, invite, room, moves, rejoin, resign
python scripts/e2e/edges.py    # races, second tab, token lifetime, disconnect after the result (~90s)
python scripts/e2e/endings.py  # two matches played out: to turn 50 on passes, and won on points (~1 min)

# Client (from client/)
ng serve                                              # serve on :4200
ng test

# CI (.github/workflows/tests.yml) runs both suites, the migrations check and the production
# build on every push and pull request.
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

The whole-number rules a config may leave out (`panelMoversPerTurn`, `postmatchEntries`,
`homecomingsPerSetupTurn`, `cpAtStart`, `cpPhaseOffset`) are listed once per side in `COUNTED_RULES`, filled in
at their defaults by both normalisers, and read through `ruleOf(config, key)` /
`rule_of(config, key)` - never as a module constant, because one server process plays every
room and each room may carry its own config. `postmatchEntries` was `phaseInitEntries` until
the phase's extra turn moved from its start to its end, and `cpPhaseOffset` replaced
`cpPerPhase` when CP became earned; neither old key is migrated. Neither
runtime validator rejects a rule key it does not know, so a room saved with an old name reads
the new one at its default and carries the stale key along unread. The schema itself does
say `additionalProperties: false` on `rules`, but nothing loads the schema at runtime. The overtime schedule (`OVERTIME_STAGES` in
`phases.ts` / `phases.py`) is still code, for that reason: it is read by functions that take
only a ply, and making it per-room means handing them the room's schedule.

**The scoring rules are mirrored too, and a test holds the two copies together.** The capture
zones, the phase bank, deaths, the endings, the CP award, the points the schedule pays and the
overtime conversion are written in `match-score.ts` / `hex-rules.ts` / `phases.ts` and again in
`scoring.py` / `phases.py`. Each side's own tests pin their own numbers, so a rule changed on one
side alone used to pass both. `server/scripts/make_scoring_parity.py` writes fixed cases (a fixed
seed) with the server's answers to `client/src/app/services/scoring-parity.json` - there because
the client's `rootDir` is `src` - and `test_scoring_parity.py` and `scoring-parity.spec.ts` assert
each engine against it. **Regenerate only when the rules changed on purpose, in both engines**:
the script writes the server's answers as the truth, and rerunning it to quiet a failing server
test is the one way to use it wrongly.

**3. Movement is a single `move` stat per unit** (an adjacent-hex step budget), not a pattern
list. `move_validator.get_legal_moves()` floods outward through the six hex neighbours, through
empty hexes only — a unit can never move through or onto an occupied hex, ally or enemy. No
direction/range/canJump DSL, and no white/black mirroring: flood fill is inherently symmetric.

**4. Reveal mode must never inspect config shape.** `_handle_request_reveal_mode` /
`_handle_reveal_response` treat the config as an opaque blob so that new config sections need
no transport-layer changes. Keep it that way.

**5. A handler handed a `gameId` off the wire calls `_require_seat` first.** Checking
`self.username == data['username']` proves who you are, not that the room you named is one of
yours. See *Room access and identity*.

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
  **Solo never commits on the clock** (`updateTurnClock`): there is no server to race and nobody
  waiting, and the turn's *end* is where overtime takes its toll - so a clock that ended the
  turn for you killed a king on its last HP while the player was still deciding how to save it.
  In solo the clock paces and beeps; ending the turn stays a click.
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
  - **Each side opens with its base squad; both reserves open empty.** The owner, 25 Sep
    2026: *"at the start of game, there will be units in base"*, by the numbers on the board
    (Show Hex), as white: rooks on 518 and 523, knights on 519 and 522, bishops on 520 and 521,
    shieldmen on 495 and 499, archers on 496 and 498, pawns on 497 and 471-475 - the base's
    bottom three rows, full - and *"the same to black side"*, the point mirror (19-24,
    43-47, 67-71).
    - **The config's `setup` places them.** A side's setup is one map of hexes, battlefield
      and panels alike, so the starting position reads the way the board is numbered: an
      entry on the battlefield is the board's (`build_initial_board` / `buildBoard`), one on a
      hex of **that side's own** panels is dealt there (`set_up_panels()` / `dealSetUpPanels()`,
      from `deal_panels()` / `buildReserves()`), with the board's uid shape,
      `{color[0]}{q},{r}`. No new config field: the schema already took any `q,r`.
    - **Both validators refuse** an entry in the other side's panels (every panel rule would
      count it as theirs) and a commander in any panel (he starts on the battlefield; under
      regicide one off it is a side that has lost). `validateGameRules` has no grid, so it
      reads a panel's side off the sign of the hex's pixel y, as `panelOf` does - `r` on an
      edge-up board, `q + 2r` on a vertex-up one; a test on each side pins the hex where the
      two readings part.
    - **The placeholder squads stay, as the tests' fixture.** `PANELS_DEALT` in
      `hex-rules.ts` and `engine/panels.py` deals them - one of each of the first five unit
      types on every third hex of all four panels (`dealt_panels()` / the rest of
      `buildReserves()`) - **instead of** the setup's panel entries, never beside them. 36
      server tests and 15 client specs of everything that *works* a panel - the walk, the
      wrap, the crossing, the blow into one, the walk home, and the windows and allowances
      over them - were written against those squads and keep them: `DealtPanels` (both server
      test modules) and `setPanelsDealt(true)` in the board spec. The live e2e scripts cannot
      reach into the process, so `scripts/e2e/panels.py` needs the server started with
      `CPP_DEAL_PANELS=1`; the other three run against the setup's squads, as a real game
      does. The flag goes on **both sides together** or the two halves of a networked game
      disagree about who is standing where.
  - **The red plane is the base, the green one the reserve.** **Every panel unit, base and
    reserve alike, gets its own MOV per turn and no more** - spendable a few steps at a time,
    never an endless shuffle (`panelMoved` in `game-board.component.ts`, keyed by uid).
    **No panel unit attacks**, base or reserve: they walk and nothing else. A **reserve unit
    still counters when it is hit** - *specified, not built*, because nothing can reach into a
    panel yet and the engines have no reserve to resolve a counter for. Only **three units of
    a panel may be moved in a turn** (`rules.panelMoversPerTurn`, `baseMovers` / `reserveMovers`
    - a set per panel, so one panel's walks are not counted against the other's cap).
    **Both panels carry the cap, all match**: three out of the base and three out of the
    reserve, never three between them. *The reserve used to carry it only through the
    initialization and shuffle freely after; the owner asked for the base's rule on both.*
    **The reserve's three becomes five on a numbered phase's postmatch turn**
    (`rules.postmatchEntries`), and the five stand instead of the three rather than beside them;
    the base keeps its three. Allowances reset each ply. Moving a panel unit is still not the turn's one board
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
  - **Both sides open on mirrored squads.** The setup's base squads are the point mirror of
    each other, as the placeholder deal's are (black's panels walked backwards): a side dealt
    a different shape would open with a different reach.
  - **Every label on the board counter-rotates** (`textTransform`), or it reads upside down on
    a board flipped for a black seat. That includes the wrap's `-x`, the base's `+x` and the
    mending `+1`; all three shipped without it and were upside down for whoever sat as black.
  - **The wrap's corridor is never dealt on** (`wrapCorridor()`). Each tip is a cul-de-sac with
    exactly one hex of its own panel leading in - every other neighbour is battlefield, which a
    panel unit may not cross - so a unit on either the tip or its doorway shuts the crossing
    for the whole panel: nothing reaches the base tip, or nothing lands past the reserve one.
    The dealt squad used to sit on both, so the wrap was closed from the first turn and a
    reload re-dealt the blockage as fast as it was shuffled away. **The setup deal does not
    check it** - it deals exactly what the config says. The owner's squads sit in the base's
    bottom three rows, clear of it (white's corridor is 283 and 307); a custom setup that puts
    a unit there shuts its own wrap until that unit walks off.
  - **The wrap is the only way out of the base.** A unit that reaches its base's outer tip may
    step across to the reserve tip facing it, and **the crossing costs 1 MOV**; whatever is left
    carries on into the reserve. On the shipped board white's pair is hex **283** `(-12,1)` and
    hex **306** `(11,1)` - far left and far right of the same row - and black's is the point
    mirror, `(12,-1)` and `(-11,-1)`. `wrapTips()` / `addWrap()` derive both from the radius, so
    neither number is hardcoded.
  - **The turn indicator names the stage** (`stageLabel` in the room, `stageAt()` in
    `phases.ts`): `YOUR TURN - PHASE 1 HALFTIME`. Thirteen stages - `Initialization`,
    `Phase 1`, `Phase 1 Halftime`, `Phase 1 Postmatch`, ... , `Overtime 1`, `Overtime 2`,
    `Overtime 3` - because **a phase that breaks in the middle is two stages**, **one that
    closes with a postmatch turn is three**, and overtime breaks twice more, each taking its
    own name, which is the same name `turnHeading()` counts down to. The result replaces the
    stage once the three phases have settled one - which can be as early as Phase 3's
    postmatch, turn 36, since that is when the third phase banks (see the scoring below).
    Overtime is both a stage and a verdict, so the stage covers it; a close match on turn 36
    is bound for overtime but still reads `PHASE 3 POSTMATCH`, the turn being played, until
    `OVERTIME 1` arrives on turn 37. *It
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
    - **Everything standing in a base mends 1 HP** (`BASE_HEAL_PER_TURN`), never past its
      `max_hp` - the squad dealt there at the start as much as a unit that walked home.
      **A reserve does not mend**: it is a staging area, not a hospital.
    - **In overtime, the commander of the side that just played loses HP** - 1, 3 or 5,
      depending which of overtime's three stretches the turn is in (`overtimeTollAt()` in
      `phases.ts`).

    Each swells - or shrinks, for the toll - and carries its `+1` / `-1`. They are **owed**
    where they are noticed (the mending as the new board is absorbed, the toll as the ply
    turns over) and **paid** in one beat of their own once the recap has played out;
    `runPlayback` awaits it before `playbackDone`. Marking them where they were noticed put
    them on screen underneath the recap, while the turn's blows were still being struck.

    **Every commit plays, empty or not.** `recapRunning` goes up on every End Turn - the
    amber `.committing-mine` / `.committing-theirs` wash - and the board is handed the recap
    even when it is `[]`. An empty list plays as `COMMIT_STEP` - a `kind: 'commit'` beat
    that holds `COMMIT_MS` and touches nothing - so a run has one path and not two; the room
    keeps that beat silent (`playEndTurnSound` has already sounded for it). Then the upkeep
    settles and `playbackDone` brings the curtain back down. It used to light only when there
    was something to replay, so a pass that mended or bled showed nothing at all. `replaying`
    keeps the scheduled recap and the ngOnChanges fallback apart: it goes up where a recap is
    *scheduled*, not where it starts, and a commit's state can arrive in that gap.

    **`game_over` does not lift the curtain over a recap that has not played.** A blow or a
    cast that WINS resolves synchronously inside `endTurn`, before the board has been handed
    the turn, so the handler dropping `recapRunning` played the match's last turn bare. It
    only lifts when `playbackRunning` is false - a resignation, a disconnect, an interrupted
    replay - and `playbackDone` covers the rest.

    **A cast writes what it moved over the unit** - `AnimStep.mark`, set from `hpChange()`
    and carried through `buildPlayback` so the recap replays the same number. It is the HP
    that actually moved, not the HP the ability offered. The beat carries `uid` as well:
    the recap plays against the board the turn ENDED on, so resolving the mark's owner from
    the hex put a cast's number on whoever had since walked onto it. `markKey()` falls back
    to the **hex** when nobody with that uid is standing: a cast that killed has no unit left
    to mark, and its number belongs over the ghost. Compare identity through `uidOf()` on
    both sides - a board dealt without uids identifies units by hex, and reading `piece.uid`
    raw there matches nothing, which sends every mark down the fallback.

    **A mark can be taken down early, and Undo is the only thing that does it.** `clearMarks()`
    on the board, from `undoMove()`: the HP goes back, so the `+20` over it has to go too.

    **The mark is drawn last of everything on the board, centred on the face.** SVG has no
    z-index. It used to sit above the plate at `cy - 18`, in the per-hex cells group - one
    pixel off the HP readout in the later "labels last" group, which is painted after it with
    a white halo of its own. Every `-1` the board ever owed was drawn correctly and buried
    under the number, which is why the owner never saw one. A spec pins the DOM order
    (`compareDocumentPosition` against `.stat-hp`); keep the mark at the end of that group.

    **Four colours, not two** - which side wears a mark matters as much as what it says, and
    a green `+1` over a unit that is not yours reads as your own until you have found the
    plate under it. `.heal-mark` is your mending (green), `.mark-theirs` theirs (blue),
    `.toll-mark` your king paying overtime (red) and both together theirs (purple). The
    swell `popUnit()` runs is tinted to match, a shade brighter so it carries as a glow.
    The CSS is ordered plain / theirs / toll / toll+theirs so the more particular selector
    is always the later one.
  - **Mending counts a side's OWN turns, not hand-overs** (`handOversBy()` in `phases.ts`,
    through the one `mendedSince()` both derivations call). A base mends at the end of its
    owner's turn, so a unit standing through a full turn takes one HP back, not the two a ply
    count gave it before. **A unit killed in a panel is never mended back** - both derivations
    drop it at 0 HP before any mending is added, so one hit on a unit with 1 HP left ends it
    and no later turn brings it back.
  - **One mending rule, two derivations, one panel.** A base holds two kinds of unit and both
    mend: `withdrawnUnits` covers the ones that walked home and `panelHp` the squad dealt there
    at the start. They share `mendedSince()` so they cannot drift. Before that only the walked-
    home half mended, so an identical wound closed itself on one unit and stayed open on the
    unit standing beside it - which reads as a bug because it is one. It also means **`panelHp`
    is keyed on the ply as well as the history**: nothing is recorded when a unit mends, so a
    turn passing is the whole of what changed, and a history-only cache would hold yesterday's
    number forever.
  - **The blow carries the panel it landed in** (`panel` on the `panel_attack` message and on
    the record; `BASE_PANELS` lives in `hex-rules.ts` so the room can read it too). The board
    is the only thing that knows which panel a hex is in, and it is gone by the time a reload
    re-derives the mending - so the panel travels with the blow the same way the unit does,
    for the same reason: no engine holds either. Without it `panelHp` cannot tell a base's
    wound (which mends) from a reserve's (which does not).
  - **Overtime's toll is real damage, and a commander on the toll or less dies of it** -
    `regicide`, the game over, the board left on screen. *It used to be a mark and a shake with no HP behind
    it; the owner asked for the death.* A king that the toll will kill **wears a waving skull
    beside its face** for the whole turn (`doomedKing()`, `overtimeTollAt()` in `phases.ts`): the
    toll is the *last* thing a turn does, so the king lives the turn out on its last HP and a
    heal - or the match ending first - still saves it. Both kings wear it, not only the side
    about to hand over. *The owner: "he wont die in this turn unless he takes damage from
    someone, but at the end of the turn commit he will get hit -1 and the game ends."* It
    waves rather than pulsing, and sits beside the face rather than over it, because the
    hovered trade's `.kill-forecast` skull owns the middle and both can be true at once.
    **Overtime costs HP and nothing else** - the points bleed that used to run beside it is
    gone. *The owner: "loses just HP, if i said points i misspoke."*
    - **Both engines take it.** `game_logic.overtime_toll` takes the same toll on a move, a
      pass and the clock's pass, which is what the schedule was ported to Python for - see
      the fourth-mirror warning at the top of `phases.py`. *This used to read "the browser
      engine's alone… a networked game takes no toll", and it was still saying so long after
      the server had started taking one.*
    - A **passed turn still pays it**, so the browser engine's `turn_passed` now carries a
      `boardState` and `applyTurnPassed` takes one when there is one. The networked server
      sends none and the board stands. Only a king *the toll itself felled* ends the game
      there - a pass has never looked at who is beaten and must not start.
  - **The wrap runs on a window** (`isWrapOpen()` in `phases.ts`): open on **a numbered
    phase's played first half and nothing else** - turns 4-8, 15-19 and 26-30. Not the
    opening, not a postmatch turn, and not overtime. See the window table in the
    schedule section for all three arrows. Shut means **no target and no price**:
    `addWrap()` returns at the top, so not even the struck-through `wrapDenied` figure is
    drawn, because a price is an offer and there is nothing on offer. What says so instead is
    a **red cross over the arrow** on the tip the crossing leaves from - each side's **base**
    tip, hexes **283** and **259**, which is the one the owner reads as pointing up (`wrapOut`
    on the cell, set by `wrapMarks()`; `.gateway-shut`). Struck out rather than removed: an
    arrow that vanished for five turns and came back would read as the board losing a feature.
    The rest of the panel walk is untouched - a base unit still shuffles inside its own base
    while the crossing is shut. **The same cross now marks the other two arrows** on their own
    windows, off `arrowShut()` rather than off the wrap's predicate - one arrow's cross drawn
    from another arrow's window is exactly the bug that shape prevents.
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
    **its own** base. Staged and undone like any other move.
    - **On a setup turn it is deployment, not the turn's board action** - the same seat, the
      same ply, the same clock, answered with a state update rather than `move_made`, exactly
      as a crossing is (`_commit_deployment`). That is the only reason three a turn is
      reachable at all: it used to commit the turn on the first walk, so the allowance was a
      cap nothing could ever meet, and the tests for it had to wind the ply back between walks
      to pretend otherwise. **Overtime keeps it as the turn's board action** - the toll is
      running and units still fight there, so a walk home is an ordinary move that happens to
      end off the board, and the turn's own move allowance is the only cap it needs.
    - **The room stages it as a deployment too, or none of the above is reachable.** Both
      engines accepting three is not enough: a walk home used to be staged as the turn's board
      action, so the first one set `pendingMove`, the board's staging lock (`movesLeftFor`)
      refused every other unit, and End Turn was the only way to commit it - one a turn,
      whatever the engines allowed. A setup turn's walk home now carries `homecoming: true` on
      the staged action, which keeps it out of `lastBoardAction` and so out of `pendingMove`,
      and `endTurn()` sends each as its own `make_move ... withdraw` **before** the turn's
      board action, beside the panel steps. Three walks home and the turn's own move is one
      turn and four messages, and the engines hand over on the last of them. Consequences that
      have to move together: `homecomingsSpent` counts the **staged** ones as well as the
      recorded (the record does not move while a turn is staged, so the cap would read 0 all
      the way to End Turn); `initBoardSpent` no longer counts a withdrawal (it once did, on
      the reasoning that a walk home ends the turn, which is what changed); the board's lock
      lets a unit that is not the staged one be offered **its doorways and nothing else**
      (`homeOnly` in `refreshTargets`, `canWalkHome()` in `drivable`), since anywhere else
      would be a second board move; and `movementArrows` reads each hop off the action before
      it only when they share an origin, because a turn can now stage several units.
      *Confirmed in a browser, 21 Sep 2026: three home plus a board move, four messages, one
      hand-over, the fourth walk refused.*
    - **It runs on a window, and only out of your own first three rows** - see the window
      table in the schedule section. Open on any setup turn (three units a turn) and through
      all of overtime (uncounted); shut through both halves of a numbered phase's play, and
      the three base arrows carry a red cross while it is. The mover must be standing in its
      own first three rows: `inHomeRows()` / `in_home_rows()`, asked of where the unit
      **stands**, not of the route to the doorway.
    - **The king never walks home** - the owner's rule, 17 Sep 2026. A commander belongs on
      the board, the way he is never dealt into a panel. Walked home, he was off the board,
      and under regicide a side with no commander on it has lost, so the walk lost the match
      (PUNCHLIST 6.13). All three refuse it: `addBaseEntry()` offers him no doorway,
      `homecoming_targets()` offers him nothing and the consumer says so by name, and the
      browser engine's `move()` will not let him leave.
    - **A unit walks home in range; it does not teleport in.** Out of MOV is out of reach -
      a scout far across the board cannot go home in one turn. This was briefly made free-from-anywhere and the owner
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
    - **A panel is in a fight in every room** (`entryBind`, the same gate crossings use). It
      used to be solo-only, because no server held a panel and the blow went out to a server
      with no answer for it. `_handle_panel_attack` answers it now, through
      `resolve_panel_attack` in `game_logic.py`, and it **derives three things the browser
      engine is handed**: the defender (from the panel occupancy), the panel it stands in, and
      whether that panel answers. A base never counter-attacks and a reserve does; in the
      browser engine that rule is a `counters` boolean off the wire, so a client could switch
      the counter off against its own blows.
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
  - **The way home is gated with the way out** (`entryBind`), and both are on in every room.
    `_handle_make_move` takes a `withdraw` and checks it with `homecoming_targets`: one of
    *your own* doorways, reached within MOV, then on into the base. The browser engine accepts
    any off-board hex whose q has the right sign and skips the walk entirely, which would let a
    unit land in the wrong panel or come home from anywhere.
    - The doorway is a **panel** hex, so "is anyone in it" is asked of the panel occupancy.
      Asked of `board_state` it can never be answered - the board holds no panel hex - which is
      the mistake the first version of this check made.
  - **A unit in a base mends an HP a turn** (`BASE_HEAL_PER_TURN`, the owner's placeholder -
    "1hp (for now at least)"). **Derived, not tallied**: each derivation reads the HP the unit
    was last left with off its own history record - the walk home, or the blow that hit it -
    and adds a point for every one of that side's own turns since, clamped to what it started
    with. The record is never rewritten, so a reload arrives at the same number. A reserve
    keeps its wounds.
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
  - **A counter is drawn only when one is actually thrown.** Three things refuse one: the
    defender died, it is standing in a **base** (which never answers), or the blow came from
    outside its own `attackRange` - an archer at three hexes takes nothing back from a
    swordsman. The staged action records `countered`, and all three readers go by it: the
    hover forecast (`refreshForecast`), the beat played as the blow is staged
    (`onPlayerAttack`), and the end-of-turn recap (`buildPlayback`). Each used to decide for
    itself and each got it wrong differently - the forecast drew a purple number over your own
    face for an answer that was never coming, and both animations swung a base unit back at
    you for nothing.
  - **A `+1` marks what mended.** Drawn over any unit whose HP went up as the turn ended,
    and only those - **a unit already at full earns none**, which is what a base of unhurt
    units looks like: no mark, no number moving, and nothing to tell the mending apart from
    a mending that is broken. Held by uid, so it follows a unit shuffled afterwards, and it
    clears itself after a couple of seconds. Owed from **two** places, since two derivations
    feed a base: `absorbWithdrawn()` for a unit that walked home, and `woundReserves()` for
    the squad dealt there - where `panelHp` arriving HIGHER than what is drawn IS the mend.
    - **Both halves may only owe it across a ply** (`mendingTurn`, set by `woundReserves()`
      and read by `absorbWithdrawn()`). HP going up *inside* a turn is a staged cast or an
      Undo, and neither is mending. `woundReserves()` always made that test;
      `absorbWithdrawn()` did not, and got away with it only while the withdrawn list could
      not change mid-turn. It can now - see below.
  - **Both derivations that feed a base must lay the staged turn on top.** `panelHp` always
    did; `withdrawnUnits` did not, so `absorbWithdrawn()` wrote the *committed* HP over the
    staged one on every rebuild, and a cast on a unit that walked home was invisible until
    the turn committed. That looks cosmetic and is not: the next cast in the same turn read
    the stale number off the board and staged from it, so **two mends in one turn were worth
    one**. `stageWithdrawn()` is the overlay, applied **outside** the cache - the cache is
    keyed on the history and the ply, and neither of those moves while a turn is being
    staged.
  - **A unit's HP lives in one of two places, and both have to be SENT.** No engine holds an
    ability, so a cast that moves HP is only the client's word until the engine is told. A
    panel unit's HP lives in the move history (`{unit, hp, panel}`, written as a
    `panelEffect` record); a board unit's lives on the board (`{at, uid, hp}`). Only the
    panel half was ever sent at first: a mend on a battlefield unit lived on the room's
    `stagedBoard` alone and the next state update rolled it off - which is why *healing a
    king off 1 HP still lost it to overtime on the same commit*.
  - **A turn's casts ride inside the one message that ends it** - `pass_turn`, `make_move`
    or `panel_attack` - split around the turn's board action: `effectsBefore` for casts
    staged before it, `effects` for casts staged after (`endTurn` splits at the last staged
    entry that is not a cast). The browser engine's `landEffects` lands the first list on a
    *copy* of the board, measures the move against that copy, lands the second list after
    the move resolves, then takes the overtime toll - and emits the panel records on either
    side of the move's own (`applyMoveMade` / `applyTurnPassed` splice them in). They used
    to be separate `panel_effect` / `unit_effect` messages sent ahead, which broke twice:
    a cast carries the HP worked out for the turn *so far, blow included*, so one made
    after the blow was struck over again (a mend after a counter vanished; a panel unit
    struck and then finished by a spell rose again on reload, because the blow's record was
    the last word); and **a move the engine refused came back half-played**, the casts
    already kept. Now a refusal keeps none of it. Board casts carry the **uid** as well as
    the hex, so a stale hex still finds its unit. A cast that empties a commander ends the
    match, like a blow, but **only when a cast actually emptied one** - a heal that ends a
    match it had no part in is worse than no check. This is the same line `pass()` draws for
    the toll.

    **Both message types must be in `LOCAL_GAME_TYPES`** (`websocket.service.ts`) and neither
    was. A solo game keeps its socket when a server is reachable, and only listed types are
    answered by the browser engine - so both were posted to a server that has never heard of
    them and dropped with "Unknown message type". Offline play was the only place either one
    ever worked.
  - **A refused turn takes its crossings with it** (`discardCrossings()`, called from the room's
    `invalid_move`). They reach the engine *ahead* of the move and it keeps them, so a move it
    then rejects left them committed there and still drawn from the board's own `entered`
    overlay - and the next End Turn sent every one again, onto a hex that now held the unit
    that entered it. The engine answered "Nothing may enter there" and cleared the freshly
    staged turn a second time. What they spent is not handed back: the walk happened.
  - *Known ceiling:* crossings are sent before the turn's move, so a crossing that lands on the
    **path** the staged move takes (only its landing hex is checked against `committedBoard`)
    makes that move illegal on arrival. The engine rejects it, which clears the staged turn -
    recoverable, since `submittedTurn` is reset on a move error and the turn can be played
    again, but the walk is lost with no explanation.
  - **Which turns and phases close the way home is undecided.** The owner has said there will
    be some. Until they are named it is open whenever a unit can reach it, and the gate
    belongs in `addBaseEntry` beside `entryBind`. Do not invent the schedule.
  - **The gap opens in every room** (`entryBind`). The server has a reserve model now,
    `server/game/engine/panels.py`, and answers `enter_board` itself - a crossing is
    deployment, not the turn's board action, so it hands nothing over and answers with a full
    `game_state_update` the way the browser engine does.
    - **The panels are derived, not stored.** The deal is deterministic from the radius and
      the config, the geometry is arithmetic, and everything since is in `move_history`, which
      the server already keeps. `panel_occupancy()` composes them. There is no panel table and
      no migration, and nothing about a panel unit is taken off the wire - send a thousand-HP
      queen claiming to be `rbr4` and the archer that is really there lands.
    - **The trade that was made, and was warned against.** This section used to say that
      lifting the gate meant the owner's real roster first, because dealing the placeholder
      squad server-side "would freeze a placeholder into the protocol". The panels went live
      without waiting. What that actually froze is narrower than it sounds - **the deal itself
      never crosses the wire**; both sides derive it - but two things did harden: the deal is
      now a rule mirrored in two places (`buildReserves` and `deal_panels`, which must change
      together), and the uid scheme `r{panel}{i}` is now written into stored networked
      histories as well as solo ones, so a roster that re-orders the deal would re-point old
      uids at different units. Rooms are short-lived, so that bites a game in progress across
      a change and nothing older.
    - **Mending is applied server-side too**, via `panel_hp(history, ply)` and
      `withdrawn_units(history, ply)`, mirroring `mendedSince`. It only needs ply parity
      (`hand_overs_by`), not the phase schedule. Without it the client previewed a blow from
      the mended HP while the server struck from the recorded one, and the unit dropped further
      than the player was shown - which is why it could not wait for stage 3.
    - **The toll is not behind this gate** - `tollBind` is, and stays solo until the server
      takes it.
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
  never disagree. **The server has them too** (`capture_zone_hexes()` / `capture_claims()` in
  `engine/scoring.py`, ported onto `board.py`'s own geometry), because it banks each phase's score and ends the
  match on it - see the scoring below. Its `_js_round` is `Math.round`, not Python's `round`,
  which rounds a half to even.
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
  costs you its config `value` (a pawn is 5) - **except one killed in a base** (a red panel,
  `BASE_PANELS`), which costs nothing; one killed in a reserve (green) costs as on the board.
  *The owner, 24 Sep 2026: "killing things in base (red panel) should not count towards
  victory points ... in green panel it ... counts towards victory points".* `deathsOf()` /
  `deaths_of()` skip a blow into a base (`intoPanel` with a base `panel`); a base never strikes
  back, so that blow only ever kills the unit standing in it.
  - **A phase's total never goes below 0** (`phaseTotal()` in `match-score.ts`, `phase_total()`
    in `engine/scoring.py`): deaths can wipe out what a side holds but not push it under, so
    `4 - 18` reads `= 0` and banks 0. *The owner, 24 Sep 2026: "the total points racked
    shouldnt go negative by death. max is 0".* The bank and the header's live figure both go
    through it, so the two cannot disagree about the floor; the header's own numbers are
    `standings()` / `phaseScore(side)` in `game-room.component.ts`.
  - **A phase's total is multiplied by its number** - x1 in Phase 1, **x2 in Phase 2, x3 in
    Phase 3** - in the same `phaseTotal()`, after the floor (4 - 18 in Phase 3 is 0, not -42).
    *The owner, 24 Sep 2026: "the total victory points for each phase is multiplied by 2 on
    phase 2, multipled by 3 on phase 3".* The bank holds the multiplied figure, so the match
    total, the margins and the CP award all read it. The header shows the sum it made:
    `(🚩 5 - 💀 0) x2 = 10` in Phases 2 and 3 (`Standing.multiplier`, off `Phase.multiplier`
    in `PHASES`), the plain `🚩 5 - 💀 0 = 5` in Phase 1 - and on a postmatch, which scores
    nothing to multiply. The margins went up the same day, to 10 and 5 (below).
  - **The initialization banks no VP; each of the three phases does.** The opening is not in
    `SCORING_PHASES`, so it reads a flat 0 and contributes nothing to the match total, and
    nothing is banked when it ends. Confirmed by the owner - do not "fix" the opening into a
    scoring phase.
- **A full turn is white's hand-over and black's together.** The engine counts a turn per
  hand-over (`turnNumber` goes up on every one, and white plays the odd numbers), but every
  rule below is written in **full turns** - so turn 50 is hand-overs 99 and 100.
  `services/phases.ts` is the one place the two meet: `turnOf(ply)` converts, and every
  function it exports takes the engine's count and converts for you. Do not scatter the
  conversion at call sites, and do not change what the engine counts - the server mirrors it.
- **The match runs in five phases**, on a fixed turn schedule (`services/phases.ts`):

  | phase | turns | |
  |---|---|---|
  | Initialization | 1-3 | the opening |
  | Phase 1 | 4-13 / 14 | halftime after turn 8; turn 14 is its **postmatch turn** |
  | Phase 2 | 15-24 / 25 | halftime after turn 19; postmatch turn 25 |
  | Phase 3 | 26-35 / 36 | halftime after turn 30; postmatch turn 36 |
  | Overtime 1 | 37-44 | first hand-over is 73 (`OVERTIME_FIRST_PLY`); toll **-1**, **1** board move, no points |
  | Overtime 2 | 45-49 | toll **-3**, **2** board moves, no points |
  | Overtime 3 | 50 | the last turn; toll **-5**, **3** board moves, no points, and anything still standing is black's |

  A halftime splits a ten-turn phase evenly. These are full turns, so the opening is six
  hand-overs and each phase is twenty-two.

  **Each numbered phase closes with a postmatch turn of its own, and its ten turns do not
  count it.** Carried as `postmatch: true` on the phase rather than as a phase of its own
  (`phaseSpan()` adds the one turn): a separate entry would have to be excluded from
  `SCORING_PHASES` and from every "which phase am I in" answer, and turn 14 *is* part of
  Phase 1 - `phaseIndexAt()` answers 1 for it. A ply is the postmatch when its phase has the
  flag and it falls on the turn after the ten, `phaseStartTurn(index) + turns`
  (`isPostmatch()` / `is_postmatch()`). Play starts on the phase's first turn, so the
  halftime splits the ten from there and the postmatch, coming after both halves, reads as
  past the halftime; `isWrapOpen()` still refuses it by name, for clarity. Two predicates come
  off the schedule and must not be confused - `isInitialization()` is **the opening alone**,
  because the opening's one-move-per-phase lock hangs off it and handing that to a single
  turn would stop a unit that moved in an unrelated earlier turn; `isSetupTurn()` is the
  opening plus each phase's postmatch turn, and covers only what the two genuinely share.
  - *The extra turn used to open the phase, as `Phase N Initialization` (`init: true`,
    `isPhaseInitialization()`, `playStartTurn()`).* That put four setup turns in a row at the
    start of the match - the opening's three and then Phase 1's own - and the owner moved it
    to the end of each phase and renamed it, 23 Sep 2026: *"make it phase x postmatch, and
    move the inization part to the end of the phase. that way you dont have 3 inization turns
    then start right away at phase 1 initialization"*. It is the same turn with the same
    allowances, only moved. Every phase still spans eleven turns, so which phase a ply
    belongs to and overtime's start at turn 37 did not move with it. The CP did, a day later -
    it is now earned at the start of each postmatch (see the currencies below).

  **The history header counts down to the next change**, in full turns:
  `Turn 1 - 2 Until Phase 1`. A change lands at the *end* of the turn it is counted to, so
  the turn it lands on has already moved on to the next one - turn 3 is the last of the
  opening and reads `Turn 3 - 5 Until Phase 1 Halftime`. A postmatch is two changes, into it
  at the end of the phase's tenth turn and out of it into the next phase one turn later: turn
  12 reads `1 Until Phase 1 Postmatch`, turn 13 `1 Until Phase 2`, and turn 14, the postmatch
  itself, `5 Until Phase 2 Halftime`. Past the last change it says where you are, in the
  **stage's** name rather than the phase's: `Turn 50 - Overtime 3`.

- **Three arrows a side, three windows, and no turn opens all three.** Every one is read off
  the ply alone, so both engines and the board answer from the same predicate in `phases.ts`
  (mirrored in `engine/phases.py`), and the board draws a **red cross** over any arrow that is
  shut (`arrowKind` on the cell, `arrowShut()`, `.gateway-shut`):

  | | predicate | open on |
  |---|---|---|
  | the wrap, out of a base | `isWrapOpen()` | a numbered phase's **played first half**: 4-8, 15-19, 26-30 |
  | the three ways in, out of a reserve | `isEntryOpen()` | any setup turn, and each phase's **halftime half**: 1-3, 9-14, 20-25, 31-36 |
  | the three ways home, into a base | `isHomecomingOpen()` | any setup turn, and **all of overtime**: 1-3, 14, 25, 36 onward |

  The wrap and the way in are near enough complements: a side spends a phase's first half
  sending units out around the outside and its second half bringing them back in. With the
  postmatch at the end, the way in runs unbroken from a phase's halftime through its
  postmatch, and the next phase's wrap opens on the very next turn. *The wrap
  used to be `beforeHalftime()` alone, which said yes for every phase with no break to fall
  either side of - quietly including the opening and the whole of overtime. It is now spelled
  out as three conditions: the scoring phase and the halftime each refuse turns the other does
  not, and the postmatch clause, redundant since the postmatch moved past the halftime, is kept
  so the rule reads the way the owner said it.*

- **A crossing lands in its own first three rows, and a walk home starts in them**
  (`inHomeRows()` in `hex-rules.ts`, `in_home_rows()` in `engine/panels.py`; `HOME_ROWS = 3`).
  The ground a side deploys onto now bounds both ends of a unit's journey off the board: a
  unit coming out of a reserve may not stop past row 9 (white; the mirror for black), and a
  unit that has pushed up the board walks back down into its own ground before it can walk
  off it. A limit on where a walk **stops**, not on where it goes - the flood still routes
  through a fourth row, the same way it steps over a friend it cannot stop on. The board's
  `homeOf` tint reads the same helper, so the coloured ground and the rule cannot drift.

  *Consequence worth knowing: at the deal those rows are where a side's army already stands,
  so the opening offers white exactly one legal crossing - '1,9', six steps off. Reserves
  backfill ground the line has vacated; they do not pour onto an empty board.*

- **A phase's postmatch turn has its own allowances.** One full turn, both sides, and on it:
  **no ability fires and nobody attacks** (`isSetupTurn()`, shared with the opening -
  `noAttackMessage()` says which of the two refused, `Nobody attacks in the postmatch` or
  `Nobody attacks in the opening`, since "the opening" on turn 14 points at a phase that
  ended a whole phase ago); **five units may be started out of the reserve** rather than the
  usual three (`rules.postmatchEntries`, and it stands *instead of* the per-panel three,
  covering walks inside the reserve as well as crossings out of it - capping the walk at three
  would leave two of the five unable to reach a gateway); and **three units may walk home**
  (`rules.homecomingsPerSetupTurn`, counted by `homecomingsAt()` / `homecomings_at()`). The base
  keeps its three: nothing in the rule was about the base, and the wrap is shut on that turn
  anyway. **Overtime is the exception to the count** - it is not a setup turn, the toll is
  running and units still fight, so a walk home there is an ordinary move that happens to end
  off the board and the turn's own move allowance is the only cap it needs.
  - **All three enforce each of these, the board included.** The board kept its own copy of
    the mover rule (`panelCanMove`, its own `reserveMovers` set) and its own copy of the
    no-attack rule, and neither heard about the phase's extra setup turn (then an
    initialization at the phase's start, now its postmatch) - so the fourth and fifth
    crossings were refused by the only thing a player can click, and a strike was *offered* on
    a turn both engines then refused it on, stalling a networked turn on the error banner. A
    rule applied in one place and not its twin is this repo's oldest bug shape; when one of
    these numbers moves, grep for every copy.
- **The initialization runs on its own rules.** Through the opening three turns:
  - **Nobody attacks at all** - not on the battlefield either. No targets are offered and no
    strike layer is drawn (`isInitialization()` in `services/phases.ts`, read by
    `refreshTargets` and `refreshPreview`).
  - **No ability is CAST** - not a pool ability, not a path's skill or ultimate, not a unit's
    own - **but choosing is exactly what the opening is for.** Two gates, and the split
    matters: `canChooseAbilities()` (take a pair up, take a path, hand a pair back through
    Reselect) is open through every setup turn; `canUseAbilities()` is that plus
    "not `isSetupTurn()`", and everything that spends an ability runs through it. So a
    numbered phase's postmatch turn shuts casting for the same reason the opening does.
    The panels say which rule closed them, and name the turn (`abilityBlockedNote`: on turn
    14, `Unavailable: no abilities during the phase 1 postmatch.`). The
    offline engine refuses one too (`abilityFault()`): it need not know what a cast is
    *worth* to know none should have arrived, which is the one ability rule it can keep with
    the abilities still unsettled.
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
  - **A board unit gets one of the two, a move or a walk home, never both.** The owner, 25 Sep
    2026: *"in the 3 turns, each unit on the board may only move once. so they can either move
    it or send it home."* That is the lock above, checked before the walk home is offered (the
    board) or taken (`opening_moved_hexes`, before the walk-home branch on the server).
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
  - **So does a postmatch's running score**, for a different reason: it scores nothing, like
    the opening, but it sits *inside* the phase it closes (`phaseIndexAt()` puts turn 14 in
    Phase 1), and that phase has already banked by then - see below. Left live, its cap and
    deaths would be the running phase and the phase just banked would be counted twice in
    `z`. `standings()` reads both as 0 on a postmatch turn, so Phase 1's postmatch reads
    `🚩 0 - 💀 0 = 0 (+ 7 = 7)` in the owner's example.
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
  - **Banked by the engines, not the room** (`bankEndedPhases()` in `match-score.ts`, mirrored
    by `bank_ended_phases()` in `engine/scoring.py`). The server keeps the bank on its state
    row (`GameState.phase_bank`, migration 0008) and the browser engine on its saved game; every
    hand-over carries it (`phaseBank` on `move_made`, `turn_passed`, `game_state_update` and
    `game_started`), and the room shows the snapshot's (`GameSnapshot.phaseBank`) rather than
    keeping one. A phase's cap is the board as it stood when its play ended, and no board but
    the current one is stored - so it is read on the **hand-over into the phase's own
    postmatch**, the one moment the board still shows how the play finished. Not a hand-over
    later: the postmatch rearranges units - entries out of the reserve, walks home - and none of
    that may count towards the phase it closes. So a scoring phase is over, and banks, once
    `phase < now || (phase === now && isPostmatch(ply))` (`phaseOver()` / `phase_over()`),
    and a phase banked is never read again. The third phase therefore banks at the start of
    Phase 3's postmatch (turn 36), and `matchVerdict` is readable from there.
    - *It used to be the room's*, banked by whichever client happened to be watching as a
      phase ended and persisted in the solo UI state only - so a networked reload or a late
      join banked late, off a board the postmatch had already reshuffled, and nothing could end
      a match on a score only the browser knew. Moved to the engines on 24 Sep 2026, when the
      owner asked for the match to end on turn 50 (6.25).
    - **A phase banked after its moment is marked `late`** (`phaseOver(phase, ply - 1)` already
      true on the hand-over that banks it). A room already past a phase's postmatch when the
      bank arrived - mid-game at the deploy, a solo game saved before it, or a position built by
      hand - banks the phase at its next hand-over, off whatever board that leaves. It is shown,
      but **a bank with a late phase in it decides nothing on points** (`decidedOnPoints()` /
      `decided_on_points()`), so neither the engines nor the header end a match on it; it plays
      on to the turn-50 rule. The old room's saved banks are not carried over for the same
      reason: the late mark keeps the result honest without them.
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
- **Nothing on the room screen is ever hidden to make room.** The owner, 25 Sep 2026: *"DO
  NOT HIDE ANYTHING AS IT MAKES THIS GAME UNPLAYABLE"*. The room is laid out at no less than
  `ROOM_MIN_WIDTH` x `ROOM_MIN_HEIGHT` (1480 x 1120), and a smaller window scales the whole of
  it down (`fitRoom()`, CSS `zoom` on `.game-room-container`): a smaller window gets a smaller
  room, never a shorter one. What it replaced, all measured:
  - the Unit panel was `flex: 1 1 0` and free to shrink, and in any window shorter than the
    left column the two ability panels above it crushed it to its border - 2px at 1400x800,
    and on the owner's own 1904x946 window everything below HP/ATK was gone;
  - the header pushed its buttons and the connection status off the right edge below about
    1470px;
  - under 900px the columns stacked, with the board below the bottom of the window.
  - **The two numbers are measured, not chosen**: 1480 is the header on one line with the
    banner at full size, 1120 the left column at its full 260px (1011px) under the header,
    with a hint line to spare. Past them, the header wraps (`flex-wrap`) and the column
    scrolls - `.stats-panel` is `flex: 1 0 auto`, never less than its contents.
  - **No `vw` inside the room.** While it is scaled the room is laid out bigger than the
    window, so a size read off the window is wrong for it: the columns are shares of the room
    (`clamp(190px, 18%, 260px)`, `clamp(230px, 22%, 320px)`), the banner a flat `2rem`.
  - **No narrow-window layout.** The `max-width: 900px` stacking is gone. Do not bring back a
    breakpoint that rearranges or collapses a panel.
  - Checked in headless Chrome at 1904x946 (drawn at 85%), 1100x650, 880x600 and 700x500:
    nothing off screen, the left column unscrolled, the Unit panel whole. Chrome fires no
    `resize` in a hidden tab, so a test driven through a background tab sees the old zoom -
    drive the size with `Emulation.setDeviceMetricsOverride` instead.
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
- **The third phase ending settles the match, or sends it to overtime** (`decidedOnPoints()` /
  `decided_on_points()`, shown by `matchVerdict`). White must finish **more than 10** clear to
  take it outright; black only **more than 5** (`OVERTIME_MARGIN`, in `match-score.ts` and
  `scoring.py`, keyed by the side behind) - black is allowed the wider gap because white moves
  first. Anything closer than that is overtime. *The owner, 24 Sep 2026: "10 ahead for white
  and 5 ahead for black to trigger overtime"* - it was 5 and 3, before the phases were
  multiplied. The third phase banks on the hand-over into its postmatch (turn 36,
  ply 71), so the result is known - and the header names it - from there. **But the postmatch
  is still played**, and both engines end the match as it ends, on the hand-over into turn 37
  (`OVERTIME_FIRST_PLY`, ply 73; `endReason: 'points'`). *The owner, 24 Sep 2026: "phase 3
  post match still happens even if overtime isnt triggered."* Until then a points match ended
  as the postmatch began, and its CP award never came.
  - **Never on a late phase** (see the bank above). The first version checked every hand-over
    and the first test that wound a game straight to overtime ended it on points off the dealt
    board; the second only asked on the hand-over into Phase 3's postmatch, which still let a
    late Phase 1 or 2 decide it, and let the header name a winner the engine would never
    declare. The late mark answers both, and `matchVerdict` and `scheduleEnding` now read the
    one `decidedOnPoints`, so the header and the ending cannot disagree.
  - **Overtime runs in three stretches and the toll climbs through them** (`OVERTIME_STAGES`
    in `phases.ts`, mirrored in `phases.py`): turns **37-44 take -1**, **45-49 take -3**, and
    the **last turn, 50, takes -5** - 28 off a king who sits through all of it, of the 45 he
    starts with. A match with both kings still standing at the end of it **goes to black** -
    the same verdict `matchVerdict` already gave, now with an escalation behind it that makes
    reaching it unlikely. *The owner: "overtime is broken into 3 parts, overtime 1 takes -1
    damage. on turn 45 it turns to overtime 2 ... and if both survives, black wins."* Raised
    from -2 and -3 on 24 Sep 2026: *"the 3 and 5 is DAMAGE TAKEN TO KING."*
    - **Counted forward from overtime's first turn, not written down.** `OVERTIME_FIRST_TURN`
      and `OVERTIME_LAST_TURN` are both read off the schedule, so a phase that moves carries
      all of overtime with it. `OVERTIME_LAST_TURN` used to be the literal `50` declared in
      `game-room.component.ts`, and when each numbered phase gained its extra turn - then an
      initialization at the phase's start, now the postmatch at its end - moving overtime's
      start from 34 to 37, the literal stayed where it was and silently cost overtime three of
      its fourteen turns. Nothing failed. Moving that turn to the end of each phase moved
      nothing in overtime: every phase still spans eleven turns.
    - **`overtimeTollAt()` answering `0` is the schedule gate as well as the amount.** Neither
      engine keeps a `ply < OVERTIME_FIRST_PLY` test of its own beside it: one question with
      one answer beats two that can come to disagree.
    - **The skull sums the turns, it does not multiply one of them** (`overtimeTollOver()`).
      With a climbing toll, "will he live through the next two" is no longer `toll * 2` - a
      king on 3 HP is two turns clear in the first stretch, on his last in the second, and
      already gone in the third. It reads **his** next toll, not the mover's: white pays at
      the end of an odd hand-over and black at the end of an even one, so the side not to
      move pays one ply later and can be a stretch further along.
    - **Overtime widens the turn itself: two board moves in Overtime 2, three in
      Overtime 3** (`boardMovesPerTurn()`, off `OVERTIME_STAGES`). *The owner: "on overtime 2,
      you can move two units each turn on the main board. on overtime 3, you can move 3."*
      **Each is a whole board action - a walk and, if it ends in reach, a swing** - so a
      stretch that allows three allows three blows. The owner's call when asked.
      - **This is the one rule that changes what a turn *is*,** so everything built on "there
        is exactly one board move" had to be asked rather than assumed. Four places assumed it:
        the board's lock (`movesLeftFor` alone meant "nothing else may be driven"), the room's
        commit (one `make_move` built from `pendingMove`), `hasAttacked` (one blow a *turn*,
        now one a *unit* - `canSwingFrom()`), and `onPlayerAttack`, which chained a blow onto
        whatever moved last: a side that walked A and swung with B wrote B's blow onto A's
        origin and lost A's move.
      - **The moves go out as separate messages and only the last hands the turn over** - the
        first carry `more: true` and both engines answer them through the deployment path
        (`_commit_deployment`): same seat, same ply, same clock. The toll is deliberately not
        taken on a held move; once per move would bleed a king three points on the very
        stretch that allows three. Panel deployments still go first, then held moves, then the
        one that ends the turn.
      - **`more` is a claim, not a permission.** The server counts the ply's board moves off
        the record (`board_moves_at`) and refuses any past the allowance, and a `more` on the
        last one the allowance permits ends the turn anyway. A panel's move is not a board
        move; a walk home is one in overtime and a deployment while setting out.
      - **The allowance counts moves; the rule counts *units*.** A unit gets one of the
        turn's moves, not two (`boardMoveLandings()` / `board_move_landings`, and
        `movedUnitHexes` -> the board's `movedHexes`). Without it a side in Overtime 3 played
        A, then B, then A again: each message is legal on its own, judged from where the unit
        stands with a full MOV, so both engines took it and A covered **twice its budget in
        one turn**. A unit continuing a walk it began is not this - the room folds those into
        one move and sends the origin it really set out from, so a `from` matching an earlier
        landing is always a second go. *Found by driving the screen on 22 Sep 2026 with 357
        specs green; see PUNCHLIST 3.15.*
      - **Moving another unit ends the first one's move, hexes left or not** - the owner, 25
        Sep 2026: *"when another unit is selected and moved, it would be considered the end of
        turn for the first moved unit."* So a unit never comes back for what it left unwalked.
        Their reason: switching back and forth would make the turn's yellow replay hard to
        follow. Do not loosen it to "any unit, within its MOV in total".
      - **The board's lock keeps a floor** (`movesToSpare`): never fewer than the one
        `movesLeftFor` proves. The count and the lock are two answers to one question, and an
        unbound `boardMovesSpent` of 0 would read as "nothing staged" and unlock the whole
        board behind a turn already spoken for.
    - **Overtime is three stages, not one** (`stageAt()`), so the header reads `OVERTIME 1`,
      `OVERTIME 2`, `OVERTIME 3`, and `MILESTONES` counts down to each - including the one
      *into* overtime, which turn 35 counts down to as `1 Until Overtime 1` (the change lands
      at the end of turn 36, Phase 3's postmatch). The stretches are named
      and the phase they sit in is not: `phaseAt()` still answers `Overtime` for all fourteen
      turns, the same split a numbered phase already has from its halftime. A countdown to a
      bare `Overtime` would name something `stageAt()` never says.
  - **Overtime scores nothing and costs no points.** It is a decider, and what it takes is a
    king's HP - see the toll. A per-turn points bleed (`overtimeTicks`) used to run beside it
    and was removed at the owner's word: *"loses just HP, if i said points i misspoke."*
  - **The toll is shown on the board as well as in the header**: the king of whoever just paid
    takes a red **`-1`, `-3` or `-5`** over its icon - the stretch's own number - and a hit pop
    (`markOvertimeToll()` in
    `game-board.component.ts`, derived from the turn that ended - white plays the odd
    hand-overs, so which side paid is arithmetic and needs no input from the room). The HP
    behind it is real - see the toll above - so this is the mark over damage that has already
    landed, not a shake standing in for it.
    - Gated on `tollBind`, like the toll it draws - which **both** engines now take, so the
      mark is over HP that really moved in a networked room too.
    - The mark shares one map with the base's mending `+1` (`turnMarks` / `markOf()`): same
      mark, four colours, one fade timer (`MARK_FADE_MS`, on `PLAYBACK_SPEED` like every
      other beat).
    - **A king the toll kills still wears his last mark**, on the hex he died on. By the time
      `markOvertimeToll()` runs the board has been rebuilt without him, so `kingHex` — written
      on every `buildCells()` — is the only record of where he stood. Same shape as a cast
      that kills (`markKey`). The side is carried in `markColors` because an empty hex belongs
      to nobody.
    - **Whose a mark is turns on whether it has an owner, not on which map wins.** In
      `settleUpkeep`, a uid that resolves to a standing unit reads its colour off that unit;
      only a hex-keyed mark falls back to `markColors`. Both orders are wrong on their own and
      I shipped each in turn: occupant-first drew a dead king's toll in the enemy's purple as
      soon as anything stepped onto his hex, and `markColors`-first broke the commoner case,
      because `showMark` keys a *killing cast's* number to the hex too — so a hex that carried
      a kill earlier in the turn tinted the next unit's own `+1` in the victim's colour.
    - **Only the toll's own kill, and the ply is the test that proves it.** `kingHex` records
      the hex, the HP *and* the ply he was last seen on; the mark is owed only when the HP was
      down to the **stretch's own toll** (`overtimeTollAt(ended)`, which is 1, 3 or 5) **and**
      that ply is the one that just ended. The toll takes him
      during the commit of that ply, so his last sighting is always that ply; a king cut down
      by a blow vanished earlier and is stamped with it. HP alone cannot separate them — a
      king already down to the toll or less when a blow finishes him passes the HP test as
      the toll's victim does. Without either guard any *missing* commander was marked, on top
      of the recap's real kill number, and under `objective: 'elimination'` the `-1` came back
      every overtime ply.
    - **Battlefield only, on both sides of it.** `markOvertimeToll` skips panel cells when it
      looks for the standing king, and `kingHex` records only battlefield hexes. A commander
      never stands in a panel - never dealt there, never walks home - so these only keep a
      hand-built board from aiming a toll mark at a square the toll never touches.
  - **The doom skull warns `DOOM_WARNING_TURNS` (2) of that side's turns out**, not one. A
    warning that arrives on the turn the king dies has nothing left to act on. `doomState()`
    is the primitive and returns `'' | 'early' | 'imminent'`; `doomedKing()` and `dyingKing()`
    are thin wrappers for callers that want a predicate. `'imminent'` dies at *this* commit
    and draws `.doom-skull.imminent` — red, faster, solid, the look the skull always had; the
    early one is amber, slower, and peaks short of solid.
    - The template gates and classes the skull off **one** call
      (`*ngIf="doomState(hex) as doom"`), because `''` is falsy. Running `*ngIf` on one
      predicate and the class binding on another that re-ran the first was three full
      evaluations per commander cell per change-detection pass, over ~400 cells.
    - **Never over a king in a panel.** `overtimeToll()` searches the board alone, and a king
      never walks home, so this only keeps a hand-built board honest. `doomedKing()` returns
      false on any `hex.panel`. The turn the wider warning buys is for landing a heal.
  - **The END of turn 50 gives it to black** (`OVERTIME_LAST_TURN`), however level it still
    is - turn 50 is played out first, so the match ends on the hand-over into turn 51 (ply
    101), not on 99. **Both engines end it there** (`endReason: 'overtime'`), on a move, a
    pass, or the clock's pass alike. *The owner, 24 Sep 2026: "didnt i say the games not
    suppose to last longer than 50 turns"* - they had; until then the header said so and the
    match played on, the toll taking three a turn until a king died.
  - **One settlement per engine, in one order** (`_settle_hand_over()` in `consumers.py`, run
    by `_commit_turn` and `_settle_pass`; `settleHandOver()` in the browser engine, run by its
    move, its panel blow and its pass). **The board decides first** - both sides beaten is a
    mutual draw, one is the other's win by the objective - then the schedule, then `maxTurns`,
    a custom config's turn limit, checked against the turn just played. A king killed on the
    hand-over that would end the match is a regicide, not the schedule's ending. The order
    used to be written out at every hand-over, five copies across two languages, and the
    browser engine's panel blow had already lost its mutual draw: a blow that left neither side
    a commander went to black by list order.
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
- **What the offline engine checks, and what it takes on trust.** The server re-derives every
  move; the offline engine cannot, because the panels, the points and the abilities are all
  still the client's own. So it keeps every rule that needs none of them: the board move and its
  reach, the walk home, **the opening's rules** (nobody attacks - on the board or into a panel -
  a battlefield unit gets one move for the whole phase, and a panel unit is locked out once it
  has moved), **a panel's three starts a turn**, and, for a unit named in a panel message, that
  the config knows it, it is not already standing on the board, and its HP is neither above what
  its own config allows nor back from the dead - attacker and defender alike, a `panel_attack`
  naming both. The wrap is held to its schedule (`isWrapOpen` needs only the ply) and charged
  the unit's `value` from config rather than the number on the message - but **the decision that
  a price is owed at all is still the message's**, because telling a crossing from a shuffle
  inside a base needs the panel geometry the engine has not got, so `price: 0` crosses free. It still takes on trust what an ability is worth - a boost, a mend, a cast's HP - and
  what needs a panel to work out: which panel a unit stands in, what a walk inside one cost, and
  whether a side can afford the wrap. That last one is **not** an oversight: a solo purse holds
  what abilities have paid in and out (Rally hands out 300) as well as what the record shows, so
  a check against the record alone would refuse a crossing the player really could afford. It
  waits on the ability catalogue - see 6.15 and 6.17 on the punchlist, which settle together.
- **The opening's lock and the panels' allowance are derived, in one place.**
  `services/history-rules.ts` reads them off the move history - `openingMovedHexes`,
  `lockedPanelUnits`, `panelMoversAt`, `panelMoverAllowed` - and each names the server function
  it mirrors in its own doc comment. The room (after a reload) and the offline engine both use
  it; the **board** keeps its own running Sets as well, because it has to draw a half-staged
  turn before any of it is recorded. Three readers, one derivation: a rule change goes there and
  in the server function it names, and nowhere else on the client.
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
- **Damage is `attack - defense`**, floored at **`MIN_STRIKE_DAMAGE` (1)**: armour blunts a
  hit but never turns it aside entirely, and never heals (`strike_damage()`). It floored at 0
  until 16 Sep 2026, which left whole matchups unable to hurt each other at all — a pawn (14
  atk) dealt literally nothing to a shieldman (18 def) or a king (15 def), all game. That was
  the reported "some shit simply doesn't seem to take any hit".
  - **An attack of 0 stays 0.** The floor lifts a blow that was blunted, not one that was
    never thrown; without that guard a unit with no attack stat would chip a point off
    whatever it touched.
  - **The floor is `rules.minStrikeDamage` in the config**, not a constant on each side — the
    same place and the same shape as `rangeFalloff`, read from the same config object both
    `strike_damage()` and `strikeDamage()` already receive. It started life as a hand-synced
    `MIN_STRIKE_DAMAGE` in both files guarded by prose saying "these must agree", which is
    exactly the sort of pairing that drifts: a client flooring at 1 against a server flooring
    at 0 disagrees about who is still standing, and nothing would have caught it. Changing the
    dial is now a config edit, validated by the schema, with the `config-sync` skill keeping
    the three mirrors in step.
  - `MIN_STRIKE_DAMAGE` survives in both files as the **fallback for a config that names no
    floor** — reached only by a caller that hand-built a config without going through
    `load_config()` / `ConfigService`, which a number of tests do.
  - **Absent means the current default (1), not the rule in force when the config was
    written.** Both normalisers fill it in. Filling in the old 0 to preserve a frozen room's
    combat is tempting and wrong: nothing can tell such a snapshot from a custom config
    authored today that simply omitted the field, and that config would silently get the dead
    matchups back.
  - **A negative floor is rejected on both sides**, because it corrupts the board rather than
    merely unbalancing it: `strike_damage` would return a negative number and `deal_damage`
    subtracts it, so a blow would heal whatever it hit. An explicit `null` is rejected too —
    both normalisers only fill an *absent* key, so a client that read it through `?? 0` called
    valid a config the server then refused.
  - **The result is capped at the attacker's own ring-scaled attack.** The floor lifts a hit
    that armour absorbed; it is not a damage source of its own. Unclamped, a large
    `minStrikeDamage` would override the attack stat outright — every blow dealing the floor
    whatever the attack, defence or falloff, which makes all three dead config. Neither the
    schema nor either validator puts an upper bound on the field, so the clamp in
    `strike_damage` / `strikeDamage` is what holds this.
- **The defender counter-attacks** with the same sum reversed, but only if the attacker is
  inside *its* reach — a melee unit cannot answer a bishop three rings out. A unit reduced to
  0 HP never counters.
- **The attacker holds its ground**, even on a kill. Taking the hex would be free movement, and
  attacking is what ends the unit's movement for the turn.
- `hex-rules.ts` mirrors the damage sums client-side (`strikeDamage`, `rangedDamage`,
  `attackTiers`) for the board glyphs and the offline engine. Change one, change both — the
  specs compare them against these numbers.

## Points

Placeholder numbers, but a real economy now, and **derived rather than tallied**. Every source and
sink of a point is on the move history or the schedule, so both engines add them up from those.
The owner's rules and their history are under *Two currencies* in the phases section; this is
the ledger:

| | |
|---|---|
| a side's turn begins | its rate - 1, then 2 from Phase 2's halftime, 3 from Phase 3's, nothing in overtime - and a phase's grant (10, 20, 30) on the side's first turn of it (`turnPointsBy`) |
| overtime begins | the side's banked victory points, once, on its own first overtime turn (`vpAsPoints`) |
| a kill on the board | +the dead unit's `value` to the killer; a counter-swing that kills the attacker pays the defender's side its `value` |
| a kill in a panel | nothing, base or reserve, whoever dies |
| walking home | +the unit's `value` |
| the wrap | −the unit's `value` (on the `panelMove` record's `price`) |
| a pool ability | −its `abilityCosts` entry — solo only, and **not** on the record |

The first two rows are `scheduledPoints()` in `match-score.ts` / `scheduled_points()` in
`scoring.py`; a unit's worth is read by `unitValue()` / `unit_value()` and nowhere else. A cast
that kills pays nothing; only a turn's own action ever did. A round trip — wrap out, walk home —
is points-neutral, which is what the refund is for.

- **Server**: `points_of(color, ply, history, config, bank)` in `server/game/engine/economy.py`,
  *bank* being the state row's `phase_bank`. The wrap is priced against it, so it has to be
  right.
- **Client**: `pointsFromHistory(color)` in the room mirrors it. **`reconcilePoints` resets both
  purses from the record on every `game_started`, `move_made`, `turn_passed` and
  `game_state_update`, solo and networked alike** — and the live tally still moves in between, so
  a wrap staged this turn shows its price at once. Nothing else pays a point: not the start of a
  turn (`beginTurnFor` only ticks cooldowns), not a kill on its way in. So a new way to earn one
  is one line in the record's sum, and a held move - one of an Overtime 2 or 3 turn's several,
  which arrives as a `game_state_update` rather than a `move_made` - is paid like any other.
- **The one thing the record does not hold is abilities**, which are solo only: a pool ability
  is bought with points, and Rally hands 300 out. `chargeFor()` keeps that apart as
  `myAbilityPoints` / `opponentAbilityPoints`, persisted with the solo state, and
  `reconcilePoints` adds it on - so the reset gives back nothing spent. A networked room casts
  nothing and adds 0. (Solo used to keep a tally alone and pay each source by hand, which is how
  a held move's kill went unpaid.)
- Cooldowns still tick at the start of a side's turn and are still client-side; see Ability
  panels.

## The panels, the toll and the opening, on the server

None of this existed on the server before; the room gated all of it to solo because no server
could answer it. Everything below is **derived from the config and the move history** — there is
no panel table, no points column and no migration.

- **`server/game/engine/panels.py`** is the model: the geometry (`gateway_hexes`,
  `base_gateway_hexes`, `wrap_tips`, `wrap_corridor`), the opening deal - the setup's squads,
  or the placeholder ones under `PANELS_DEALT` (`deal_panels`, mirrored by `buildReserves`),
  mending
  (`panel_hp`, `withdrawn_units`), and **`panel_occupancy`, which replays the history in order**:
  the deal, then every walk home, walk inside a panel and crossing, in the order they happened.
  It was two sets once — "ever crossed" and "ever walked home" — which was right only while a unit
  could reach a panel at most once. Recorded panel moves let a unit cross, walk home, wrap back and
  cross again, and only an ordered replay can say where it ends up. **The client's
  `panelReplay` does the same replay**, and the two must agree.
- **The browser engine is not the specification.** It takes crossings, walks, the wrap, blows
  into panels and casts on trust — it has nobody to cheat — and the base-never-counters rule is a
  `counters` boolean off the wire there. The rules live in the board's *click handler*
  (`addGateway`, `addWrap`, `addBaseEntry`, `panelCanMove`, `budgetFor`), and that is what the
  server mirrors. Solo play is therefore laxer than networked play.
- **Messages.** `enter_board` (a crossing) and **`panel_move`** (a walk inside a panel, or the
  wrap) are **deployment**: they hand nothing over, so several may come in one turn, and both are
  answered with a full `game_state_update` through the shared `_commit_deployment`.
  `panel_attack` and a withdrawing `make_move` are the turn's board action and end the turn
  through the shared `_commit_turn`. The client sends a turn's panel steps from
  `pendingPanelSteps` **in the order they happened** — a crossing judged before the walk that
  brought its unit to the gateway finds nobody standing there. That is exactly how a networked
  crossing was refused when only crossings were sent.
- **The `panelMove` record**: `from`, `to`, `turn`, `unit` (with `uid`), **`panel` — the panel the
  walk BEGAN in**, which decides whose movers it spends (the wrap starts in the base), `cost` (MOV)
  and `price` (points). The server derives `cost` and `price`; the client sends them only for the
  browser engine.
- **`panel_allowance`** is what a panel unit may still spend this ply, or `None`: locked out of the
  opening (`locked_units`), or its panel's three movers used up (`panel_movers` — three per base
  and three per reserve, never between them), otherwise its `move` less what it has already walked
  this ply (`walked_this_ply`). **A crossing is held to it too**; it used to cross on a full MOV it
  had already half spent getting to the gateway.
- **The wrap** (`panel_move_targets`): base units only, into their own reserve, while
  `is_wrap_open(ply)`; one step on top of reaching the base tip, no enemy on the far tip, and the
  unit's `value` in points against `points_of`. Out of MOV is judged before out of money, as the
  client judges it.
- **The client places recorded units** in `placeRecorded`, after the deal and the walks home —
  skipping any unit this turn has walked and not yet sent, whose staged hex is newer. This is how
  the *other* player sees a shuffle at all, and how a reload keeps one instead of re-dealing it.
- **Overtime's toll** (`overtime_toll` in `game_logic.py`) is taken on **all three ways a turn
  ends**: a move (`_commit_turn`), a pass, and the clock's pass (both through `_settle_pass`) —
  before the ply bump and before anyone is judged beaten. A pass never used to touch the board or
  ask who lost, so a king on his last point could pass his way past the toll. `turn_passed` now
  carries `boardState`; `applyTurnPassed` already took one. A pass judges **only the side the toll
  felled**, by its objective — the browser engine's pass used to call a toll-killed king a defeat
  outright, which is wrong under `elimination`, and now judges it the same way.
- **The opening's rules** are enforced in `_handle_make_move` and `_handle_panel_attack`: nobody
  attacks (explicitly, by moving onto an enemy, or into a panel), and a battlefield unit that has
  moved in the opening is done for the phase (`opening_moved_hexes`, mirroring `initMovedHexes`) —
  checked before the walk-home branch, because the board locks a unit out before it offers it a
  way home. Neither engine enforced any of this; the browser engine still does not. Three live
  tests and `match.py` had been striking or re-moving in the opening and passing because of it.
- **`server/game/engine/phases.py` is the fourth mirror.** The browser engine warned that porting
  the phase schedule "would make a fourth thing to keep in step" beside the three halves of the
  config. It was ported because the server cannot take the toll, open the wrap or know the opening
  without it. Change the schedule in both; `PhaseScheduleTestCase` pins the numbers.

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

## Room access and identity

**A room's access token is refreshed on every join, and kept alive by heartbeats while the
seat is in use.** On join: `_refresh_game_token`, called from
`_handle_join_game_room` once the token checks out. `GAME_TOKEN_LIFETIME` is how long an
*unused invite* stays good, not a ceiling on how long a game may run. It was a ceiling: the
lobby and the room rejoin on every socket reopen (above), so a token frozen at room creation
meant any blip past ten minutes answered `TOKEN_EXPIRED`, bounced the player to the lobby, and
let the 30-second disconnect grace timer forfeit a match still being played. Eleven minutes in
the setup screen did it too, without any network trouble at all. Refreshing on join alone still
left a match played for ten minutes *without* a reload one dropped connection from
`TOKEN_EXPIRED`, so a heartbeat from a socket seated in a room (`self.game_id` set) calls
`_keep_game_token_alive`, which rewrites the expiry only once half the lifetime has run - the
condition is in the query, one statement either way. A socket that sends no heartbeats lets its
seat go stale, which is the point of the expiry.

**The token does not live in the URL.** It arrives on the query string once, is copied into
`sessionStorage` under `cpp.roomToken.<gameId>`, and the query string is rewritten away with
`history.replaceState`. A bearer token in a URL is kept in browser history and leaves in the
`Referer` of any outbound link; session storage is per-tab, dies with the tab, and is what
carries the token across a reload now that the address bar cannot.

**"All ready" means both seats.** `_all_players_ready` compares `{host, opponent}` against the
usernames holding a ready row - not `all()` over whatever rows exist. A disconnect *deletes*
the leaver's row, so `all()` over the one surviving row (the host's own) said yes with nobody
left to play against, and the client's `canStartGame()` was a stricter check than the server's.

**Every handler handed a `gameId` calls `_require_seat`.** `player_ready`, `player_unready` and
`reveal_response` all take a room id off the wire; `change_game_mode`, `set_custom_config` and
`start_game` check `game.host` directly, which is stronger. Chat is the same rule wearing
another hat: `group_send` never asked whether the sender is in the group it sends to, so
`_handle_game_room_message` requires `self.game_id` - only set after the token check - and
`_handle_chat_message` requires `self.username`, or a socket that never joined talks to the
whole lobby as `null`.

**A username is taken in one statement.** `_claim_player_connection` is the only way to claim
one: `get_or_create`, returning whether it is ours now, with `takeover=True` for the rejoin
path that has already matched the stored secret. The read-then-`update_or_create` it replaced
left a window - two clients that both saw a name free both wrote it, and the second walked off
with the first's row, channel name and identity secret. `change_username` claims the new name
*before* releasing the old, so a rename that loses leaves the player exactly where they were.

**An invited pair is claimed in one statement too.** `_claim_invite_pair` marks both players
`invited` in a single conditional update that skips anyone already `in-game` or `invited`, and
rolls back unless exactly both rows changed. The busy checks above it still read the statuses -
they give the clearer refusal - but the write used to come after the invite was created, so two
players inviting each other at the same moment both read "online" in between and both invites
went out. If creating the invite then fails, both are put back to `online`, or nothing would
ever release them.

**A room join carries the identity secret.** Leaving a room deletes the player's connection
row (`_cleanup_game_room_connection`), and rejoining recreates it through
`_create_or_update_player_connection`. Recreated without a secret, the player's return to the
lobby failed its own rejoin check - `bool(existing.secret)` - and was handed a guest's name:
anyone who reloaded mid-game came back a stranger. The client sends `secret` with
`join_game_room`; the server stores it once the token has proved the seat, and a join without
one leaves the stored secret alone.

**A name nobody has heartbeated may be taken back by its owner - and by nobody else.** A row older
than `STALE_AFTER` (45s, three missed heartbeats) is almost certainly abandoned: a server that dies
runs no disconnects, so every player's row outlives a restart, and the roster sweep
(`_get_all_online_users`) clears those rows a moment *later* - so the first player back was renamed
to a guest, which also cost them their seat, while everyone after them kept their name
(PUNCHLIST 6.18). So `_handle_join_lobby` lets staleness stand in for `rejoining`.

**Staleness widens WHEN a row may be taken back, never WHO may take it.** The secret still has to
match. An earlier fix deleted the stale row outright before the comparison, which meant a sleeping
laptop - three missed heartbeats, socket still open, seat still held by that name - handed its name
and its game to whoever asked next, with no secret at all. A row carrying no secret has nothing to
check and nothing to protect, and age alone frees that one. The sweep, the turn clock's liveness
check and this all read the one constant.

**A room page leaves only a room it joined - but always takes its socket down.** Opened without a
token it goes straight back to the lobby, and its `ngOnDestroy` used to send `leave_game_room`
anyway: the message sat in the socket's queue, went out on the lobby's new connection before anyone
had joined it, and the lobby showed "Error: Can only leave as yourself". `roomJoinSent` is set by
`join()` and gates the leave. It does **not** gate `disconnect()`: the socket was opened for this
room the moment the token checked out, so gating both on the join left a room socket open behind a
page that had already gone. Two questions, two conditions.

**Tokens and secrets compare through `_same_secret`** - `secrets.compare_digest` over encoded
bytes, because `compare_digest` rejects non-ASCII `str` and both of these arrive off the wire.

**Reading storage goes through `storage.ts`.** `localStorage` and `sessionStorage` *throw* in
Safari private browsing and with site data blocked - not on a missing key, on the access - and
these reads sit in constructors and `ngOnInit`, where that takes the screen down rather than
losing one remembered value. `AudioService` and `LocalGameService` carry their own try/catch;
everything else calls `readStore`/`writeStore`/`removeStore`.

**A socket the player replaced is not the player leaving.** A half-open
connection is only torn down when the OS or a proxy gives up on it, which can be long after
the client noticed, gave up and reconnected. `_delete_player_connection` always knew this -
it takes a `channel_name` and only deletes a row that still belongs to that channel - but
nothing above it did, so a late close cleared a live player's ready tick, told the room they
had dropped, and armed a 30-second forfeit against somebody sitting at the board.
`_reclaimed_by_newer_socket` is that question asked once: the PlayerConnection row *is* the
seat, since both join handlers write their own channel name into it. Both cleanup paths bail
on it, and the grace timer re-asks on the way out - a join that lands between the timer being
armed and the cancel at the top of `_handle_join_game_room` cancels nothing. The timer's
version narrows to `status='in-game'`, because turning up in the lobby is not a reason to
spare your opponent the forfeit.

  Reproducing it needs a genuinely half-open socket, which neither the test suite (clean
  disconnects) nor a page reload (clean close) produces. Put a TCP relay in front: run
  daphne on 8001, relay 8000 -> 8001, and for one connection close the *browser* side while
  holding the daphne side open. The browser reconnects and rejoins; daphne still believes
  the old socket is live. Closing the held side then delivers the late disconnect, which
  daphne logs as `code: 1006` followed by `Ignoring stale disconnect`. Watched working on
  5 Sep 2026 - Bob saw nothing at all and no forfeit fired.

**An unanswered invite used to wedge a pair forever.** `expires_at` was written at creation
and read by nothing the server runs - only by `cleanup_game_state`, a management command
nobody schedules. So a responder who closed their tab left the row `pending`, and
`CHALLENGE_EXISTS` refused every future invite between that pair while both players stayed
`invited`, which is refused as busy for everyone else. `_expire_stale_challenges` runs at the
top of `_handle_game_challenge` and clears both. It is a thin wrapper over
`utils.expire_stale_challenges`, which the `cleanup_game_state` command calls too - the
command used to mark the rows `expired` and leave the players at `invited`, so the
documented escape hatch did not end the jam it is documented for. One implementation,
because two disagreed. The two deadlines are deliberate and
different: the lobby gives the responder **5 seconds** and auto-declines, which is the real
one; the server's **30** is the backstop for a responder who is not there to run it.

**The client's retry budget is coupled to `DISCONNECT_GRACE_SECONDS`.** Five attempts at a 3s
handshake plus a 3s wait jittered to 1.5x spans ~30-37s, against a server that forfeits at 30.
Lower `MAX_RECONNECT_ATTEMPTS` or `RECONNECT_INTERVAL_MS` and players start losing games they
were still trying to reconnect to. The comment in `websocket.config.ts` says so; this is the
other half of it.

**Readying is not ordered against starting, in tests.** The two readies travel on two
connections and `start_game` on a third, so nothing sequences them. `_both_ready_then_start`
in `test_consumers.py` waits for both `player_ready` broadcasts to come back on the host
first - each is sent only after its row is written. Six sites raced this and got away with it
while `all()` over a single row was enough.

**A receive that times out kills the consumer under test.** asgiref's
`ApplicationCommunicator.receive_output` cancels the application future when it times out
(`venv/.../asgiref/testing.py`) - so `_receive_until` running out, or any wait-for-quiet built
on `receive_json_from`, destroys the thing being tested and the real failure resurfaces as a
`CancelledError` in `disconnect()` during teardown. If a test fails with a teardown
`CancelledError`, look for what timed out above it. To assert something does *not* arrive, use
`_drain`, which polls `receive_nothing` instead.

**No backticks inside `game-board.component.ts`.** Its template and its styles are both
inline template literals spanning ~1200 lines, so a backtick anywhere in either — including
in a comment, quoting a class name like `` `.imminent` `` — ends the literal and the file
fails to parse. The errors that come back point at the `@Component({` on line 465 and at
`styles:`, not at the comment that caused it. Name classes in prose instead.

**A board spec that means "a turn later" has to move `turnNumber`.** Two of them called
`buildCells()` twice at the same ply and asserted a mending `+1`; they passed only because
`absorbWithdrawn()` was missing the across-a-ply guard that `woundReserves()` had. Rebuilding
at an unchanged ply is exactly the case that must stay silent, because that is what a staged
cast looks like.

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
one `make_move {from, to, attack?}` - its casts included (see *a turn's casts ride inside the one
message that ends it*), so the engine takes the turn whole or refuses it whole.

**Undo stops once End Turn has sent the turn.** `turnSubmitted` (the `submittedTurn` guard
End Turn already used) disables the button and makes `undoMove` a no-op until the engine
answers. The staged stack stays up in that gap so the position does not flicker, and popping it
then changed nothing the engine saw while showing a board that was not being played.

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
    skill, ultimate. **Each side starts with `rules.cpAtStart` (5)** - *the owner, 24 Sep
    2026: "at the start of the game, user has 5cp"* - **and earns the rest at the start of
    each postmatch** (turns 14, 25 and 36), off the phase that has just banked (`cpAwarded()`
    in `match-score.ts`, `cp_awarded()` in `engine/scoring.py`; `cpOf()` adds the start).
    Phase N pays each side `N x rules.cpPhaseOffset` (**5, 10, 15** - lowered from 10, 20, 30
    the same day) plus both sides' scores for the phase, and the side that scored less the gap
    between them as well. *The owner:* the higher total gets `phase_x + (mine + theirs)`, the
    lower `phase_x + (mine + theirs) + abs(mine - theirs)`. So a hard-fought phase pays both
    sides more, and the side behind is paid up to level: Phase 2 banking white 12, black 4 -
    the bank's figures, already doubled - pays white 10 + 16 = 26 and black 34.
    - **Nothing else awards CP.** The 5 a side starts with buys the cheapest path (Tempo, 5)
      and no other before turn 14. Choosing is open on a setup turn, so an award can be spent
      in the postmatch it arrives on. It used to be a flat `rules.cpPerPhase` (100) as each of
      the five phases began.
    - **Only the phase's own scores are compared**, not the match's: the side behind in that
      phase is paid its gap even when it leads overall (the owner's call). A tie pays both the
      same. A late phase still awards.
    - The server has the formula but spends nothing yet - abilities are solo (6.15) - so the
      Python copy is kept in step for when they are not.
  - **Points** buy the eight-ability pool, and stay the board's currency besides: the wrap
    crossing charges them and coming home refunds them. A side banks points **at the start of
    each of its own turns, at a rate that steps up at each phase's halftime**: 1 a turn to
    turn 19, **2 from Phase 2's halftime (turn 20), 3 from Phase 3's (turn 31)**, and
    **nothing in overtime** (`turnPointsBy()`, off `POINT_RATES`, which reads
    `Phase.points` in `PHASES` - a phase's own rate from its halftime, the one before it until
    then). *The owner, 24 Sep 2026: "regular points are multipled by x ... phase 1 is 1 points,
    phase 2 is 2 points. phase 3 is 3 points"*, *"OT stops gaining points"*, and *"1x, 2x, 3x
    regular point accumation now happens at the start of half time of each phase instead of
    start of a phase."* Overtime used to pay 1, 3 and 5 a turn.
    - **And a grant as each phase begins: 10 for Phase 1, 20 for Phase 2, 30 for Phase 3**
      (`Phase.grant`), paid on the side's own first turn of the phase, on top of the rate.
      *The owner, 24 Sep 2026: "at the start of each phase (not start of each postmatch), +10
      regular points for phase 1, 20 for phase 2, 30 for phase 3."* `turnPointsBy()` /
      `turn_points_by()` add it, so rate and grant come from one sum. A side that passes every
      turn has 59 in rates and 60 in grants by turn 36: 119.
    - **At the start of overtime a side's victory points turn into points**: its whole banked
      total, paid once as its own first overtime turn begins - white on hand-over 73, black on
      74 (`vpAsPoints()` in `match-score.ts`, `vp_as_points()` in `scoring.py`). *The owner, 24
      Sep 2026: "at the start of the overtime, all your accumlated victory points turn into
      regular points."* The bank is not emptied - it is the record of how the phases
      finished - but nothing is decided on it any more, and the header hides the score for
      all of overtime (`showScore`), so on screen the victory points are simply gone.
      **A match won on points never converts**: it ends *on* the hand-over into overtime's
      first ply, the one moment the arithmetic would read a turn as begun, so `vpAsPoints`
      answers 0 once `decidedOnPoints` does. The same finished position keeps its score up
      (`showScore`) and shows no toll warning (`tollBind`). `pointsFromHistory()` and
      `economy.points_of(..., bank)` add it to the record's sum, through `scheduledPoints()`;
      the server's copy has nothing to price with it yet, since no wrap is open in overtime.
    - **Two places add that point up and both read the one table.** `pointsFromHistory()`
      re-derives the whole purse from the record on every hand-over, solo included;
      `economy.points_of()` is the server's copy, which the wrap is priced against
      (`turnPointsBy()` / `turn_points_by()` walk the rates). The scoring parity tests hold the
      two to the same answers.
    - Besides the turn: **+the dead unit's value for a kill on the board** (and the defender
      is paid the attacker's value when a counter kills it) - *the owner, 24 Sep 2026:
      "anytime a unit is killed, i get the amount of regular points which the one i killed is
      worth"*, where it was 1 - **+the unit's value** when it walks home, **-the price** of a
      wrap crossing. **A blow into a panel pays nobody**, base or reserve, whoever dies of it:
      *"in green panel it doesnt award points if the unit in there kills or gets killed for
      any player."* A cast that kills pays nobody either. `killRewards()` is the one place the
      room reads a kill's pay, for `pointsFromHistory()`, mirroring `points_of()`. All of it
      derived from the record, never a stored tally.
  - Everything goes through `purseFor()` / `chargeFor()` / `purseName()`, so a cost, a grant, a
    hint and an Undo all read the same currency off one place.
  - `cpOf(side)` is **derived** - `cpAtStart` plus `cpAwarded(bank, color, cpPhaseOffset)` off
    the engine's phase bank, less `myCpSpent` - rather than tallied, so a reload cannot collect
    a phase's award twice. Only what has been spent is persisted. Spend through `spendCp()`; a
    negative amount hands some back (Undo does).
    - **A solo save's spend is stamped with the CP scheme it was made under** (`CP_SCHEME`,
      `cpScheme` in the saved UI state). One from before CP was earned carries no stamp, and its
      spend is dropped on restore: it came out of 100 a phase, and read against what is earned
      now it left the purse deep in debt (`CP: -125`). What it bought stays bought. Bump the
      stamp if CP is reworked again.
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
  - **A pick taken back in the turn it was made is free**; a swap in any later turn costs
    `swapDebt`, and whatever refills the slot comes in on a 3-turn cooldown. The debt exists
    so swapping is not a way to hand yourself a *ready* ability mid-match - but changing your
    mind about a pick nobody has cast yet is not swapping, and charging for it made the
    four-slot cap order-sensitive (Mend arrives paired with Rally, so a damage pair only fit
    if it was the second pick).
    - **The test is the whole pair: picked this turn AND neither half cast.** `canReset()`
      only looks at the index that was clicked, while a click gives the whole pair back — so
      testing that one index alone let you cast Mend, hand the pair back through its untouched
      partner Rally, and pick a fresh pair cold in the same turn. Cast once, re-armed free,
      every turn.
    - **"Cast" is `abilityGlow`, not the cooldown row.** The cooldown row holds what was cast
      *and* what merely arrived cold-started off a `swapDebt` slot, so reading it meant a
      replacement pair could never be taken back free however untouched — the very
      order-sensitivity this was meant to remove, surviving for anyone who had swapped once.
      `markUsed()` writes the glow on every cast and it clears when that side is up again, so
      within a turn it is exactly "what I have cast".
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
- **The socket dials the origin that served the page** - except under `ng serve`
  (`WEBSOCKET_CONFIG.DEV_SERVER_PORT`), which proxies nothing and has to be pointed at daphne
  by hand. Pinning `BACKEND_PORT` unconditionally sent a deployment behind TLS on 443 to
  `:8000`, where nothing is listening.
- **The reconnect wait is jittered upward** - `interval * (1 + 0.5 * random)`, so the clients a
  restart knocked off do not all come back in the same three-second lockstep. The configured
  interval is the floor; specs pin `Math.random()` to 0 so the tick arithmetic stays honest.
- **`WEBSOCKET_CONFIG` is read, not decorative.** `RECONNECT_INTERVAL_MS` and
  `MAX_RECONNECT_ATTEMPTS` were duplicated as literals in the service and the config was dead;
  they are now the only copy. `DEFAULT_ROOM` was read by nobody and is gone.

## Known quirks

- **Movement still cannot land on an occupied hex** — attacking is its own thing, carried by the
  optional `attack` field on `make_move` (see Combat). An "attack by moving onto an enemy" click
  does nothing; that path is gone for good.
- `server/game/tests_disabled/` is **not** disabled. Its 4 tests match Django's `test*.py`
  discovery pattern and run under a bare `manage.py test` (89 vs 85). They pass. Left as-is.
- `client/src/app/components/setup-config/setup-config.component.html` is still a raw JSON
  `<textarea>` with a "Configuration UI will be added here" placeholder.
- **The ability catalogue lives in the config** (`abilities`: `slots`, `pool`, `paths`,
  `catalogue`), in all three mirrors. **The engine still does not read it** — only the client
  does — so tuning an ability is a config edit and nothing more. This is the *system* half of
  PUNCHLIST 6.15; the numbers themselves are still the owner's placeholders, and two testing
  levers sit in the pool: **Mend** (free, heals 20) and **Rally** (free, hands out 300 points),
  both carrying `testing: true` so they can be kept out of a real game. **Abilities stay gated
  to solo (`buffsBind`, `canChooseAbilities`) until the numbers settle.**
  - **Ids outlive slots.** The catalogue is keyed by a stable `id`; the room works internally in
    *slot numbers* (the template, the glows, the cooldown arrays all do), and `abilityIds` is the
    single place the two meet — pool first, then each path's passive, skill and ultimate.
    Everything that **outlives the component** is written by id (`persistLocalUiState`, saved
    under `cpp.localGame.ui.v2`), so reordering the config moves the slots and leaves a saved
    loadout, path and cooldowns pointing at the same abilities. An id the catalogue has lost is
    dropped rather than pointing at nothing.
  - **Derived once per config** (`catalogueCache`). The template reads `abilityEffects`,
    `abilityCosts` and `abilityPaths` on every change-detection pass, and rebuilding seventeen
    entries each time would allocate through the whole match — the same reason `standings` and
    `homecomingsSpent` carry caches. `mov`/`atk`/`def` are filled in at 0 where the config omits
    them: every reader wants a number, and `undefined` reached a stat line as `NaN`.
  - **Only the client validates them** (`validateGameRules`): the pool and each path must name
    abilities the catalogue has, and an entry must carry its own key as its `id`. The server's
    `_validate_config` deliberately does not, the engine never touching abilities.
  - **Still to move**, and deliberately not done here: boosts have to reach the server's combat —
    `strike_damage` and the move budgets — which today ignore the `bonuses` a message carries.
    That, and the numbers, are what keep abilities solo.
  - A networked room still opens the ability panels, so the refusal is what a player reads:
    `ABILITIES_SOLO_ONLY`, through `choiceRefusal` and `abilityBlockedNote`. It used to be "not
    your turn" everywhere, which was false on your own turn — and in solo it also said so for a
    cast refused by the opening.
- **Never `sed -i` a CRLF file from Git Bash.** It rewrites the file even when the pattern does not
  match, and it drops the carriage returns as it does - so a failed substitution silently flattens
  a whole file to LF. `git diff --stat` will not show it (`core.autocrlf` normalises the
  comparison), so only a byte count does. It has happened twice to the Python test files. Use the
  file-aware editor, or a Python rewrite that opens the file in binary.
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
