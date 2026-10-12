"""Play paired seats against a legal one-action greedy baseline; never writes a database."""
import argparse
import asyncio
import copy
import json
import os
from pathlib import Path
import random
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
import django
django.setup()

from game.cpu import candidate_commands, color_of, position_value, search_turn
from game.consumers import GameConsumer
from game.engine.ability_rules import initial_state
from game.engine.config_loader import DEFAULT_CONFIG, build_initial_board, load_config
from game.models import GameState
from game.engine.phases import overtime_last_turn
from game.validators import ValidationError


async def greedy(state, seed):
    runner = GameConsumer()
    color = color_of(state)
    passed = await runner._preview_turn(state, [])
    best = position_value(passed, color), [{'type': 'pass_turn'}]
    # Compare a complete, legal single action; no opponent search or action combinations.
    commands = list(candidate_commands(state, time.monotonic() + 2))
    random.Random(seed).shuffle(commands)
    groups = {kind: [] for kind in ('movement', 'ability', 'choice')}
    for command in commands:
        kind = 'movement' if command['type'] in ('make_move', 'panel_move', 'panel_attack', 'enter_board') else 'ability' if command['type'] == 'cast_ability' else 'choice'
        groups[kind].append(command)
    commands = [command for group in groups.values() for command in group[:12]]
    for command in commands:
        try:
            after = await runner._preview_turn(state, [command])
        except (ValidationError, ValueError, KeyError):
            continue
        value = position_value(after, color)
        if value > best[0]:
            best = value, [command, {'type': 'pass_turn'}]
        if after.is_finished and after.winner == getattr(after, 'player_' + color):
            break
    return best[1]


async def match(config, color, difficulty, seed, seconds, trace=False):
    state = GameState(game_id='cpu-benchmark', config_snapshot=copy.deepcopy(config), board_state=build_initial_board(config).to_dict(),
        player_white='white', player_black='black', current_turn='white', turn_number=1, revision=1,
        move_history=[], phase_bank={}, ability_state=initial_state())
    runner, begun, moves = GameConsumer(), time.monotonic(), 0
    while not state.is_finished:
        commands = await search_turn(state, difficulty, seconds) if color_of(state) == color else await greedy(state, seed + state.turn_number)
        if trace:
            print(json.dumps({'ply': state.turn_number, 'side': color_of(state), 'commands': commands, 'kings': {k:u['hp'] for k,u in state.board_state.items() if config['units'][u['unit_id']].get('commander')}}), flush=True)
        previous = state.turn_number
        state = await runner._preview_turn(state, commands)
        if not state.is_finished and state.turn_number != previous + 1:
            raise AssertionError('A chosen turn did not advance.')
        moves += 1
        if moves > max(config['match']['maxTurns'] * 2 + 4, (overtime_last_turn(config) + 2) * 2):
            raise AssertionError('The match exceeded its configured limit.')
    return {'difficulty': difficulty, 'seed': seed, 'cpu': color, 'winner': state.winner, 'reason': state.end_reason,
            'plies': moves, 'bank': state.phase_bank, 'seconds': round(time.monotonic() - begun, 2)}


async def main(args):
    config = load_config(json.loads(Path(args.config).read_text(encoding='utf-8'))) if args.config else copy.deepcopy(DEFAULT_CONFIG)
    results = []
    for difficulty in args.difficulty:
        for seed in range(args.games):
            for color in ('white', 'black'):
                result = await match(config, color, difficulty, seed, args.seconds, args.trace)
                results.append(result)
                print(json.dumps(result), flush=True)
                if args.output:
                    Path(args.output).write_text(json.dumps(results, indent=2), encoding='utf-8')
        selected = [r for r in results if r['difficulty'] == difficulty]
        wins = sum(r['winner'] == r['cpu'] for r in selected)
        print(f'{difficulty}: {wins}/{len(selected)} wins against the greedy baseline', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--games', type=int, default=4, help='Paired seeds; each plays both seats.')
    parser.add_argument('--difficulty', nargs='+', choices=('easy', 'normal', 'hard'), default=['normal'])
    parser.add_argument('--seconds', type=float, help='Optional shorter search budget for development checks.')
    parser.add_argument('--config', help='An exported game configuration.')
    parser.add_argument('--trace', action='store_true', help='Print turn intents and commander HP.')
    parser.add_argument('--output', help='Write results as they finish.')
    args = parser.parse_args()
    if not 1 <= args.games <= 100 or (args.seconds is not None and not 0.01 <= args.seconds <= 5):
        parser.error('Use 1–100 paired seeds and a 0.01–5 second budget.')
    asyncio.run(main(args))
