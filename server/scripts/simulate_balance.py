"""Seeded strategic self-play through authoritative turns, with no database writes.

Run with DJANGO_DEBUG=true. Results describe these policies, not optimal human play.
"""
import argparse
import asyncio
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
import copy
from functools import lru_cache
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import random
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
os.environ.setdefault('DJANGO_DEBUG', 'true')
os.environ.setdefault('DJANGO_DB_PATH', ':memory:')
import django
django.setup()

from game import cpu
from game.consumers import GameConsumer
from game.engine import board as geometry, panels, scoring
from game.engine.ability_rules import AbilityContext, initial_state, combat_stats, passive
from game.engine.config_loader import DEFAULT_CONFIG, build_initial_board
from game.engine.economy import points_of, unit_points_of
from game.engine.phases import phase_index_at, turn_of, overtime_last_turn, stage_rules, is_overtime
from game.engine.unit_combat import exchange
from game.engine.unit_stats import active_vet
from game.models import GameState
from game.validators import ValidationError

STYLES = {
    'capture': dict(capture=9, approach=3, material=.8, king=1, rush=.3, economy=.4),
    'rush': dict(capture=2, approach=1, material=1, king=1, rush=5, economy=.3),
    'control': dict(capture=3, approach=1.5, material=.8, king=1.3, rush=4, economy=.4),
    'economy': dict(capture=5, approach=2, material=.9, king=1.5, rush=.5, economy=2),
    'attrition': dict(capture=4, approach=1.5, material=2, king=1.2, rush=2, economy=.5),
    'adaptive': dict(capture=6, approach=2, material=1.2, king=1.7, rush=1.5, economy=.6),
    'defend': dict(capture=5, approach=1, material=1.2, king=3, rush=0, economy=.6),
}
PATHS = ('bastion', 'onslaught', 'tempo')
PAIRS = ('warcry', 'bulwark', 'dash', 'mend')
RUNNER = GameConsumer()
COUNTS = Counter()


class FrozenSnapshot(dict):
    """Match config is immutable; analysis clones can share it after parity checks."""
    def __deepcopy__(self, memo):
        return self


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def accelerate_geometry():
    """Memoize only derived, read-only geometry inside this analysis process."""
    replacements = {}
    for name in ('grid_coords', 'panel_zones', 'gateway_hexes', 'base_gateway_hexes', 'wrap_tips', 'wrap_corridor'):
        original = getattr(panels, name)
        replacements[original] = lru_cache(maxsize=128)(original)
    original = geometry.parse_coord
    cached_parse = lru_cache(maxsize=8192)(original)
    def parse(key):
        return cached_parse(key) if isinstance(key, str) else original(key)
    replacements[original] = parse
    for module in list(sys.modules.values()):
        if getattr(module, '__name__', '').startswith('game.'):
            for name, value in list(vars(module).items()):
                if callable(value) and getattr(value, '__hash__', None) is not None and value in replacements:
                    setattr(module, name, replacements[value])


def policy(style, seed, variant=0):
    rng = random.Random(seed)
    weights = dict(STYLES[style])
    if style == 'adaptive':
        weights = {key: value * rng.uniform(.85, 1.15) for key, value in weights.items()}
    pairs = list(PAIRS)
    rng.shuffle(pairs)
    return dict(style=style, weights=weights, path=PATHS[variant % 3], pairs=pairs[:2], noise=.35 if style != 'adaptive' else .6)


def fresh_state(frozen=True):
    config = FrozenSnapshot(copy.deepcopy(DEFAULT_CONFIG)) if frozen else copy.deepcopy(DEFAULT_CONFIG)
    return GameState(game_id='analysis-only', config_snapshot=config,
        board_state=build_initial_board(config).to_dict(), player_white='white', player_black='black',
        current_turn='white', turn_number=1, revision=1, move_history=[], phase_bank={}, ability_state=initial_state())


