"""
The four off-battlefield panels: what is in them, and where they join the board.

Until now the panels were the browser's alone. The board rejects a panel
coordinate outright (``HexBoard.set_cell`` raises outside the radius), so a
networked game could not offer a crossing at all and the client gated the whole
feature behind ``entryBind``.

Nothing here is persisted, and no migration adds a panel table, because none is
needed: **the panels are entirely derivable from what the server already has.**

* New games currently start with an empty *deal*. Recorded panel actions can
  still repopulate the derived occupancy later.
* The *geometry* - where a panel joins the board - is a pure function of radius.
* Everything that happens to a panel unit afterwards is written into
  ``GameState.move_history``, which the server already stores verbatim.

So this module is arithmetic, not state. It mirrors the client, and the client
is the specification: ``buildReserves()`` / ``gridCoords()`` / ``addGateway()``
in ``game-board.component.ts`` and ``BASE_PANELS`` in ``hex-rules.ts``. Where a
number here looks arbitrary it is because the client chose it; the tests pin the
radius-11 values both sides must agree on.

A warning for anyone extending this: the browser engine (``local-game.service``)
is **not** the specification. It validates almost none of this - entering takes
the unit, the hex and the HP on trust, and whether a panel answers a blow
arrives as a boolean off the wire. It says so itself, and the reason is that it
has nobody to cheat. A server does.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# The phase schedule's own count of a side's turns. Mending needs it, and it
# lived here as a private copy until the schedule was ported whole; one copy of
# a rule is the only kind that cannot drift from itself.
from .phases import hand_overs_by  # noqa: F401  (re-exported as panels.hand_overs_by)

#: Radius of a single hex in the client's SVG units. Only ratios and signs
#: matter here, but the client's own value is kept so the bounding-box
#: arithmetic in `grid_coords` compares against identical numbers.
HEX_SIZE = 28

#: The client's float slack when testing a hex against the bounding box.
EPS = 0.001

#: White's base and black's base. The other two panels are reserves.
#:
#: The distinction is not cosmetic and is needed on both sides of the wire:
#: **a base mends its wounded and never counter-attacks; a reserve does
#: neither.** Mirrors BASE_PANELS in hex-rules.ts.
BASE_PANELS = frozenset({'bl', 'tr'})

#: The six axial neighbours. Used only to build the wrap corridor, which is a
#: set, so the order is immaterial.
HEX_DIRS: Tuple[Tuple[int, int], ...] = (
    (1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1),
)

#: How many unit types a panel is dealt. The client's `.slice(0, 5)`.
PANEL_SQUAD = 5

#: A panel holds a unit on every Nth free hex, so the squad is spread out
#: rather than bunched at one end. The client's `i % 3 === 0`.
PANEL_SPACING = 3

#: How many of a panel's units may be walked in a turn: three out of the base
#: and three out of the reserve, never three between them. A unit already
#: walked this turn may keep spending what is left of its MOV. Mirrors
#: PANEL_MOVERS_PER_TURN in client/src/app/services/history-rules.ts.
PANEL_MOVERS_PER_TURN = 3

Coord = Tuple[int, int]


def coord_key(q: int, r: int) -> str:
    """The "q,r" string the board and the move history key cells by."""
    return f"{q},{r}"


def axial_to_pixel(q: int, r: int, orientation: str = 'edge-up') -> Tuple[float, float]:
    """
    Axial (q, r) to the pixel (x, y) the client lays the hex out at.

    Mirrors ``axialToPixel``. This matters here for two reasons that are easy
    to miss: which panel a hex belongs to is read off the **pixel** sign, not
    the axial sign, and the grid's reading order sorts on pixel y then x.
    """
    if orientation == 'vertex-up':
        return (
            HEX_SIZE * (3 / 2) * q,
            HEX_SIZE * (math.sqrt(3) / 2 * q + math.sqrt(3) * r),
        )
    return (
        HEX_SIZE * (math.sqrt(3) * q + math.sqrt(3) / 2 * r),
        HEX_SIZE * (3 / 2) * r,
    )


def on_battlefield(q: int, r: int, radius: int) -> bool:
    """Inside the playable hexagon, as opposed to out in a panel."""
    return max(abs(q), abs(r), abs(q + r)) <= radius


def panel_of(x: float, y: float) -> str:
    """
    Which of the four panels a pixel falls in: 'bl', 'br', 'tl' or 'tr'.

    Top/bottom then left/right, off the pixel sign - so on the default edge-up
    board ``y < 0`` is ``r < 0`` and ``x < 0`` is ``2q + r < 0``. Bottom is
    white's pair, top is black's. Mirrors ``panelOf``.
    """
    return f"{'t' if y < 0 else 'b'}{'l' if x < 0 else 'r'}"


def color_of_panel(panel: str) -> str:
    """Whose panel it is, read off the first letter - bottom is white."""
    return 'white' if panel.startswith('b') else 'black'


def grid_coords(radius: int, orientation: str = 'edge-up') -> List[Dict[str, Any]]:
    """
    Every hex the client draws - battlefield and panels - in **reading order**.

    Mirrors ``gridCoords``. The order is load-bearing rather than cosmetic: the
    opening deal indexes into this list, so a panel squad laid out in a
    different order is dealt onto different hexes and every uid means a
    different unit.

    The shape is a squared-off block: the hexagon, plus whatever falls inside
    its bounding box, widened by half a hex so the outermost column is not
    clipped.
    """
    limit_x = 0.0
    limit_y = 0.0
    for q in range(-radius, radius + 1):
        for r in range(-radius, radius + 1):
            if not on_battlefield(q, r, radius):
                continue
            x, y = axial_to_pixel(q, r, orientation)
            limit_x = max(limit_x, abs(x))
            limit_y = max(limit_y, abs(y))
    limit_x += abs(
        axial_to_pixel(1, 0, orientation)[0] - axial_to_pixel(0, 0, orientation)[0]
    ) / 2

    scan = 2 * radius + 3
    cells: List[Dict[str, Any]] = []
    for q in range(-scan, scan + 1):
        for r in range(-scan, scan + 1):
            x, y = axial_to_pixel(q, r, orientation)
            inside = on_battlefield(q, r, radius)
            if not inside and (abs(x) > limit_x + EPS or abs(y) > limit_y + EPS):
                continue
            cells.append({
                'q': q, 'r': r, 'x': x, 'y': y,
                'on_battlefield': inside,
                'key': coord_key(q, r),
            })
    cells.sort(key=lambda c: (c['y'], c['x']))
    return cells


def panel_zones(radius: int, orientation: str = 'edge-up') -> Dict[str, List[str]]:
    """
    The hexes of each panel, in reading order.

    A list rather than a set, because the deal counts along it.
    """
    zones: Dict[str, List[str]] = {}
    for cell in grid_coords(radius, orientation):
        if cell['on_battlefield']:
            continue
        zones.setdefault(panel_of(cell['x'], cell['y']), []).append(cell['key'])
    return zones


# ---------------------------------------------------------------------------
# Where a panel joins the board
# ---------------------------------------------------------------------------

def gateway_hexes(radius: int) -> Dict[str, Dict[str, str]]:
    """
    The three reserve hexes each side steps onto the battlefield from.

    Mirrors ``gatewayHexes``. They satisfy ``q + r == radius + 1`` - the
    reserve hexes nearest that player's own edge. On radius 11 that is
    ``(3,9) (2,10) (1,11)`` for white and the point mirror for black.
    """
    out: Dict[str, Dict[str, str]] = {}
    for step in (2, 1, 0):
        out[coord_key(step + 1, radius - step)] = {'dir': 'left', 'color': 'white'}
        out[coord_key(-step - 1, step - radius)] = {'dir': 'right', 'color': 'black'}
    return out


def base_gateway_hexes(radius: int) -> Dict[str, Dict[str, str]]:
    """
    The three base hexes each side walks home through.

    Mirrors ``baseGatewayHexes``. On radius 11 that is ``(-12,11) (-12,10)
    (-12,9)`` for white and ``(12,-11) (12,-10) (12,-9)`` for black.
    """
    out: Dict[str, Dict[str, str]] = {}
    for step in (0, 1, 2):
        out[coord_key(radius + 1, step - radius)] = {
            'dir': 'right', 'color': 'black', 'back': 'true',
        }
        out[coord_key(-radius - 1, radius - step)] = {
            'dir': 'left', 'color': 'white', 'back': 'true',
        }
    return out


def wrap_tips(color: str, radius: int) -> Dict[str, str]:
    """
    The two hexes a side's wrap joins: its base's tip and its reserve's.

    Mirrors ``wrapTips``. Far left and far right of the same row - white
    ``(-12,1) -> (11,1)`` on radius 11, black the point mirror. Nothing is
    hard-coded; both come off the radius.
    """
    flip = -1 if color == 'black' else 1
    return {
        'base': coord_key(-flip * (radius + 1), flip),
        'reserve': coord_key(flip * radius, flip),
    }


def wrap_corridor(color: str, radius: int) -> frozenset:
    """
    The hexes a side's wrap needs kept clear to be usable at all.

    Both tips and every hex beside them. Only the one panel neighbour of each
    tip really matters - the rest are battlefield or off the grid, and naming
    them costs nothing - so this is the whole ring rather than a hand-picked
    pair. The opening deal excludes it, so a squad can never block its own
    wrap. Mirrors ``wrapCorridor``.
    """
    tips = wrap_tips(color, radius)
    clear = set()
    for tip in (tips['base'], tips['reserve']):
        clear.add(tip)
        tq, tr = (int(n) for n in tip.split(','))
        for dq, dr in HEX_DIRS:
            clear.add(coord_key(tq + dq, tr + dr))
    return frozenset(clear)


# ---------------------------------------------------------------------------
# The opening deal
# ---------------------------------------------------------------------------

def panel_roster(config: Dict[str, Any]) -> List[Tuple[str, Dict[str, Any]]]:
    """
    The unit types a panel is dealt: the first five that are not commanders.

    The commander belongs on the board - losing it is how a side loses - so it
    is never dealt into a panel. Mirrors the filter in ``buildReserves``, and
    relies on dicts preserving insertion order the way ``Object.entries`` does.
    """
    units = config.get('units') or {}
    roster = [
        (unit_id, spec) for unit_id, spec in units.items()
        if isinstance(spec, dict) and not spec.get('commander')
    ]
    return roster[:PANEL_SQUAD]


def deal_panels(
    config: Dict[str, Any],
    radius: int,
    orientation: str = 'edge-up',
    panel_hp: Optional[Dict[str, int]] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Return the initial panel occupancy.

    New games currently start with empty base and reserve panels. Panel
    history is still replayed by :func:`panel_occupancy` so recorded
    deployment actions remain understandable if that feature is re-enabled.
    """
    return {}


