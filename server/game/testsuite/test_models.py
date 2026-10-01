from django.test import TestCase
from django.utils import timezone
from datetime import timedelta
import uuid
from django.apps import apps
from typing import Any

from game.engine.config_loader import DEFAULT_CONFIG


class GameModelsTestCase(TestCase):
    def test_game_challenge_is_expired(self):
        now = timezone.now()
        challenger = f'user_{uuid.uuid4().hex[:6]}'
        responder = f'user_{uuid.uuid4().hex[:6]}'
        GameChallenge: Any = apps.get_model('game', 'GameChallenge')

        future = GameChallenge.objects.create(
            challenger=challenger,
            responder=responder,
            expires_at=now + timedelta(minutes=5),
        )
        self.assertFalse(future.is_expired())

        past = GameChallenge.objects.create(
            challenger=f'user_{uuid.uuid4().hex[:6]}',
            responder=f'user_{uuid.uuid4().hex[:6]}',
            expires_at=now - timedelta(minutes=5),
        )
        self.assertTrue(past.is_expired())

    def test_playerconnection_create_and_str(self):
        username = f'user_{uuid.uuid4().hex[:6]}'
        PlayerConnection: Any = apps.get_model('game', 'PlayerConnection')
        conn = PlayerConnection.objects.create(
            username=username,
            channel_name='test-channel',
            status='online',
        )
        self.assertIn(username, str(conn))

    def test_custom_unit_stats_survive_game_and_state_database_round_trip(self):
        GameRoom: Any = apps.get_model('game', 'GameRoom')
        GameState: Any = apps.get_model('game', 'GameState')
        config = {
            **DEFAULT_CONFIG,
            'units': {
                **DEFAULT_CONFIG['units'],
                'pawn': {**DEFAULT_CONFIG['units']['pawn'], 'hp': 137, 'move': 4},
            },
        }
        pawn = config['units']['pawn']
        room = GameRoom.objects.create(
            host='alice',
            opponent='bob',
            game_mode='custom',
            custom_config=config,
        )
        GameState.objects.create(
            game=room,
            board_state={
                '0,0': {
                    'unit_id': 'pawn', 'color': 'white',
                    'hp': pawn['hp'], 'max_hp': pawn['hp'], 'uid': 'w0,0',
                },
            },
            current_turn='alice',
            turn_number=1,
            move_history=[],
            player_white='alice',
            player_black='bob',
            config_snapshot=config,
        )

        room.refresh_from_db()
        state = GameState.objects.get(game=room)
        self.assertEqual(room.custom_config['units']['pawn']['hp'], pawn['hp'])
        self.assertEqual(room.custom_config['units']['pawn']['move'], pawn['move'])
        self.assertEqual(state.config_snapshot['units']['pawn'], pawn)
        self.assertEqual(state.board_state['0,0']['hp'], pawn['hp'])
        self.assertEqual(state.board_state['0,0']['max_hp'], pawn['hp'])
