import copy
from django.test import TransactionTestCase
from django.utils import timezone
from datetime import timedelta
import asyncio
from game.models import GameState
from game.recording import append_action, incoming_action
from game.testsuite.test_turn_drafts import TurnDraftTests
from game.validators import ValidationError


class ReplayJournalTests(TransactionTestCase):
    request = TurnDraftTests.request

    def setUp(self):
        TurnDraftTests.setUp(self)
        self.state.replay_journal = {'version': 1, 'actions': []}
        self.state.save(update_fields=['replay_journal'])

    async def test_private_drafts_are_not_recorded_and_commit_records_each_click(self):
        commands = [{'type': 'make_move', 'from': '0,0', 'to': '1,0'},
                    {'type': 'make_move', 'from': '1,0', 'to': '2,0'}, {'type': 'pass_turn'}]
        await self.consumer._handle_save_turn_draft(self.request(commands))
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual(saved.replay_journal['actions'], [])
        await self.consumer._handle_save_turn_draft(self.request(commands, sequence=2, kind='commit_turn'))
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual([a['command'] for a in saved.replay_journal['actions']], commands)
        self.assertEqual([(a['ply'], a['color']) for a in saved.replay_journal['actions']], [(7, 'white')] * 3)
        self.assertEqual(saved.revision, 2)
        await self.consumer._handle_request_game_state({})
        self.assertEqual(self.messages[-1]['replayJournal'], saved.replay_journal)

    async def test_refused_batch_leaves_no_record_or_partial_move(self):
        commands = [{'type': 'make_move', 'from': '0,0', 'to': '1,0'},
                    {'type': 'make_move', 'from': '8,0', 'to': '7,0'}]
        with self.assertRaises(ValidationError):
            await self.consumer._preview_turn(self.state, commands)
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual(saved.replay_journal['actions'], [])
        self.assertIn('0,0', saved.board_state)

    async def test_timeout_draft_record_and_revision_are_atomic(self):
        await self.consumer._handle_save_turn_draft(self.request())
        draft = await self.consumer._get_turn_draft(self.state)
        self.assertTrue(await self.consumer._commit_saved_draft(self.state, draft, timed_out=True))
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual([a['command']['type'] for a in saved.replay_journal['actions']], ['make_move', 'pass_turn'])
        before = copy.deepcopy(saved.replay_journal)
        self.assertIsNone(await self.consumer._commit_saved_draft(self.state, draft))
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual(saved.replay_journal, before)

    async def test_legacy_action_records_only_safe_intent_fields(self):
        token = incoming_action.set({'type': 'make_move', 'from': '0,0', 'to': '1,0',
                                     'token': 'secret', 'bonuses': {'atk': 999}})
        try:
            await self.consumer._handle_make_move({'from': '0,0', 'to': '1,0', 'more': True})
        finally:
            incoming_action.reset(token)
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual(saved.replay_journal['actions'][0]['command'],
                         {'type': 'make_move', 'from': '0,0', 'to': '1,0'})

    async def test_resignation_is_an_explicit_input(self):
        self.assertTrue(await self.consumer._end_game(self.state.game_id, self.state, 'bob', 'resign'))
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual(saved.replay_journal['actions'], [
            {'ply': 7, 'color': 'white', 'command': {'type': 'result', 'reason': 'resign'}}])

    async def test_old_matches_remain_unexportable(self):
        self.state.replay_journal = None
        await self.state.asave(update_fields=['replay_journal'])
        result = await self.consumer._preview_turn(self.state, [{'type': 'pass_turn'}])
        self.assertIsNone(result.replay_journal)

    async def test_timeout_task_does_not_inherit_the_input_that_armed_it(self):
        token = incoming_action.set({'type': 'make_move', 'from': '0,0', 'to': '1,0'})
        try:
            await self.consumer._start_turn_timer(self.state.game_id, 0.01, turn_number=7,
                current_turn='alice', turn_started_at=timezone.now() - timedelta(seconds=1))
        finally:
            incoming_action.reset(token)
        await asyncio.sleep(0.2)
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual([a['command'] for a in saved.replay_journal['actions']], [{'type': 'pass_turn'}])

    async def test_a_lost_write_cannot_append_an_input(self):
        token = incoming_action.set({'type': 'pass_turn'})
        try:
            applied = await self.consumer._update_game_state(game_id=self.state.game_id,
                board_state=self.state.board_state, current_turn='bob', turn_number=8,
                move_history=[], expected_revision=0, expected_turn_number=7)
        finally:
            incoming_action.reset(token)
        self.assertFalse(applied)
        saved = await GameState.objects.aget(pk=self.state.pk)
        self.assertEqual(saved.replay_journal['actions'], [])

    def test_recorded_coordinate_aliases_are_canonical(self):
        journal = append_action({'version': 1, 'actions': []}, 1, 'white',
            {'type': 'make_move', 'from': '+01,00', 'to': '02,0', 'attack': '' , 'hex': 'ignored', 'unitUid': 'ignored'})
        self.assertEqual(journal['actions'][0]['command'],
            {'type': 'make_move', 'from': '1,0', 'to': '2,0'})

    def test_append_does_not_mutate_the_snapshot(self):
        journal = {'version': 1, 'actions': []}
        new = append_action(journal, 1, 'white', {'type': 'pass_turn', 'token': 'secret'})
        self.assertEqual(journal['actions'], [])
        self.assertEqual(new['actions'][0]['command'], {'type': 'pass_turn'})
