"""Config-driven permanent first-star stats, mirrored by unit-stats.ts."""

MAX_UNIT_STAT = 99


def cap_stat(value):
    return max(0, min(MAX_UNIT_STAT, value))


def cap_unit(unit):
    result = dict(unit)
    if 'vet' in unit:
        result['vet'] = min(3, cap_stat(unit['vet']))
    if 'max_hp' in unit:
        result['max_hp'] = cap_stat(unit['max_hp'])
    if 'hp' in unit:
        result['hp'] = min(cap_stat(unit['hp']), result.get('max_hp', MAX_UNIT_STAT))
    return result


def active_vet(unit):
    """Panel units keep their earned stars without activating their unit kit."""
    return 0 if unit.get('panel') else unit.get('vet', 0)


def unit_stats(unit_id, config, vet=0):
    unit = config.get('units', {}).get(unit_id, {})
    bonus = unit.get('veterancy')
    stats = dict(unit)
    if vet >= 1 and bonus:
        for key in ('hp', 'move', 'defense'):
            if key in bonus:
                stats[key] = unit.get(key, 0) + bonus[key]
        if 'attack' in bonus:
            attack = bonus['attack']
            if isinstance(attack, list):
                stats['attack'] = attack
            elif isinstance(unit.get('attack'), list):
                stats['attack'] = [n + attack for n in unit['attack']]
            else:
                stats['attack'] = unit.get('attack', 0) + attack
        for key in ('attackRange', 'attackMinRange', 'heal'):
            if key in bonus:
                stats[key] = bonus[key]
    for key in ('hp', 'move', 'defense', 'attackRange', 'attackMinRange'):
        if key in stats:
            stats[key] = cap_stat(stats[key])
    if 'attack' in stats:
        stats['attack'] = [cap_stat(n) for n in stats['attack']] if isinstance(stats['attack'], list) else cap_stat(stats['attack'])
    if stats.get('heal'):
        stats['heal'] = [cap_stat(n) for n in stats['heal'][:MAX_UNIT_STAT]]
    return stats


def positional_bonus(unit, config, key, stat):
    if not key or active_vet(unit) < 2:
        return 0
    trait = config.get('abilities', {}).get('catalogue', {}).get(
        config.get('units', {}).get(unit['unit_id'], {}).get('passive'), {})
    if trait.get('effect') != 'checkmate':
        return 0
    from .board import hex_distance, parse_coord
    from .panels import in_home_rows
    q, r = parse_coord(key)
    radius = config.get('board', {}).get('radius', 11)
    enemy = 'black' if unit.get('color') == 'white' else 'white'
    return trait.get(stat, 0) if hex_distance((q, r), (0, 0)) <= radius and in_home_rows(enemy, r, radius) else 0


def ranked_unit(unit, config, vet, active=True):
    """Toggle first-star HP by zone: lower max only in panels; add both on exit."""
    bonus = config.get('units', {}).get(unit['unit_id'], {}).get('veterancy', {}).get('hp', 0)
    previous = unit.get('veterancyHpActive', unit.get('vet', 0) >= 1)
    enabled = active and vet >= 1
    delta = bonus * (int(enabled) - int(previous))
    return cap_unit({**unit, 'vet': vet,
                    'hp': unit.get('hp', 0) + max(0, delta) if unit.get('hp', 0) > 0 else 0,
                    'max_hp': unit.get('max_hp', config.get('units', {}).get(unit['unit_id'], {}).get('hp', 0))
                    + (-min(bonus, max(0, unit.get('max_hp', unit.get('hp', 0)) - cap_stat(config.get('units', {}).get(unit['unit_id'], {}).get('hp', 0))))
                       if previous and not enabled else delta),
                    **({'veterancyHpActive': enabled} if bonus and (vet >= 1 or 'veterancyHpActive' in unit) else {})})
