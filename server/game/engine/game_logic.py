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


def strike_damage(
    attacker_def: Dict[str, Any],
    defender_def: Dict[str, Any],
    distance: int,
    config: Dict[str, Any],
) -> int:
    """
    Damage one unit lands on another: the attacker's ring-scaled attack stat
    less the defender's defence. Armour can absorb a hit entirely, but never
    heals - the result floors at 0.
    """
    attack = ranged_damage(attacker_def.get('attack', 1), distance, config)
    return max(0, attack - defender_def.get('defense', 0))


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
    last commander of the attacker); white is reported first, arbitrarily.
    """
    objective = config.get('rules', {}).get('objective', 'regicide')
    units = config.get('units', {})

    for color in ('white', 'black'):
        pieces = board.pieces_by_color(color)
        if not pieces:
            return color
        if objective == 'regicide':
            if not any(units.get(cell['unit_id'], {}).get('commander') for cell in pieces.values()):
                return color
    return None


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
