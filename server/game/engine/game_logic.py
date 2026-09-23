"""
Game logic - combat resolution and win-condition detection for a
Fire-Emblem-style hex-grid tactical game.

Key differences from chess:
  * Units have HP and attack stats.
  * Attacking an enemy deals damage; the defender is eliminated only when
    its HP drops to 0.  If the defender survives, the attacker stays put.
  * No check/checkmate/stalemate concepts.
  * The game ends when ALL units of one side are eliminated ("elimination").

All functions are pure (no DB access) and operate on a HexBoard + config.
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional, Tuple

from .board import HexBoard, CellData, Coord, hex_distance
from .move_validator import get_legal_moves


# ---------------------------------------------------------------------------
# Combat resolution
# ---------------------------------------------------------------------------

def ranged_damage(attack: int, distance: int, config: Dict[str, Any]) -> int:
    """
    Damage an attack of *attack* deals at *distance* rings.

    Striking a neighbour (distance 1) costs nothing. Every further ring loses
    ``rules.rangeFalloff`` of the attack stat, linearly, floored - a hit that
    lands at all always takes off at least 1.
    """
    if attack <= 0 or distance <= 1:
        return max(0, attack)
    falloff = config.get('rules', {}).get('rangeFalloff', 0)
    scale = max(0.0, 1.0 - falloff * (distance - 1))
    return max(1, int(attack * scale))


#: Fallback for a config that names no floor at all. `_normalise_config` fills
#: `rules.minStrikeDamage` in from DEFAULT_CONFIG, so this is only reached by a
#: caller that hand-built a config dict without going through `load_config` -
#: several tests do exactly that.
MIN_STRIKE_DAMAGE = 1


def strike_damage(
    attacker_def: Dict[str, Any],
    defender_def: Dict[str, Any],
    distance: int,
    config: Dict[str, Any],
) -> int:
    """
    Damage one unit lands on another: the attacker's ring-scaled attack stat
    less the defender's defence.

    Armour blunts a hit down to ``rules.minStrikeDamage`` but never turns it
    aside entirely, and never heals. At the default of 1 a blow that lands
    always takes something off; at 0 armour can absorb one whole, which is
    what left a pawn (14 attack) unable to scratch a shieldman (18 defence).

    An attack of nothing stays nothing either way: the floor lifts a blow that
    was blunted, not one that was never thrown.

    Read off the config rather than a constant so the browser and the server
    cannot drift - the same config object carries `rangeFalloff` to
    `ranged_damage` a few lines up, and `hex-rules.ts` reads this same field.
    """
    attack = ranged_damage(attacker_def.get('attack', 1), distance, config)
    if attack <= 0:
        return 0
    # Never more than the attacker could deal unblunted. The floor lifts a hit
    # that armour absorbed; it is not a damage source of its own, and without
    # this clamp a large ``minStrikeDamage`` would override the attack stat
    # outright - every blow dealing the floor regardless of attack, defence or
    # ring falloff, which makes all three dead config.
    floor = config.get('rules', {}).get('minStrikeDamage', MIN_STRIKE_DAMAGE)
    return min(attack, max(floor, attack - defender_def.get('defense', 0)))


def resolve_combat(
    board: HexBoard,
    from_coord: Coord,
    to_coord: Coord,
    config: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Resolve a move from *from_coord* to *to_coord*.

    Returns a dict describing the outcome:
      {
        "moved": bool,           # did the attacker change position?
        "attacked": bool,        # was this an attack (target had enemy)?
        "damage_dealt": int,     # damage dealt to defender
        "defender_eliminated": bool,
        "captured_unit": {...} | None,  # CellData of eliminated unit
        "defender_hp": int | None,      # defender remaining HP (if survived)
      }

    Side-effects: mutates *board* in place (moves pieces / reduces HP).
    """
    attacker = board.get(*from_coord)
    if attacker is None:
        raise ValueError(f"No piece at {from_coord}")

    defender = board.get(*to_coord)

    # -- Empty hex -> simple move -----------------------------------
    if defender is None:
        board.move(*from_coord, *to_coord)
        return {
            'moved': True,
            'attacked': False,
            'damage_dealt': 0,
            'defender_eliminated': False,
            'captured_unit': None,
            'defender_hp': None,
        }

    # -- Occupied by enemy -> combat --------------------------------
    units = config.get('units', {})
    attacker_def = units.get(attacker['unit_id'], {})
    defender_def = units.get(defender['unit_id'], {})
    distance = hex_distance(from_coord, to_coord)

    # Damage is what gets past armour: the ring-scaled attack stat minus the
    # defender's defence, never healing them.
    atk_damage = strike_damage(attacker_def, defender_def, distance, config)
    eliminated = board.deal_damage(*to_coord, atk_damage)

    result: Dict[str, Any] = {
        'moved': False,
        'attacked': True,
        'damage_dealt': atk_damage,
        'defender_eliminated': eliminated is not None,
        'captured_unit': eliminated,
        'defender_hp': None,
        'counter_damage': 0,
        'attacker_eliminated': False,
        'attacker_hp': attacker.get('hp'),
    }

    if eliminated:
        # A dead unit never swings back. The attacker holds its ground -
        # taking the hex is a move, and its move was spent attacking.
        return result

    surviving_cell = board.get(*to_coord)
    result['defender_hp'] = surviving_cell['hp'] if surviving_cell else None

    # Counter-attack: the same sum in reverse, and only if the attacker is
    # inside the defender's own reach.
    if distance <= defender_def.get('attackRange', 1):
        counter = strike_damage(defender_def, attacker_def, distance, config)
        if counter > 0:
            killed = board.deal_damage(*from_coord, counter)
            result['counter_damage'] = counter
            result['attacker_eliminated'] = killed is not None
        attacker_cell = board.get(*from_coord)
        result['attacker_hp'] = attacker_cell['hp'] if attacker_cell else None

    return result


