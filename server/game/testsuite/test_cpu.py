import copy
import json
import os
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from game import cpu

from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase

from game.cpu import CpuConsumer, analyse, candidate_commands, position_value, search_turn, movement_priority
from game.consumers import GameConsumer
from game.engine.ability_rules import initial_state
from game.engine.config_loader import DEFAULT_CONFIG, build_initial_board, load_config
from game.engine.unit_stats import ranked_unit
from game.models import GameState
from game.validators import ValidationError


class CpuTests(SimpleTestCase):
    def state(self):
        config = load_config(json.loads((Path(__file__).resolve().parents[3] / 'shared' / 'testing' / 'balance-config.json').read_text(encoding='utf-8')))
        config['setup'] = {'white': {'-5,0': 'king', '0,0': 'queen'}, 'black': {'1,0': 'king'}}
        return GameState(game_id='cpu-test', config_snapshot=config, board_state=build_initial_board(config).to_dict(),
            player_white='white', player_black='black', current_turn='white', turn_number=55, revision=1,
            move_history=[], phase_bank={'1': {'white': 1, 'black': 1}, '2': {'white': 1, 'black': 1}}, ability_state=initial_state())

    async def test_takes_a_winning_attack_and_uses_the_real_engine(self):
        state = self.state()
        state.board_state['1,0']['hp'] = 1
        commands = await search_turn(state, 'normal', 0.7)
        after = await GameConsumer()._preview_turn(state, commands)
        self.assertEqual(after.winner, 'white')
        self.assertEqual(state.board_state['1,0']['hp'], 1)
        self.assertEqual(state.move_history, [])

    async def test_retreats_a_wounded_commander_instead_of_chasing_capture_points(self):
        state = self.state()
        state.board_state = {
            '0,0': {'unit_id': 'king', 'color': 'white', 'uid': 'w-king', 'hp': 1, 'max_hp': 60, 'vet': 0},
            '3,0': {'unit_id': 'queen', 'color': 'black', 'uid': 'b-queen', 'hp': 32, 'max_hp': 32, 'vet': 0},
            '6,0': {'unit_id': 'king', 'color': 'black', 'uid': 'b-king', 'hp': 60, 'max_hp': 60, 'vet': 0},
        }
        for index in range(4):
            state.board_state[f'{index},2'] = {'unit_id': 'pawn', 'color': 'white', 'uid': f'p{index}', 'hp': 12, 'max_hp': 12, 'vet': 0}
        state.board_state = {key: ranked_unit(unit, state.config_snapshot, 3) for key, unit in state.board_state.items()}
        # Tactical quality gets CPU time; unrelated host load must not spend its budget.
        with patch.object(cpu, 'time', SimpleNamespace(monotonic=time.process_time)):
            commands = await search_turn(state, 'normal', 2)
            self.assertTrue(any(command.get('from') == '0,0' and command.get('to') != '0,0' for command in commands))
            after = await GameConsumer()._preview_turn(state, commands)
            enemy = await search_turn(after, 'easy', 0.5)
            reply = await GameConsumer()._preview_turn(after, enemy)
            self.assertNotEqual(reply.winner, 'black')

    async def test_numeric_attack_changes_change_the_best_action(self):
        state = self.state()
        state.config_snapshot['units']['queen']['attack'] = [0, 0]
        state.config_snapshot['units']['king']['attack'] = [0]
        state.board_state['1,0']['hp'] = 1
        commands = await search_turn(state, 'easy', 0.3)
        self.assertFalse(any(c.get('attack') for c in commands))
        state.config_snapshot['units']['queen']['attack'] = [99, 99]
        commands = await search_turn(state, 'easy', 0.3)
        after = await GameConsumer()._preview_turn(state, commands)
        self.assertEqual(after.winner, 'white')

    async def test_both_colors_generate_legal_turns(self):
        for side in ('white', 'black'):
            state = self.state()
            state.current_turn = side
            state.turn_number = 55 if side == 'white' else 56
            commands = await search_turn(state, 'easy', 0.2)
            after = await GameConsumer()._preview_turn(state, commands)
            self.assertTrue(after.is_finished or after.turn_number == state.turn_number + 1)

    async def test_partial_preview_does_not_advance_the_turn(self):
        state = self.state()
        after = await GameConsumer()._preview_turn(state, [{'type': 'make_move', 'from': '0,0', 'to': '0,1', 'more': True}], finish=False)
        self.assertEqual(after.turn_number, 55)
        self.assertIn('0,1', after.board_state)
        self.assertIn('0,0', state.board_state)

    async def test_completed_history_reconstructs_and_cache_survives_branches(self):
        request = {'config': copy.deepcopy(DEFAULT_CONFIG), 'actions': [], 'ply': 1, 'color': 'white', 'difficulty': 'easy', 'budget': 0.01}
        _, cached = await analyse(request)
        request['actions'] = [{'ply': 1, 'color': 'white', 'command': {'type': 'pass_turn'}}]
        request.update(ply=2, color='black')
        _, second = await analyse(request, cached)
        self.assertEqual(second['state'].turn_number, 2)
        request['actions'] = []
        request.update(ply=1, color='white')
        _, rewind = await analyse(request, second)
        self.assertEqual(rewind['state'].turn_number, 1)

    async def test_corrupt_or_incomplete_recording_is_rejected(self):
        base = {'config': copy.deepcopy(DEFAULT_CONFIG), 'actions': [], 'ply': 1, 'color': 'white', 'difficulty': 'easy', 'budget': 0.01}
        for command in ({'type': 'make_move', 'from': '0,0', 'to': '500,0'}, {'type': 'pass_turn', 'damage': 99}, {'type': 'result'}):
            with self.assertRaises((ValueError, ValidationError)):
                await analyse({**base, 'actions': [{'ply': 1, 'color': 'white', 'command': command}]})

    def test_all_carried_pool_path_and_unit_casts_have_candidates(self):
        state = self.state()
        state.config_snapshot['match']['cpAtStart'] = 1000
        state.config_snapshot['economy']['upAtStart'] = 1000
        state.ability_state['pointDelta']['white'] = 1000
        state.ability_state['loadouts']['white'] = ['warcry', 'sap', 'mend', 'strike']
        state.ability_state['paths']['white'] = 'bastion'
        unit = state.board_state['0,0']
        state.board_state['0,0'] = ranked_unit(unit, state.config_snapshot, 3)
        import time
        commands = list(candidate_commands(state, time.monotonic() + 2))
        ids = {c.get('id') for c in commands}
        self.assertTrue({'warcry', 'sap', 'mend', 'strike', 'queen-leech'} <= ids)
        path = next(p for p in state.config_snapshot['abilities']['paths'] if p['id'] == 'bastion')
        self.assertTrue({path['utility'], path['skill'], path['ultimate']} <= ids)

    def test_withdrawal_order_uses_configured_refunds_including_zero_and_wounds(self):
        import time
        for rank, multiplier, fee, missing, override, expected in ((0, 3, 4, 4, None, 132), (3, 0, 0, 0, None, 0), (3, 1, 30, 4, None, 10), (3, 3, 0, 0, 0, 0)):
            with self.subTest(rank=rank, refund=expected):
                state = self.state()
                unit = state.board_state['0,0']
                unit.update(vet=rank, hp=32 - missing, max_hp=32)
                settings = state.config_snapshot['economy']['walkHomeRefund']
                settings.update(minimum=0, valueMultiplier=multiplier, fee=fee, missingHpMultiplier=2)
                settings['veterancy'] = [dict(valueMultiplier=multiplier, fee=fee, missingHpMultiplier=2) for _ in range(3)]
                if override is not None:
                    state.config_snapshot['economy']['unitValues'] = {'queen': {'withdrawal': override}}
                self.assertEqual(cpu.withdrawal_refund(state.config_snapshot, unit), expected)
                with patch.object(cpu, 'is_homecoming_open', return_value=True), patch.object(cpu.panels, 'homecoming_targets', return_value={'-10,9'}), patch.object(cpu, 'movement_priority', return_value=20):
                    commands = [c for c in candidate_commands(state, time.monotonic() + 2)
                                if c.get('from') == '0,0' and c.get('to') != '0,0'
                                and not c.get('attack') and not c.get('heal')]
                self.assertTrue(any(c.get('withdraw') for c in commands))
                self.assertTrue(any(not c.get('withdraw') for c in commands))
                self.assertEqual(bool(commands[0].get('withdraw')), expected > 20)

    async def test_search_shortlist_retains_configured_withdrawal_priority(self):
        state = self.state()
        state.config_snapshot['economy']['walkHomeRefund'].update(valueMultiplier=3, fee=0, missingHpMultiplier=0)
        walk = {'type': 'make_move', 'from': '0,0', 'to': '0,1', 'more': True}
        withdraw = {'type': 'make_move', 'from': '0,0', 'to': '-10,9', 'withdraw': True, 'more': True}
        tuning = cpu.load_cpu_tuning()
        tuning['limits']['maxSteps'] = 1
        preview = AsyncMock(return_value=state)
        with patch.object(cpu, 'TUNING', tuning), patch.object(cpu.GameConsumer, '_preview_turn', preview), patch.object(cpu, 'position_value', return_value=0), patch.object(cpu, 'movement_priority', return_value=0), patch.object(cpu, 'candidate_commands', return_value=(walk, withdraw)), patch.object(cpu.time, 'monotonic', return_value=0):
            await search_turn(state, 'easy')
        first_action = next(call.args[1][0] for call in preview.await_args_list if call.args[1])
        self.assertEqual(first_action, withdraw)

    def test_cpu_tuning_file_controls_weights_and_profiles_with_environment_precedence(self):
        tuning = cpu.load_cpu_tuning()
        state = self.state()
        state.phase_bank['1'] = {'white': 4, 'black': 1}
        with patch.object(cpu, 'TUNING', tuning):
            before = position_value(state, 'white')
            tuning['position']['bankPoints'] += 6
            self.assertAlmostEqual(position_value(state, 'white') - before, 18)
            move_before = movement_priority('0,0', state.board_state['0,0'], state, state.board_state)
            tuning['movement']['attackTarget'] += 7
            self.assertAlmostEqual(movement_priority('0,0', state.board_state['0,0'], state, state.board_state) - move_before, 7)
        tuning['profiles']['normal'] = {'seconds': 1.25, 'beam': 7, 'depth': 1}
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cpu.cpu_profiles(tuning)['normal'], (1.25, 7, 1))
            with patch.dict(os.environ, {'CPP_CPU_NORMAL_SECONDS': '3', 'CPP_CPU_NORMAL_BEAM': '12', 'CPP_CPU_NORMAL_DEPTH': '3'}):
                self.assertEqual(cpu.cpu_profiles(tuning)['normal'], (3, 12, 3))
            with patch.dict(os.environ, {'CPP_CPU_NORMAL_SECONDS': '100', 'CPP_CPU_NORMAL_BEAM': '999', 'CPP_CPU_NORMAL_DEPTH': '99'}):
                self.assertEqual(cpu.cpu_profiles(tuning)['normal'], (5, 64, 4))
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'cpu-tuning.json'
            path.write_text(json.dumps(tuning), encoding='utf-8')
            self.assertEqual(cpu.load_cpu_tuning(path), tuning)
            tuning['position']['bankPoints'] = float('nan')
            path.write_text(json.dumps(tuning), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'finite'):
                cpu.load_cpu_tuning(path)

    def test_cpu_tuning_rejects_missing_and_unknown_fields_before_search(self):
        fields = [((), 'position'), (('profiles',), 'normal'), (('profiles', 'normal'), 'seconds'),
                  (('position',), 'attack'), (('movement',), 'attackTarget'),
                  (('candidate',), 'attackDamage'), (('limits',), 'maxSteps'), (('search',), 'replySeconds')]
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'cpu-tuning.json'
            for parts, key in fields:
                for edit in ('missing', 'unknown', 'renamed'):
                    with self.subTest(group=parts, key=key, edit=edit):
                        tuning = cpu.load_cpu_tuning()
                        node = tuning
                        for part in parts:
                            node = node[part]
                        value = node[key]
                        if edit != 'unknown':
                            del node[key]
                        if edit != 'missing':
                            node[key + 'Typo'] = value
                        path.write_text(json.dumps(tuning), encoding='utf-8')
                        with self.assertRaises(ValueError) as failure:
                            cpu.load_cpu_tuning(path)
                        error = str(failure.exception)
                        self.assertIn('CPU tuning ' + ('.'.join(parts) or 'config'), error)
                        if edit != 'unknown':
                            self.assertIn('missing keys: ' + key, error)
                        if edit != 'missing':
                            self.assertIn('unknown keys: ' + key + 'Typo', error)

    async def test_profile_depth_overrides_do_not_recursively_reuse_the_easy_profile(self):
        state = self.state()
        preview = AsyncMock(return_value=state)
        with patch.object(cpu, 'PROFILES', {'easy': (0.5, 8, 3), 'normal': (2, 16, 4)}), patch.object(cpu.GameConsumer, '_preview_turn', preview), patch.object(cpu, 'position_value', return_value=0), patch.object(cpu, 'candidate_commands', return_value=()), patch.object(cpu.time, 'monotonic', return_value=0):
            self.assertEqual(await search_turn(state, 'normal'), [{'type': 'pass_turn'}])
        self.assertLess(preview.await_count, 20)

    def test_cpu_candidate_target_limit_is_configurable(self):
        import time
        state = self.state()
        state.config_snapshot['economy']['upAtStart'] = 1000
        state.ability_state['loadouts']['white'] = ['mend', 'strike']
        for index in range(4):
            state.board_state[f'{index},2'] = {'unit_id': 'pawn', 'color': 'white', 'uid': f'p{index}', 'hp': 1, 'max_hp': 12, 'vet': 0}
        tuning = cpu.load_cpu_tuning()
        tuning['limits']['abilityTargets'] = 1
        with patch.object(cpu, 'TUNING', tuning):
            commands = list(candidate_commands(state, time.monotonic() + 2))
        self.assertEqual(len([c for c in commands if c.get('id') == 'mend']), 1)

    def test_large_configured_prices_never_outweigh_a_completed_win(self):
        state = self.state()
        state.config_snapshot['units']['queen']['value'] = 10 ** 12
        ongoing = position_value(state, 'white')
        self.assertGreater(ongoing, 10 ** 9)
        state.end_reason = 'regicide'
        state.winner = 'white'
        self.assertGreater(position_value(state, 'white'), ongoing)
        state.winner = 'black'
        self.assertLess(position_value(state, 'white'), -abs(ongoing))

    def test_pending_phase_loss_outweighs_material(self):
        state = self.state()
        before = position_value(state, 'white')
        state.phase_bank['1']['pendingLoss'] = 'white'
        self.assertLess(position_value(state, 'white'), before - 900000)

    async def test_opaque_unit_ids_remain_playable(self):
        state = self.state()
        state.config_snapshot['units']['custom-unit'] = state.config_snapshot['units'].pop('queen')
        state.config_snapshot['setup']['white']['0,0'] = 'custom-unit'
        state.board_state['0,0']['unit_id'] = 'custom-unit'
        state.board_state['1,0']['hp'] = 1
        commands = await search_turn(state, 'normal', 0.4)
        after = await GameConsumer()._preview_turn(state, commands)
        self.assertEqual(after.winner, 'white')

    async def test_cast_filters_range_before_limiting_preferred_targets(self):
        import time
        state = self.state()
        state.config_snapshot['economy']['upAtStart'] = 1000
        def unit(kind, color, uid):
            definition = state.config_snapshot['units'][kind]
            return ranked_unit({'unit_id': kind, 'color': color, 'uid': uid,
                'hp': definition['hp'], 'max_hp': definition['hp'], 'vet': 0}, state.config_snapshot, 3)
        state.board_state = {'0,0': unit('bishop', 'white', 'bishop'),
            '-8,0': unit('king', 'white', 'wk'), '1,0': unit('pawn', 'black', 'adjacent'),
            '8,0': unit('king', 'black', 'bk'), '7,0': unit('queen', 'black', 'queen'),
            '6,0': unit('rook', 'black', 'rook')}
        casts = [command for command in candidate_commands(state, time.monotonic() + 2)
                 if command.get('id') == 'bishop-cast']
        self.assertEqual(casts, [{'type': 'cast_ability', 'id': 'bishop-cast',
                                 'unitUid': 'bishop', 'targetUid': 'adjacent'}])
        result = await GameConsumer()._preview_turn(state, casts, finish=False)
        self.assertEqual(result.board_state['1,0']['color'], 'white')

    def test_every_configured_unit_ability_has_a_candidate(self):
        import time
        state = self.state()
        state.config_snapshot['economy']['upAtStart'] = 1000
        state.board_state['3,0'] = {'unit_id': 'pawn', 'color': 'black', 'uid': 'ranged-target', 'hp': 12, 'max_hp': 12, 'vet': 0}
        for kind, definition in state.config_snapshot['units'].items():
            ability = definition.get('ability')
            if not ability:
                continue
            original = {'unit_id': kind, 'color': 'white', 'uid': 'caster', 'hp': definition['hp'], 'max_hp': definition['hp'], 'vet': 0}
            state.board_state['0,0'] = ranked_unit(original, state.config_snapshot, 3)
            commands = list(candidate_commands(state, time.monotonic() + 2))
            self.assertTrue(any(c.get('id') == ability and c.get('unitUid') == 'caster' for c in commands), ability)

    def test_overtime_changes_attacking_and_defending_position_priorities(self):
        state = self.state()
        state.turn_number = 75
        state.phase_bank['3'] = {'white': 1, 'black': 1}
        white = state.board_state['0,0']
        occupied = state.board_state
        self.assertGreater(movement_priority('0,1', white, state, occupied), movement_priority('-4,0', white, state, occupied))
        black = state.board_state['1,0']
        self.assertGreater(movement_priority('5,0', black, state, occupied), movement_priority('0,1', black, state, occupied))

    async def test_expensive_configs_are_refused_before_search(self):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['scoring']['zones'] *= 7
        request = {'config': config, 'actions': [], 'ply': 1, 'color': 'white', 'difficulty': 'easy', 'budget': 0.01}
        with self.assertRaisesRegex(ValueError, 'too large'):
            await analyse(request)

    async def test_socket_rejects_bad_settings_and_oversized_requests(self):
        socket = WebsocketCommunicator(CpuConsumer.as_asgi(), '/ws/cpu/')
        await socket.connect()
        await socket.send_json_to({'type': 'think', 'id': 1, 'ply': 1, 'color': 'white', 'config': {}, 'actions': [], 'difficulty': 'invented'})
        self.assertIn('settings', (await socket.receive_json_from())['message'])
        await socket.send_to(text_data=' ' * (2 * 1024 * 1024 + 1))
        self.assertIn('size limit', (await socket.receive_json_from())['message'])
        await socket.disconnect()
