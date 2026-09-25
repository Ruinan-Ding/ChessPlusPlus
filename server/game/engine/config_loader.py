"""
Config loader - parses a GameConfig dict (matching the shared JSON schema)
and builds the initial HexBoard state.

The only fixed game fact is the board: a hexagon with 12 cells per edge
(axial radius 11), rendered with an edge pointing up. Even that lives in
the default config (shared/default-config.json) rather than engine code, so
it can change with the config.

The engine reads all movement and combat behaviour from the config's units -
none of the unit ids mean anything to the code.
"""

from __future__ import annotations
import copy
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .board import HexBoard, coord_key, parse_coord
from .panels import axial_to_pixel, color_of_panel, on_battlefield, panel_of

logger = logging.getLogger('game')

# ---------------------------------------------------------------------------
# Default (built-in) configuration.
#
# One file for both engines: shared/default-config.json, beside the schema.
# The client imports the same file (config.service.ts), so a number changed
# there is changed for solo and networked play alike - there used to be a copy
# here and a copy in the client, kept equal by hand. What each field means is
# in shared/game-config.schema.json.
# ---------------------------------------------------------------------------

#: shared/ at the repository root. A deployment builds from the root so the
#: server can reach it (DEPLOYMENT.md).
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[3] / 'shared' / 'default-config.json'


def _read_default_config() -> Dict[str, Any]:
    with open(DEFAULT_CONFIG_PATH, encoding='utf-8') as fh:
        return json.load(fh)


DEFAULT_CONFIG: Dict[str, Any] = _read_default_config()

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


#: A unit type's whole numbers besides `defense`, and the least of each.
#: Mirrors UNIT_NUMBERS in config.service.ts.
UNIT_NUMBERS = (('hp', 1), ('attack', 0), ('move', 0), ('value', 0))


def _unit_ability_errors(unit_id: str, ability: Any, abilities: Any) -> List[str]:
    """
    What is wrong with a unit type's own ability (``units.<id>.ability``),
    cast from the Unit panel onto the unit itself. Mirrors unitAbilityErrors
    in config.service.ts. The server casts nothing, but it validates the
    units it plays, so the two reject the same configs.
    """
    at = f"units.{unit_id}.ability"
    if not isinstance(ability, str):
        return [f"{at} must be a catalogue id"]
    catalogue = abilities.get('catalogue') if isinstance(abilities, dict) else None
    # A config with no catalogue plays the shipped one, checked on its own.
    if not isinstance(catalogue, dict):
        return []
    entry = catalogue.get(ability)
    if not isinstance(entry, dict):
        return [f'{at} names unknown ability "{ability}"']
    paths = abilities.get('paths') if isinstance(abilities.get('paths'), list) else []
    passive = any(isinstance(p, dict) and p.get('passive') == ability for p in paths)
    if passive or entry.get('target') != 'friendly':
        return [f"{at} must be a friendly ability - it is cast on the unit itself"]
    return []


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
            # The rest the engines read, when they are there: a move of "5" was
            # a TypeError in get_legal_moves - an INTERNAL_ERROR for a plainly
            # bad config. Only when there: rooms hold configs saved by older
            # builds, some without a field or with one since renamed (the old
            # `movement`), and refusing them would strand every such room.
            # The setup screen, where a config is written today, also refuses
            # a missing field and an unknown one (validateGameRules).
            for field, least in UNIT_NUMBERS:
                if field not in unit:
                    continue
                value = unit[field]
                if not isinstance(value, int) or isinstance(value, bool) or value < least:
                    errors.append(
                        f"units.{unit_id}.{field} must be an integer >= {least}, got {value}")
            if 'ability' in unit:
                errors.extend(_unit_ability_errors(
                    unit_id, unit['ability'], config.get('abilities')))

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
