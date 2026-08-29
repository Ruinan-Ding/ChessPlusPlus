"""
Move validator - fully config-driven.

The engine knows nothing about specific unit types. Every unit's movement is
described by a single ``move`` stat: the number of adjacent-hex steps it can
take per turn. Unit ids ('king', 'knight', ...) are opaque labels; renaming a
unit or adding a brand-new one requires no engine changes.

Movement is a flood fill (BFS) outward through the six hex neighbours, up to
``move`` steps, through empty hexes only. A unit can never move through OR
onto an occupied hex - own and enemy pieces both block equally, so a blocked
path must be routed around rather than jumped. There is no separate
capture-by-moving here: attack is a different action from movement.

Hex geometry reference: https://www.redblobgames.com/grids/hexagons/
"""

from __future__ import annotations
from typing import Any, Dict, List, Set

from .board import HexBoard, Coord

# ---------------------------------------------------------------------------
# Core validation
# ---------------------------------------------------------------------------

def get_legal_moves(
    board: HexBoard,
    coord: Coord,
    config: Dict[str, Any],
    color: str,
    move_bonus: int = 0,
) -> List[Coord]:
    """
    Return all legal destination coordinates for the piece at *coord*.

    The piece must belong to *color*. An empty or wrong-colour source
    returns an empty list. Movement comes purely from the unit's ``move``
    stat - there is no per-unit engine logic - plus *move_bonus*, the extra
    steps a one-turn ability has lent this unit.
    """
    piece = board.get(*coord)
    if not piece or piece['color'] != color:
        return []

    unit_def = config.get('units', {}).get(piece['unit_id'])
    if not unit_def:
        return []

    move_range = unit_def.get('move', 0) + max(0, move_bonus)
    if move_range <= 0:
        return []

    visited: Set[Coord] = {coord}
    frontier: List[Coord] = [coord]
    moves: List[Coord] = []

    for _ in range(move_range):
        next_frontier: List[Coord] = []
        for cq, cr in frontier:
            for nq, nr in board.valid_neighbours(cq, cr):
                if (nq, nr) in visited:
                    continue
                visited.add((nq, nr))
                if board.get(nq, nr) is not None:
                    continue  # occupied - blocks entry and further passage
                moves.append((nq, nr))
                next_frontier.append((nq, nr))
        if not next_frontier:
            break
        frontier = next_frontier

    return moves


def is_legal_move(
    board: HexBoard,
    from_coord: Coord,
    to_coord: Coord,
    config: Dict[str, Any],
    color: str,
) -> bool:
    """Quick check: is the move from -> to in the legal set?"""
    return to_coord in get_legal_moves(board, from_coord, config, color)