# ---------------------------------------------------------------------------
# What the record says happened to them
# ---------------------------------------------------------------------------

def recorded_panel_hp(history: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """
    Each panel unit's last word on its own HP, by uid.

    A blow or an ability that touched a unit standing in a panel writes
    ``intoPanel`` with the unit and what it had left; that record is the only
    place a panel unit's HP survives, because no board holds it.

    **Mending is deliberately not applied here.** A base closes an HP a turn,
    but that is derived from the ply schedule and is the client's display
    concern; the server wants this for validation - is the unit there, is it
    alive - and for that the recorded floor is the conservative answer. When
    the phase schedule lands server-side (stage 3) a mending variant can wrap
    this. Mirrors the settled half of ``panelHp`` in game-room.component.ts.
    """
    left: Dict[str, int] = {}
    for move in history or []:
        if not isinstance(move, dict) or not move.get('intoPanel'):
            continue
        unit = move.get('unit') or {}
        uid = unit.get('uid')
        if not uid or move.get('defenderHp') is None:
            continue
        left[uid] = move['defenderHp'] or 0
    return left


#: What a base closes on each of its wounded at the end of its side's turn.
#: The owner's placeholder - "1hp (for now at least)". Mirrors
#: BASE_HEAL_PER_TURN in game-room.component.ts.
BASE_HEAL_PER_TURN = 1


def mended_since(color: str, since: Optional[int], now: int) -> int:
    """
    What a unit in a base has mended between the ply its HP was last written
    down and the ply about to be played.

    Counted in the side's OWN hand-overs, not in plies: a base mends at the
    end of its owner's turn, so a unit standing through a white ply and a black
    ply takes one HP back, not two. ``now`` is the ply about to be played, so
    the last one finished is ``now - 1``. Mirrors ``mendedSince``.
    """
    if since is None:
        return 0
    return max(0, hand_overs_by(color, now - 1) - hand_overs_by(color, since)) \
        * BASE_HEAL_PER_TURN


def panel_hp(history: Iterable[Dict[str, Any]], ply: int) -> Dict[str, int]:
    """
    Each panel unit's HP as of *ply*: its last word, plus whatever a base has
    mended since. Mirrors ``panelHp`` in game-room.component.ts.

    **A base mends and a reserve does not**, so this reads the panel off the
    record rather than off the unit. This is the HP the client draws, and so
    the HP a blow has to be struck from - striking from the unmended figure
    instead drops the unit by more than the preview promised.
    """
    wounds: Dict[str, Dict[str, Any]] = {}
    for move in history or []:
        if not isinstance(move, dict) or not move.get('intoPanel'):
            continue
        unit = move.get('unit') or {}
        uid = unit.get('uid')
        if not uid or move.get('defenderHp') is None:
            continue
        wounds[uid] = {
            'left': move.get('defenderHp') or 0,
            'turn': move.get('turn'),
            'full': unit.get('max_hp') or unit.get('hp') or 0,
            'color': unit.get('color'),
            'mends': move.get('panel') in BASE_PANELS,
        }
    hp: Dict[str, int] = {}
    for uid, wound in wounds.items():
        # Nothing mends back from nothing: 0 is what killed in a panel means.
        if wound['left'] <= 0:
            hp[uid] = 0
            continue
        mended = mended_since(wound['color'], wound['turn'], ply) if wound['mends'] else 0
        hp[uid] = min(wound['full'], wound['left'] + mended)
    return hp


def departed_uids(history: Iterable[Dict[str, Any]]) -> frozenset:
    """
    Panel units that have stepped onto the battlefield, by uid.

    A panel keeps its dealt squad for the whole game, so without this a unit
    that crossed and was later killed would be dealt back into its old panel
    hex, alive and ready to cross again - the board it died on no longer names
    it. Mirrors ``departedUids``.
    """
    out = set()
    for move in history or []:
        if not isinstance(move, dict) or not move.get('entered'):
            continue
        uid = (move.get('unit') or {}).get('uid')
        if uid:
            out.add(uid)
    return frozenset(out)


def withdrawn_units(
    history: Iterable[Dict[str, Any]],
    ply: Optional[int] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Units that walked off the battlefield into their own base, by uid.

    Keyed by uid rather than by the hex they landed on: a unit shuffled off its
    landing hex frees it for the next one home, and keying by hex would have
    the second record quietly erase the first. Each entry carries where it
    landed, the unit as it stood when it left, and the ply it was last spoken
    for - a later blow that found it at home moves that on.

    Mirrors ``withdrawnUnits``. Given the ply about to be played, each unit has
    whatever its base has mended since its last word added on, never past its
    full HP; without one, the recorded HP is returned as it stands.
    """
    home: Dict[str, Dict[str, Any]] = {}
    for move in history or []:
        if not isinstance(move, dict):
            continue
        unit = move.get('unit') or {}
        uid = unit.get('uid')
        if move.get('withdrawn') and unit:
            home[uid or move.get('to', '')] = {
                'at': move.get('to'),
                'unit': unit,
                'hp': unit.get('hp', 0),
                'turn': move.get('turn'),
            }
            continue
        # Something that set a panel unit's HP while it stood in its base - a
        # blow, or an ability. Reserves are not in here; they are dealt from
        # the roster and read `recorded_panel_hp` instead.
        if not move.get('intoPanel') or not uid or move.get('defenderHp') is None:
            continue
        standing = home.get(uid)
        if standing:
            standing['hp'] = move.get('defenderHp') or 0
            standing['turn'] = move.get('turn')
    # Killed where it stood is killed: not drawn, and not mended back to life.
    alive = {uid: stood for uid, stood in home.items() if stood['hp'] > 0}
    if ply is None:
        return alive
    # A unit that walked home is in a base by definition, so it always mends.
    for stood in alive.values():
        unit = stood['unit']
        full = unit.get('max_hp') or unit.get('hp') or 0
        stood['hp'] = min(
            full, stood['hp'] + mended_since(unit.get('color'), stood['turn'], ply))
    return alive


def panel_occupancy(
    config: Dict[str, Any],
    radius: int,
    history: Iterable[Dict[str, Any]],
    orientation: str = 'edge-up',
    ply: Optional[int] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Everything standing in a panel right now, by hex key.

    The dealt squad less whoever has crossed or been killed, plus everyone who
    has walked home. This is the answer a crossing has to be validated against,
    and it is derived wholly from the config and the move history - there is no
    panel state anywhere to fall out of step with it.

    **Pass the ply** wherever HP matters - a blow, or a crossing that puts a
    unit on the board with its HP - so the bases have mended exactly as far as
    the client draws them. Without it the recorded HP is used as it stands,
    which is fine for "is anyone there" and wrong for "how much is left".
    """
    moves = [move for move in (history or []) if isinstance(move, dict)]
    wounds = recorded_panel_hp(moves) if ply is None else panel_hp(moves, ply)
    home = withdrawn_units(moves, ply)

    # Where each unit stands, by uid, replayed from the deal in the order things
    # happened. It used to be two sets - the dealt squad less whoever had ever
    # crossed, plus whoever had ever walked home - which was right only while a
    # unit could reach a panel at most once. With panel moves recorded a unit
    # can cross, walk home, wrap back into its reserve and cross again, and no
    # arrangement of sets can say where it is at the end of that.
    positions: Dict[str, Dict[str, Any]] = {}
    for at, unit in deal_panels(config, radius, orientation).items():
        positions[unit['uid']] = {'at': at, 'unit': unit, 'home': False}
    for move in moves:
        unit = move.get('unit') or {}
        uid = unit.get('uid')
        if move.get('withdrawn') and unit:
            key = uid or move.get('to', '')
            positions[key] = {'at': move.get('to'), 'unit': dict(unit), 'home': True}
        elif move.get('panelMove') and uid in positions:
            positions[uid]['at'] = move.get('to')
        elif move.get('entered') and uid:
            positions.pop(uid, None)

    standing: Dict[str, Dict[str, Any]] = {}
    for uid, stood in positions.items():
        unit = dict(stood['unit'])
        if stood['home']:
            # A unit that walked home keeps its HP in its own record and in any
            # blow that later found it there - not in the dealt squad's wounds.
            alive = home.get(uid)
            if not alive:
                continue
            unit['hp'] = alive['hp']
        else:
            left = wounds.get(uid, unit.get('hp'))
            if left is not None and left <= 0:
                continue
            unit['hp'] = left
        at = stood['at']
        try:
            aq, ar = parse_key(at)
        except (ValueError, TypeError):
            continue
        # Read off where it stands NOW: a unit wrapped out of its base is a
        # reserve unit, and answers blows as one.
        unit['panel'] = panel_of(*axial_to_pixel(aq, ar, orientation))
        standing[at] = unit
    return standing


def panel_at(
    config: Dict[str, Any],
    radius: int,
    history: Iterable[Dict[str, Any]],
    key: str,
    orientation: str = 'edge-up',
) -> Optional[Dict[str, Any]]:
    """The unit standing on this panel hex, or None."""
    return panel_occupancy(config, radius, history, orientation).get(key)


def is_base(panel: Optional[str]) -> bool:
    """Whether this panel mends its wounded and refuses to counter-attack."""
    return panel in BASE_PANELS


#: How deep a side's own ground runs from its own edge inwards - the "first
#: three rows". Mirrors ``HOME_ROWS`` in hex-rules.ts.
HOME_ROWS = 3


def in_home_rows(color: str, r: int, radius: int) -> bool:
    """
    Whether row ``r`` is one of *color*'s own first three.

    The ground a side deploys onto, and now the ground that bounds both ends of
    a unit's journey off the board: a crossing out of the reserve may not land
    beyond it, and a unit may only walk home from inside it.

    White's edge is positive ``r`` and black's negative, so on radius 11 white
    holds rows 9, 10 and 11 and black the mirror. Read off the radius rather
    than off the placement, because this marks the ground a side *owns* - still
    its ground on a config that leaves some of those hexes empty. Mirrors the
    board's ``homeOf``, which tints exactly these rows.
    """
    edge = max(1, radius - (HOME_ROWS - 1))
    return r >= edge if color == 'white' else r <= -edge


# ---------------------------------------------------------------------------
# Walking, and stepping out onto the board
# ---------------------------------------------------------------------------

def parse_key(key: str) -> Coord:
    """"q,r" back to a pair. Raises ValueError on anything malformed."""
    q_str, _, r_str = str(key).partition(',')
    return int(q_str), int(r_str)


def move_costs(
    units: Dict[str, Dict[str, Any]],
    sq: int,
    sr: int,
    config: Dict[str, Any],
    radius: int,
    moves_left: Optional[int] = None,
    zone: Optional[Sequence[str]] = None,
) -> Tuple[Dict[str, int], Dict[str, int]]:
    """
    What the unit at (sq, sr) can reach, and at what cost. Mirrors
    ``computeMoveCosts``.

    Returns ``(costs, passable)``. The split matters: **a unit walks through
    its own.** An ally costs a step to pass but is not somewhere to stop, so it
    lands in ``passable`` and never limits the reach beyond it; an enemy blocks
    both the hex and the way past it. The crossings need this, because a friend
    standing on a gateway is walked past rather than walked into.

    ``zone`` confines the walk to a set of hexes - a panel - instead of the
    battlefield.
    """
    costs: Dict[str, int] = {}
    passable: Dict[str, int] = {}
    piece = units.get(coord_key(sq, sr))
    if not piece:
        return costs, passable
    unit_def = (config.get('units') or {}).get(piece.get('unit_id')) or {}
    move_range = unit_def.get('move', 0) if moves_left is None else moves_left
    try:
        move_range = int(move_range)
    except (TypeError, ValueError):
        return costs, passable
    if move_range <= 0:
        return costs, passable

    allowed_zone = None if zone is None else set(zone)
    visited = {coord_key(sq, sr)}
    frontier: List[Coord] = [(sq, sr)]
    for step in range(1, move_range + 1):
        nxt: List[Coord] = []
        for cq, cr in frontier:
            for dq, dr in HEX_DIRS:
                nq, nr = cq + dq, cr + dr
                key = coord_key(nq, nr)
                allowed = (
                    key in allowed_zone if allowed_zone is not None
                    else on_battlefield(nq, nr, radius)
                )
                if key in visited or not allowed:
                    continue
                visited.add(key)
                blocker = units.get(key)
                if blocker and blocker.get('color') != piece.get('color'):
                    continue
                if blocker:
                    passable[key] = step
                else:
                    costs[key] = step
                nxt.append((nq, nr))
        if not nxt:
            break
        frontier = nxt
    return costs, passable


def entry_targets(
    config: Dict[str, Any],
    radius: int,
    occupancy: Dict[str, Dict[str, Any]],
    board_state: Dict[str, Dict[str, Any]],
    from_key: str,
    orientation: str = 'edge-up',
    moves_left: Optional[int] = None,
) -> Dict[str, int]:
    """
    Every battlefield hex the panel unit on ``from_key`` may step onto, by the
    MOV it costs to get there. Mirrors ``addGateway``.

    The crossing is: walk to one of your own gateway hexes inside the panel,
    then **one more step** through the gap, then carry on across the board with
    whatever is left. An enemy on the landing hex shuts that way in; one of
    your own is stepped over, because you simply cannot stop on it.

    An empty result means no legal crossing - out of MOV, no gateway of that
    colour reachable, or every way in blocked.
    """
    unit = occupancy.get(from_key)
    if not unit:
        return {}
    try:
        fq, fr = parse_key(from_key)
    except ValueError:
        return {}
    color = unit.get('color')
    panel = unit.get('panel')
    if not panel:
        panel = panel_of(*axial_to_pixel(fq, fr, orientation))
    zone = panel_zones(radius, orientation).get(panel)
    if not zone:
        return {}

    unit_def = (config.get('units') or {}).get(unit.get('unit_id')) or {}
    mov = unit_def.get('move', 0) if moves_left is None else moves_left
    try:
        mov = int(mov)
    except (TypeError, ValueError):
        return {}

    costs, passable = move_costs(
        occupancy, fq, fr, config, radius, mov, zone)
    # `costAt` accepts a hex the walk passes THROUGH as well as one it can stop
    # on, so a friend standing on the gateway does not shut the crossing.
    reach = dict(costs)
    reach.update(passable)
    reach[from_key] = 0

    out: Dict[str, int] = {}
    for gate, arrow in gateway_hexes(radius).items():
        if arrow['color'] != color:
            continue
        to_gate = reach.get(gate)
        if to_gate is None:
            continue
        spent = to_gate + 1
        left = mov - spent
        if left < 0:
            continue
        gq, gr = parse_key(gate)
        for dq, dr in HEX_DIRS:
            eq, er = gq + dq, gr + dr
            entry = coord_key(eq, er)
            if not on_battlefield(eq, er, radius):
                continue
            standing = board_state.get(entry)
            if standing and standing.get('color') != color:
                continue
            if not standing and spent < out.get(entry, math.inf):
                out[entry] = spent
            if left == 0:
                continue
            # On across the board with what is left. The unit is put on the
            # entry hex for that pass, because the flood reads the mover off
            # the board it is given and it has not actually stepped in yet.
            onward = dict(board_state)
            onward[entry] = unit
            onward_costs, _ = move_costs(
                onward, eq, er, config, radius, left)
            for hex_key, cost in onward_costs.items():
                total = spent + cost
                if total < out.get(hex_key, math.inf):
                    out[hex_key] = total
    # A crossing lands in its own first three rows and goes no further. The
    # owner's rule, and a limit on where the walk STOPS, not on where it goes:
    # the flood above may route through a fourth row and come back, the same
    # way it may pass over a friend it cannot stop on.
    return {
        hex_key: cost for hex_key, cost in out.items()
        if in_home_rows(color, parse_key(hex_key)[1], radius)
    }


def homecoming_targets(
    config: Dict[str, Any],
    radius: int,
    occupancy: Dict[str, Dict[str, Any]],
    board_state: Dict[str, Dict[str, Any]],
    from_key: str,
    orientation: str = 'edge-up',
    moves_left: Optional[int] = None,
) -> Dict[str, int]:
    """
    Every hex in its own base the board unit on ``from_key`` may walk home to,
    by the MOV it costs. Mirrors ``addBaseEntry``.

    The walk home is the crossing run backwards: reach a battlefield hex beside
    one of your own base doorways, **one more step** onto the doorway, then on
    into the base with whatever is left, confined to that panel. A unit walks
    home within its MOV like it walks anywhere else - the owner has said twice
    that it does not teleport in from across the board.

    An enemy in the doorway shuts it; one of your own is stepped over. The
    doorway is a *panel* hex, so the question is asked of the panel occupancy -
    the board never holds a panel hex and could not answer it.

    **The king never walks home** - the owner's rule. A commander belongs on
    the board, the way :func:`panel_roster` never deals one into a panel, so he
    is offered nowhere. Walked home, he was off the board, and under regicide a
    side with no commander on it has lost.

    The browser engine checks none of this. It takes any off-board hex on the
    mover's own side by a sign-of-q test, which would let a unit land in the
    wrong panel entirely, or from anywhere on the board.
    """
    unit = board_state.get(from_key)
    if not unit:
        return {}
    try:
        fq, fr = parse_key(from_key)
    except ValueError:
        return {}
    color = unit.get('color')
    unit_def = (config.get('units') or {}).get(unit.get('unit_id')) or {}
    if unit_def.get('commander'):
        return {}
    # Only from your own first three rows. The owner's rule, and the same bound
    # a crossing lands inside: a unit that has pushed up the board has to walk
    # back down into its own ground before it can walk off it. Asked of where
    # the unit STANDS, not of where the walk passes - the doorways are in the
    # base and the route to them runs through these rows anyway.
    if not in_home_rows(color, fr, radius):
        return {}
    mov = unit_def.get('move', 0) if moves_left is None else moves_left
    try:
        mov = int(mov)
    except (TypeError, ValueError):
        return {}

    costs, passable = move_costs(board_state, fq, fr, config, radius, mov)
    # `costAt`: where the unit already stands costs nothing, and a hex it could
    # only pass through still counts as reached.
    reach = dict(costs)
    reach.update(passable)
    reach[from_key] = 0

    zones = panel_zones(radius, orientation)
    out: Dict[str, int] = {}
    for gate, mark in base_gateway_hexes(radius).items():
        if mark['color'] != color:
            continue
        in_door = occupancy.get(gate)
        if in_door and in_door.get('color') != color:
            continue
        gq, gr = parse_key(gate)
        to_edge = math.inf
        for dq, dr in HEX_DIRS:
            nq, nr = gq + dq, gr + dr
            if not on_battlefield(nq, nr, radius):
                continue
            cost = reach.get(coord_key(nq, nr))
            if cost is not None:
                to_edge = min(to_edge, cost)
        spent = to_edge + 1
        if not math.isfinite(spent):
            continue
        left = mov - spent
        if left < 0:
            continue
        # A doorway derived from coordinates alone need not be a hex the board
        # draws - another orientation can put it outside the block - and with
        # no panel to confine it the walk beyond would flood the battlefield.
        zone = zones.get(panel_of(*axial_to_pixel(gq, gr, orientation)))
        if not zone or gate not in zone:
            continue
        if not in_door and spent < out.get(gate, math.inf):
            out[gate] = int(spent)
        if left == 0:
            continue
        # On into the base with what is left. The unit is put on the doorway
        # for that pass, because the flood reads the mover off the units it is
        # handed.
        onward = dict(board_state)
        onward.update(occupancy)
        onward[gate] = unit
        onward.pop(from_key, None)
        onward_costs, _ = move_costs(
            onward, gq, gr, config, radius, int(left), zone)
        for hex_key, cost in onward_costs.items():
            total = int(spent) + cost
            if total < out.get(hex_key, math.inf):
                out[hex_key] = total
    return out


# ---------------------------------------------------------------------------
# Walking inside a panel, and the wrap
# ---------------------------------------------------------------------------

def _is_panel_step(move: Any) -> bool:
    """A walk inside a panel or a crossing out of one - a panel unit's move."""
    return isinstance(move, dict) and bool(move.get('panelMove') or move.get('entered'))


def walked_this_ply(history: Iterable[Dict[str, Any]], uid: str, ply: int) -> int:
    """
    The MOV a panel unit has already spent this ply, across every step it took.

    A panel unit is walked a few steps at a time, so its budget is what is left
    of its MOV rather than the whole stat. Mirrors `panelMoved`, which the
    client kept in memory and lost on a reload - these are the records now.
    """
    total = 0
    for move in history or []:
        if not isinstance(move, dict) or not move.get('panelMove'):
            continue
        if move.get('turn') != ply or (move.get('unit') or {}).get('uid') != uid:
            continue
        total += int(move.get('cost') or 0)
    return total


def homecomings_at(
    history: Iterable[Dict[str, Any]], ply: int, color: str,
) -> frozenset:
    """
    The units of *color* walked home this ply. Mirrors ``homecomingsAt`` in
    history-rules.ts.

    Keyed by uid, from the record's own copy of the unit as it left the board -
    the only place a withdrawn unit survives. A set rather than a count because
    a unit walks home in one record and could not be counted twice anyway; the
    set makes that explicit rather than lucky.
    """
    out = set()
    for move in history or []:
        if not isinstance(move, dict) or move.get('turn') != ply:
            continue
        if not move.get('withdrawn'):
            continue
        unit = move.get('unit') or {}
        if unit.get('color') != color:
            continue
        uid = unit.get('uid')
        if uid:
            out.add(uid)
    return frozenset(out)


def panel_movers(
    history: Iterable[Dict[str, Any]], ply: int, color: str,
) -> Dict[str, set]:
    """
    The units of *color* walked this ply, split by the panel each walk began in.

    Mirrors `panelMoversAt` in history-rules.ts (and the board's own running
    `baseMovers` / `reserveMovers`, which it keeps to draw an unrecorded turn).
    The wrap starts in the base, so it
    spends a base mover; a crossing starts in the reserve and spends a reserve
    one. One set each, because the cap is a per-panel allowance, and counting one
    panel's walks against the other spends it on units it was never about.
    """
    movers: Dict[str, set] = {'base': set(), 'reserve': set()}
    for move in history or []:
        if not isinstance(move, dict) or move.get('turn') != ply:
            continue
        unit = move.get('unit') or {}
        uid = unit.get('uid')
        if not uid or unit.get('color') != color:
            continue
        if move.get('entered'):
            movers['reserve'].add(uid)
        elif move.get('panelMove'):
            movers['base' if is_base(move.get('panel')) else 'reserve'].add(uid)
    return movers


def locked_units(history: Iterable[Dict[str, Any]], ply: int) -> frozenset:
    """
    Panel units that may not move again for the rest of the opening.

    Through the initialization a unit gets one move for the whole phase, so one
    that moved on an earlier turn of it stays out until the phase ends - and
    only then. Mirrors `lockedPanelUnits` in history-rules.ts, and the board's
    own `lockedUnits`, which is filled as each opening ply turns over and
    emptied the moment the phase is gone.
    """
    from .phases import is_initialization

    if not is_initialization(ply):
        return frozenset()
    out = set()
    for move in history or []:
        if not _is_panel_step(move):
            continue
        turn = move.get('turn')
        if turn is None or turn >= ply or not is_initialization(turn):
            continue
        uid = (move.get('unit') or {}).get('uid')
        if uid:
            out.add(uid)
    return frozenset(out)


def panel_allowance(
    config: Dict[str, Any],
    history: Iterable[Dict[str, Any]],
    unit: Dict[str, Any],
    ply: int,
) -> Optional[int]:
    """
    The MOV this panel unit may still spend this ply - or None if it may not
    move at all. Mirrors `panelCanMove` and `budgetFor`.

    None when it is locked out of the opening, or when its panel's three movers
    are used up and it is not one of them. Otherwise its move stat less what it
    has already walked, which may be 0.

    **In a phase initialization the reserve's cap is five, not three.** The
    owner's number, and it stands *instead of* the per-panel three rather than
    beside it. It governs walking inside the reserve as well as crossing out of
    it, because the two are the same allowance: capping the walk at three would
    leave two of the five unable to reach a gateway to spend their crossing on.
    The base keeps its three - nothing in the rule was about the base, and the
    wrap is shut on that turn anyway.
    """
    from .phases import PHASE_INIT_ENTRIES, is_phase_initialization

    moves = list(history or [])
    uid = unit.get('uid')
    if not uid or uid in locked_units(moves, ply):
        return None
    kind = 'base' if is_base(unit.get('panel')) else 'reserve'
    movers = panel_movers(moves, ply, unit.get('color'))[kind]
    cap = PANEL_MOVERS_PER_TURN
    if kind == 'reserve' and is_phase_initialization(ply):
        cap = PHASE_INIT_ENTRIES
    if uid not in movers and len(movers) >= cap:
        return None
    stat = ((config.get('units') or {}).get(unit.get('unit_id')) or {}).get('move', 0)
    try:
        stat = int(stat)
    except (TypeError, ValueError):
        return None
    return max(0, stat - walked_this_ply(moves, uid, ply))


def panel_move_targets(
    config: Dict[str, Any],
    radius: int,
    history: Iterable[Dict[str, Any]],
    board_state: Dict[str, Dict[str, Any]],
    from_key: str,
    ply: int,
    points: int,
    orientation: str = 'edge-up',
) -> Dict[str, Dict[str, int]]:
    """
    Every panel hex the unit on ``from_key`` may walk to this ply, with the MOV
    each costs and the points each costs. Mirrors the panel branch of
    ``refreshTargets``, and ``addWrap``.

    A walk stays inside the unit's own panel. A **base** unit may also take the
    wrap - out over its base's tip and onto its reserve's tip across the board -
    while the schedule has it open. The wrap costs one step on top of reaching
    the tip, and the unit's `value` in points; every hex reached by making it
    carries that price, because the price is for the crossing, not the hex.

    Out of MOV is judged before out of money, as the client judges it: telling
    someone to save up for a crossing they could not have reached anyway points
    at the wrong thing.
    """
    from .phases import is_wrap_open

    moves = list(history or [])
    occupancy = panel_occupancy(config, radius, moves, orientation, ply=ply)
    unit = occupancy.get(from_key)
    if not unit:
        return {}
    try:
        fq, fr = parse_key(from_key)
    except ValueError:
        return {}
    budget = panel_allowance(config, moves, unit, ply)
    if not budget:
        return {}
    panel = unit.get('panel')
    zones = panel_zones(radius, orientation)
    zone = zones.get(panel)
    if not zone:
        return {}

    # Everything on the board and in every panel, the way the client's
    # `occupancy` is: an enemy anywhere blocks, a friend anywhere is passed.
    everyone = dict(board_state)
    everyone.update(occupancy)
    costs, passable = move_costs(everyone, fq, fr, config, radius, budget, zone)
    out: Dict[str, Dict[str, int]] = {
        hex_key: {'cost': cost, 'price': 0} for hex_key, cost in costs.items()
    }

    if not is_base(panel) or not is_wrap_open(ply):
        return out
    color = unit.get('color')
    tips = wrap_tips(color, radius)
    reach = dict(costs)
    reach.update(passable)
    reach[from_key] = 0
    to_tip = reach.get(tips['base'])
    far = everyone.get(tips['reserve'])
    # An enemy on the far tip shuts the wrap - no landing and no way past. One
    # of your own only means you cannot stop there.
    if to_tip is None or (far and far.get('color') != color):
        return out
    spent = to_tip + 1
    left = budget - spent
    if left < 0:
        return out
    price = ((config.get('units') or {}).get(unit.get('unit_id')) or {}).get('value', 0) or 0
    price = int(price)
    if price > points:
        return out
    if not far:
        out[tips['reserve']] = {'cost': spent, 'price': price}
    if left == 0:
        return out

    wq, wr = parse_key(tips['reserve'])
    reserve_zone = zones.get(panel_of(*axial_to_pixel(wq, wr, orientation)))
    # The tips are arithmetic, so the far one need not be a hex this board
    # draws. No panel to confine the onward walk means no walk - otherwise the
    # flood falls back to the battlefield and offers a paid teleport onto it.
    if not reserve_zone or tips['reserve'] not in reserve_zone:
        return out
    onward = dict(everyone)
    onward[tips['reserve']] = unit
    onward.pop(from_key, None)
    beyond, _ = move_costs(onward, wq, wr, config, radius, left, reserve_zone)
    for hex_key, cost in beyond.items():
        total = spent + cost
        if hex_key in out and total >= out[hex_key]['cost']:
            continue
        out[hex_key] = {'cost': total, 'price': price}
    return out