class View:
    def __init__(self, state, plan):
        self.state, self.plan = state, plan
        self.config = state.config_snapshot
        self.color = cpu.color_of(state)
        self.enemy = 'black' if self.color == 'white' else 'white'
        self.ctx = AbilityContext(state)
        self.occupied = self.ctx.recipients()
        self.friends = {k: u for k, u in self.occupied.items() if u['color'] == self.color}
        self.enemies = {k: u for k, u in self.occupied.items() if u['color'] != self.color}
        self.zones = scoring.capture_zones(self.ctx.radius, self.config)
        self.claims = scoring.capture_claims(state.board_state, self.ctx.radius, self.config)
        self.stats = {u['uid']: combat_stats(u, self.config, key=k) for k, u in self.occupied.items()}
        self.enemy_kings = [k for k, u in self.enemies.items() if self.config['units'][u['unit_id']].get('commander')]
        self.goals = {}
        home = next(z for z in self.zones if z.get('owner') == self.color)
        garrisons = [(k, u) for k, u in self.friends.items() if k in state.board_state
            and scoring.capture_eligible(u, home, self.config) and not self.config['units'][u['unit_id']].get('commander')]
        garrison = min(garrisons, key=lambda item: (cpu.distance(item[0], home['center']) / max(1, self.stats[item[1]['uid']].get('move', 1))
            + self.config['units'][item[1]['unit_id']].get('value', 0) / 80, item[0]))[1]['uid'] if garrisons else None
        for key, unit in self.friends.items():
            spec = self.config['units'][unit['unit_id']]
            effect = self.config['abilities']['catalogue'].get(spec.get('ability'), {}).get('effect')
            if key not in state.board_state:
                self.goals[unit['uid']] = []
            elif plan['style'] == 'defend' and spec.get('commander'):
                self.goals[unit['uid']] = [home['center']]
            elif unit['uid'] == garrison:
                self.goals[unit['uid']] = [home['center']]
            elif (plan['style'] in ('rush', 'attrition') or plan['style'] == 'control' and effect == 'control' and active_vet(unit, self.config) >= self.config['veterancy']['abilityUnlock'] or is_overtime(state.turn_number, self.config)):
                self.goals[unit['uid']] = self.enemy_kings
            else:
                goals = [z['center'] for z in self.zones if scoring.capture_eligible(unit, z, self.config)
                    and any(self.claims.get(k) != self.color for k in z['hexes'])]
                self.goals[unit['uid']] = goals or self.enemy_kings

    def priority(self, key, unit, state, occupied, claims=None, zones=None):
        if is_overtime(state.turn_number, self.config) and self.config['units'][unit['unit_id']].get('commander') and self.config['match']['winConditions']['overtimeWinner'] == unit['color']:
            return min((cpu.distance(key, at) for at in self.enemies if at in state.board_state), default=25) * self.plan['weights']['king'] * 4
        goals = self.goals.get(unit['uid'], self.enemy_kings)
        gap = min((cpu.distance(key, target) for target in goals), default=0)
        result = -gap * self.plan['weights']['approach']
        if self.enemy_kings:
            effect = self.config['abilities']['catalogue'].get(self.config['units'][unit['unit_id']].get('ability'), {}).get('effect')
            rush = self.plan['weights']['rush'] * (2 if effect == 'control' and self.plan['style'] == 'control' else 1)
            if effect == 'control' and active_vet(unit, self.config) < 3: rush = 0
            result -= min(cpu.distance(key, target) for target in self.enemy_kings) * rush
        return result

    def quick(self, command):
        kind = command['type']
        source = self.occupied.get(command.get('from'))
        target = self.occupied.get(command.get('attack') or command.get('heal'))
        if command.get('attack') and source and target:
            hit = exchange(source, target, cpu.distance(command['to'], command['attack']), self.config,
                self.state.ability_state, source_key=command['to'], target_key=command['attack'])
            return (100000 if hit['target_hp'] == 0 and self.config['units'][target['unit_id']].get('commander') else 0) + hit['damage'] * 5 - hit['counter_damage'] * 2
        if source and command.get('withdraw'):
            from game.engine.economy import withdrawal_refund
            return withdrawal_refund(self.config, source) * self.plan['weights']['economy'] * .2
        if source and kind in ('make_move', 'enter_board', 'panel_move'):
            if kind == 'make_move':
                ability = self.config['abilities']['catalogue'].get(self.config['units'][source['unit_id']].get('ability'), {})
                if ability.get('effect') == 'control' and active_vet(source, self.config) >= self.config['veterancy']['abilityUnlock'] and any(cpu.distance(command['to'], target) <= ability.get('radius', 1) for target in self.enemy_kings):
                    return 2000
                return self.priority(command['to'], source, self.state, self.occupied) - self.priority(command['from'], source, self.state, self.occupied)
            return (20 if kind == 'enter_board' else 3) - min((cpu.distance(command['to'], k) for k in self.enemy_kings), default=0) * .1
        entry = self.config['abilities']['catalogue'].get(command.get('id'), {})
        if kind == 'cast_ability':
            chosen = next((u for u in self.occupied.values() if u['uid'] == command.get('targetUid')), None)
            bonus = 0
            if chosen:
                at = next(k for k, unit in self.occupied.items() if unit['uid'] == chosen['uid'])
                missing = chosen.get('max_hp', chosen['hp']) - chosen['hp']
                if entry.get('heal', 0): bonus += min(missing, entry['heal']) * 6
                if entry.get('effect') == 'sacrifice': bonus += missing * 3
                if entry.get('effect') == 'promote' and chosen.get('vet', 0) >= 3: return -100000
                if entry.get('effect') == 'promote':
                    active = self.config['abilities']['catalogue'].get(self.config['units'][chosen['unit_id']].get('ability'), {})
                    if active.get('effect') == 'control': bonus += 60
                if self.config['units'][chosen['unit_id']].get('commander'): bonus += 10
                foes = self.enemies if chosen['color'] == self.color else self.friends
                near = min((cpu.distance(at, k) for k in foes if k in self.state.board_state), default=30)
                bonus += max(0, 12-near) * 3
            if chosen and entry.get('mov', 0) > 0:
                ability = self.config['abilities']['catalogue'].get(self.config['units'][chosen['unit_id']].get('ability'), {})
                if ability.get('effect') == 'control' and active_vet(chosen, self.config) >= self.config['veterancy']['abilityUnlock']: bonus += 60
            return 5 + bonus + entry.get('damage', 0) * 3 + (50 if entry.get('effect') == 'control' else 0)
        return -100


