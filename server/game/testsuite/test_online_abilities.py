"""Authoritative ability effects and chronological network turn execution."""
import copy
import asyncio
from datetime import timedelta
from types import SimpleNamespace

from django.test import SimpleTestCase, TransactionTestCase
from django.utils import timezone

from game.consumers import GameConsumer, _pending_turn_timers
from game.engine import panels
from game.engine.ability_rules import AbilityContext, bonus, carries, initial_state, setting
from game.engine.board import HexBoard, HEX_DIRECTIONS
from game.engine.config_loader import DEFAULT_CONFIG
from game.engine.economy import unit_points_of
from game.engine.game_logic import board_moves_at, defeated_sides, overtime_toll, resolve_panel_attack
from game.engine.scoring import deaths_of
from game.engine.move_validator import get_legal_moves
from game.engine.unit_combat import after_exchange, attack_allowed, exchange, taunt_allows
from game.engine.unit_stats import unit_stats
from game.validators import ValidationError
from game.models import GameState, TurnDraft
from game.testsuite import test_turn_drafts as draft_tests


class OnlineAbilityRulesTests(SimpleTestCase):
    def setUp(self):
        self.config = copy.deepcopy(DEFAULT_CONFIG)
        self.config['setup'] = {'white': {}, 'black': {}}
        self.config['rules'].update(cpAtStart=1000, upAtStart=1000, turnTimeLimit=0)
        self.state = SimpleNamespace(config_snapshot=self.config, ability_state=initial_state(),
            turn_number=55, current_turn='alice', player_white='alice', player_black='bob',
            board_state={}, move_history=[], phase_bank={'1': {'white': 5, 'black': 5},
                '2': {'white': 5, 'black': 5}}, game_id='ability-test', revision=1,
            is_finished=False, winner='', end_reason='', turn_started_at=None)
        self.state.ability_state['pointDelta']['white'] = 1000
        self.put('-8,0', 'king', 'white', 'wk')
        self.put('8,0', 'king', 'black', 'bk')
        self.ctx = AbilityContext(self.state)

    def put(self, key, kind='pawn', color='white', uid=None, vet=3, hp=None):
        full = unit_stats(kind, self.config, vet)['hp']
        unit = {'unit_id': kind, 'color': color, 'uid': uid or key, 'vet': vet,
                'hp': full if hp is None else hp, 'max_hp': full}
        self.state.board_state[key] = unit
        return unit

    def panel(self, panel, kind='pawn', uid=None, vet=3, hp=None):
        key = panels.panel_zones(11)[panel][0]
        color = panels.color_of_panel(panel)
        self.config['setup'][color][key] = kind
        # Use a withdrawal to preserve arranged rank/HP through normal panel reconstruction.
        unit = self.put(key, kind, color, uid or panel, vet, hp)
        self.state.board_state.pop(key)
        self.state.move_history.append({'turn': 53, 'color': color, 'from': '0,0',
            'to': key, 'withdrawn': True, 'unit_id': kind, 'unit': unit})
        return key, self.ctx.find(unit['uid'])[1]

    def carry(self, *ids):
        self.state.ability_state['loadouts']['white'] = list(ids)

    def cast(self, ability, **target):
        self.ctx.cast({'type': 'cast_ability', 'id': ability, **target})

    def path(self, path):
        self.ctx.pick({'type': 'pick_path', 'id': path})

    def test_pair_unlock_is_per_side_and_measured_in_full_turns(self):
        self.state.turn_number = self.ctx.ply = 7
        self.ctx.pick({'type': 'pick_pair', 'id': 'warcry'})
        with self.assertRaisesRegex(ValueError, 'not unlocked'):
            self.ctx.pick({'type': 'pick_pair', 'id': 'bulwark'})
        self.ctx.ply = 17
        self.ctx.pick({'type': 'pick_pair', 'id': 'bulwark'})
        self.assertEqual(self.ctx.data['loadouts']['white'], ['warcry', 'sap', 'bulwark', 'weakening'])
        self.assertEqual(self.ctx.data['pickTurns']['white'], 4)
        self.assertIsNone(self.ctx.data['pickTurns']['black'])

    def test_free_pair_return_and_later_swap_cold_start(self):
        self.ctx.pick({'type': 'pick_pair', 'id': 'warcry'})
        self.ctx.pick({'type': 'reset_pair', 'id': 'warcry'})
        self.ctx.pick({'type': 'pick_pair', 'id': 'mend'})
        self.assertEqual(self.ctx.data['cooldowns']['white'], {})
        self.ctx.ply += 2
        self.ctx.pick({'type': 'reset_pair', 'id': 'mend'})
        self.ctx.ply += 10
        self.ctx.pick({'type': 'pick_pair', 'id': 'dash'})
        self.assertEqual(self.ctx.data['cooldowns']['white'], {'dash': 4, 'mire': 3})

    def test_pool_buffs_cost_cooldown_and_configured_expiry(self):
        pawn = self.put('0,0')
        self.carry('warcry', 'bulwark', 'dash')
        for ability, stat, value, cost, cd in [('warcry', 'atk', 8, 25, 3),
                ('bulwark', 'def', 8, 25, 3), ('dash', 'mov', 4, 20, 4)]:
            with self.subTest(ability=ability):
                old = self.ctx.data['pointDelta']['white']
                self.cast(ability, targetUid=pawn['uid'])
                self.assertEqual(self.ctx.data['buffs'][pawn['uid']][stat], value)
                self.assertEqual(self.ctx.data['pointDelta']['white'], old - cost)
                self.assertEqual(self.ctx.data['cooldowns']['white'][ability], cd)
                with self.assertRaisesRegex(ValueError, 'cooling'):
                    self.cast(ability, targetUid=pawn['uid'])
        self.ctx.begin_turn('black', 56)
        self.assertIn(pawn['uid'], self.ctx.data['buffs'])
        self.ctx.begin_turn('white', 57)
        self.assertNotIn(pawn['uid'], self.ctx.data['buffs'])
        self.assertEqual(self.ctx.data['cooldowns']['white']['warcry'], 2)

    def test_selected_pool_debuffs_require_one_living_enemy_and_keep_their_zone_scope(self):
        for color in ('white', 'black'):
            for ability, stat in (('sap', 'atk'), ('weakening', 'def'), ('mire', 'mov')):
                for zone in ('field', 'reserve'):
                    with self.subTest(color=color, ability=ability, zone=zone):
                        self.setUp()
                        self.ctx.color = color
                        self.ctx.ply = self.state.turn_number = 55 if color == 'white' else 56
                        enemy_color = 'black' if color == 'white' else 'white'
                        enemy = self.put('0,0', color=enemy_color, uid='target')
                        self.put('1,0', color=enemy_color, uid='other')
                        _, reserve = self.panel('tl' if enemy_color == 'black' else 'br', uid='reserve')
                        _, base = self.panel('tr' if enemy_color == 'black' else 'bl', uid='base')
                        self.put('2,0', color=enemy_color, uid='dead', hp=0)
                        self.ctx.data['loadouts'][color] = [ability]
                        before = copy.deepcopy(self.ctx.data)
                        for target in (None, 'base', 'dead', 'wk' if color == 'white' else 'bk'):
                            with self.assertRaisesRegex(ValueError, 'living unit'):
                                self.cast(ability, **({'targetUid': target} if target else {}))
                            self.assertEqual(self.ctx.data, before)
                        chosen = enemy if zone == 'field' else reserve
                        self.cast(ability, targetUid=chosen['uid'])
                        self.assertEqual(set(self.ctx.data['buffs']), {chosen['uid']})
                        self.assertEqual(self.ctx.data['buffs'][chosen['uid']][stat], self.ctx.catalogue[ability][stat])
                        self.assertEqual(self.ctx.data['cooldowns'][color][ability], self.ctx.catalogue[ability]['cooldown'])
                        self.ctx.begin_turn(enemy_color, self.ctx.ply + 1)
                        self.assertIn(chosen['uid'], self.ctx.data['buffs'])
                        self.ctx.begin_turn(color, self.ctx.ply + 1)
                        self.assertNotIn(chosen['uid'], self.ctx.data['buffs'])

    async def test_selected_debuff_commands_replay_only_the_selected_uid_atomically(self):
        self.put('0,0', color='black', uid='target')
        self.put('1,0', color='black', uid='other')
        for ability in ('sap', 'weakening', 'mire'):
            with self.subTest(ability=ability):
                result = await GameConsumer()._preview_turn(self.state, [
                    {'type': 'pick_pair', 'id': ability},
                    {'type': 'cast_ability', 'id': ability, 'targetUid': 'target'},
                    {'type': 'pass_turn'}])
                self.assertEqual(set(result.ability_state['buffs']), {'target'})
                cast = next(move['abilityCast'] for move in result.move_history if move.get('abilityCast'))
                self.assertEqual([target['uid'] for target in cast['targets']], ['target'])
                self.assertEqual(result.board_state['0,0']['hp'], self.state.board_state['0,0']['hp'])
                self.assertEqual(self.state.ability_state['buffs'], {})

    def test_legacy_army_debuffs_include_reserves_not_bases_and_follow_recipients(self):
        for ability in ('sap', 'weakening', 'mire'):
            self.ctx.catalogue[ability]['target'] = 'all-enemies'
            self.ctx.catalogue[ability].pop('scope')
        enemy = self.put('0,0', color='black', uid='enemy')
        _, reserve = self.panel('tl', uid='reserve')
        _, base = self.panel('tr', uid='base')
        self.carry('sap', 'weakening', 'mire')
        for ability in ('sap', 'weakening', 'mire'):
            self.cast(ability)
        self.assertEqual({k for k in self.ctx.data['buffs']}, {'enemy', 'reserve', 'bk'})
        self.assertEqual(self.ctx.data['buffs']['enemy']['atk'], -8)
        self.assertEqual(self.ctx.data['buffs']['reserve']['def'], -8)
        self.assertEqual(self.ctx.data['buffs']['reserve']['mov'], -2)
        self.assertNotIn(base['uid'], self.ctx.data['buffs'])
        self.put('1,0', color='black', uid='late')
        self.assertNotIn('late', self.ctx.data['buffs'])
        self.assertFalse(attack_allowed(reserve, 1, self.config, self.ctx.data, True))
        self.assertEqual(bonus(reserve, self.config, self.ctx.data, 'atk'), -8)

    def test_mend_caps_healing_and_strike_kills_without_up_bounty(self):
        self.put('0,0', uid='ally', hp=13)
        self.put('1,0', color='black', uid='enemy', hp=3)
        self.carry('mend', 'strike')
        self.cast('mend', targetUid='ally')
        self.assertEqual(self.ctx.board['0,0']['hp'], 14)
        before = unit_points_of('white', self.ctx.history, self.config)
        self.cast('strike', targetUid='enemy')
        self.assertNotIn('1,0', self.ctx.board)
        self.assertEqual(unit_points_of('white', self.ctx.history, self.config), before)
        self.assertTrue(any(m.get('abilityDeath') for m in self.ctx.history))

    def test_counter_unlock_preserves_debuff_without_creating_an_initiating_attack(self):
        unit = self.put('0,0', 'shieldman', uid='shield', vet=0)
        self.carry('warcry', 'sap')
        for vet in (0, 2):
            unit['vet'] = vet
            with self.assertRaisesRegex(ValueError, 'no stat'):
                self.cast('warcry', targetUid='shield')
        self.ctx.add_buff(unit, self.ctx.catalogue['sap'], hostile=True)
        self.assertFalse(attack_allowed(unit, 1, self.config, self.ctx.data, True))
        self.ctx.data['buffs'].clear()
        self.assertTrue(attack_allowed(unit, 1, self.config, self.ctx.data, True))
        self.assertFalse(attack_allowed(unit, 1, self.config, self.ctx.data))

    def test_bastion_and_onslaught_and_sprint_passives_in_all_zones(self):
        unit = self.put('0,0', vet=0)
        for path, stat in [('bastion', 'def'), ('onslaught', 'atk'), ('tempo', 'mov')]:
            with self.subTest(path=path):
                self.ctx.data['paths']['white'] = path
                self.assertEqual(bonus(unit, self.config, self.ctx.data, stat, True, True), 1)
        self.ctx.data['paths']['white'] = 'bastion'
        self.assertEqual(bonus(unit, self.config, self.ctx.data, 'def', False, False), 0)

    def test_drain_rings_boost_both_sides_and_existing_healers_only(self):
        self.put('0,0', uid='center')
        self.put('1,0', 'bishop', 'black', 'near')
        self.put('2,0', 'bishop', 'white', 'far')
        self.put('0,2', 'pawn', 'black', 'far-enemy')
        self.put('3,0', uid='outside')
        self.path('bastion')
        self.cast('anchor', hex='0,0')
        buffs = self.ctx.data['buffs']
        self.assertEqual(setting(buffs['center'], 'atk'), 0)
        self.assertEqual(buffs['near']['hel'], -4)
        self.assertEqual(buffs['far']['hel'], 2)
        self.assertEqual(buffs['far']['atk'], 0)
        self.assertEqual(buffs['far-enemy']['atk'], 2)
        self.assertNotIn('outside', buffs)

    def test_horizontal_cleave_and_cross_trap_in_both_orientations(self):
        for orientation, horizontal, diagonal in [('edge-up', (1, 0), (0, 1)),
                ('vertex-up', (2, -1), (1, 0))]:
            with self.subTest(orientation=orientation):
                self.setUp(); self.config['board']['orientation'] = orientation
                self.ctx.orientation = orientation
                for n in range(4):
                    self.put(f'{horizontal[0]*n},{horizontal[1]*n}', uid=f'h{n}', hp=10)
                self.path('onslaught'); self.cast('cleave', hex='0,0')
                self.assertEqual([self.ctx.board[f'{horizontal[0]*n},{horizontal[1]*n}']['hp'] for n in range(4)], [5, 7, 7, 11])
                self.ctx.data['paths']['white'] = 'tempo'
                for n in range(1, 4):
                    self.put(f'{diagonal[0]*n},{diagonal[1]*n}', uid=f'd{n}')
                self.cast('surge', hex='0,0')
                self.assertTrue(carries(self.ctx.data['buffs']['h0'], 'action-lock'))
                self.assertEqual([self.ctx.data['buffs'][f'd{n}']['mov'] for n in range(1, 4)], [-4, -4, 2])

    def test_trap_strips_positive_buffs_keeps_debuffs_and_control(self):
        unit = self.put('0,0', uid='target')
        self.ctx.add_buff(unit, self.ctx.catalogue['warcry'])
        self.ctx.add_buff(unit, self.ctx.catalogue['mire'], hostile=True)
        self.ctx.data['controls']['target'] = {'color': 'white', 'owner': 'black', 'controlledUntil': 57}
        self.path('tempo'); self.cast('surge', hex='0,0')
        buff = self.ctx.data['buffs']['target']
        self.assertEqual((buff['atk'], buff['mov']), (0, -2))
        self.assertTrue(carries(buff, 'action-lock'))
        self.assertIn('target', self.ctx.data['controls'])
        self.assertTrue(attack_allowed(unit, 1, self.config, self.ctx.data, True))

    def test_fortress_blocks_strike_and_overtime_including_base(self):
        _, base = self.panel('bl', uid='base')
        self.path('bastion'); self.cast('fortress')
        self.assertTrue(carries(self.ctx.data['buffs']['base'], 'invulnerable'))
        self.assertEqual(setting(self.ctx.data['buffs']['bk'], 'def'), 0)
        before = self.ctx.board['-8,0']['hp']
        board = HexBoard.from_dict(11, self.ctx.board)
        overtime_toll(board, self.config, 'white', 75, self.ctx.data)
        self.assertEqual(board.get(-8, 0)['hp'], before)
        self.carry('strike'); self.ctx.color = 'black'; self.ctx.data['loadouts']['black'] = ['strike']
        self.ctx.data['pointDelta']['black'] = 1000
        self.cast('strike', targetUid='base')
        self.assertEqual(self.ctx.find('base')[1]['hp'], base['hp'])

    def test_ruin_damages_everyone_then_heals_only_friendly_survivors(self):
        self.put('0,0', uid='dead', hp=2)
        self.put('1,0', uid='alive', hp=10)
        self.put('2,0', color='black', uid='enemy', hp=10)
        _, base = self.panel('tr', uid='base')
        self.path('onslaught'); self.cast('ruin')
        self.assertNotIn('0,0', self.ctx.board)
        self.assertEqual(self.ctx.board['1,0']['hp'], 10)
        self.assertEqual(self.ctx.board['2,0']['hp'], 7)
        self.assertEqual(self.ctx.find('base')[1]['hp'], base['hp'] - 3)
        with self.assertRaisesRegex(ValueError, 'used up'):
            self.cast('ruin')

    def test_blitz_scopes_base_and_preserves_counters(self):
        self.put('0,0', 'bishop', uid='healer')
        pawn = self.put('1,0', uid='pawn')
        _, base = self.panel('tr', uid='enemy-base')
        self.path('tempo'); self.cast('blitz')
        self.assertEqual(self.ctx.data['buffs']['healer']['hel'], 4)
        self.assertEqual(self.ctx.data['buffs']['pawn']['hel'], 0)
        self.assertTrue(carries(self.ctx.data['buffs']['enemy-base'], 'action-lock'))
        self.assertTrue(attack_allowed(base, 1, self.config, self.ctx.data, True))

    def test_utilities_phase_uses_and_recharge_floor(self):
        self.path('bastion')
        start = self.ctx.data['pointDelta']['white']
        for _ in range(5):
            self.cast('convert')
            self.ctx.begin_turn('white', self.ctx.ply + 2)
        self.assertEqual(self.ctx.data['pointDelta']['white'], start + 250)
        with self.assertRaisesRegex(ValueError, 'used up'):
            self.cast('convert')
        self.ctx.begin_turn('white', 75)
        self.cast('convert')
        self.ctx.data['paths']['white'] = 'tempo'; self.carry('warcry', 'sap')
        self.ctx.data['cooldowns']['white'] = {'warcry': 1, 'sap': 3}
        self.cast('recharge', pairId='warcry')
        self.assertEqual(self.ctx.data['cooldowns']['white']['warcry'], 1)
        self.assertEqual(self.ctx.data['cooldowns']['white']['sap'], 2)

    def test_panel_ability_casualties_count_reserves_for_both_sides_without_up(self):
        for panel in ('tl', 'br', 'tr', 'bl'):
            self.panel(panel, uid=panel, hp=1)
        before = {color: unit_points_of(color, self.ctx.history, self.config) for color in ('white', 'black')}
        self.path('onslaught')
        self.cast('ruin')
        for color in ('white', 'black'):
            self.assertEqual(deaths_of(self.config, self.ctx.history, color), 2 * self.config['units']['pawn']['value'])
            self.assertEqual(unit_points_of(color, self.ctx.history, self.config), before[color])
        self.assertTrue(all(self.ctx.find(uid)[1] is None for uid in ('tl', 'br')))

    async def test_stationary_locked_panel_attacks_roll_back_and_locked_reserves_can_counter(self):
        key = next(key for key in panels.panel_zones(11)['tl']
                   if any(panels.on_battlefield(q + dq, r + dr, 11)
                          for q, r in [panels.parse_key(key)] for dq, dr in HEX_DIRECTIONS.values()))
        q, r = panels.parse_key(key)
        source = next(f'{q + dq},{r + dr}' for dq, dr in HEX_DIRECTIONS.values()
                      if panels.on_battlefield(q + dq, r + dr, 11))
        self.config['setup']['black'][key] = 'pawn'
        attacker = self.put(source, 'rook', uid='attacker')
        command = {'type': 'panel_attack', 'from': source, 'to': source, 'attack': key}
        for effect in ('surge', 'blitz'):
            with self.subTest(effect=effect):
                self.ctx.data['buffs'] = {}
                self.ctx.add_buff(attacker, self.ctx.catalogue[effect], {'effect': 'action-lock'}, True)
                before = copy.deepcopy(self.state.board_state)
                with self.assertRaises(ValidationError):
                    await GameConsumer()._preview_turn(self.state, [command, {'type': 'pass_turn'}])
                self.assertEqual(self.state.board_state, before)
                board = HexBoard.from_dict(11, before)
                result = resolve_panel_attack(board, self.config, self.ctx.history, source, source, key,
                    'white', 55, ability_state=self.ctx.data)
                self.assertIn('error', result)
                self.assertEqual(board.to_dict(), before)
        self.ctx.data['buffs'] = {}
        self.ctx.data['endedUnits']['attacker'] = 55
        with self.assertRaises(ValidationError):
            await GameConsumer()._preview_turn(self.state, [command])
        self.ctx.data['endedUnits'] = {}
        defender = self.ctx.recipients()[key]
        self.ctx.add_buff(defender, self.ctx.catalogue['surge'], {'effect': 'action-lock'}, True)
        result = resolve_panel_attack(HexBoard.from_dict(11, self.state.board_state), self.config,
            self.ctx.history, source, source, key, 'white', 55, ability_state=self.ctx.data)
        self.assertNotIn('error', result)
        self.assertTrue(result['record']['countered'])

    async def test_strengthen_adds_to_later_phase_awards_on_board_and_reserve(self):
        for zone in ('board', 'reserve'):
            with self.subTest(zone=zone):
                self.setUp()
                if zone == 'board':
                    self.put('0,0', uid='promoted', vet=1, hp=7)
                else:
                    self.panel('br', uid='promoted', vet=1, hp=7)
                    self.state.move_history[-1]['turn'] = 23
                self.state.turn_number = self.ctx.ply = 25
                self.path('onslaught')
                state = await GameConsumer()._preview_turn(self.state, [
                    {'type': 'cast_ability', 'id': 'strengthen', 'targetUid': 'promoted'},
                    {'type': 'pass_turn'}])
                self.assertEqual(AbilityContext(state).find('promoted')[1]['vet'], 2)
                self.assertEqual(board_moves_at(state.move_history, 25, 'white'), 0)
                state = await GameConsumer()._preview_turn(state, [{'type': 'pass_turn'}])
                key, unit = AbilityContext(state).find('promoted')
                self.assertEqual(unit['vet'], 3)
                self.assertEqual((unit['hp'], unit['max_hp']), (7, 14 if zone == 'board' else 12))
                self.assertEqual(panels.unit_veterancy('promoted', key, state.move_history, 27, 11), 3)

    def test_hex_cast_coordinate_aliases_select_the_same_panel_and_battlefield_hex(self):
        for zone in ('field', 'reserve', 'base'):
            with self.subTest(zone=zone):
                self.setUp()
                if zone == 'field':
                    key = '1,0'; self.put(key, uid='target')
                else:
                    key, _ = self.panel('br' if zone == 'reserve' else 'bl', uid='target')
                self.path('bastion')
                q, r = map(int, key.split(','))
                self.cast('anchor', hex=f'{q:03d},{r:03d}')
                self.assertEqual(setting(self.ctx.data['buffs']['target'], 'atk'), 0)
                self.assertEqual(self.ctx.data['cpSpent']['white'], 60)

    async def test_checkmate_walks_charge_their_actual_steps_before_continuing(self):
        self.put('5,-9', uid='walker', vet=2)
        state = await GameConsumer()._preview_turn(self.state, [
            {'type': 'make_move', 'from': '5,-9', 'to': '-2,-9', 'more': True},
            {'type': 'make_move', 'from': '-2,-9', 'to': '-2,-8', 'more': True},
            {'type': 'pass_turn'}])
        self.assertEqual([m['steps'] for m in state.move_history if m.get('uid') == 'walker'], [7, 1])
        with self.assertRaisesRegex(ValidationError, 'Illegal move'):
            await GameConsumer()._preview_turn(self.state, [
                {'type': 'make_move', 'from': '5,-9', 'to': '-2,-9', 'more': True},
                {'type': 'make_move', 'from': '-2,-9', 'to': '-2,-7', 'more': True},
                {'type': 'pass_turn'}])

    async def test_checkmate_panel_attack_records_its_extended_walk_cost(self):
        self.put('5,-9', uid='walker', vet=2)
        self.config['setup']['black']['-3,-9'] = 'shieldman'
        state = await GameConsumer()._preview_turn(self.state, [
            {'type': 'panel_attack', 'from': '5,-9', 'to': '-2,-9', 'attack': '-3,-9', 'more': True},
            {'type': 'pass_turn'}])
        self.assertEqual(next(m['steps'] for m in state.move_history if m.get('uid') == 'walker'), 7)

    async def test_panel_cleave_does_not_hit_its_direct_target_twice_through_coordinate_aliases(self):
        for target in ('-3,-9', '-03,-09'):
            with self.subTest(target=target):
                self.setUp(); self.put('-2,-9', 'rook', uid='rook')
                self.config['setup']['black']['-3,-9'] = 'rook'
                unit = self.put('-3,-9', 'rook', 'black', 'b-3,-9', vet=0, hp=6)
                self.state.board_state.pop('-3,-9')
                self.state.move_history.append({'turn': 54, 'intoPanel': True, 'panelEffect': True,
                    'unit': unit, 'panel': 'tl', 'defenderHp': 6})
                state = await GameConsumer()._preview_turn(self.state, [
                    {'type': 'cast_ability', 'id': 'rook-cleave', 'unitUid': 'rook'},
                    {'type': 'panel_attack', 'from': '-02,-09', 'to': '-02,-09', 'attack': target, 'more': True},
                    {'type': 'pass_turn'}])
                self.assertEqual(deaths_of(self.config, state.move_history, 'black'), 0)
                self.assertFalse(any(m.get('panelEffect') and (m.get('unit') or {}).get('uid') == 'b-3,-9' and m.get('turn') == 55 for m in state.move_history))
                self.assertEqual(AbilityContext(state).find('b-3,-9')[1]['hp'], 2)

    async def test_coordinate_aliases_spend_the_same_movement_budget(self):
        self.config['units']['pawn']['move'] = 2
        self.put('0,0', uid='walker')
        legal = [{'type': 'make_move', 'from': '00, 00', 'to': '01,00'},
                 {'type': 'make_move', 'from': '01,00', 'to': '02,00'}]
        state = await GameConsumer()._preview_turn(self.state, legal)
        records = [move for move in state.move_history if move.get('uid') == 'walker']
        self.assertEqual([(move['from'], move['to'], move['steps']) for move in records],
                         [('0,0', '1,0', 1), ('1,0', '2,0', 1)])
        commands = [{'type': 'make_move', 'from': f'{q - 1},0', 'to': f'{q:02d},00'}
                    for q in range(1, 4)]
        with self.assertRaisesRegex(ValidationError, 'Illegal move'):
            await GameConsumer()._preview_turn(self.state, commands)
        self.assertIn('0,0', self.state.board_state)
        self.assertEqual(self.state.move_history, [])

    def test_panel_attack_normalizes_coordinate_aliases_before_recording_the_walk(self):
        target = next(key for key in panels.panel_zones(11)['tl']
                      if any(panels.on_battlefield(q + dq, r + dr, 11)
                             for q, r in [panels.parse_key(key)] for dq, dr in HEX_DIRECTIONS.values()))
        q, r = panels.parse_key(target)
        end = next((q + dq, r + dr) for dq, dr in HEX_DIRECTIONS.values()
                   if panels.on_battlefield(q + dq, r + dr, 11))
        start = next((end[0] + dq, end[1] + dr) for dq, dr in HEX_DIRECTIONS.values()
                     if panels.on_battlefield(end[0] + dq, end[1] + dr, 11))
        self.config['setup']['black'][target] = 'pawn'
        self.put(panels.coord_key(*start), uid='attacker')
        padded = lambda xy: f'{xy[0]:03d}, {xy[1]:03d}'
        board = HexBoard.from_dict(11, self.state.board_state)
        outcome = resolve_panel_attack(board, self.config, [], padded(start), padded(end),
                                       padded((q, r)), 'white', 55, ability_state=self.ctx.data)
        self.assertNotIn('error', outcome)
        self.assertEqual((outcome['record']['from'], outcome['record']['to'], outcome['record']['attackedHex']),
                         (panels.coord_key(*start), panels.coord_key(*end), target))
        self.assertEqual(outcome['record']['steps'], 1)
        self.assertEqual(board.get(*end)['uid'], 'attacker')

    async def test_completed_history_keeps_a_counter_that_dealt_zero_damage(self):
        knight = self.put('0,0', 'knight', uid='knight')
        self.put('1,0', 'rook', 'black', 'enemy')
        self.ctx.add_buff(knight, self.ctx.catalogue['fortress'], {'effect': 'invulnerable'})
        self.cast('knight-charge', unitUid='knight')
        state = await GameConsumer()._preview_turn(self.state, [
            {'type': 'make_move', 'from': '00,00', 'to': '00,00', 'attack': '01,00'}])
        record = next(move for move in state.move_history if move.get('attacked'))
        self.assertTrue(record.get('countered'))
        self.assertEqual(record['counter_damage'], 0)
        self.assertTrue(record['secondStrike'])
        self.assertEqual(record['attackedHex'], '1,0')
        self.assertEqual(state.board_state['0,0']['hp'], knight['hp'])

    async def test_strengthen_does_not_spend_the_battlefield_action(self):
        self.put('0,0', uid='promoted', vet=1)
        self.path('onslaught')
        state = await GameConsumer()._preview_turn(self.state, [
            {'type': 'cast_ability', 'id': 'strengthen', 'targetUid': 'promoted'},
            {'type': 'make_move', 'from': '0,0', 'to': '1,0'},
            {'type': 'pass_turn'}])
        self.assertEqual(state.board_state['1,0']['uid'], 'promoted')
        self.assertEqual(board_moves_at(state.move_history, 55, 'white'), 1)

    def test_strengthen_raises_current_and_max_hp_once_and_caps_rank(self):
        self.put('0,0', uid='pawn', vet=0, hp=5)
        self.path('onslaught')
        for expected in (1, 2, 3, 3):
            self.cast('strengthen', targetUid='pawn')
            self.assertEqual(self.ctx.board['0,0']['vet'], expected)
            self.assertEqual((self.ctx.board['0,0']['hp'], self.ctx.board['0,0']['max_hp']), (7, 14))
            self.ctx.begin_turn('white', self.ctx.ply + 2)

    def test_legacy_sacrifice_spends_up_counts_death_and_excludes_bases(self):
        entry = self.ctx.catalogue['unit-sacrifice']; entry.pop('stars')
        entry.update(atk=1, def_=1, mov=1, heal=1); entry['def'] = entry.pop('def_')
        self.put('0,0', uid='pawn')
        self.put('1,0', 'bishop', uid='ally', hp=3)
        self.panel('bl', uid='base')
        before = unit_points_of('white', self.ctx.history, self.config)
        self.cast('unit-sacrifice', unitUid='pawn')
        self.assertNotIn('0,0', self.ctx.board)
        self.assertEqual(unit_points_of('white', self.ctx.history, self.config), before + self.ctx.catalogue['unit-sacrifice']['up'] - self.ctx.catalogue['unit-sacrifice']['cost'])
        self.assertEqual(self.ctx.board['1,0']['hp'], 4)
        self.assertEqual(self.ctx.data['buffs']['ally']['atk'], 0)
        self.assertEqual(self.ctx.data['buffs']['ally']['def'], 1)
        self.assertNotIn('base', self.ctx.data['buffs'])

    def test_selected_sacrifice_promotes_heals_and_buffs_one_recipient_for_either_seat(self):
        for color in ('white', 'black'):
            for zone in ('field', 'reserve'):
                for rank in (0, 1, 2, 3):
                    with self.subTest(color=color, zone=zone, rank=rank):
                        self.setUp()
                        self.ctx.color = color
                        self.ctx.ply = self.state.turn_number = 55 if color == 'white' else 56
                        self.state.current_turn = 'alice' if color == 'white' else 'bob'
                        pawn = self.put('0,0', color=color, uid='caster')
                        self.put('1,0', color=color, uid='other', hp=3)
                        if zone == 'field':
                            key = '2,0'; self.put(key, color=color, uid='target', vet=rank, hp=3)
                        else:
                            key, _ = self.panel('br' if color == 'white' else 'tl', uid='target', vet=rank, hp=3)
                            self.ctx.history[-1]['from'] = panels.panel_zones(11)['bl' if color == 'white' else 'tr'][0]
                        before = unit_points_of(color, self.ctx.history, self.config)
                        self.cast('unit-sacrifice', unitUid='caster', targetUid='target')
                        _, target = self.ctx.find('target')
                        self.assertEqual(target['vet'], min(3, rank + 1))
                        self.assertEqual(target['hp'], target['max_hp'])
                        self.assertEqual((self.ctx.data['buffs']['target']['mov'], self.ctx.data['buffs']['target']['atk'], self.ctx.data['buffs']['target']['def']), (2, 6, 6))
                        self.assertEqual(set(self.ctx.data['buffs']), {'target'})
                        self.assertNotIn('0,0', self.ctx.board)
                        self.assertEqual(unit_points_of(color, self.ctx.history, self.config), before - 24)
                        self.assertEqual(deaths_of(self.config, self.ctx.history, color, 3), self.config['units']['pawn']['value'])
                        self.assertTrue(any(m.get('promotion', {}).get('uid') == 'target' for m in self.ctx.history))
                        self.ctx.begin_turn('black' if color == 'white' else 'white', self.ctx.ply + 1)
                        self.assertIn('target', self.ctx.data['buffs'])
                        self.ctx.begin_turn(color, self.ctx.ply + 1)
                        self.assertNotIn('target', self.ctx.data['buffs'])
                        self.assertEqual(self.ctx.find('target')[1]['vet'], min(3, rank + 1))

    async def test_sacrifice_bonuses_apply_to_real_attack_and_counter_for_both_seats(self):
        for color in ('white', 'black'):
            with self.subTest(color=color):
                self.setUp(); enemy_color = 'black' if color == 'white' else 'white'
                self.state.current_turn = 'alice' if color == 'white' else 'bob'
                self.state.turn_number = 55 if color == 'white' else 56
                self.put('-2,0', color=color, uid='caster')
                self.put('0,0', color=color, uid='ally', hp=3)
                self.put('1,0', color=enemy_color, uid='enemy')
                state = await GameConsumer()._preview_turn(self.state, GameConsumer._draft_commands([
                    {'type': 'cast_ability', 'id': 'unit-sacrifice', 'unitUid': 'caster', 'targetUid': 'ally', 'extraUid': 'ally'},
                    {'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '1,0', 'more': True},
                    {'type': 'pass_turn'}]))
                self.assertEqual((state.board_state['0,0']['hp'], state.board_state['1,0']['hp']), (13, 6))
                self.assertEqual(unit_points_of(color, state.move_history, self.config), 976)
                self.assertEqual(deaths_of(self.config, state.move_history, color), 12)
                self.assertEqual(deaths_of(self.config, state.move_history, enemy_color), 0)

    async def test_sacrifice_extra_actor_is_independent_and_does_not_restore_used_actions(self):
        for selected in ('target', 'extra'):
            with self.subTest(selected=selected):
                self.setUp()
                self.put('0,0', uid='caster')
                self.put('2,0', uid='target', vet=1, hp=3)
                self.put('3,0', uid='extra')
                self.put('-2,0', uid='ordinary')
                key = '2,0' if selected == 'target' else '3,0'
                state = await GameConsumer()._preview_turn(self.state, GameConsumer._draft_commands([
                    {'type': 'make_move', 'from': '-2,0', 'to': '-3,0', 'more': True},
                    {'type': 'cast_ability', 'id': 'unit-sacrifice', 'unitUid': 'caster', 'targetUid': 'target', 'extraUid': selected},
                    {'type': 'make_move', 'from': key, 'to': key.replace(',0', ',1'), 'more': True},
                    {'type': 'pass_turn'}]))
                self.assertEqual(state.turn_number, 56)
                self.assertEqual(state.board_state[key.replace(',0', ',1')]['uid'], selected)
                self.assertEqual(board_moves_at(state.move_history, 55, 'white'), 1)
                self.assertTrue(any(m.get('extraUnit', {}).get('uid') == selected for m in state.move_history))
        self.setUp(); self.put('0,0', uid='caster'); self.put('2,0', uid='target')
        before = copy.deepcopy(self.state.board_state)
        with self.assertRaisesRegex(ValidationError, 'unused'):
            await GameConsumer()._preview_turn(self.state, [
                {'type': 'make_move', 'from': '2,0', 'to': '2,1', 'more': True},
                {'type': 'cast_ability', 'id': 'unit-sacrifice', 'unitUid': 'caster', 'targetUid': 'target', 'extraUid': 'target'}])
        self.assertEqual(self.state.board_state, before)
        self.assertEqual(self.state.move_history, [])

    def test_sacrifice_rejects_invalid_recipients_and_extra_actors_without_payment(self):
        self.put('0,0', uid='caster'); self.put('1,0', uid='target')
        self.put('2,0', color='black', uid='enemy'); self.panel('bl', uid='base'); self.panel('br', uid='green')
        for target, extra in [('caster', None), ('enemy', None), ('base', None), ('missing', None),
                              ('target', 'enemy'), ('target', 'base'), ('target', 'green'), ('target', 'caster'), ('target', 'missing')]:
            with self.subTest(target=target, extra=extra):
                before = copy.deepcopy(self.ctx.data), copy.deepcopy(self.ctx.board), copy.deepcopy(self.ctx.history)
                with self.assertRaises(ValueError):
                    self.cast('unit-sacrifice', unitUid='caster', targetUid=target, **({'extraUid': extra} if extra else {}))
                self.assertEqual((self.ctx.data, self.ctx.board, self.ctx.history), before)
        self.ctx.add_buff(self.ctx.board['1,0'], {'name': 'Trap', 'turns': 1}, {'effect': 'action-lock'})
        with self.assertRaisesRegex(ValueError, 'unused'):
            self.cast('unit-sacrifice', unitUid='caster', targetUid='target', extraUid='target')

    async def test_sacrifice_promotion_remains_additive_at_the_next_phase_award(self):
        for zone in ('board', 'reserve'):
            with self.subTest(zone=zone):
                self.setUp(); self.put('0,0', uid='caster')
                if zone == 'board':
                    self.put('2,0', uid='promoted', vet=1, hp=3)
                else:
                    self.panel('br', uid='promoted', vet=1, hp=3)
                    self.state.move_history[-1]['turn'] = 23
                self.state.turn_number = self.ctx.ply = 25
                state = await GameConsumer()._preview_turn(self.state, [
                    {'type': 'cast_ability', 'id': 'unit-sacrifice', 'unitUid': 'caster', 'targetUid': 'promoted'},
                    {'type': 'pass_turn'}])
                self.assertEqual(AbilityContext(state).find('promoted')[1]['vet'], 2)
                state = await GameConsumer()._preview_turn(state, [{'type': 'pass_turn'}])
                key, unit = AbilityContext(state).find('promoted')
                self.assertEqual(unit['vet'], 3)
                self.assertEqual(unit['hp'], unit['max_hp'])
                self.assertEqual(panels.unit_veterancy('promoted', key, state.move_history, 27, 11), 3)

    def test_sacrifice_does_not_create_missing_attack_profiles(self):
        for kind in ('bishop', 'shieldman'):
            with self.subTest(kind=kind):
                self.setUp(); self.put('0,0', uid='caster'); self.put('1,0', kind, uid='target', vet=1, hp=2)
                self.cast('unit-sacrifice', unitUid='caster', targetUid='target')
                self.assertEqual(self.ctx.data['buffs']['target']['atk'], 0)
                self.assertEqual(self.ctx.find('target')[1]['vet'], 2)

    def test_quick_archer_and_counter_only_shield_use_their_exact_rings(self):
        archer = self.put('0,0', 'archer')
        shield = self.put('1,0', 'shieldman')
        self.assertEqual([attack_allowed(archer, n, self.config, self.ctx.data, True) for n in (1, 2, 3)], [False, False, True])
        self.assertEqual([attack_allowed(shield, n, self.config, self.ctx.data, True) for n in (1, 2, 3)], [True, False, False])
        self.assertFalse(attack_allowed(shield, 1, self.config, self.ctx.data))
        from game.engine.ability_rules import passive
        self.assertEqual(passive(archer, self.config)['effect'], 'rapid-movement')
        archer['panel'] = 'br'; shield['panel'] = 'tl'
        self.assertFalse(attack_allowed(shield, 1, self.config, self.ctx.data, True))
        self.assertEqual(passive(archer, self.config), {})

    def test_charge_requires_actual_counter_and_nullify_prevents_it(self):
        knight = self.put('0,0', 'knight', uid='knight')
        defender = self.put('1,0', 'pawn', 'black', 'enemy')
        self.cast('knight-charge', unitUid='knight')
        result = exchange(knight, defender, 1, self.config, self.ctx.data)
        self.assertTrue(result['countered']); self.assertGreater(result['second_damage'], 0)
        self.ctx.add_buff(knight, self.ctx.catalogue['queen-nullify'])
        result = exchange(knight, defender, 1, self.config, self.ctx.data)
        self.assertFalse(result['countered']); self.assertEqual(result['second_damage'], 0)

    async def test_charge_records_a_zero_damage_second_strike_on_field_and_panel_targets(self):
        for zone in ('field', 'panel'):
            with self.subTest(zone=zone):
                self.setUp()
                if zone == 'field':
                    target_key, source_key = '1,0', '0,0'
                    target = self.put(target_key, 'rook', 'black', 'enemy')
                    command = {'type': 'make_move', 'from': source_key, 'to': source_key, 'attack': target_key}
                else:
                    target_key = next(key for key in panels.panel_zones(11)['tl']
                        if any(panels.on_battlefield(q + dq, r + dr, 11)
                               for q, r in [panels.parse_key(key)] for dq, dr in HEX_DIRECTIONS.values()))
                    self.config['setup']['black'][target_key] = 'rook'
                    target = self.put(target_key, 'rook', 'black', f'b{target_key}')
                    self.state.board_state.pop(target_key)
                    self.state.move_history.append({'turn': 53, 'color': 'black', 'panelEffect': True,
                        'intoPanel': True, 'unit': target, 'panel': 'tl', 'defenderHp': target['hp']})
                    q, r = panels.parse_key(target_key)
                    source_key = next(f'{q + dq},{r + dr}' for dq, dr in HEX_DIRECTIONS.values()
                                      if panels.on_battlefield(q + dq, r + dr, 11))
                    command = {'type': 'panel_attack', 'from': source_key, 'to': source_key, 'attack': target_key}
                self.put(source_key, 'knight', uid='knight')
                self.ctx.add_buff(target, self.ctx.catalogue['fortress'], {'effect': 'invulnerable'})
                self.cast('knight-charge', unitUid='knight')
                state = await GameConsumer()._preview_turn(self.state, [command])
                record = next(move for move in state.move_history if move.get('attacked'))
                self.assertTrue(record['countered'])
                self.assertEqual(record['damage_dealt'], 0)
                self.assertGreater(record['counter_damage'], 0)
                self.assertTrue(record.get('secondStrike'))
                self.assertEqual(AbilityContext(state).find(target['uid'])[1]['hp'], target['hp'])

    async def test_combat_history_preserves_counter_appearance_when_either_actor_dies(self):
        for zone in ('field', 'panel'):
            for casualty in ('attacker', 'defender'):
                with self.subTest(zone=zone, casualty=casualty):
                    self.setUp()
                    if zone == 'field':
                        target_key, source_key = '1,0', '0,0'
                        target = self.put(target_key, 'pawn', 'black', 'enemy', hp=9 if casualty == 'defender' else 14)
                        command = {'type': 'make_move', 'from': source_key, 'to': source_key, 'attack': target_key}
                    else:
                        target_key = next(key for key in panels.panel_zones(11)['tl']
                            if any(panels.on_battlefield(q + dq, r + dr, 11)
                                   for q, r in [panels.parse_key(key)] for dq, dr in HEX_DIRECTIONS.values()))
                        self.config['setup']['black'][target_key] = 'pawn'
                        target = self.put(target_key, 'pawn', 'black', f'b{target_key}', hp=11 if casualty == 'defender' else 12)
                        self.state.board_state.pop(target_key)
                        self.state.move_history.append({'turn': 53, 'color': 'black', 'panelEffect': True,
                            'intoPanel': True, 'unit': target, 'panel': 'tl', 'defenderHp': target['hp']})
                        q, r = panels.parse_key(target_key)
                        source_key = next(f'{q + dq},{r + dr}' for dq, dr in HEX_DIRECTIONS.values()
                                          if panels.on_battlefield(q + dq, r + dr, 11))
                        command = {'type': 'panel_attack', 'from': source_key, 'to': source_key, 'attack': target_key}
                    self.put(source_key, 'knight', uid='actor', hp=1 if casualty == 'attacker' else 20)
                    if casualty == 'defender':
                        self.cast('knight-charge', unitUid='actor')
                    state = await GameConsumer()._preview_turn(self.state, [command])
                    record = next(move for move in state.move_history if move.get('attacked'))
                    self.assertTrue(record['countered'])
                    self.assertTrue(record[f'{casualty}_eliminated'])
                    self.assertEqual(record['counterActor'], {key: target[key] for key in ('unit_id', 'color', 'uid')})
                    self.assertEqual(target['hp'], (9 if zone == 'field' else 11) if casualty == 'defender' else (14 if zone == 'field' else 12))


    def test_rook_bog_stacks_after_exchange_and_cleave_spares_allies(self):
        rook = self.put('0,0', 'rook', uid='rook')
        defender = self.put('1,0', 'pawn', 'black', 'enemy')
        self.put('0,1', color='black', uid='splash')
        self.put('-1,0', uid='ally')
        self.cast('rook-cleave', unitUid='rook')
        result = exchange(rook, defender, 1, self.config, self.ctx.data)
        after_exchange(self.ctx, '0,0', '1,0', rook, defender, result)
        self.assertEqual(self.ctx.board['0,1']['hp'], 6)
        self.assertEqual(self.ctx.board['-1,0']['hp'], 14)
        self.assertEqual(self.ctx.data['buffs']['enemy']['atk'], -1)
        after_exchange(self.ctx, '0,0', '1,0', rook, defender, result)
        self.assertEqual(self.ctx.data['buffs']['enemy']['atk'], -2)

    def test_archer_bog_respects_configured_duration(self):
        self.put('0,0', 'archer', uid='archer')
        target = self.put('3,0', color='black', uid='enemy')
        self.config['abilities']['catalogue']['archer-bog']['turns'] = 3
        self.cast('archer-bog', unitUid='archer')
        result = exchange(self.ctx.board['0,0'], target, 3, self.config, self.ctx.data)
        after_exchange(self.ctx, '0,0', '3,0', self.ctx.board['0,0'], target, result)
        self.ctx.begin_turn('white', 57)
        self.assertEqual(self.ctx.data['buffs']['enemy']['mov'], -4)
        self.ctx.begin_turn('white', 61)
        self.assertNotIn('enemy', self.ctx.data['buffs'])

    def test_hop_crosses_multiple_enemies_but_never_lands_on_them(self):
        self.put('0,0', 'knight', uid='knight')
        for i in (1, 2): self.put(f'{i},0', color='black')
        board = HexBoard.from_dict(11, self.ctx.board)
        moves = get_legal_moves(board, (0, 0), self.config, 'white', ability_state=self.ctx.data)
        self.assertIn((3, 0), moves); self.assertNotIn((1, 0), moves); self.assertNotIn((2, 0), moves)

    def test_regenerate_and_adjacent_auras_have_correct_side_and_scope(self):
        self.put('0,0', 'bishop', uid='bishop', hp=1)
        _, reserve = self.panel('br', 'bishop', 'reserve', hp=1)
        _, base = self.panel('bl', 'bishop', 'base', hp=1)
        self.ctx.end_turn()
        self.assertEqual(self.ctx.board['0,0']['hp'], 10)
        self.assertEqual(self.ctx.find('reserve')[1]['hp'], 1)
        self.assertLess(self.ctx.find('base')[1]['hp'], 10)
        self.put('2,0', 'queen', uid='queen')
        self.put('3,0', color='black', uid='enemy')
        self.put('2,1', uid='ally')
        self.put('-2,0', 'king', uid='king')
        self.put('-3,0', uid='king-neighbor')
        self.ctx.begin_turn('white', 57)
        self.assertNotIn('enemy', self.ctx.data['buffs'])
        self.assertNotIn('king-neighbor', self.ctx.data['buffs'])
        self.assertEqual(self.ctx.data['buffs']['ally']['mov'], 1)

    def test_cast_preserves_king_owner_and_returns_at_casters_next_turn(self):
        self.put('7,0', 'bishop', uid='bishop')
        self.cast('bishop-cast', unitUid='bishop', targetUid='bk')
        self.assertEqual((self.ctx.board['8,0']['color'], self.ctx.board['8,0']['owner']), ('white', 'black'))
        self.assertEqual(defeated_sides(HexBoard.from_dict(11, self.ctx.board), self.config), [])
        self.ctx.begin_turn('black', 56)
        self.assertEqual(self.ctx.board['8,0']['color'], 'white')
        self.ctx.begin_turn('white', 57)
        self.assertEqual(self.ctx.board['8,0']['color'], 'black')
        self.ctx.board.pop('8,0')
        self.assertEqual(defeated_sides(HexBoard.from_dict(11, self.ctx.board), self.config), ['black'])

    def test_call_affects_adjacent_units_of_both_sides_but_not_its_king_or_distant_units(self):
        for color, sign, panel in (('white', 1, 'br'), ('black', -1, 'tl')):
            with self.subTest(color=color):
                self.setUp()
                self.ctx.color = color
                self.ctx.ply = self.state.turn_number = 55 if color == 'white' else 56
                enemy = 'black' if color == 'white' else 'white'
                source = f'{10 * sign},{sign}'
                self.ctx.board.pop('-8,0' if color == 'white' else '8,0')
                king = self.put(source, 'king', color, 'caster', hp=50)
                ally = self.put(f'{10 * sign},0', color=color, uid='ally', hp=10)
                foe = self.put(f'{9 * sign},{sign}', color=enemy, uid='enemy', hp=10)
                distant = self.put(f'{8 * sign},{sign}', color=color, uid='distant', hp=10)
                green = f'{11 * sign},{sign}'
                self.config['setup'][color][green] = 'pawn'
                panel_unit = {'unit_id': 'pawn', 'uid': color[0] + green, 'color': color, 'vet': 0, 'hp': 5, 'max_hp': 12}
                self.ctx.history.append({'turn': self.ctx.ply, 'color': color, 'panelEffect': True,
                    'intoPanel': True, 'unit': panel_unit, 'panel': panel, 'defenderHp': 5})
                before = unit_points_of(color, self.ctx.history, self.config)
                self.cast('king-call', unitUid='caster')
                self.assertEqual(self.ctx.board[source]['hp'], 50)
                self.assertEqual(self.ctx.board[f'{10 * sign},0']['hp'], 11)
                self.assertEqual(self.ctx.board[f'{9 * sign},{sign}']['hp'], 9)
                self.assertEqual(self.ctx.board[f'{8 * sign},{sign}']['hp'], 10)
                self.assertEqual(self.ctx.find(panel_unit['uid'])[1]['hp'], 6)
                self.assertEqual(set(self.ctx.data['buffs']), {'ally', 'enemy', panel_unit['uid']})
                for stat in ('atk', 'def', 'mov'):
                    self.assertEqual(self.ctx.data['buffs']['ally'][stat], 1)
                    self.assertEqual(self.ctx.data['buffs']['enemy'][stat], -1)
                self.assertEqual(unit_points_of(color, self.ctx.history, self.config), before - 4)
                self.assertEqual(self.ctx.data['unitCooldowns']['caster']['turns'], 1)
                self.ctx.begin_turn(enemy, self.ctx.ply + 1)
                self.assertIn('ally', self.ctx.data['buffs'])
                self.ctx.begin_turn(color, self.ctx.ply + 1)
                self.assertEqual(self.ctx.data['buffs'], {})
                self.assertNotIn('caster', self.ctx.data['unitCooldowns'])

    def test_legacy_call_heals_friends_and_damages_and_drains_enemies(self):
        entry = self.ctx.catalogue['king-call']
        entry.update(cost=20, cooldown=5, heal=2, atk=0, mov=0, enemyMov=0, enemyDef=-2, **{'def': 2})
        entry.pop('radius')
        self.put('0,0', uid='ally', hp=10)
        self.put('1,0', color='black', uid='enemy', hp=10)
        self.cast('king-call', unitUid='wk')
        self.assertEqual(self.ctx.board['0,0']['hp'], 12)
        self.assertEqual(self.ctx.board['1,0']['hp'], 9)
        self.assertEqual(self.ctx.data['buffs']['ally']['def'], 2)
        self.assertEqual(self.ctx.data['buffs']['enemy']['atk'], -1)
        self.assertEqual(self.ctx.data['buffs']['enemy']['def'], -2)

    def test_taunt_only_restricts_reachable_attack_targets(self):
        attacker = self.put('0,0', uid='attacker')
        self.put('1,0', 'shieldman', 'black', 'taunter')
        self.put('0,1', color='black', uid='other')
        self.ctx.add_buff(self.ctx.board['1,0'], self.ctx.catalogue['shield-taunt'])
        self.assertFalse(taunt_allows(self.ctx.board, '0,0', '0,1', self.config, self.ctx.data))
        self.assertTrue(taunt_allows(self.ctx.board, '0,0', '1,0', self.config, self.ctx.data))

    async def test_checkmate_is_immediate_for_combat_but_does_not_extend_a_walk_started_outside(self):
        for color, sign, player in (('white', -1, 'alice'), ('black', 1, 'bob')):
            with self.subTest(color=color):
                self.setUp()
                self.state.current_turn = player
                self.state.turn_number = self.ctx.ply = 55 if color == 'white' else 56
                start, edge, finish = f'0,{8 * sign}', f'0,{9 * sign}', f'0,{11 * sign}'
                self.put(start, uid='pawn', color=color, vet=2)
                self.put(f'1,{9 * sign}', 'shieldman', 'black' if color == 'white' else 'white', 'target')
                landed = await GameConsumer()._preview_turn(self.state, [
                    {'type': 'make_move', 'from': start, 'to': edge, 'more': True},
                    {'type': 'make_move', 'from': edge, 'to': edge, 'attack': f'1,{9 * sign}', 'more': True}])
                attack = next(m for m in landed.move_history if m.get('attacked'))
                self.assertEqual(attack['damage_dealt'], 1)  # 8 + 6 ATK versus 14 DEF; minimum damage
                with self.assertRaises(ValidationError):
                    await GameConsumer()._preview_turn(self.state, [
                        {'type': 'make_move', 'from': start, 'to': edge, 'more': True},
                        {'type': 'make_move', 'from': edge, 'to': f'7,{3 * sign}', 'more': True}])
                self.state.board_state.pop(start)
                pawn = self.put(edge, uid='pawn', color=color, vet=2)
                destinations = get_legal_moves(HexBoard.from_dict(11, self.state.board_state), panels.parse_key(edge), self.config, color,
                    ability_state=self.state.ability_state)
                self.assertIn((0, sign), destinations)
                self.assertNotIn((0, 0), destinations)
                departed = await GameConsumer()._preview_turn(self.state, [
                    {'type': 'make_move', 'from': edge, 'to': f'0,{3 * sign}', 'more': True},
                    {'type': 'make_move', 'from': f'0,{3 * sign}', 'to': f'0,{sign}', 'more': True}])
                self.assertEqual(departed.board_state[f'0,{sign}']['uid'], 'pawn')
                self.assertEqual(bonus(pawn, self.config, {}, 'atk', key='0,0'), 0)
                pawn['panel'] = 'br'
                self.assertEqual(bonus(pawn, self.config, {}, 'atk', key=edge), 0)

    async def test_quick_can_walk_after_a_ranged_attack_and_pawn_cannot(self):
        self.put('0,0', 'archer', uid='archer', vet=2)
        self.put('4,0', 'shieldman', 'black', 'enemy')
        result = await GameConsumer()._preview_turn(self.state, [
            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'attack': '4,0', 'more': True},
            {'type': 'make_move', 'from': '1,0', 'to': '2,0', 'more': True},
            {'type': 'pass_turn'}])
        self.assertEqual(result.board_state['2,0']['uid'], 'archer')
        self.assertEqual(board_moves_at(result.move_history, 55, 'white'), 1)
        self.state.board_state.pop('0,0')
        self.put('0,0', uid='pawn', vet=2)
        self.put('1,0', 'shieldman', 'black', 'target')
        with self.assertRaises(ValidationError):
            await GameConsumer()._preview_turn(self.state, [
                {'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '1,0', 'more': True},
                {'type': 'make_move', 'from': '0,0', 'to': '0,1', 'more': True}])

    async def test_intervening_strike_resolves_before_rapid_movement(self):
        self.config['units']['pawn']['passive'] = 'rapid-movement'
        self.put('0,0', uid='pawn')
        self.put('2,0', 'shieldman', 'black', 'enemy', hp=4)
        self.carry('mend', 'strike')
        result = await GameConsumer()._preview_turn(self.state, [
            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'attack': '2,0', 'more': True},
            {'type': 'cast_ability', 'id': 'strike', 'targetUid': 'enemy'},
            {'type': 'make_move', 'from': '1,0', 'to': '2,0', 'more': True},
            {'type': 'pass_turn'}])
        self.assertEqual(result.board_state['2,0']['uid'], 'pawn')
        self.assertEqual(result.turn_number, 56)
        self.assertEqual(board_moves_at(result.move_history, 55, 'white'), 1)
        self.assertEqual(self.state.turn_number, 55)
        self.assertIn('0,0', self.state.board_state)

    async def test_movement_steps_share_one_budget_and_cannot_reopen_an_attack(self):
        self.put('0,0', 'rook', uid='rook')
        with self.assertRaises(ValidationError):
            await GameConsumer()._preview_turn(self.state, [
                {'type': 'make_move', 'from': '0,0', 'to': '3,0', 'more': True},
                {'type': 'make_move', 'from': '3,0', 'to': '6,0', 'more': True}])
        self.assertIn('0,0', self.state.board_state)

    async def test_cast_extra_action_and_source_ends_action(self):
        self.put('0,0', 'bishop', uid='bishop')
        self.put('1,0', 'rook', 'black', 'enemy')
        commands = [{'type': 'cast_ability', 'id': 'bishop-cast', 'unitUid': 'bishop', 'targetUid': 'enemy'},
                    {'type': 'make_move', 'from': '1,0', 'to': '2,0', 'more': True}]
        result = await GameConsumer()._preview_turn(self.state, commands)
        self.assertEqual(result.board_state['2,0']['color'], 'white')
        self.assertEqual(result.turn_number, 56)
        with self.assertRaises(ValidationError):
            await GameConsumer()._preview_turn(self.state, commands + [
                {'type': 'make_move', 'from': '0,0', 'to': '-1,0'}])

    async def test_two_stationary_cast_sources_cannot_share_one_ordinary_action(self):
        self.put('0,0', 'bishop', uid='first')
        self.put('1,0', color='black', uid='enemy-first')
        self.put('3,0', 'bishop', uid='second')
        self.put('4,0', color='black', uid='enemy-second')
        with self.assertRaises(ValidationError):
            await GameConsumer()._preview_turn(self.state, [
                {'type': 'cast_ability', 'id': 'bishop-cast', 'unitUid': 'first', 'targetUid': 'enemy-first'},
                {'type': 'cast_ability', 'id': 'bishop-cast', 'unitUid': 'second', 'targetUid': 'enemy-second'}])

    async def test_trap_blocks_move_heal_and_unit_cast_but_not_pool_cast(self):
        bishop = self.put('0,0', 'bishop', uid='bishop')
        self.put('1,0', uid='ally', hp=1)
        self.ctx.add_buff(bishop, self.ctx.catalogue['surge'], {'effect': 'action-lock'}, True)
        for command in [
            {'type': 'make_move', 'from': '0,0', 'to': '0,0', 'heal': '1,0'},
            {'type': 'make_move', 'from': '0,0', 'to': '-1,0'},
            {'type': 'cast_ability', 'id': 'bishop-cast', 'unitUid': 'bishop', 'targetUid': 'bk'}]:
            with self.subTest(command=command), self.assertRaises(ValidationError):
                await GameConsumer()._preview_turn(self.state, [command])
        self.carry('mend')
        result = await GameConsumer()._preview_turn(self.state, [{'type': 'cast_ability', 'id': 'mend', 'targetUid': 'ally'}])
        self.assertEqual(result.board_state['1,0']['hp'], 3)


