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

from game.models import GameChallenge, GameRoom, GameState, PlayerConnection
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
