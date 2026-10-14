"""Bounded, config-driven turn search. Every candidate uses the network turn runner."""
import asyncio
import copy
import json
import logging
import os
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from .cpu_worker import initialise, run

from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from .consumers import GameConsumer
from .models import GameState
from .validators import ValidationError
from .engine import panels
from .engine.ability_rules import AbilityContext, ability_config, bonus, combat_stats, initial_state, passive, setting, path_passive, carries, actions_used, battlefield_action_bonus
from .engine.board import HexBoard, coord_key, hex_distance, parse_coord
from .engine.config_loader import load_config, build_initial_board, UNIT_ACTIVES
from .engine.economy import points_of, unit_points_of
from .engine.game_logic import board_move_uids, get_legal_moves_filtered, opening_moved_hexes
from .engine.phases import attacks_allowed, is_entry_open, is_homecoming_open, is_overtime, is_initialization, board_moves_per_turn, phase_index_at, phases_of, stage_rules
from .engine.scoring import capture_eligible, capture_zones, capture_claims, capture_score, unit_value, decided_on_points, deaths_of, phase_total
from .engine.unit_combat import attack_allowed, exchange, strike
from .engine.unit_stats import active_vet, unit_stats, cap_stat
from .engine.game_rules import section_of


PROFILES = {name: (max(0.01, min(5, float(os.environ.get(f'CPP_CPU_{name.upper()}_SECONDS', seconds)))),
                   max(2, min(64, int(os.environ.get(f'CPP_CPU_{name.upper()}_BEAM', width)))), depth)
            for name, seconds, width, depth in (('easy', 0.5, 8, 1), ('normal', 2.0, 16, 2), ('hard', 5.0, 32, 4))}
MAX_BYTES = 2 * 1024 * 1024
MAX_ACTIONS = 10000


def color_of(state):
    return 'white' if state.current_turn == state.player_white else 'black'


def distance(a, b):
    return hex_distance(parse_coord(a), parse_coord(b))


