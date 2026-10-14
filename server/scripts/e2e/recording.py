"""Record a complete real-socket match and optionally export it for browser playback.

E2E_PORT selects an isolated server; REPLAY_OUTPUT selects the downloaded fixture.
"""
import json
import os
from pathlib import Path
import uuid
import time
from wslib import WS, check


def run():
    tag = uuid.uuid4().hex[:8]
    names = ['ReplayA' + tag, 'ReplayB' + tag]
    sockets = []
    try:
        lobby = []
        for name in names:
            ws = WS('/ws/game/lobby/'); sockets.append(ws); ws.type('connection_established')
            ws.send({'type': 'join_lobby', 'username': name, 'secret': name + '-secret'})
            lobby.append(ws)
        lobby[0].until(lambda m: m.get('type') == 'user_list' and names[1] in json.dumps(m), 'both users')
        lobby[0].send({'type': 'game_challenge', 'challenger': names[0], 'opponent': names[1]})
        lobby[1].type('game_challenge')
        lobby[1].send({'type': 'challenge_accept', 'challenger': names[0], 'opponent': names[1]})
        seats = [ws.type('challenge_accepted') for ws in lobby]
        game = seats[0]['gameId']
        players = []
        for name, seat in zip(names, seats):
            ws = WS('/ws/game/' + game + '/'); sockets.append(ws); ws.type('connection_established')
            ws.send({'type': 'join_game_room', 'gameId': game, 'username': name,
                     'token': seat['token'], 'secret': name + '-secret'})
            ws.type('join_game_room_success'); players.append(ws)
        config = json.loads((Path(__file__).parents[3] / 'shared/default-config.json').read_text(encoding='utf-8'))
        config['match']['turnTimeLimit'] = 0
        config['match']['cpAtStart'] = 500
        config['economy']['pointsAtStart'] = 500
        config['setup'] = {'white': {'-3,6': 'king', '0,0': 'pawn'},
                           'black': {'3,-6': 'king', '5,0': 'pawn'}}
        players[0].send({'type': 'change_game_mode', 'gameId': game, 'mode': 'custom', 'options': {}})
        players[0].type('game_mode_changed')
        players[0].send({'type': 'set_custom_config', 'config': config})
        players[0].type('custom_config_saved')
        for name, ws in zip(names, players):
            ws.send({'type': 'player_ready', 'gameId': game, 'username': name})
        players[0].until(lambda m: m.get('type') == 'player_ready' and m.get('username') == names[1], 'both ready')
        players[0].send({'type': 'start_game', 'gameId': game, 'hostColor': 'white', 'turnTimeLimit': 0})
        state = players[0].type('game_started'); players[1].type('game_started')
        tape = []
        for ply in range(1, 101):
            time.sleep(0.25)
            current = players[(ply - 1) % 2]
            commands = []
            if ply == 1:
                commands = [{'type': 'pick_pair', 'id': 'warcry'}, {'type': 'pick_path', 'id': 'onslaught'},
                            {'type': 'make_move', 'from': '0,0', 'to': '1,0', 'more': True},
                            {'type': 'make_move', 'from': '1,0', 'to': '2,0', 'more': True}]
            if ply == 2:
                commands = [{'type': 'make_move', 'from': '5,0', 'to': '4,0', 'more': True}]
            if ply == 7:
                commands = [{'type': 'cast_ability', 'id': 'convert'},
                            {'type': 'cast_ability', 'id': 'warcry', 'targetUid': 'w0,0'}]
            if ply == 9:
                commands = [{'type': 'make_move', 'from': '2,0', 'to': '3,0', 'attack': '4,0', 'more': True},
                            {'type': 'cast_ability', 'id': 'cleave', 'hex': '4,0'}]
            commands.append({'type': 'pass_turn'})
            current.send({'type': 'commit_turn', 'gameId': game, 'turnNumber': ply,
                          'revision': state['revision'], 'sequence': ply, 'commands': commands})
            ack = current.until(lambda m: m.get('type') in ('turn_draft_saved', 'error'), 'accepted draft')
            assert ack['type'] == 'turn_draft_saved', ack
            state = current.until(lambda m: m.get('type') == 'game_state_update' and m.get('committedTurn') == ply, 'committed turn')
            other = players[ply % 2]
            other.until(lambda m: m.get('type') == 'game_state_update' and m.get('revision') == state['revision'], 'same accepted revision')
            tape = state['replayJournal']['actions']
            if state.get('endReason'):
                break
        check('complete online match keeps a canonical journal', len(tape) >= 72 and tape[-1]['command']['type'] == 'pass_turn', len(tape))
        check('all three command families are recorded', {'make_move', 'pick_pair', 'pick_path', 'cast_ability'}.issubset({a['command']['type'] for a in tape}))
        current.send({'type': 'request_game_state', 'gameId': game})
        restored = current.type('game_state_update')
        check('reconnect snapshot retains the complete tape', restored['replayJournal'] == state['replayJournal'])
        archive = {'type': 'chessplusplus-replay', 'version': 1, 'config': state['config'],
                   'players': {'white': names[0], 'black': names[1]}, 'actions': tape}
        output = os.environ.get('REPLAY_OUTPUT')
        if output:
            Path(output).write_text(json.dumps(archive))
            Path(output + '.expected.json').write_text(json.dumps({
                'board': state['boardState'], 'turn': state['turnNumber'],
                'phaseBank': state['phaseBank'], 'endReason': state['endReason']}))
        check('archive contains no seat secret or private draft', all('secret' not in json.dumps(a) and 'token' not in json.dumps(a) for a in tape))
    finally:
        for ws in sockets:
            ws.close()


if __name__ == '__main__':
    run()
