"""Authoritative ability state and config-driven effects for networked turns."""
from .board import coord_key, hex_distance, parse_coord
from .config_loader import rule_of, UNIT_ACTIVES, DEFAULT_CONFIG
from .economy import points_of, unit_points_of
from .phases import board_moves_per_turn, is_initialization, phase_index_at, turn_of
from .scoring import cp_awarded
from .unit_stats import MAX_UNIT_STAT, active_vet, positional_bonus, cap_stat, cap_unit, ranked_unit, unit_stats
from . import panels


COLORS = ('white', 'black')


def ability_config(config):
    return config.get('abilities', DEFAULT_CONFIG['abilities'])


def initial_state():
    return {
        'version': 1, 'loadouts': {c: [] for c in COLORS},
        'paths': {c: None for c in COLORS}, 'pickTurns': {c: None for c in COLORS},
        'cooldowns': {c: {} for c in COLORS}, 'cpSpent': {c: 0 for c in COLORS},
        'pointDelta': {c: 0 for c in COLORS}, 'uses': {}, 'unitCooldowns': {},
        'buffs': {}, 'controls': {}, 'usedUnits': {}, 'pickedAt': {}, 'castAt': {},
        'extraUnits': {}, 'endedUnits': {}, 'unitProgress': {}, 'activeUnit': None,
        'swapDebts': {c: 0 for c in COLORS},
    }


def state_of(state):
    if not getattr(state, 'ability_state', None):
        state.ability_state = initial_state()
    return state.ability_state


def passive(unit, config):
    if active_vet(unit) < 2:
        return {}
    return ability_config(config).get('catalogue', {}).get(
        config.get('units', {}).get(unit['unit_id'], {}).get('passive'), {})


def combat_stats(unit, config, counter=False, key=None):
    stats = unit_stats(unit['unit_id'], config, active_vet(unit))
    if key:
        atk = positional_bonus(unit, config, key, 'atk')
        if isinstance(stats.get('attack'), list):
            stats['attack'] = [cap_stat(n + atk) for n in stats['attack']]
        elif stats.get('attack', 0) > 0:
            stats['attack'] = cap_stat(stats['attack'] + atk)
        stats['defense'] = cap_stat(stats.get('defense', 0) + positional_bonus(unit, config, key, 'def'))
    trait = passive(unit, config)
    if counter and trait.get('effect') == 'counter':
        attack = [cap_stat(n) for n in trait['counterAttack'][:MAX_UNIT_STAT]]
        return {**stats, 'attack': attack, 'attackMinRange': 1, 'attackRange': len(attack)}
    if trait.get('effect') == 'deflect':
        return {**stats, 'attack': 0 if counter else cap_stat(trait['atk'])}
    return stats


def has_attack(stats):
    attack = stats.get('attack', 1)
    return not stats.get('heal') and (any(n > 0 for n in attack) if isinstance(attack, list) else attack > 0)


def unit_effect(unit, config, effect):
    out = dict(effect)
    for stat, available in (('atk', has_attack(combat_stats(unit, config))),
                            ('hel', bool(unit_stats(unit['unit_id'], config, active_vet(unit)).get('heal')))):
        if not available:
            if out.get(stat, 0) > 0:
                out[stat] = 0
            field = 'set' + stat.title()
            if out.get(field, 0) > 0:
                out.pop(field, None)
    return out


def summed(effects):
    return {
        **{s: sum(e.get(s, 0) for e in effects) for s in ('mov', 'atk', 'def', 'hel')},
        'effects': effects, 'caster': effects[0].get('caster', ''), 'label': effects[-1]['name'],
        'up': any(any(e.get(s, 0) > 0 for s in ('mov', 'atk', 'def', 'hel')) for e in effects),
        'down': any(e.get('hostile') or any(e.get(s, 0) < 0 for s in ('mov', 'atk', 'def', 'hel')) for e in effects),
    }


def carries(buff, effect):
    return any(e.get('effect') == effect for e in (buff or {}).get('effects', []))


