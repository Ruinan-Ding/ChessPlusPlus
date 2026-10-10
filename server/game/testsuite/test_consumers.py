import asyncio
import copy
import json
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.db.models import F

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from datetime import timedelta

from django.utils import timezone

from game.consumers import STALE_AFTER
from game.models import (
    GameChallenge, GameDisconnect, GameRoom, GameState, PlayerConnection, PlayerReadyStatus, TurnDraft,
)
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

    async def test_only_one_concurrent_draw_offer_can_claim_an_empty_slot(self):
        self.assertTrue(await self.consumer._update_draw_offer(
            self.game.game_id, 'alice', '', self.state.revision))
        self.assertFalse(await self.consumer._update_draw_offer(
            self.game.game_id, 'bob', '', self.state.revision))
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.draw_offered_by, 'alice')
        self.assertEqual(refreshed.revision, self.state.revision + 1)

        stale_move = await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={'stale': True},
            current_turn='bob',
            turn_number=2,
            move_history=[],
            expected_turn_number=self.state.turn_number,
            expected_revision=self.state.revision,
        )
        self.assertFalse(stale_move)

    async def test_new_disconnect_replaces_a_grace_task_restored_during_its_write(self):
        from game.consumers import GameConsumer, _pending_disconnect_timers

        key = (self.game.game_id, 'bob')
        old_deadline = timezone.now() + timedelta(seconds=30)
        await self.consumer._record_disconnect_deadline(*key, 'old-channel', old_deadline)
        restoring = GameConsumer()
        self.consumer.channel_name = 'new-channel'
        record = self.consumer._record_disconnect_deadline
        restored = replacement = None

        async def record_after_restore(game_id, username, channel, deadline):
            nonlocal restored
            # Restore the old period after start cancels, before it finishes writing.
            await restoring._arm_disconnect_grace_timer(*key, 'old-channel', old_deadline)
            restored = _pending_disconnect_timers[key]
            await record(game_id, username, channel, deadline)

        try:
            with patch.object(self.consumer, '_record_disconnect_deadline', record_after_restore):
                await self.consumer._start_disconnect_grace_timer(*key)
            replacement = _pending_disconnect_timers[key]
            self.assertIsNot(replacement, restored)
            await asyncio.gather(restored, return_exceptions=True)
            self.assertTrue(restored.done())

            [(username, channel, deadline)] = await self.consumer._get_disconnect_deadlines(self.game.game_id)
            await restoring._arm_disconnect_grace_timer(self.game.game_id, username, channel, deadline)
            self.assertIs(_pending_disconnect_timers[key], replacement)

            # A late restore must not replace the newer task with its old snapshot.
            await restoring._arm_disconnect_grace_timer(*key, 'old-channel', old_deadline)
            self.assertIs(_pending_disconnect_timers[key], replacement)

            # Both the channel and the deadline must match to reuse a task.
            for channel, deadline in [('other-channel', deadline),
                                      ('other-channel', deadline + timedelta(seconds=1))]:
                await record(*key, channel, deadline)
                await restoring._arm_disconnect_grace_timer(*key, channel, deadline)
                current = _pending_disconnect_timers[key]
                self.assertIsNot(current, replacement)
                await asyncio.gather(replacement, return_exceptions=True)
                replacement = current
        finally:
            self.consumer._cancel_disconnect_timer(*key)
            tasks = [task for task in (restored, replacement) if task]
            await asyncio.gather(*tasks, return_exceptions=True)

    async def test_disconnect_deadline_survives_a_stale_forfeit_write(self):
        deadline = timezone.now() - timedelta(seconds=1)
        await GameDisconnect.objects.acreate(
            game=self.game,
            username='bob',
            channel_name='old-channel',
            deadline=deadline,
        )

        stale_attempt = await self.consumer._end_game_for_disconnect(
            self.game.game_id, 'bob', 'old-channel', deadline,
            self.state.revision + 1, 'alice')
        self.assertEqual(stale_attempt, 'retry')
        self.assertTrue(await GameDisconnect.objects.filter(
            game_id=self.game.game_id, username='bob',
        ).aexists())
        self.assertFalse((await GameState.objects.aget(game_id=self.game.game_id)).is_finished)

        applied = await self.consumer._end_game_for_disconnect(
            self.game.game_id, 'bob', 'old-channel', deadline,
            self.state.revision, 'alice')
        self.assertEqual(applied, 'ended')
        self.assertFalse(await GameDisconnect.objects.filter(
            game_id=self.game.game_id, username='bob',
        ).aexists())
        finished = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(finished.end_reason, 'disconnect')
        self.assertEqual(finished.winner, 'alice')
        self.assertEqual(finished.revision, self.state.revision + 1)

    async def _write_from(self, snapshot, history, turn_number=None):
        """A write the way every commit path makes one: conditional on the
        turn and the revision of the snapshot it was built from."""
        return await self.consumer._update_game_state(
            game_id=self.game.game_id,
            board_state={},
            current_turn=snapshot.current_turn,
            turn_number=turn_number or snapshot.turn_number,
            move_history=history,
            expected_turn_number=snapshot.turn_number,
            expected_revision=snapshot.revision,
        )

    async def test_two_writes_in_one_ply_cannot_both_land(self):
        # Two deployments read at the same ply - two tabs, say. Neither hands
        # the turn over, so the turn number matched both, and the second write
        # replaced the history the first had just recorded.
        a = await GameState.objects.aget(game_id=self.game.game_id)
        b = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertTrue(await self._write_from(a, [{'deployed': 'A'}]))
        self.assertFalse(await self._write_from(b, [{'deployed': 'B'}]))
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.move_history, [{'deployed': 'A'}])
        self.assertEqual(refreshed.revision, a.revision + 1)

    async def test_a_clock_that_read_before_a_deployment_cannot_erase_it(self):
        timer_read = await GameState.objects.aget(game_id=self.game.game_id)
        deploying = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertTrue(await self._write_from(deploying, [{'deployed': 'A'}]))
        # The timer's pass hands the turn over, from the board it read first.
        self.assertFalse(await self._write_from(timer_read, [], turn_number=2))
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.turn_number, 1)
        self.assertEqual(refreshed.move_history, [{'deployed': 'A'}])

    async def test_a_resign_racing_a_deployment_retries_and_lands(self):
        stale = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertTrue(await self._write_from(stale, [{'deployed': 'A'}]))
        # From the snapshot before the deployment, the ending loses...
        self.assertFalse(await self.consumer._end_game(self.game.game_id, stale, 'bob', 'resign'))
        # ...and the retrying path reads again and lands, keeping the deployment.
        self.assertTrue(await self.consumer._end_game_with_retry(self.game.game_id, 'bob', 'resign'))
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.end_reason, 'resign')
        self.assertEqual(refreshed.move_history, [{'deployed': 'A'}])

    async def test_the_deployment_commit_is_conditional_on_what_it_read(self):
        sent = []

        async def capture(consumer, code, message):
            sent.append(code)

        async def quiet(*args, **kwargs):
            pass

        self.consumer.game_id = self.game.game_id
        self.consumer.channel_layer = None  # broadcast_to_group is patched out
        a = await GameState.objects.aget(game_id=self.game.game_id)
        b = await GameState.objects.aget(game_id=self.game.game_id)
        with patch('game.consumers.send_error', capture), \
                patch('game.consumers.broadcast_to_group', quiet):
            self.assertTrue(await self.consumer._commit_deployment(a, {}, {'deployed': 'A'}, 'crossing'))
            self.assertFalse(await self.consumer._commit_deployment(b, {}, {'deployed': 'B'}, 'crossing'))
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        self.assertEqual(refreshed.move_history, [{'deployed': 'A'}])
        self.assertEqual(sent, ['STATE_CHANGED'])

    async def test_a_clock_that_loses_to_a_deployment_still_passes_the_turn(self):
        from game import consumers as _consumers
        real_update = self.consumer._update_game_state
        raced = []

        async def deployment_lands_first(**kwargs):
            # Between the timer's read and its write, somebody deploys.
            if not raced:
                raced.append(True)
                await GameState.objects.filter(game_id=self.game.game_id).aupdate(
                    move_history=[{'deployed': 'A'}], revision=F('revision') + 1)
            return await real_update(**kwargs)

        async def quiet(*args, **kwargs):
            pass

        async def nobody_there(*args, **kwargs):
            return False

        self.consumer.channel_layer = None  # broadcast_to_group is patched out
        self.consumer._update_game_state = deployment_lands_first
        self.consumer._any_player_connected = nobody_there
        with patch('game.consumers.broadcast_to_group', quiet):
            await self.consumer._start_turn_timer(
                self.game.game_id, 0.01, turn_number=1, current_turn='alice')
            await _consumers._pending_turn_timers[self.game.game_id]
        refreshed = await GameState.objects.aget(game_id=self.game.game_id)
        # Giving up on the lost write left the turn with no clock at all.
        self.assertEqual(refreshed.turn_number, 2)
        self.assertEqual(refreshed.current_turn, 'bob')
        self.assertEqual(refreshed.move_history, [{'deployed': 'A'}])

    async def test_a_lost_write_in_a_running_game_is_not_called_game_over(self):
        sent = []

        async def capture(consumer, code, message):
            sent.append(code)

        self.consumer.game_id = self.game.game_id
        with patch('game.consumers.send_error', capture):
            await self.consumer._refuse_lost_write('crossing')
            await GameState.objects.filter(game_id=self.game.game_id).aupdate(end_reason='resign')
            await self.consumer._refuse_lost_write('crossing')
        self.assertEqual(sent, ['STATE_CHANGED', 'GAME_OVER'])

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

    async def test_expired_disconnect_deadline_is_restored_after_process_restart(self):
        from game.consumers import _pending_disconnect_timers

        with patch('game.consumers.DISCONNECT_GRACE_SECONDS', 30):
            game, host_comm, opp_comm = await self._start_game(grace_seconds=30)
            host_rejoin = None
            try:
                await opp_comm.disconnect()
                await _receive_until(host_comm, 'opponent_disconnected', timeout=5)

                # Simulate the process losing its in-memory task while retaining
                # the persisted deadline, then let the deadline lapse.
                task = _pending_disconnect_timers.pop((game.game_id, 'bob'))
                task.cancel()
                await GameDisconnect.objects.filter(
                    game_id=game.game_id, username='bob',
                ).aupdate(deadline=timezone.now() - timedelta(seconds=1))

                host_rejoin = WebsocketCommunicator(
                    URLRouter(websocket_urlpatterns), f"/ws/game/{game.game_id}/"
                )
                await host_rejoin.connect()
                await host_rejoin.send_json_to({
                    'type': 'join_game_room', 'username': 'alice',
                    'gameId': game.game_id, 'token': 'host-tok',
                })
                await _receive_until(host_rejoin, 'join_game_room_success')
                over = await _receive_until(host_rejoin, 'game_over', timeout=5)
                self.assertEqual(over['endReason'], 'disconnect')
                self.assertEqual(over['disconnectedPlayer'], 'bob')
            finally:
                await host_comm.disconnect()
                if host_rejoin:
                    await host_rejoin.disconnect()

    async def test_turn_clock_resumes_from_persisted_start_after_rejoin(self):
        game, host_comm, opp_comm = await self._start_game(grace_seconds=30)
        host_rejoin = None
        try:
            state = await GameState.objects.aget(game_id=game.game_id)
            config = copy.deepcopy(state.config_snapshot)
            config['rules']['turnTimeLimit'] = 1
            started_at = timezone.now() - timedelta(seconds=3)
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                config_snapshot=config,
                turn_started_at=started_at,
            )

            host_rejoin = WebsocketCommunicator(
                URLRouter(websocket_urlpatterns), f"/ws/game/{game.game_id}/"
            )
            await host_rejoin.connect()
            await host_rejoin.send_json_to({
                'type': 'join_game_room', 'username': 'alice',
                'gameId': game.game_id, 'token': 'host-tok',
            })
            await _receive_until(host_rejoin, 'join_game_room_success')
            passed = await _receive_until(host_rejoin, 'turn_passed', timeout=5)
            self.assertTrue(passed['timedOut'])
            self.assertEqual(passed['turnNumber'], state.turn_number + 1)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()
            if host_rejoin:
                await host_rejoin.disconnect()


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

    async def test_custom_unit_stats_drive_live_networked_moves_and_combat(self):
        game, host_comm, opp_comm = await self._join_room()
        try:
            custom_config = copy.deepcopy(DEFAULT_CONFIG)
            custom_config['setup'] = {
                'white': {'0,0': 'pawn', '-2,0': 'king'},
                'black': {'1,0': 'pawn', '3,0': 'king'},
            }
            custom_config['units']['pawn'].update({
                'hp': 137,
                'move': 1,
                'attack': 13,
                'defense': 5,
                'attackRange': 1,
            })
            custom_config['units']['pawn']['value'] = 17
            await host_comm.send_json_to({
                'type': 'change_game_mode', 'mode': 'custom', 'gameId': game.game_id,
            })
            await _receive_until(host_comm, 'game_mode_changed')
            await _receive_until(opp_comm, 'game_mode_changed')
            await host_comm.send_json_to({'type': 'set_custom_config', 'config': custom_config})
            await _receive_until(host_comm, 'custom_config_saved')
            await _receive_until(opp_comm, 'custom_config_saved')
            await _both_ready_then_start(
                host_comm, opp_comm, game.game_id, hostColor='white',
            )

            started = await _receive_until(host_comm, 'game_started')
            await _receive_until(opp_comm, 'game_started')
            self.assertEqual(started['config']['units']['pawn']['move'], 1)
            self.assertEqual(started['boardState']['0,0']['hp'], 99)
            white = host_comm if started['currentTurn'] == 'alice' else opp_comm
            black = opp_comm if white is host_comm else host_comm
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.config_snapshot['units']['pawn']['value'], 17)

            for ply in range(1, 7):
                player = white if ply % 2 else black
                await player.send_json_to({'type': 'pass_turn'})
                host_pass = await _receive_until(host_comm, 'turn_passed')
                opp_pass = await _receive_until(opp_comm, 'turn_passed')
                expected_mover = 'alice' if player is host_comm else 'bob'
                self.assertEqual(host_pass['passedBy'], expected_mover)
                self.assertEqual(opp_pass['passedBy'], expected_mover)

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 7)
            self.assertEqual(state.current_turn, state.player_white)

            # The custom move budget is one: a two-step action is rejected,
            # while the adjacent strike remains available on the unchanged turn.
            await white.send_json_to({
                'type': 'make_move', 'from': '0,0', 'to': '0,2',
            })
            rejected = await _receive_until(white, 'error')
            self.assertEqual(rejected['code'], 'INVALID_MOVE')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.board_state['0,0']['hp'], 99)
            self.assertEqual(state.turn_number, 7)

            await white.send_json_to({
                'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '1,0',
            })
            made = await _receive_until(white, 'move_made')
            self.assertEqual(made['boardState']['1,0']['hp'], 99 - (15 - 7))
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.board_state['1,0']['hp'], 99 - (15 - 7))
            self.assertEqual(state.config_snapshot['units']['pawn']['attack'], 13)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_malformed_config_shapes_preserve_the_saved_config(self):
        game, host_comm, opp_comm = await self._join_room()
        saved = copy.deepcopy(DEFAULT_CONFIG)
        saved['units']['pawn']['hp'] = 17
        try:
            await host_comm.send_json_to({'type': 'set_custom_config', 'config': saved})
            await _receive_until(host_comm, 'custom_config_saved')
            for path, value in ((['board'], None), (['units'], None), (['setup'], None),
                                (['units', 'pawn'], None), (['setup', 'white'], []),
                                (['setup', 'white', '0,0'], [])):
                config = copy.deepcopy(saved)
                node = config
                for key in path[:-1]:
                    node = node[key]
                node[path[-1]] = value
                with self.subTest(path=path):
                    await host_comm.send_json_to({'type': 'set_custom_config', 'config': config})
                    error = await _receive_until(host_comm, 'error')
                    self.assertEqual(error['code'], 'INVALID_CONFIG')
                    current = await GameRoom.objects.aget(game_id=game.game_id)
                    self.assertEqual(current.custom_config, saved)
            saved['units']['pawn']['hp'] = 18
            await host_comm.send_json_to({'type': 'set_custom_config', 'config': saved})
            await _receive_until(host_comm, 'custom_config_saved')
            current = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertEqual(current.custom_config, saved)
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

    async def test_malformed_envelopes_are_refused_without_closing_the_socket(self):
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), '/ws/game/lobby/')
        try:
            await comm.connect()
            await _receive_until(comm, 'connection_established')
            for payload in (None, [], True, False, 0, 1, 'text', {},
                            {'type': None}, {'type': []}, {'type': {}}, {'type': True}, {'type': 1}):
                with self.subTest(payload=payload):
                    await comm.send_json_to(payload)
                    error = await _receive_until(comm, 'error')
                    self.assertEqual(error['code'], 'INVALID_MESSAGE')
            await comm.send_json_to({'type': 'heartbeat'})
            self.assertEqual((await _receive_until(comm, 'heartbeat_ack'))['type'], 'heartbeat_ack')
        finally:
            await comm.disconnect()

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

    async def test_only_one_concurrent_rematch_claim_can_reset_state(self):
        from game.consumers import GameConsumer

        game, host_comm, opp_comm, started = await self._start_game()
        try:
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                end_reason='resign', winner='alice', revision=F('revision') + 1,
            )
            finished = await GameState.objects.aget(game_id=game.game_id)

            def start_args():
                return (
                    game.game_id, finished.board_state, 'alice', 'alice', 'bob',
                    finished.config_snapshot,
                )

            first, second = await asyncio.gather(
                GameConsumer()._create_game_state(
                    *start_args(), expected_revision=finished.revision,
                    expected_end_reason='resign'),
                GameConsumer()._create_game_state(
                    *start_args(), expected_revision=finished.revision,
                    expected_end_reason='resign'),
            )
            self.assertEqual(sum(result is not None for result in (first, second)), 1)
            refreshed = await GameState.objects.aget(game_id=game.game_id)
            self.assertFalse(refreshed.is_finished)
            self.assertEqual(refreshed.revision, finished.revision + 1)
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

            await white_comm.send_json_to({'type': 'respond_draw', 'accept': 'false'})
            invalid_accept = await _receive_until(white_comm, 'error', timeout=5)
            self.assertEqual(invalid_accept['code'], 'INVALID_REQUEST')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertFalse(state.is_finished)
            self.assertEqual(
                state.draw_offered_by, 'alice' if black_comm is host_comm else 'bob')

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
            await owner.send_json_to({'type': 'join_lobby', 'username': 'aliceTest', 'secret': 'correct-secret'})
            await _receive_until(owner, 'user_list')

            await rejoiner.connect()
            await _receive_until(rejoiner, 'connection_established')
            await rejoiner.send_json_to({
                'type': 'join_lobby',
                'username': 'aliceTest',
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
            await owner.send_json_to({'type': 'join_lobby', 'username': 'bobTest', 'secret': 'owner-secret'})
            await _receive_until(owner, 'user_list')

            await attacker.connect()
            await _receive_until(attacker, 'connection_established')
            await attacker.send_json_to({
                'type': 'join_lobby',
                'username': 'bobTest',
                'rejoining': True,
                'secret': 'wrong-secret',
            })
            assigned = await _receive_until(attacker, 'username_assigned')
            self.assertEqual(assigned['originalUsername'], 'bobTest')
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
            username='carolTest', channel_name='before-the-restart', secret='carol-secret',
            status='in-game')
        await PlayerConnection.objects.filter(username='carolTest').aupdate(
            last_activity=timezone.now() - STALE_AFTER - timedelta(seconds=1))
        seen, comm = await self._join_lobby('carolTest', 'carol-secret')
        try:
            self.assertNotIn('username_assigned', [m['type'] for m in seen])
            row = await PlayerConnection.objects.aget(username='carolTest')
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
            username='erinTest', channel_name='a-sleeping-laptop', secret='erin-secret',
            status='in-game')
        await PlayerConnection.objects.filter(username='erinTest').aupdate(
            last_activity=timezone.now() - STALE_AFTER - timedelta(seconds=1))
        seen, comm = await self._join_lobby('erinTest', 'not-erins-secret')
        try:
            assigned = next(m for m in seen if m['type'] == 'username_assigned')
            self.assertEqual(assigned['originalUsername'], 'erinTest')
            self.assertNotEqual(assigned['username'], 'erinTest')
            # The row itself may well be gone - the sweep in
            # _get_all_online_users clears stale rows on every user list, and
            # always has. What matters is that it was not handed over: no row
            # for this name belongs to the socket that asked for it.
            taken = await PlayerConnection.objects.filter(
                username='erinTest').exclude(channel_name='a-sleeping-laptop').acount()
            self.assertEqual(taken, 0)
        finally:
            await comm.disconnect()

    async def test_a_row_still_being_heartbeated_holds_the_name(self):
        await PlayerConnection.objects.acreate(
            username='daveTest', channel_name='a-live-socket', secret='dave-secret',
            status='online')
        seen, comm = await self._join_lobby('daveTest', 'someone-else')
        try:
            assigned = next(m for m in seen if m['type'] == 'username_assigned')
            self.assertEqual(assigned['originalUsername'], 'daveTest')
            row = await PlayerConnection.objects.aget(username='daveTest')
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

    async def test_a_refused_join_proves_nothing(self):
        # The join used to take the name it was offered before checking the
        # token, and a refusal left it there - after which a leave in that
        # name resigned the named player's match and closed their room.
        game = await self._room()
        host = await self._joined(game.game_id, 'alice', 'host-tok')
        opp = await self._joined(game.game_id, 'bob', 'opp-tok')
        stranger = await self._join(game.game_id, 'alice', 'not-the-token')
        try:
            await _both_ready_then_start(host, opp, game.game_id)
            await _receive_until(host, 'game_started')
            err = await _receive_until(stranger, 'error')
            self.assertEqual(err['code'], 'INVALID_TOKEN')

            for message in (
                {'type': 'player_unready', 'username': 'alice', 'gameId': game.game_id},
                {'type': 'change_game_mode', 'mode': 'custom', 'gameId': game.game_id},
                {'type': 'request_reveal_mode', 'action': 'enable', 'gameId': game.game_id},
                {'type': 'start_game', 'gameId': game.game_id},
                {'type': 'resign'},
            ):
                await stranger.send_json_to(message)
                refused = await _receive_until(stranger, 'error')
                self.assertNotEqual(refused['code'], 'INTERNAL_ERROR', message['type'])
            await stranger.send_json_to(
                {'type': 'leave_game_room', 'username': 'alice', 'gameId': game.game_id})
            # One socket's messages are handled in order, so the answer to
            # this one says the leave before it has been dealt with.
            await stranger.send_json_to({'type': 'heartbeat'})
            await _receive_until(stranger, 'heartbeat_ack')

            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.end_reason, '')
            room = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertNotEqual(room.status, 'closed')
            self.assertEqual(room.game_mode, 'default')
            self.assertTrue(await PlayerReadyStatus.objects.filter(
                game_id=game.game_id, username='alice', is_ready=True).aexists())
        finally:
            await stranger.disconnect()
            await host.disconnect()
            await opp.disconnect()

    async def test_the_right_name_without_the_token_holds_no_seat(self):
        # A socket the lobby knows as the host has proved the name, not the
        # seat: only the room's token does that.
        game = await self._room()
        lobby = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        try:
            await lobby.connect()
            await lobby.send_json_to({'type': 'join_lobby', 'username': 'alice', 'secret': 'a-secret'})
            await _receive_until(lobby, 'user_list')

            for message in (
                {'type': 'player_ready', 'username': 'alice', 'gameId': game.game_id},
                {'type': 'change_game_mode', 'mode': 'custom', 'gameId': game.game_id},
                {'type': 'start_game', 'gameId': game.game_id},
            ):
                await lobby.send_json_to(message)
                err = await _receive_until(lobby, 'error')
                self.assertEqual(err['code'], 'NOT_IN_GAME_ROOM', message['type'])
            await lobby.send_json_to(
                {'type': 'leave_game_room', 'username': 'alice', 'gameId': game.game_id})
            await lobby.send_json_to({'type': 'heartbeat'})
            await _receive_until(lobby, 'heartbeat_ack')

            room = await GameRoom.objects.aget(game_id=game.game_id)
            self.assertEqual(room.status, 'waiting')
            self.assertFalse(await PlayerReadyStatus.objects.filter(game_id=game.game_id).aexists())
        finally:
            await lobby.disconnect()

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


