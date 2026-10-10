import copy
import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase
from django.utils import timezone

from game.engine.config_loader import DEFAULT_CONFIG_PATH
from game.engine.config_loader import DEFAULT_CONFIG
from game.replay import next_turn_started_at, replay_milliseconds, turn_clock_start


class ReplayClockTests(SimpleTestCase):
    def test_shared_replay_cases(self):
        cases = json.loads(DEFAULT_CONFIG_PATH.with_name('replay-parity.json').read_text())
        for case in cases:
            with self.subTest(case=case['name']):
                self.assertEqual(replay_milliseconds(case['records']), case['milliseconds'])

    def state(self, ply=7):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['match']['turnTimeLimit'] = 15
        config['setup'] = {'white': {}, 'black': {}}
        return SimpleNamespace(config_snapshot=config, turn_number=ply, current_turn='alice',
            player_white='alice', ability_state={}, board_state={})

    def test_deadline_includes_one_simultaneous_upkeep_beat(self):
        state = self.state()
        unit = {'unit_id': 'pawn', 'color': 'white', 'uid': 'home', 'hp': 5, 'max_hp': 12}
        history = [{'turn': 5, 'withdrawn': True, 'from': '0,9', 'to': '-12,11', 'unit': unit}]
        now = timezone.now()
        with patch('game.replay.timezone.now', return_value=now):
            self.assertEqual(next_turn_started_at(state, history), now + timedelta(milliseconds=1940))
            history[0]['unit']['hp'] = 12
            self.assertEqual(next_turn_started_at(state, history), now + timedelta(milliseconds=1433))

    def test_overtime_toll_and_fortress(self):
        state = self.state(73)
        state.board_state = {'0,0': {'unit_id': 'king', 'color': 'white', 'uid': 'king', 'hp': 60}}
        now = timezone.now()
        with patch('game.replay.timezone.now', return_value=now):
            self.assertEqual(next_turn_started_at(state, []), now + timedelta(milliseconds=1940))
            state.ability_state = {'buffs': {'king': {'effects': [{'effect': 'invulnerable'}]}}}
            self.assertEqual(next_turn_started_at(state, []), now + timedelta(milliseconds=1433))

    def test_unlimited_clock_has_no_replay_offset(self):
        state = self.state()
        state.config_snapshot['match']['turnTimeLimit'] = 0
        now = timezone.now()
        with patch('game.replay.timezone.now', return_value=now):
            self.assertEqual(next_turn_started_at(state, [{'abilityCast': {'id': 'anything'}}]), now)

    def test_first_turn_notice_is_excluded_only_for_a_timed_match(self):
        state = self.state()
        now = timezone.now()
        with patch('game.replay.timezone.now', return_value=now):
            self.assertEqual(turn_clock_start(state.config_snapshot), now + timedelta(milliseconds=900))
            state.config_snapshot['match']['turnTimeLimit'] = 0
            self.assertEqual(turn_clock_start(state.config_snapshot), now)