def resolve_panel_attack(
    board: HexBoard,
    config: Dict[str, Any],
    history: List[Dict[str, Any]],
    from_key: str,
    to_key: str,
    attack_key: str,
    color: str,
    turn: int,
    orientation: str = 'edge-up',
) -> Dict[str, Any]:
    """
    A board unit walks (optionally) and strikes a unit standing in a panel.

    Returns ``{'error': message}`` and leaves *board* untouched if the blow is
    not legal, or ``{'record': ..., 'counters': bool}`` having applied it -
    the walk, and any counter-attack's damage to the attacker. The panel unit's
    own HP lives in the record and nowhere else, because no board holds it.

    Mirrors ``attackIntoPanel`` in the browser engine, except in the three
    places where that engine takes the client's word:

    * **The defender** is found in the panel occupancy derived from the config
      and the move history, not read off the message.
    * **Which panel it stands in** is derived the same way. The record carries
      it because it is what tells the mending a base from a reserve after a
      reload, when the board that knew is long gone.
    * **Whether it answers** is derived from that panel. A base never
      counter-attacks; a reserve does. The browser engine does not implement
      this rule at all - it arrives there as a `counters` boolean the client
      sets - so a server that trusted the same flag would let any client
      switch off the counter against its own blows.

    Ability boosts are ignored, as they are in ``_handle_make_move``: they live
    on the client, and honouring them would hand a free stat upgrade to anyone
    willing to edit a message.
    """
    from . import panels  # local: panels is geometry, and needs nothing here

    try:
        fq, fr = panels.parse_key(from_key)
        tq, tr = panels.parse_key(to_key)
        aq, ar = panels.parse_key(attack_key)
    except ValueError:
        return {'error': 'Malformed move coordinates'}

    attacker = board.get(fq, fr)
    if not attacker or attacker.get('color') != color:
        return {'error': 'Nothing of yours to attack with there'}

    walked = (tq, tr) != (fq, fr)
    if walked:
        legal = get_legal_moves(board, (fq, fr), config, color)
        if (tq, tr) not in legal:
            return {'error': 'Illegal move for this piece'}

    history = list(history or [])
    # With the ply, so a base has mended exactly as far as the client draws it.
    # Struck from the unmended figure, the unit drops by more than the preview
    # said it would.
    occupancy = panels.panel_occupancy(
        config, board.radius, history, orientation, ply=turn)
    defender = occupancy.get(attack_key)
    if not defender or defender.get('color') == color:
        return {'error': 'Nothing to attack there'}

    units = config.get('units', {})
    attacker_def = units.get(attacker['unit_id'], {})
    defender_def = units.get(defender['unit_id'], {})
    # Measured from where the unit ENDS UP, not where it started.
    distance = hex_distance((tq, tr), (aq, ar))
    if distance > attacker_def.get('attackRange', 1):
        return {'error': 'That hex is out of attack range'}

    # -- Legal. Everything below this line changes the board. ---------------
    if walked:
        board.move(fq, fr, tq, tr)

    dealt = strike_damage(attacker_def, defender_def, distance, config)
    left = max(0, (defender.get('hp') or 0) - dealt)
    panel = defender.get('panel')
    answers = not panels.is_base(panel)

    record: Dict[str, Any] = {
        'from': from_key,
        'to': to_key,
        'unit_id': attacker['unit_id'],
        'color': attacker['color'],
        'turn': turn,
        'captured': None,
        'attacked': True,
        'attackedHex': attack_key,
        'damage_dealt': dealt,
        'defender_eliminated': False,
        'moved': walked,
        'counter_damage': 0,
        'attacker_eliminated': False,
        'panelAttack': True,
        'intoPanel': True,
        # The panel unit as it stood before the blow. The client's derivations
        # read its uid, colour and max_hp; its HP after is `defenderHp`.
        'unit': {
            'unit_id': defender['unit_id'],
            'color': defender['color'],
            'hp': defender.get('hp'),
            'max_hp': defender.get('max_hp', defender_def.get('hp')),
            'uid': defender.get('uid'),
        },
        'defenderHp': left,
    }
    if panel:
        record['panel'] = panel

    if left <= 0:
        record['defender_eliminated'] = True
        record['captured'] = defender['unit_id']
    elif answers and distance <= defender_def.get('attackRange', 1):
        counter = strike_damage(defender_def, attacker_def, distance, config)
        record['counter_damage'] = counter
        if counter > 0:
            killed = board.deal_damage(tq, tr, counter)
            record['attacker_eliminated'] = killed is not None

    return {'record': record, 'counters': answers}


