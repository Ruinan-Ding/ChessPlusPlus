"""Portable replays contain accepted intents, never resolved combat or private drafts."""
import json
from pathlib import Path
from contextvars import ContextVar
from copy import deepcopy
from .engine.board import parse_coord, coord_key

incoming_action = ContextVar('replay_action', default=None)
COMMAND_FIELDS = json.loads((Path(__file__).resolve().parents[2] / 'shared/replay-command-fields.json').read_text(encoding='utf-8'))
COMMAND_TYPES = set(COMMAND_FIELDS) - {'result'}


def append_action(journal, ply, color, command):
    if journal is None:
        return None  # Matches begun before recording cannot supply a complete replay.
    result = deepcopy(journal)
    cleaned = {key: value for key, value in command.items() if key in COMMAND_FIELDS[command['type']]}
    for field in ('attack', 'heal'):
        if field in cleaned and not cleaned[field]:
            del cleaned[field]
    for field in ('withdraw', 'more'):
        if field in cleaned:
            cleaned[field] = bool(cleaned[field])
    for field in ('from', 'to', 'attack', 'heal', 'hex'):
        if cleaned.get(field) is not None:
            cleaned[field] = coord_key(*parse_coord(cleaned[field]))
    result['actions'].append({'ply': ply, 'color': color, 'command': cleaned})
    return result


def record_write(state, turn_number, winner, end_reason):
    color = 'white' if state.current_turn == state.player_white else 'black'
    command = incoming_action.get()
    if command and command.get('type') in COMMAND_TYPES:
        journal = append_action(state.replay_journal, state.turn_number, color, command)
        return append_action(journal, state.turn_number, color, {'type': 'pass_turn'}) if (
            turn_number > state.turn_number and command['type'] != 'pass_turn') else journal
    if end_reason in ('resign', 'draw_agreed', 'disconnect', 'timeout'):
        loser = 'black' if winner == state.player_white else 'white'
        return append_action(state.replay_journal, state.turn_number, loser,
                             {'type': 'result', 'reason': end_reason})
    if turn_number > state.turn_number:
        return append_action(state.replay_journal, state.turn_number, color, {'type': 'pass_turn'})
    return state.replay_journal