class CleanUsernameTests(SimpleTestCase):
    """Base names use ASCII letters/digits and cannot impersonate System."""

    def test_base_names_are_ascii_letters_and_digits(self):
        from game.validators import ValidationError, clean_username
        self.assertEqual(clean_username('Alice123'), 'Alice123')
        self.assertEqual(clean_username('a' * 24), 'a' * 24)
        for name in ['Alice Smith', 'Ａlice', 'Á', 'Alice!', 'Alice_1', 'Alice#key']:
            with self.subTest(name=name), self.assertRaises(ValidationError):
                clean_username(name)

    def test_invisible_control_and_reserved_names_are_refused(self):
        from game.validators import ValidationError, clean_username
        for name in ['Alice​', '‮ecila', 'a\x00b', 'System', 'SYSTEM',
                     'ｓystem', '', '   ', None, 7, 'x' * 25, 'ﷺ' * 2]:
            with self.subTest(name=name):
                with self.assertRaises(ValidationError):
                    clean_username(name)


class TripcodeTests(SimpleTestCase):
    def test_same_key_has_a_stable_code_independent_of_the_base_name(self):
        from game.validators import username_with_tripcode
        first, _ = username_with_tripcode('Alice#test key')
        other, _ = username_with_tripcode('Bob', key='test key')
        self.assertEqual(first.split('!')[1], other.split('!')[1])
        self.assertNotEqual(first, username_with_tripcode('Alice#another key')[0])
        self.assertEqual(len(username_with_tripcode('A' * 24 + '#key')[0]), 37)

    def test_private_proof_preserves_the_code_on_reconnect_and_rename(self):
        from game.validators import username_with_tripcode
        name, proof = username_with_tripcode('Alice#test key')
        self.assertEqual(username_with_tripcode(name, token=proof), (name, proof))
        self.assertEqual(username_with_tripcode('Renamed', token=proof)[0], 'Renamed!' + name.split('!')[1])

    def test_public_codes_and_malformed_proofs_cannot_authenticate(self):
        from django.core import signing
        from game.validators import ValidationError, username_with_tripcode
        name, proof = username_with_tripcode('Alice#test key')
        wrong_proof = username_with_tripcode('Bob#other key')[1]
        malformed_proof = signing.Signer(salt='game.tripcode').sign('not-a-tripcode')
        wrong_salt_proof = signing.Signer(salt='another.feature').sign(name.split('!')[1])
        for supplied_name, token in [(name, ''), (name.lower(), ''), (name, proof + 'x'),
                                     (name, wrong_proof), (name, None), (name, 7),
                                     (name, 'x' * 201), (name, malformed_proof), (name, wrong_salt_proof),
                                     (name, '\ud800')]:
            with self.subTest(name=supplied_name, token=repr(token)):
                with self.assertRaises(ValidationError) as caught:
                    username_with_tripcode(supplied_name, token=token)
                self.assertEqual(caught.exception.code, 'INVALID_TRIPCODE')

    def test_invalid_keys_and_base_names_are_refused(self):
        from game.validators import ValidationError, username_with_tripcode
        for name, key in [('Alice#', ''), ('Alice#one#two', ''), ('Alice', 'x' * 129),
                          ('Alice #key', ''), ('Alice', '\ud800'), ('Alice', None),
                          ('Alice', 7), ('Alice', 'one#two'), ('System#key', ''), (None, '')]:
            with self.subTest(name=name, key=repr(key)), self.assertRaises(ValidationError):
                username_with_tripcode(name, key=key)