def opening_moved_hexes(history: List[Dict[str, Any]], color: str) -> set:
    """
    Where *color*'s battlefield units that have already moved in the opening
    now stand. Mirrors ``openingMovedHexes`` in
    client/src/app/services/history-rules.ts, which the room's ``initMovedHexes``
    and the offline engine both read through.

    Through the initialization a battlefield unit gets one move for the whole
    phase, not one a turn. Keyed by the hex it moved to, as the client keys it:
    nothing is captured in the opening - nobody may attack - so a unit that has
    moved is still standing where it landed, and a board move's record carries
    no uid. Crossings, walks home and walks inside a panel are not battlefield
    moves and are not counted.

    Both hex strings are normalised, because a record keeps whatever form the
    message used and a stray space would otherwise hide a moved unit.
    """
    from .phases import is_initialization

    out = set()
    for move in history or []:
        if not isinstance(move, dict) or move.get('color') != color:
            continue
        if move.get('entered') or move.get('withdrawn') or move.get('panelMove'):
            continue
        turn = move.get('turn')
        if turn is None or not is_initialization(turn):
            continue
        try:
            q_str, _, r_str = str(move.get('to', '')).partition(',')
            out.add(f"{int(q_str)},{int(r_str)}")
        except ValueError:
            continue
    return out


def board_moves_at(
    history: List[Dict[str, Any]], ply: int, color: str,
) -> int:
    """
    How many board moves of *color* this ply already holds. Mirrors
    ``boardMovesAt`` in history-rules.ts.

    What it is for: overtime's later stretches allow a side two or three moves
    on the main board, so "has this side moved yet" stopped being a yes/no and
    became a count - and the count has to come off the record, because the
    moves arrive as separate messages and only the last of them ends the turn.

    **A panel's move is not a board move.** A crossing (``entered``), a walk
    inside a panel (``panelMove``) and a cast's damage (``panelEffect``) each
    have an allowance of their own, and counting them here would spend the
    board's.

    **A walk home is one, except while setting out.** In overtime it *is* the
    turn's board action, so it counts against this; on a setup turn three may
    go as deployments and none of them is the turn's action.
    """
    from .phases import is_setup_turn

    setup = is_setup_turn(ply)
    moves = 0
    for move in history or []:
        if not isinstance(move, dict):
            continue
        if move.get('turn') != ply or move.get('color') != color:
            continue
        if move.get('panelMove') or move.get('entered') or move.get('panelEffect'):
            continue
        if move.get('withdrawn') and setup:
            continue
        moves += 1
    return moves


def board_move_landings(
    history: List[Dict[str, Any]], ply: int, color: str,
) -> set:
    """
    The hexes *color*'s board moves have already landed on this ply. Mirrors
    ``boardMoveLandings`` in history-rules.ts.

    **What stops a unit taking two of the turn's moves.** The allowance counts
    moves, and the owner's rule counts *units*. Without this a side in Overtime
    3 could move A, then B, then A again: each message is legal on its own,
    judged from where the unit stands with a full MOV, so the unit travelled
    twice its budget in one turn.

    A unit continuing a walk it has already begun is not this: the room folds
    those into one move and sends the origin it really set out from, so a
    ``from`` matching an earlier landing is always a second go.
    """
    out = set()
    for move in history or []:
        if not isinstance(move, dict):
            continue
        if move.get('turn') != ply or move.get('color') != color:
            continue
        if move.get('panelMove') or move.get('entered') or move.get('panelEffect'):
            continue
        # A walk home lands off the board: nothing left to move again.
        if move.get('withdrawn'):
            continue
        # Normalised the way ``opening_moved_hexes`` does: a hex arrives as
        # whatever string the client wrote, and "0,9" must not miss "0, 9".
        try:
            q_str, _, r_str = str(move.get('to', '')).partition(',')
            out.add(f"{int(q_str)},{int(r_str)}")
        except ValueError:
            continue
    return out


