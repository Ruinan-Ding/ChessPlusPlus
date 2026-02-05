from django.test import TestCase
from django.utils import timezone
from datetime import timedelta
import uuid
from django.apps import apps
from typing import Any


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