class OnlineAbilityDraftTests(TransactionTestCase):
    def setUp(self):
        draft_tests.TurnDraftTests.setUp(self)
        self.state.ability_state = initial_state()
        self.state.config_snapshot['rules'].update(cpAtStart=100, upAtStart=100)
        self.state.config_snapshot['setup'] = {'white': {}, 'black': {}}
        self.state.ability_state['pointDelta']['white'] = 100
        self.state.board_state['0,0'].update(vet=2, hp=14, max_hp=14)
        self.state.board_state['2,0'] = {'unit_id': 'pawn', 'uid': 'bp', 'color': 'black',
                                        'vet': 2, 'hp': 14, 'max_hp': 14}
        self.state.save()

    request = draft_tests.TurnDraftTests.request

    async def commit(self, commands):
        await self.consumer._handle_save_turn_draft(self.request(commands, kind='commit_turn'))
        return await GameState.objects.aget(pk=self.game.game_id)

    async def test_direct_and_timeout_passes_publish_the_advanced_ability_state(self):
        for timed_out in (False, True):
            with self.subTest(timed_out=timed_out):
                data = initial_state()
                data['cooldowns']['black']['sap'] = 3
                data['buffs']['wp'] = {'mov': -2, 'atk': 0, 'def': 0, 'hel': 0,
                    'effects': [{'name': 'Mire', 'caster': 'black', 'expiresAt': 8, 'mov': -2}]}
                await GameState.objects.filter(pk=self.game.game_id).aupdate(
                    ability_state=data, turn_number=7, current_turn='alice', revision=1)
                self.messages.clear()
                if timed_out:
                    await self.consumer._start_turn_timer(self.game.game_id, 1, 7, 'alice',
                        turn_started_at=timezone.now() - timedelta(seconds=2))
                    await asyncio.wait_for(_pending_turn_timers[self.game.game_id], 2)
                else:
                    await self.consumer._handle_pass_turn({})
                state = await GameState.objects.aget(pk=self.game.game_id)
                message = next(m for m in self.messages if m.get('type') == 'turn_passed')
                self.assertEqual((state.turn_number, state.revision), (8, 2))
                self.assertEqual(state.ability_state['cooldowns']['black']['sap'], 2)
                self.assertNotIn('wp', state.ability_state['buffs'])
                self.assertEqual(message.get('abilityState'), state.ability_state)
                self.assertTrue(message.get('abilitiesSupported'))

    async def test_capture_is_banked_authoritatively_at_postmatch_and_queen_persuades_on_turn_start(self):
        config = copy.deepcopy(self.state.config_snapshot)
        board = {'2,0': dict(unit_id='king', uid='wk', color='white', vet=2, hp=60, max_hp=60),
                 '8,-3': dict(unit_id='king', uid='bk', color='black', vet=2, hp=60, max_hp=60),
                 '0,0': dict(unit_id='rook', uid='br', color='black', vet=2, hp=24, max_hp=24),
                 '5,3': dict(unit_id='queen', uid='wq', color='white', vet=2, hp=34, max_hp=34),
                 '5,4': dict(unit_id='pawn', uid='ally', color='white', vet=2, hp=14, max_hp=14),
                 '6,3': dict(unit_id='pawn', uid='enemy', color='black', vet=2, hp=14, max_hp=14)}
        await GameState.objects.filter(pk=self.game.game_id).aupdate(
            config_snapshot=config, board_state=board, turn_number=48, current_turn='bob',
            phase_bank={'1': {'white': 1, 'black': 1}})
        self.consumer.username = 'bob'
        request = self.request([{'type': 'pass_turn'}], kind='commit_turn')
        request['turnNumber'] = 48
        await self.consumer._handle_save_turn_draft(request)
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual(state.phase_bank['2'], {'white': 72, 'black': 4})
        self.assertEqual(state.board_state['2,0']['vet'], 3)
        self.assertEqual(state.ability_state['buffs']['ally']['atk'], 1)
        self.assertNotIn('enemy', state.ability_state['buffs'])
        self.assertEqual(self.messages[-1]['phaseBank'], state.phase_bank)
        self.assertEqual(self.messages[-1]['abilityState'], state.ability_state)

    async def test_semantic_cast_then_attack_uses_server_damage_and_one_write(self):
        state = await self.commit([
            {'type': 'pick_pair', 'id': 'warcry'},
            {'type': 'cast_ability', 'id': 'warcry', 'targetUid': 'wp', 'cost': -999,
             'bonuses': {'atk': 999}, 'effects': [{'at': '2,0', 'hp': 0}]},
            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'attack': '2,0', 'more': True},
            {'type': 'pass_turn'}])
        self.assertEqual((state.turn_number, state.revision), (8, 2))
        self.assertEqual(state.board_state['2,0']['hp'], 4)
        self.assertEqual(state.ability_state['pointDelta']['white'], 75)
        self.assertEqual(state.ability_state['cooldowns']['white']['warcry'], 3)
        self.assertEqual(state.ability_state['loadouts']['white'], ['warcry', 'sap'])
        self.assertEqual(self.messages[-1]['abilityState'], state.ability_state)
        self.assertTrue(self.messages[-1]['abilitiesSupported'])

    async def test_private_draft_restores_choices_and_casts_without_committing_resources(self):
        commands = [{'type': 'pick_path', 'id': 'bastion'}, {'type': 'cast_ability', 'id': 'anchor', 'hex': '2,0'}]
        await self.consumer._handle_save_turn_draft(self.request(commands))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertIsNone(state.ability_state['paths']['white'])
        self.assertEqual(state.ability_state['cpSpent']['white'], 0)
        await self.consumer._handle_request_game_state({})
        self.assertEqual(self.messages[-1]['turnDraft']['commands'], commands)
        self.consumer.username = 'bob'
        await self.consumer._handle_request_game_state({})
        self.assertNotIn('turnDraft', self.messages[-1])

    async def test_illegal_later_cast_rolls_back_earlier_move_and_path_purchase(self):
        with self.assertRaises(ValidationError):
            await self.commit([{'type': 'pick_path', 'id': 'bastion'},
                {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'more': True},
                {'type': 'cast_ability', 'id': 'blitz'}])
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual(state.revision, 1)
        self.assertIn('0,0', state.board_state)
        self.assertEqual(state.ability_state['cpSpent']['white'], 0)
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())

    async def test_saved_ability_turn_timeout_commits_once_and_preserves_cooldown(self):
        commands = [{'type': 'pick_path', 'id': 'bastion'}, {'type': 'cast_ability', 'id': 'convert'}]
        await self.consumer._handle_save_turn_draft(self.request(commands))
        draft = await TurnDraft.objects.aget(pk=self.game.game_id)
        self.assertTrue(await self.consumer._commit_saved_draft(self.state, draft, True))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.revision), (8, 2))
        self.assertEqual(state.ability_state['cpSpent']['white'], 35)
        self.assertEqual(state.ability_state['pointDelta']['white'], 150)
        self.assertEqual(state.ability_state['cooldowns']['white']['convert'], 1)
        self.assertTrue(self.messages[-1]['timedOut'])
        self.assertIsNone(await self.consumer._commit_saved_draft(self.state, draft, True))
        self.assertEqual((await GameState.objects.aget(pk=self.game.game_id)).ability_state['pointDelta']['white'], 150)

    async def test_opponent_cannot_spend_casters_path_or_carried_ability(self):
        self.state.ability_state['loadouts']['white'] = ['warcry', 'sap']
        self.state.ability_state['paths']['white'] = 'bastion'
        self.state.ability_state['pointDelta']['black'] = 100
        self.state.turn_number = 8; self.state.current_turn = 'bob'; await self.state.asave()
        self.consumer.username = 'bob'
        for ability in ['warcry', 'convert', 'anchor', 'fortress']:
            with self.subTest(ability=ability), self.assertRaises(ValidationError):
                await self.consumer._handle_save_turn_draft(dict(self.request([
                    {'type': 'cast_ability', 'id': ability, 'targetUid': 'bp', 'hex': '0,0'}]), turnNumber=8))
        self.assertEqual((await GameState.objects.aget(pk=self.game.game_id)).revision, 1)

    async def test_dead_king_from_strike_finishes_atomic_turn_and_keeps_final_history(self):
        self.state.board_state['8,0']['hp'] = 3
        self.state.ability_state['loadouts']['white'] = ['mend', 'strike']; await self.state.asave()
        state = await self.commit([{'type': 'cast_ability', 'id': 'strike', 'targetUid': 'bk'}, {'type': 'pass_turn'}])
        self.assertEqual((state.winner, state.end_reason), ('alice', 'regicide'))
        self.assertEqual(self.messages[-2]['committedTurn'], 7)
        self.assertTrue(any(m.get('abilityCast', {}).get('id') == 'strike' for m in self.messages[-2]['moveHistory']))

    async def test_pre_migration_match_initializes_kits_before_its_first_batched_move(self):
        self.state.config_snapshot['units']['pawn']['passive'] = 'rapid-movement'
        self.state.ability_state = {}; await self.state.asave()
        state = await self.commit([
            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'attack': '2,0', 'more': True},
            {'type': 'make_move', 'from': '1,0', 'to': '1,-1', 'more': True}])
        self.assertEqual(state.ability_state['version'], 1)
        self.assertEqual(state.board_state['1,-1']['uid'], 'wp')
        self.assertEqual(board_moves_at(state.move_history, 7, 'white'), 1)

    async def test_undo_draft_to_empty_does_not_purchase_or_cast_at_timeout(self):
        await self.consumer._handle_save_turn_draft(self.request([
            {'type': 'pick_path', 'id': 'onslaught'}, {'type': 'cast_ability', 'id': 'cleave', 'hex': '2,0'}]))
        await self.consumer._handle_save_turn_draft(self.request([], sequence=2))
        draft = await TurnDraft.objects.aget(pk=self.game.game_id)
        self.assertTrue(await self.consumer._commit_saved_draft(self.state, draft, True))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual(state.board_state['2,0']['hp'], 14)
        self.assertIsNone(state.ability_state['paths']['white'])
        self.assertEqual(state.ability_state['cpSpent']['white'], 0)