def position_value(state, color):
    if state.is_finished:
        return 0 if not state.winner else float('inf') if state.winner == getattr(state, 'player_' + color) else -float('inf')
    config, abilities = state.config_snapshot, state.ability_state
    ctx = AbilityContext(state)
    occupied = ctx.recipients()
    zones = capture_zones(ctx.radius, config)
    claims = capture_claims(state.board_state, ctx.radius, config)
    score = 0.0
    threats = []
    for at, enemy in state.board_state.items():
        stats = combat_stats(enemy, config, key=at)
        attacks = stats.get('attack', 0)
        if not (max(attacks, default=0) if isinstance(attacks, list) else attacks) or carries(abilities.get('buffs', {}).get(enemy.get('uid')), 'action-lock'):
            continue
        ring = stats.get('attackMinRange', 1) + attacks.index(max(attacks)) if isinstance(attacks, list) else stats.get('attackMinRange', 1)
        move = cap_stat(stats.get('move', 0) + bonus(enemy, config, abilities, 'mov', key=at))
        threats.append((at, enemy, ring, move + stats.get('attackRange', 1)))
    for key, unit in occupied.items():
        sign = 1 if unit['color'] == color else -1
        stats = combat_stats(unit, config, key=key)
        attack = stats.get('attack', 0)
        power = max(attack, default=0) if isinstance(attack, list) else attack
        power += bonus(unit, config, abilities, 'atk', key=key) if power else 0
        held_buff = abilities.get('buffs', {}).get(unit.get('uid'))
        fixed = setting(held_buff, 'atk')
        power = cap_stat(fixed if fixed is not None else power)
        fixed_def = setting(held_buff, 'def')
        defense = cap_stat(fixed_def if fixed_def is not None else stats.get('defense', 0) + bonus(unit, config, abilities, 'def', key=key))
        mov = stats.get('move', 0) + bonus(unit, config, abilities, 'mov', panels.is_base(unit.get('panel')), key=key)
        mov = cap_stat(mov)
        healing = stats.get('heal', [])
        hel = cap_stat(max(healing, default=0) + bonus(unit, config, abilities, 'hel', key=key)) if healing else 0
        fixed_hel = setting(held_buff, 'hel')
        if fixed_hel is not None and healing:
            hel = fixed_hel
        health = unit['hp'] / max(1, unit.get('max_hp', stats.get('hp', 1)))
        field = key in state.board_state
        deployment = 1 if field else 0.65 if not panels.is_base(unit.get('panel')) else 0.25
        worth = unit_value(config, unit['unit_id'])
        score += sign * (worth * (0.45 + 0.55 * health) + power * 1.4 + defense * 0.45
                         + mov * 0.4 + hel * 1.4 + max(0, active_vet(unit, config)) * 3) * deployment
        goals = [z['center'] for z in zones if capture_eligible(unit, z, config) and any(claims.get(hex_key) != unit['color'] for hex_key in z['hexes'])]
        if is_overtime(state.turn_number, config) and field:
            enemy_commanders = [at for at, other in state.board_state.items() if other.get('owner', other['color']) != unit['color'] and config['units'][other['unit_id']].get('commander')]
            gap = min((distance(key, at) for at in enemy_commanders), default=ctx.radius * 2)
            defending = section_of(config, 'match')['winConditions']['overtimeWinner'] == unit['color']
            score += sign * (gap * 2 if defending and config['units'][unit['unit_id']].get('commander') else (ctx.radius * 2 - gap) * (12 if not defending else 2))
        elif field and goals:
            score += sign * max(0, 15 - min(distance(key, goal) for goal in goals)) * 1.2
        elif field and not goals:
            enemies = [at for at, other in state.board_state.items() if other['color'] != unit['color']]
            score += sign * max(0, ctx.radius * 2 - min((distance(key, at) for at in enemies), default=ctx.radius * 2)) * 1.2
        elif not field:
            if panels.is_base(unit.get('panel')):
                goal = panels.wrap_tips(panels.color_of_panel(unit['panel']), ctx.radius)['base']
            else:
                goal = next(k for k, gateway in panels.gateway_hexes(ctx.radius).items() if gateway['color'] == unit['color'])
            score -= sign * min(25, distance(key, goal)) * 0.3
        if field and unit['color'] == color_of(state) and attacks_allowed(state.turn_number, config) and not abilities.get('unitProgress', {}).get(unit.get('uid'), {}).get('attacked'):
            targets = [(at, enemy) for at, enemy in occupied.items() if enemy['color'] != unit['color']
                       and attack_allowed(unit, distance(key, at), config, abilities, key=key)]
            if carries(held_buff, 'cleave'):
                radius = ability_config(config)['catalogue'][config['units'][unit['unit_id']]['ability']].get('radius', 1)
                score += sign * sum(strike(unit, enemy, 1, config, abilities, source_key=key, target_key=at)
                                    for at, enemy in targets if distance(key, at) <= radius)
            if carries(held_buff, 'charge'):
                score += sign * max((exchange(unit, enemy, distance(key, at), config, abilities, source_key=key, target_key=at)['second_damage']
                                     for at, enemy in targets), default=0)
            if carries(held_buff, 'attack-drain') and targets:
                score += sign * 4
        if carries(held_buff, 'taunt'):
            protected = [u for at, u in state.board_state.items() if u['color'] == unit['color'] and distance(key, at) <= 2
                         and config['units'][u['unit_id']].get('commander')]
            if protected:
                score += sign * 15
        if field:
            incoming = max((strike(enemy, unit, ring, config, abilities, source_key=key, target_key=key)
                            for at, enemy, ring, reach in threats if enemy['color'] != unit['color'] and distance(key, at) <= reach), default=0)
            if unit['color'] == color:
                if incoming >= unit['hp']:
                    score -= 1e7 if config['units'][unit['unit_id']].get('commander') else worth * 8 + power * 2
                elif config['units'][unit['unit_id']].get('commander'):
                    score -= incoming * 8
                    if incoming and unit['hp'] - incoming < unit.get('max_hp', unit['hp']) * 0.55:
                        score -= 2000
            else:
                score += min(incoming, unit['hp']) * 0.5
        if config['units'][unit['unit_id']].get('commander') and field:
            score += sign * health * 500
            for enemy_key, enemy in state.board_state.items():
                if enemy['color'] == unit['color']:
                    continue
                gap = distance(key, enemy_key)
                if carries(abilities.get('buffs', {}).get(enemy.get('uid')), 'action-lock'):
                    continue
                damage = strike(enemy, unit, gap, config, abilities, source_key=enemy_key, target_key=key)
                if damage:
                    score -= (10000 if damage >= unit['hp'] else damage * 8) if unit['color'] == color else -min(damage, unit['hp']) * 0.5
    for side in ('white', 'black'):
        sign = 1 if side == color else -1
        if not is_overtime(state.turn_number, config):
            phase = max(1, phase_index_at(state.turn_number, config))
            multiplier = phases_of(config)[phase]['multiplier']
            score += sign * phase_total(capture_score(claims, side, ctx.radius, config), deaths_of(config, state.move_history, side, phase), multiplier, config) * 7
        held = abilities['loadouts'][side]
        for ability_id in held:
            entry = ability_config(config)['catalogue'][ability_id]
            usefulness = max(abs(entry.get('atk', 0)), abs(entry.get('def', 0)), abs(entry.get('mov', 0)) * 2, entry.get('heal', 0) * 2, entry.get('damage', 0) * 3)
            score += sign * (1 + usefulness / max(1, entry.get('cost', 0)) * 8)
        path_ctx = AbilityContext(state)
        path_ctx.color = side
        score += sign * path_ctx.cp() * 0.025
        score += sign * sum(1 for u in occupied.values() if u['color'] == side) * (
            3 if abilities['paths'][side] else 0)
        score += sign * (points_of(side, state.turn_number, state.move_history, config, state.phase_bank)
                         + abilities['pointDelta'][side]) * 0.025
        score += sign * unit_points_of(side, state.move_history, config) * 0.1
    for bank in state.phase_bank.values():
        score += (bank.get(color, 0) - bank.get('black' if color == 'white' else 'white', 0)) * 5
        if bank.get('pendingLoss'):
            score += -1e6 if bank['pendingLoss'] == color else 1e6
    verdict = decided_on_points(state.phase_bank, config)
    if verdict:
        score += 1e6 if verdict == color else -1e6
    return score


