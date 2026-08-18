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
DJANGO_DEBUG=true python manage.py test               # 75 tests
DJANGO_DEBUG=true python manage.py test game.testsuite  # 71 tests, engine + consumers + models

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

Filler hexes are **purely cosmetic**: skipped by `onHexClick`, never given a piece, and
`computeLegalMoves()` still bounds itself with `isInsideBoard`, so movement cannot leak off the
battlefield. They are tinted per corner (`.panel-tl/tr/bl/br`) and are where the reserve planes
will eventually live (see Game spec), but they carry no meaning yet.

Serialised coords are `"q,r"` strings (`coord_key` / `parse_coord`). `parse_coord` raises
`ValueError` on anything malformed so callers catch one exception type.

## Config pipeline

Setup screen → `set_custom_config` WS message → `config_loader.load_config()` validates →
`GameRoom.custom_config` (DB) → `build_initial_board(config)` at game start.

This path is tested and reusable. New config sections ride it for free — no consumer changes.

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
  through the six hex neighbours. A unit can never move through or onto an occupied hex — own or
  enemy blocks equally, so a blocked path must be routed around. Implemented in
  `move_validator.get_legal_moves()`. Placeholder: every unit in `DEFAULT_CONFIG` currently gets
  `move: 6`; real per-unit values come with the real roster.
- **One unit acts per turn**, alternating plies (confirmed — the existing chess-like turn
  plumbing stays as-is; move + attack + ability all resolve inside a single player action).
- **Attack is decoupled from movement.** Units get an `attackRange: {min, max}` measured with
  `hex_distance`. Not yet implemented — see the known quirk below: since movement can no longer
  land on an occupied hex at all, the old "attack by moving onto an enemy" path is currently
  unreachable until this is built.
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
  - **Nothing of this is built.** The board squares itself off with `filler` hexes, tinted one
    colour per corner so the four panels are distinguishable, and nothing else — no labels, no
    units, no clicks, no server model. The owner asked for the shape and the colours only.
    Do not add staging/deployment UI back unprompted.
  - **Left and right are from each player's own perspective**, and the board never flips —
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

Assumed by an agent, **not** yet confirmed by the owner — treat as weaker than the above and
re-check before building on it:

- **No line-of-sight for ranged attacks** — range is pure `hex_distance`, and units do not block
  shots. Cheapest option; a real LOS check is the upgrade path.

Deferred, not rejected: global (army-wide) ultimates, stat growth on rank, the real config
editor UI.

Not yet specified at all: the actual unit roster (the config still ships chess-piece
placeholders), concrete stat values, ability numbers, XP thresholds, and how many charges an
ultimate gets.

## Known quirks

- **Attacking via `make_move` currently does nothing.** `get_legal_moves()` never returns an
  occupied hex (movement can't land on any unit, ally or enemy), and `_handle_make_move` in
  `consumers.py` only calls `resolve_combat()` when the target is in that legal-move set. So
  until the `attackRange` action from the Game spec above is built, combat is unreachable through
  the live game even though `resolve_combat()` itself still works correctly when called directly
  (see its tests in `test_engine.py::GameLogicTestCase`). This is expected, not a bug — attack was
  always meant to decouple into its own action.
- `server/game/tests_disabled/` is **not** disabled. Its 4 tests match Django's `test*.py`
  discovery pattern and run under a bare `manage.py test` (75 vs 71). They pass. Left as-is.
- `client/src/app/components/setup-config/setup-config.component.html` is still a raw JSON
  `<textarea>` with a "Configuration UI will be added here" placeholder.
- `abilities` exists in the schema and in `DEFAULT_CONFIG` as `{}`. The engine does not read
  it yet.
- Every unit in `DEFAULT_CONFIG` is a chess-piece placeholder. Nothing depends on them being
  chess pieces.
