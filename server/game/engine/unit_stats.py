"""Config-driven permanent first-star stats, mirrored by unit-stats.ts."""


def unit_stats(unit_id, config, vet=0):
    unit = config.get('units', {}).get(unit_id, {})
    bonus = unit.get('veterancy')
    if vet < 1 or not bonus:
        return unit
    stats = dict(unit)
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
    return stats


def ranked_unit(unit, config, vet):
    """Raise current/max HP once at the first star; a dead unit stays dead."""
    hp = (config.get('units', {}).get(unit['unit_id'], {}).get('veterancy', {}).get('hp', 0)
          if vet >= 1 and unit.get('vet', 0) < 1 and unit.get('hp', 0) > 0 else 0)
    return {**unit, 'vet': vet, 'hp': unit.get('hp', 0) + hp,
            'max_hp': unit.get('max_hp', config.get('units', {}).get(unit['unit_id'], {}).get('hp', 0)) + hp}