def movement_priority(key, unit, state, occupied, claims=None, zones=None):
    config = state.config_snapshot
    zones = zones if zones is not None else capture_zones(config['board']['radius'], config)
    claims = claims if claims is not None else capture_claims(state.board_state, config['board']['radius'], config)
    goals = [z['center'] for z in zones if capture_eligible(unit, z, config) and any(claims.get(k) != unit['color'] for k in z['hexes'])]
    if not goals:
        goals = [at for at, other in occupied.items() if other['color'] != unit['color']]
    if is_overtime(state.turn_number, config):
        goals = [at for at, other in occupied.items() if other.get('owner', other['color']) != unit['color'] and config['units'][other['unit_id']].get('commander')]
    gap = min((distance(key, goal) for goal in goals), default=0)
    retreat = is_overtime(state.turn_number, config) and config['units'][unit['unit_id']].get('commander') and section_of(config, 'match')['winConditions']['overtimeWinner'] == unit['color']
    result = gap if retreat else -gap
    stats = combat_stats(unit, config)
    attack = stats.get('attack', 0)
    power = max(attack, default=0) if isinstance(attack, list) else attack
    if power > 0:
        low, high = stats.get('attackMinRange', 1), stats.get('attackRange', 1)
        for target, other in occupied.items():
            if other['color'] != unit['color'] and low <= distance(key, target) <= high:
                result += 3
                if config['units'][other['unit_id']].get('commander'):
                    result += 10
    return result


