"""
Move validator for hex-chess.

Given a board, a source coordinate, a game config and the current colour,
determines which destination hexes are legal.

Hex geometry reference:
  https://www.redblobgames.com/grids/hexagons/

Piece semantics on a hex grid
------------------------------
* **King**   – 1 step in any of the 6 cardinal directions.
* **Queen**  – unlimited slide in all 6 cardinal directions (blocked by pieces).
* **Rook**   – unlimited slide in the 3 "straight" axes: E/W, NE/SW, NW/SE.
* **Bishop** – unlimited slide in the 3 "diagonal" axes.  On a hex grid the
  diagonal step from (q,r) is the combination of two adjacent cardinal
  steps, giving offsets: (+1,+1), (-1,-1), (+2,-1), (-2,+1), (+1,-2), (-1,+2).
* **Knight** – jumps to specific offsets (12 possible targets on a hex grid,
  analogous to the "two-step-then-one-step" rule on square grids).
* **Pawn**   – moves 1 step "forward" (direction depends on colour), captures
  diagonally-forward.  First-move double step is not yet implemented.
"""

from __future__ import annotations
from typing import Any, Dict, List, Set, Tuple

from .board import HexBoard, HEX_DIRECTIONS, Coord

# ---------------------------------------------------------------------------
# Hex-grid diagonal offsets
# ---------------------------------------------------------------------------
# On a hex grid with the 6 cardinal directions, the "diagonals" are the
# hexes that share an *edge-pair* (rather than a single edge).
# There are exactly 6 diagonal neighbours at distance 2:
#   combine adjacent cardinal pairs → skip the shared neighbour.
#
#   NE + E  → (+2, -1)    SW + W  → (-2, +1)
#   NE + NW → (+1, -2)    SW + SE → (-1, +2)
#   E  + SE → (+1, +1)    W  + NW → (-1, -1)

HEX_DIAGONALS: List[Coord] = [
    (+2, -1),
    (-2, +1),
    (+1, -2),
    (-1, +2),
    (+1, +1),
    (-1, -1),
]

# ---------------------------------------------------------------------------
# Knight offsets on hex grid
# ---------------------------------------------------------------------------
# Analogous to standard chess "L-shape" — move 2 in one cardinal direction
# then 1 in an adjacent direction (60° turn), giving 12 unique offsets.
# These are every combination of 2 steps in direction A + 1 step in an
# adjacent direction B (where A and B are neighbours in the direction ring).

_DIR_LIST = ['E', 'NE', 'NW', 'W', 'SW', 'SE']  # ring order

def _compute_knight_offsets() -> List[Coord]:
    """Pre-compute the 12 unique knight landing offsets on a hex grid."""
    offsets: Set[Coord] = set()
    for i, d in enumerate(_DIR_LIST):
        dq, dr = HEX_DIRECTIONS[d]
        # Two steps in direction d
        base_q, base_r = dq * 2, dr * 2
        # Adjacent directions in ring
        for adj_idx in [(i - 1) % 6, (i + 1) % 6]:
            aq, ar = HEX_DIRECTIONS[_DIR_LIST[adj_idx]]
            offsets.add((base_q + aq, base_r + ar))
    return sorted(offsets)

KNIGHT_OFFSETS: List[Coord] = _compute_knight_offsets()