def value(state, view):
    if state.is_finished:
        return 0 if not state.winner else 1e9 if state.winner == view.color else -1e9
    config, weights = view.config, view.plan['weights']
    occupied = AbilityContext(state).recipients()
    claims = scoring.capture_claims(state.board_state, config['board']['radius'], config)
    scores = {c: scoring.capture_score(claims, c, config['board']['radius'], config) for c in ('white', 'black')}
    result = 0 if is_overtime(state.turn_number, config) else (scores[view.color] - scores[view.enemy]) * weights['capture']
    for bank in state.phase_bank.values():
        result += (bank.get(view.color, 0) - bank.get(view.enemy, 0)) * weights['capture']
        if bank.get('pendingLoss'):
            result += -100000 if bank['pendingLoss'] == view.color else 100000
    kings = {c: [k for k, u in occupied.items() if u['color'] == c and config['units'][u['unit_id']].get('commander')] for c in ('white', 'black')}
    stats = {u['uid']: combat_stats(u, config, key=k) for k, u in occupied.items()}
    for key, unit in occupied.items():
        spec = config['units'][unit['unit_id']]
        own = unit['color'] == view.color
        sign = 1 if own else -1
        field = key in state.board_state
        deployment = 1 if field else .35 if not panels.is_base(unit.get('panel')) else .15
        health = unit['hp'] / max(1, unit.get('max_hp', spec['hp']))
        stat = stats[unit['uid']]
        enemy_color = view.enemy if own else view.color
        gap = min((cpu.distance(key, k) for k, enemy in occupied.items() if k in state.board_state and enemy['color'] == enemy_color), default=25)
        powers = stat.get('attack', 0)
        atk = max(powers, default=0) if isinstance(powers, list) else powers
        atk += cpu.bonus(unit, config, state.ability_state, 'atk', key=key) if atk else 0
        defend = stat.get('defense', 0) + cpu.bonus(unit, config, state.ability_state, 'def', key=key)
        engaged = .8 if gap <= stat.get('move', 0) + stat.get('attackRange', 1) + 3 else .08
        result += sign * deployment * (spec.get('value', 0) * (.3 + .7 * health) * weights['material']
            + engaged * (atk * .5 + defend * .3) + active_vet(unit, config) * 1.5)
        if own and field:
            result += (20 + view.priority(key, unit, state, occupied)) * .7
        elif own:
            goals = panels.wrap_tips(unit['color'], view.ctx.radius).values() if panels.is_base(unit.get('panel')) else [k for k, gate in panels.gateway_hexes(view.ctx.radius).items() if gate['color'] == unit['color']]
            result -= min((cpu.distance(key, goal) for goal in goals), default=0) * .25
        if field and spec.get('commander'):
            result += sign * health * 300 * weights['king']
            incoming = 0
            for at, enemy in occupied.items():
                if at not in state.board_state or enemy['color'] == unit['color']:
                    continue
                enemy_stats = stats[enemy['uid']]
                power = enemy_stats.get('attack', 0)
                if not (max(power, default=0) if isinstance(power, list) else power):
                    continue
                reach = enemy_stats.get('move', 0) + enemy_stats.get('attackRange', 1)
                if cpu.distance(key, at) <= reach:
                    ring = enemy_stats.get('attackMinRange', 1) + (power.index(max(power)) if isinstance(power, list) else 0)
                    hit = cpu.strike(enemy, unit, ring, config, state.ability_state, source_key=at, target_key=key)
                    incoming = max(incoming, hit)
            if incoming >= unit['hp']:
                result -= sign * 6000 * weights['king']
            else:
                result -= sign * min(incoming, unit['hp']) * 4 * weights['king']
        if own and unit.get('owner') and unit['owner'] != unit['color']:
            result += 1000 if spec.get('commander') else 30
    ctx = AbilityContext(state)
    for color in ('white', 'black'):
        sign = 1 if color == view.color else -1
        ctx.color = color
        result += sign * (ctx.cp() * .025 + (points_of(color, state.turn_number, state.move_history, config, state.phase_bank)
            + state.ability_state['pointDelta'][color]) * .06 + unit_points_of(color, state.move_history, config) * .08 * weights['economy'])
    return result