def candidate_commands(state, deadline):
    """Prioritize tactical targets, then useful positions; handlers reject exhausted actions."""
    ctx = AbilityContext(state)
    color, config, abilities = ctx.color, ctx.config, ctx.data
    occupied = ctx.recipients()
    zones = capture_zones(ctx.radius, config)
    claims = capture_claims(state.board_state, ctx.radius, config)
    def actor_priority(item):
        key, unit = item
        goals = [z['center'] for z in zones if capture_eligible(unit, z, config) and any(claims.get(k) != unit['color'] for k in z['hexes'])]
        if not goals:
            goals = [at for at, other in occupied.items() if other['color'] != unit['color']]
        move = unit_stats(unit['unit_id'], config, active_vet(unit, config)).get('move', 0)
        return (key not in state.board_state, not config['units'][unit['unit_id']].get('commander', False),
                min((distance(key, g) for g in goals), default=0) - move, key)
    friends = sorted(((k, u) for k, u in occupied.items() if u['color'] == color), key=actor_priority)
    enemies = [(k, u) for k, u in occupied.items() if u['color'] != color]
    catalogue = ability_config(config)
    if attacks_allowed(ctx.ply, config):
        for key, unit in friends:
            if key not in state.board_state:
                continue
            for target, enemy in enemies:
                gap = distance(key, target)
                if config['units'][enemy['unit_id']].get('commander') and attack_allowed(unit, gap, config, abilities, key=key):
                    hit = exchange(unit, enemy, gap, config, abilities, source_key=key, target_key=target)
                    if hit['target_hp'] <= 0 and hit['attacker_hp'] > 0:
                        yield {'type': 'make_move' if target in state.board_state else 'panel_attack', 'from': key, 'to': key, 'attack': target, 'more': True}
    out = []
    # Free choices are explored alongside paid casts, never charged at guessed prices.
    for ability in catalogue.get('pool', [])[::2]:
        if ability not in abilities['loadouts'][color]:
            out.append({'type': 'pick_pair', 'id': ability})
    if len(abilities['loadouts'][color]) >= catalogue.get('slots', 4):
        out.extend({'type': 'reset_pair', 'id': i} for i in abilities['loadouts'][color][::2])
    if abilities['paths'][color] is None:
        out.extend({'type': 'pick_path', 'id': p['id']} for p in catalogue.get('paths', []))
    path = next((p for p in catalogue.get('paths', []) if p['id'] == abilities['paths'][color]), {})
    sources = [(i, None, None) for i in abilities['loadouts'][color]]
    sources += [(path[i], None, None) for i in ('utility', 'skill', 'ultimate') if path.get(i)]
    sources += [(config['units'][u['unit_id']]['ability'], k, u) for k, u in friends
                if config['units'][u['unit_id']].get('ability') and active_vet(u, config) >= section_of(config, 'veterancy')['abilityUnlock']]
    for ability, source_key, source in sources:
        if time.monotonic() >= deadline:
            break
        entry = catalogue['catalogue'][ability]
        base = {'type': 'cast_ability', 'id': ability, **({'unitUid': source['uid']} if source else {})}
        mode, target = entry.get('effect'), entry.get('target', 'friendly')
        category = 'unitAbilities' if source else ('cpUtilities' if ability == path.get('utility') else 'cpUltimates' if ability == path.get('ultimate') else 'cpSkills') if ability in (path.get('utility'), path.get('skill'), path.get('ultimate')) else 'poolAbilities'
        if not stage_rules(ctx.ply, config)[category]:
            continue
        if source and (abilities['endedUnits'].get(source['uid']) == ctx.ply or (abilities['unitProgress'].get(source['uid']) and abilities.get('activeUnit') != source['uid']) or any(m.get('entered') and m.get('turn') == ctx.ply and (m.get('unit') or {}).get('uid') == source['uid'] for m in ctx.history)):
            continue
        cooldown = abilities['unitCooldowns'].get(source['uid'], {}).get('turns', 0) if source else abilities['cooldowns'][color].get(ability, 0)
        if cooldown or (source and abilities['usedUnits'].get(source['uid']) == ctx.ply):
            continue
        discount = path_passive(config, abilities, color)
        cost = max(discount.get('minimumCost', 1), entry.get('cost', 0) - discount['costReduction']) if discount.get('costReduction') else entry.get('cost', 0)
        available = unit_points_of(color, ctx.history, config) if source and mode in UNIT_ACTIVES else ctx.cp() if category.startswith('cp') else points_of(color, ctx.ply, ctx.history, config, state.phase_bank) + abilities['pointDelta'][color]
        if cost > available:
            continue
        def target_priority(item):
            key, unit = item
            missing = unit.get('max_hp', unit['hp']) - unit['hp']
            enemies_near = min((distance(key, at) for at, enemy in occupied.items() if enemy['color'] != unit['color']), default=ctx.radius * 2)
            stats = combat_stats(unit, config, key=key)
            attack = stats.get('attack', 0)
            power = max(attack, default=0) if isinstance(attack, list) else attack
            return (missing * (entry.get('heal', 0) > 0 or mode == 'sacrifice') + power + unit.get('vet', 0) * 2 - enemies_near)
        valid_friends = [(k, u) for k, u in friends if entry.get('scope') != 'field-reserve' or not panels.is_base(u.get('panel'))]
        valid_enemies = [(k, u) for k, u in enemies if entry.get('scope') != 'field-reserve' or not panels.is_base(u.get('panel'))]
        if (not source and target in ('friendly', 'enemy')) or mode in ('control', 'sacrifice'):
            valid_friends.sort(key=lambda item: -target_priority(item))
            valid_enemies.sort(key=lambda item: -target_priority(item))
        if mode == 'recharge':
            out.extend({**base, 'pairId': i} for i in abilities['loadouts'][color][::2])
        elif mode == 'control' or (source and mode == 'sacrifice' and 'stars' in entry):
            targets = [(k, u) for k, u in (valid_enemies if mode == 'control' else valid_friends)
                       if (not source or u['uid'] != source['uid']) and (mode != 'control' or distance(source_key, k) <= entry.get('radius', 1))]
            out.extend({**base, 'targetUid': u['uid']} for k, u in targets[:3])
            if mode == 'sacrifice' and 'battlefieldActions' not in entry:
                extras = [(k, u) for k, u in friends if k in state.board_state and u['uid'] != source['uid']]
                if extras:
                    extra = max(extras, key=lambda item: movement_priority(item[0], item[1], state, occupied, claims, zones))[1]['uid']
                    out.extend({**command, 'extraUid': extra} for command in list(out)
                               if command.get('unitUid') == source['uid'] and command.get('targetUid'))
        elif source or target in ('universal', 'all-enemies'):
            if source and mode in ('attack-drain', 'cleave', 'charge', 'leech') and not any(attack_allowed(source, distance(source_key, k), config, abilities, key=source_key) for k, u in enemies):
                continue
            out.append(base)
        elif target in ('friendly', 'enemy'):
            out.extend({**base, 'targetUid': u['uid']} for k, u in (valid_friends if target == 'friendly' else valid_enemies)[:3])
        elif target == 'hex':
            # Empty centres can put several units on useful rings/lines.
            centres = set(occupied)
            for key in occupied:
                q, r = parse_coord(key)
                centres.update(coord_key(q + dq, r + dr) for dq, dr in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)))
            def area_value(key):
                from .engine.ability_rules import effect_band
                return sum((1 if u['color'] != color else -1) * (3 if effect_band(key, k, entry, ctx.orientation) in ('centre', 'splash') else -1)
                           for k, u in occupied.items() if effect_band(key, k, entry, ctx.orientation))
            out.extend({**base, 'hex': key} for key in sorted(centres, key=lambda k: (-area_value(k), k))[:4])
    for command in out:
        yield command
    board = HexBoard.from_dict(ctx.radius, state.board_state)
    for key, unit in friends:
        tactical, walks = [], []
        if time.monotonic() >= deadline:
            break
        if key not in state.board_state:
            budget = panels.panel_allowance(config, state.move_history, unit, ctx.ply, abilities)
            if not budget:
                continue
            targets = panels.panel_move_targets(config, ctx.radius, state.move_history, state.board_state, key,
                        ctx.ply, unit_points_of(color, state.move_history, config), ctx.orientation, abilities)
            goals = panels.wrap_tips(panels.color_of_panel(unit['panel']), ctx.radius) if panels.is_base(unit.get('panel')) else {k: k for k, gate in panels.gateway_hexes(ctx.radius).items() if gate['color'] == color}
            def panel_value(destination):
                wrapped = panels.panel_of(*panels.axial_to_pixel(*parse_coord(destination), ctx.orientation)) != unit.get('panel')
                return 20 * wrapped - min(distance(destination, g) for g in goals.values())
            walks.extend((panel_value(k), {'type': 'panel_move', 'from': key, 'to': k})
                         for k in sorted(targets, key=lambda k: (-panel_value(k), k))[:3])
            if not panels.is_base(unit.get('panel')) and is_entry_open(ctx.ply, config):
                entries = panels.entry_targets(config, ctx.radius, occupied, state.board_state, key, ctx.orientation, budget,
                                               passive(unit, config).get('effect') == 'hop')
                walks.extend((30 + movement_priority(k, unit, state, occupied, claims, zones), {'type': 'enter_board', 'from': key, 'to': k})
                             for k in sorted(entries, key=lambda k: (-movement_priority(k, unit, state, occupied, claims, zones), k))[:4])
            for _, command in sorted(walks, key=lambda item: -item[0]):
                yield command
            continue
        progress = abilities.get('unitProgress', {}).get(unit['uid'], {})
        if (is_initialization(ctx.ply, config) and not progress and key in opening_moved_hexes(state.move_history, color, config)) or abilities['endedUnits'].get(unit['uid']) == ctx.ply or progress.get('ended') or progress.get('healed'):
            continue
        if progress and (abilities.get('activeUnit') != unit['uid'] or (progress.get('attacked') and passive(unit, config).get('effect') != 'rapid-movement')):
            continue
        if not progress and unit['uid'] not in board_move_uids(state.move_history, ctx.ply, color, config) and abilities['extraUnits'].get(unit['uid']) != ctx.ply and actions_used(state, color) >= board_moves_per_turn(ctx.ply, config) + battlefield_action_bonus(state.move_history, ctx.ply, color):
            continue
        spent = progress.get('spent', 0)
        destinations = [coord_key(*c) for c in get_legal_moves_filtered(board, parse_coord(key), config, color, -spent, abilities)]
        ranked = sorted(destinations, key=lambda k: (-movement_priority(k, unit, state, occupied, claims, zones), k))
        chosen = ranked[:4]
        if config['units'][unit['unit_id']].get('commander'):
            def safety(destination):
                return min((distance(destination, at) - cap_stat(unit_stats(enemy['unit_id'], config, active_vet(enemy, config)).get('move', 0) + bonus(enemy, config, abilities, 'mov', key=at)) - combat_stats(enemy, config).get('attackRange', 1) for at, enemy in enemies if at in state.board_state and combat_stats(enemy, config).get('attack')), default=ctx.radius * 2)
            chosen.extend(k for k in sorted(destinations, key=lambda k: (-safety(k), k))[:2] if k not in chosen)
        for destination in [key, *chosen]:
            base = {'type': 'make_move', 'from': key, 'to': destination, 'more': True}
            if destination != key:
                walks.append((movement_priority(destination, unit, state, occupied, claims, zones), base))
            if attacks_allowed(ctx.ply, config):
                for target, enemy in enemies:
                    gap = distance(destination, target)
                    if attack_allowed(unit, gap, config, abilities, key=destination):
                        hit = exchange(unit, enemy, gap, config, abilities, target_base=panels.is_base(enemy.get('panel')),
                                       source_key=destination, target_key=target)
                        priority = hit['damage'] * 2 - hit['counter_damage'] + (100000 if hit['target_hp'] <= 0 and config['units'][enemy['unit_id']].get('commander') else 0)
                        tactical.append((priority, {**base, 'type': 'panel_attack' if target not in state.board_state else 'make_move', 'attack': target}))
            if stage_rules(ctx.ply, config)['normalHeal'] and unit_stats(unit['unit_id'], config, active_vet(unit, config)).get('heal'):
                for target, ally in friends:
                    if target != key and ally['hp'] < ally.get('max_hp', ally['hp']):
                        tactical.append((ally.get('max_hp', ally['hp']) - ally['hp'], {**base, 'heal': target}))
        # A destination outside the top positional shortlist may offer the winning shot.
        if attacks_allowed(ctx.ply, config):
            for target, enemy in enemies:
                if config['units'][enemy['unit_id']].get('commander'):
                    for destination in ranked[4:]:
                        gap = distance(destination, target)
                        if attack_allowed(unit, gap, config, abilities, key=destination):
                            tactical.append((1000, {'type': 'make_move' if target in state.board_state else 'panel_attack',
                                'from': key, 'to': destination, 'attack': target, 'more': True}))
        if is_homecoming_open(ctx.ply, config):
            home = panels.homecoming_targets(config, ctx.radius, occupied, state.board_state, key, ctx.orientation)
            walks.extend((unit_value(config, unit['unit_id']) * (3 if unit.get('vet') == 3 else 0.1),
                          {'type': 'make_move', 'from': key, 'to': k, 'withdraw': True, 'more': True}) for k in list(home)[:2])
        for _, command in sorted(tactical, key=lambda item: -item[0]):
            yield command
        for _, command in sorted(walks, key=lambda item: -item[0]):
            yield command