# ---------------------------------------------------------------------------
# Pawn movement helpers
# ---------------------------------------------------------------------------
# White starts at the *south* edge (high r) and moves toward low r (northward).
# Black starts at the *north* edge (low r) and moves toward high r (southward).
#
# "Forward" for white = NW and NE (both decrease r or keep it same while going N)
# Actually on axial hex: "forward" for white is NW (0,-1) and NE (+1,-1)
# — both move toward negative r.
# "Forward" for black is SW (-1,+1) and SE (0,+1)
# — both move toward positive r.
#
# Pawn move (non-capture): 1 step in the straight-forward direction.
# For white that's NW (0,-1).  For black that's SE (0,+1).
# On a hex grid, going "straight north" is ambiguous; we pick NW as the
# primary forward and also allow NE as secondary forward (both go toward
# the opponent's side).
#
# Pawn capture: the two diagonal-forward directions.
# For white: E (+1,0) and W (-1,0) *from the forward hex* — but more
# naturally, the capture directions are the two diagonals that gain ground:
# For white captures: NE (+1,-1) and NW (0,-1) look wrong because NW is
# also the move direction.
#
# Glinski convention (most popular hex chess variant):
#   White pawns move NW (0,-1), capture NE (+1,-1) and W... no.
#
# Let's use a clean convention:
#   White pawn moves: NW  (0,-1)  — one step forward
#   White pawn captures: NE (+1,-1) and  (-1, 0) W — the two adjacent
#     directions that flank NW
#   But W is backward for white... 
#
# Cleaner approach matching Glinski-style hex chess:
#   Forward for white = toward decreasing (r) axis
#     Move-only:   NW (0,-1)
#     Capture-only: NE (+1,-1), and Hex-diagonal forward-left/right
#
# After research, Glinski hex chess uses:
#   White pawn forward = NE(+1,-1) and NW(0,-1) are the two forward edges
#   Move (non-capture): straight forward — but hex has no single "straight"
#   Typically pawns can move to one forward hex (the one directly ahead)
#
# SIMPLE CONVENTION FOR THIS ENGINE:
#   We define pawn movement purely by direction sets per color.
#   The config says which directions are move-only and which are capture-only.
#   The validator respects moveOnly / captureOnly flags.
#
# For the DEFAULT config, white pawn:
#   move-only:    NW (0,-1)  — forward 1
#   capture-only: NE (+1,-1) and W(-1,0)?  No...
#
# Let me just use a pragmatic approach:
#   White forward: any direction with dr < 0 (northward)
#   Black forward: any direction with dr > 0 (southward)
# Then config supplies the exact patterns.

# For pawns we respect the config's movement patterns but flip directions
# for black. The config specifies movement from WHITE's perspective.

_DIRECTION_OPPOSITES: Dict[str, str] = {
    'E': 'W', 'W': 'E',
    'NE': 'SW', 'SW': 'NE',
    'NW': 'SE', 'SE': 'NW',
}


def _flip_direction(d: str) -> str:
    """Mirror a direction for the other colour."""
    return _DIRECTION_OPPOSITES[d]


