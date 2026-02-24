"""
Config loader — parses a GameConfig dict (matching the shared JSON schema)
and builds the initial HexBoard state.

The DEFAULT_CONFIG provides a minimal playable hex-chess setup on a
radius-5 board so the game works even when no custom config is supplied.
"""

from __future__ import annotations
import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from .board import HexBoard, coord_key, parse_coord

logger = logging.getLogger('game')

# ---------------------------------------------------------------------------
# Default (built-in) configuration — radius-5 hex board with classic-style
# pieces adapted for hex geometry.
#
# Placement uses axial coords where the board centre is (0, 0).
# White starts on the southern edge, black on the northern edge.
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": "1.0",
    "board": {
        "radius": 5
    },
    "units": {
        "king": {
            "id": "king",
            "name": "King",
            "symbol": "K",
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
            "movement": [
                {"direction": d, "range": 0}
                for d in ("E", "W", "NE", "NW", "SE", "SW")
            ],
            "value": 3,
            "hp": 6,
            "attack": 5
        },
        "knight": {
            "id": "knight",
            "name": "Knight",
            "symbol": "N",
            "movement": [
                {"direction": d, "range": 2, "canJump": True}
                for d in ("E", "W", "NE", "NW", "SE", "SW")
            ],
            "value": 3,
            "hp": 8,
            "attack": 4
        },
        "pawn": {
            "id": "pawn",
            "name": "Pawn",
            "symbol": "P",
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
        # Minimal symmetric placement for a radius-5 board.
        # White on south, black on north.  Expand later for a full game.
        "white": {
            "0,5":   "king",
            "-1,5":  "queen",
            "-2,5":  "bishop",
            "1,4":   "bishop",
            "-3,5":  "knight",
            "2,3":   "knight",
            "-4,5":  "rook",
            "3,2":   "rook",
            "-1,4":  "pawn",
            "0,4":   "pawn",
            "1,3":   "pawn",
            "-2,4":  "pawn",
            "2,2":   "pawn",
        },
        "black": {
            "0,-5":   "king",
            "1,-5":   "queen",
            "2,-5":   "bishop",
            "-1,-4":  "bishop",
            "3,-5":   "knight",
            "-2,-3":  "knight",
            "4,-5":   "rook",
            "-3,-2":  "rook",
            "1,-4":   "pawn",
            "0,-4":   "pawn",
            "-1,-3":  "pawn",
            "2,-4":   "pawn",
            "-2,-2":  "pawn",
        }
    },
    "rules": {
        "maxTurns": 0,
        "turnTimeLimit": 0
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
        if not isinstance(r, int) or r < 1 or r > 20:
            errors.append(f"board.radius must be an integer 1–20, got {r}")

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
