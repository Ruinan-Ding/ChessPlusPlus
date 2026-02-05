from django.core.management.base import BaseCommand
from django.utils import timezone
from datetime import timedelta
import logging

from django.apps import apps
from typing import Any

logger = logging.getLogger('game')


class Command(BaseCommand):
    help = 'Clean up expired challenges, stale player connections, and old closed game rooms.'

    def add_arguments(self, parser):
        parser.add_argument('--stale-minutes', type=int, default=10,
                            help='Remove PlayerConnection entries with last_activity older than this many minutes')
        parser.add_argument('--closed-days', type=int, default=7,
                            help='Delete closed GameRoom entries older than this many days')

    def handle(self, *args, **options):
        now = timezone.now()
        try:
            stale_minutes = int(options.get('stale_minutes', 10) or 10)
            closed_days = int(options.get('closed_days', 7) or 7)

            stale_delta = timedelta(minutes=stale_minutes)
            closed_delta = timedelta(days=closed_days)

            # Resolve models from app registry to avoid static-analysis attribute errors
            # Resolve models from app registry; annotate as Any to satisfy static type checkers
            GameChallenge: Any = apps.get_model('game', 'GameChallenge')
            PlayerConnection: Any = apps.get_model('game', 'PlayerConnection')
            GameRoom: Any = apps.get_model('game', 'GameRoom')

            # Expire pending challenges
            expired_qs = GameChallenge.objects.filter(status='pending', expires_at__lt=now)
            expired_count = expired_qs.update(status='expired')
            self.stdout.write(f'Expired {expired_count} pending challenges')
            logger.info(f'Expired {expired_count} pending challenges')

            # Remove stale player connections
            stale_threshold = now - stale_delta
            stale_qs = PlayerConnection.objects.filter(last_activity__lt=stale_threshold)
            deleted_info = stale_qs.delete()
            stale_count = deleted_info[0] if isinstance(deleted_info, tuple) else int(deleted_info)
            self.stdout.write(f'Deleted {stale_count} stale player connection rows')
            logger.info(f'Deleted {stale_count} stale player connection rows')

            # Optionally remove old closed game rooms
            closed_threshold = now - closed_delta
            closed_qs = GameRoom.objects.filter(status='closed', closed_at__lt=closed_threshold)
            deleted_info = closed_qs.delete()
            closed_count = deleted_info[0] if isinstance(deleted_info, tuple) else int(deleted_info)
            self.stdout.write(f'Deleted {closed_count} old closed game rooms')
            logger.info(f'Deleted {closed_count} old closed game rooms')

            self.stdout.write('Cleanup complete.')
        except Exception as exc:
            logger.exception('Error running cleanup_game_state command')
            self.stderr.write(f'Cleanup failed: {exc}')
            raise SystemExit(1)