class OnlineAbilityPanelTests(SimpleTestCase):
    setUp = OnlineAbilityRulesTests.setUp
    put = OnlineAbilityRulesTests.put
    async def test_controlled_reserve_uses_physical_gateway_and_keeps_owner_on_entry(self):
        self.state.turn_number = self.ctx.ply = 27
        self.config['setup']['black']['-3,-9'] = 'rook'
        self.put('-2,-9', 'bishop', uid='bishop')
        result = await GameConsumer()._preview_turn(self.state, [
            {'type': 'cast_ability', 'id': 'bishop-cast', 'unitUid': 'bishop', 'targetUid': 'b-3,-9'},
            {'type': 'enter_board', 'from': '-3,-9', 'to': '-1,-10'}, {'type': 'pass_turn'}])
        self.assertEqual(result.board_state['-1,-10']['color'], 'white')
        self.assertEqual(result.board_state['-1,-10']['owner'], 'black')
        self.assertEqual(result.turn_number, 28)

    async def test_withdrawal_commits_wound_adjusted_refund_before_base_healing(self):
        self.state.turn_number = self.ctx.ply = 27
        self.put('-11,9', 'pawn', uid='wounded', hp=9)
        result = await GameConsumer()._preview_turn(self.state, [
            {'type': 'make_move', 'from': '-11,9', 'to': '-12,9', 'withdraw': True, 'more': True},
            {'type': 'pass_turn'}])
        record = next(move for move in result.move_history if move.get('withdrawn'))
        self.assertEqual((record['unit']['hp'], record['unit']['max_hp']), (9, 12))
        self.assertEqual(unit_points_of('white', result.move_history, self.config), 1006)
        standing = panels.panel_occupancy(self.config, 11, result.move_history, ply=28, ability_state=result.ability_state)
        self.assertGreaterEqual(standing['-12,9']['hp'], 9)
        self.assertEqual(unit_points_of('white', result.move_history, self.config), 1006)

    async def test_controlled_withdrawal_refunds_original_owner_and_returns_in_place(self):
        self.state.turn_number = self.ctx.ply = 27
        self.put('-10,9', 'bishop', uid='bishop')
        self.put('-11,9', 'rook', 'black', 'enemy')
        before_black = unit_points_of('black', self.ctx.history, self.config)
        result = await GameConsumer()._preview_turn(self.state, [
            {'type': 'cast_ability', 'id': 'bishop-cast', 'unitUid': 'bishop', 'targetUid': 'enemy'},
            {'type': 'make_move', 'from': '-11,9', 'to': '-12,9', 'withdraw': True, 'more': True},
            {'type': 'pass_turn'}])
        self.assertNotIn('-11,9', result.board_state)
        self.assertEqual(unit_points_of('black', result.move_history, self.config), before_black + self.config['units']['rook']['value'] - 1)
        self.assertEqual(unit_points_of('white', result.move_history, self.config), 1000 - self.config['abilities']['catalogue']['bishop-cast']['cost'])
        at_home = panels.panel_occupancy(self.config, 11, result.move_history, ply=28, ability_state=result.ability_state)
        self.assertEqual(at_home['-12,9']['color'], 'white')
        result.current_turn = 'bob'
        returned = await GameConsumer()._preview_turn(result, [{'type': 'pass_turn'}])
        at_home = panels.panel_occupancy(self.config, 11, returned.move_history, ply=29, ability_state=returned.ability_state)
        self.assertEqual((at_home['-12,9']['color'], at_home['-12,9']['owner']), ('black', 'black'))


    def test_foreign_reserve_does_not_spend_own_reserve_mover_cap(self):
        unit = self.put('0,0', uid='own-reserve')
        unit['panel'] = 'br'
        history = [{'turn': 55, 'color': 'white', 'panelMove': True, 'panel': 'tl',
                    'unit': {'uid': str(i), 'color': 'white'}, 'cost': 1} for i in range(3)]
        self.assertIsNone(panels.panel_allowance(self.config, history, unit, 55, self.state.ability_state))
        for move in history: move['panel'] = 'br'
        self.assertIsNone(panels.panel_allowance(self.config, history, unit, 55, self.state.ability_state))


    def test_legacy_entry_records_count_the_physical_reserve_cap(self):
        unit = self.put('0,0', uid='reserved'); unit['panel'] = 'tl'
        history = [{'turn': 55, 'color': 'white', 'entered': True, 'from': '-3,-9',
                    'unit': {'uid': str(i), 'color': 'white'}} for i in range(3)]
        self.assertIsNone(panels.panel_allowance(self.config, history, unit, 55, self.state.ability_state))
        unit['panel'] = 'br'
        self.assertIsNone(panels.panel_allowance(self.config, history, unit, 55, self.state.ability_state))

    def test_cast_extra_reserve_action_does_not_spend_the_ordinary_category_slot(self):
        unit = dict(unit_id='pawn', color='white', panel='tl', uid='controlled', vet=2)
        self.state.ability_state['extraUnits']['controlled'] = 55
        history = [dict(turn=55, panelMove=True, panel='br', unit={**unit, 'uid': 'ordinary'}, cost=0)]
        self.assertEqual(panels.panel_allowance(self.config, history, unit, 55, self.state.ability_state), 6)
        history[0]['unit']['uid'] = 'controlled'
        self.assertEqual(panels.panel_allowance(self.config, history, {**unit, 'uid': 'ordinary'}, 55, self.state.ability_state), 6)


