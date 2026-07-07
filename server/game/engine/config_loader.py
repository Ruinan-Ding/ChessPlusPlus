"""
Config loader — parses a GameConfig dict (matching the shared JSON schema)
and builds the initial HexBoard state.

The only fixed game fact is the board: a hexagon with 24 cells per edge
(axial radius 23), rendered with an edge pointing up. Even that lives in
DEFAULT_CONFIG rather than engine code, so it can change with the config.

Everything about the units below is a PLACEHOLDER. The engine reads all
movement/combat behaviour from this data — none of the unit ids mean
anything to the code, and the real game's units will replace these.
"""

from __future__ import annotations
import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from .board import HexBoard, coord_key, parse_coord
from .move_validator import KNIGHT_OFFSETS

logger = logging.getLogger('game')

# ---------------------------------------------------------------------------
# Default (built-in) configuration.
#
# Board: hexagon, 24 cells per edge → axial radius 23 (side = radius + 1),
# edge-up orientation. Placement uses axial coords with centre (0, 0);
# white starts on the southern edge row (r = +23), black mirrored north.
#
# Movement patterns are authored from WHITE's perspective; the engine
# mirrors them for black. Two pattern types exist:
#   {"direction": ..., "range": N, canJump/moveOnly/captureOnly}
#   {"offsets": [[dq, dr], ...], moveOnly/captureOnly}   (fixed jumps)
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": "1.0",
    "board": {
        "radius": 23,              # 24 cells per hexagon edge
        "orientation": "edge-up"   # cosmetic: how the client draws the hexagon
    },
    "units": {
        "king": {
            "id": "king",
            "name": "King",
            "symbol": "K",
            "display": {"white": "♔", "black": "♚"},
            "movement": [
                {"direction": d, "range": 1}
                for d in ("E", "W", "NE", "NW", "SE", "SW")
            ],
            "value": 0,
            "hp": 10,
            "attack": 3
        },
        "queen": {
            "id": "queen",
            "name": "Queen",
            "symbol": "Q",
            "display": {"white": "♕", "black": "♛"},
            "movement": [
                {"direction": d, "range": 0}          # unlimited slide
                for d in ("E", "W", "NE", "NW", "SE", "SW")
            ],
            "value": 9,
            "hp": 8,
            "attack": 6
        },
        "rook": {
            "id": "rook",
            "name": "Rook",
            "symbol": "R",
            "display": {"white": "♖", "black": "♜"},
            "movement": [
                {"direction": d, "range": 0}
                for d in ("E", "W", "NE", "NW", "SE", "SW")
            ],
            "value": 5,
            "hp": 12,
            "attack": 4
        },
        "bishop": {
            "id": "bishop",
            "name": "Bishop",
            "symbol": "B",
            "display": {"white": "♗", "black": "♝"},
            "movement": [
                {"direction": d, "range": 0}          # diagonal slides
                for d in ("DN", "DS", "DNE", "DSW", "DSE", "DNW")
            ],
            "value": 3,
            "hp": 6,
            "attack": 5
        },
        "knight": {
            "id": "knight",
            "name": "Knight",
            "symbol": "N",
            "display": {"white": "♘", "black": "♞"},
            "movement": [
                {"offsets": [list(o) for o in KNIGHT_OFFSETS]}
            ],
            "value": 3,
            "hp": 8,
            "attack": 4
        },
        "pawn": {
            "id": "pawn",
            "name": "Pawn",
            "symbol": "P",
            "display": {"white": "♙", "black": "♟"},
            "movement": [
                {"direction": "NW", "range": 1, "moveOnly": True},
                {"direction": "NE", "range": 1, "captureOnly": True},
                {"direction": "W",  "range": 1, "captureOnly": True},
            ],
            "value": 1,
            "hp": 4,
            "attack": 2
        }
    },
    "abilities": {},
    "setup": {
        # Placeholder symmetric placement on the south/north edge rows of the
        # radius-23 board.  White's edge row is r=+23 (q from -23 to 0);
        # black is the point-mirror (q,r) → (-q,-r).
        "white": {
            "-11,23": "king",
            "-13,23": "queen",
            "-9,23":  "bishop",
            "-15,23": "bishop",
            "-7,23":  "knight",
            "-17,23": "knight",
            "-5,23":  "rook",
            "-19,23": "rook",
            "-8,22":  "pawn",
            "-10,22": "pawn",
            "-12,22": "pawn",
            "-14,22": "pawn",
            "-16,22": "pawn",
        },
        "black": {
            "11,-23": "king",
            "13,-23": "queen",
            "9,-23":  "bishop",
            "15,-23": "bishop",
            "7,-23":  "knight",
            "17,-23": "knight",
            "5,-23":  "rook",
            "19,-23": "rook",
            "8,-22":  "pawn",
            "10,-22": "pawn",
            "12,-22": "pawn",
            "14,-22": "pawn",
            "16,-22": "pawn",
        }
    },
    "rules": {
        "maxTurns": 0,
        "turnTimeLimit": 0,
        # Placeholder: win condition. Only 'elimination' is implemented.
        "objective": "elimination"
    }
}


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_config(config: Dict[str, Any]) -> List[str]:
    """
    Light validation of a config dict.
    Returns a list of error strings (empty = valid).
    """
    errors: List[str] = []

    if 'version' not in config:
        errors.append("Missing 'version'")
    if 'board' not in config or 'radius' not in config.get('board', {}):
        errors.append("Missing 'board.radius'")
    else:
        r = config['board']['radius']
        if not isinstance(r, int) or r < 1 or r > 50:
            errors.append(f"board.radius must be an integer 1–50, got {r}")

    if 'units' not in config or not isinstance(config.get('units'), dict):
        errors.append("Missing or invalid 'units'")

    if 'setup' not in config:
        errors.append("Missing 'setup'")
    else:
        for side in ('white', 'black'):
            placement = config['setup'].get(side, {})
            if not isinstance(placement, dict):
                errors.append(f"setup.{side} must be a dict")
                continue
            for coord_str, unit_id in placement.items():
                # validate coord format
                try:
                    parse_coord(coord_str)
                except (ValueError, IndexError):
                    errors.append(f"Invalid coordinate '{coord_str}' in setup.{side}")
                # validate unit exists
                if unit_id not in config.get('units', {}):
                    errors.append(f"Unknown unit '{unit_id}' at {coord_str} in setup.{side}")

    return errors


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_config(raw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Normalise and validate a config dict.

    If *raw* is None or empty, returns a deep copy of DEFAULT_CONFIG.
    Raises ValueError if the config has structural problems.
    """
    if not raw:
        return copy.deepcopy(DEFAULT_CONFIG)

    config = copy.deepcopy(raw)
    errors = _validate_config(config)
    if errors:
        raise ValueError(f"Invalid game config: {'; '.join(errors)}")
    return config


def build_initial_board(config: Dict[str, Any]) -> HexBoard:
    """
    Create a HexBoard populated with the starting pieces described in *config*.

    Each piece is placed with its max HP from the unit definition.
    Returns the ready-to-play board instance.
    """
    radius: int = config['board']['radius']
    board = HexBoard(radius)
    units = config.get('units', {})

    for color in ('white', 'black'):
        placement = config.get('setup', {}).get(color, {})
        for coord_str, unit_id in placement.items():
            q, r = parse_coord(coord_str)
            if not board.is_valid(q, r):
                logger.warning(
                    f"Skipping out-of-bounds placement: {unit_id} at ({q},{r}) "
                    f"for {color} (radius={radius})"
                )
                continue
            unit_def = units.get(unit_id, {})
            hp = unit_def.get('hp', 1)
            board.set(q, r, unit_id, color, hp=hp, max_hp=hp)

    logger.info(f"Built initial board: radius={radius}, pieces={len(board.to_dict())}")
    return board