async def preview(state, commands, finish=False):
    COUNTS['previews'] += 1
    return await RUNNER._preview_turn(state, commands, finish=finish)


async def scored(state, view):
    config = state.config_snapshot
    owners = {u.get('owner', u['color']) for u in state.board_state.values() if config['units'][u['unit_id']].get('commander')}
    boundary = state.turn_number % 2 == 0 and stage_rules(state.turn_number + 1, config) != stage_rules(state.turn_number, config)
    if not state.is_finished and (len(owners) < 2 or boundary):
        return value(await preview(state, [], finish=True), view)
    return value(state, view)


async def tactical_extensions(node, child, command, view, movement):
    """Test move/cast/attack and buff/attack combinations using real handlers."""
    extensions = []
    config = view.config
    if command['type'] == 'cast_ability':
        entry = config['abilities']['catalogue'][command['id']]
        target_uid = command.get('targetUid')
        target_key, target = AbilityContext(child).find(target_uid) if target_uid else (None, None)
        if target and target_key in child.board_state and target['color'] == view.color and (entry.get('mov', 0) > 0 or entry.get('effect') == 'promote'):
            spec = config['abilities']['catalogue'].get(config['units'][target['unit_id']].get('ability'), {})
            if spec.get('effect') == 'control' and active_vet(target, config) >= config['veterancy']['abilityUnlock']:
                destinations = cpu.get_legal_moves_filtered(geometry.HexBoard.from_dict(view.ctx.radius, child.board_state),
                    geometry.parse_coord(target_key), config, view.color, 0, child.ability_state)
                enemies = {k:u for k,u in AbilityContext(child).recipients().items() if u['color'] != view.color and config['units'][u['unit_id']].get('commander')}
                for at, enemy in enemies.items():
                    landing = sorted((geometry.coord_key(*to) for to in destinations if geometry.hex_distance(to, geometry.parse_coord(at)) <= spec.get('radius', 1)))
                    for to in landing[:2]:
                        extensions.append([{'type':'make_move','from':target_key,'to':to,'more':True},
                            {'type':'cast_ability','id':config['units'][target['unit_id']]['ability'],'unitUid':target_uid,'targetUid':enemy['uid']}])
        elif entry.get('atk') or entry.get('def'):
            chosen_key, chosen = AbilityContext(node).find(target_uid) if target_uid else (None, None)
            matches = [c for c in movement if c.get('attack') and (c.get('from') == chosen_key if chosen and chosen['color'] == view.color else c.get('attack') == chosen_key)]
            extensions.extend([[c] for c in sorted(matches, key=view.quick, reverse=True)[:2]])
    elif command['type'] == 'make_move' and not command.get('withdraw'):
        source = node.board_state.get(command['from'])
        if source:
            ability_id = config['units'][source['unit_id']].get('ability')
            entry = config['abilities']['catalogue'].get(ability_id, {})
            if active_vet(source, config) >= config['veterancy']['abilityUnlock']:
                if not command.get('attack') and entry.get('effect') == 'control':
                    enemies = [(k,u) for k,u in AbilityContext(child).recipients().items() if u['color'] != view.color
                        and cpu.distance(command['to'],k) <= entry.get('radius',1)]
                    enemies.sort(key=lambda item: (not config['units'][item[1]['unit_id']].get('commander'), -config['units'][item[1]['unit_id']].get('value',0)))
                    extensions.extend([[{'type':'cast_ability','id':ability_id,'unitUid':source['uid'],'targetUid':u['uid']}] for _,u in enemies[:2]])
                elif command.get('attack') and entry.get('effect') in ('leech','charge','cleave','attack-drain','nullify','call'):
                    # Rebuild the exchange from before the attack to respect move -> ability -> attack.
                    sequence = []
                    if command['from'] != command['to']:
                        sequence.append({'type':'make_move','from':command['from'],'to':command['to'],'more':True})
                    sequence += [{'type':'cast_ability','id':ability_id,'unitUid':source['uid']},
                        {**command,'from':command['to']}]
                    try:
                        combined = await preview(node, sequence)
                        COUNTS['tactical_bundles'] += 1
                        yield combined, sequence
                    except ValidationError:
                        COUNTS['bundle_refusals'] += 1
    if not child.is_finished:
        for extra in extensions:
            try:
                combined = await preview(child, extra)
                COUNTS['tactical_bundles'] += 1
                yield combined, [command, *extra]
            except ValidationError:
                COUNTS['bundle_refusals'] += 1


