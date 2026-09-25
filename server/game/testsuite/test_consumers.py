import asyncio
import copy
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from datetime import timedelta

from django.utils import timezone

from game.consumers import STALE_AFTER
from game.models import GameChallenge, GameRoom, GameState, PlayerConnection
from game.engine import economy, panels
from game.engine.game_logic import board_moves_at
from game.engine.config_loader import DEFAULT_CONFIG
from game.routing import websocket_urlpatterns


async def _receive_until(comm, msg_type, timeout=8):
    """Consume messages from the communicator until one with `type: msg_type`
    is seen, discarding any others (housekeeping broadcasts) along the way.

    `msg_type` may be a tuple, for a send whose answer is one of two - a move
    that either lands or is refused, say. The message itself says which."""
    wanted = msg_type if isinstance(msg_type, tuple) else (msg_type,)
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"Timed out waiting for message type {msg_type!r}")
        msg = await comm.receive_json_from(timeout=remaining)
        if msg.get('type') in wanted:
            return msg


async def _drain(comm, seconds):
    """Every message type that turns up in the next `seconds`.

    For asserting that something does *not* arrive - there is no other way to
    tell "nothing came" from "it has not come yet".

    Polls with receive_nothing rather than waiting on a receive: asgiref's
    receive_output *cancels the application it is driving* when it times out
    (testing.py), so waiting for quiet the obvious way kills the consumer
    under test and the failure surfaces as a CancelledError in teardown.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + seconds
    types = []
    while loop.time() < deadline:
        if await comm.receive_nothing(timeout=0.1, interval=0.01):
            continue
        types.append((await comm.receive_json_from()).get('type'))
    return types


async def _both_ready_then_start(host_comm, opp_comm, game_id, **start):
    """Ready both seats, wait until the server has both, then start.

    The two readies travel on two separate connections, so nothing orders
    them against the start on a third. Each is broadcast to the room only
    after its row is written, so seeing both arrive on the host is what says
    the server has them - `all()` over whatever rows existed used to let a
    start that beat one of them through anyway.
    """
    await host_comm.send_json_to(
        {'type': 'player_ready', 'username': 'alice', 'gameId': game_id})
    await opp_comm.send_json_to(
        {'type': 'player_ready', 'username': 'bob', 'gameId': game_id})
    for _ in range(2):
        await _receive_until(host_comm, 'player_ready')
    await host_comm.send_json_to({'type': 'start_game', 'gameId': game_id, **start})


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


def _cancel_pending_turn_timers():
    """Stop every armed turn timer.

    The timeout path re-arms itself, so a test that lets one fire leaves a
    task writing GameState rows into a database the test runner is about to
    truncate - and racing its own assertions.
    """
    from game import consumers as _consumers
    for task in list(_consumers._pending_turn_timers.values()):
        task.cancel()
    _consumers._pending_turn_timers.clear()


class HostColourChoiceTests(TransactionTestCase):
    """
    The host takes a side. Only the host can start a game at all - anyone else
    is refused before this - so this is the one seat in a two-player room that
    is chosen rather than tossed for.
    """

    async def _start_with(self, host_color):
        game = await GameRoom.objects.acreate(
            host='alice', opponent='bob', status='waiting',
            host_token='host-tok', opponent_token='opp-tok',
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
            seat = {} if host_color is None else {'hostColor': host_color}
            await _both_ready_then_start(host_comm, opp_comm, game.game_id, **seat)
            started = await _receive_until(host_comm, 'game_started')
            return started
        finally:
            _cancel_pending_turn_timers()
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_host_takes_the_side_it_asks_for(self):
        started = await self._start_with('white')
        self.assertEqual(started['playerWhite'], 'alice')
        self.assertEqual(started['playerBlack'], 'bob')

        started = await self._start_with('black')
        self.assertEqual(started['playerWhite'], 'bob')
        self.assertEqual(started['playerBlack'], 'alice')

    async def test_anything_else_is_still_a_coin_toss(self):
        # Including a client that sends nothing at all, which is what every
        # client did before the choice existed.
        for value in (None, 'random', 'purple'):
            started = await self._start_with(value)
            self.assertEqual(
                {started['playerWhite'], started['playerBlack']}, {'alice', 'bob'})


class TurnTimerLiveIntegrationTests(TransactionTestCase):
    """
    Drives a real game through the full async WebSocket stack with a short
    turnTimeLimit, proving the turn-timer refactor (turn-scoped identity +
    optimistic-concurrency writes) doesn't regress the ordinary, non-racing
    timeout path: the real asyncio.sleep-based timer must pass the turn and
    broadcast turn_passed to both players.
    """

    async def test_real_timeout_passes_turn_and_broadcasts_to_both_players(self):
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

            await _both_ready_then_start(host_comm, opp_comm, game.game_id)

            started_host = await _receive_until(host_comm, 'game_started')
            started_opp = await _receive_until(opp_comm, 'game_started')
            self.assertEqual(started_host['currentTurn'], started_opp['currentTurn'])

            # Neither player moves - the real 1-second asyncio timer should fire.
            passed_host = await _receive_until(host_comm, 'turn_passed', timeout=8)
            passed_opp = await _receive_until(opp_comm, 'turn_passed', timeout=8)
            self.assertTrue(passed_host['timedOut'])
            self.assertTrue(passed_opp['timedOut'])
            self.assertEqual(passed_host['turnNumber'], 2)
            self.assertEqual(passed_host['currentTurn'], passed_opp['currentTurn'])

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, '')
            self.assertEqual(state.turn_number, 2)
        finally:
            # The timeout re-arms itself, so left alone it keeps writing
            # GameState rows while the test database is torn down under it -
            # and can pass the turn again before the assertions above run.
            _cancel_pending_turn_timers()
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

        await _both_ready_then_start(host_comm, opp_comm, game.game_id)
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

    async def test_pregame_disconnect_abandons_the_room_after_grace_period(self):
        """
        Regression test: before, a disconnect with no match underway left the
        remaining player sitting in a room forever waiting for someone who was
        never coming back. Now they are told the room is abandoned and it is
        closed - and the leaver's ready flag is cleared straight away so the
        room can't be started while they're missing.
        """
        with patch('game.consumers.DISCONNECT_GRACE_SECONDS', 1):
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
            await opp_comm.send_json_to({'type': 'player_ready', 'username': 'bob', 'gameId': game.game_id})
            await _receive_until(host_comm, 'player_ready')

            try:
                # Bob drops out before the game ever starts and never returns.
                await opp_comm.disconnect()

                # Alice is told he is no longer ready, then that he's gone.
                # (_receive_until discards everything before its target, so
                # these have to be asserted in the order they're broadcast.)
                unready = await _receive_until(host_comm, 'player_unready', timeout=5)
                self.assertEqual(unready['username'], 'bob')
                notice = await _receive_until(host_comm, 'opponent_disconnected', timeout=5)
                self.assertEqual(notice['username'], 'bob')

                # Once the grace period lapses the room is declared abandoned,
                # not "won" - there was no match to win.
                abandoned = await _receive_until(host_comm, 'room_abandoned', timeout=5)
                self.assertEqual(abandoned['username'], 'bob')

                room = await GameRoom.objects.aget(game_id=game.game_id)
                self.assertEqual(room.status, 'closed')
                self.assertFalse(await GameState.objects.filter(game_id=game.game_id).aexists())
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

            await _both_ready_then_start(host_comm, opp_comm, game.game_id)

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

        await _both_ready_then_start(host_comm, opp_comm, game.game_id)
        started = await _receive_until(host_comm, 'game_started')
        await _receive_until(opp_comm, 'game_started')
        return game, host_comm, opp_comm, started

    async def test_replayed_start_game_is_rejected_and_does_not_reset_board(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            # White makes a move so the board diverges from the initial setup.
            white_comm = host_comm if started['currentTurn'] == 'alice' else opp_comm
            await white_comm.send_json_to({'type': 'make_move', 'from': '-5,9', 'to': '-5,8'})
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
            await _both_ready_then_start(host_comm, opp_comm, game.game_id)
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

    async def _join_pregame_room(self):
        """Two players joined to a 'waiting' room; game not yet started."""
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

    async def test_non_host_leaving_pregame_room_closes_it_and_blocks_rejoin(self):
        """
        Regression test: bob (non-host) leaves before the game starts while
        alice is elsewhere (e.g. the setup-config screen) and doesn't see the
        partner_left broadcast. Her eventual rejoin attempt must bounce her
        to the lobby (GAME_NOT_FOUND) instead of reviving a stale room that
        still shows bob as present.
        """
        game, host_comm, opp_comm = await self._join_pregame_room()
        try:
            await opp_comm.send_json_to({
                'type': 'leave_game_room', 'username': 'bob', 'gameId': game.game_id,
            })

            room = None
            for _ in range(40):
                room = await GameRoom.objects.aget(game_id=game.game_id)
                if room.status == 'closed':
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(room.status, 'closed')

            # Alice (host) was away and rejoins afterwards, as if returning
            # from the setup screen.
            await host_comm.send_json_to({
                'type': 'join_game_room', 'username': 'alice', 'gameId': game.game_id, 'token': 'host-tok',
            })
            err = await _receive_until(host_comm, 'error', timeout=5)
            self.assertEqual(err['code'], 'GAME_NOT_FOUND')
            self.assertEqual(err['message'], 'Game room not found')
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

            await white_comm.send_json_to({'type': 'make_move', 'from': '-5,9', 'to': '-5,8'})
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

    async def test_passing_hands_the_turn_over_without_touching_the_board(self):
        game, host_comm, opp_comm, started = await self._start_game()
        try:
            white_comm = host_comm if started['currentTurn'] == 'alice' else opp_comm
            black_comm = opp_comm if white_comm is host_comm else host_comm
            before = await GameState.objects.aget(game_id=game.game_id)

            # Out of turn: rejected, and the turn stays put.
            await black_comm.send_json_to({'type': 'pass_turn'})
            err = await _receive_until(black_comm, 'error', timeout=5)
            self.assertEqual(err['code'], 'NOT_YOUR_TURN')

            await white_comm.send_json_to({'type': 'pass_turn'})
            passed = await _receive_until(black_comm, 'turn_passed', timeout=5)
            self.assertEqual(passed['color'], 'white')
            self.assertEqual(passed['turnNumber'], before.turn_number + 1)

            after = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(after.board_state, before.board_state)
            self.assertEqual(list(after.move_history), list(before.move_history))
            self.assertNotEqual(after.current_turn, before.current_turn)
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


class LobbyIdentityHijackTests(TransactionTestCase):
    """
    Verifies that rejoining an already-connected username requires proving
    ownership via the per-browser secret (game.consumers._handle_join_lobby),
    instead of anyone being able to take over an online username by simply
    sending rejoining: true.
    """

    async def test_matching_secret_allows_rejoin(self):
        application = URLRouter(websocket_urlpatterns)
        owner = WebsocketCommunicator(application, "/ws/game/lobby/")
        rejoiner = WebsocketCommunicator(application, "/ws/game/lobby/")
        try:
            await owner.connect()
            await _receive_until(owner, 'connection_established')
            await owner.send_json_to({'type': 'join_lobby', 'username': 'alice_test', 'secret': 'correct-secret'})
            await _receive_until(owner, 'user_list')

            await rejoiner.connect()
            await _receive_until(rejoiner, 'connection_established')
            await rejoiner.send_json_to({
                'type': 'join_lobby',
                'username': 'alice_test',
                'rejoining': True,
                'secret': 'correct-secret',
            })
            # A successful rejoin goes straight to user_list with no
            # username_assigned Guest-rename in between.
            result = await _receive_until(rejoiner, 'user_list')
            self.assertIsNotNone(result)
        finally:
            await owner.disconnect()
            await rejoiner.disconnect()

    async def test_wrong_secret_blocks_rejoin(self):
        application = URLRouter(websocket_urlpatterns)
        owner = WebsocketCommunicator(application, "/ws/game/lobby/")
        attacker = WebsocketCommunicator(application, "/ws/game/lobby/")
        try:
            await owner.connect()
            await _receive_until(owner, 'connection_established')
            await owner.send_json_to({'type': 'join_lobby', 'username': 'bob_test', 'secret': 'owner-secret'})
            await _receive_until(owner, 'user_list')

            await attacker.connect()
            await _receive_until(attacker, 'connection_established')
            await attacker.send_json_to({
                'type': 'join_lobby',
                'username': 'bob_test',
                'rejoining': True,
                'secret': 'wrong-secret',
            })
            assigned = await _receive_until(attacker, 'username_assigned')
            self.assertEqual(assigned['originalUsername'], 'bob_test')
            self.assertTrue(assigned['username'].startswith('Guest'))
        finally:
            await owner.disconnect()
            await attacker.disconnect()

    async def _join_lobby(self, username, secret):
        """Join the lobby; the messages seen up to the user list, and the socket."""
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        await comm.connect()
        await comm.send_json_to({'type': 'join_lobby', 'username': username, 'secret': secret})
        seen = []
        while not seen or seen[-1]['type'] != 'user_list':
            seen.append(await comm.receive_json_from(timeout=5))
        return seen, comm

    async def test_a_row_left_by_a_dead_server_does_not_hold_the_name(self):
        """
        A server that dies runs no disconnects. The row it left behind was
        taken for a live player on the first join after the restart, and that
        player was renamed to a guest - which also cost them their seat.
        """
        await PlayerConnection.objects.acreate(
            username='carol_test', channel_name='before-the-restart', secret='carol-secret',
            status='in-game')
        await PlayerConnection.objects.filter(username='carol_test').aupdate(
            last_activity=timezone.now() - STALE_AFTER - timedelta(seconds=1))
        seen, comm = await self._join_lobby('carol_test', 'carol-secret')
        try:
            self.assertNotIn('username_assigned', [m['type'] for m in seen])
            row = await PlayerConnection.objects.aget(username='carol_test')
            self.assertNotEqual(row.channel_name, 'before-the-restart')
        finally:
            await comm.disconnect()

    async def test_a_stale_row_still_holds_its_name_against_the_wrong_secret(self):
        """
        Age says the owner is *probably* gone, never that they are - a sleeping
        laptop misses three heartbeats too, and the name is what holds a seat.
        Freeing a stale row outright handed a live player's name, and their
        game, to whoever asked for it next.
        """
        await PlayerConnection.objects.acreate(
            username='erin_test', channel_name='a-sleeping-laptop', secret='erin-secret',
            status='in-game')
        await PlayerConnection.objects.filter(username='erin_test').aupdate(
            last_activity=timezone.now() - STALE_AFTER - timedelta(seconds=1))
        seen, comm = await self._join_lobby('erin_test', 'not-erins-secret')
        try:
            assigned = next(m for m in seen if m['type'] == 'username_assigned')
            self.assertEqual(assigned['originalUsername'], 'erin_test')
            self.assertNotEqual(assigned['username'], 'erin_test')
            # The row itself may well be gone - the sweep in
            # _get_all_online_users clears stale rows on every user list, and
            # always has. What matters is that it was not handed over: no row
            # for this name belongs to the socket that asked for it.
            taken = await PlayerConnection.objects.filter(
                username='erin_test').exclude(channel_name='a-sleeping-laptop').acount()
            self.assertEqual(taken, 0)
        finally:
            await comm.disconnect()

    async def test_a_row_still_being_heartbeated_holds_the_name(self):
        await PlayerConnection.objects.acreate(
            username='dave_test', channel_name='a-live-socket', secret='dave-secret',
            status='online')
        seen, comm = await self._join_lobby('dave_test', 'someone-else')
        try:
            assigned = next(m for m in seen if m['type'] == 'username_assigned')
            self.assertEqual(assigned['originalUsername'], 'dave_test')
            row = await PlayerConnection.objects.aget(username='dave_test')
            self.assertEqual(row.channel_name, 'a-live-socket')
        finally:
            await comm.disconnect()


class RoomAccessGuardTests(TransactionTestCase):
    """
    The checks around getting into a room and readying up in one, as opposed
    to playing in it: an access token stays good for as long as its holder
    keeps turning up, "all ready" means both seats rather than however many
    rows happen to exist, and a handler handed a room id off the wire only
    acts on rooms the sender actually sits in.
    """

    async def _room(self, **kwargs):
        return await GameRoom.objects.acreate(
            host='alice', opponent='bob', status='waiting',
            host_token='host-tok', opponent_token='opp-tok', **kwargs,
        )

    async def _join(self, game_id, username, token):
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), f"/ws/game/{game_id}/")
        await comm.connect()
        await comm.send_json_to({
            'type': 'join_game_room', 'username': username, 'gameId': game_id, 'token': token,
        })
        return comm

    async def _joined(self, game_id, username, token):
        comm = await self._join(game_id, username, token)
        await _receive_until(comm, 'join_game_room_success')
        return comm

    async def test_joining_pushes_the_token_expiry_out(self):
        # The client rejoins on every socket reopen, so an expiry frozen at
        # room creation turned any blip past the ten-minute mark into
        # TOKEN_EXPIRED, a bounce to the lobby, and a disconnect forfeit of a
        # match still being played.
        game = await self._room(token_expires_at=timezone.now() + timedelta(seconds=5))
        comm = await self._joined(game.game_id, 'alice', 'host-tok')
        try:
            refreshed = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertGreater(refreshed.token_expires_at, timezone.now() + timedelta(minutes=5))
        finally:
            await comm.disconnect()

    async def test_a_seated_heartbeat_keeps_the_token_alive(self):
        # Refreshed only on join, a match played for ten minutes without a
        # reload answered TOKEN_EXPIRED to the first rejoin after a dropped
        # connection, and the grace timer forfeited it.
        game = await self._room()
        comm = await self._joined(game.game_id, 'alice', 'host-tok')
        try:
            await GameRoom.objects.filter(game_id=game.game_id).aupdate(
                token_expires_at=timezone.now() + timedelta(minutes=1))
            await comm.send_json_to({'type': 'heartbeat'})
            await _receive_until(comm, 'heartbeat_ack')
            refreshed = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertGreater(refreshed.token_expires_at, timezone.now() + timedelta(minutes=9))
        finally:
            await comm.disconnect()

    async def test_a_player_who_rejoined_the_room_keeps_their_name(self):
        # Leaving a room deletes the player's row and rejoining recreates it.
        # Recreated without the identity secret, the player's return to the
        # lobby failed its own rejoin check and was renamed to a guest.
        game = await self._room()
        await PlayerConnection.objects.acreate(
            username='bob', channel_name='old-lobby', secret='bob-secret', status='in-game')
        await PlayerConnection.objects.filter(username='bob').adelete()  # the room socket closed

        room = WebsocketCommunicator(URLRouter(websocket_urlpatterns), f"/ws/game/{game.game_id}/")
        await room.connect()
        await room.send_json_to({
            'type': 'join_game_room', 'username': 'bob', 'gameId': game.game_id,
            'token': 'opp-tok', 'secret': 'bob-secret',
        })
        await _receive_until(room, 'join_game_room_success')
        lobby = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        await lobby.connect()
        try:
            await lobby.send_json_to({
                'type': 'join_lobby', 'username': 'bob', 'secret': 'bob-secret', 'rejoining': True})
            seen = []
            while not seen or seen[-1] != 'user_list':
                seen.append((await lobby.receive_json_from(timeout=5))['type'])
            self.assertNotIn('username_assigned', seen)
        finally:
            await lobby.disconnect()
            await room.disconnect()

    async def test_an_expired_token_is_still_refused(self):
        game = await self._room(token_expires_at=timezone.now() - timedelta(seconds=1))
        comm = await self._join(game.game_id, 'alice', 'host-tok')
        try:
            err = await _receive_until(comm, 'error')
            self.assertEqual(err['code'], 'TOKEN_EXPIRED')
        finally:
            await comm.disconnect()

    async def test_start_needs_both_seats_ready_not_just_a_row(self):
        game = await self._room()
        host = await self._joined(game.game_id, 'alice', 'host-tok')
        opp = await self._joined(game.game_id, 'bob', 'opp-tok')
        try:
            await host.send_json_to({
                'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id})
            await _receive_until(host, 'player_ready')

            # One seat has readied. `all()` over the rows that exist says yes
            # to that - and a disconnect deletes the leaver's row, so that was
            # reachable without anybody crafting a thing.
            await host.send_json_to({'type': 'start_game', 'gameId': game.game_id})
            err = await _receive_until(host, 'error')
            self.assertEqual(err['code'], 'NOT_ALL_READY')
            self.assertFalse(await GameState.objects.filter(game_id=game.game_id).aexists())
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_both_seats_ready_still_starts(self):
        game = await self._room()
        host = await self._joined(game.game_id, 'alice', 'host-tok')
        opp = await self._joined(game.game_id, 'bob', 'opp-tok')
        try:
            for comm, name in ((host, 'alice'), (opp, 'bob')):
                await comm.send_json_to({
                    'type': 'player_ready', 'username': name, 'gameId': game.game_id})
            # Both readies reach the room only once their rows are written, so
            # seeing both here is what says the server has them.
            readied = [(await _receive_until(host, 'player_ready'))['username']
                       for _ in range(2)]
            self.assertCountEqual(readied, ['alice', 'bob'])

            await host.send_json_to({'type': 'start_game', 'gameId': game.game_id})
            started = await _receive_until(host, 'game_started')
            self.assertEqual(started['gameId'], game.game_id)
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_an_outsider_cannot_touch_a_rooms_ready_state(self):
        game = await self._room()
        host = await self._joined(game.game_id, 'alice', 'host-tok')
        opp = await self._joined(game.game_id, 'bob', 'opp-tok')
        outsider = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        try:
            await outsider.connect()
            await _receive_until(outsider, 'connection_established')
            await outsider.send_json_to({
                'type': 'join_lobby', 'username': 'mallory', 'secret': 'm-secret'})
            await _receive_until(outsider, 'user_list')

            # Knowing the room id used to be enough to write a ready row into
            # somebody else's room - and an unready one wedged it shut.
            await outsider.send_json_to({
                'type': 'player_unready', 'username': 'mallory', 'gameId': game.game_id})
            err = await _receive_until(outsider, 'error')
            self.assertEqual(err['code'], 'NOT_IN_GAME')
        finally:
            await host.disconnect()
            await opp.disconnect()
            await outsider.disconnect()

    async def test_chat_needs_a_name_and_a_room(self):
        game = await self._room()
        # Connected to the room's own URL, having shown no token: connect()
        # only joins the channel group for the lobby, but group_send never
        # asked whether the sender was in the group it was sending to.
        stranger = WebsocketCommunicator(
            URLRouter(websocket_urlpatterns), f"/ws/game/{game.game_id}/")
        try:
            await stranger.connect()
            await _receive_until(stranger, 'connection_established')

            await stranger.send_json_to({'type': 'game_room_message', 'content': 'hello'})
            err = await _receive_until(stranger, 'error')
            self.assertEqual(err['code'], 'NOT_IN_GAME_ROOM')

            await stranger.send_json_to({'type': 'chat_message', 'content': 'hello'})
            err = await _receive_until(stranger, 'error')
            self.assertEqual(err['code'], 'NOT_IN_LOBBY')
        finally:
            await stranger.disconnect()


class UsernameClaimTests(TestCase):
    """
    Taking a username is one statement (_claim_player_connection), so a
    second client cannot land between a "is it free?" read and the write and
    walk off with the first one's row, channel name and identity secret.
    """

    def setUp(self):
        from game.consumers import GameConsumer
        self.consumer = GameConsumer()

    async def test_a_taken_name_is_refused_without_touching_the_row(self):
        await PlayerConnection.objects.acreate(
            username='frank', channel_name='chan-a', secret='a-secret')

        took = await self.consumer._claim_player_connection('frank', 'chan-b', 'b-secret')

        self.assertFalse(took)
        row = await PlayerConnection.objects.aget(username='frank')
        self.assertEqual(row.channel_name, 'chan-a')
        self.assertEqual(row.secret, 'a-secret')

    async def test_a_free_name_is_taken(self):
        self.assertTrue(
            await self.consumer._claim_player_connection('grace', 'chan-a', 'g-secret'))
        row = await PlayerConnection.objects.aget(username='grace')
        self.assertEqual(row.channel_name, 'chan-a')

    async def test_the_same_socket_can_say_hello_twice(self):
        await PlayerConnection.objects.acreate(
            username='heidi', channel_name='chan-a', secret='h-secret')

        # Already ours - a repeated join_lobby on one socket is not a clash.
        self.assertTrue(
            await self.consumer._claim_player_connection('heidi', 'chan-a', 'h-secret'))

    async def test_a_proven_rejoin_takes_the_row_over(self):
        await PlayerConnection.objects.acreate(
            username='ivan', channel_name='old-chan', secret='i-secret')

        # takeover: the caller has already matched the stored secret.
        self.assertTrue(await self.consumer._claim_player_connection(
            'ivan', 'new-chan', 'i-secret', takeover=True))
        row = await PlayerConnection.objects.aget(username='ivan')
        self.assertEqual(row.channel_name, 'new-chan')


class InvitePairClaimTests(TestCase):
    """
    Marking a pair invited is one statement (_claim_invite_pair). The busy
    check read both statuses and the write came after the invite was made, so
    two players inviting each other at once both got through.
    """

    def setUp(self):
        from game.consumers import GameConsumer
        self.consumer = GameConsumer()

    async def _online(self, *names):
        for name in names:
            await PlayerConnection.objects.acreate(
                username=name, channel_name=f'chan-{name}', secret=f'{name}-secret', status='online')

    async def test_the_second_of_two_crossed_invites_is_refused(self):
        await self._online('carol', 'dave')
        # Both requests have already read "online" - this is what they do next.
        self.assertTrue(await self.consumer._claim_invite_pair('carol', 'dave'))
        self.assertFalse(await self.consumer._claim_invite_pair('dave', 'carol'))
        self.assertEqual(
            await PlayerConnection.objects.filter(status='invited').acount(), 2)

    async def test_a_half_free_pair_is_left_untouched(self):
        await self._online('erin', 'frank', 'gina')
        await self.consumer._claim_invite_pair('erin', 'frank')
        # frank is taken; gina must not be left marked invited for nothing.
        self.assertFalse(await self.consumer._claim_invite_pair('gina', 'frank'))
        self.assertEqual((await PlayerConnection.objects.aget(username='gina')).status, 'online')


class RenameSafetyTests(TransactionTestCase):
    """
    A rename claims the new name before releasing the old one: losing the
    race used to leave the player with no connection row at all, because the
    old one was deleted up front.
    """

    async def _join(self, username, secret):
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        await comm.connect()
        await _receive_until(comm, 'connection_established')
        await comm.send_json_to({
            'type': 'join_lobby', 'username': username, 'secret': secret})
        await _receive_until(comm, 'user_list')
        return comm

    async def test_a_rename_that_loses_keeps_the_name_you_had(self):
        dave = await self._join('dave', 'dave-secret')
        erin = await self._join('erin', 'erin-secret')
        try:
            await dave.send_json_to({
                'type': 'change_username', 'oldUsername': 'dave',
                'newUsername': 'erin', 'secret': 'dave-secret'})
            err = await _receive_until(dave, 'error')
            self.assertEqual(err['code'], 'USERNAME_TAKEN')

            self.assertTrue(await PlayerConnection.objects.filter(username='dave').aexists())
            row = await PlayerConnection.objects.aget(username='erin')
            self.assertEqual(row.secret, 'erin-secret')
        finally:
            await dave.disconnect()
            await erin.disconnect()

    async def test_renaming_to_the_name_already_held_still_confirms(self):
        # The client keeps the rename box open until the server answers, so a
        # no-op that returned silently left it open forever.
        frank = await self._join('frank', 'frank-secret')
        try:
            await frank.send_json_to({
                'type': 'change_username', 'oldUsername': 'frank',
                'newUsername': 'frank', 'secret': 'frank-secret'})
            changed = await _receive_until(frank, 'username_changed')
            self.assertEqual(changed['newUsername'], 'frank')
            self.assertTrue(await PlayerConnection.objects.filter(username='frank').aexists())
        finally:
            await frank.disconnect()


class StaleSocketTests(TransactionTestCase):
    """
    A socket the player has already replaced closing late must not be read as
    them leaving. A half-open connection is torn down whenever the OS or a
    proxy gives up on it, which can be long after the client noticed, gave up
    and reconnected - and that close used to clear a live player's ready tick,
    tell the room they had dropped, and arm a forfeit against them.
    """

    async def _joined(self, game_id, username, token):
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), f"/ws/game/{game_id}/")
        await comm.connect()
        await comm.send_json_to({
            'type': 'join_game_room', 'username': username, 'gameId': game_id, 'token': token,
        })
        await _receive_until(comm, 'join_game_room_success')
        return comm

    async def test_a_replaced_socket_closing_does_not_forfeit_the_player(self):
        with patch('game.consumers.DISCONNECT_GRACE_SECONDS', 1):
            game = await GameRoom.objects.acreate(
                host='alice', opponent='bob', status='waiting',
                host_token='host-tok', opponent_token='opp-tok',
            )
            old = await self._joined(game.game_id, 'alice', 'host-tok')
            opp = await self._joined(game.game_id, 'bob', 'opp-tok')
            await _both_ready_then_start(old, opp, game.game_id)
            await _receive_until(old, 'game_started')
            await _receive_until(opp, 'game_started')

            # Alice's client gave up on a socket that had stopped answering
            # and opened another. The seat is the new one's.
            new = await self._joined(game.game_id, 'alice', 'host-tok')
            try:
                # Only now does the old one's close finally land.
                await old.disconnect()

                seen = await _drain(opp, 2.5)
                self.assertNotIn('opponent_disconnected', seen)
                self.assertNotIn('game_over', seen)

                state = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual(state.end_reason, '')
            finally:
                await new.disconnect()
                await opp.disconnect()


class SeatOwnershipTests(TestCase):
    """_reclaimed_by_newer_socket, the question both stale-socket guards ask."""

    def setUp(self):
        from game.consumers import GameConsumer
        self.consumer = GameConsumer()

    async def test_another_channel_holds_the_row(self):
        await PlayerConnection.objects.acreate(
            username='alice', channel_name='new-chan', status='in-game')
        self.assertTrue(
            await self.consumer._reclaimed_by_newer_socket('alice', 'old-chan'))

    async def test_our_own_channel_is_not_a_replacement(self):
        await PlayerConnection.objects.acreate(
            username='alice', channel_name='old-chan', status='in-game')
        self.assertFalse(
            await self.consumer._reclaimed_by_newer_socket('alice', 'old-chan'))

    async def test_nobody_there_is_not_a_replacement(self):
        self.assertFalse(
            await self.consumer._reclaimed_by_newer_socket('alice', 'old-chan'))

    async def test_turning_up_in_the_lobby_does_not_save_the_match(self):
        # Back at a board is back. Back in the lobby is not - their opponent
        # is still sitting in a room waiting for somebody who left it.
        await PlayerConnection.objects.acreate(
            username='alice', channel_name='new-chan', status='online')
        self.assertFalse(await self.consumer._reclaimed_by_newer_socket(
            'alice', 'old-chan', status='in-game'))


class StaleChallengeTests(TransactionTestCase):
    """
    An invite nobody answered used to wedge the pair permanently: the row
    stayed 'pending' so CHALLENGE_EXISTS refused every future invite between
    them, and both players stayed 'invited', which is refused as busy for
    everyone. expires_at was written at creation and read by nothing running.
    """

    async def _join(self, username):
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        await comm.connect()
        await _receive_until(comm, 'connection_established')
        await comm.send_json_to({
            'type': 'join_lobby', 'username': username, 'secret': f'{username}-secret'})
        await _receive_until(comm, 'user_list')
        return comm

    async def test_an_unanswered_invite_stops_blocking_once_it_expires(self):
        alice = await self._join('alice')
        bob = await self._join('bob')
        try:
            await alice.send_json_to({
                'type': 'game_challenge', 'challenger': 'alice', 'opponent': 'bob'})
            await _receive_until(bob, 'game_challenge')

            # Bob's tab closes without answering - nothing ever declines it.
            await GameChallenge.objects.filter(challenger='alice', responder='bob').aupdate(
                expires_at=timezone.now() - timedelta(seconds=1))

            await alice.send_json_to({
                'type': 'game_challenge', 'challenger': 'alice', 'opponent': 'bob'})
            # Not CHALLENGER_BUSY (alice was left 'invited'), and not
            # CHALLENGE_EXISTS (the dead row was still 'pending').
            await _receive_until(bob, 'game_challenge')

            alice_row = await PlayerConnection.objects.aget(username='alice')
            self.assertEqual(alice_row.status, 'invited')  # by the *new* invite
            self.assertEqual(
                await GameChallenge.objects.filter(challenger='alice').acount(), 1)
        finally:
            await alice.disconnect()
            await bob.disconnect()


class CleanupCommandTests(TestCase):
    """
    The manual escape hatch the README points at. It shares its invite sweep
    with the consumer (utils.expire_stale_challenges) so the two cannot drift:
    it used to mark the rows 'expired' and leave both players sitting at
    'invited', which every invite check refuses as busy - so running the
    documented fix did not actually end the jam it was documented for.
    """

    def test_it_releases_players_stuck_on_an_invite_nobody_answered(self):
        GameChallenge.objects.create(
            challenger='alice', responder='bob', status='pending',
            expires_at=timezone.now() - timedelta(seconds=1))
        PlayerConnection.objects.create(username='alice', channel_name='a', status='invited')
        PlayerConnection.objects.create(username='bob', channel_name='b', status='invited')

        call_command('cleanup_game_state', stdout=StringIO())

        self.assertFalse(GameChallenge.objects.filter(challenger='alice').exists())
        self.assertEqual(PlayerConnection.objects.get(username='alice').status, 'online')
        self.assertEqual(PlayerConnection.objects.get(username='bob').status, 'online')

    def test_it_leaves_a_live_invite_and_its_players_alone(self):
        GameChallenge.objects.create(
            challenger='alice', responder='bob', status='pending',
            expires_at=timezone.now() + timedelta(seconds=30))
        PlayerConnection.objects.create(username='alice', channel_name='a', status='invited')

        call_command('cleanup_game_state', stdout=StringIO())

        self.assertTrue(GameChallenge.objects.filter(status='pending').exists())
        self.assertEqual(PlayerConnection.objects.get(username='alice').status, 'invited')

    def test_it_runs_at_all(self):
        # It had no test and is never exercised in normal play, so a crash in
        # it would only ever be found by the person reaching for it in a jam.
        out = StringIO()
        call_command('cleanup_game_state', stdout=out)
        self.assertIn('Cleanup complete.', out.getvalue())


async def _start_seated_game():
    """
    Two players in a started room. Returns the room, both sockets, and which of
    them is white and which black - the seat is chosen at start, so the tests
    that need a side to move cannot assume the host has it.
    """
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
        'type': 'join_game_room', 'username': 'alice',
        'gameId': game.game_id, 'token': 'host-tok',
    })
    await _receive_until(host_comm, 'join_game_room_success')
    await opp_comm.send_json_to({
        'type': 'join_game_room', 'username': 'bob',
        'gameId': game.game_id, 'token': 'opp-tok',
    })
    await _receive_until(opp_comm, 'join_game_room_success')
    await _both_ready_then_start(host_comm, opp_comm, game.game_id)
    started = await _receive_until(host_comm, 'game_started')
    await _receive_until(opp_comm, 'game_started')
    white = host_comm if started['currentTurn'] == 'alice' else opp_comm
    black = opp_comm if white is host_comm else host_comm
    return game, host_comm, opp_comm, white, black


class DealtPanels:
    """
    Deal the panel squads for the duration of a test.

    A new game now opens with all four panels empty while the owner clears the
    placeholder squads out (``panels.PANELS_DEALT``). Everything that *works* a
    panel is still here and still has to be right for the day they come back,
    so these turn the deal back on rather than going away - a rule nobody
    exercises while it is being changed is a rule that rots.
    """

    def setUp(self):
        super().setUp()
        self._dealt_was = panels.PANELS_DEALT
        panels.PANELS_DEALT = True

    def tearDown(self):
        panels.PANELS_DEALT = self._dealt_was
        super().tearDown()


class PanelCrossingLiveIntegrationTests(DealtPanels, TransactionTestCase):
    """
    A reserve unit stepping onto the battlefield, against a live consumer.

    Until now the server knew nothing about panels, so a networked game could
    not offer a crossing and the client gated the whole feature behind
    `entryBind`. These pin the three things that make the server's answer worth
    more than the browser engine's, which takes the same message on trust.

    White's archer is dealt to '7,7' in its reserve and the gateway at '3,9'
    puts it one step inside the board. Both coordinates come from the panel
    deal, which is derived, not stored (see engine/panels.py).

    **A crossing lands in its own first three rows**, and at the opening those
    rows are where white's army is already standing - so the one hex the archer
    can reach and stop on is '1,9', six steps off: four to the gap, one through
    it onto its own shieldman at '2,9' (passed over, not stopped on) and one
    more. Exactly its six MOV, which is why every "spend a step first" test
    below refuses.
    """

    ARCHER_AT = '7,7'
    LANDS_ON = '1,9'

    async def _start_game(self):
        return await _start_seated_game()

    async def test_a_reserve_unit_crosses_without_taking_the_turn(self):
        """
        A crossing is deployment, not the turn's board action: several may come
        through in one turn, so it must hand nothing over.
        """
        game, host_comm, opp_comm, white, _black = await self._start_game()
        try:
            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': self.LANDS_ON,
            })
            update = await _receive_until(white, 'game_state_update')

            self.assertIn(self.LANDS_ON, update['boardState'])
            landed = update['boardState'][self.LANDS_ON]
            self.assertEqual(landed['unit_id'], 'archer')
            self.assertEqual(landed['color'], 'white')
            self.assertEqual(landed['uid'], 'rbr4')

            state = await GameState.objects.aget(game_id=game.game_id)
            # The ply and the seat are untouched - nothing was handed over.
            self.assertEqual(state.turn_number, 1)
            self.assertEqual(state.current_turn, update['currentTurn'])

            record = state.move_history[-1]
            # The fields the client's panel derivations read. If any of these
            # is dropped the panel re-deals the unit at home, alive and ready
            # to cross again - and mending breaks without a line of mending
            # code being touched.
            self.assertTrue(record['entered'])
            self.assertEqual(record['unit']['uid'], 'rbr4')
            self.assertEqual(record['from'], self.ARCHER_AT)
            self.assertEqual(record['to'], self.LANDS_ON)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_same_unit_cannot_cross_twice(self):
        """
        `entered` takes it out of its panel for good. Without that the panel
        would re-deal it and it could pour the same archer onto the board.
        """
        game, host_comm, opp_comm, white, _black = await self._start_game()
        try:
            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': self.LANDS_ON,
            })
            await _receive_until(white, 'game_state_update')

            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': '-1,9',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_unit_on_the_wire_is_ignored_and_the_derived_one_used(self):
        """
        The whole difference between this and the browser engine. It accepts
        the unit, the hex and the HP as sent, because it has nobody to cheat;
        a server hands a console-armed client a free unit if it does the same.
        """
        game, host_comm, opp_comm, white, _black = await self._start_game()
        try:
            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': self.LANDS_ON,
                # A queen with a thousand HP, which is not what is standing there.
                'unit': {
                    'unit_id': 'queen', 'color': 'white',
                    'hp': 1000, 'max_hp': 1000, 'uid': 'rbr4',
                },
            })
            update = await _receive_until(white, 'game_state_update')

            landed = update['boardState'][self.LANDS_ON]
            self.assertEqual(landed['unit_id'], 'archer')
            self.assertEqual(landed['hp'], 16)
            self.assertNotEqual(landed['hp'], 1000)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_crossing_out_of_reach_is_refused(self):
        """
        The gateway is four steps from the archer and one more through the gap.
        A hex the walk cannot pay for is not on offer however well-formed the
        message is.
        """
        game, host_comm, opp_comm, white, _black = await self._start_game()
        try:
            # '0,0' is the middle of the board - far past six MOV.
            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': '0,0',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')

            # And the three reserve units further back cannot cross at all.
            await white.send_json_to({
                'type': 'enter_board', 'from': '9,3', 'to': self.LANDS_ON,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_only_the_side_to_move_may_cross(self):
        game, host_comm, opp_comm, _white, black = await self._start_game()
        try:
            await black.send_json_to({
                'type': 'enter_board', 'from': '-7,-7', 'to': '-1,-9',
            })
            err = await _receive_until(black, 'error')
            self.assertEqual(err['code'], 'NOT_YOUR_TURN')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class PanelAttackLiveIntegrationTests(DealtPanels, TransactionTestCase):
    """
    A board unit striking into a panel, against a live consumer.

    Nothing of white's reaches a black panel from the opening position, so each
    test stands a white pawn beside one in the stored state first. The numbers
    are the ones PUNCHLIST 4.1 records as watched in a solo game.
    """

    BESIDE_RESERVE = '-8,-3'   # beside rtl0, black's reserve queen
    RESERVE_QUEEN = '-9,-3'
    BESIDE_BASE = '11,-3'      # beside rtr1, black's base rook
    BASE_ROOK = '12,-4'
    #: Ply 7: turn 4, the first of Phase 1's *play*, and white's. These tests
    #: used to strike on ply 1, which is the opening - where nobody attacks.
    #: Nothing enforced that until the server had a phase schedule, so they
    #: passed while striking a blow the game's own rules forbid. For a while
    #: they struck on ply 9 instead, because turn 4 was Phase 1's own
    #: initialization turn and refused a blow for the same reason the opening
    #: does; that turn has since moved to the end of the phase as its
    #: postmatch, and play starts the moment the opening ends.
    PAST_OPENING = 7

    async def _stand_pawn(self, game, at):
        state = await GameState.objects.aget(game_id=game.game_id)
        board = dict(state.board_state)
        board[at] = {'unit_id': 'pawn', 'color': 'white', 'hp': 20, 'max_hp': 20, 'uid': 'wtest'}
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            board_state=board, turn_number=self.PAST_OPENING)

    async def test_a_blow_into_a_reserve_is_answered_and_takes_the_turn(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn(game, self.BESIDE_RESERVE)
            await white.send_json_to({
                'type': 'panel_attack',
                'from': self.BESIDE_RESERVE, 'to': self.BESIDE_RESERVE,
                'attack': self.RESERVE_QUEEN,
            })
            made = await _receive_until(white, 'move_made')

            record = made['move']
            self.assertEqual(record['damage_dealt'], 2)
            self.assertEqual(record['defenderHp'], 28)
            self.assertEqual(record['counter_damage'], 16)
            self.assertEqual(record['panel'], 'tl')
            self.assertEqual(made['boardState'][self.BESIDE_RESERVE]['hp'], 4)

            state = await GameState.objects.aget(game_id=game.game_id)
            # Unlike a crossing, a blow IS the turn's board action.
            self.assertEqual(state.turn_number, self.PAST_OPENING + 1)
            self.assertTrue(state.move_history[-1]['intoPanel'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_counters_flag_off_the_wire_changes_nothing(self):
        """
        The browser engine reads `counters` straight off the message, so a
        client could switch off the counter-attack against its own blows.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn(game, self.BESIDE_RESERVE)
            await white.send_json_to({
                'type': 'panel_attack',
                'from': self.BESIDE_RESERVE, 'to': self.BESIDE_RESERVE,
                'attack': self.RESERVE_QUEEN,
                'counters': False,
                # And a panel and a unit that are not the truth either.
                'panel': 'tr',
                'unit': {'unit_id': 'pawn', 'color': 'black', 'hp': 1, 'uid': 'rtl0'},
            })
            made = await _receive_until(white, 'move_made')

            self.assertEqual(made['move']['counter_damage'], 16)
            self.assertEqual(made['move']['panel'], 'tl')
            self.assertEqual(made['move']['defenderHp'], 28)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_blow_into_a_base_is_never_answered(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn(game, self.BESIDE_BASE)
            await white.send_json_to({
                'type': 'panel_attack',
                'from': self.BESIDE_BASE, 'to': self.BESIDE_BASE,
                'attack': self.BASE_ROOK,
            })
            made = await _receive_until(white, 'move_made')

            self.assertEqual(made['move']['damage_dealt'], 1)
            self.assertEqual(made['move']['counter_damage'], 0)
            self.assertEqual(made['move']['panel'], 'tr')
            self.assertEqual(made['boardState'][self.BESIDE_BASE]['hp'], 20)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_refused_blow_does_not_take_the_turn(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn(game, self.BESIDE_RESERVE)
            # Black's reserve bishop, three hexes out of a pawn's reach of one.
            await white.send_json_to({
                'type': 'panel_attack',
                'from': self.BESIDE_RESERVE, 'to': self.BESIDE_RESERVE,
                'attack': '-9,-5',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            # Refused for its range, not for a setup turn: this is ply 7, turn
            # 4, which plays now that the extra turn closes the phase instead.
            self.assertEqual(err.get('message'), 'That hex is out of attack range')

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, self.PAST_OPENING)
            self.assertEqual(state.move_history, [])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class PanelWithdrawalLiveIntegrationTests(DealtPanels, TransactionTestCase):
    """
    A board unit walking off the battlefield into its own base, on `make_move`.

    White's pawn at '-11,11' starts beside its own doorway at '-12,11', so the
    walk home costs a single step.
    """

    PAWN_AT = '-11,11'
    DOORWAY = '-12,11'

    async def test_a_unit_walks_home_and_the_base_keeps_it(self):
        """
        Turn 1 is a setup turn, so this walk is deployment: answered with a
        state update rather than `move_made`, and the seat and the ply stay put.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'make_move', 'from': self.PAWN_AT, 'to': self.DOORWAY,
                'withdraw': True,
            })
            made = await _receive_until(white, 'game_state_update')

            # Off the board - the doorway is a panel hex, which no board holds.
            self.assertNotIn(self.PAWN_AT, made['boardState'])
            self.assertNotIn(self.DOORWAY, made['boardState'])

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 1)
            record = state.move_history[-1]
            self.assertTrue(record['withdrawn'])
            self.assertEqual(record['unit']['uid'], 'w-11,11')

            # And the record is enough on its own to put it back in its base,
            # which is what a reload - or the other player's screen - does.
            standing = panels.panel_occupancy(
                state.config_snapshot, state.config_snapshot['board']['radius'],
                state.move_history)
            self.assertEqual(standing[self.DOORWAY]['uid'], 'w-11,11')
            self.assertTrue(panels.is_base(standing[self.DOORWAY]['panel']))
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_king_never_walks_home(self):
        """
        The owner's rule. It used to be allowed, and it lost the match on the
        spot: off the board, he counted as no commander.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            # White's king, stood where the pawn starts - one step from home.
            state = await GameState.objects.aget(game_id=game.game_id)
            board = dict(state.board_state)
            king_at = next(k for k, v in board.items()
                           if v['unit_id'] == 'king' and v['color'] == 'white')
            board[self.PAWN_AT] = board.pop(king_at)
            await GameState.objects.filter(game_id=game.game_id).aupdate(board_state=board)

            await white.send_json_to({
                'type': 'make_move', 'from': self.PAWN_AT, 'to': self.DOORWAY,
                'withdraw': True,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            self.assertIn('king', err['message'])
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 1)
            self.assertEqual(state.end_reason, '')
            self.assertEqual(state.board_state[self.PAWN_AT]['unit_id'], 'king')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_nobody_walks_home_into_the_other_sides_base(self):
        """
        The browser engine's test is only the sign of q, so it never needed a
        doorway at all. Black's doorways are not white's way home.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'make_move', 'from': self.PAWN_AT, 'to': '12,-11',
                'withdraw': True,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 1)
            self.assertIn(self.PAWN_AT, state.board_state)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_unit_does_not_come_home_from_across_the_board(self):
        """A queen five hexes out spends all her MOV reaching the doorway."""
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            # Deeper into the base than the doorway - past what six MOV buys.
            await white.send_json_to({
                'type': 'make_move', 'from': '-6,11', 'to': '-13,11',
                'withdraw': True,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_striking_and_walking_home_in_one_turn_is_refused(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'make_move', 'from': self.PAWN_AT, 'to': self.DOORWAY,
                'withdraw': True, 'attack': '0,0',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertIn(self.PAWN_AT, state.board_state)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

class ArrowWindowLiveIntegrationTests(DealtPanels, TransactionTestCase):
    """
    The three arrows' schedules, against a live consumer.

    Each side has three ways in from its reserve, three ways home into its
    base, and a wrap between the two - and each runs on its own window. The
    board draws a red cross over a shut one; these are what stop a message
    asking anyway, which is the half the board cannot enforce.

    Turn numbers throughout are plies. Turn 8 (ply 15) is Phase 1's played
    first half - the wrap's window. Turn 11 (ply 21) is its halftime half -
    the way in. Turn 14 (ply 27) is Phase 1's postmatch - the way in still,
    plus the three walks home. Turn 37 (ply 73) is overtime - the way home
    alone.
    """

    ARCHER_AT = '7,7'          # rbr4, white's reserve archer
    LANDS_ON = '1,9'           # the one hex a crossing may stop on at the deal
    PAWN_AT = '-11,11'         # beside white's own doorway
    DOORWAY = '-12,11'

    async def _wind_to(self, game, ply):
        """Put the stored game on `ply` with white still to play."""
        state = await GameState.objects.aget(game_id=game.game_id)
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            turn_number=ply, current_turn=state.player_white)

    async def test_no_crossing_while_the_way_in_is_shut(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 15)
            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': self.LANDS_ON,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            self.assertEqual(err['message'], 'The way in is shut')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.move_history, [])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_crossing_may_not_stop_past_the_first_three_rows(self):
        """
        '3,8' is one step through the gap and one row short of white's own
        ground. `entry_targets` never offers it, so the message is refused
        where every unreachable hex is.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'enter_board', 'from': self.ARCHER_AT, 'to': '3,8',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertNotIn('3,8', state.board_state)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_no_walk_home_while_the_way_home_is_shut(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 15)
            await white.send_json_to({
                'type': 'make_move', 'from': self.PAWN_AT, 'to': self.DOORWAY,
                'withdraw': True,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            self.assertEqual(err['message'], 'The way home is shut')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertIn(self.PAWN_AT, state.board_state)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_only_the_first_three_rows_walk_home(self):
        """
        A unit that has pushed up the board walks back down into its own
        ground before it can walk off it. Row 8 is one short of it.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            state = await GameState.objects.aget(game_id=game.game_id)
            board = dict(state.board_state)
            board.pop(self.PAWN_AT, None)
            board['-11,8'] = {
                'unit_id': 'pawn', 'color': 'white', 'hp': 20, 'max_hp': 20,
                'uid': 'pushed-up',
            }
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                board_state=board)

            await white.send_json_to({
                'type': 'make_move', 'from': '-11,8', 'to': self.DOORWAY,
                'withdraw': True,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            # Said by name, and in the browser engine's words. Asserting only
            # the code let the generic 'That unit cannot walk home there'
            # stand, which points at the destination when the trouble is where
            # the unit is standing - and had the two engines disagreeing.
            self.assertEqual(err['message'], 'Only your own first three rows walk home')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_walks_home_are_read_off_the_rooms_config(self):
        # rules.homecomingsPerSetupTurn: a room that says one stops the second.
        # Ply 27 is turn 14, Phase 1's postmatch.
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 27)
            state = await GameState.objects.aget(game_id=game.game_id)
            config = dict(state.config_snapshot)
            config['rules'] = {**config['rules'], 'homecomingsPerSetupTurn': 1}
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                config_snapshot=config)
            replies = []
            for frm, to in (('-11,11', '-12,11'), ('-11,10', '-12,10')):
                await white.send_json_to({
                    'type': 'make_move', 'from': frm, 'to': to, 'withdraw': True,
                })
                replies.append(await _receive_until(white, ('game_state_update', 'error')))
            self.assertEqual(replies[0]['type'], 'game_state_update')
            self.assertEqual(replies[1].get('message'), 'That is all who may walk home this turn')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_three_walk_home_in_a_setup_turn_and_no_more(self):
        """
        The owner's three, all inside the one turn.

        **A walk home on a setup turn is deployment, not the turn's board
        action** - the same seat, the same ply, the same clock - which is the
        only reason a count of three is reachable at all. It used to commit the
        turn on the first walk, so the allowance was a cap nothing could ever
        reach, and this test had to wind the ply back between walks to pretend
        otherwise. Nothing is wound here: the fourth is refused by the count.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 27)
            # One walk per doorway, then a fourth that routes through the
            # first doorway - its own unit standing there is passed over.
            walks = [('-11,11', '-12,11'), ('-11,10', '-12,10'),
                     ('-11,9', '-12,9'), ('-10,11', '-13,11')]
            errors = []
            for frm, to in walks:
                await white.send_json_to({
                    'type': 'make_move', 'from': frm, 'to': to, 'withdraw': True,
                })
                reply = await _receive_until(white, ('game_state_update', 'error'))
                if reply['type'] == 'error':
                    errors.append(reply['message'])
                else:
                    self.assertEqual(reply['turnNumber'], 27)

            self.assertEqual(errors, ['That is all who may walk home this turn'])
            state = await GameState.objects.aget(game_id=game.game_id)
            gone = panels.homecomings_at(state.move_history, 27, 'white')
            self.assertEqual(len(gone), 3)
            # Still white's, still turn 14: three walks took no hand-over.
            self.assertEqual(state.turn_number, 27)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_overtime_caps_a_walk_home_by_the_board_move_allowance(self):
        """
        The owner's exception. Overtime is not a setup turn: the toll runs and
        units still fight, so a walk home there is an ordinary board move, and
        the three-a-turn homecoming count does not apply to it.

        What *does* cap it is the turn's own board-move allowance - one through
        Overtime 1 - which is exactly what the window there was always for.

        This used to wind the ply back to 73 between four walks and assert that
        all four landed. No real game reaches that: the first walk ends the
        turn. The fake was the rule showing through - nothing capped a walk
        home in overtime because nothing had to, the turn already being over.
        Now the allowance is counted, the same fixture says so out loud.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 73)
            await white.send_json_to({
                'type': 'make_move', 'from': '-11,11', 'to': '-12,11', 'withdraw': True,
            })
            made = await _receive_until(white, 'move_made')
            self.assertTrue(made['move']['withdrawn'])
            # It ended the turn, like any other board move in overtime.
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 74)

            # A second walk inside the same hand-over is refused - and by the
            # board's allowance, not by the homecoming count, which is the
            # whole of the owner's exception.
            await self._wind_to(game, 73)
            await white.send_json_to({
                'type': 'make_move', 'from': '-11,10', 'to': '-12,10', 'withdraw': True,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['message'],
                             'That side has had all 1 of its moves this turn')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_overtime_two_lets_a_side_move_two_units_in_one_turn(self):
        """
        Ply 89 is turn 45 - Overtime 2, two board moves. The first carries
        `more` and holds the seat; the second ends the turn.

        The ordinary-move path is a different call site from the walk home's,
        so it gets its own test: the two branches were wired one at a time and
        a rule that lands in one and not its twin is this repo's oldest bug.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 89)
            await white.send_json_to({
                'type': 'make_move', 'from': '-5,9', 'to': '-5,8', 'more': True,
            })
            held = await _receive_until(white, 'game_state_update')
            # Same seat, same ply: a held move hands nothing over.
            self.assertEqual(held['turnNumber'], 89)
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.current_turn, state.player_white)

            await white.send_json_to({'type': 'make_move', 'from': '-4,9', 'to': '-4,8'})
            await _receive_until(white, 'move_made')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 90)
            self.assertEqual(
                board_moves_at(state.move_history, 89, 'white'), 2)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_unit_may_not_take_two_of_the_turns_moves(self):
        """
        The allowance counts moves; the owner's rule counts **units** - "you
        can move two units each turn". A side could otherwise play A, then B,
        then A again: each message is legal on its own, judged from where the
        unit stands with a full MOV, so A covered twice its budget in a turn.

        Found by driving the real screen on 22 Sep 2026 with 357 specs green -
        the same way 6.23 was found, and for the same reason: every layer was
        right about the question it was asked.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 99)      # turn 50, Overtime 3: three moves
            await white.send_json_to({
                'type': 'make_move', 'from': '-5,9', 'to': '-5,8', 'more': True,
            })
            await _receive_until(white, 'game_state_update')
            await white.send_json_to({
                'type': 'make_move', 'from': '-4,9', 'to': '-4,8', 'more': True,
            })
            await _receive_until(white, 'game_state_update')

            # The third move is there to be had - but not by the unit that
            # already took the first.
            await white.send_json_to({
                'type': 'make_move', 'from': '-5,8', 'to': '-5,7',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['message'], 'That unit has already moved this turn')

            # A unit that has not moved still gets the third.
            await white.send_json_to({'type': 'make_move', 'from': '-2,9', 'to': '-2,8'})
            await _receive_until(white, 'move_made')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 100)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_third_move_is_refused_where_only_two_are_allowed(self):
        """
        `more` is the client's claim, not its permission. Two is the whole of
        Overtime 2's allowance, so a third message is refused however it is
        flagged - otherwise a client that sets `more` on everything plays the
        rest of the match inside one hand-over.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 89)
            await white.send_json_to({
                'type': 'make_move', 'from': '-5,9', 'to': '-5,8', 'more': True,
            })
            await _receive_until(white, 'game_state_update')
            # The second claims `more` as well - and is still the last one the
            # allowance permits, so it ends the turn rather than holding.
            await white.send_json_to({
                'type': 'make_move', 'from': '-4,9', 'to': '-4,8', 'more': True,
            })
            await _receive_until(white, 'move_made')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 90)

            # And a third, wound back into the same hand-over, is refused.
            await self._wind_to(game, 89)
            await white.send_json_to({'type': 'make_move', 'from': '-7,9', 'to': '-7,8'})
            err = await _receive_until(white, 'error')
            self.assertEqual(err['message'],
                             'That side has had all 2 of its moves this turn')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_overtime_three_lets_three_units_walk_home_in_one_turn(self):
        """
        The allowance is the cap, so raising the allowance raises it. Ply 99 is
        turn 50 - Overtime 3, three board moves - and three walks home fit
        inside one hand-over, the first two holding the seat with `more`.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 99)
            walks = [('-11,11', '-12,11'), ('-11,10', '-12,10'), ('-11,9', '-12,9')]
            for i, (frm, to) in enumerate(walks):
                await white.send_json_to({
                    'type': 'make_move', 'from': frm, 'to': to,
                    'withdraw': True, 'more': i < len(walks) - 1,
                })
                if i < len(walks) - 1:
                    reply = await _receive_until(white, 'game_state_update')
                    # Same seat, same ply: a held move hands nothing over.
                    self.assertEqual(reply['turnNumber'], 99)
                else:
                    made = await _receive_until(white, 'move_made')
                    self.assertTrue(made['move']['withdrawn'])

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(len(panels.homecomings_at(state.move_history, 99, 'white')), 3)
            # The third handed over.
            self.assertEqual(state.turn_number, 100)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_nobody_attacks_in_the_postmatch(self):
        """
        Turn 14 refuses a blow for the same reason the opening does - and says
        which turn refused it, since "the opening" by then is over. Both roads
        to a blow: a board move that swings, and a swing into a panel.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._wind_to(game, 27)
            await white.send_json_to({
                'type': 'make_move', 'from': '-5,9', 'to': '-5,9', 'attack': '-5,8',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['message'], 'Nobody attacks in the postmatch')

            await white.send_json_to({
                'type': 'panel_attack', 'from': '-8,-3', 'to': '-8,-3', 'attack': '-9,-3',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['message'], 'Nobody attacks in the postmatch')

            # Neither took the turn or wrote anything down.
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 27)
            self.assertEqual(state.move_history, [])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class OvertimeTollLiveIntegrationTests(TransactionTestCase):
    """
    Overtime's toll, taken by the server at the end of every turn in overtime.

    Each test winds the stored game on to ply 73, which is overtime's first
    and white's to play, and sets white's king to the HP it needs. The toll is
    taken on all three ways a turn can end - a move, a pass, and the clock -
    and a king on his last HP must not be able to pass his way past it.
    """

    OVERTIME = 73

    async def _overtime(self, game, king_hp, objective=None):
        state = await GameState.objects.aget(game_id=game.game_id)
        board = dict(state.board_state)
        king_at = next(k for k, v in board.items()
                       if v['unit_id'] == 'king' and v['color'] == 'white')
        board[king_at] = {**board[king_at], 'hp': king_hp}
        config = copy.deepcopy(state.config_snapshot)
        if objective:
            config.setdefault('rules', {})['objective'] = objective
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            board_state=board, turn_number=self.OVERTIME, config_snapshot=config)
        return king_at

    async def test_a_pass_in_overtime_takes_the_toll_and_sends_the_board(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            king_at = await self._overtime(game, 10)
            await white.send_json_to({'type': 'pass_turn'})
            passed = await _receive_until(black, 'turn_passed')

            # The board rides on the pass now: the client already takes one,
            # and without it the toll would never reach the other screen.
            self.assertEqual(passed['boardState'][king_at]['hp'], 9)
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.board_state[king_at]['hp'], 9)
            self.assertEqual(state.turn_number, self.OVERTIME + 1)
            self.assertEqual(state.end_reason, '')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_king_on_his_last_point_cannot_pass_his_way_past_it(self):
        """Before the toll a pass never touched the board or asked who lost."""
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            king_at = await self._overtime(game, 1)
            await white.send_json_to({'type': 'pass_turn'})
            over = await _receive_until(black, 'game_over')

            self.assertEqual(over['endReason'], 'regicide')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(over['winner'], state.player_black)
            self.assertNotIn(king_at, state.board_state)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_move_in_overtime_takes_the_toll_from_the_side_that_moved(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            king_at = await self._overtime(game, 10)
            state = await GameState.objects.aget(game_id=game.game_id)
            board = state.board_state
            # Any white pawn with an empty hex straight ahead of it.
            frm, to = next(
                (k, f"{int(k.split(',')[0])},{int(k.split(',')[1]) - 1}")
                for k, v in board.items()
                if v['unit_id'] == 'pawn' and v['color'] == 'white'
                and f"{int(k.split(',')[0])},{int(k.split(',')[1]) - 1}" not in board)
            await white.send_json_to({'type': 'make_move', 'from': frm, 'to': to})
            made = await _receive_until(black, 'move_made')

            self.assertEqual(made['boardState'][king_at]['hp'], 9)
            # Black's king has not played, and pays nothing.
            black_king = next(v for v in made['boardState'].values()
                              if v['unit_id'] == 'king' and v['color'] == 'black')
            self.assertEqual(black_king['hp'], black_king['max_hp'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_under_elimination_a_king_the_toll_kills_loses_nothing(self):
        """
        Elimination only ends when a side has no units at all, so a king the
        toll kills on a pass is a loss of a unit, not of the match. The browser
        engine's pass used to call it a defeat all the same, while its move did
        not; both judge the felled side by its objective now.
        """
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            king_at = await self._overtime(game, 1, objective='elimination')
            await white.send_json_to({'type': 'pass_turn'})
            passed = await _receive_until(black, 'turn_passed')

            self.assertNotIn(king_at, passed['boardState'])
            self.assertTrue(passed['currentTurn'])
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, '')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class MatchEndingLiveIntegrationTests(TransactionTestCase):
    """
    The schedule's two endings, enforced by the server (engine/scoring.py): a
    side past the other's margin once Phase 3 has banked and its postmatch is
    played wins on points, and a match still standing once turn 50 is played
    out is black's. Both were the
    owner's rules long before anything enforced them - the header read them,
    and the match played on.

    Each test winds the stored game to the ply it needs, with the side whose
    ply it is to play and whatever bank the earlier phases would have left.
    """

    async def _wind(self, game, ply, bank=None, black_king_hp=None):
        state = await GameState.objects.aget(game_id=game.game_id)
        board = dict(state.board_state)
        if black_king_hp is not None:
            king_at = next(k for k, v in board.items()
                           if v['unit_id'] == 'king' and v['color'] == 'black')
            board[king_at] = {**board[king_at], 'hp': black_king_hp}
        mover = state.player_white if ply % 2 else state.player_black
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            turn_number=ply, current_turn=mover, board_state=board,
            phase_bank=bank or {})
        return state

    async def _pass(self, mover, other):
        """
        Pass *mover*'s turn and read the hand-over off both sockets, returning
        *other*'s copy. Both are sent every turn_passed, so a socket left
        holding its copy would hand it to the next read as if it were new.
        """
        await mover.send_json_to({'type': 'pass_turn'})
        await _receive_until(mover, 'turn_passed')
        return await _receive_until(other, 'turn_passed')

    async def test_turn_fifty_played_out_goes_to_black(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            state = await self._wind(game, 99)
            # White's half of turn 50 is played, and the match goes on.
            await white.send_json_to({'type': 'pass_turn'})
            passed = await _receive_until(black, 'turn_passed')
            self.assertEqual(passed['currentTurn'], state.player_black)

            # Black's half ends it, with both kings standing: black's.
            await black.send_json_to({'type': 'pass_turn'})
            over = await _receive_until(white, 'game_over')
            self.assertEqual(over['endReason'], 'overtime')
            self.assertEqual(over['winner'], state.player_black)
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.end_reason, 'overtime')
            self.assertEqual(stored.turn_number, 101)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_king_the_last_toll_kills_still_loses_by_regicide(self):
        # The board decides before the schedule does: black's king on the
        # toll's 3 dies of it at the end of turn 50, and that is white's win,
        # not black's by default.
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            state = await self._wind(game, 100, black_king_hp=3)
            await black.send_json_to({'type': 'pass_turn'})
            over = await _receive_until(white, 'game_over')
            self.assertEqual(over['endReason'], 'regicide')
            self.assertEqual(over['winner'], state.player_white)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_side_past_the_margin_wins_on_points_once_the_postmatch_is_played(self):
        # Phase 3 banks as its postmatch begins, and the result is known
        # there, but the postmatch is still played: "phase 3 post match still
        # happens even if overtime isnt triggered."
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            # Ply 70 is black's half of turn 35, the last of Phase 3's play.
            state = await self._wind(game, 70, bank={
                '1': {'white': 12, 'black': 0}, '2': {'white': 0, 'black': 0}})
            passed = await self._pass(black, white)
            self.assertIn('3', passed['phaseBank'])
            self.assertEqual(passed['currentTurn'], state.player_white)
            # White's half of the postmatch, and black's, which ends it.
            passed = await self._pass(white, black)
            self.assertEqual(passed['currentTurn'], state.player_black)
            passed = await self._pass(black, white)
            self.assertEqual(passed['currentTurn'], '')
            over = await _receive_until(white, 'game_over')
            self.assertEqual(over['endReason'], 'points')
            self.assertEqual(over['winner'], state.player_white)
            stored = await GameState.objects.aget(game_id=game.game_id)
            # Phase 3 banked on the way: the dealt board is the same for both
            # sides, so it came to a draw and white's nine carried it.
            self.assertEqual(stored.phase_bank['3']['white'], stored.phase_bank['3']['black'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_close_match_goes_on_into_overtime(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            await self._wind(game, 70, bank={
                '1': {'white': 10, 'black': 0}, '2': {'white': 0, 'black': 0}})
            passed = await self._pass(black, white)
            self.assertIn('3', passed['phaseBank'])
            await self._pass(white, black)
            passed = await self._pass(black, white)
            # Ten clear is not more than ten: nobody has it outright, and
            # the postmatch hands on into overtime.
            self.assertEqual(passed['turnNumber'], 73)
            self.assertTrue(passed['currentTurn'])
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.end_reason, '')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_hand_over_that_leaves_no_commander_standing_is_a_draw(self):
        # The board decides first, and both sides beaten is nobody's win - not
        # the first colour in the list's. A board with no commander on it at
        # all is the plainest way there.
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            state = await GameState.objects.aget(game_id=game.game_id)
            pawn_at, pawn = next(
                (k, v) for k, v in state.board_state.items()
                if v['unit_id'] == 'pawn' and v['color'] == 'white')
            q, r = (int(n) for n in pawn_at.split(','))
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                board_state={pawn_at: pawn}, turn_number=9, current_turn=state.player_white)
            await white.send_json_to({'type': 'make_move', 'from': pawn_at, 'to': f'{q},{r - 1}'})
            over = await _receive_until(black, 'game_over')
            self.assertEqual(over['endReason'], 'draw_mutual')
            self.assertEqual(over['winner'], '')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_late_phase_decides_nothing_on_points(self):
        # Phase 1 banked after its moment - off a board that no longer showed
        # how it finished - is shown, but a match is not ended on it.
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            await self._wind(game, 70, bank={
                '1': {'white': 12, 'black': 0, 'late': True}, '2': {'white': 0, 'black': 0}})
            passed = await self._pass(black, white)
            self.assertNotIn('late', passed['phaseBank']['3'])
            await self._pass(white, black)
            passed = await self._pass(black, white)
            self.assertEqual(passed['turnNumber'], 73)
            self.assertTrue(passed['currentTurn'])
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.end_reason, '')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_move_that_plays_turn_fifty_out_ends_it_the_same(self):
        # A move hands over through _commit_turn, not the pass's settlement:
        # both have to ask the schedule.
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            state = await self._wind(game, 100)
            board = state.board_state
            # Any black pawn with an empty hex straight ahead of it.
            frm, to = next(
                (k, f"{int(k.split(',')[0])},{int(k.split(',')[1]) + 1}")
                for k, v in board.items()
                if v['unit_id'] == 'pawn' and v['color'] == 'black'
                and f"{int(k.split(',')[0])},{int(k.split(',')[1]) + 1}" not in board)
            await black.send_json_to({'type': 'make_move', 'from': frm, 'to': to})
            made = await _receive_until(white, 'move_made')
            self.assertEqual(made['currentTurn'], '')
            over = await _receive_until(white, 'game_over')
            self.assertEqual(over['endReason'], 'overtime')
            self.assertEqual(over['winner'], state.player_black)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_rematch_starts_with_no_phases_banked(self):
        # The state row is reused on a rematch; the last match's bank is not.
        from game.consumers import GameConsumer
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            state = await self._wind(game, 40, bank={'1': {'white': 3, 'black': 1}})
            await GameConsumer()._create_game_state(
                game.game_id, state.board_state, state.player_white,
                state.player_white, state.player_black, state.config_snapshot)
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.phase_bank, {})
            self.assertEqual(stored.turn_number, 1)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_bank_rides_on_the_hand_over_into_a_postmatch(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            # Ply 26 is black's half of turn 13, the last of Phase 1's play.
            await self._wind(game, 26)
            await black.send_json_to({'type': 'pass_turn'})
            passed = await _receive_until(white, 'turn_passed')
            self.assertEqual(set(passed['phaseBank']), {'1'})
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.phase_bank, passed['phaseBank'])

            # And a reconnecting screen gets it back with the rest of the state.
            await white.send_json_to({'type': 'request_game_state'})
            full = await _receive_until(white, 'game_state_update')
            self.assertEqual(full['phaseBank'], passed['phaseBank'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class PanelMoveLiveIntegrationTests(DealtPanels, TransactionTestCase):
    """
    Walking a unit inside its panel, and the wrap, against a live consumer.

    Neither used to reach any engine. The board moved the unit in its own memory
    and sent nothing, so a networked player who shuffled a reserve unit and then
    crossed it from its new hex was refused - the server still had it on the hex
    it was dealt to.
    """

    ARCHER_AT = '7,7'       # rbr4, white's reserve archer
    SHUFFLED_TO = '6,7'     # one step nearer its gateway
    SHUFFLED_ASIDE = '7,8'  # one step that gets it no nearer
    LANDS_ON = '1,9'        # the one hex a crossing may stop on (see below)
    KNIGHT_AT = '-12,6'     # rbl3, white's base knight
    WRAP_OPEN_PLY = 7       # turn 4: Phase 1's first, 14 points (4 turns + its 10)

    async def _history(self, game):
        state = await GameState.objects.aget(game_id=game.game_id)
        return state

    async def test_a_unit_shuffled_first_can_still_cross_from_where_it_stands(self):
        """The hole this fixes, end to end."""
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'panel_move', 'from': self.ARCHER_AT, 'to': self.SHUFFLED_TO,
            })
            moved = await _receive_until(white, 'game_state_update')
            record = moved['moveHistory'][-1]
            self.assertTrue(record['panelMove'])
            self.assertEqual(record['unit']['uid'], 'rbr4')
            self.assertEqual(record['cost'], 1)
            self.assertEqual(record['panel'], 'br')
            # A walk inside a panel is deployment: it hands nothing over.
            self.assertEqual(moved['turnNumber'], 1)

            await white.send_json_to({
                'type': 'enter_board', 'from': self.SHUFFLED_TO, 'to': self.LANDS_ON,
            })
            crossed = await _receive_until(white, 'game_state_update')
            self.assertEqual(crossed['boardState'][self.LANDS_ON]['uid'], 'rbr4')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_crossing_cannot_spend_mov_the_unit_already_walked(self):
        """
        Shuffled one step *sideways*, the archer has five of its six left and
        is no nearer the gap: '1,9' is still six away, reachable on a full MOV
        and not on what is left. Before the allowance a crossing always got the
        whole stat.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'panel_move', 'from': self.ARCHER_AT, 'to': self.SHUFFLED_ASIDE,
            })
            await _receive_until(white, 'game_state_update')
            await white.send_json_to({
                'type': 'enter_board', 'from': self.SHUFFLED_ASIDE, 'to': self.LANDS_ON,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_walk_never_leaves_its_panel(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            # Straight onto the battlefield is a crossing, not a walk.
            await white.send_json_to({
                'type': 'panel_move', 'from': self.ARCHER_AT, 'to': self.LANDS_ON,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.move_history, [])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_wrap_is_paid_for_in_points_and_the_price_comes_off(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                turn_number=self.WRAP_OPEN_PLY)
            state = await GameState.objects.aget(game_id=game.game_id)
            radius = state.config_snapshot['board']['radius']
            tip = panels.wrap_tips('white', radius)['reserve']
            before = economy.points_of(
                'white', self.WRAP_OPEN_PLY, state.move_history, state.config_snapshot)
            self.assertEqual(before, 14)

            await white.send_json_to({'type': 'panel_move', 'from': self.KNIGHT_AT, 'to': tip})
            wrapped = await _receive_until(white, 'game_state_update')
            record = wrapped['moveHistory'][-1]
            self.assertEqual(record['price'], 12)      # a knight is worth 12
            self.assertEqual(record['panel'], 'bl')    # it began in the base

            after = economy.points_of(
                'white', self.WRAP_OPEN_PLY, wrapped['moveHistory'], wrapped['config'])
            self.assertEqual(after, 2)

            # The queen is worth 30, and there are 2 left.
            await white.send_json_to({'type': 'panel_move', 'from': '-13,3', 'to': '10,1'})
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_wrap_is_shut_at_halftime_however_rich(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            # Ply 63 is turn 32: Phase 3's halftime, shut.
            await GameState.objects.filter(game_id=game.game_id).aupdate(turn_number=63)
            state = await GameState.objects.aget(game_id=game.game_id)
            tip = panels.wrap_tips('white', state.config_snapshot['board']['radius'])['reserve']
            await white.send_json_to({'type': 'panel_move', 'from': self.KNIGHT_AT, 'to': tip})
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def _step_once(self, game, white, uid, plan_rules=None):
        """
        Send `uid` one cheapest step inside its panel, from where it stands.

        `plan_rules` lays rules over the room's for *choosing* the step only,
        so a test can ask for a step the room's own rules then refuse - rather
        than one this helper already knew was refused, which proves nothing
        about the server.
        """
        state = await GameState.objects.aget(game_id=game.game_id)
        config = state.config_snapshot
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(
            config, radius, state.move_history, ply=state.turn_number)
        frm = next(k for k, u in occupancy.items() if u['uid'] == uid)
        plan = {**config, 'rules': {**config['rules'], **(plan_rules or {})}}
        targets = panels.panel_move_targets(
            plan, radius, state.move_history, state.board_state, frm,
            state.turn_number, points=0)
        # Planned rules are asked for so the step is a real one; with nowhere
        # to go, the stand-in step below would be refused for being no step at
        # all, and a refusal the test reads as the room's rule would be that.
        assert targets or plan_rules is None, (uid, frm, plan_rules)
        to = min(targets, key=lambda k: (targets[k]['cost'], k)) if targets else frm
        await white.send_json_to({'type': 'panel_move', 'from': frm, 'to': to})
        return frm

    async def test_a_fourth_reserve_unit_may_not_start_moving(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            for uid in ('rbr0', 'rbr1', 'rbr2'):
                await self._step_once(game, white, uid)
                await _receive_until(white, 'game_state_update')
            # The three movers are spent, and rbr3 is not one of them.
            await self._step_once(game, white, 'rbr3')
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_postmatch_starts_the_whole_reserve(self):
        """
        Ply 27 is turn 14, Phase 1's postmatch, where the reserve's cap is
        rules.postmatchEntries - five - instead of the three above. The dealt
        reserve is five strong, so every one of them may start.
        """
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await GameState.objects.filter(game_id=game.game_id).aupdate(turn_number=27)
            for uid in ('rbr0', 'rbr1', 'rbr2', 'rbr3', 'rbr4'):
                await self._step_once(game, white, uid)
                reply = await _receive_until(white, ('game_state_update', 'error'))
                self.assertEqual(reply['type'], 'game_state_update', (uid, reply))
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_postmatch_reads_its_reserve_allowance_off_the_rooms_config(self):
        # A room that says one stops the second, where the default would let
        # five go - the room's own config, not the shipped number.
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            state = await GameState.objects.aget(game_id=game.game_id)
            config = dict(state.config_snapshot)
            config['rules'] = {**config['rules'], 'postmatchEntries': 1}
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                turn_number=27, config_snapshot=config)

            await self._step_once(game, white, 'rbr0')
            await _receive_until(white, 'game_state_update')
            # Planned as if the room allowed the default five, so the step
            # asked for is a real one and only the room's one refuses it.
            await self._step_once(game, white, 'rbr1', plan_rules={'postmatchEntries': 5})
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual([m['unit']['uid'] for m in state.move_history], ['rbr0'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()


class OpeningRulesLiveIntegrationTests(TransactionTestCase):
    """
    The opening's three turns: nobody attacks, and a battlefield unit gets one
    move for the whole phase rather than one a turn.

    The board enforced both in its click handler and nowhere else. Neither
    engine knew what the opening was - the server had no phase schedule at all -
    so a crafted message could strike on the first turn, or walk the same unit
    three times.
    """

    async def _pawn_steps(self, game, count):
        """`count` white pawns with an empty hex straight ahead of each."""
        state = await GameState.objects.aget(game_id=game.game_id)
        board = state.board_state
        out = []
        for key, cell in board.items():
            if cell['unit_id'] != 'pawn' or cell['color'] != 'white':
                continue
            q, r = (int(n) for n in key.split(','))
            ahead = f'{q},{r - 1}'
            if ahead not in board:
                out.append((key, ahead))
            if len(out) == count:
                break
        return out

    async def test_nobody_attacks_in_the_opening(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            (frm, to), = await self._pawn_steps(game, 1)
            await white.send_json_to({
                'type': 'make_move', 'from': frm, 'to': to, 'attack': '0,0',
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['code'], 'INVALID_MOVE')
            self.assertIn('opening', err['message'])
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 1)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_nor_into_a_panel(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await white.send_json_to({
                'type': 'panel_attack', 'from': '-8,-3', 'to': '-8,-3', 'attack': '-9,-3',
            })
            err = await _receive_until(white, 'error')
            self.assertIn('opening', err['message'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_unit_that_moved_in_the_opening_is_done_until_it_ends(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            (frm, to), (other_frm, other_to) = await self._pawn_steps(game, 2)
            await white.send_json_to({'type': 'make_move', 'from': frm, 'to': to})
            await _receive_until(white, 'move_made')
            await black.send_json_to({'type': 'pass_turn'})
            await _receive_until(white, 'turn_passed')

            # Ply 3, still the opening: the same pawn may not go again.
            q, r = (int(n) for n in to.split(','))
            await white.send_json_to({'type': 'make_move', 'from': to, 'to': f'{q},{r - 1}'})
            err = await _receive_until(white, 'error')
            self.assertIn('its move for the opening', err['message'])

            # But a different one may.
            await white.send_json_to({'type': 'make_move', 'from': other_frm, 'to': other_to})
            made = await _receive_until(white, 'move_made')
            self.assertEqual(made['move']['to'], other_to)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_the_lock_lifts_when_the_opening_ends(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            (frm, to), = await self._pawn_steps(game, 1)
            await white.send_json_to({'type': 'make_move', 'from': frm, 'to': to})
            await _receive_until(white, 'move_made')
            # Wind on to ply 7, turn 4: the first of Phase 1's play, straight
            # after the opening, and white's again.
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                turn_number=7, current_turn=(await GameState.objects.aget(
                    game_id=game.game_id)).player_white)
            q, r = (int(n) for n in to.split(','))
            await white.send_json_to({'type': 'make_move', 'from': to, 'to': f'{q},{r - 1}'})
            made = await _receive_until(white, 'move_made')
            self.assertEqual(made['move']['from'], to)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()
