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
from .panels import axial_to_pixel, color_of_panel, on_battlefield, panel_of

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
            "value": 40,
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
            "value": 30,
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
            "value": 18,
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
            "value": 14,
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
            "value": 12,
            "hp": 28,
            "attack": 18,
            "attackRange": 1,
            "defense": 11
        },
        # Two more of the footsoldier's kind, either side of the pawn: one
        # that outranges everything but the bishop and folds when reached,
        # one that reaches nothing and does not fold. Placeholder numbers on
        # the same scale as the rest - the owner said to make them up.
        "archer": {
            "id": "archer",
            "name": "Archer",
            "symbol": "A",
            "display": {"white": "🏹︎", "black": "🏹︎"},
            "move": 6,
            "value": 8,
            "hp": 16,
            "attack": 15,
            "attackRange": 3,
            "defense": 7
        },
        "shieldman": {
            "id": "shieldman",
            "name": "Shieldman",
            "symbol": "S",
            "display": {"white": "🛡︎", "black": "🛡︎"},
            "move": 5,
            "value": 9,
            "hp": 30,
            "attack": 8,
            "attackRange": 1,
            "defense": 18
        },
        "pawn": {
            "id": "pawn",
            "name": "Pawn",
            "symbol": "P",
            "display": {"white": "♙", "black": "♟"},
            "move": 6,
            "value": 5,
            "hp": 20,
            "attack": 14,
            "attackRange": 1,
            "defense": 10
        }
    },
    # The ability catalogue, and how a side gets at it. Keyed by a STABLE id
    # throughout - never by position - because a side's saved loadout, path and
    # cooldowns are written by id, and a reordered list would re-point every
    # one of them. `cost` is in whichever purse the ability draws on: points
    # for a pool ability, CP for a path's (see `isPathSlot` in the room).
    #
    # A path shares its id with its own passive on purpose: the path IS its
    # passive. They live in different namespaces - `paths` is a list, the
    # catalogue is a map - and nothing looks one up in the other.
    #
    # `testing: True` marks the owner's bench rather than a balanced ability,
    # and is what keeps Rally's 300 points out of networked play.
    #
    # **The engine still does not read any of this.** It is here so that
    # tuning an ability is a config edit rather than a code change, which is
    # the half of PUNCHLIST 6.15 that could land without the numbers settling.
    "abilities": {
        "slots": 4,
        "pool": ["dash", "focus", "bulwark", "sap", "arc-bolt", "mire", "mend", "rally"],
        "paths": [
            {
                "id": "bastion",
                "name": "Bastion",
                "cost": 6,
                "passive": "bastion",
                "skill": "anchor",
                "ultimate": "fortress"
            },
            {
                "id": "onslaught",
                "name": "Onslaught",
                "cost": 7,
                "passive": "onslaught",
                "skill": "cleave",
                "ultimate": "ruin"
            },
            {
                "id": "tempo",
                "name": "Tempo",
                "cost": 5,
                "passive": "tempo",
                "skill": "surge",
                "ultimate": "blitz"
            }
        ],
        "catalogue": {
            "dash": {
                "id": "dash",
                "name": "Dash",
                "target": "friendly",
                "cost": 3,
                "mov": 2
            },
            "focus": {
                "id": "focus",
                "name": "Focus",
                "target": "friendly",
                "cost": 5,
                "atk": 2
            },
            "bulwark": {
                "id": "bulwark",
                "name": "Bulwark",
                "target": "friendly",
                "cost": 1,
                "def": 3
            },
            "sap": {
                "id": "sap",
                "name": "Sap",
                "target": "enemy",
                "cost": 4,
                "mov": -2,
                "atk": -2,
                "def": -2,
                "damage": 6
            },
            "arc-bolt": {
                "id": "arc-bolt",
                "name": "Arc Bolt",
                "target": "enemy",
                "cost": 3,
                "damage": 8
            },
            "mire": {
                "id": "mire",
                "name": "Mire",
                "target": "enemy",
                "cost": 2,
                "mov": -3
            },
            "mend": {
                "id": "mend",
                "name": "Mend",
                "target": "friendly",
                "cost": 0,
                "heal": 20,
                "testing": True
            },
            "rally": {
                "id": "rally",
                "name": "Rally",
                "target": "universal",
                "cost": 0,
                "points": 300,
                "testing": True
            },
            "bastion": {
                "id": "bastion",
                "name": "Bastion",
                "target": "friendly",
                "cost": 0,
                "def": 1
            },
            "anchor": {
                "id": "anchor",
                "name": "Anchor",
                "target": "friendly",
                "cost": 4,
                "def": 4
            },
            "fortress": {
                "id": "fortress",
                "name": "Fortress",
                "target": "universal",
                "cost": 8,
                "points": 4
            },
            "onslaught": {
                "id": "onslaught",
                "name": "Onslaught",
                "target": "friendly",
                "cost": 0,
                "atk": 1
            },
            "cleave": {
                "id": "cleave",
                "name": "Cleave",
                "target": "enemy",
                "cost": 5,
                "damage": 10
            },
            "ruin": {
                "id": "ruin",
                "name": "Ruin",
                "target": "universal",
                "cost": 8,
                "points": 5
            },
            "tempo": {
                "id": "tempo",
                "name": "Tempo",
                "target": "friendly",
                "cost": 0,
                "mov": 1
            },
            "surge": {
                "id": "surge",
                "name": "Surge",
                "target": "friendly",
                "cost": 3,
                "mov": 3
            },
            "blitz": {
                "id": "blitz",
                "name": "Blitz",
                "target": "universal",
                "cost": 8,
                "points": 3
            }
        }
    },
    "setup": {
        # Three rows on each side of the radius-11 board, spaced so nothing
        # sits shoulder to shoulder. White's edge row is r=+11; black is the point
        # mirror (q,r) -> (-q,-r).
        #   row 1 (r=11): pawn archer shieldman | queen king | shieldman archer pawn
        #                 - the pair in the middle behind a shield each, an
        #                 archer outside that, and a pawn on each wing tip
        #   row 2 (r=10): pawn | rook knight bishop | bishop knight rook | pawn,
        #                 every other hex with a pawn on each wing tip
        #   row 3 (r=9) : four pawns, two archers and two shieldmen, every other
        #                 hex but the middle pair, which straddles the centre
        #                 line - eight spaced units are one hex wider than the
        #                 row.
        # Odd separations are what stay centred here: the row holds an even number
        # of hexes, so an even gap would put the pair off the middle.
        #
        # Then each side's base: its bottom three rows, full - rook knight
        # bishop bishop knight rook, shieldman archer pawn archer shieldman, and
        # five pawns. The owner, 25 Sep 2026: "at the start of game, there will
        # be units in base", by the numbers on the board (the # after each).
        # A hex off the battlefield is a panel hex: build_initial_board leaves
        # it alone and the panel deal (panels.set_up_panels) stands the unit
        # there. Black's is the same point mirror.
        "white": {
            "-11,11":  "pawn",
            "-10,11":  "archer",
            "-8,11":   "shieldman",
            "-6,11":   "queen",
            "-5,11":   "king",
            "-3,11":   "shieldman",
            "-1,11":   "archer",
            "0,11":    "pawn",
            "-11,10":  "pawn",
            "-10,10":  "rook",
            "-8,10":   "knight",
            "-6,10":   "bishop",
            "-4,10":   "bishop",
            "-2,10":   "knight",
            "0,10":    "rook",
            "1,10":    "pawn",
            "-11,9":   "shieldman",
            "-9,9":    "pawn",
            "-7,9":    "archer",
            "-5,9":    "pawn",
            "-4,9":    "pawn",
            "-2,9":    "archer",
            "0,9":     "pawn",
            "2,9":     "shieldman",
            "-17,11":  "rook",       # 518
            "-16,11":  "knight",     # 519
            "-15,11":  "bishop",     # 520
            "-14,11":  "bishop",     # 521
            "-13,11":  "knight",     # 522
            "-12,11":  "rook",       # 523
            "-16,10":  "shieldman",  # 495
            "-15,10":  "archer",     # 496
            "-14,10":  "pawn",       # 497
            "-13,10":  "archer",     # 498
            "-12,10":  "shieldman",  # 499
            "-16,9":   "pawn",       # 471
            "-15,9":   "pawn",       # 472
            "-14,9":   "pawn",       # 473
            "-13,9":   "pawn",       # 474
            "-12,9":   "pawn",       # 475
        },
        "black": {
            "11,-11":  "pawn",
            "10,-11":  "archer",
            "8,-11":   "shieldman",
            "6,-11":   "queen",
            "5,-11":   "king",
            "3,-11":   "shieldman",
            "1,-11":   "archer",
            "0,-11":   "pawn",
            "11,-10":  "pawn",
            "10,-10":  "rook",
            "8,-10":   "knight",
            "6,-10":   "bishop",
            "4,-10":   "bishop",
            "2,-10":   "knight",
            "0,-10":   "rook",
            "-1,-10":  "pawn",
            "11,-9":   "shieldman",
            "9,-9":    "pawn",
            "7,-9":    "archer",
            "5,-9":    "pawn",
            "4,-9":    "pawn",
            "2,-9":    "archer",
            "0,-9":    "pawn",
            "-2,-9":   "shieldman",
            "17,-11":  "rook",       # 24
            "16,-11":  "knight",     # 23
            "15,-11":  "bishop",     # 22
            "14,-11":  "bishop",     # 21
            "13,-11":  "knight",     # 20
            "12,-11":  "rook",       # 19
            "16,-10":  "shieldman",  # 47
            "15,-10":  "archer",     # 46
            "14,-10":  "pawn",       # 45
            "13,-10":  "archer",     # 44
            "12,-10":  "shieldman",  # 43
            "16,-9":   "pawn",       # 71
            "15,-9":   "pawn",       # 70
            "14,-9":   "pawn",       # 69
            "13,-9":   "pawn",       # 68
            "12,-9":   "pawn",       # 67
        },
    },
    "rules": {
        # Fraction of damage lost per ring beyond the first.
        "rangeFalloff": 0.25,
        # The least a blow that lands may deal, once defence is off it.
        "minStrikeDamage": 1,
        "maxTurns": 0,
        "turnTimeLimit": 0,
        # A side loses when its commander dies; 'elimination' (no units left)
        # is the other supported objective.
        "objective": "regicide",
        # How many units each panel - the base and the reserve, separately -
        # may start in one turn.
        "panelMoversPerTurn": 3,
        # How many a side may bring out of its reserve in a phase's postmatch
        # turn. Stands instead of panelMoversPerTurn for the reserve on that
        # turn, not beside it.
        "postmatchEntries": 5,
        # How many units a side may walk home in one setup turn.
        "homecomingsPerSetupTurn": 3,
        # The CP each side starts the match with.
        "cpAtStart": 5,
        # The base of the CP award at the start of each phase's postmatch:
        # Phase N's is N times this, plus both sides' phase scores, plus the
        # gap for the side behind (engine/scoring.py, cp_awarded).
        "cpPhaseOffset": 5
    }
}

