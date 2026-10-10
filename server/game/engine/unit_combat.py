"""Combat modifiers and veterancy traits, mirrored by unit-combat.ts."""

from .game_rules import rule_of, section_of
from .ability_rules import bonus, carries, combat_stats, has_attack, passive, setting
from .board import hex_distance, parse_coord
from .unit_stats import active_vet, cap_stat, cap_unit, unit_stats


def attack_allowed(unit, distance, config, abilities, counter=False, key=None):
    stats = combat_stats(unit, config, counter)
    if not has_attack(stats) or not stats.get('attackMinRange', 1) <= distance <= stats.get('attackRange', 1):
        return False
    fixed = setting(abilities.get('buffs', {}).get(unit.get('uid')), 'atk')
    attack = stats.get('attack', 1)
    tier = attack[distance - stats.get('attackMinRange', 1)] if isinstance(attack, list) else attack
    return (fixed if fixed is not None else tier + bonus(unit, config, abilities, 'atk', key=key)) > 0


def strike(source, target, distance, config, abilities, counter=False, target_base=False, source_key=None, target_key=None):
    from .game_logic import ranged_damage
    if not attack_allowed(source, distance, config, abilities, counter, source_key):
        return 0
    buffs = abilities.get('buffs', {})
    if carries(buffs.get(target.get('uid')), 'invulnerable'):
        return 0
    stats = combat_stats(source, config, counter)
    attack = setting(buffs.get(source.get('uid')), 'atk')
    if attack is None:
        attack = cap_stat(ranged_damage(stats.get('attack', 1), distance, config, stats.get('attackMinRange', 1))
                     + bonus(source, config, abilities, 'atk', key=source_key))
    defense = setting(buffs.get(target.get('uid')), 'def')
    if defense is None:
        defense = cap_stat(unit_stats(target['unit_id'], config, active_vet(target, config)).get('defense', 0)
                      + bonus(target, config, abilities, 'def', target_base, True, key=target_key))
    return min(attack, max(rule_of(config, 'minStrikeDamage'), attack - defense)) if attack > 0 else 0


def exchange(attacker, defender, distance, config, abilities, counters=True, target_base=False, source_key=None, target_key=None):
    attacker, defender = cap_unit(attacker), cap_unit(defender)
    buffs = abilities.get('buffs', {})
    damage = strike(attacker, defender, distance, config, abilities, target_base=target_base, source_key=source_key, target_key=target_key)
    target_hp = max(0, defender['hp'] - damage)
    countered = counters and section_of(config, 'combat')['counterattacks'] and target_hp > 0 and not carries(buffs.get(attacker.get('uid')), 'nullify') and attack_allowed(
        defender, distance, config, abilities, True, target_key)
    counter = strike(defender, attacker, distance, config, abilities, True, source_key=target_key, target_key=source_key) if countered else 0
    attacker_hp = max(0, attacker['hp'] - counter)
    second_strike = bool(countered and attacker_hp > 0 and carries(buffs.get(attacker.get('uid')), 'charge'))
    second = strike(attacker, defender, distance, config, abilities, target_base=target_base, source_key=source_key, target_key=target_key) if second_strike else 0
    return {'damage': damage, 'counter_damage': counter, 'countered': bool(countered),
            'second_strike': second_strike, 'second_damage': second, 'target_hp': max(0, target_hp - second), 'attacker_hp': attacker_hp}


def taunt_allows(occupied, from_key, target_key, config, abilities):
    attacker = occupied[from_key]
    targets = [key for key, unit in occupied.items() if unit['color'] != attacker['color']
               and carries(abilities.get('buffs', {}).get(unit.get('uid')), 'taunt')
               and attack_allowed(attacker, hex_distance(parse_coord(from_key), parse_coord(key)), config, abilities, key=from_key)]
    return not targets or target_key in targets


def after_exchange(context, from_key, target_key, attacker, defender, result):
    abilities, config = context.data, context.config
    occupied = context.recipients()
    if carries(abilities['buffs'].get(attacker.get('uid')), 'cleave'):
        for key, unit in list(occupied.items()):
            if key != target_key and unit['color'] != attacker['color'] and 1 <= hex_distance(parse_coord(from_key), parse_coord(key)) <= config['abilities']['catalogue'][config['units'][attacker['unit_id']]['ability']].get('radius', 1):
                context.change_hp(key, unit, -strike(attacker, unit, 1, config, abilities,
                    target_base=unit.get('panel') in ('bl', 'tr'), source_key=from_key, target_key=key))
    if result['target_hp'] > 0 and carries(abilities['buffs'].get(attacker.get('uid')), 'attack-drain'):
        entry = config['abilities']['catalogue'][config['units'][attacker['unit_id']]['ability']]
        context.color = attacker['color']
        context.add_buff(defender, entry, {'mov': entry.get('mov', 0)}, True)
    for source, recipient, alive in ((attacker, defender, result['target_hp'] > 0),
                                     (defender, attacker, result['attacker_hp'] > 0)):
        trait = passive(source, config)
        if alive and trait.get('effect') == 'on-hit-drain':
            context.color = source['color']
            context.add_buff(recipient, trait, hostile=True)
