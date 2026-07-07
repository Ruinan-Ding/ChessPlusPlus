"""
Move validator — fully config-driven.

The engine knows NOTHING about specific unit types. Every unit's movement
is described entirely by the ``movement`` patterns in its config entry.
Unit ids ('king', 'knight', …) are opaque labels; renaming a unit or adding
a brand-new one requires no engine changes.

Pattern types
-------------
1. Direction pattern — step/slide along a named direction:
       { "direction": "NW", "range": 1, "canJump": false,
         "moveOnly": false, "captureOnly": false }
   range 0 means unlimited (blocked by pieces unless canJump).

2. Offsets pattern — fixed jump targets relative to the unit:
       { "offsets": [[2, -1], [1, -2], ...],
         "moveOnly": false, "captureOnly": false }
   Offsets are inherently jumping (intervening pieces are ignored).

Directions
----------
Six cardinals (edge-adjacent) and six diagonals (the distance-2 hexes
reached by combining two adjacent cardinals):

    E  (+1,  0)   W  (-1,  0)
    NE (+1, -1)   SW (-1, +1)
    NW ( 0, -1)   SE ( 0, +1)
    DN  (+1, -2)  DS  (-1, +2)
    DNE (+2, -1)  DSW (-2, +1)
    DSE (+1, +1)  DNW (-1, -1)

Orientation convention
----------------------
All movement patterns are defined from WHITE's perspective and are
automatically mirrored (negated) for black. Symmetric movement sets
(e.g. "all 6 cardinals") are unaffected by mirroring, so this is safe
to apply universally — it only matters for asymmetric, pawn-like units.

Hex geometry reference: https://www.redblobgames.com/grids/hexagons/
"""

from __future__ import annotations
from typing import Any, Dict, List, Set, Tuple

from .board import HexBoard, HEX_DIRECTIONS, Coord

# ---------------------------------------------------------------------------
# Direction tables
# ---------------------------------------------------------------------------

# Full direction vocabulary available to config movement patterns.
# Diagonals are the 6 distance-2 hexes that share an edge-pair with the origin.
ALL_DIRECTIONS: Dict[str, Coord] = {
    **HEX_DIRECTIONS,
    'DN':  (+1, -2),
    'DS':  (-1, +2),
    'DNE': (+2, -1),
    'DSW': (-2, +1),
    'DSE': (+1, +1),
    'DNW': (-1, -1),
}

# ---------------------------------------------------------------------------
# Knight-style jump offsets (kept as a convenience constant for configs
# and tests — the engine itself never treats these specially).
# ---------------------------------------------------------------------------

_DIR_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE']  # ring order

def _compute_knight_offsets() -> List[Coord]:
    """The 12 hex 'L-shape' offsets: 2 steps in a cardinal + 1 in an adjacent one."""
    offsets: Set[Coord] = set()
    for i, d in enumerate(_DIR_LIST):
        dq, dr = HEX_DIRECTIONS[d]
        base_q, base_r = dq * 2, dr * 2
        for adj_idx in [(i - 1) % 6, (i + 1) % 6]:
            aq, ar = HEX_DIRECTIONS[_DIR_LIST[adj_idx]]
            offsets.add((base_q + aq, base_r + ar))
    return sorted(offsets)

KNIGHT_OFFSETS: List[Coord] = _compute_knight_offsets()

# ---------------------------------------------------------------------------
# Core validation
# ---------------------------------------------------------------------------

def get_legal_moves(
    board: HexBoard,
    coord: Coord,
    config: Dict[str, Any],
    color: str,
) -> List[Coord]:
    """
    Return all legal destination coordinates for the piece at *coord*.

    The piece must belong to *color*.  An empty or wrong-colour source
    returns an empty list.  Movement comes purely from the unit's config
    ``movement`` patterns — there is no per-unit engine logic.
    """
    piece = board.get(*coord)
    if not piece or piece['color'] != color:
        return []

    unit_def = config.get('units', {}).get(piece['unit_id'])
    if not unit_def:
        return []

    mirror = color != 'white'  # patterns are authored from white's perspective
    moves: List[Coord] = []
    seen: Set[Coord] = set()

    for pattern in unit_def.get('movement', []):
        if 'offsets' in pattern:
            targets = _offset_targets(board, coord, color, pattern, mirror)
        else:
            targets = _direction_targets(board, coord, color, pattern, mirror)
        for t in targets:
            if t not in seen:
                seen.add(t)
                moves.append(t)

    return moves


def is_legal_move(
    board: HexBoard,
    from_coord: Coord,
    to_coord: Coord,
    config: Dict[str, Any],
    color: str,
) -> bool:
    """Quick check: is the move from → to in the legal set?"""
    return to_coord in get_legal_moves(board, from_coord, config, color)


# ---------------------------------------------------------------------------
# Pattern walkers
# ---------------------------------------------------------------------------

def _direction_targets(
    board: HexBoard,
    coord: Coord,
    color: str,
    pattern: Dict[str, Any],
    mirror: bool,
) -> List[Coord]:
    """
    Step/slide along a named direction.

    range == 0 → unlimited slide (bounded by board size).
    canJump     → not blocked by intermediate pieces.
    moveOnly    → cannot land on an occupied hex.
    captureOnly → can only land on an enemy-occupied hex.
    """
    targets: List[Coord] = []
    delta = ALL_DIRECTIONS.get(pattern.get('direction', ''))
    if not delta:
        return targets
    dq, dr = delta
    if mirror:
        dq, dr = -dq, -dr

    max_range = pattern.get('range', 1)
    can_jump = pattern.get('canJump', False)
    move_only = pattern.get('moveOnly', False)
    capture_only = pattern.get('captureOnly', False)

    steps = max_range if max_range > 0 else board.radius * 2  # generous upper bound
    cq, cr = coord
    for _ in range(steps):
        cq += dq
        cr += dr
        if not board.is_valid(cq, cr):
            break
        target = board.get(cq, cr)
        if target:
            if target['color'] == color:
                if not can_jump:
                    break       # blocked by own piece
                continue        # jump over own piece
            else:
                if not move_only:
                    targets.append((cq, cr))
                if not can_jump:
                    break       # can't continue past an enemy
                continue
        else:
            if not capture_only:
                targets.append((cq, cr))

    return targets


def _offset_targets(
    board: HexBoard,
    coord: Coord,
    color: str,
    pattern: Dict[str, Any],
    mirror: bool,
) -> List[Coord]:
    """
    Fixed jump targets. Intervening pieces are irrelevant; the unit may land
    on any listed offset that is on the board and not occupied by a friend
    (subject to moveOnly / captureOnly).
    """
    targets: List[Coord] = []
    move_only = pattern.get('moveOnly', False)
    capture_only = pattern.get('captureOnly', False)
    q, r = coord

    for offset in pattern.get('offsets', []):
        try:
            dq, dr = int(offset[0]), int(offset[1])
        except (TypeError, ValueError, IndexError):
            continue
        if mirror:
            dq, dr = -dq, -dr
        tq, tr = q + dq, r + dr
        if not board.is_valid(tq, tr):
            continue
        target = board.get(tq, tr)
        if target:
            if target['color'] == color:
                continue        # can't land on a friend
            if move_only:
                continue
            targets.append((tq, tr))
        else:
            if capture_only:
                continue
            targets.append((tq, tr))

    return targets