async def search_turn(state, difficulty, budget=None):
    seconds, width, depth = PROFILES[difficulty]
    deadline = time.monotonic() + min(seconds, budget if budget is not None else seconds)
    own_deadline = time.monotonic() + (deadline - time.monotonic()) * (0.6 if depth > 1 else 1)
    runner = GameConsumer()
    color = color_of(state)
    passed = await runner._preview_turn(state, [])
    best = (position_value(passed, color), [{'type': 'pass_turn'}], passed)
    beam = [(position_value(state, color), [], state)]
    finished = [best]
    # ponytail: beam search prunes quiet combinations; widen budgets if tactical benchmarks demand it.
    for _ in range(12):
        children = []
        for _, commands, node in beam:
            preparation = time.monotonic() + max(0, own_deadline - time.monotonic()) * 0.25
            groups = {'movement': [], 'ability': [], 'choice': []}
            node_occupied = AbilityContext(node).recipients()
            for command in candidate_commands(node, preparation):
                target = node_occupied.get(command.get('attack'))
                source = node.board_state.get(command.get('from'))
                if source and target and node.config_snapshot['units'][target['unit_id']].get('commander'):
                    hit = exchange(source, target, distance(command['to'], command['attack']), node.config_snapshot,
                                   node.ability_state, source_key=command['to'], target_key=command['attack'])
                    if hit['target_hp'] <= 0:
                        try:
                            complete = await runner._preview_turn(node, [command])
                        except (ValidationError, ValueError, KeyError):
                            continue
                        if complete.is_finished and complete.winner == getattr(node, 'player_' + color):
                            return [*commands, command, {'type': 'pass_turn'}]
                kind = 'movement' if command['type'] in ('make_move', 'panel_move', 'panel_attack', 'enter_board') else 'ability' if command['type'] == 'cast_ability' else 'choice'
                groups[kind].append(command)
            node_radius = node.config_snapshot['board']['radius']
            node_claims = capture_claims(node.board_state, node_radius, node.config_snapshot)
            node_zones = capture_zones(node_radius, node.config_snapshot)
            def priority(command):
                if command.get('attack'):
                    source = node.board_state.get(command['from'])
                    target = node_occupied.get(command['attack'])
                    if source and target:
                        hit = exchange(source, target, distance(command['to'], command['attack']), node.config_snapshot, node.ability_state, source_key=command['to'], target_key=command['attack'])
                        return 100000 if hit['target_hp'] == 0 and node.config_snapshot['units'][target['unit_id']].get('commander') else hit['damage'] * 3 - hit['counter_damage']
                if command['type'] == 'make_move' and not command.get('withdraw') and command['from'] in node.board_state:
                    projected = dict(node.board_state)
                    unit = projected.pop(command['from'])
                    projected[command['to']] = unit
                    claimed = capture_claims(projected, node.config_snapshot['board']['radius'], node.config_snapshot)
                    before = node_claims
                    return (capture_score(claimed, unit['color'], node.config_snapshot['board']['radius'], node.config_snapshot) - capture_score(before, unit['color'], node.config_snapshot['board']['radius'], node.config_snapshot)) * 10 + movement_priority(command['to'], unit, node, projected, claimed, node_zones) - movement_priority(command['from'], unit, node, node_occupied, node_claims, node_zones)
                return 0
            groups['movement'].sort(key=priority, reverse=True)
            # Keep commander escapes even when capture gains crowd the movement shortlist.
            commander_moves = [command for command in groups['movement']
                               if command['type'] == 'make_move' and not command.get('attack') and command['from'] in node.board_state
                               and node.config_snapshot['units'][node.board_state[command['from']]['unit_id']].get('commander')][:6]
            candidates = commander_moves + [command for group in groups.values() for command in group[:max(4, width)]
                                           if command not in commander_moves]
            for command in candidates:
                if time.monotonic() >= own_deadline:
                    break
                try:
                    child = await runner._preview_turn(node, [command], finish=False)
                    complete = child if child.is_finished else await runner._preview_turn(child, [])
                except (ValidationError, ValueError, KeyError):
                    continue
                value = position_value(complete, color)
                steps = [*commands, command, {'type': 'pass_turn'}]
                finished.append((value, steps, complete))
                if len(finished) > 4:
                    finished = sorted(finished, key=lambda n: -n[0])[:4]
                if value > best[0]:
                    best = (value, steps, complete)
                if complete.is_finished and complete.winner == getattr(complete, 'player_' + color):
                    return steps
                if not child.is_finished:
                    children.append((position_value(child, color), [*commands, command], child))
                    if len(children) > width:
                        children = sorted(children, key=lambda n: -n[0])[:width]
            if time.monotonic() >= own_deadline:
                break
        if not children or time.monotonic() >= own_deadline:
            break
        beam = sorted(children, key=lambda n: -n[0])[:width]
    if depth > 1 and time.monotonic() < deadline:
        alternatives = sorted(finished, key=lambda n: -n[0])[:min(width, 3 if depth == 2 else 4)]
        assessed = []
        for value, commands, node in alternatives:
            if node.is_finished:
                assessed.append((value, commands, node))
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0.01:
                break
            reply = await search_turn(node, 'easy', min(0.5, remaining / max(1, len(alternatives) * (2 if depth > 2 else 1))))
            after = await runner._preview_turn(node, reply)
            if depth > 2 and not after.is_finished and deadline - time.monotonic() > 0.08:
                continuation = await search_turn(after, 'normal', min(0.3, deadline - time.monotonic()))
                after = await runner._preview_turn(after, continuation)
            assessed.append((position_value(after, color), commands, node))
        if assessed:
            best = max(assessed, key=lambda n: n[0])
    await runner._preview_turn(state, best[1])
    return best[1]


