import copy

from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase

from game.cpu import CpuConsumer, analyse, candidate_commands, position_value, search_turn, movement_priority
from game.consumers import GameConsumer
from game.engine.ability_rules import initial_state
from game.engine.config_loader import DEFAULT_CONFIG, build_initial_board
from game.engine.unit_stats import ranked_unit
from game.models import GameState
from game.validators import ValidationError


class CpuTests(SimpleTestCase):
    def state(self):
        config = copy.deepcopy(DEFAULT_CONFIG)
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
