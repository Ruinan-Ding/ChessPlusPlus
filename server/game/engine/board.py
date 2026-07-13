"""
Hex board representation using axial coordinates (q, r).

Coordinate reference (flat-top hex grid):
  https://www.redblobgames.com/grids/hexagons/

A board of radius N contains all hexes where
  max(|q|, |r|, |q+r|) <= N
giving a total of  3N² + 3N + 1  hexes.

Each occupied cell stores:
  {"unit_id": "<unit type>", "color": "white"|"black"}
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional, Tuple


# Type aliases
Coord = Tuple[int, int]
CellData = Dict[str, Any]       # {"unit_id": str, "color": str, "hp": int, "max_hp": int}
BoardDict = Dict[str, CellData]  # serialised "q,r" -> CellData

# Six axial direction offsets (flat-top orientation)
HEX_DIRECTIONS: Dict[str, Coord] = {
    'E':  (+1,  0),
    'W':  (-1,  0),
    'NE': (+1, -1),
    'NW': ( 0, -1),
    'SE': ( 0, +1),
    'SW': (-1, +1),
}


def coord_key(q: int, r: int) -> str:
    """Serialise an axial coordinate to the string key used in JSON / DB."""
    return f"{q},{r}"


def parse_coord(key: str) -> Coord:
    """Parse a `'q,r'` string back to an (int, int) tuple."""
    parts = key.split(',')
    return int(parts[0]), int(parts[1])


def hex_distance(a: Coord, b: Coord) -> int:
    """Manhattan distance on a hex grid (axial coords)."""
    dq = a[0] - b[0]
    dr = a[1] - b[1]
    return max(abs(dq), abs(dr), abs(dq + dr))


class HexBoard:
    """
    In-memory hex board.

    Stores pieces in a dict keyed by (q, r) tuples for fast lookup.
    Can serialise / deserialise to the JSON-friendly `BoardDict` format
    stored in ``GameState.board_state``.
    """

    def __init__(self, radius: int):
        if radius < 1:
            raise ValueError("Board radius must be >= 1")
        self.radius = radius
        # Piece map: (q, r) -> CellData
        self._cells: Dict[Coord, CellData] = {}

    # -- Valid hex enumeration -----------------------------------------

    def all_coords(self) -> List[Coord]:
        """Return every valid hex coordinate on this board."""
        coords: List[Coord] = []
        for q in range(-self.radius, self.radius + 1):
            for r in range(-self.radius, self.radius + 1):
                if max(abs(q), abs(r), abs(q + r)) <= self.radius:
                    coords.append((q, r))
        return coords

    def is_valid(self, q: int, r: int) -> bool:
        """Return True if (q, r) is inside the board boundaries."""
        return max(abs(q), abs(r), abs(q + r)) <= self.radius

    @property
    def total_hexes(self) -> int:
        n = self.radius
        return 3 * n * n + 3 * n + 1

    # -- Cell access ---------------------------------------------------

    def get(self, q: int, r: int) -> Optional[CellData]:
        """Get the piece at (q, r), or None if empty / off-board."""
        return self._cells.get((q, r))

    def set(self, q: int, r: int, unit_id: str, color: str,
            hp: Optional[int] = None, max_hp: Optional[int] = None) -> None:
        """Place a piece on the board with optional HP tracking."""
        if not self.is_valid(q, r):
            raise ValueError(f"Coordinate ({q},{r}) is outside radius {self.radius}")
        cell: CellData = {'unit_id': unit_id, 'color': color}
        if hp is not None:
            cell['hp'] = hp
        if max_hp is not None:
            cell['max_hp'] = max_hp
        self._cells[(q, r)] = cell

    def remove(self, q: int, r: int) -> Optional[CellData]:
        """Remove and return the piece at (q, r), or None if empty."""
        return self._cells.pop((q, r), None)

    def move(self, from_q: int, from_r: int, to_q: int, to_r: int) -> Optional[CellData]:
        """
        Move the piece at (from) to (to).

        Returns the captured piece if one was present at (to), else None.
        Raises ValueError if source is empty.
        """
        piece = self.get(from_q, from_r)
        if piece is None:
            raise ValueError(f"No piece at ({from_q},{from_r})")
        captured = self.remove(to_q, to_r)
        self.remove(from_q, from_r)
        self.set(to_q, to_r, piece['unit_id'], piece['color'],
                 hp=piece.get('hp'), max_hp=piece.get('max_hp'))
        return captured

    def deal_damage(self, q: int, r: int, damage: int) -> Optional[CellData]:
        """
        Deal *damage* to the unit at (q, r).

        Returns the unit's CellData if it was eliminated (hp <= 0),
        or None if it survived.
        """
        cell = self.get(q, r)
        if cell is None:
            return None
        cell['hp'] = max(0, cell.get('hp', 1) - damage)
        if cell['hp'] <= 0:
            return self.remove(q, r)  # eliminated
        return None  # survived

    def pieces_by_color(self, color: str) -> Dict[Coord, CellData]:
        """Return all pieces belonging to the given color."""
        return {c: d for c, d in self._cells.items() if d['color'] == color}

    # -- Neighbour helpers ---------------------------------------------

    @staticmethod
    def neighbours(q: int, r: int) -> List[Coord]:
        """Return the six neighbouring coordinates (may be off-board)."""
        return [(q + dq, r + dr) for dq, dr in HEX_DIRECTIONS.values()]

    def valid_neighbours(self, q: int, r: int) -> List[Coord]:
        """Return only the neighbours that are inside the board."""
        return [(nq, nr) for nq, nr in self.neighbours(q, r) if self.is_valid(nq, nr)]

    # -- Serialisation -------------------------------------------------

    def to_dict(self) -> BoardDict:
        """Serialise to JSON-safe dict (for GameState.board_state)."""
        return {coord_key(q, r): data for (q, r), data in self._cells.items()}

    @classmethod
    def from_dict(cls, radius: int, data: BoardDict) -> 'HexBoard':
        """Reconstruct a board from a serialised dict."""
        board = cls(radius)
        for key, cell in data.items():
            q, r = parse_coord(key)
            board.set(q, r, cell['unit_id'], cell['color'],
                      hp=cell.get('hp'), max_hp=cell.get('max_hp'))
        return board

    # -- Debug ---------------------------------------------------------

    def __repr__(self) -> str:
        return f"HexBoard(radius={self.radius}, pieces={len(self._cells)})"