async def analyse(request, cached=None):
    deadline = time.monotonic() + 10
    config = load_config(request['config'])
    if sum(len(squad) for squad in config.get('setup', {}).values()) > 256 or len(config['scoring']['zones']) > 32:
        raise ValueError('This configuration is too large for CPU analysis. You can continue as Myself.')
    actions = request['actions']
    if cached and cached['config'] == config and actions[:len(cached['actions'])] == cached['actions']:
        state, offset = copy.deepcopy(cached['state']), len(cached['actions'])
    else:
        state = GameState(game_id='cpu-analysis', config_snapshot=config, board_state=build_initial_board(config).to_dict(),
            current_turn='white', player_white='white', player_black='black', turn_number=1, revision=1,
            move_history=[], phase_bank={}, ability_state=initial_state(), turn_started_at=timezone.now())
        offset = 0
    runner, batch = GameConsumer(), []
    for action in actions[offset:]:
        if time.monotonic() > deadline:
            raise ValueError('This replay is too expensive to analyse. You can continue as Myself.')
        if not isinstance(action, dict) or type(action.get('ply')) is not int or action.get('ply') != state.turn_number or action.get('color') != color_of(state) or state.is_finished:
            raise ValueError('The saved turn history is invalid.')
        raw = action.get('command')
        if not isinstance(raw, dict) or any(type(v) not in (str, bool) for v in raw.values()):
            raise ValueError('Invalid command fields.')
        command = runner._draft_commands([raw])[0]
        batch.append(command)
        if command['type'] == 'pass_turn':
            state = await runner._preview_turn(state, batch)
            batch = []
    if batch or state.is_finished or state.turn_number != request['ply'] or color_of(state) != request['color']:
        raise ValueError('CPU analysis requires a live turn-start position.')
    commands = await search_turn(state, request['difficulty'], request.get('budget'))
    return commands, {'config': config, 'actions': actions, 'state': state}


