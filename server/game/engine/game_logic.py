"""
Game logic — combat resolution and win-condition detection for a
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

from .board import HexBoard, CellData, Coord
from .move_validator import get_legal_moves


# ---------------------------------------------------------------------------
# Combat resolution
# ---------------------------------------------------------------------------

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

    # ── Empty hex → simple move ───────────────────────────────────
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

    # ── Occupied by enemy → combat ────────────────────────────────
    unit_def = config.get('units', {}).get(attacker['unit_id'], {})
    atk_damage = unit_def.get('attack', 1)

    eliminated = board.deal_damage(*to_coord, atk_damage)

    result: Dict[str, Any] = {
        'moved': False,
        'attacked': True,
        'damage_dealt': atk_damage,
        'defender_eliminated': eliminated is not None,
        'captured_unit': eliminated,
        'defender_hp': None,
    }

    if eliminated:
        # Defender destroyed → attacker moves in
        board.move(*from_coord, *to_coord)
        result['moved'] = True
    else:
        # Defender survived → attacker stays; record remaining HP
        surviving_cell = board.get(*to_coord)
        result['defender_hp'] = surviving_cell['hp'] if surviving_cell else None

    return result


# ---------------------------------------------------------------------------
# Legal-move helpers  (replaces the chess self-check filter)
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
) -> List[Coord]:
    """
    Return all legal destinations for the piece at *coord*.

    In the tactical RPG model there is no self-check constraint, so this
    is a thin wrapper around ``move_validator.get_legal_moves``.
    """
    return get_legal_moves(board, coord, config, color)


# ---------------------------------------------------------------------------
# End-of-game detection
# ---------------------------------------------------------------------------

def detect_outcome(
    board: HexBoard,
    color_to_move: str,
    config: Dict[str, Any],
) -> Optional[str]:
    """
    After a move has been made, call this to check if the game is over.

    Returns:
      - ``'elimination'`` if one side has zero pieces remaining.
      - ``None``          if the game continues.

    No stalemate: if a player has pieces but no moves, the turn simply
    passes (or the game continues until elimination).
    """
    white_count = len(board.pieces_by_color('white'))
    black_count = len(board.pieces_by_color('black'))

    if white_count == 0 or black_count == 0:
        return 'elimination'
    return None


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
