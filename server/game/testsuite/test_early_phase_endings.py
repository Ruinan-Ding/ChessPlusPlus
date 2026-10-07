import copy
from types import SimpleNamespace

from django.test import SimpleTestCase

from game.consumers import _settle_hand_over
from game.engine.config_loader import DEFAULT_CONFIG
from game.engine.board import HexBoard
from game.engine.game_logic import defeated_sides
from game.engine.scoring import bank_ended_phases, capture_zones, schedule_ending


class EarlyPhaseEndingsTests(SimpleTestCase):
    def setUp(self):
        self.config = copy.deepcopy(DEFAULT_CONFIG)
        self.home = next(z['center'] for z in capture_zones(11) if z['owner'] == 'white')
        self.enemy_home = next(z['center'] for z in capture_zones(11) if z['owner'] == 'black')

    def unit(self, id, color, hp=12):
        return {'unit_id': id, 'color': color, 'hp': hp, 'max_hp': hp}

    def test_phase_one_requires_eligible_occupancy_not_a_positive_score(self):
        cases = [
            ({}, True),
            ({'-10,0': self.unit('king', 'white')}, True),
            ({'0,0': self.unit('pawn', 'white')}, True),
            ({self.home: self.unit('pawn', 'white', 0)}, True),
            ({self.home: self.unit('pawn', 'white')}, False),
            ({'0,0': self.unit('rook', 'white')}, False),
        ]
        for board, loses in cases:
            bank = bank_ended_phases({}, self.config, board, [], 27)
            self.assertEqual(bank['1'].get('pendingLoss'), 'white' if loses else None)
        deaths = [{'turn': 25, 'color': 'white', 'unit_id': 'pawn', 'attacker_eliminated': True}] * 8
        bank = bank_ended_phases({}, self.config, {self.home: self.unit('pawn', 'white')}, deaths, 27)
        self.assertEqual(bank['1']['white'], 0)
        self.assertNotIn('pendingLoss', bank['1'])

    def test_contested_eligible_occupancy_keeps_white_alive_even_with_zero_vp(self):
        board = {'-4,8': self.unit('pawn', 'white'), '-3,8': self.unit('queen', 'black')}
        bank = bank_ended_phases({}, self.config, board, [], 27)
        self.assertEqual(bank['1']['white'], 0)
        self.assertNotIn('pendingLoss', bank['1'])

    def test_phase_two_zero_vp_causes_loss_even_with_eligible_occupancy(self):
        prior = {'1': {'white': 57, 'black': 57}}
        board = {self.enemy_home: self.unit('pawn', 'black')}
        deaths = [{'turn': 39, 'color': 'black', 'unit_id': 'pawn', 'attacker_eliminated': True}] * 8
        bank = bank_ended_phases(prior, self.config, board, deaths, 49)
        self.assertEqual(bank['2']['black'], 0)
        self.assertEqual(bank['2']['pendingLoss'], 'black')
        positive = bank_ended_phases(prior, self.config, board, [], 49)
        self.assertGreater(positive['2']['black'], 0)
        self.assertNotIn('pendingLoss', positive['2'])

    def test_pending_result_is_frozen_and_waits_for_both_postmatch_halves(self):
        for phase, start, loss, winner in [(1, 27, 'white', 'black'), (2, 49, 'black', 'white')]:
            prior = {} if phase == 1 else {'1': {'white': 57, 'black': 57}}
            bank = bank_ended_phases(prior, self.config, {}, [], start)
            self.assertEqual(bank[str(phase)]['pendingLoss'], loss)
            for ply in [start, start + 1]:
                self.assertIsNone(schedule_ending(bank, ply))
            changed = bank_ended_phases(bank, self.config, {
                self.home: self.unit('queen', 'white'), self.enemy_home: self.unit('queen', 'black')}, [], start + 1)
            self.assertEqual(changed, bank)
            self.assertEqual(schedule_ending(changed, start + 2), (winner, 'phase_result'))

    def test_late_banks_and_old_banks_do_not_infer_a_loss_from_a_later_board(self):
        late = bank_ended_phases({}, self.config, {}, [], 50)
        self.assertNotIn('pendingLoss', late['1'])
        self.assertNotIn('pendingLoss', late['2'])
        self.assertIsNone(schedule_ending({'1': {'white': 0, 'black': 0}}, 29))

    def test_regicide_precedes_the_pending_phase_result(self):
        for phase, ply, loser, survivor in [(1, 28, 'white', 'white'), (2, 50, 'black', 'black')]:
            bank = {str(phase): {'white': 0, 'black': 0, 'pendingLoss': loser}}
            state = SimpleNamespace(game_id='early-phase-test', config_snapshot=self.config, board_state={
                '-10,0': self.unit('king', survivor, 60)}, move_history=[], phase_bank=bank,
                turn_number=ply, current_turn='bob', player_white='alice', player_black='bob')
            board = HexBoard.from_dict(11, state.board_state)
            result = _settle_hand_over(state, board, [], defeated_sides(board, self.config))
            self.assertEqual(result.end_reason, 'regicide')
            self.assertEqual(result.winner, 'alice' if survivor == 'white' else 'bob')