def setting(buff, stat):
    field = 'set' + stat.title()
    effects = (buff or {}).get('effects', [])
    for i in range(len(effects) - 1, -1, -1):
        if field in effects[i]:
            return cap_stat(effects[i][field] if stat == 'def' else
                            effects[i][field] + sum(e.get(stat, 0) for e in effects[i + 1:]))
    return None


def path_passive(config, abilities, color):
    path = next((p for p in ability_config(config).get('paths', [])
                 if p['id'] == abilities.get('paths', {}).get(color)), None)
    return ability_config(config).get('catalogue', {}).get(path['passive'], {}) if path else {}


def bonus(unit, config, abilities, stat, in_base=False, defending=False, key=None):
    buff = abilities.get('buffs', {}).get(unit.get('uid'), {})
    trait = path_passive(config, abilities, unit.get('color'))
    available = unit.get('vet', 0) >= trait.get('minVet', 1)
    available = available and not (in_base and trait.get('scope') == 'field-reserve')
    available = available and not (stat == 'def' and trait.get('effect') == 'defensive-armor' and not defending)
    origin = abilities.get('unitProgress', {}).get(unit.get('uid'), {}).get('origin', key) if stat == 'mov' else key
    return buff.get(stat, 0) + (trait.get(stat, 0) if available else 0) + positional_bonus(unit, config, origin, stat)


def effect_band(origin, key, effect, orientation='edge-up'):
    oq, ore = parse_coord(origin)
    q, r = parse_coord(key)
    dq, dr = q - oq, r - ore
    if not dq and not dr:
        return 'centre'
    distance = hex_distance((oq, ore), (q, r))
    area = effect.get('area')
    if area == 'horizontal':
        if (dq + 2 * dr != 0) if orientation == 'vertex-up' else (dr != 0):
            return None
        distance = abs(dr) if orientation == 'vertex-up' else abs(dq)
    elif area == 'cross':
        if (dr != 0 and dq + dr != 0) if orientation == 'vertex-up' else (dq != 0 and dq + dr != 0):
            return None
    elif distance > effect.get('outerRange', effect.get('splashRange', 1)):
        return None
    return 'splash' if distance <= effect.get('splashRange', 1) else 'outer'


def controlled(unit, abilities, ply):
    control = abilities.get('controls', {}).get(unit.get('uid'))
    if not control:
        return unit
    active = ply < control.get('controlledUntil', 0)
    return {**unit, **{k: v for k, v in control.items() if k in ('owner', 'controlledUntil', 'controlTurn')},
            'color': control['color'] if active else control['owner']}


def actions_used(state, color):
    from .game_logic import board_move_uids
    history, ply = state.move_history, state.turn_number
    acted = board_move_uids(history, ply, color)
    sources = {m['controlSource'] for m in history if m.get('turn') == ply
               and m.get('color') == color and m.get('controlSource')
               and state.ability_state.get('extraUnits', {}).get(m['controlSource']) != ply}
    return len(acted | sources)