async def choose_turn(state, plan, rng, width=5, max_actions=12):
    node, selected = state, []
    ctx = AbilityContext(node)
    held = ctx.data['loadouts'][ctx.color]
    for pair in plan['pairs']:
        if pair not in held:
            try:
                node = await preview(node, [{'type': 'pick_pair', 'id': pair}])
                selected.append({'type': 'pick_pair', 'id': pair})
                held = node.ability_state['loadouts'][ctx.color]
            except ValidationError:
                pass
    if not node.ability_state['paths'][ctx.color]:
        command = {'type': 'pick_path', 'id': plan['path']}
        try:
            node = await preview(node, [command]); selected.append(command)
        except ValidationError:
            pass
    view = View(node, plan)
    opportunity, used_candidates = set(), set()
    for _ in range(max_actions):
        view = View(node, plan)
        previous_priority = cpu.movement_priority
        cpu.movement_priority = view.priority
        try:
            commands = list(cpu.candidate_commands(node, float('inf')))
            # Include mobility support for control casters, even when their ATK is absent.
            for ability_id in node.ability_state['loadouts'][view.color]:
                entry = view.config['abilities']['catalogue'][ability_id]
                if entry.get('target') == 'friendly' and entry.get('mov', 0) > 0:
                    for key, unit in view.friends.items():
                        active = view.config['abilities']['catalogue'].get(view.config['units'][unit['unit_id']].get('ability'), {})
                        if key in node.board_state and active.get('effect') == 'control' and active_vet(unit, view.config) >= view.config['veterancy']['abilityUnlock']:
                            commands.append({'type':'cast_ability','id':ability_id,'targetUid':unit['uid']})
            path = next((p for p in view.config['abilities']['paths'] if p['id'] == node.ability_state['paths'][view.color]), {})
            promote = view.config['abilities']['catalogue'].get(path.get('utility'), {})
            if promote.get('effect') == 'promote':
                for key, unit in view.friends.items():
                    active = view.config['abilities']['catalogue'].get(view.config['units'][unit['unit_id']].get('ability'), {})
                    unlock = view.config['veterancy']['abilityUnlock']
                    if key in node.board_state and active.get('effect') == 'control' and unit.get('vet',0) < unlock <= unit.get('vet',0) + promote.get('stars',1):
                        commands.append({'type':'cast_ability','id':path['utility'],'targetUid':unit['uid']})
        finally:
            cpu.movement_priority = previous_priority
        groups = {k: [] for k in ('movement', 'ability')}
        for command in commands:
            if command['type'] in ('pick_pair', 'pick_path', 'reset_pair'):
                continue
            encoded = json.dumps(command, sort_keys=True)
            if encoded in used_candidates:
                continue
            kind = 'ability' if command['type'] == 'cast_ability' else 'movement'
            groups[kind].append((view.quick(command) + rng.random() * .05, command))
        candidates = [command for _, command in sorted(groups['movement'], key=lambda x: -x[0])[:width]]
        # Preserve one close strike per unlocked kit; an unbuffed counter can hide its best combo.
        kit_strikes = {}
        for _, command in groups['movement']:
            source = node.board_state.get(command.get('from'))
            if not source or not command.get('attack') or active_vet(source, view.config) < view.config['veterancy']['abilityUnlock']:
                continue
            ability = view.config['units'][source['unit_id']].get('ability')
            if view.config['abilities']['catalogue'].get(ability, {}).get('effect') not in ('leech','charge','cleave','attack-drain','nullify','call'):
                continue
            target = view.occupied.get(command['attack'], {})
            priority = (bool(view.config['units'].get(target.get('unit_id'), {}).get('commander')),
                -cpu.distance(command['to'], command['attack']), view.quick(command))
            if ability not in kit_strikes or priority > kit_strikes[ability][0]:
                kit_strikes[ability] = (priority, command)
        for _, command in kit_strikes.values():
            if command not in candidates:
                candidates.append(command)
        ability_seen = set()
        for _, command in sorted(groups['ability'], key=lambda x: -x[0]):
            token = command['id']
            if token not in ability_seen:
                candidates.append(command)
                ability_seen.add(token)
        baseline = await scored(node, view)
        options = []
        for command in candidates:
            used_candidates.add(json.dumps(command, sort_keys=True))
            try:
                child = await preview(node, [command])
            except ValidationError:
                COUNTS['candidate_refusals'] += 1
                continue
            if command['type'] == 'cast_ability':
                opportunity.add(command['id'])
            gain = await scored(child, view) - baseline
            if gain > .025:
                noise = -math.log(max(1e-12, rng.random())) * plan['noise']
                options.append((gain + noise, child, [command]))
            async for combined, sequence in tactical_extensions(node, child, command, view, [c for _,c in groups['movement']]):
                opportunity.update(c['id'] for c in sequence if c['type'] == 'cast_ability')
                combined_gain = await scored(combined, view) - baseline
                if combined_gain > .025:
                    options.append((combined_gain + rng.random() * plan['noise'], combined, sequence))
        if not options:
            break
        _, node, sequence = max(options, key=lambda item: item[0])
        selected.extend(sequence)
        if node.is_finished:
            break
        used_candidates.clear()
    final = node if node.is_finished else await preview(node, [], finish=True)
    return final, selected, sorted(opportunity)


