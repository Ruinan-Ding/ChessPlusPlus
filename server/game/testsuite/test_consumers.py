import asyncio
import copy
from unittest.mock import patch

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from game.models import GameRoom, GameState
from game.engine.config_loader import DEFAULT_CONFIG
from game.routing import websocket_urlpatterns


async def _receive_until(comm, msg_type, timeout=8):
    """Consume messages from the communicator until one with `type: msg_type`
    is seen, discarding any others (housekeeping broadcasts) along the way."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"Timed out waiting for message type {msg_type!r}")
        msg = await comm.receive_json_from(timeout=remaining)
        if msg.get('type') == msg_type:
            return msg


class ConsumerSmokeTests(SimpleTestCase):
    def test_consumer_module_importable(self):
        try:
            from game.consumers import GameConsumer  # noqa: F401
        except Exception as e:
            self.fail(f"Importing GameConsumer failed: {e}")

    def test_utils_importable(self):
        try:
            from game import utils  # noqa: F401
        except Exception as e:
            self.fail(f"Importing game.utils failed: {e}")


class GameStateOptimisticConcurrencyTests(TestCase):
    """
    Verifies the conditional-write mechanism in GameConsumer._update_game_state /
    _end_game that prevents a stale turn-timer write from clobbering a move
    that already ended the game (or vice versa). Each test exercises the real
    consumer methods directly against a real GameState row - no WebSocket or
    asyncio timing is involved, so the race conditions are reproduced
    deterministically instead of by trying to hit a live microsecond window.
    """

    def setUp(self):
        from game.consumers import GameConsumer
        self.consumer = GameConsumer()
        self.game = GameRoom.objects.create(host='alice', opponent='bob', status='started')
        self.state = GameState.objects.create(
            game=self.game,
            board_state={},
            current_turn='alice',
            turn_number=1,
            player_white='alice',
            player_black='bob',
        )

    async def test_update_succeeds_when_turn_matches(self):
        applied = await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={'moved': True},
            current_turn='bob',
            turn_number=2,
            move_history=[{'from': '0,0', 'to': '1,0'}],
            expected_turn_number=1,
        )
        self.assertTrue(applied)
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.turn_number, 2)
        self.assertEqual(refreshed.current_turn, 'bob')

    async def test_stale_write_is_rejected_and_does_not_clobber(self):
        """A writer that read state before another writer already advanced
        turn_number must not be able to overwrite that newer state."""
        # A move already advanced the game to turn 2 (simulating the winning writer).
        await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={'first': True},
            current_turn='bob',
            turn_number=2,
            move_history=[],
            expected_turn_number=1,
        )

        # A second writer, still holding a stale turn_number=1 snapshot, tries to write.
        applied = await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={'second': True},
            current_turn='alice',
            turn_number=2,
            move_history=[],
            expected_turn_number=1,  # stale - the row is already at turn_number=2
        )
        self.assertFalse(applied)

        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.board_state, {'first': True})  # unchanged by the stale writer
        self.assertEqual(refreshed.current_turn, 'bob')

    async def test_write_after_game_finished_is_rejected(self):
        """A move that finishes processing after a turn timer already ended
        the game must not revive it back to 'in progress'."""
        # Turn timer fires first and ends the game (still turn_number=1).
        applied_timeout = await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={},
            current_turn='alice',
            turn_number=1,
            move_history=[],
            winner='bob',
            end_reason='timeout',
            expected_turn_number=1,
        )
        self.assertTrue(applied_timeout)

        # The move that was already in flight (read state before the timeout
        # landed) now tries to persist its own result on the same turn_number.
        applied_move = await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={'move_applied': True},
            current_turn='bob',
            turn_number=2,
            move_history=[{'from': '0,0', 'to': '1,0'}],
            winner='',
            end_reason='',
            expected_turn_number=1,  # matches turn_number, but end_reason is no longer ''
        )
        self.assertFalse(applied_move)

        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.end_reason, 'timeout')  # not clobbered back to in-progress
        self.assertEqual(refreshed.winner, 'bob')
        self.assertEqual(refreshed.board_state, {})

    async def test_end_game_second_caller_on_same_turn_is_rejected(self):
        """Two concurrent end-game paths (e.g. resign racing a timeout) on the
        same turn - only the first should apply; the second must no-op."""
        first_ok = await self.consumer._end_game(self.game.game_id, self.state, 'bob', 'timeout')
        self.assertTrue(first_ok)

        second_ok = await self.consumer._end_game(self.game.game_id, self.state, 'alice', 'resign')
        self.assertFalse(second_ok)

        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.end_reason, 'timeout')
        self.assertEqual(refreshed.winner, 'bob')


class TurnTimerLiveIntegrationTests(TransactionTestCase):
    """
    Drives a real game through the full async WebSocket stack with a short
    turnTimeLimit, proving the turn-timer refactor (turn-scoped identity +
    optimistic-concurrency writes) doesn't regress the ordinary, non-racing
    timeout path: the real asyncio.sleep-based timer must still end the
    game and broadcast game_over to both players with a consistent result.
    """

    async def test_real_timeout_ends_game_and_broadcasts_to_both_players(self):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['rules']['turnTimeLimit'] = 1  # 1 second, to keep the test fast

        game = await GameRoom.objects.acreate(
            host='alice', opponent='bob', status='waiting',
            host_token='host-tok', opponent_token='opp-tok',
            game_mode='custom', custom_config=config,
        )

        application = URLRouter(websocket_urlpatterns)
        host_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
        opp_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
        try:
            await host_comm.connect()
            await opp_comm.connect()

            await host_comm.send_json_to({
                'type': 'join_game_room', 'username': 'alice',
                'gameId': game.game_id, 'token': 'host-tok',
            })
            await _receive_until(host_comm, 'join_game_room_success')

            await opp_comm.send_json_to({
                'type': 'join_game_room', 'username': 'bob',
                'gameId': game.game_id, 'token': 'opp-tok',
            })
            await _receive_until(opp_comm, 'join_game_room_success')

            await host_comm.send_json_to({'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id})
            await opp_comm.send_json_to({'type': 'player_ready', 'username': 'bob', 'gameId': game.game_id})
            await host_comm.send_json_to({'type': 'start_game', 'gameId': game.game_id})

            started_host = await _receive_until(host_comm, 'game_started')
            started_opp = await _receive_until(opp_comm, 'game_started')
            self.assertEqual(started_host['currentTurn'], started_opp['currentTurn'])

            # Neither player moves - the real 1-second asyncio timer should fire.
            over_host = await _receive_until(host_comm, 'game_over', timeout=8)
            over_opp = await _receive_until(opp_comm, 'game_over', timeout=8)

            self.assertEqual(over_host['endReason'], 'timeout')
            self.assertEqual(over_opp['endReason'], 'timeout')
            self.assertEqual(over_host['winner'], over_opp['winner'])
            # The winner must be whoever was NOT on the clock when it expired.
            self.assertEqual(over_host['winner'], started_host['playerBlack']
                              if started_host['currentTurn'] == started_host['playerWhite']
                              else started_host['playerWhite'])

            # DB reflects a single, clean, non-clobbered timeout result.
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, 'timeout')
            self.assertEqual(state.winner, over_host['winner'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class DisconnectGraceLiveIntegrationTests(TransactionTestCase):
    """
    Drives a real game through the full async WebSocket stack to verify the
    disconnect-forfeit grace period: a raw disconnect during an active game
    must not freeze the match forever (the old bug) nor instantly forfeit it
    (too harsh for a page refresh) - it should notify the opponent, wait a
    grace period, and only forfeit if the disconnected player never returns.
    """

    async def _start_game(self, grace_seconds):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['rules']['turnTimeLimit'] = 0  # no turn timer - isolate the disconnect path

        game = await GameRoom.objects.acreate(
            host='alice', opponent='bob', status='waiting',
            host_token='host-tok', opponent_token='opp-tok',
            game_mode='custom', custom_config=config,
        )
        application = URLRouter(websocket_urlpatterns)
        host_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
        opp_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")

        await host_comm.connect()
        await opp_comm.connect()
        await host_comm.send_json_to({
            'type': 'join_game_room', 'username': 'alice', 'gameId': game.game_id, 'token': 'host-tok',
        })
        await _receive_until(host_comm, 'join_game_room_success')
        await opp_comm.send_json_to({
            'type': 'join_game_room', 'username': 'bob', 'gameId': game.game_id, 'token': 'opp-tok',
        })
        await _receive_until(opp_comm, 'join_game_room_success')

        await host_comm.send_json_to({'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id})
        await opp_comm.send_json_to({'type': 'player_ready', 'username': 'bob', 'gameId': game.game_id})
        await host_comm.send_json_to({'type': 'start_game', 'gameId': game.game_id})
        await _receive_until(host_comm, 'game_started')
        await _receive_until(opp_comm, 'game_started')

        return game, host_comm, opp_comm

    async def test_abandoned_disconnect_forfeits_after_grace_period(self):
        with patch('game.consumers.DISCONNECT_GRACE_SECONDS', 1):
            game, host_comm, opp_comm = await self._start_game(grace_seconds=1)
            try:
                # Bob disconnects and never comes back.
                await opp_comm.disconnect()

                notice = await _receive_until(host_comm, 'opponent_disconnected', timeout=5)
                self.assertEqual(notice['username'], 'bob')

                # Game must still be active immediately after the disconnect
                # (not instantly forfeited - a page refresh shouldn't lose the game).
                state = await GameState.objects.aget(game_id=game.game_id)
                self.assertFalse(state.is_finished)

                over = await _receive_until(host_comm, 'game_over', timeout=5)
                self.assertEqual(over['endReason'], 'disconnect')
                self.assertEqual(over['winner'], 'alice')
                self.assertEqual(over['disconnectedPlayer'], 'bob')

                state = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual(state.end_reason, 'disconnect')
                self.assertEqual(state.winner, 'alice')

                room = await GameRoom.objects.aget(game_id=game.game_id)
                self.assertEqual(room.status, 'closed')
            finally:
                await host_comm.disconnect()

    async def test_reconnect_within_grace_period_cancels_the_forfeit(self):
        with patch('game.consumers.DISCONNECT_GRACE_SECONDS', 3):
            game, host_comm, opp_comm = await self._start_game(grace_seconds=3)
            try:
                await opp_comm.disconnect()
                await _receive_until(host_comm, 'opponent_disconnected', timeout=5)

                # Bob reconnects (e.g. refreshed the page) before the grace period ends.
                opp_comm2 = WebsocketCommunicator(
                    URLRouter(websocket_urlpatterns), f"/ws/game/{game.game_id}/"
                )
                await opp_comm2.connect()
                await opp_comm2.send_json_to({
                    'type': 'join_game_room', 'username': 'bob', 'gameId': game.game_id, 'token': 'opp-tok',
                })
                await _receive_until(opp_comm2, 'join_game_room_success')

                reconnect_notice = await _receive_until(host_comm, 'opponent_reconnected', timeout=5)
                self.assertEqual(reconnect_notice['username'], 'bob')

                # Wait past what would have been the forfeit deadline.
                await asyncio.sleep(4)

                state = await GameState.objects.aget(game_id=game.game_id)
                self.assertFalse(state.is_finished)  # the game must NOT have been forfeited

                room = await GameRoom.objects.aget(game_id=game.game_id)
                self.assertEqual(room.status, 'started')

                await opp_comm2.disconnect()
            finally:
                await host_comm.disconnect()


class CustomConfigLiveIntegrationTests(TransactionTestCase):
    """
    Verifies the setup-screen custom config actually reaches the server and
    is used at game start - closing the gap where saveConfig() only wrote to
    a local Angular service and never touched game_options/custom_config.
    """

    async def _join_room(self):
        game = await GameRoom.objects.acreate(
            host='alice', opponent='bob', status='waiting',
            host_token='host-tok', opponent_token='opp-tok',
        )
        application = URLRouter(websocket_urlpatterns)
        host_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
        opp_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
        await host_comm.connect()
        await opp_comm.connect()
        await host_comm.send_json_to({
            'type': 'join_game_room', 'username': 'alice', 'gameId': game.game_id, 'token': 'host-tok',
        })
        await _receive_until(host_comm, 'join_game_room_success')
        await opp_comm.send_json_to({
            'type': 'join_game_room', 'username': 'bob', 'gameId': game.game_id, 'token': 'opp-tok',
        })
        await _receive_until(opp_comm, 'join_game_room_success')
        return game, host_comm, opp_comm

    async def test_saved_custom_config_is_used_at_game_start(self):
        game, host_comm, opp_comm = await self._join_room()
        try:
            custom_config = copy.deepcopy(DEFAULT_CONFIG)
            custom_config['board']['radius'] = 30  # distinct from the default (23), still fits every unit

            await host_comm.send_json_to({'type': 'change_game_mode', 'mode': 'custom', 'gameId': game.game_id})
            await _receive_until(host_comm, 'game_mode_changed')
            await _receive_until(opp_comm, 'game_mode_changed')

            await host_comm.send_json_to({'type': 'set_custom_config', 'config': custom_config})
            saved_host = await _receive_until(host_comm, 'custom_config_saved')
            self.assertEqual(saved_host['savedBy'], 'alice')
            await _receive_until(opp_comm, 'custom_config_saved')

            room = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertEqual(room.custom_config['board']['radius'], 30)

            await host_comm.send_json_to({'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id})
            await opp_comm.send_json_to({'type': 'player_ready', 'username': 'bob', 'gameId': game.game_id})
            await host_comm.send_json_to({'type': 'start_game', 'gameId': game.game_id})

            started = await _receive_until(host_comm, 'game_started')
            self.assertEqual(started['config']['board']['radius'], 30)

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.config_snapshot['board']['radius'], 30)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_non_host_cannot_set_custom_config(self):
        game, host_comm, opp_comm = await self._join_room()
        try:
            await opp_comm.send_json_to({'type': 'set_custom_config', 'config': DEFAULT_CONFIG})
            err = await _receive_until(opp_comm, 'error')
            self.assertEqual(err['code'], 'PERMISSION_DENIED')

            room = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertEqual(room.custom_config, {})
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_invalid_custom_config_is_rejected_and_not_saved(self):
        game, host_comm, opp_comm = await self._join_room()
        try:
            bad_config = copy.deepcopy(DEFAULT_CONFIG)
            bad_config['setup']['white']['-11,23'] = 'not_a_real_unit'

            await host_comm.send_json_to({'type': 'set_custom_config', 'config': bad_config})
            err = await _receive_until(host_comm, 'error')
            self.assertEqual(err['code'], 'INVALID_CONFIG')

            room = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertEqual(room.custom_config, {})
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class FloodProtectionLiveIntegrationTests(TransactionTestCase):
    """
    Verifies the per-connection message-size cap and sliding-window rate
    limit added to GameConsumer.receive() actually engage over a real
    WebSocket, without disrupting ordinary usage.
    """

    async def test_oversized_message_is_rejected(self):
        from game.consumers import MAX_MESSAGE_BYTES

        application = URLRouter(websocket_urlpatterns)
        comm = WebsocketCommunicator(application, "/ws/game/lobby/")
        try:
            await comm.connect()
            await _receive_until(comm, 'connection_established')

            oversized = {
                'type': 'chat_message',
                'content': 'x' * (MAX_MESSAGE_BYTES + 1),
            }
            await comm.send_json_to(oversized)
            err = await _receive_until(comm, 'error')
            self.assertEqual(err['code'], 'MESSAGE_TOO_LARGE')
        finally:
            await comm.disconnect()

    async def test_flood_of_messages_gets_rate_limited(self):
        from game.consumers import RATE_LIMIT_MAX_MESSAGES

        application = URLRouter(websocket_urlpatterns)
        comm = WebsocketCommunicator(application, "/ws/game/lobby/")
        try:
            await comm.connect()
            await _receive_until(comm, 'connection_established')

            # Blow well past the window's allowance in rapid succession.
            for _ in range(RATE_LIMIT_MAX_MESSAGES + 20):
                await comm.send_json_to({'type': 'heartbeat'})

            err = await _receive_until(comm, 'error', timeout=5)
            self.assertEqual(err['code'], 'RATE_LIMITED')
        finally:
            await comm.disconnect()

    async def test_ordinary_usage_is_not_rate_limited(self):
        """A normal handful of messages (well under the window's allowance)
        must never be throttled."""
        from game.consumers import RATE_LIMIT_MAX_MESSAGES

        application = URLRouter(websocket_urlpatterns)
        comm = WebsocketCommunicator(application, "/ws/game/lobby/")
        try:
            await comm.connect()
            await _receive_until(comm, 'connection_established')

            for _ in range(RATE_LIMIT_MAX_MESSAGES - 5):
                await comm.send_json_to({'type': 'heartbeat'})
                ack = await _receive_until(comm, 'heartbeat_ack', timeout=3)
                self.assertEqual(ack['type'], 'heartbeat_ack')
        finally:
            await comm.disconnect()


class GameLifecycleGuardTests(TransactionTestCase):
    """
    Covers the start_game replay guard and the explicit-leave forfeit:
    a duplicate start_game must not reset a live board, and a player who
    deliberately leaves an active match must forfeit it (unlike a raw
    disconnect, which gets a reconnect grace period).
    """

    async def _start_game(self):
        game = await GameRoom.objects.acreate(
            host='alice', opponent='bob', status='waiting',
            host_token='host-tok', opponent_token='opp-tok',
        )
        application = URLRouter(websocket_urlpatterns)
        host_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
        opp_comm = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")

        await host_comm.connect()
        await opp_comm.connect()
        await host_comm.send_json_to({
            'type': 'join_game_room', 'username': 'alice', 'gameId': game.game_id, 'token': 'host-tok',
        })
        await _receive_until(host_comm, 'join_game_room_success')
        await opp_comm.send_json_to({
            'type': 'join_game_room', 'username': 'bob', 'gameId': game.game_id, 'token': 'opp-tok',
        })
        await _receive_until(opp_comm, 'join_game_room_success')

        await host_comm.send_json_to({'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id})
        await opp_comm.send_json_to({'type': 'player_ready', 'username': 'bob', 'gameId': game.game_id})
        await host_comm.send_json_to({'type': 'start_game', 'gameId': game.game_id})
        started = await _receive_until(host_comm, 'game_started')
        await _receive_until(opp_comm, 'game_started')
        return game, host_comm, opp_comm, started

    async def test_replayed_start_game_is_rejected_and_does_not_reset_board(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            # White makes a move so the board diverges from the initial setup.
            white_comm = host_comm if started['currentTurn'] == 'alice' else opp_comm
            await white_comm.send_json_to({'type': 'make_move', 'from': '-12,22', 'to': '-12,21'})
            await _receive_until(white_comm, 'move_made')

            # Host replays start_game (double-click / crafted message).
            await host_comm.send_json_to({'type': 'start_game', 'gameId': game.game_id})
            err = await _receive_until(host_comm, 'error')
            self.assertEqual(err['code'], 'GAME_IN_PROGRESS')

            # The live game was not reset: still turn 2, same colour assignment.
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 2)
            self.assertEqual(state.player_white, started['playerWhite'])
            self.assertEqual(state.player_black, started['playerBlack'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_rematch_start_game_still_allowed_after_game_over(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            await opp_comm.send_json_to({'type': 'resign'})
            await _receive_until(host_comm, 'game_over')
            await _receive_until(opp_comm, 'game_over')

            # Both re-ready and the host starts again - must succeed (rematch).
            await host_comm.send_json_to({'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id})
            await opp_comm.send_json_to({'type': 'player_ready', 'username': 'bob', 'gameId': game.game_id})
            await host_comm.send_json_to({'type': 'start_game', 'gameId': game.game_id})
            restarted = await _receive_until(host_comm, 'game_started')
            self.assertEqual(restarted['turnNumber'], 1)

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, '')
            self.assertEqual(state.turn_number, 1)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_explicit_leave_mid_game_forfeits_to_the_other_player(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            # Bob (non-host) deliberately leaves the room mid-game.
            await opp_comm.send_json_to({
                'type': 'leave_game_room', 'username': 'bob', 'gameId': game.game_id,
            })

            over = await _receive_until(host_comm, 'game_over', timeout=5)
            self.assertEqual(over['endReason'], 'resign')
            self.assertEqual(over['winner'], 'alice')
            self.assertEqual(over['resignedBy'], 'bob')

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, 'resign')
            self.assertEqual(state.winner, 'alice')

            # The room must not linger as 'started' with no one able to end it.
            # (game_over is broadcast before the handler closes the room, so
            # give the rest of the handler a moment to finish.)
            room = None
            for _ in range(40):
                room = await GameRoom.objects.aget(game_id=game.game_id)
                if room.status == 'closed':
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(room.status, 'closed')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_move_clears_pending_draw_offer_server_side(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            white_comm = host_comm if started['currentTurn'] == 'alice' else opp_comm
            black_comm = opp_comm if white_comm is host_comm else host_comm

            # Black offers a draw, then white moves instead of responding.
            await black_comm.send_json_to({'type': 'offer_draw'})
            await _receive_until(white_comm, 'draw_offered')

            await white_comm.send_json_to({'type': 'make_move', 'from': '-12,22', 'to': '-12,21'})
            await _receive_until(white_comm, 'move_made')

            # The stale offer must be gone server-side too (a reconnect resync
            # previously resurrected it).
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.draw_offered_by, '')

            # And accepting it now must be rejected, not end the game in a draw.
            await white_comm.send_json_to({'type': 'respond_draw', 'accept': True})
            err = await _receive_until(white_comm, 'error', timeout=5)
            self.assertEqual(err['code'], 'NO_DRAW_OFFER')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, '')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_malformed_move_coordinates_get_client_error_not_internal(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            white_comm = host_comm if started['currentTurn'] == 'alice' else opp_comm
            await white_comm.send_json_to({'type': 'make_move', 'from': 'garbage', 'to': '0,0'})
            err = await _receive_until(white_comm, 'error', timeout=5)
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_resync_reports_persisted_turn_started_at(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            # The resync must echo the persisted turn-start timestamp, not "now".
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertIsNotNone(state.turn_started_at)

            await host_comm.send_json_to({'type': 'request_game_state'})
            resync = await _receive_until(host_comm, 'game_state_update', timeout=5)
            self.assertEqual(resync['turnStartedAt'], state.turn_started_at.isoformat())
            self.assertEqual(resync['turnStartedAt'], started['turnStartedAt'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()