class UsernameHandlingTests(TransactionTestCase):
    """What holds a name, what a name can be, and when it may change."""

    async def _lobby(self, username, secret, **extra):
        """Join the lobby; the socket, and the username_assigned if one came."""
        comm = WebsocketCommunicator(URLRouter(websocket_urlpatterns), "/ws/game/lobby/")
        await comm.connect()
        await _receive_until(comm, 'connection_established')
        await comm.send_json_to({'type': 'join_lobby', 'username': username, 'secret': secret, **extra})
        assigned = None
        while True:
            msg = await comm.receive_json_from(timeout=5)
            if msg['type'] == 'username_assigned':
                assigned = msg
            if msg['type'] == 'user_list':
                return comm, assigned

    def tearDown(self):
        from game import consumers as _consumers
        for task in list(_consumers._pending_disconnect_timers.values()):
            task.cancel()
        _consumers._pending_disconnect_timers.clear()
        _cancel_pending_turn_timers()
        super().tearDown()

    async def test_unicode_tripcode_boundary_survives_join_and_rename(self):
        from game.validators import username_with_tripcode
        key = '😀' * 128
        base = 'A' * 24
        comm, assigned = await self._lobby(base + '#' + key, 'unicode-secret')
        try:
            name, proof = username_with_tripcode(base, key=key)
            self.assertEqual(assigned['username'], name)
            self.assertEqual(assigned['tripcodeToken'], proof)
            self.assertNotEqual(name, username_with_tripcode(base, key=key[:64])[0])
            self.assertNotIn(key, json.dumps(assigned, ensure_ascii=False))
            await comm.send_json_to({
                'type': 'change_username', 'oldUsername': name, 'newUsername': 'B' * 24,
                'tripcodeKey': key, 'secret': 'unicode-secret'})
            renamed = await _receive_until(comm, 'username_assigned')
            self.assertEqual(renamed['username'], 'B' * 24 + '!' + name.split('!')[1])
            self.assertEqual(renamed['tripcodeToken'], proof)
            await comm.send_json_to({
                'type': 'change_username', 'oldUsername': renamed['username'],
                'newUsername': 'C' * 24, 'tripcodeKey': key + '😀', 'secret': 'unicode-secret'})
            error = await _receive_until(comm, 'error')
            self.assertEqual(error['code'], 'INVALID_TRIPCODE')
            self.assertTrue(await PlayerConnection.objects.filter(username=renamed['username']).aexists())
            self.assertNotIn(key, json.dumps(error, ensure_ascii=False))
        finally:
            await comm.disconnect()

    async def test_tripcode_join_reconnect_rename_and_remove_keep_keys_private(self):
        observer, _ = await self._lobby('Observer', 'o')
        player, assigned = await self._lobby('A' * 24 + '#test key', 'p')
        back = None
        try:
            name, proof = assigned['username'], assigned['tripcodeToken']
            self.assertEqual(assigned['reason'], 'tripcode')
            self.assertEqual(len(name), 37)
            self.assertNotIn('test key', json.dumps(assigned))
            roster = await _receive_until(observer, 'user_list')
            while name not in json.dumps(roster):
                roster = await _receive_until(observer, 'user_list')
            self.assertNotIn(proof, json.dumps(roster))
            self.assertNotIn('test key', json.dumps(roster))
            await player.disconnect()
            back, _ = await self._lobby(name, 'p', tripcodeToken=proof, rejoining=True)
            await back.send_json_to({'type': 'change_username', 'oldUsername': name,
                                    'newUsername': 'Renamed', 'tripcodeToken': proof, 'secret': 'p'})
            ack = await _receive_until(back, 'username_assigned')
            renamed = ack['username']
            self.assertEqual(renamed.split('!')[1], name.split('!')[1])
            broadcast = await _receive_until(observer, 'username_changed')
            self.assertEqual(broadcast['newUsername'], renamed)
            self.assertNotIn('tripcodeToken', broadcast)
            await back.send_json_to({'type': 'change_username', 'oldUsername': renamed,
                                    'newUsername': 'Renamed', 'tripcodeToken': '', 'secret': 'p'})
            removed = await _receive_until(back, 'username_assigned')
            self.assertEqual(removed['username'], 'Renamed')
            self.assertEqual(removed['tripcodeToken'], '')
            self.assertTrue(await PlayerConnection.objects.filter(username='Renamed').aexists())
        finally:
            await observer.disconnect()
            if back:
                await back.disconnect()

    async def test_a_name_that_cannot_be_held_gets_a_guest_not_an_error(self):
        comm, assigned = await self._lobby('System', 's')
        try:
            self.assertEqual(assigned['reason'], 'invalid')
            self.assertTrue(assigned['username'].startswith('Guest'))
            self.assertFalse(await PlayerConnection.objects.filter(username='System').aexists())
        finally:
            await comm.disconnect()

    async def test_a_non_ascii_name_gets_a_guest(self):
        # Names saved before the ASCII-only rule recover as guests.
        comm, assigned = await self._lobby('Ａlice', 's')
        try:
            self.assertEqual(assigned['reason'], 'invalid')
            self.assertTrue(assigned['username'].startswith('Guest'))
        finally:
            await comm.disconnect()

    async def test_names_differing_only_in_case_are_one_name(self):
        alice, _ = await self._lobby('Alice', 'a')
        other, assigned = await self._lobby('alice', 'not-a')
        try:
            self.assertEqual(assigned['reason'], 'taken')
            self.assertTrue(assigned['username'].startswith('Guest'))
            # A rename into it in another case is refused the same way.
            await other.send_json_to({
                'type': 'change_username', 'oldUsername': assigned['username'],
                'newUsername': 'ALICE', 'secret': 'not-a'})
            err = await _receive_until(other, 'error')
            self.assertEqual(err['code'], 'USERNAME_TAKEN')
        finally:
            await alice.disconnect()
            await other.disconnect()

    async def test_its_owner_asking_in_another_case_gets_the_name_as_held(self):
        alice, _ = await self._lobby('Alice', 'a')
        back, assigned = await self._lobby('alice', 'a', rejoining=True)
        try:
            self.assertEqual(assigned['reason'], 'normalized')
            self.assertEqual(assigned['username'], 'Alice')
        finally:
            await alice.disconnect()
            await back.disconnect()

    async def test_a_player_may_recase_their_own_name(self):
        dave, _ = await self._lobby('dave', 'd')
        try:
            await dave.send_json_to({
                'type': 'change_username', 'oldUsername': 'dave', 'newUsername': 'Dave', 'secret': 'd'})
            changed = await _receive_until(dave, 'username_changed')
            self.assertEqual(changed['newUsername'], 'Dave')
        finally:
            await dave.disconnect()

    async def test_one_socket_holds_one_name(self):
        comm, _ = await self._lobby('first', 's')
        try:
            await comm.send_json_to({'type': 'join_lobby', 'username': 'second', 'secret': 's'})
            err = await _receive_until(comm, 'error')
            self.assertEqual(err['code'], 'INVALID_REQUEST')
            self.assertFalse(await PlayerConnection.objects.filter(username='second').aexists())
        finally:
            await comm.disconnect()

    async def test_a_guest_name_already_held_is_not_handed_out(self):
        await PlayerConnection.objects.acreate(
            username='Guest000001', channel_name='someone', secret='x')
        await PlayerConnection.objects.acreate(username='taken', channel_name='other', secret='x')
        with patch('game.consumers._guest_name', side_effect=['Guest000001', 'Guest000002']):
            comm, assigned = await self._lobby('taken', 's')
        try:
            self.assertEqual(assigned['username'], 'Guest000002')
            row = await PlayerConnection.objects.aget(username='Guest000001')
            self.assertEqual(row.channel_name, 'someone')
        finally:
            await comm.disconnect()

    async def test_no_rename_with_an_invite_out_and_the_invite_still_finds_its_player(self):
        alice, _ = await self._lobby('alice', 'a')
        bob, _ = await self._lobby('bob', 'b')
        mallory = None
        try:
            await alice.send_json_to({'type': 'game_challenge', 'challenger': 'alice', 'opponent': 'bob'})
            await _receive_until(bob, 'game_challenge')
            for comm, name in ((alice, 'alice'), (bob, 'bob')):
                await comm.send_json_to({
                    'type': 'change_username', 'oldUsername': name,
                    'newUsername': name + '2', 'secret': name[0]})
                err = await _receive_until(comm, 'error')
                self.assertEqual(err['code'], 'NAME_LOCKED', name)
            row = await PlayerConnection.objects.aget(username='alice')
            self.assertEqual(row.status, 'invited')

            # The old name never went free, so nobody else holds it when Bob
            # accepts - the host token reaches Alice.
            mallory, assigned = await self._lobby('alice', 'm')
            self.assertEqual(assigned['reason'], 'taken')
            await bob.send_json_to({'type': 'challenge_accept', 'challenger': 'alice', 'opponent': 'bob'})
            accepted = await _receive_until(alice, 'challenge_accepted')
            self.assertTrue(accepted['token'])
            self.assertNotIn('challenge_accepted', await _drain(mallory, 0.5))
        finally:
            for comm in (alice, bob, mallory):
                if comm:
                    await comm.disconnect()

    async def test_no_way_round_the_rename_lock_with_an_invite_out(self):
        alice, _ = await self._lobby('alice', 'a')
        bob, _ = await self._lobby('bob', 'b')
        try:
            await alice.send_json_to({'type': 'game_challenge', 'challenger': 'alice', 'opponent': 'bob'})
            await _receive_until(bob, 'game_challenge')

            # Setting yourself online over the invite is refused...
            await alice.send_json_to({'type': 'set_status', 'username': 'alice', 'status': 'online'})
            err = await _receive_until(alice, 'error')
            self.assertEqual(err['code'], 'INVALID_STATUS')
            row = await PlayerConnection.objects.aget(username='alice')
            self.assertEqual(row.status, 'invited')

            # ...and a repeat join, which does put the status back to online,
            # still leaves the invite holding the name.
            await alice.send_json_to({'type': 'join_lobby', 'username': 'alice', 'secret': 'a'})
            await _receive_until(alice, 'user_list')
            await alice.send_json_to({
                'type': 'change_username', 'oldUsername': 'alice', 'newUsername': 'alice2', 'secret': 'a'})
            err = await _receive_until(alice, 'error')
            self.assertEqual(err['code'], 'NAME_LOCKED')
            self.assertTrue(await PlayerConnection.objects.filter(username='alice').aexists())
            self.assertFalse(await PlayerConnection.objects.filter(username='alice2').aexists())
        finally:
            await alice.disconnect()
            await bob.disconnect()

    async def test_an_invite_nobody_answered_lets_go_of_the_name(self):
        alice, _ = await self._lobby('alice', 'a')
        bob, _ = await self._lobby('bob', 'b')
        try:
            await alice.send_json_to({'type': 'game_challenge', 'challenger': 'alice', 'opponent': 'bob'})
            await _receive_until(bob, 'game_challenge')
            await GameChallenge.objects.filter(challenger='alice').aupdate(
                expires_at=timezone.now() - timedelta(seconds=1))

            await alice.send_json_to({
                'type': 'change_username', 'oldUsername': 'alice', 'newUsername': 'alice2', 'secret': 'a'})
            changed = await _receive_until(alice, ('username_changed', 'error'))
            self.assertEqual(changed['type'], 'username_changed', changed)
            # And the invite it was is gone, so nothing can be accepted under
            # the name it freed.
            self.assertFalse(await GameChallenge.objects.filter(challenger='alice').aexists())
        finally:
            await alice.disconnect()
            await bob.disconnect()

    async def test_no_rename_in_a_game_room(self):
        game, host, opp, white, black = await _start_seated_game()
        try:
            await host.send_json_to({
                'type': 'change_username', 'oldUsername': 'alice', 'newUsername': 'alice2'})
            err = await _receive_until(host, 'error')
            self.assertEqual(err['code'], 'NAME_LOCKED')
            self.assertTrue(await PlayerConnection.objects.filter(username='alice').aexists())
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_a_socket_that_lost_its_name_no_longer_speaks_for_it(self):
        old_tab, _ = await self._lobby('carol', 's')
        watcher, _ = await self._lobby('watcher', 'w')
        new_tab, _ = await self._lobby('carol', 's', rejoining=True)
        try:
            await old_tab.send_json_to({'type': 'chat_message', 'content': 'still me?'})
            err = await _receive_until(old_tab, 'error')
            self.assertEqual(err['code'], 'NAME_RECLAIMED')
            await old_tab.send_json_to({
                'type': 'change_username', 'oldUsername': 'carol', 'newUsername': 'zed', 'secret': 's'})
            err = await _receive_until(old_tab, 'error')
            self.assertEqual(err['code'], 'NAME_RECLAIMED')

            seen = await _drain(new_tab, 0.5)
            self.assertNotIn('username_changed', seen)
            self.assertNotIn('chat_message', await _drain(watcher, 0.1))
            self.assertFalse(await PlayerConnection.objects.filter(username='zed').aexists())
        finally:
            for comm in (old_tab, watcher, new_tab):
                await comm.disconnect()

    async def test_a_dropped_players_name_is_held_through_the_grace_period(self):
        with patch('game.consumers.DISCONNECT_GRACE_SECONDS', 1):
            game = await GameRoom.objects.acreate(
                host='alice', opponent='bob', status='waiting',
                host_token='host-tok', opponent_token='opp-tok',
            )
            application = URLRouter(websocket_urlpatterns)
            host = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
            opp = WebsocketCommunicator(application, f"/ws/game/{game.game_id}/")
            # Joined as the client joins: with the browser's secret.
            for comm, name, token in ((host, 'alice', 'host-tok'), (opp, 'bob', 'opp-tok')):
                await comm.connect()
                await comm.send_json_to({
                    'type': 'join_game_room', 'username': name, 'gameId': game.game_id,
                    'token': token, 'secret': f'{name}-secret'})
                await _receive_until(comm, 'join_game_room_success')
            await _both_ready_then_start(host, opp, game.game_id)
            await _receive_until(host, 'game_started')
            await _receive_until(opp, 'game_started')

            await host.disconnect()   # alice drops out of her match
            stranger = owner = None
            try:
                stranger, assigned = await self._lobby('alice', 'not-alices-secret')
                self.assertEqual(assigned['reason'], 'taken')
                # Nobody is shown sitting behind the held name.
                await stranger.send_json_to({'type': 'request_user_list'})
                listed = await _receive_until(stranger, 'user_list')
                self.assertNotIn('alice', [u['username'] for u in listed['users']])

                # Her own browser may take it back from the lobby...
                owner, assigned = await self._lobby('alice', 'alice-secret')
                self.assertIsNone(assigned)
                row = await PlayerConnection.objects.aget(username='alice')
                self.assertNotEqual(row.channel_name, '')

                # ...which is not being back at the board: the forfeit stands.
                over = await _receive_until(opp, 'game_over', timeout=5)
                self.assertEqual(over['endReason'], 'disconnect')
            finally:
                for comm in (stranger, owner, opp):
                    if comm:
                        await comm.disconnect()

    async def test_her_room_takes_her_name_back_from_another_case(self):
        # Her row went - swept - and a stranger took the name in capitals.
        game, host, opp, white, black = await _start_seated_game()
        await PlayerConnection.objects.filter(username='alice').adelete()
        squatter, assigned = await self._lobby('ALICE', 'x')
        self.assertIsNone(assigned)
        rejoined = WebsocketCommunicator(
            URLRouter(websocket_urlpatterns), f"/ws/game/{game.game_id}/")
        await rejoined.connect()
        try:
            await rejoined.send_json_to({
                'type': 'join_game_room', 'username': 'alice', 'gameId': game.game_id,
                'token': 'host-tok'})
            await _receive_until(rejoined, 'join_game_room_success')
            self.assertFalse(await PlayerConnection.objects.filter(username='ALICE').aexists())
            await squatter.send_json_to({'type': 'chat_message', 'content': 'hi'})
            err = await _receive_until(squatter, 'error')
            self.assertEqual(err['code'], 'NAME_RECLAIMED')
        finally:
            for comm in (squatter, rejoined, host, opp):
                await comm.disconnect()


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
                await old.send_json_to({'type': 'resign'})
                stale_action = await _receive_until(old, 'error', timeout=5)
                self.assertEqual(stale_action['code'], 'STALE_GAME_SOCKET')
                state = await GameState.objects.aget(game_id=game.game_id)
                self.assertFalse(state.is_finished)

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

    async def test_a_swept_row_is_not_a_replacement(self):
        """
        The roster sweep deletes a row nobody has heartbeated for STALE_AFTER,
        and the socket behind it can still be open. Nobody replaced that
        socket, so it still plays - it used to be refused everything,
        resyncing included, until a reload.
        """
        game, host, opp, white, black = await _start_seated_game()
        try:
            mover = 'alice' if white is host else 'bob'
            await PlayerConnection.objects.filter(username=mover).adelete()

            await white.send_json_to({'type': 'pass_turn'})
            answer = await _receive_until(white, ('turn_passed', 'error'))
            self.assertEqual(answer['type'], 'turn_passed', answer)
            await white.send_json_to({'type': 'request_game_state'})
            answer = await _receive_until(white, ('game_state_update', 'error'))
            self.assertEqual(answer['type'], 'game_state_update', answer)
            self.assertEqual(answer['turnNumber'], 2)
        finally:
            await host.disconnect()
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

    def test_deleting_a_closed_room_cascades_its_draft_and_reports_rooms_not_all_rows(self):
        old = GameRoom.objects.create(host='alice', opponent='bob', status='closed',
                                     closed_at=timezone.now() - timedelta(days=8))
        state = GameState.objects.create(game=old, current_turn='alice', player_white='alice',
                                        player_black='bob', end_reason='resign', winner='bob')
        TurnDraft.objects.create(game=state, username='alice', turn_number=1, sequence=1, commands=[])
        live = GameRoom.objects.create(host='carol', opponent='dan', status='started')
        live_state = GameState.objects.create(game=live, current_turn='carol', player_white='carol', player_black='dan')
        TurnDraft.objects.create(game=live_state, username='carol', turn_number=1, sequence=1, commands=[])
        output = StringIO()
        call_command('cleanup_game_state', closed_days=7, stdout=output)
        self.assertFalse(GameRoom.objects.filter(pk=old.pk).exists())
        self.assertFalse(GameState.objects.filter(pk=old.pk).exists())
        self.assertFalse(TurnDraft.objects.filter(pk=old.pk).exists())
        self.assertTrue(TurnDraft.objects.filter(pk=live.pk).exists())
        self.assertIn('Deleted 1 old closed game rooms', output.getvalue())

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
    Deal the placeholder panel squads for the duration of a test.

    A new game stands in its panels what the config's setup puts there - the
    owner's base squads. These tests were written against the placeholder
    squads (one of each of five unit types, every third hex, all four panels),
    so they turn those on instead (``panels.PANELS_DEALT``) and keep their
    fixtures.
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
            self.assertEqual(landed['hp'], update['config']['units']['archer']['hp'])
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
        config = copy.deepcopy(state.config_snapshot)
        for unit in config['units'].values():
            unit.pop('veterancy', None)
        board = dict(state.board_state)
        board[at] = {'unit_id': 'pawn', 'color': 'white', 'hp': 20, 'max_hp': 20, 'uid': 'wtest'}
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            config_snapshot=config, board_state=board, turn_number=self.PAST_OPENING)

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
            self.assertEqual(record['damage_dealt'], 1)
            self.assertEqual(record['defenderHp'], 31)
            self.assertEqual(record['counter_damage'], 12)
            self.assertEqual(record['panel'], 'tl')
            self.assertEqual(made['boardState'][self.BESIDE_RESERVE]['hp'], 8)

            state = await GameState.objects.aget(game_id=game.game_id)
            # Unlike a crossing, a blow IS the turn's board action.
            self.assertEqual(state.turn_number, self.PAST_OPENING + 1)
            self.assertTrue(state.move_history[-1]['intoPanel'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    #: Turn 45, Overtime 2: two board moves a turn.
    OVERTIME_TWO = 89

    async def _stand_pawn_in_overtime(self, game, at):
        await self._stand_pawn(game, at)
        state = await GameState.objects.aget(game_id=game.game_id)
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            turn_number=self.OVERTIME_TWO, current_turn=state.player_white)

    @staticmethod
    def _white_king_hp(board):
        return next(u['hp'] for u in board.values()
                    if u['unit_id'] == 'king' and u['color'] == 'white')

    async def test_an_overtime_blow_can_hold_the_seat_for_the_next_unit(self):
        # A blow into a panel ended the turn outright, so the room sent it
        # alone - and every other move an overtime turn had staged was lost.
        from game.engine.phases import overtime_toll_at
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn_in_overtime(game, self.BESIDE_RESERVE)
            before = await GameState.objects.aget(game_id=game.game_id)
            await white.send_json_to({
                'type': 'panel_attack', 'more': True,
                'from': self.BESIDE_RESERVE, 'to': self.BESIDE_RESERVE,
                'attack': self.RESERVE_QUEEN,
            })
            held = await _receive_until(white, 'game_state_update')
            self.assertEqual(held['turnNumber'], self.OVERTIME_TWO)
            self.assertTrue(held['moveHistory'][-1]['intoPanel'])
            # The toll is the END of a turn's cost: none yet.
            self.assertEqual(self._white_king_hp(held['boardState']),
                             self._white_king_hp(before.board_state))

            await white.send_json_to({'type': 'make_move', 'from': '-5,9', 'to': '-5,8'})
            made = await _receive_until(white, 'move_made')
            self.assertEqual(made['turnNumber'], self.OVERTIME_TWO + 1)
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(board_moves_at(state.move_history, self.OVERTIME_TWO, 'white'), 2)
            # And taken once, for the two moves together.
            self.assertEqual(
                self._white_king_hp(state.board_state),
                self._white_king_hp(before.board_state) - overtime_toll_at(self.OVERTIME_TWO))
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_blow_after_a_held_move_ends_the_turn(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn_in_overtime(game, self.BESIDE_RESERVE)
            await white.send_json_to(
                {'type': 'make_move', 'from': '-5,9', 'to': '-5,8', 'more': True})
            await _receive_until(white, 'game_state_update')
            await white.send_json_to({
                'type': 'panel_attack',
                'from': self.BESIDE_RESERVE, 'to': self.BESIDE_RESERVE,
                'attack': self.RESERVE_QUEEN,
            })
            made = await _receive_until(white, 'move_made')
            self.assertTrue(made['move']['intoPanel'])
            self.assertEqual(made['turnNumber'], self.OVERTIME_TWO + 1)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_blow_is_one_of_the_turns_moves(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await self._stand_pawn_in_overtime(game, self.BESIDE_RESERVE)
            for move in ({'from': '-5,9', 'to': '-5,8'}, {'from': '-4,9', 'to': '-4,8'}):
                await white.send_json_to({'type': 'make_move', 'more': True, **move})
            await _receive_until(white, 'game_state_update')
            await _receive_until(white, 'game_state_update')
            # Both of Overtime 2's moves are spent, and the seat has gone.
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                turn_number=self.OVERTIME_TWO,
                current_turn=(await GameState.objects.aget(game_id=game.game_id)).player_white)
            await white.send_json_to({
                'type': 'panel_attack', 'more': True,
                'from': self.BESIDE_RESERVE, 'to': self.BESIDE_RESERVE,
                'attack': self.RESERVE_QUEEN,
            })
            err = await _receive_until(white, 'error')
            self.assertEqual(err['message'], 'That side has had all 2 of its moves this turn')
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

            self.assertEqual(made['move']['counter_damage'], 12)
            self.assertEqual(made['move']['panel'], 'tl')
            self.assertEqual(made['move']['defenderHp'], 31)
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
            await self._wind_to(game, 1)
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
            self.assertEqual(replies[1].get('message'), 'That side has had all 1 of its moves this turn')
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

            self.assertEqual(errors, ['That side has had all 3 of its moves this turn'])
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
            await _receive_until(white, 'game_state_update')
            state = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(state.turn_number, 89)

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


class FullMatchLiveIntegrationTests(TransactionTestCase):
    """Use the shipped deal and real turns rather than winding a match to its ending."""

    async def _play_match(self, capture):
        # The flood guard has its own live tests; accelerated full matches
        # need its burst allowance lifted without sleeping between actions.
        with patch('game.consumers.RATE_LIMIT_MAX_MESSAGES', 1000):
            game, host, opponent, white, black = await _start_seated_game()
            try:
                initial = await GameState.objects.aget(game_id=game.game_id)
                revision = initial.revision
                last_ply = 72 if capture else 100
                white_to = '-3,6' if capture else '-4,8'
                white_capture = 57 if capture else 3
                banks = {}
                for ply in range(1, last_ply + 1):
                    mover, other = (white, black) if ply % 2 else (black, white)
                    message = ({'type': 'make_move', 'from': '-4,9', 'to': white_to} if ply == 1
                               else {'type': 'make_move', 'from': '8,-10' if capture else '4,-9',
                                     'to': '7,-2' if capture else '4,-8'} if ply == 2 else {'type': 'pass_turn'})
                    await mover.send_json_to(message)
                    kind = 'move_made' if ply <= 2 else 'turn_passed'
                    sent = await _receive_until(mover, (kind, 'error'))
                    self.assertEqual(sent['type'], kind, sent)
                    received = await _receive_until(other, kind)
                    self.assertEqual(sent, received)
                    stored = await GameState.objects.aget(game_id=game.game_id)
                    self.assertEqual(received['turnNumber'], ply + 1)
                    self.assertEqual(received['revision'], revision + 1)
                    revision = received['revision']
                    self.assertEqual(stored.revision, revision)
                    self.assertEqual(received['boardState'], stored.board_state)
                    self.assertEqual(received['phaseBank'], stored.phase_bank)
                    if ply + 1 in (27, 49, 71):
                        phase = {27: 1, 49: 2, 71: 3}[ply + 1]
                        banks[str(phase)] = {'white': white_capture * phase, 'black': (1 if capture else 3) * phase}
                    self.assertEqual(stored.phase_bank, banks)
                    if ply + 1 in (7, 27, 49, 71):
                        self.assertEqual(stored.board_state[white_to]['vet'],
                                         {7: 1, 27: 2, 49: 3, 71: 3}[ply + 1])
                    if ply + 1 in (17, 39, 61):
                        expected_up = 10 + {17: 1, 39: 3, 61: 6}[ply + 1] * white_capture
                        self.assertEqual(economy.unit_points_of('white', stored.move_history,
                                                               stored.config_snapshot), expected_up)
                        self.assertEqual(economy.unit_points_of('black', stored.move_history,
                                                               stored.config_snapshot), 10 + {17: 1, 39: 3, 61: 6}[ply + 1] * (1 if capture else 3))
                    if ply == 38:
                        await black.send_json_to({'type': 'request_game_state'})
                        restored = await _receive_until(black, 'game_state_update')
                        self.assertEqual(restored['moveHistory'], stored.move_history)
                        self.assertEqual(restored['phaseBank'], banks)
                        self.assertEqual(restored['revision'], revision)
                    if ply < last_ply:
                        self.assertEqual(received['currentTurn'],
                                         initial.player_black if ply % 2 else initial.player_white)
                self.assertEqual(received['currentTurn'], '')
                expected_reason = 'points' if capture else 'overtime'
                expected_winner = initial.player_white if capture else initial.player_black
                for socket in (white, black):
                    result = await _receive_until(socket, 'game_over')
                    self.assertEqual(result['endReason'], expected_reason)
                    self.assertEqual(result['winner'], expected_winner)
                    self.assertEqual(result['revision'], revision)
                    await socket.send_json_to({'type': 'request_game_state'})
                    restored = await _receive_until(socket, 'game_state_update')
                    self.assertEqual(restored['endReason'], expected_reason)
                    self.assertEqual(restored['winner'], expected_winner)
                    self.assertEqual(restored['turnNumber'], last_ply + 1)
                    self.assertEqual(restored['boardState'], stored.board_state)
                    self.assertEqual(restored['moveHistory'], stored.move_history)
                self.assertEqual(stored.end_reason, expected_reason)
                self.assertEqual(stored.winner, expected_winner)
                if not capture:
                    kings = [unit['hp'] for unit in stored.board_state.values()
                             if unit['unit_id'] == 'king']
                    self.assertEqual(kings, [32, 32])
            finally:
                await host.disconnect()
                await opponent.disconnect()

    async def test_shipped_match_scores_promotes_awards_up_and_finishes_after_all_72_plies(self):
        await self._play_match(capture=True)

    async def test_shipped_draw_runs_all_100_plies_and_pays_every_overtime_toll(self):
        await self._play_match(capture=False)


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
                '1': {'white': 51, 'black': 0}, '2': {'white': 0, 'black': 0}})
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
            # sides, so its draw leaves White's existing 51-point lead intact.
            self.assertEqual(stored.phase_bank['3']['white'], stored.phase_bank['3']['black'])
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_a_close_match_goes_on_into_overtime(self):
        game, host_comm, opp_comm, white, black = await _start_seated_game()
        try:
            await self._wind(game, 70, bank={
                '1': {'white': 50, 'black': 0}, '2': {'white': 0, 'black': 0}})
            passed = await self._pass(black, white)
            self.assertIn('3', passed['phaseBank'])
            await self._pass(white, black)
            passed = await self._pass(black, white)
            # Fifty clear is not more than fifty: nobody has it outright, and
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
                '1': {'white': 51, 'black': 0, 'late': True}, '2': {'white': 0, 'black': 0}})
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
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                end_reason='resign', winner=state.player_black,
                revision=F('revision') + 1,
            )
            finished = await GameState.objects.aget(game_id=game.game_id)
            await GameConsumer()._create_game_state(
                game.game_id, state.board_state, state.player_white,
                state.player_white, state.player_black, state.config_snapshot,
                expected_revision=finished.revision, expected_end_reason='resign')
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.phase_bank, {})
            self.assertEqual(stored.turn_number, 1)
        finally:
            await host_comm.disconnect()
            await opp_comm.disconnect()

    async def test_capture_permissions_and_center_control_are_banked_and_resynced(self):
        from game.engine.config_loader import DEFAULT_CONFIG
        for enemy, expected in (('pawn', {'white': 38, 'black': 0}), ('rook', {'white': 12, 'black': 2})):
            game, host, opp, white, black = await _start_seated_game()
            try:
                state = await self._wind(game, 26)
                board = {
                    '-10,0': {'unit_id': 'king', 'color': 'white', 'hp': 60, 'max_hp': 60, 'uid': 'wk'},
                    '10,0': {'unit_id': 'king', 'color': 'black', 'hp': 60, 'max_hp': 60, 'uid': 'bk'},
                    '0,0': {'unit_id': 'bishop', 'color': 'white', 'hp': 8, 'max_hp': 8, 'uid': 'wb'},
                    '2,0': {'unit_id': enemy, 'color': 'black', 'hp': 12, 'max_hp': 12, 'uid': 'be'},
                }
                await GameState.objects.filter(game_id=game.game_id).aupdate(
                    board_state=board, config_snapshot=DEFAULT_CONFIG)
                passed = await self._pass(black, white)
                self.assertEqual(passed['phaseBank']['1'], expected, enemy)
                stored = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual(stored.phase_bank['1'], expected)
                self.assertEqual(passed['revision'], stored.revision)
                await white.send_json_to({'type': 'request_game_state'})
                full = await _receive_until(white, 'game_state_update')
                self.assertEqual(full['phaseBank']['1'], expected)
            finally:
                await host.disconnect()
                await opp.disconnect()

    async def test_halftime_up_snapshots_are_written_broadcast_and_resynced_once(self):
        for phase, ply in ((1, 17), (2, 39), (3, 61)):
            game, host, opp, white, black = await _start_seated_game()
            try:
                await self._wind(game, ply - 1)
                board = {
                    '-10,0': dict(unit_id='king', color='white', hp=60, max_hp=60, uid='wk'),
                    '10,0': dict(unit_id='king', color='black', hp=60, max_hp=60, uid='bk'),
                    '-3,6': dict(unit_id='pawn', color='white', hp=12, max_hp=12, uid='wp'),
                    '7,0': dict(unit_id='rook', color='black', hp=40, max_hp=40, uid='br'),
                }
                await GameState.objects.filter(game_id=game.game_id).aupdate(board_state=board)
                if phase == 2:
                    await black.send_json_to({'type': 'make_move', 'from': '10,0', 'to': '10,-1'})
                    await _receive_until(black, 'move_made')
                    handed = await _receive_until(white, 'move_made')
                else:
                    handed = await self._pass(black, white)
                award = {'turn': ply, 'halftimeUp': {'phase': phase, 'white': 57 * phase, 'black': 19 * phase}}
                self.assertEqual(handed['effects'], [award])
                stored = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual(stored.move_history[-1], award)
                self.assertEqual(handed['revision'], stored.revision)
                for comm in (white, black):
                    await comm.send_json_to({'type': 'request_game_state'})
                    full = await _receive_until(comm, 'game_state_update')
                    self.assertEqual(full['moveHistory'][-1], award)
                await GameState.objects.filter(game_id=game.game_id).aupdate(
                    board_state={key: unit for key, unit in board.items() if unit['unit_id'] == 'king'})
                await self._pass(white, black)
                stored = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual([m for m in stored.move_history if m.get('halftimeUp')], [award])
                self.assertEqual(economy.unit_points_of('white', stored.move_history, stored.config_snapshot),
                                 10 + 57 * phase)
                self.assertEqual(economy.unit_points_of('black', stored.move_history, stored.config_snapshot),
                                 10 + 19 * phase)
                self.assertNotIn(str(phase), stored.phase_bank)
            finally:
                await host.disconnect()
                await opp.disconnect()

    async def test_phase_three_full_heals_are_written_broadcast_and_resynced(self):
        game, host, opp, white, black = await _start_seated_game()
        try:
            state = await self._wind(game, 70)
            config = copy.deepcopy(DEFAULT_CONFIG)
            config['setup']['white']['11,1'] = 'pawn'
            pawn = dict(unit_id='pawn', uid='w11,1', color='white', hp=1, max_hp=12)
            history = [dict(turn=60, intoPanel=True, panelEffect=True, panel='br',
                            unit=pawn, attackedHex='11,1', defenderHp=1)]
            board = {k: {**v, 'hp': 1} for k, v in state.board_state.items()}
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                config_snapshot=config, board_state=board, move_history=history)
            passed = await self._pass(black, white)
            self.assertEqual(passed['turnNumber'], 71)
            self.assertTrue(all(v['hp'] == v['max_hp'] for v in passed['boardState'].values()))
            self.assertEqual(len(passed['effects']), 1)
            self.assertEqual(passed['effects'][0]['unit']['uid'], 'w11,1')
            self.assertEqual(passed['effects'][0]['defenderHp'], 12)
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.move_history, [*history, *passed['effects']])
            self.assertEqual(stored.board_state, passed['boardState'])
            self.assertEqual(stored.revision, passed['revision'])
            await white.send_json_to({'type': 'request_game_state'})
            full = await _receive_until(white, 'game_state_update')
            self.assertEqual(full['moveHistory'], stored.move_history)
            self.assertEqual(full['boardState'], passed['boardState'])
            again = await self._pass(white, black)
            self.assertNotIn('effects', again)
        finally:
            await host.disconnect()
            await opp.disconnect()

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

    async def test_regular_points_cannot_pay_for_a_wrap_when_up_is_short(self):
        game, host, opp, white, black = await _start_seated_game()
        try:
            await GameState.objects.filter(game_id=game.game_id).aupdate(turn_number=31)
            state = await GameState.objects.aget(game_id=game.game_id)
            tip = panels.wrap_tips('white', state.config_snapshot['board']['radius'])['reserve']
            self.assertEqual(economy.unit_points_of('white', [], state.config_snapshot), 10)
            self.assertGreaterEqual(economy.points_of('white', state.turn_number, [], state.config_snapshot),
                                    state.config_snapshot['units']['knight']['value'])
            await white.send_json_to({'type': 'panel_move', 'from': self.KNIGHT_AT, 'to': tip})
            refused = await _receive_until(white, ('error', 'game_state_update'))
            self.assertEqual(refused['type'], 'error')
            self.assertEqual(refused['code'], 'INVALID_MOVE')
            stored = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(stored.move_history, [])
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_the_wrap_is_paid_for_in_up_and_the_price_comes_off(self):
        game, host_comm, opp_comm, white, _black = await _start_seated_game()
        try:
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                turn_number=self.WRAP_OPEN_PLY)
            state = await GameState.objects.aget(game_id=game.game_id)
            config = state.config_snapshot
            config['rules']['upAtStart'] = config['units']['knight']['value']
            await GameState.objects.filter(game_id=game.game_id).aupdate(config_snapshot=config)
            state = await GameState.objects.aget(game_id=game.game_id)
            radius = state.config_snapshot['board']['radius']
            tip = panels.wrap_tips('white', radius)['reserve']
            before = economy.unit_points_of('white', state.move_history, state.config_snapshot)
            self.assertEqual(before, config['units']['knight']['value'])

            await white.send_json_to({'type': 'panel_move', 'from': self.KNIGHT_AT, 'to': tip})
            wrapped = await _receive_until(white, 'game_state_update')
            record = wrapped['moveHistory'][-1]
            self.assertEqual(record['price'], state.config_snapshot['units']['knight']['value'])
            self.assertEqual(record['panel'], 'bl')    # it began in the base

            after = economy.unit_points_of('white', wrapped['moveHistory'], wrapped['config'])
            self.assertEqual(after, before - state.config_snapshot['units']['knight']['value'])

            self.assertEqual(economy.points_of('white', self.WRAP_OPEN_PLY,
                                              wrapped['moveHistory'], wrapped['config']), 34)
            # There is no UP left for a second crossing.
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
            for uid in ('rbr0',):
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
            for uid in ('rbr0', 'rbr1', 'rbr2'):
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
                turn_number=1, config_snapshot=config)

            await self._step_once(game, white, 'rbr0')
            await _receive_until(white, 'game_state_update')
            # Planned as if the room allowed the default five, so the step
            # asked for is a real one and only the room's one refuses it.
            await self._step_once(game, white, 'rbr1')
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