def metrics(state):
    config = state.config_snapshot
    ctx = AbilityContext(state)
    occupied = ctx.recipients()
    claims = scoring.capture_claims(state.board_state, config['board']['radius'], config)
    result = {}
    for color in ('white', 'black'):
        ctx.color = color
        result[color] = dict(cp=ctx.cp(), points=points_of(color, state.turn_number, state.move_history, config, state.phase_bank)
            + state.ability_state['pointDelta'][color], up=unit_points_of(color, state.move_history, config),
            capture=scoring.capture_score(claims, color, config['board']['radius'], config),
            field=sum(u['color'] == color for u in state.board_state.values()),
            living=sum(u['color'] == color for u in occupied.values()))
    return result


async def play(job):
    COUNTS.clear()
    state = fresh_state()
    expected = fingerprint(state.config_snapshot)
    rng = random.Random(job['seed'])
    plans = {c: job[c] for c in ('white', 'black')}
    rows, checkpoints, actions, casts, opportunities, actors = [], {}, Counter(), Counter(), Counter(), set()
    begun = time.monotonic()
    while not state.is_finished:
        color, ply = cpu.color_of(state), state.turn_number
        phase = phase_index_at(ply, state.config_snapshot)
        if str(phase) not in checkpoints:
            checkpoints[str(phase)] = metrics(state)
        before = state
        state, commands, offered = await choose_turn(state, plans[color], rng, job.get('width', 4))
        if not state.is_finished and state.turn_number != ply + 1:
            raise AssertionError('Chosen turn did not advance')
        for ability in offered:
            opportunities[color + '|' + ability] += 1
        for command in commands:
            actions[color + '|' + command['type']] += 1
            if command['type'] == 'cast_ability': casts[color + '|' + command['id']] += 1
            unit = AbilityContext(before).recipients().get(command.get('from'))
            uid = command.get('unitUid') or (unit or {}).get('uid')
            if uid: actors.add(color + '|' + uid)
        rows.append(dict(ply=ply, color=color, commands=commands, opportunity=offered))
        if ply % 10 == 0:
            print(json.dumps({'running': job['id'], 'ply': ply, 'seconds': round(time.monotonic()-begun, 1)}), flush=True)
        if state.turn_number > (overtime_last_turn(state.config_snapshot) + 1) * 2:
            raise AssertionError('Simulation exceeded configured schedule')
    if fingerprint(state.config_snapshot) != expected:
        raise AssertionError('Simulation mutated match rules')
    return dict(id=job['id'], seed=job['seed'], plans=plans, winner=state.winner, reason=state.end_reason,
        plies=len(rows), bank=state.phase_bank, paths=state.ability_state['paths'], loadouts=state.ability_state['loadouts'],
        actions=dict(actions), casts=dict(casts), opportunities=dict(opportunities), actors=sorted(actors), checkpoints=checkpoints,
        final_resources=metrics(state), counters=dict(COUNTS), seconds=round(time.monotonic()-begun, 3), trace=rows)


