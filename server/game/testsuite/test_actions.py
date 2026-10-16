"""The action transition is usable without a consumer, socket, or ORM model."""
from copy import deepcopy
from types import SimpleNamespace
from unittest import TestCase

from game.engine.actions import ActionRefused, record_unit_progress, resolve_move
from game.engine.ability_rules import initial_state
from game.engine.config_loader import DEFAULT_CONFIG


class ActionTransitionTests(TestCase):
    def position(self):
        config = deepcopy(DEFAULT_CONFIG)
        unit_id = next(key for key, unit in config['units'].items() if unit.get('move', 0) > 0)
        hp = config['units'][unit_id]['hp']
        return SimpleNamespace(config_snapshot=config, turn_number=7, current_turn='alice',
                               player_white='alice', player_black='bob', move_history=[],
                               board_state={'0,0': {'unit_id': unit_id, 'color': 'white',
                                                   'hp': hp, 'max_hp': hp, 'uid': 'actor'}},
                               ability_state=initial_state(), phase_bank={})

    def test_resolves_normalized_movement_without_transport_or_persistence(self):
        state = self.position()
        before = deepcopy(state.board_state)
        result = resolve_move(state, {'from': '00,0', 'to': '01,0', 'more': True})
        self.assertEqual(result.record['from'], '0,0')
        self.assertEqual(result.record['to'], '1,0')
        self.assertEqual(result.board.to_dict()['1,0']['uid'], 'actor')
        self.assertNotIn('0,0', result.board.to_dict())
        self.assertTrue(result.holding)
        self.assertEqual(state.board_state, before)
        self.assertEqual(state.move_history, [])

    def test_refusal_leaves_the_position_unchanged(self):
        state = self.position()
        state.ability_state['endedUnits']['actor'] = state.turn_number
        before = deepcopy(vars(state))
        with self.assertRaisesRegex(ActionRefused, 'cannot take another action'):
            resolve_move(state, {'from': '0,0', 'to': '1,0'})
        self.assertEqual(vars(state), before)

    def test_continued_actions_share_one_movement_budget_and_actor(self):
        state = self.position()
        state.config_snapshot['units'][state.board_state['0,0']['unit_id']]['move'] = 6
        first = {'uid': 'actor', 'from': '0,0', 'steps': 2}
        second = {'uid': 'actor', 'from': '2,0', 'steps': 1}
        record_unit_progress(state, first)
        record_unit_progress(state, second)
        state.board_state['3,0'] = state.board_state.pop('0,0')
        within_budget = resolve_move(state, {'from': '3,0', 'to': '4,0', 'more': True})
        self.assertEqual(within_budget.record['to'], '4,0')
        with self.assertRaisesRegex(ActionRefused, 'Illegal move'):
            resolve_move(state, {'from': '3,0', 'to': '7,0', 'more': True})
        self.assertTrue(second['continuedAction'])