_pool = None
_jobs = 0


class CpuConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.cached = None
        self.task = None
        self.last_request = 0.0
        await self.accept()

    async def disconnect(self, code):
        if self.task:
            self.task.cancel()
        self.cached = None

    async def receive(self, text_data=None, bytes_data=None):
        try:
            if not text_data or len(text_data.encode('utf-8')) > MAX_BYTES:
                raise ValueError('CPU request exceeds its size limit.')
            request = json.loads(text_data)
            if not isinstance(request, dict):
                raise ValueError('Invalid CPU request.')
            if request.get('type') == 'cancel':
                if self.task:
                    self.task.cancel()
                return
            if request.get('type') != 'think' or set(request) - {'type', 'id', 'config', 'actions', 'ply', 'color', 'difficulty', 'budget'}:
                raise ValueError('Unsupported CPU request.')
            if self.task and not self.task.done():
                raise ValueError('CPU is already thinking.')
            if time.monotonic() - self.last_request < 0.25:
                raise ValueError('Too many CPU requests.')
            self.last_request = time.monotonic()
            if request.get('difficulty') not in PROFILES or request.get('color') not in ('white', 'black'):
                raise ValueError('Invalid CPU settings.')
            if type(request.get('ply')) is not int or request['ply'] < 1 or type(request.get('id')) is not int:
                raise ValueError('Invalid CPU turn identifier.')
            if not isinstance(request.get('actions'), list) or len(request['actions']) > MAX_ACTIONS:
                raise ValueError('CPU history exceeds its action limit.')
            if not isinstance(request.get('config'), dict):
                raise ValueError('CPU configuration is missing.')
            budget = request.get('budget', PROFILES[request['difficulty']][0])
            if type(budget) not in (int, float) or not 0.01 <= budget <= 5:
                raise ValueError('Invalid thinking budget.')
            self.task = asyncio.create_task(self.think(request))
        except (ValueError, TypeError, RecursionError) as error:
            await self.send(text_data=json.dumps({'type': 'cpu_error', 'message': str(error)}))

    async def think(self, request):
        global _pool, _jobs
        workers = max(1, min(4, int(os.environ.get('CPP_CPU_WORKERS', '1'))))
        if _jobs >= workers:
            await self.send(text_data=json.dumps({'type': 'cpu_error', 'id': request['id'], 'message': 'CPU server is busy. Please retry.'}))
            return
        if _pool is None:
            _pool = ProcessPoolExecutor(max_workers=workers, initializer=initialise)
        try:
            future = asyncio.get_running_loop().run_in_executor(_pool, run, request, self.cached)
            _jobs += 1
            future.add_done_callback(lambda _: release_job())
            commands, self.cached = await asyncio.shield(future)
            await self.send(text_data=json.dumps({'type': 'cpu_turn', 'id': request['id'], 'ply': request['ply'], 'commands': commands}))
        except asyncio.CancelledError:
            pass
        except Exception as error:
            logging.getLogger(__name__).exception('CPU analysis failed')
            if isinstance(error, BrokenProcessPool):
                _pool.shutdown(wait=False, cancel_futures=True)
                _pool = None
            await self.send(text_data=json.dumps({'type': 'cpu_error', 'id': request['id'], 'message': str(error) if isinstance(error, (ValueError, ValidationError)) else 'CPU analysis failed. Please retry.'}))


def release_job():
    global _jobs
    _jobs -= 1
