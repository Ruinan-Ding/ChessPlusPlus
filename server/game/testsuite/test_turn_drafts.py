import asyncio
import copy
import json
from datetime import timedelta
from unittest.mock import patch

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.test import TransactionTestCase
from django.utils import timezone

from game.consumers import GameConsumer, _pending_turn_timers
from game.engine import panels
from game.engine.board import HEX_DIRECTIONS
from game.engine.config_loader import DEFAULT_CONFIG
from game.engine.economy import unit_points_of
from game.models import GameRoom, GameState, PlayerConnection, TurnDraft
from game.routing import websocket_urlpatterns
from game.testsuite.test_consumers import _start_seated_game, _receive_until, _drain
from game.validators import ValidationError


class TurnDraftTests(TransactionTestCase):
    def setUp(self):
        self.game = GameRoom.objects.create(host='alice', opponent='bob', status='started')
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['rules']['turnTimeLimit'] = 0
        self.state = GameState.objects.create(
            game=self.game, player_white='alice', player_black='bob', current_turn='alice',
            turn_number=7, revision=1, config_snapshot=config, turn_started_at=timezone.now(),
            board_state={
                '-8,0': {'unit_id': 'king', 'color': 'white', 'uid': 'wk', 'hp': 60, 'max_hp': 60},
                '8,0': {'unit_id': 'king', 'color': 'black', 'uid': 'bk', 'hp': 60, 'max_hp': 60},
                '0,0': {'unit_id': 'pawn', 'color': 'white', 'uid': 'wp', 'hp': 12, 'max_hp': 12},
            })
        self.consumer = GameConsumer()
        self.consumer.game_id = self.game.game_id
        self.consumer.username = 'alice'
        self.consumer.room_group_name = f'game_{self.game.game_id}'
        self.consumer.channel_name = 'test-draft'
        self.messages = []

        async def send(text_data=None, **kwargs):
            self.messages.append(json.loads(text_data))

        async def group_send(group, message):
            self.messages.append(message['data'])

        self.consumer.send = send
        self.consumer.channel_layer = type('Layer', (), {'group_send': staticmethod(group_send)})()

    def request(self, commands=None, sequence=1, kind='save_turn_draft'):
        return {'type': kind, 'gameId': self.game.game_id, 'turnNumber': 7, 'revision': 1,
                'sequence': sequence, 'commands': commands if commands is not None else [
                    {'type': 'make_move', 'from': '0,0', 'to': '1,0'}]}

    async def test_saving_is_private_and_does_not_change_committed_state(self):
        await self.consumer._handle_save_turn_draft(self.request())
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual(state.board_state, self.state.board_state)
        self.assertEqual((state.turn_number, state.revision), (7, 1))
        self.assertEqual(self.messages, [{'type': 'turn_draft_saved', 'turnNumber': 7, 'sequence': 1}])
        await self.consumer._handle_request_game_state({})
        self.assertEqual(self.messages[-1]['turnDraft']['commands'], self.request()['commands'])
        self.consumer.username = 'bob'
        await self.consumer._handle_request_game_state({})
        self.assertNotIn('turnDraft', self.messages[-1])

    async def test_commit_is_one_revision_and_cannot_replay_in_the_opponent_turn(self):
        await self.consumer._handle_save_turn_draft(self.request(kind='commit_turn'))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.current_turn, state.revision), (8, 'bob', 2))
        self.assertNotIn('0,0', state.board_state)
        self.assertEqual(state.board_state['1,0']['uid'], 'wp')
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        await self.consumer._handle_save_turn_draft(self.request(kind='commit_turn'))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.revision), (8, 2))

    async def test_undo_to_empty_replaces_the_draft_and_timeout_passes(self):
        await self.consumer._handle_save_turn_draft(self.request())
        await self.consumer._handle_save_turn_draft(self.request([], 2))
        draft = await TurnDraft.objects.aget(pk=self.game.game_id)
        self.assertEqual(draft.commands, [])
        self.assertTrue(await self.consumer._commit_saved_draft(self.state, draft, True))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertIn('0,0', state.board_state)
        self.assertEqual(state.turn_number, 8)

    async def test_invalid_later_command_cannot_save_or_commit_a_legal_prefix(self):
        await GameState.objects.filter(pk=self.game.game_id).aupdate(turn_number=89,
            phase_bank={str(phase): {'white': 3 * phase, 'black': 3 * phase} for phase in (1, 2, 3)})
        commands = [
            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'more': True},
            {'type': 'make_move', 'from': '-8,0', 'to': '90,90'},
        ]
        with self.assertRaises(ValidationError):
            await self.consumer._handle_save_turn_draft(dict(self.request(commands, kind='commit_turn'), turnNumber=89))
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.board_state, state.move_history, state.revision), (self.state.board_state, [], 1))

    async def test_forged_bonuses_hp_and_casts_are_not_part_of_the_draft(self):
        command = dict(self.request()['commands'][0], moveBonus=999, bonuses={'atk': 999},
                       effects=[{'at': '8,0', 'hp': 0}], username='bob')
        await self.consumer._handle_save_turn_draft(self.request([command], kind='commit_turn'))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual(state.board_state['8,0']['hp'], 60)
        self.assertFalse(state.is_finished)
        self.assertEqual(state.revision, 2)

    async def test_stale_sequence_cannot_replace_newer_moves(self):
        await self.consumer._handle_save_turn_draft(self.request(sequence=2))
        await self.consumer._handle_save_turn_draft(self.request([], 1))
        self.assertEqual((await TurnDraft.objects.aget(pk=self.game.game_id)).commands, self.request()['commands'])

    async def test_wrong_room_inactive_seat_and_stale_revision_cannot_save(self):
        other = await GameRoom.objects.acreate(host='alice', opponent='bob')
        data = dict(self.request(), gameId=other.game_id)
        await self.consumer._handle_save_turn_draft(data)
        self.assertEqual(self.messages[-1]['code'], 'NOT_IN_GAME_ROOM')
        self.consumer.username = 'bob'
        await self.consumer._handle_save_turn_draft(self.request())
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        self.consumer.username = 'alice'
        await self.consumer._handle_save_turn_draft(dict(self.request(), revision=0))
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())

    async def test_newer_draft_and_board_revision_both_guard_the_commit(self):
        await self.consumer._handle_save_turn_draft(self.request())
        old = await TurnDraft.objects.aget(pk=self.game.game_id)
        await self.consumer._handle_save_turn_draft(self.request([], 2))
        self.assertIsNone(await self.consumer._commit_saved_draft(self.state, old, True))
        current = await TurnDraft.objects.aget(pk=self.game.game_id)
        await GameState.objects.filter(pk=self.game.game_id).aupdate(revision=2, draw_offered_by='bob')
        self.assertIsNone(await self.consumer._commit_saved_draft(self.state, current, True))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertTrue(await self.consumer._commit_saved_draft(state, current, True))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.revision), (8, 3))

    async def test_restored_timer_commits_a_disconnected_players_persisted_moves(self):
        await self.consumer._handle_save_turn_draft(self.request())
        await PlayerConnection.objects.acreate(username='bob', channel_name='bob-socket', status='in-game')
        restored = GameConsumer()
        restored.game_id = self.game.game_id
        restored.channel_layer = self.consumer.channel_layer
        restored.channel_name = 'timer-restored'
        await restored._start_turn_timer(self.game.game_id, 1, turn_number=7, current_turn='alice',
                                         turn_started_at=timezone.now() - timedelta(seconds=2))
        for _ in range(100):
            state = await GameState.objects.aget(pk=self.game.game_id)
            if state.turn_number == 8:
                break
            await asyncio.sleep(.01)
        self.assertEqual((state.turn_number, state.current_turn), (8, 'bob'))
        self.assertEqual(state.board_state['1,0']['uid'], 'wp')
        snapshot = next(m for m in self.messages if m.get('committedTurn') == 7)
        self.assertTrue(snapshot['timedOut'])
        self.assertEqual(snapshot['revision'], state.revision)

    async def test_invalid_saved_draft_is_discarded_without_applying_any_prefix(self):
        commands = [{'type': 'make_move', 'from': '0,0', 'to': '90,90'}]
        draft = await TurnDraft.objects.acreate(game_id=self.game.game_id, username='alice', turn_number=7,
                                               sequence=1, commands=commands)
        self.assertFalse(await self.consumer._commit_saved_draft(self.state, draft, True))
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.board_state, state.move_history, state.revision), (self.state.board_state, [], 1))

    async def test_invalid_older_draft_cannot_discard_or_pass_over_its_valid_replacement(self):
        old = await TurnDraft.objects.acreate(game_id=self.game.game_id, username='alice', turn_number=7,
            sequence=1, commands=[{'type': 'make_move', 'from': '0,0', 'to': '90,90'}])
        async def replaced(state, commands):
            await TurnDraft.objects.filter(pk=self.game.game_id).aupdate(sequence=2, commands=self.request()['commands'])
            raise ValidationError('INVALID_MOVE', 'The older destination is no longer legal')
        with patch.object(self.consumer, '_preview_turn', side_effect=replaced):
            self.assertIsNone(await self.consumer._commit_saved_draft(self.state, old, True))
        current = await TurnDraft.objects.aget(pk=self.game.game_id)
        self.assertEqual(current.sequence, 2)
        self.assertTrue(await self.consumer._commit_saved_draft(self.state, current, True))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.revision), (8, 2))
        self.assertEqual(state.board_state['1,0']['uid'], 'wp')

    async def test_invalid_old_turn_cannot_delete_the_next_players_draft_with_the_same_sequence(self):
        old = await TurnDraft.objects.acreate(game_id=self.game.game_id, username='alice', turn_number=7,
            sequence=1, commands=[{'type': 'make_move', 'from': '0,0', 'to': '90,90'}])
        commands = [{'type': 'make_move', 'from': '8,0', 'to': '7,0'}]

        async def next_turn(state, old_commands):
            await GameState.objects.filter(pk=self.game.game_id).aupdate(
                turn_number=8, current_turn='bob', revision=2)
            await TurnDraft.objects.filter(pk=self.game.game_id).aupdate(
                turn_number=8, username='bob', sequence=1, commands=commands)
            raise ValidationError('INVALID_MOVE', 'The old turn is no longer current')

        with patch.object(self.consumer, '_preview_turn', side_effect=next_turn):
            self.assertIsNone(await self.consumer._commit_saved_draft(self.state, old, True))
        draft = await TurnDraft.objects.aget(pk=self.game.game_id)
        self.assertEqual((draft.turn_number, draft.username, draft.sequence, draft.commands),
                         (8, 'bob', 1, commands))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.current_turn, state.revision), (8, 'bob', 2))
        self.assertEqual(state.board_state, self.state.board_state)

    async def test_finished_game_blocks_an_outstanding_draft_without_changing_the_result(self):
        await self.consumer._handle_save_turn_draft(self.request())
        draft = await TurnDraft.objects.aget(pk=self.game.game_id)
        await GameState.objects.filter(pk=self.game.game_id).aupdate(revision=2, end_reason='resign', winner='bob')
        self.assertIsNone(await self.consumer._commit_saved_draft(self.state, draft, True))
        await self.consumer._handle_save_turn_draft(self.request(kind='commit_turn', sequence=2))
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.winner, state.end_reason, state.revision, state.board_state),
                         ('bob', 'resign', 2, self.state.board_state))
        self.assertNotIn('turnDraft', self.messages[-1])

    async def test_rematch_discards_drafts_and_keeps_an_unfinished_match_unrestartable(self):
        await self.consumer._handle_save_turn_draft(self.request())
        self.assertIsNone(await self.consumer._create_game_state(self.game.game_id, {}, 'alice', 'alice', 'bob',
                            self.state.config_snapshot, expected_revision=1))
        self.assertTrue(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        await GameState.objects.filter(pk=self.game.game_id).aupdate(revision=2, end_reason='resign', winner='bob')
        restarted = await self.consumer._create_game_state(self.game.game_id, self.state.board_state,
            'alice', 'alice', 'bob', self.state.config_snapshot, expected_revision=2, expected_end_reason='resign')
        self.assertEqual((restarted.turn_number, restarted.revision, restarted.end_reason), (1, 3, ''))
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())

    async def test_timer_retries_a_newer_draft_when_the_older_one_becomes_invalid(self):
        await TurnDraft.objects.acreate(game_id=self.game.game_id, username='alice', turn_number=7,
            sequence=1, commands=[{'type': 'make_move', 'from': '0,0', 'to': '90,90'}])
        preview = self.consumer._preview_turn
        calls = 0
        async def replace_once(state, commands):
            nonlocal calls
            calls += 1
            if calls == 1:
                await TurnDraft.objects.filter(pk=self.game.game_id).aupdate(sequence=2, commands=self.request()['commands'])
                raise ValidationError('INVALID_MOVE', 'The older draft became invalid')
            return await preview(state, commands)
        with patch.object(self.consumer, '_preview_turn', side_effect=replace_once):
            await self.consumer._start_turn_timer(self.game.game_id, 1, 7, 'alice',
                turn_started_at=timezone.now() - timedelta(seconds=2))
            task = _pending_turn_timers[self.game.game_id]
            await asyncio.wait_for(task, 2)
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.revision), (8, 2))
        self.assertEqual(state.board_state['1,0']['uid'], 'wp')
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        self.assertEqual(calls, 2)

    async def test_timeout_cannot_pass_over_a_draft_saved_after_its_empty_lookup(self):
        lookup = self.consumer._get_turn_draft
        calls = 0

        async def saved_after_lookup(state):
            nonlocal calls
            calls += 1
            if calls == 1:
                await self.consumer._handle_save_turn_draft(self.request())
                return None
            return await lookup(state)

        with patch.object(self.consumer, '_get_turn_draft', side_effect=saved_after_lookup):
            await self.consumer._start_turn_timer(self.game.game_id, 1, 7, 'alice',
                turn_started_at=timezone.now() - timedelta(seconds=2))
            await asyncio.wait_for(_pending_turn_timers[self.game.game_id], 2)
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.current_turn, state.revision), (8, 'bob', 2))
        self.assertEqual(state.board_state['1,0']['uid'], 'wp')
        self.assertNotIn('0,0', state.board_state)
        self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        self.assertTrue(any(m.get('type') == 'turn_draft_saved' for m in self.messages))
        self.assertTrue(any(m.get('committedTurn') == 7 and m.get('timedOut') for m in self.messages))

    async def test_expired_timer_does_not_leave_the_turn_without_a_clock_after_three_lost_writes(self):
        update = self.consumer._update_game_state
        lost = 0
        async def lose_three(**values):
            nonlocal lost
            if lost < 3:
                lost += 1
                await GameState.objects.filter(pk=self.game.game_id).aupdate(revision=values['expected_revision'] + 1)
                return False
            return await update(**values)
        with patch.object(self.consumer, '_update_game_state', side_effect=lose_three):
            await self.consumer._start_turn_timer(self.game.game_id, 1, 7, 'alice',
                turn_started_at=timezone.now() - timedelta(seconds=2))
            await asyncio.wait_for(_pending_turn_timers[self.game.game_id], 2)
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.turn_number, state.current_turn, state.revision), (8, 'bob', 5))
        self.assertEqual({at: u['uid'] for at, u in state.board_state.items()},
                         {at: u['uid'] for at, u in self.state.board_state.items()})
        self.assertEqual(lost, 3)

    async def test_expired_timer_stops_retrying_when_another_write_ends_its_turn_or_match(self):
        for changed in ({'turn_number': 8, 'current_turn': 'bob', 'end_reason': '', 'winner': ''},
                        {'turn_number': 7, 'current_turn': 'alice', 'end_reason': 'resign', 'winner': 'bob'}):
            with self.subTest(changed=changed):
                await GameState.objects.filter(pk=self.game.game_id).aupdate(
                    turn_number=7, current_turn='alice', revision=1, end_reason='', winner='')

                async def another_write_wins(**values):
                    await GameState.objects.filter(pk=self.game.game_id).aupdate(revision=2, **changed)
                    return False

                with patch.object(self.consumer, '_update_game_state', side_effect=another_write_wins) as update:
                    await self.consumer._start_turn_timer(self.game.game_id, 1, 7, 'alice',
                        turn_started_at=timezone.now() - timedelta(seconds=2))
                    await asyncio.wait_for(_pending_turn_timers[self.game.game_id], 2)
                state = await GameState.objects.aget(pk=self.game.game_id)
                self.assertEqual(update.call_count, 1)
                self.assertEqual((state.turn_number, state.current_turn, state.end_reason, state.winner, state.revision),
                                 (changed['turn_number'], changed['current_turn'], changed['end_reason'], changed['winner'], 2))
                self.assertEqual((state.board_state, state.move_history), (self.state.board_state, []))
                self.assertEqual(self.messages, [])

    async def test_a_revision_change_between_validation_and_save_keeps_the_old_draft_and_syncs(self):
        await self.consumer._handle_save_turn_draft(self.request())
        preview = self.consumer._preview_turn
        async def revision_changes(state, commands):
            result = await preview(state, commands)
            await GameState.objects.filter(pk=self.game.game_id).aupdate(revision=2, draw_offered_by='bob')
            return result
        with patch.object(self.consumer, '_preview_turn', side_effect=revision_changes):
            await self.consumer._handle_save_turn_draft(self.request([], sequence=2))
        self.assertEqual((await TurnDraft.objects.aget(pk=self.game.game_id)).sequence, 1)
        state = await GameState.objects.aget(pk=self.game.game_id)
        self.assertEqual((state.board_state, state.revision, state.draw_offered_by), (self.state.board_state, 2, 'bob'))
        self.assertEqual(self.messages[-1]['type'], 'game_state_update')
        self.assertEqual(self.messages[-1]['revision'], 2)
        self.assertEqual(self.messages[-1]['turnDraft']['commands'], self.request()['commands'])

    async def test_saving_a_winning_draft_does_not_cancel_the_live_turn_clock(self):
        board = copy.deepcopy(self.state.board_state)
        king = board.pop('8,0')
        king['hp'] = 1
        board['1,0'] = king
        config = copy.deepcopy(self.state.config_snapshot)
        config['rules']['turnTimeLimit'] = 60
        await GameState.objects.filter(pk=self.game.game_id).aupdate(board_state=board, config_snapshot=config)
        await self.consumer._start_turn_timer(self.game.game_id, 60, 7, 'alice')
        task = _pending_turn_timers[self.game.game_id]
        try:
            await self.consumer._handle_save_turn_draft(self.request([
                {'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '1,0'}]))
            self.assertIs(_pending_turn_timers.get(self.game.game_id), task)
            self.assertFalse(task.done())
            state = await GameState.objects.aget(pk=self.game.game_id)
            self.assertFalse(state.is_finished)
            self.assertEqual((state.board_state, state.revision), (board, 1))
        finally:
            self.consumer._cancel_turn_timer(self.game.game_id)
            try:
                await task
            except asyncio.CancelledError:
                pass


class TurnDraftProtocolTests(TransactionTestCase):
    async def position(self, board=None, ply=7):
        self.game, self.host, self.opponent, self.white, self.black = await _start_seated_game()
        state = await GameState.objects.aget(pk=self.game.game_id)
        config = copy.deepcopy(state.config_snapshot)
        config['rules']['turnTimeLimit'] = 0
        config['setup'] = {'white': {}, 'black': {}}
        pieces = {
            '-10,0': {'unit_id': 'king', 'color': 'white', 'uid': 'wk', 'hp': 60, 'max_hp': 60},
            '10,0': {'unit_id': 'king', 'color': 'black', 'uid': 'bk', 'hp': 60, 'max_hp': 60},
            '0,0': {'unit_id': 'pawn', 'color': 'white', 'uid': 'wp', 'hp': 12, 'max_hp': 12},
        }
        await GameState.objects.filter(pk=self.game.game_id).aupdate(board_state=board or pieces,
            config_snapshot=config, turn_number=ply, current_turn=state.player_white, move_history=[],
            phase_bank={str(phase): {'white': 3 * phase, 'black': 3 * phase} for phase in (1, 2, 3)} if ply >= 73 else {})
        return await GameState.objects.aget(pk=self.game.game_id)

    def request(self, state, commands=None, kind='save_turn_draft', sequence=1):
        return {'type': kind, 'gameId': self.game.game_id, 'turnNumber': state.turn_number,
                'revision': state.revision, 'sequence': sequence, 'commands': commands if commands is not None else [
                    {'type': 'make_move', 'from': '0,0', 'to': '1,0'}]}

    async def close(self):
        await self.host.disconnect()
        await self.opponent.disconnect()

    async def test_malformed_draft_envelopes_preserve_the_last_saved_turn_and_socket(self):
        state = await self.position()
        try:
            await self.white.send_json_to(self.request(state))
            await _receive_until(self.white, 'turn_draft_saved')
            for key in ('turnNumber', 'revision', 'sequence'):
                for value in (True, False, -1, 0.5, '1', [], {}, 9007199254740992):
                    with self.subTest(field=key, value=value):
                        await self.white.send_json_to(dict(self.request(state, sequence=2), **{key: value}))
                        error = await _receive_until(self.white, 'error')
                        self.assertEqual(error['code'], 'INVALID_DRAFT')
                        self.assertEqual((await TurnDraft.objects.aget(pk=self.game.game_id)).sequence, 1)
            await self.white.send_json_to(self.request(state, kind='commit_turn', sequence=2))
            committed = await _receive_until(self.black, 'game_state_update')
            self.assertEqual(committed['boardState']['1,0']['uid'], 'wp')
            self.assertEqual(committed['revision'], state.revision + 1)
        finally:
            await self.close()

    async def test_unknown_command_types_and_missing_fields_do_not_write_or_break_a_seated_socket(self):
        state = await self.position()
        try:
            for raw in ('moves', {}, [None], ['pass_turn'], [{'type': []}], [{'type': 'resign'}], [{}]):
                with self.subTest(commands=raw):
                    await self.white.send_json_to(self.request(state, commands=raw))
                    self.assertEqual((await _receive_until(self.white, 'error'))['code'], 'INVALID_DRAFT')
            for key in ('gameId', 'turnNumber', 'revision', 'sequence', 'commands'):
                with self.subTest(missing=key):
                    data = self.request(state)
                    del data[key]
                    await self.white.send_json_to(data)
                    self.assertEqual((await _receive_until(self.white, 'error'))['code'], 'MISSING_FIELD')
            after = await GameState.objects.aget(pk=self.game.game_id)
            self.assertEqual((after.board_state, after.revision), (state.board_state, state.revision))
            self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
            await self.white.send_json_to(self.request(state, kind='commit_turn'))
            self.assertEqual((await _receive_until(self.black, 'game_state_update'))['turnNumber'], 8)
        finally:
            await self.close()

    async def test_private_saved_draft_survives_seat_replacement_and_stale_sockets_cannot_change_it(self):
        state = await self.position()
        new = None
        try:
            await self.white.send_json_to(self.request(state))
            await _receive_until(self.white, 'turn_draft_saved')
            await self.black.send_json_to({'type': 'request_game_state'})
            snapshot = await _receive_until(self.black, 'game_state_update')
            self.assertNotIn('turnDraft', snapshot)
            self.assertEqual(snapshot['boardState'], state.board_state)
            new = WebsocketCommunicator(URLRouter(websocket_urlpatterns), f'/ws/game/{self.game.game_id}/')
            await new.connect()
            white_name = state.player_white
            token = 'host-tok' if white_name == 'alice' else 'opp-tok'
            await new.send_json_to({'type': 'join_game_room', 'username': white_name, 'gameId': self.game.game_id, 'token': token})
            await _receive_until(new, 'join_game_room_success')
            await new.send_json_to({'type': 'request_game_state'})
            restored = await _receive_until(new, 'game_state_update')
            self.assertEqual(restored['turnDraft']['commands'], self.request(state)['commands'])
            self.assertEqual(restored['revision'], state.revision)
            for kind in ('save_turn_draft', 'commit_turn'):
                await self.white.send_json_to(self.request(state, commands=[], kind=kind, sequence=2))
                self.assertEqual((await _receive_until(self.white, 'error'))['code'], 'STALE_GAME_SOCKET')
            self.assertEqual((await TurnDraft.objects.aget(pk=self.game.game_id)).sequence, 1)
            await new.send_json_to(self.request(state, kind='commit_turn', sequence=2))
            committed = await _receive_until(self.black, 'game_state_update')
            self.assertEqual(committed['turnNumber'], 8)
            self.assertEqual(committed['boardState']['1,0']['uid'], 'wp')
            self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        finally:
            if new:
                await new.disconnect()
            await self.close()

    async def test_panel_walk_then_crossing_then_heal_commits_as_one_authoritative_turn(self):
        state = await self.position(ply=27)
        config = copy.deepcopy(state.config_snapshot)
        reserve = next(at for at, gate in panels.gateway_hexes(11).items() if gate['color'] == 'white')
        config['setup']['white'] = {reserve: 'bishop'}
        occupancy = panels.panel_occupancy(config, 11, [], ply=27)
        first = next(key for key, cost in panels.panel_move_targets(config, 11, [], state.board_state,
                    reserve, 27, 10).items() if cost['price'] == 0 and cost['cost'] == 1)
        unit = occupancy[reserve]
        walk = {'turn': 27, 'color': 'white', 'from': reserve, 'to': first,
                'panelMove': True, 'panel': unit['panel'], 'cost': 1, 'price': 0, 'unit': unit}
        after_walk = panels.panel_occupancy(config, 11, [walk], ply=27)
        budget = panels.panel_allowance(config, [walk], after_walk[first], 27)
        entry = next(iter(panels.entry_targets(config, 11, after_walk, state.board_state, first, moves_left=budget)))
        friend = '-1,0'
        board = {'-10,0': state.board_state['-10,0'], '10,0': state.board_state['10,0'],
                 friend: {'unit_id': 'pawn', 'color': 'white', 'uid': 'friend', 'hp': 1, 'max_hp': 14, 'vet': 1},
                 '0,0': {'unit_id': 'bishop', 'color': 'white', 'uid': 'field-healer', 'hp': 8, 'max_hp': 8, 'vet': 2}}
        await GameState.objects.filter(pk=self.game.game_id).aupdate(config_snapshot=config, board_state=board,
                                            phase_bank={'1': {'white': 3, 'black': 3}})
        state = await GameState.objects.aget(pk=self.game.game_id)
        commands = [{'type': 'panel_move', 'from': reserve, 'to': first},
                    {'type': 'enter_board', 'from': first, 'to': entry},
                    {'type': 'make_move', 'from': '0,0', 'to': '0,0', 'heal': friend,
                     'bonuses': {'hel': 999}, 'unit': {'uid': 'forged', 'hp': 999}}]
        try:
            await self.white.send_json_to(self.request(state, commands=commands))
            await _receive_until(self.white, 'turn_draft_saved')
            untouched = await GameState.objects.aget(pk=self.game.game_id)
            self.assertEqual((untouched.board_state, untouched.move_history, untouched.revision), (board, [], state.revision))
            await self.white.send_json_to(self.request(state, commands=commands, kind='commit_turn', sequence=2))
            own = await _receive_until(self.white, 'game_state_update')
            other = await _receive_until(self.black, 'game_state_update')
            self.assertEqual(own, other)
            self.assertEqual((own['turnNumber'], own['revision']), (28, state.revision + 1))
            self.assertEqual(own['boardState'][entry]['uid'], unit['uid'])
            self.assertEqual(own['boardState'][friend]['hp'], 9)
            moves = [m for m in own['moveHistory'] if m.get('unit_id')]
            self.assertEqual([bool(m.get('panelMove')) for m in moves], [True, False, False])
            self.assertEqual([bool(m.get('entered')) for m in moves], [False, True, False])
            self.assertEqual(moves[-1]['healed_amount'], 8)
            self.assertNotIn(unit['uid'], {u['uid'] for u in panels.panel_occupancy(config, 11, own['moveHistory'], ply=28).values()})
        finally:
            await self.close()

    async def test_atomic_overtime_exchange_counts_two_distinct_units_and_tolls_once(self):
        state = await self.position(ply=89)
        board = state.board_state
        board['0,0'].update(vet=3, max_hp=14)
        board['0,1'] = {'unit_id': 'pawn', 'color': 'black', 'uid': 'defender', 'hp': 12, 'max_hp': 14, 'vet': 3}
        board['-2,0'] = {'unit_id': 'pawn', 'color': 'white', 'uid': 'second', 'hp': 12, 'max_hp': 14, 'vet': 3}
        await GameState.objects.filter(pk=self.game.game_id).aupdate(board_state=board)
        state = await GameState.objects.aget(pk=self.game.game_id)
        commands = [{'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '0,1', 'more': True,
                     'bonuses': {'atk': 999, 'def': 999}, 'counters': False},
                    {'type': 'make_move', 'from': '-2,0', 'to': '-3,0'}]
        try:
            await self.white.send_json_to(self.request(state, commands=commands, kind='commit_turn'))
            own = await _receive_until(self.white, 'game_state_update')
            other = await _receive_until(self.black, 'game_state_update')
            self.assertEqual(own, other)
            self.assertEqual((own['turnNumber'], own['revision']), (90, state.revision + 1))
            self.assertEqual(own['boardState']['-10,0']['hp'], 57)
            self.assertEqual(own['boardState']['10,0']['hp'], 60)
            self.assertEqual(own['boardState']['0,0']['hp'], 11)
            self.assertEqual(own['boardState']['0,1']['hp'], 11)
            self.assertEqual(own['boardState']['-3,0']['uid'], 'second')
            self.assertEqual([m['counter_damage'] for m in own['moveHistory'] if m.get('attacked')], [1])
            self.assertFalse(await TurnDraft.objects.filter(pk=self.game.game_id).aexists())
        finally:
            await self.close()

    async def test_persisted_draft_kill_rewards_up_and_game_over_share_the_commit_revision(self):
        state = await self.position()
        board = state.board_state
        dead = board.pop('10,0')
        dead['hp'] = 1
        board['1,0'] = dead
        await GameState.objects.filter(pk=self.game.game_id).aupdate(board_state=board)
        state = await GameState.objects.aget(pk=self.game.game_id)
        commands = [{'type': 'make_move', 'from': '0,0', 'to': '0,0', 'attack': '1,0'}]
        try:
            await self.white.send_json_to(self.request(state, commands=commands))
            await _receive_until(self.white, 'turn_draft_saved')
            saved = await GameState.objects.aget(pk=self.game.game_id)
            self.assertFalse(saved.is_finished)
            self.assertEqual((saved.board_state, saved.revision), (state.board_state, state.revision))
            self.assertNotIn('game_over', await _drain(self.black, .05))
            await self.white.send_json_to(self.request(state, commands=commands, kind='commit_turn', sequence=2))
            for comm in (self.white, self.black):
                final = await _receive_until(comm, 'game_state_update')
                over = await _receive_until(comm, 'game_over')
                self.assertEqual((final['winner'], final['endReason'], final['currentTurn']), (state.player_white, 'regicide', ''))
                self.assertEqual(final['revision'], state.revision + 1)
                self.assertEqual(over['revision'], final['revision'])
            self.assertEqual(unit_points_of('white', final['moveHistory'], state.config_snapshot),
                             state.config_snapshot['rules']['upAtStart'] + state.config_snapshot['units']['king']['value'])
            await self.white.send_json_to(self.request(state, commands=commands, kind='commit_turn', sequence=3))
            duplicate = await _receive_until(self.white, 'game_state_update')
            self.assertEqual(duplicate['revision'], final['revision'])
            self.assertNotIn('turnDraft', duplicate)
        finally:
            await self.close()

    async def test_phase_one_boundary_promotes_only_on_commit_and_early_endings_wait_for_both_seats(self):
        state = await self.position(ply=6)
        board = state.board_state
        board['0,0']['color'] = 'black'
        board['0,0']['uid'] = 'bp'
        await GameState.objects.filter(pk=self.game.game_id).aupdate(board_state=board, current_turn=state.player_black)
        state = await GameState.objects.aget(pk=self.game.game_id)
        try:
            await self.black.send_json_to(self.request(state))
            await _receive_until(self.black, 'turn_draft_saved')
            self.assertEqual((await GameState.objects.aget(pk=self.game.game_id)).board_state['0,0']['hp'], 12)
            await self.black.send_json_to(self.request(state, kind='commit_turn', sequence=2))
            promoted = await _receive_until(self.white, 'game_state_update')
            await _receive_until(self.black, 'game_state_update')
            self.assertEqual((promoted['turnNumber'], promoted['boardState']['1,0']['hp'], promoted['boardState']['1,0']['vet']), (7, 14, 1))
            for phase, last, loser, winner in [(1, 28, 'white', state.player_black), (2, 50, 'black', state.player_white)]:
                fresh = await GameState.objects.aget(pk=self.game.game_id)
                await GameState.objects.filter(pk=self.game.game_id).aupdate(turn_number=last - 2, current_turn=state.player_black, end_reason='', winner='',
                    board_state={k: v for k, v in fresh.board_state.items() if v['unit_id'] == 'king'},
                    phase_bank={} if phase == 1 else {'1': {'white': 3, 'black': 3}})
                for ply, comm in [(last - 2, self.black), (last - 1, self.white), (last, self.black)]:
                    fresh = await GameState.objects.aget(pk=self.game.game_id)
                    await comm.send_json_to(self.request(fresh, commands=[], kind='commit_turn', sequence=10 + ply))
                    snapshots = [await _receive_until(c, 'game_state_update') for c in (self.white, self.black)]
                    self.assertEqual(snapshots[0], snapshots[1])
                    self.assertEqual(snapshots[0]['phaseBank'][str(phase)]['pendingLoss'], loser)
                    self.assertEqual(snapshots[0]['endReason'], 'phase_result' if ply == last else '')
                for c in (self.white, self.black):
                    over = await _receive_until(c, 'game_over')
                    self.assertEqual((over['winner'], over['endReason']), (winner, 'phase_result'))
        finally:
            await self.close()

    async def test_entered_unit_cannot_walk_or_heal_again_but_another_field_unit_can_act(self):
        state = await self.position(ply=27)
        config = copy.deepcopy(state.config_snapshot)
        reserve = next(at for at, gate in panels.gateway_hexes(11).items() if gate['color'] == 'white')
        config['setup']['white'] = {reserve: 'bishop'}
        occupancy = panels.panel_occupancy(config, 11, [], ply=27)
        entry = next(iter(panels.entry_targets(config, 11, occupancy, state.board_state, reserve)))
        q, r = panels.parse_key(entry)
        empty = next(panels.coord_key(q + dq, r + dr) for dq, dr in HEX_DIRECTIONS.values()
                   if panels.on_battlefield(q + dq, r + dr, 11) and panels.coord_key(q + dq, r + dr) not in state.board_state)
        friend = next(panels.coord_key(q + dq, r + dr) for dq, dr in HEX_DIRECTIONS.values()
                    if panels.on_battlefield(q + dq, r + dr, 11) and panels.coord_key(q + dq, r + dr) not in (empty, entry))
        board = state.board_state
        board[friend] = {'unit_id': 'pawn', 'color': 'white', 'uid': 'friend', 'hp': 1, 'max_hp': 14, 'vet': 1}
        await GameState.objects.filter(pk=self.game.game_id).aupdate(config_snapshot=config, board_state=board,
                                                    phase_bank={'1': {'white': 3, 'black': 3}})
        try:
            await self.white.send_json_to({'type': 'enter_board', 'from': reserve, 'to': entry})
            entered = await _receive_until(self.white, 'game_state_update')
            for action in [{'type': 'make_move', 'from': entry, 'to': empty},
                           {'type': 'make_move', 'from': entry, 'to': entry, 'heal': friend}]:
                await self.white.send_json_to(action)
                error = await _receive_until(self.white, ('error', 'move_made'))
                self.assertEqual(error['type'], 'error')
                self.assertEqual(error['code'], 'INVALID_MOVE')
                current = await GameState.objects.aget(pk=self.game.game_id)
                self.assertEqual((current.board_state, current.revision, current.turn_number),
                                 (entered['boardState'], entered['revision'], 27))
            await self.white.send_json_to({'type': 'make_move', 'from': '0,0', 'to': '0,1'})
            self.assertEqual((await _receive_until(self.white, 'move_made'))['turnNumber'], 28)
        finally:
            await self.close()