def initialise():
    logging.disable(logging.CRITICAL)
    from django.db.backends.utils import CursorWrapper
    def refuse_database(*args, **kwargs):
        raise AssertionError('Analysis attempted database access')
    CursorWrapper.execute = refuse_database
    CursorWrapper.executemany = refuse_database
    accelerate_geometry()


def worker(job):
    return asyncio.run(play(job))


async def self_check():
    plain = fresh_state(False)
    fast = fresh_state()
    original = fingerprint(plain.board_state)
    for ply in range(1, 9):
        plan = policy('capture', 100 + ply, 0)
        after, commands, _ = await choose_turn(fast, plan, random.Random(ply), width=2, max_actions=3)
        canonical = await preview(plain, commands, finish=True)
        for field in ('board_state', 'move_history', 'ability_state', 'phase_bank', 'turn_number', 'winner', 'end_reason'):
            assert getattr(after, field) == getattr(canonical, field), field
        if ply == 1:
            assert fingerprint(plain.board_state) == original
        plain, fast = canonical, after
    for unit_id, effect, rank in (('bishop', 'control', 3), ('queen', 'leech', 3), ('bishop', 'control', 2)):
        fixture = fresh_state(False)
        fixture.config_snapshot['economy']['upAtStart'] = 100
        fixture.config_snapshot['veterancy']['startingRank'] = rank
        fixture.config_snapshot['match']['cpAtStart'] = 100
        fixture.config_snapshot['setup'] = {'white': {'-10,10': 'king', '0,0': unit_id}, 'black': {'2,0': 'king'}}
        fixture.board_state = build_initial_board(fixture.config_snapshot).to_dict()
        fixture.turn_number = 7
        if effect == 'leech':
            fixture.board_state['0,0']['hp'] = 5
            fixture.board_state['2,0']['hp'] = 10
        plan = policy('control', 510, 0)
        plan['pairs'] = []
        after, commands, _ = await choose_turn(fixture, plan, random.Random(510), width=3, max_actions=3)
        assert any(c['type'] == 'cast_ability' and fixture.config_snapshot['abilities']['catalogue'][c['id']].get('effect') == effect for c in commands), (effect, commands)
        canonical = await preview(fixture, commands, finish=True)
        for field in ('board_state','move_history','ability_state','phase_bank','winner','end_reason'):
            assert getattr(after,field) == getattr(canonical,field), (effect,field)
    print(json.dumps({'self_check':'pass','atomic_turns_compared':8,'tactical_bundles_compared':3,'config_sha256':fingerprint(DEFAULT_CONFIG)}), flush=True)


