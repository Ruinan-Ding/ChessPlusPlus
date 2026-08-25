"""
Config loader - parses a GameConfig dict (matching the shared JSON schema)
and builds the initial HexBoard state.

The only fixed game fact is the board: a hexagon with 12 cells per edge
(axial radius 11), rendered with an edge pointing up. Even that lives in
DEFAULT_CONFIG rather than engine code, so it can change with the config.

Everything about the units below is a PLACEHOLDER. The engine reads all
movement/combat behaviour from this data - none of the unit ids mean
anything to the code, and the real game's units will replace these.
"""

from __future__ import annotations
import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from .board import HexBoard, coord_key, parse_coord

logger = logging.getLogger('game')

# ---------------------------------------------------------------------------
# Default (built-in) configuration.
#
# Board: hexagon, 12 cells per edge -> axial radius 11 (side = radius + 1),
# edge-up orientation. Placement uses axial coords with centre (0, 0);
# white starts on the southern edge row (r = +11), black mirrored north.
#
# Movement is a single "move" stat per unit: the number of adjacent-hex
# steps it can take per turn. Movement floods outward through the six hex
# neighbours, through empty hexes only - a unit can never move through or
# onto an occupied hex (ally or enemy). See move_validator.py.
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": "1.0",
    "board": {
        "radius": 11,              # 12 cells per hexagon edge
        "orientation": "edge-up"   # cosmetic: how the client draws the hexagon
    },
    "units": {
        "king": {
            "id": "king",
            "name": "King",
            "symbol": "K",
            "display": {"white": "♔", "black": "♚"},
            "move": 6,
            "value": 0,
            "hp": 45,
            "attack": 16,
            "attackRange": 1,
            "commander": True,
            "defense": 15
        },
        "queen": {
            "id": "queen",
            "name": "Queen",
            "symbol": "Q",
            "display": {"white": "♕", "black": "♛"},
            "move": 6,
            "value": 9,
            "hp": 30,
            "attack": 26,
            "attackRange": 2,
            "defense": 12
        },
        "rook": {
            "id": "rook",
            "name": "Rook",
            "symbol": "R",
            "display": {"white": "♖", "black": "♜"},
            "move": 6,
            "value": 5,
            "hp": 40,
            "attack": 20,
            "attackRange": 2,
            "defense": 13
        },
        "bishop": {
            "id": "bishop",
            "name": "Bishop",
            "symbol": "B",
            "display": {"white": "♗", "black": "♝"},
            "move": 6,
            "value": 3,
            "hp": 22,
            "attack": 22,
            "attackRange": 3,
            "defense": 10
        },
        "knight": {
            "id": "knight",
            "name": "Knight",
            "symbol": "N",
            "display": {"white": "♘", "black": "♞"},
            "move": 6,
            "value": 3,
            "hp": 28,
            "attack": 18,
            "attackRange": 1,
            "defense": 11
        },
        "pawn": {
            "id": "pawn",
            "name": "Pawn",
            "symbol": "P",
            "display": {"white": "♙", "black": "♟"},
            "move": 6,
            "value": 1,
            "hp": 20,
            "attack": 14,
            "attackRange": 1,
            "defense": 10
        }
    },
    "abilities": {},
    "setup": {
        # Placeholder symmetric placement on the south/north edge rows of the
        # radius-11 board.  White's edge row is r=+11 (q from -11 to 0, 12
        # cells); black is the point-mirror (q,r) -> (-q,-r).  The 8 back-rank
        # pieces sit contiguously (the row is too short to space them out).
        "white": {
            "-5,11":  "king",
            "-6,11":  "queen",
            "-4,11":  "bishop",
            "-7,11":  "bishop",
            "-3,11":  "knight",
            "-8,11":  "knight",
            "-2,11":  "rook",
            "-9,11":  "rook",
            "-3,10":  "pawn",
            "-4,10":  "pawn",
            "-5,10":  "pawn",
            "-6,10":  "pawn",
            "-7,10":  "pawn",
        },
        "black": {
            "5,-11":  "king",
            "6,-11":  "queen",
            "4,-11":  "bishop",
            "7,-11":  "bishop",
            "3,-11":  "knight",
            "8,-11":  "knight",
            "2,-11":  "rook",
            "9,-11":  "rook",
            "3,-10":  "pawn",
            "4,-10":  "pawn",
            "5,-10":  "pawn",
            "6,-10":  "pawn",
            "7,-10":  "pawn",
        }
    },
    "rules": {
        # Fraction of damage lost per ring beyond the first.
        "rangeFalloff": 0.25,
        "maxTurns": 0,
        "turnTimeLimit": 0,
        # A side loses when its commander dies; 'elimination' (no units left)
        # is the other supported objective.
        "objective": "regicide"
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
            errors.append(f"board.radius must be an integer 1-50, got {r}")

    if 'units' not in config or not isinstance(config.get('units'), dict):
        errors.append("Missing or invalid 'units'")
    else:
        # A silly attackRange would have the client expanding rings over the
        # whole board for a hover preview, so bound it like board.radius.
        for unit_id, unit in config['units'].items():
            if not isinstance(unit, dict):
                continue
            rng = unit.get('attackRange', 1)
            if not isinstance(rng, int) or isinstance(rng, bool) or rng < 1 or rng > 50:
                errors.append(f"units.{unit_id}.attackRange must be an integer 1-50, got {rng}")
            # The schema requires defence and combat reads it. A unit without
            # one loads as armour 0 and fights with silently wrong numbers.
            dfn = unit.get('defense')
            if not isinstance(dfn, int) or isinstance(dfn, bool) or dfn < 0:
                errors.append(f"units.{unit_id}.defense must be an integer >= 0, got {dfn}")

    falloff = config.get('rules', {}).get('rangeFalloff', 0)
    if not isinstance(falloff, (int, float)) or isinstance(falloff, bool) or not 0 <= falloff <= 1:
        errors.append(f"rules.rangeFalloff must be a number 0-1, got {falloff}")

    if 'setup' not in config:
        errors.append("Missing 'setup'")
    else:
        for side in ('white', 'black'):
            placement = config['setup'].get(side, {})
            if not isinstance(placement, dict):
                errors.append(f"setup.{side} must be a dict")
                continue
            for coord_str, unit_id in placement.items():
                try:
                    parse_coord(coord_str)
                except ValueError:
                    errors.append(f"Invalid coordinate '{coord_str}' in setup.{side}")
                if unit_id not in config.get('units', {}):
                    errors.append(f"Unknown unit '{unit_id}' at {coord_str} in setup.{side}")

    # The objective decides how a game is lost, so a config that cannot
    # satisfy it is unplayable rather than merely odd: under regicide a side
    # with no commander on the board has already lost before the first move.
    objective = config.get('rules', {}).get('objective', 'regicide')
    if objective not in ('regicide', 'elimination'):
        errors.append(
            f"rules.objective must be 'regicide' or 'elimination', got {objective!r}")
    elif objective == 'regicide' and isinstance(config.get('setup'), dict):
        units = config.get('units', {})
        for side in ('white', 'black'):
            placement = config['setup'].get(side, {})
            if not isinstance(placement, dict):
                continue
            if not any(units.get(u, {}).get('commander') for u in placement.values()):
                errors.append(
                    f"setup.{side} has no commander unit, but rules.objective "
                    f"is 'regicide' - that side is beaten before it moves")

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
            # Every unit carries an identity that outlives the hex it stands
            # on. Per-unit state - veterancy, boosts, cooldowns - hangs off
            # this, so it travels with the unit instead of being re-keyed by
            # every caller that moves one. The cell dict is open and both
            # move() and (de)serialisation preserve it.
            board.set_cell(q, r, {
                'unit_id': unit_id,
                'color': color,
                'hp': hp,
                'max_hp': hp,
                'uid': f"{color[0]}{coord_str}",
            })

    logger.info(f"Built initial board: radius={radius}, pieces={len(board.to_dict())}")
    return board