class AbilityContext:
    def __init__(self, state, board=None, history=None):
        self.state = state
        self.config = state.config_snapshot
        self.data = state_of(state)
        self.ply = state.turn_number
        self.color = 'white' if state.current_turn == state.player_white else 'black'
        self.history = state.move_history if history is None else history
        self.board = state.board_state if board is None else board
        for at, unit in self.board.items():
            self.board[at] = cap_unit(unit)
        self.radius = self.config['board']['radius']
        self.orientation = self.config['board'].get('orientation', 'edge-up')
        self.catalogue = ability_config(self.config).get('catalogue', {})

    def recipients(self, scope='all'):
        occupied = panels.panel_occupancy(self.config, self.radius, self.history, self.orientation, ply=self.ply)
        occupied = {k: controlled(u, self.data, self.ply) for k, u in occupied.items()}
        occupied.update(self.board)
        return {k: u for k, u in occupied.items() if u.get('hp', 0) > 0
                and (scope != 'field-reserve' or not panels.is_base(u.get('panel')))}

    def find(self, uid, scope='all'):
        return next(((k, u) for k, u in self.recipients(scope).items() if u.get('uid') == uid), (None, None))

    def cp(self):
        return rule_of(self.config, 'cpAtStart') + cp_awarded(
            self.state.phase_bank, self.color, rule_of(self.config, 'cpPhaseOffset')) - self.data['cpSpent'][self.color]

    def pick(self, command):
        kind, ability_id = command['type'], command.get('id')
        if not isinstance(ability_id, str):
            raise ValueError('Choose a configured ability or path')
        if kind == 'pick_path':
            path = next((p for p in ability_config(self.config).get('paths', []) if p['id'] == ability_id), None)
            if not path or self.data['paths'][self.color] is not None or self.cp() < path['cost']:
                raise ValueError('This path cannot be purchased')
            self.data['cpSpent'][self.color] += path['cost']
            self.data['paths'][self.color] = path['id']
        else:
            pool = ability_config(self.config).get('pool', [])
            if ability_id not in pool:
                raise ValueError('Choose a pool pair')
            index = pool.index(ability_id)
            pair = pool[index - index % 2:index - index % 2 + 2]
            held = self.data['loadouts'][self.color]
            if kind == 'reset_pair':
                if not all(i in held for i in pair) or self.data['cooldowns'][self.color].get(ability_id, 0):
                    raise ValueError('Only a ready carried pair can be returned')
                fresh = all(self.data['pickedAt'].get(self.color + '|' + i) == self.ply
                            and self.data['castAt'].get(self.color + '|' + i) != self.ply for i in pair)
                if not fresh:
                    self.data['swapDebts'][self.color] += len(pair)
                self.data['loadouts'][self.color] = [i for i in held if i not in pair]
            else:
                first = self.data['pickTurns'][self.color]
                delay = ability_config(self.config).get('pairPickDelay', 0)
                if len(pair) != 2 or any(i in held for i in pair) or len(held) + 2 > ability_config(self.config).get('slots', 4):
                    raise ValueError('No room for this pair')
                if held and first is not None and turn_of(self.ply) < first + delay:
                    raise ValueError('The second pair is not unlocked yet')
                self.data['pickTurns'][self.color] = first if first is not None else turn_of(self.ply)
                held.extend(pair)
                for i in pair:
                    self.data['pickedAt'][self.color + '|' + i] = self.ply
                    if self.data['swapDebts'][self.color] > 0:
                        self.data['swapDebts'][self.color] -= 1
                        self.data['cooldowns'][self.color][i] = self.catalogue[i].get('cooldown', 3)
        self.history.append({'from': '', 'to': '', 'turn': self.ply, 'color': self.color,
                             'abilityChoice': dict(command)})

    def add_buff(self, unit, entry, stats=None, hostile=False):
        stats = unit_effect(unit, self.config, entry if stats is None else stats)
        effect = {'name': entry.get('name', entry.get('id', '')), 'caster': self.color,
                  'hostile': hostile, 'turns': entry.get('turns', 1),
                  'expiresAt': self.ply + 2 * entry.get('turns', 1),
                  **{s: stats.get(s, 0) for s in ('mov', 'atk', 'def', 'hel')},
                  **{s: stats[s] for s in ('effect', 'setAtk', 'setDef', 'setHel') if s in stats}}
        if not any(effect.get(s) for s in ('mov', 'atk', 'def', 'hel', 'effect')) and not any(
                s in effect for s in ('setAtk', 'setDef', 'setHel')):
            return
        uid = unit['uid']
        effects = self.data['buffs'].get(uid, {}).get('effects', [])
        self.data['buffs'][uid] = summed([*effects, effect])

    def change_hp(self, key, unit, amount, remove=False):
        unit = cap_unit(unit)
        old = unit['hp']
        if amount < 0 and not remove and carries(self.data['buffs'].get(unit['uid']), 'invulnerable'):
            amount = 0
        hp = cap_stat(min(unit.get('max_hp', unit_stats(unit['unit_id'], self.config, active_vet(unit)).get('hp', old)), old + amount))
        if key in self.board:
            if hp > 0:
                self.board[key] = {**unit, 'hp': hp}
            else:
                self.board.pop(key, None)
                self.history.append({'from': key, 'to': key, 'turn': self.ply, 'color': unit['color'],
                                     'abilityDeath': {**unit, 'key': key}})
        else:
            self.history.append({'from': '', 'to': '', 'turn': self.ply, 'color': unit['color'],
                                 'panelEffect': True, 'intoPanel': True, 'unit': {**unit, 'hp': old},
                                 'panel': unit.get('panel'), 'defenderHp': hp,
                                 'defender_eliminated': hp <= 0, 'attacked': False, 'captured': None,
                                 **({'abilityDeath': {**unit, 'key': key}} if hp <= 0 else {})})
        return hp - old

    def cast(self, command):
        ability_id = command.get('id')
        if not isinstance(ability_id, str) or ability_id not in self.catalogue:
            raise ValueError('Unknown ability')
        entry = self.catalogue[ability_id]
        uid = command.get('unitUid')
        source_key, source = self.find(uid) if uid else (None, None)
        path = next((p for p in ability_config(self.config).get('paths', [])
                     if p['id'] == self.data['paths'][self.color]), None)
        path_slot = bool(path and ability_id in (path.get('utility'), path.get('skill'), path.get('ultimate')))
        unit_slot = bool(source and source_key in self.board and source['color'] == self.color
                         and self.config['units'][source['unit_id']].get('ability') == ability_id)
        if uid and (not unit_slot or source.get('vet', 0) < (3 if entry.get('effect') else 2)
                    or carries(self.data['buffs'].get(uid), 'action-lock') or self.data['usedUnits'].get(uid) == self.ply):
            raise ValueError('This unit cannot use that ability')
        if not uid and not path_slot and ability_id not in self.data['loadouts'][self.color]:
            raise ValueError('That ability is not carried')
        if is_initialization(self.ply) and not (path and ability_id == path.get('utility')):
            raise ValueError('Only CP utilities can be used during initialization')
        cooldown = self.data['unitCooldowns'].get(uid, {}).get('turns', 0) if unit_slot else self.data['cooldowns'][self.color].get(ability_id, 0)
        holder = uid if unit_slot else self.color
        use_key = holder + '|' + ability_id + (f'|phase:{phase_index_at(self.ply)}' if entry.get('usesScope') == 'phase' else '')
        limit = entry.get('uses', 1 if path and ability_id == path.get('ultimate') else None)
        if cooldown > 0 or (limit is not None and self.data['uses'].get(use_key, 0) >= limit):
            raise ValueError('That ability is cooling down or used up')
        unit_up = unit_slot and entry.get('effect') in UNIT_ACTIVES
        cost = entry.get('cost', 0)
        available = unit_points_of(self.color, self.history, self.config) if unit_up else self.cp() if path_slot else (
            points_of(self.color, self.ply, self.history, self.config, self.state.phase_bank) + self.data['pointDelta'][self.color])
        if available < cost:
            raise ValueError('Not enough points for that ability')
        target = entry.get('target', 'friendly')
        mode = entry.get('effect')
        recipients = self.recipients(entry.get('scope', 'all'))
        target_key = command.get('hex')
        chosen_key, chosen = self.find(command.get('targetUid'))
        if target == 'hex':
            if not isinstance(target_key, str):
                raise ValueError('Select a hex')
            rendered = set(k for values in panels.panel_zones(self.radius, self.orientation).values() for k in values)
            q, r = parse_coord(target_key)
            target_key = coord_key(q, r)
            if not panels.on_battlefield(q, r, self.radius) and target_key not in rendered:
                raise ValueError('That hex is outside the rendered board')
            recipients = {k: u for k, u in recipients.items() if effect_band(target_key, k, entry, self.orientation)}
        elif mode == 'recharge':
            pair_id = command.get('pairId')
            pool = ability_config(self.config).get('pool', [])
            if not isinstance(pair_id, str) or pair_id not in pool or pair_id not in self.data['loadouts'][self.color]:
                raise ValueError('Select a carried pair')
            index = pool.index(pair_id)
            for i in pool[index - index % 2:index - index % 2 + 2]:
                cd = self.data['cooldowns'][self.color].get(i, 0)
                self.data['cooldowns'][self.color][i] = max(1, cd - entry.get('recharge', 0)) if cd > 0 else 0
            recipients = {}
        elif mode == 'control':
            progress = self.data.get('unitProgress', {}).get(uid)
            if self.data.get('endedUnits', {}).get(uid) == self.ply or (progress and (
                    self.data.get('activeUnit') != uid or progress.get('attacked') or progress.get('healed'))):
                raise ValueError('The caster has finished its action')
            if not progress and self.data.get('extraUnits', {}).get(uid) != self.ply and actions_used(self.state, self.color) >= board_moves_per_turn(self.ply):
                raise ValueError('No battlefield action remains for the caster')
            if not chosen or chosen_key not in self.recipients('field-reserve') or chosen['color'] == self.color or hex_distance(parse_coord(source_key), parse_coord(chosen_key)) != 1:
                raise ValueError('Cast needs an adjacent battlefield or reserve enemy')
            recipients = {chosen_key: chosen}
        elif unit_slot and mode == 'sacrifice' and 'stars' in entry:
            if not chosen or chosen_key not in self.recipients('field-reserve') or chosen['color'] != self.color or chosen['uid'] == uid:
                raise ValueError('Sacrifice needs another friendly battlefield or reserve unit')
            recipients = {chosen_key: chosen}
        elif unit_slot:
            recipients = {source_key: source}
        elif target in ('friendly', 'enemy'):
            if not chosen or chosen_key not in recipients or (chosen['color'] == self.color) != (target == 'friendly'):
                raise ValueError('Select a living unit on the required side')
            filtered = unit_effect(chosen, self.config, entry)
            if target == 'friendly' and (entry.get('atk', 0) > 0 or entry.get('hel', 0) > 0) and not any(
                    filtered.get(s, 0) > 0 for s in ('mov', 'atk', 'def', 'hel', 'heal')) and not filtered.get('effect'):
                raise ValueError('That unit has no stat this ability can boost')
            recipients = {chosen_key: chosen}
        elif target == 'all-enemies':
            recipients = {k: u for k, u in self.recipients('field-reserve').items() if u['color'] != self.color}
        elif target == 'universal' and not mode:
            recipients = {}
        extra_uid = command.get('extraUid')
        if extra_uid is not None:
            extra_key, extra = self.find(extra_uid)
            acted = any(m.get('turn') == self.ply and (m.get('uid') or (m.get('unit') or {}).get('uid')) == extra_uid
                        and (m.get('entered') or m.get('from')) for m in self.history if isinstance(m, dict))
            if (mode != 'sacrifice' or 'stars' not in entry or not extra or extra_key not in self.board
                    or extra['color'] != self.color or extra_uid == uid or acted
                    or self.data.get('unitProgress', {}).get(extra_uid)
                    or self.data.get('endedUnits', {}).get(extra_uid) == self.ply
                    or carries(self.data['buffs'].get(extra_uid), 'action-lock')):
                raise ValueError('Select an unused friendly battlefield unit for the extra action')
        if unit_slot:
            if not unit_up:
                self.data['pointDelta'][self.color] -= cost
            else:
                self.history.append({'from': '', 'to': '', 'turn': self.ply, 'color': self.color,
                                     'unitCast': {'uid': uid, 'id': ability_id, 'color': self.color,
                                              'cost': cost, 'gain': entry.get('up', 0)}})
            self.data['unitCooldowns'][uid] = {'turns': entry.get('cooldown', 3), 'color': self.color}
            self.data['usedUnits'][uid] = self.ply
        elif path_slot:
            self.data['cpSpent'][self.color] += cost
        else:
            self.data['pointDelta'][self.color] -= cost
        self.data['pointDelta'][self.color] += entry.get('points', 0)
        if not unit_slot:
            self.data['cooldowns'][self.color][ability_id] = entry.get('cooldown', 3)
        self.data['uses'][use_key] = self.data['uses'].get(use_key, 0) + 1
        self.data['castAt'][self.color + '|' + ability_id] = self.ply
        if mode == 'call' or (mode == 'sacrifice' and 'stars' not in entry):
            recipients = self.recipients('field-reserve')
            if mode == 'call' and 'radius' in entry:
                recipients = {k: u for k, u in recipients.items()
                              if 0 < hex_distance(parse_coord(source_key), parse_coord(k)) <= entry['radius']}
            if mode == 'sacrifice':
                recipients = {k: u for k, u in recipients.items() if u['color'] == self.color and u['uid'] != uid}
        marks = []
        for key, unit in recipients.items():
            friendly = unit['color'] == self.color
            band = effect_band(target_key, key, entry, self.orientation) if target == 'hex' else None
            hostile = band != 'outer' if band else not friendly
            delta = 0
            if mode == 'promote' or (mode == 'sacrifice' and 'stars' in entry):
                promoted = ranked_unit(unit, self.config, min(3, unit.get('vet', 0) + entry.get('stars', 1)), active=not unit.get('panel'))
                if mode == 'sacrifice':
                    promoted['hp'] = promoted['max_hp']
                    self.add_buff(promoted, entry)
                if key in self.board:
                    self.board[key] = promoted
                else:
                    self.history.append({'turn': self.ply, 'color': unit['color'], 'panelEffect': True,
                                         'intoPanel': True, 'unit': promoted, 'panel': unit.get('panel'), 'defenderHp': promoted['hp']})
                self.history.append({'turn': self.ply, 'promotion': promoted})
                delta = promoted['hp'] - unit['hp']
            elif mode in ('hex-cleave', 'ruin'):
                amount = entry.get('heal', 0) if mode == 'hex-cleave' and band == 'outer' else -(
                    entry.get('damage', 0) if mode == 'ruin' or band == 'centre' else entry.get('splashDamage', 0))
                delta = self.change_hp(key, unit, amount)
                if mode == 'ruin' and friendly and unit['hp'] + delta > 0:
                    left = {**unit, 'hp': unit['hp'] + delta}
                    delta += self.change_hp(key, left, entry.get('heal', 0))
            elif mode == 'hex-sap':
                stats = {'setAtk': entry.get('setAtk', 0), 'setHel': entry.get('setHel', 0)} if band == 'centre' else {
                    'atk': entry.get('outerAtk', 0), 'hel': entry.get('outerHel', 0)} if band == 'outer' else {
                    'atk': entry.get('splashAtk', 0), 'hel': entry.get('splashHel', 0)}
                self.add_buff(unit, entry, stats, hostile)
            elif mode == 'hex-trap':
                if band == 'centre':
                    old = self.data['buffs'].get(unit['uid'], {}).get('effects', [])
                    stripped = []
                    for e in old:
                        e = {**e, **{s: min(0, e.get(s, 0)) for s in ('mov', 'atk', 'def', 'hel')}}
                        if e.get('effect') in ('charge', 'cleave', 'nullify', 'taunt', 'invulnerable'):
                            e.pop('effect', None)
                        if any(e.get(s, 0) < 0 for s in ('mov', 'atk', 'def', 'hel')) or e.get('effect') or any(s in e for s in ('setAtk', 'setDef', 'setHel')):
                            stripped.append(e)
                    if stripped:
                        self.data['buffs'][unit['uid']] = summed(stripped)
                    else:
                        self.data['buffs'].pop(unit['uid'], None)
                    self.add_buff(unit, entry, {'effect': 'action-lock'}, True)
                else:
                    self.add_buff(unit, entry, {'mov': entry.get('outerMov', 0) if band == 'outer' else entry.get('splashMov', 0)}, hostile)
            elif mode == 'fortress':
                self.add_buff(unit, entry, {'effect': 'invulnerable'} if friendly else {'setDef': entry.get('enemyDefSet', 0)}, not friendly)
            elif mode == 'blitz':
                self.add_buff(unit, entry, entry if friendly else {'effect': 'action-lock'}, not friendly)
            elif mode == 'control':
                control = {**unit, 'owner': unit.get('owner', unit['color']), 'color': self.color,
                           'controlledUntil': self.ply + 2 * entry.get('turns', 1), 'controlTurn': self.ply}
                self.data['controls'][unit['uid']] = control
                self.data['extraUnits'][unit['uid']] = self.ply
                self.data['endedUnits'][uid] = self.ply
                self.history.append({'turn': self.ply, 'color': self.color, 'control': control,
                                     'controlSource': uid, 'at': key})
                if key in self.board:
                    self.board[key] = control
            elif mode in ('sacrifice', 'call'):
                delta = self.change_hp(key, unit, entry.get('heal', 0) if friendly else -entry.get('enemyDamage', 0))
                self.add_buff(unit, entry, {
                    'mov': entry.get('mov', 0) if friendly else entry.get('enemyMov', 0),
                    'atk': entry.get('atk', 0) if friendly else entry.get('enemyAtk', 0),
                    'def': entry.get('def', 0) if friendly else entry.get('enemyDef', 0)}, not friendly)
            elif mode in ('attack-drain', 'taunt', 'cleave', 'charge', 'nullify'):
                self.add_buff(unit, entry)
            else:
                delta = self.change_hp(key, unit, entry.get('heal', 0) if friendly else -entry.get('damage', 0))
                if any(entry.get(s, 0) for s in ('mov', 'atk', 'def', 'hel')):
                    self.add_buff(unit, entry, hostile=not friendly)
            marks.append({'at': key, 'uid': unit['uid'], 'color': unit['color'], 'delta': delta, 'hostile': hostile})
        if extra_uid is not None:
            self.data['extraUnits'][extra_uid] = self.ply
            self.history.append({'turn': self.ply, 'color': self.color, 'extraUnit': {'uid': extra_uid, 'color': self.color}})
        if mode == 'sacrifice':
            delta = self.change_hp(source_key, source, -source['hp'], remove=True)
            marks.append({'at': source_key, 'uid': uid, 'color': self.color, 'delta': delta, 'hostile': True})
        self.history.append({'from': '', 'to': '', 'turn': self.ply, 'color': self.color,
                             'abilityCast': {'id': ability_id, 'row': 'unit' if unit_slot else 'path' if path_slot else 'pool',
                                             'unitUid': uid, 'name': entry.get('name', ability_id), 'targets': marks}})
        self.state.board_state = self.board

    def end_turn(self):
        for key, unit in self.recipients('field-reserve').items():
            if unit['color'] == self.color and passive(unit, self.config).get('effect') == 'regenerate':
                self.change_hp(key, unit, unit.get('max_hp', unit['hp']) - unit['hp'])
        self.state.board_state = self.board

    def begin_turn(self, color, ply):
        for uid, buff in list(self.data['buffs'].items()):
            left = [e for e in buff['effects'] if ply < e['expiresAt']]
            if left:
                self.data['buffs'][uid] = summed(left)
            else:
                self.data['buffs'].pop(uid, None)
        for key, unit in list(self.board.items()):
            self.board[key] = controlled(unit, self.data, ply)
        for uid, cooldown in list(self.data['unitCooldowns'].items()):
            _, unit = self.find(uid)
            if unit:
                cooldown['color'] = controlled(unit, self.data, ply)['color']
            if cooldown['color'] == color:
                cooldown['turns'] = max(0, cooldown['turns'] - 1)
            if not cooldown['turns']:
                self.data['unitCooldowns'].pop(uid, None)
        self.data['unitProgress'] = {}
        self.data['activeUnit'] = None
        self.data['cooldowns'][color] = {k: max(0, v - 1) for k, v in self.data['cooldowns'][color].items()}
        self.color, self.ply = color, ply
        if not is_initialization(ply):
            for key, unit in self.board.items():
                trait = passive(unit, self.config)
                if unit['color'] != color or trait.get('effect') not in ('persuade', 'intimidate'):
                    continue
                friendly = trait['effect'] == 'persuade'
                for at, recipient in self.board.items():
                    if hex_distance(parse_coord(key), parse_coord(at)) == 1 and (recipient['color'] == color) == friendly:
                        self.add_buff(recipient, trait, hostile=not friendly)
        self.state.board_state = self.board
