"""Versioned gameplay settings. Legacy defaults are immutable compatibility data."""
import copy
import json
import math
from pathlib import Path
from jsonschema import Draft7Validator, validators

SHARED = Path(__file__).resolve().parents[3] / 'shared'
DEFAULT = json.loads((SHARED / 'default-config.json').read_text(encoding='utf-8'))
LEGACY = json.loads((SHARED / 'legacy-rules-v1.json').read_text(encoding='utf-8'))
PREVIOUS_CONFIG = json.loads((SHARED / 'legacy-config-v1.json').read_text(encoding='utf-8'))
SECTIONS = tuple(LEGACY)
RULE_PATHS = {
    'rangeFalloff': ('combat', 'rangeFalloff'), 'minStrikeDamage': ('combat', 'minStrikeDamage'),
    'objective': ('match', 'objective'), 'maxTurns': ('match', 'maxTurns'),
    'turnTimeLimit': ('match', 'turnTimeLimit'), 'cpAtStart': ('match', 'cpAtStart'),
    'pointsAtStart': ('economy', 'pointsAtStart'), 'upAtStart': ('economy', 'upAtStart'),
}
SCHEMA = json.loads((SHARED / 'game-config.schema.json').read_text(encoding='utf-8'))
DOMAIN_SCHEMA = {'type': 'object', 'properties': {k: SCHEMA['properties'][k] for k in (*SECTIONS, 'ruleset', 'version')},
                 'required': [*SECTIONS, 'ruleset', 'version'], 'definitions': SCHEMA.get('definitions', {})}
FINITE_SCHEMA = validators.extend(Draft7Validator, type_checker=Draft7Validator.TYPE_CHECKER.redefine(
    'number', lambda _, value: type(value) is int or type(value) is float and math.isfinite(value)))
VALIDATOR = FINITE_SCHEMA(DOMAIN_SCHEMA)


def fill_missing(value, defaults):
    if isinstance(value, dict) and isinstance(defaults, dict):
        for key, default in defaults.items():
            if key not in value:
                value[key] = copy.deepcopy(default)
            elif isinstance(default, dict):
                fill_missing(value[key], default)
    return value


def section_of(config, key):
    if config is None:
        return DEFAULT[key]
    if config.get('version') == '2.0':
        return config[key] if key in config else DEFAULT[key]
    result = LEGACY[key]
    rules = config.get('rules') or {}
    if key in ('match', 'combat', 'economy') and isinstance(rules, dict):
        for name, (section, field) in RULE_PATHS.items():
            if section == key and name in rules and rules[name] != result[field]:
                result = {**result, field: rules[name]}
        if key == 'match' and 'cpPhaseOffset' in rules and any(
                phase['cpAward'] != index * rules['cpPhaseOffset'] for index, phase in enumerate(result['phases'], 1)):
            result = {**result, 'phases': [dict(phase, cpAward=index * rules['cpPhaseOffset'])
                                         for index, phase in enumerate(result['phases'], 1)]}
        if key == 'combat' and 'rangeFalloff' not in rules:
            result = {**result, 'rangeFalloff': 0}

    return result


def legacy_rules(config):
    if config.get('version') != '2.0':
        return config.get('rules')
    result = {key: section_of(config, section)[field] for key, (section, field) in RULE_PATHS.items()}
    result['cpPhaseOffset'] = section_of(config, 'match')['phases'][0]['cpAward']
    return result


def rule_of(config, key):
    if key == 'cpPhaseOffset':
        return section_of(config, 'match')['phases'][0]['cpAward']
    section, field = RULE_PATHS[key]
    return section_of(config, section)[field]


def migrate_config(raw):
    config = copy.deepcopy(raw)
    version = config.get('version')
    if version not in ('1.0', '2.0'):
        raise ValueError(f'Unsupported configuration format {version!r}; supported formats: 1.0, 2.0')
    if version == '1.0':
        config.setdefault('abilities', copy.deepcopy(PREVIOUS_CONFIG['abilities']))
        rules = config.get('rules', {})
        if not isinstance(rules, dict):
            raise ValueError('rules must be an object')
        for key in SECTIONS:
            config[key] = copy.deepcopy(section_of(config, key))
        config['ruleset'] = {'id': 'imported', 'revision': None}
        config.pop('rules', None)
        config['version'] = '2.0'
        config = {key: value for key, value in config.items()
                  if key in {'version', 'ruleset', 'board', 'units', 'abilities', 'setup', *SECTIONS}}
    else:
        config.setdefault('abilities', copy.deepcopy(DEFAULT['abilities']))
        if 'rules' in config:
            raise ValueError('rules is a format 1.0 field; use the format 2.0 sections')
        for key in (*SECTIONS, 'ruleset'):
            if key not in config:
                config[key] = copy.deepcopy(DEFAULT[key])
            else:
                fill_missing(config[key], DEFAULT[key])
    return config


def domain_errors(config):
    allowed = {'version', 'ruleset', 'board', 'units', 'abilities', 'setup', *SECTIONS}
    extra = set(config) - allowed
    errors = [f"Unknown configuration field: {key}" for key in sorted(extra)] + [f"{'.'.join(map(str, error.absolute_path)) or 'config'}: {error.message}"
              for error in sorted(VALIDATOR.iter_errors(config), key=lambda e: str(list(e.absolute_path)))]
    if errors:
        return errors
    match = config['match']
    count = len(match['phases'])
    for index, phase in enumerate(match['phases']):
        if phase['halftimeAfter'] > phase['turns']:
            errors.append(f'match.phases.{index}.halftimeAfter exceeds turns')
    for key, values in config['stageRules']['opening']['moves'].items():
        if len(values) != match['opening']['turns']:
            errors.append(f'stageRules.opening.moves.{key} must have one entry per opening turn')
    for index, rule in enumerate(match['winConditions']['earlyPhaseLosses']):
        if rule['phase'] > count:
            errors.append(f'match.winConditions.earlyPhaseLosses.{index}.phase does not exist')
    heal = config['veterancy']['fullHealPhase']
    if isinstance(heal, int) and heal > count:
        errors.append('veterancy.fullHealPhase does not exist')
    radius = config.get('board', {}).get('radius', 11)
    for index, zone in enumerate(config['scoring']['zones']):
        if 'center' in zone and max(abs(zone['center'][0]), abs(zone['center'][1]), abs(sum(zone['center']))) > radius:
            errors.append(f'scoring.zones.{index}.center must be on the battlefield')
        if (zone['kind'] == 'base') != bool(zone['owner']):
            errors.append(f'scoring.zones.{index}.owner must identify base zones only')
    return errors