#: The rules a config may leave out and be read at their default. Each is a
#: whole number >= 0, filled in by _normalise_config and read by rule_of.
#:
#: postmatchEntries was phaseInitEntries while the extra turn opened a phase
#: rather than closing it. Nothing migrates the old key: neither runtime
#: validator (_validate_config here, validateGameRules in the client) refuses
#: a rule it does not know, so a room snapshot that still carries
#: phaseInitEntries loads, ignores it, and reads postmatchEntries at its
#: default. The schema's additionalProperties would refuse it, but nothing
#: runs the schema at runtime.
#:
#: cpPhaseOffset replaced cpPerPhase - a flat 100 at the start of every phase -
#: when CP became something a phase's play earns. The same holds: a snapshot
#: still carrying cpPerPhase loads and ignores it.
COUNTED_RULES = (
    'panelMoversPerTurn', 'postmatchEntries', 'homecomingsPerSetupTurn', 'cpAtStart',
    'cpPhaseOffset')


def rule_of(config: Optional[Dict[str, Any]], key: str) -> Any:
    """
    One of *config*'s rules, or the default's when the config has none.

    A room's config has been normalised by the time it is played, so the
    fallback is for the callers that are handed no config at all.
    """
    rules = (config or {}).get('rules')
    if isinstance(rules, dict) and key in rules:
        return rules[key]
    return DEFAULT_CONFIG['rules'][key]


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _normalise_config(config: Dict[str, Any]) -> None:
    """
    Fill in what an older config predates, in place, before validating it.

    A room saved before `defense` and `rules.objective` existed is otherwise
    rejected outright - every unit missing armour, and under a `regicide`
    default it never chose, a setup with no commander. Both get the value they
    were played with: no armour is 0, and an objective is only regicide if
    there is a commander to lose.
    """
    units = config.get('units')
    if isinstance(units, dict):
        for unit in units.values():
            if isinstance(unit, dict):
                unit.setdefault('defense', 0)

    rules = config.get('rules')
    if rules is None and 'rules' not in config:
        rules = config['rules'] = {}
    # Absent means the current default, not the rule that happened to be in
    # force when the config was written.
    #
    # The tempting alternative - fill in 0, the old floor, so a room frozen
    # before this existed keeps the combat it was played under - cannot tell a
    # historical snapshot from a custom config authored today that simply did
    # not mention the field. It would hand every new custom config the dead
    # matchups this floor exists to remove, silently. An in-progress dev room
    # settling its remaining blows one point differently is the cheaper of the
    # two surprises. Read from DEFAULT_CONFIG so there is one literal.
    if isinstance(rules, dict) and 'minStrikeDamage' not in rules:
        rules['minStrikeDamage'] = DEFAULT_CONFIG['rules']['minStrikeDamage']
    if isinstance(rules, dict) and 'objective' not in rules:
        setup = config.get('setup') if isinstance(config.get('setup'), dict) else {}
        commanded = all(
            isinstance(setup.get(side), dict) and any(
                (units or {}).get(u, {}).get('commander') for u in setup[side].values())
            for side in ('white', 'black')
        )
        rules['objective'] = 'regicide' if commanded else 'elimination'
    # These were constants before they were config, so absent means the
    # number every game was played under.
    if isinstance(rules, dict):
        for key in COUNTED_RULES:
            rules.setdefault(key, DEFAULT_CONFIG['rules'][key])


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

    # `config.get('rules', {})` still hands back None for an explicit null,
    # and every read below would raise AttributeError out of a handler that
    # only catches ValueError - an INTERNAL_ERROR traceback for what is
    # plainly a bad config.
    rules = config.get('rules')
    if not isinstance(rules, dict):
        # Normalisation supplies an absent one, so this is a malformed value:
        # an explicit null, a list, a string. Mirrors the client's
        # 'Missing "rules"'.
        errors.append(f"'rules' must be a dict, got {type(rules).__name__}")
        rules = {}

    falloff = rules.get('rangeFalloff', 0)
    if not isinstance(falloff, (int, float)) or isinstance(falloff, bool) or not 0 <= falloff <= 1:
        errors.append(f"rules.rangeFalloff must be a number 0-1, got {falloff}")

    # Checked because a negative floor corrupts the board rather than merely
    # unbalancing it: strike_damage would return a negative number and
    # HexBoard.deal_damage subtracts it, so a blow would heal whatever it hit.
    floor = rules.get('minStrikeDamage', 0)
    if not isinstance(floor, int) or isinstance(floor, bool) or floor < 0:
        errors.append(f"rules.minStrikeDamage must be an integer >= 0, got {floor}")

    for key in COUNTED_RULES:
        count = rules.get(key, 0)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            errors.append(f"rules.{key} must be an integer >= 0, got {count}")

    if 'setup' not in config:
        errors.append("Missing 'setup'")
    else:
        board = config.get('board') if isinstance(config.get('board'), dict) else {}
        radius = board.get('radius')
        orientation = board.get('orientation', 'edge-up')
        units = config.get('units') if isinstance(config.get('units'), dict) else {}
        for side in ('white', 'black'):
            placement = config['setup'].get(side, {})
            if not isinstance(placement, dict):
                errors.append(f"setup.{side} must be a dict")
                continue
            for coord_str, unit_id in placement.items():
                try:
                    q, r = parse_coord(coord_str)
                except ValueError:
                    errors.append(f"Invalid coordinate '{coord_str}' in setup.{side}")
                    q = r = None
                if unit_id not in config.get('units', {}):
                    errors.append(f"Unknown unit '{unit_id}' at {coord_str} in setup.{side}")
                # Off the battlefield is a panel, and a side's panels are its
                # own two: a unit dealt into the other side's would be counted
                # as theirs by every panel rule. And a commander starts on the
                # battlefield - under regicide one in a panel is a side that
                # has lost before it moves. Mirrors validateGameRules.
                if q is None or not isinstance(radius, int) or on_battlefield(q, r, radius):
                    continue
                owner = color_of_panel(panel_of(*axial_to_pixel(q, r, orientation)))
                if owner != side:
                    errors.append(
                        f"setup.{side} puts a unit at {coord_str}, in {owner}'s panels")
                elif (units.get(unit_id) or {}).get('commander'):
                    errors.append(
                        f"setup.{side} puts its commander at {coord_str}, in a panel - "
                        f"a commander starts on the battlefield")

    # The objective decides how a game is lost, so a config that cannot
    # satisfy it is unplayable rather than merely odd: under regicide a side
    # with no commander on the board has already lost before the first move.
    objective = rules.get('objective', 'regicide')
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
    _normalise_config(config)
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
                # A panel hex is the panel deal's (panels.set_up_panels), and
                # the setup puts a base's squad there on purpose.
                if color_of_panel(panel_of(*axial_to_pixel(
                        q, r, config['board'].get('orientation', 'edge-up')))) == color:
                    continue
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