# ---------------------------------------------------------------------------
# Rook and Bishop axis definitions
# ---------------------------------------------------------------------------
# On a hex grid the 6 cardinal directions split into two groups of 3:
#   "Orthogonal" (rook) axes: E/W, NE/SW, NW/SE  — the 3 straight lines
#   "Diagonal" axes — formed by combining adjacent cardinals (see HEX_DIAGONALS)
#
# Rooks slide along the 6 cardinal directions (like queen but historically
# restricted to "straight" lines).  On a hex grid all 6 cardinals are equally
# "straight", so rook == queen for range.  To differentiate, many hex-chess
# variants give the rook only 3 axes (E/W, one NE/SW pair, and one NW/SE pair).
# However our config already defines the allowed directions per unit.  So we
# just read the config and slide along those directions.

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
    returns an empty list.

    Does NOT filter for self-check (that is done in game_logic).
    This function answers: "where can this piece physically go?"
    """
    piece = board.get(*coord)
    if not piece or piece['color'] != color:
        return []

    unit_id: str = piece['unit_id']
    unit_def = config.get('units', {}).get(unit_id)
    if not unit_def:
        return []

    # Dispatch to specialised generators
    if unit_id == 'knight':
        return _knight_moves(board, coord, color)
    if unit_id == 'pawn':
        return _pawn_moves(board, coord, color, unit_def)
    if unit_id == 'bishop':
        return _bishop_moves(board, coord, color)

    # Generic sliding / stepping — works for king, queen, rook, and any
    # custom unit whose movement is described by direction+range patterns.
    return _pattern_moves(board, coord, color, unit_def)


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
# Pattern-based sliding / stepping  (king, queen, rook, custom units)
# ---------------------------------------------------------------------------

def _pattern_moves(
    board: HexBoard,
    coord: Coord,
    color: str,
    unit_def: Dict[str, Any],
) -> List[Coord]:
    """
    Compute moves for a unit whose config defines direction+range patterns.

    range == 0 → unlimited slide (blocked by pieces).
    range == N → up to N steps.
    canJump     → not blocked by intermediate pieces.
    moveOnly    → cannot land on an occupied square.
    captureOnly → can only land on an enemy-occupied square.
    """
    moves: List[Coord] = []
    q, r = coord

    for pattern in unit_def.get('movement', []):
        direction = pattern.get('direction', '')
        max_range = pattern.get('range', 1)
        can_jump = pattern.get('canJump', False)
        move_only = pattern.get('moveOnly', False)
        capture_only = pattern.get('captureOnly', False)

        delta = HEX_DIRECTIONS.get(direction)
        if not delta:
            continue
        dq, dr = delta

        steps = max_range if max_range > 0 else board.radius * 2  # generous upper bound
        cq, cr = q, r
        for _ in range(steps):
            cq += dq
            cr += dr
            if not board.is_valid(cq, cr):
                break
            target = board.get(cq, cr)
            if target:
                if target['color'] == color:
                    if not can_jump:
                        break  # blocked by own piece
                    continue  # jump over own piece
                else:
                    # Enemy piece
                    if not move_only:
                        moves.append((cq, cr))
                    if not can_jump:
                        break  # can't continue past captured piece
                    continue
            else:
                # Empty hex
                if not capture_only:
                    moves.append((cq, cr))

    return moves


# ---------------------------------------------------------------------------
# Bishop (hex-diagonal sliding)
# ---------------------------------------------------------------------------

def _bishop_moves(
    board: HexBoard,
    coord: Coord,
    color: str,
) -> List[Coord]:
    """
    Hex bishops slide along the 6 diagonal axes.

    Each diagonal axis has a step vector from HEX_DIAGONALS.
    The bishop slides until it hits the board edge or a piece.
    It can capture the first enemy piece it encounters but cannot jump.
    """
    moves: List[Coord] = []
    q, r = coord

    for dq, dr in HEX_DIAGONALS:
        cq, cr = q, r
        for _ in range(board.radius * 2):
            cq += dq
            cr += dr
            if not board.is_valid(cq, cr):
                break
            target = board.get(cq, cr)
            if target:
                if target['color'] != color:
                    moves.append((cq, cr))  # capture
                break  # blocked either way
            moves.append((cq, cr))

    return moves


# ---------------------------------------------------------------------------
# Knight (fixed jump offsets)
# ---------------------------------------------------------------------------

def _knight_moves(
    board: HexBoard,
    coord: Coord,
    color: str,
) -> List[Coord]:
    """
    Knights jump to any of the 12 fixed offsets (hex 'L-shape').
    They can jump over pieces but cannot land on a friendly piece.
    """
    moves: List[Coord] = []
    q, r = coord

    for dq, dr in KNIGHT_OFFSETS:
        tq, tr = q + dq, r + dr
        if not board.is_valid(tq, tr):
            continue
        target = board.get(tq, tr)
        if target and target['color'] == color:
            continue  # can't capture own piece
        moves.append((tq, tr))

    return moves


# ---------------------------------------------------------------------------
# Pawn
# ---------------------------------------------------------------------------

def _pawn_moves(
    board: HexBoard,
    coord: Coord,
    color: str,
    unit_def: Dict[str, Any],
) -> List[Coord]:
    """
    Pawn movement using config-defined patterns.

    The config specifies directions from WHITE's perspective.
    For black, directions are flipped (mirrored).

    - `moveOnly` patterns: can only move to empty hexes.
    - `captureOnly` patterns: can only move to enemy-occupied hexes.
    - Plain patterns: can do either.
    """
    moves: List[Coord] = []
    q, r = coord

    for pattern in unit_def.get('movement', []):
        direction = pattern.get('direction', '')
        max_range = pattern.get('range', 1)
        move_only = pattern.get('moveOnly', False)
        capture_only = pattern.get('captureOnly', False)

        # Flip direction for black
        if color == 'black':
            direction = _flip_direction(direction)

        delta = HEX_DIRECTIONS.get(direction)
        if not delta:
            continue
        dq, dr = delta

        steps = max_range if max_range > 0 else 1  # pawns shouldn't slide unlimited
        cq, cr = q, r
        for _ in range(steps):
            cq += dq
            cr += dr
            if not board.is_valid(cq, cr):
                break
            target = board.get(cq, cr)
            if target:
                if target['color'] == color:
                    break  # blocked by own piece
                # Enemy piece
                if move_only:
                    break  # can't capture with a move-only pattern
                moves.append((cq, cr))
                break  # pawn never slides past a capture
            else:
                # Empty hex
                if capture_only:
                    break  # can't move to empty with capture-only pattern
                moves.append((cq, cr))

    return moves