class HealingLiveIntegrationTests(TransactionTestCase):
    """Normal unit healing uses the same authoritative commit as a strike."""

    async def _position(self, game, ply=7):
        state = await GameState.objects.aget(game_id=game.game_id)
        config = copy.deepcopy(state.config_snapshot)
        config['units']['bishop']['heal'] = [14, 13, 12, 11]
        board = {
            '0,0': {'unit_id': 'bishop', 'color': 'white', 'hp': 22, 'max_hp': 22, 'uid': 'healer'},
            '3,0': {'unit_id': 'rook', 'color': 'white', 'hp': 5, 'max_hp': 50, 'uid': 'friend'},
            '0,1': {'unit_id': 'pawn', 'color': 'black', 'hp': 20, 'max_hp': 20, 'uid': 'enemy'},
            '-6,0': {'unit_id': 'king', 'color': 'white', 'hp': 45, 'max_hp': 45, 'uid': 'wk'},
            '6,0': {'unit_id': 'king', 'color': 'black', 'hp': 45, 'max_hp': 45, 'uid': 'bk'},
        }
        await GameState.objects.filter(game_id=game.game_id).aupdate(
            board_state=board, config_snapshot=config, turn_number=ply, current_turn=state.player_white, move_history=[])
        return await GameState.objects.aget(game_id=game.game_id)

    async def test_walk_then_heal_is_authoritative_on_both_sockets_and_reload(self):
        game, host, opp, white, black = await _start_seated_game()
        try:
            state = await self._position(game)
            # Ring 2 AFTER the walk, not ring 3 from where the bishop began.
            await white.send_json_to({
                'type': 'make_move', 'from': '0,0', 'to': '1,0', 'heal': '3,0',
                'healed_amount': 999, 'healed_hp': 999, 'counters': True,
            })
            made = await _receive_until(white, 'move_made')
            other = await _receive_until(black, 'move_made')
            self.assertEqual(made['boardState'], other['boardState'])
            self.assertEqual(made['revision'], state.revision + 1)
            self.assertEqual(made['move']['healed_amount'], 13)
            self.assertEqual(made['move']['healed_hp'], 18)
            self.assertEqual(made['move']['healed_unit'], 'rook')
            self.assertFalse(made['move']['attacked'])
            self.assertNotIn('attackedHex', made['move'])
            self.assertNotIn('counter_damage', made['move'])
            self.assertEqual(made['boardState']['1,0']['hp'], 24)
            self.assertNotIn('0,0', made['boardState'])
            self.assertEqual(made['turnNumber'], 8)
            self.assertEqual(made['currentTurn'], state.player_black)
            saved = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(saved.move_history[-1], made['move'])
            await black.send_json_to({'type': 'request_game_state', 'gameId': game.game_id})
            snapshot = await _receive_until(black, 'game_state_update')
            self.assertEqual(snapshot['boardState']['3,0']['hp'], 18)
            self.assertEqual(snapshot['moveHistory'][-1]['healedHex'], '3,0')
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_postmatches_allow_healing_on_both_seats_but_refuse_normal_attacks(self):
        game, host, opp, white, black = await _start_seated_game()
        try:
            for ply in (27, 28, 49, 50, 71, 72):
                state = await self._position(game, ply)
                color = 'white' if ply % 2 else 'black'
                actor, other = (white, black) if color == 'white' else (black, white)
                board = copy.deepcopy(state.board_state)
                board['0,0']['color'] = color
                board['3,0']['color'] = color
                board['0,1']['color'] = 'black' if color == 'white' else 'white'
                board['1,1'] = {'unit_id': 'pawn', 'color': color, 'hp': 12, 'max_hp': 12, 'uid': 'attacker'}
                await GameState.objects.filter(game_id=game.game_id).aupdate(
                    board_state=board, current_turn=state.player_white if color == 'white' else state.player_black)
                for action in ({'to': '1,1', 'attack': '0,1'}, {'to': '0,1'}):
                    await actor.send_json_to({'type': 'make_move', 'from': '1,1', **action})
                    error = await _receive_until(actor, ('error', 'move_made'))
                    self.assertEqual(error['type'], 'error', (ply, action))
                    self.assertEqual(error['code'], 'INVALID_MOVE')
                    saved = await GameState.objects.aget(game_id=game.game_id)
                    self.assertEqual(saved.revision, state.revision)
                    self.assertEqual(saved.board_state, board)
                await actor.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '1,0', 'heal': '3,0'})
                made = await _receive_until(actor, ('move_made', 'error'))
                self.assertEqual(made['type'], 'move_made', ply)
                broadcast = await _receive_until(other, 'move_made')
                self.assertEqual(made['boardState'], broadcast['boardState'])
                self.assertEqual(made['revision'], state.revision + 1)
                self.assertEqual(made['boardState']['3,0']['hp'], 18)
                self.assertFalse(made['move']['attacked'])
                await other.send_json_to({'type': 'request_game_state', 'gameId': game.game_id})
                restored = await _receive_until(other, 'game_state_update')
                self.assertEqual(restored['boardState']['3,0']['hp'], 18)
                self.assertEqual(restored['moveHistory'][-1]['healedHex'], '3,0')
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_bad_heals_and_healer_attacks_leave_the_state_untouched(self):
        game, host, opp, white, _black = await _start_seated_game()
        try:
            state = await self._position(game)
            bad = [
                {'heal': '0,0'}, {'heal': '0,1'}, {'heal': '6,0'}, {'heal': '-6,0'}, {'heal': '2,0'},
                {'heal': '12,-4'}, {'heal': 'bogus'}, {'heal': 123},
                {'heal': '3,0', 'attack': '6,0'}, {'heal': '3,0', 'withdraw': True},
                {'attack': '6,0'},
                # A non-healer is never allowed to restore HP by naming an ally.
                {'from': '3,0', 'to': '3,0', 'heal': '0,0'},
                # Refused after a legal walk must not keep the walk either.
                {'to': '1,0', 'heal': '6,0'},
            ]
            for change in bad:
                await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,0', **change})
                error = await _receive_until(white, ('error', 'move_made'))
                self.assertEqual(error['type'], 'error', change)
                self.assertEqual(error['code'], 'INVALID_MOVE', change)
                saved = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual(saved.revision, state.revision, change)
                self.assertEqual(saved.board_state, state.board_state, change)
                self.assertEqual(saved.move_history, [], change)
            for ply in (1, 2, 5, 6):
                state = await self._position(game, ply)
                await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '1,0', 'heal': '3,0'})
                self.assertEqual((await _receive_until(white, 'error'))['code'], 'INVALID_MOVE')
                self.assertEqual((await GameState.objects.aget(game_id=game.game_id)).board_state, state.board_state)
        finally:
            await host.disconnect()
            await opp.disconnect()

    async def test_healing_caps_hp_and_keeps_overtime_action_and_toll_rules(self):
        game, host, opp, white, _black = await _start_seated_game()
        try:
            state = await self._position(game, 89)
            board = dict(state.board_state)
            board['-6,0']['hp'] = 1
            board['-3,0'] = board.pop('3,0')
            board['-3,0']['hp'] = 48
            board['-3,0']['max_hp'] = 50
            await GameState.objects.filter(game_id=game.game_id).aupdate(board_state=board)
            await white.send_json_to({
                'type': 'make_move', 'from': '0,0', 'to': '-2,0', 'heal': '-3,0', 'more': True,
            })
            held = await _receive_until(white, 'game_state_update')
            self.assertEqual(held['moveHistory'][-1]['healed_amount'], 2)
            self.assertEqual(held['boardState']['-3,0']['hp'], 50)
            self.assertEqual(held['boardState']['-6,0']['hp'], 1)
            self.assertEqual(held['turnNumber'], 89)
            await white.send_json_to({'type': 'make_move', 'from': '-2,0', 'to': '-2,0', 'heal': '-3,0'})
            self.assertEqual((await _receive_until(white, 'error'))['code'], 'INVALID_MOVE')
            # Another unit finishes the turn; it does not get a free heal.
            await white.send_json_to({'type': 'make_move', 'from': '-3,0', 'to': '-3,1'})
            made = await _receive_until(white, 'move_made')
            self.assertNotIn('-6,0', made['boardState'])  # one toll at the turn's end
        finally:
            await host.disconnect()
            await opp.disconnect()