def overtime_toll(
    board: HexBoard,
    config: Dict[str, Any],
    color: str,
    ply: int,
) -> Optional[str]:
    """
    Take overtime's toll off *color*'s commander, at the end of that side's
    turn. Returns *color* if the toll killed him, otherwise None.

    Mirrors ``overtimeToll`` in the browser engine. *ply* is the hand-over just
    played - the toll is taken **before** the turn counter moves on, and before
    anyone is judged beaten, so a king the toll kills loses the match in the
    same message that killed him.

    Real damage, not a blow: defence does not blunt it, which is why this goes
    through ``deal_damage`` and not ``strike_damage``.

    Only a commander **on the board** pays, which is the only place one ever
    stands: he is never dealt into a panel and never walks home.
    **How much is the ply's business, not this function's.** Overtime runs in
    three stretches and the toll climbs 1, 2, 3 through them, so the amount
    comes from :func:`phases.overtime_toll_at` rather than a constant here.
    Outside overtime it answers ``0``, which is also the "not yet" gate: a
    separate ``ply < OVERTIME_FIRST_PLY`` check beside it would be a second
    place holding the schedule, and the two could disagree.
    """
    from .phases import overtime_toll_at

    toll = overtime_toll_at(ply)
    if not toll:
        return None
    units = config.get('units', {})
    for (q, r), cell in board.pieces_by_color(color).items():
        if not units.get(cell['unit_id'], {}).get('commander'):
            continue
        felled = board.deal_damage(q, r, toll)
        return color if felled is not None else None
    return None


# ---------------------------------------------------------------------------
# Legal-move helpers
# ---------------------------------------------------------------------------

def has_any_legal_move(
    board: HexBoard,
    color: str,
    config: Dict[str, Any],
) -> bool:
    """Return True if *color* has at least one legal move."""
    for coord in list(board.pieces_by_color(color).keys()):
        if get_legal_moves(board, coord, config, color):
            return True
    return False


def get_legal_moves_filtered(
    board: HexBoard,
    coord: Coord,
    config: Dict[str, Any],
    color: str,
    move_bonus: int = 0,
) -> List[Coord]:
    """
    Return all legal destinations for the piece at *coord*.

    In the tactical RPG model there is no self-check constraint, so this
    is a thin wrapper around ``move_validator.get_legal_moves``.
    """
    return get_legal_moves(board, coord, config, color, move_bonus)


# ---------------------------------------------------------------------------
# End-of-game detection
# ---------------------------------------------------------------------------

def find_defeated(board: HexBoard, config: Dict[str, Any]) -> Optional[str]:
    """
    The colour that has lost, or None while the game continues.

    Under the default ``regicide`` objective a side is beaten when it has no
    commander left - the unit whose config carries ``commander: true``. Under
    ``elimination`` it takes losing every unit. Either way a side with nothing
    on the board is out, so a config with no commander still terminates.

    Both sides can fall in the same exchange (a counter-attack that kills the
    last commander of the attacker); white is reported first, arbitrarily. Use
    :func:`defeated_sides` where that difference decides a result - crediting
    the win by list order hands the game to a side that is just as dead.
    """
    sides = defeated_sides(board, config)
    return sides[0] if sides else None


def defeated_sides(board: HexBoard, config: Dict[str, Any]) -> List[str]:
    """Every colour that has lost, in board order - both when both fell."""
    objective = config.get('rules', {}).get('objective', 'regicide')
    units = config.get('units', {})

    out: List[str] = []
    for color in ('white', 'black'):
        pieces = board.pieces_by_color(color)
        if not pieces:
            out.append(color)
        elif objective == 'regicide' and not any(
            units.get(cell['unit_id'], {}).get('commander') for cell in pieces.values()
        ):
            out.append(color)
    return out


def detect_outcome(
    board: HexBoard,
    color_to_move: str,
    config: Dict[str, Any],
) -> Optional[str]:
    """
    Back-compat wrapper: the *reason* the game ended, without saying who lost.
    Prefer `find_defeated`, which is what the consumer needs to name a winner.
    """
    return 'elimination' if find_defeated(board, config) else None


def is_attacked(
    board: HexBoard,
    target: Coord,
    by_color: str,
    config: Dict[str, Any],
) -> bool:
    """Return True if any piece of *by_color* can reach *target*."""
    for coord in list(board.pieces_by_color(by_color).keys()):
        if target in get_legal_moves(board, coord, config, by_color):
            return True
    return False