class PanelCoordinateRegressionTests(SimpleTestCase):
    setUp = OnlineAbilityRulesTests.setUp
    put = OnlineAbilityRulesTests.put

    async def test_panel_walk_and_entry_aliases_record_the_same_costs_and_positions(self):
        self.state.turn_number = 27
        for kind, source, destination in [('panel_move', '-12,9', '-12,10'),
                                           ('panel_move', '3,9', '4,9'),
                                           ('enter_board', '3,9', '1,10')]:
            with self.subTest(kind=kind, source=source):
                self.config['setup']['white'] = {source: 'pawn'}
                canonical = {'type': kind, 'from': source, 'to': destination}
                expected = await GameConsumer()._preview_turn(self.state, [canonical])
                alias = lambda key: ','.join(f'{int(n):+04d}' for n in key.split(','))
                actual = await GameConsumer()._preview_turn(self.state, [
                    {**canonical, 'from': alias(source), 'to': alias(destination)}])
                self.assertEqual(actual.board_state, expected.board_state)
                self.assertEqual(actual.move_history, expected.move_history)
                self.assertEqual(actual.turn_number, expected.turn_number)

    async def test_panel_actions_report_malformed_coordinates_without_mutating_staging(self):
        self.state.turn_number = 27
        self.config['setup']['white'] = {'3,9': 'pawn'}
        before = copy.deepcopy(self.state)
        for kind in ('panel_move', 'enter_board'):
            for field in ('from', 'to'):
                with self.subTest(kind=kind, field=field):
                    command = {'type': kind, 'from': '3,9', 'to': '4,9'}
                    command[field] = {'q': 3, 'r': 9}
                    with self.assertRaisesRegex(ValidationError, 'Malformed'):
                        await GameConsumer()._preview_turn(self.state, [command])
                    self.assertEqual(self.state.move_history, before.move_history)
                    self.assertEqual(self.state.board_state, before.board_state)

    def test_saved_draft_coordinates_are_canonical_before_browser_restoration(self):
        commands = [
            {'type': 'panel_move', 'from': '+003,+009', 'to': '+004,+009'},
            {'type': 'enter_board', 'from': '+003,+009', 'to': '+001,+010'},
            {'type': 'make_move', 'from': '+000,+000', 'to': '+001,+000', 'attack': '+002,+000'},
            {'type': 'cast_ability', 'id': 'anchor', 'hex': '+003,+009'},
        ]
        clean = GameConsumer._draft_commands(commands)
        self.assertEqual(clean, [
            {'type': 'panel_move', 'from': '3,9', 'to': '4,9'},
            {'type': 'enter_board', 'from': '3,9', 'to': '1,10'},
            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'attack': '2,0'},
            {'type': 'cast_ability', 'id': 'anchor', 'hex': '3,9'},
        ])
        self.assertEqual(commands[0]['from'], '+003,+009')