class UnitStatsLiveIntegrationTests(TransactionTestCase):
    async def test_wire_bonuses_and_forged_cast_effects_cannot_change_online_rules(self):
        game, host, opponent, white, black = await _start_seated_game()
        try:
            state = await GameState.objects.aget(game_id=game.game_id)
            board = {
                '0,0': dict(unit_id='pawn', color='white', hp=14, max_hp=14, uid='actor', vet=1),
                '1,0': dict(unit_id='pawn', color='black', hp=14, max_hp=14, uid='target', vet=1),
                '-8,0': dict(unit_id='king', color='white', hp=60, max_hp=60, uid='wk', vet=1),
                '8,0': dict(unit_id='king', color='black', hp=60, max_hp=60, uid='bk', vet=1),
            }
            await GameState.objects.filter(game_id=game.game_id).aupdate(
                board_state=board, turn_number=9, current_turn=state.player_white, move_history=[])
            forged = {
                'moveBonus': 999,
                'bonuses': {'atk': 999, 'def': 999, 'targetAtkSet': 0, 'targetDefSet': 0,
                            'nullify': True, 'invulnerable': True},
                'effectsBefore': [{'at': '8,0', 'uid': 'bk', 'hp': 0,
                                   'unitCast': {'id': 'king-call', 'uid': 'actor', 'cost': 0}}],
                'effects': [{'at': '1,0', 'uid': 'target', 'hp': 0}],
            }
            await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,9', **forged})
            refused = await _receive_until(white, 'error')
            self.assertEqual(refused['code'], 'INVALID_MOVE')
            saved = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(saved.revision, state.revision)
            self.assertEqual(saved.board_state, board)
            self.assertEqual(saved.move_history, [])

            await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,0',
                                      'attack': '1,0', **forged})
            made = await _receive_until(white, 'move_made')
            self.assertEqual(made, await _receive_until(black, 'move_made'))
            self.assertEqual(made['move']['damage_dealt'], 2)
            self.assertEqual(made['move']['counter_damage'], 2)
            self.assertEqual(made['boardState']['0,0']['hp'], 12)
            self.assertEqual(made['boardState']['1,0']['hp'], 12)
            self.assertEqual(made['boardState']['8,0']['hp'], 60)
            self.assertNotIn('effectsBefore', made)
            saved = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(saved.move_history, [made['move']])
            self.assertEqual(saved.end_reason, '')

            await black.send_json_to({'type': 'pass_turn', **forged})
            passed = await _receive_until(black, 'turn_passed')
            self.assertEqual(passed, await _receive_until(white, 'turn_passed'))
            self.assertEqual(passed['boardState']['8,0']['hp'], 60)
            saved = await GameState.objects.aget(game_id=game.game_id)
            self.assertEqual(saved.move_history, [made['move']])
            self.assertEqual(saved.revision, state.revision + 2)
        finally:
            await host.disconnect()
            await opponent.disconnect()

    async def test_minimum_range_and_non_attackers_are_authoritative_after_movement(self):
        game, host, opp, white, _black = await _start_seated_game()
        try:
            state = await GameState.objects.aget(game_id=game.game_id)
            config = copy.deepcopy(state.config_snapshot)
            config['units']['dummy'] = {'hp': 99, 'move': 0, 'attack': 0,
                                        'defense': 0, 'value': 0, 'attackRange': 1}

            async def position(actor, target, distance, friendly=False):
                board = {
                    '0,0': {'unit_id': actor, 'color': 'white', 'hp': config['units'][actor]['hp'],
                            'max_hp': config['units'][actor]['hp'], 'uid': 'actor'},
                    f'{distance},0': {'unit_id': target, 'color': 'white' if friendly else 'black',
                                     'hp': 1 if friendly else 99, 'max_hp': 99, 'uid': 'target'},
                    '-8,0': {'unit_id': 'king', 'color': 'white', 'hp': 60, 'max_hp': 60, 'uid': 'wk'},
                    '8,0': {'unit_id': 'king', 'color': 'black', 'hp': 60, 'max_hp': 60, 'uid': 'bk'},
                }
                await GameState.objects.filter(game_id=game.game_id).aupdate(
                    board_state=board, config_snapshot=config, turn_number=7,
                    current_turn=state.player_white, move_history=[])
                return await GameState.objects.aget(game_id=game.game_id)

            cases = [('archer', ring, '0,0') for ring in (1, 2, 7)]
            cases += [('archer', 3, '1,0'), ('shieldman', 1, '0,0')]
            for actor, ring, to in cases:
                before = await position(actor, 'dummy', ring)
                await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': to, 'attack': f'{ring},0'})
                error = await _receive_until(white, ('error', 'move_made'))
                self.assertEqual(error['type'], 'error', (actor, ring, to))
                self.assertEqual(error['code'], 'INVALID_MOVE')
                saved = await GameState.objects.aget(game_id=game.game_id)
                self.assertEqual(saved.revision, before.revision)
                self.assertEqual(saved.board_state, before.board_state)
            for ring, damage in ((3, 4), (4, 3), (5, 2), (6, 1)):
                await position('archer', 'dummy', ring)
                await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': f'{ring},0'})
                made = await _receive_until(white, 'move_made')
                self.assertEqual(made['move']['damage_dealt'], damage)
                self.assertEqual(made['boardState'][f'{ring},0']['hp'], 99 - damage)
                self.assertEqual(made['move']['counter_damage'], 0)
            await position('archer', 'dummy', 2)
            await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '-1,0', 'attack': '2,0'})
            self.assertEqual((await _receive_until(white, 'move_made'))['move']['damage_dealt'], 4)
            for target in ('archer', 'shieldman'):
                await position('pawn', target, 1)
                await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '1,0'})
                made = await _receive_until(white, 'move_made')
                self.assertEqual(made['move']['counter_damage'], 0, target)
            for ring in (1, 2):
                await position('bishop', 'rook', ring, friendly=True)
                await white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,0', 'heal': f'{ring},0'})
                reply = await _receive_until(white, ('error', 'move_made'))
                self.assertEqual(reply['move']['healed_amount'], 8 if ring == 1 else 6)
                self.assertEqual(reply['boardState'][f'{ring},0']['hp'], 9 if ring == 1 else 7)
        finally:
            await host.disconnect()
            await opp.disconnect()