def schedule(seeds, width):
    names = list(STYLES)
    jobs = []
    for left, first in enumerate(names):
        for right in range(left, len(names)):
            second = names[right]
            for seed in range(seeds):
                a = policy(first, seed * 101 + left, seed + left)
                b = policy(second, seed * 101 + right + 41, seed + right + 1)
                for flipped in (False, True):
                    jobs.append(dict(id=f'{first}-{second}-{seed}-{int(flipped)}', seed=seed * 997 + left * 31 + right,
                        white=b if flipped else a, black=a if flipped else b, width=width))
    random.Random(724518).shuffle(jobs)
    return jobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--jobs', type=Path)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--seeds', type=int, default=10)
    parser.add_argument('--width', type=int, default=3)
    parser.add_argument('--self-check', action='store_true')
    args = parser.parse_args()
    if args.self_check:
        initialise();asyncio.run(self_check());return
    if not 1 <= args.workers <= 8 or not 1 <= args.seeds <= 100 or not 1 <= args.width <= 32:
        parser.error('Use 1–8 workers, 1–100 seeds and width 1–32.')
    jobs = json.loads(args.jobs.read_text()) if args.jobs else schedule(args.seeds, args.width)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    metadata = dict(config=DEFAULT_CONFIG, config_sha256=fingerprint(DEFAULT_CONFIG), jobs_sha256=fingerprint(jobs), policy=STYLES, cpu_tuning=cpu.TUNING, script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    meta_path = args.output.with_suffix('.meta.json')
    if meta_path.exists() and json.loads(meta_path.read_text()) != metadata:
        raise ValueError('Output metadata differs; choose a new result path.')
    meta_path.write_text(json.dumps(metadata, indent=2))
    completed = {row['id'] for row in (json.loads(line) for line in args.output.read_text().splitlines())} if args.output.exists() else set()
    pending = [job for job in jobs if job['id'] not in completed]
    began = time.monotonic()
    with args.output.open('a', encoding='utf-8') as output, ProcessPoolExecutor(max_workers=args.workers, initializer=initialise) as pool:
        futures = {pool.submit(worker, job): job for job in pending}
        try:
            for future in as_completed(futures):
                result = future.result()
                output.write(json.dumps(result, separators=(',', ':'))+'\n');output.flush()
                completed.add(result['id'])
                print(json.dumps(dict(completed=len(completed), total=len(jobs), id=result['id'], winner=result['winner'],
                    reason=result['reason'], plies=result['plies'], seconds=result['seconds'], elapsed=round(time.monotonic()-began,1))), flush=True)
        except BaseException:
            pool.terminate_workers()
            raise


if __name__ == '__main__':
    main()
