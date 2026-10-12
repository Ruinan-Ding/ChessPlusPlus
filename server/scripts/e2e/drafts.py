"""Saved turns and disconnected-player expiry over real WebSockets.

Run against a migrated development server; E2E_PORT selects a spare port.
The match starts from the shipped deal with a real 15-second turn clock.
Exits non-zero if any check fails.
"""
import json
import uuid

from wslib import WS, check, results, step


def run():
    tag = uuid.uuid4().hex[:10]
    host, guest = 'DraftA' + tag, 'DraftB' + tag
    secrets = {host: 'a-' + tag, guest: 'b-' + tag}
    sockets = []
    try:
        lobby = {}
        for name in (host, guest):
            socket = WS('/ws/game/lobby/')
            sockets.append(socket)
            socket.type('connection_established')
            socket.send({'type': 'join_lobby', 'username': name, 'secret': secrets[name]})
            lobby[name] = socket
        lobby[host].until(lambda m: m.get('type') == 'user_list'
                          and host in json.dumps(m) and guest in json.dumps(m), 'both lobby users')
        lobby[host].send({'type': 'game_challenge', 'challenger': host, 'opponent': guest})
        lobby[guest].type('game_challenge')
        lobby[guest].send({'type': 'challenge_accept', 'challenger': host, 'opponent': guest})
        accepted = {name: lobby[name].type('challenge_accepted') for name in (host, guest)}
        game = accepted[host]['gameId']

        def join(name):
            socket = WS(f'/ws/game/{game}/')
            sockets.append(socket)
            socket.type('connection_established')
            socket.send({'type': 'join_game_room', 'gameId': game, 'username': name,
                         'token': accepted[name]['token'], 'secret': secrets[name]})
            socket.type('join_game_room_success')
            return socket

        white, black = join(host), join(guest)
        white.send({'type': 'player_ready', 'gameId': game, 'username': host})
        black.send({'type': 'player_ready', 'gameId': game, 'username': guest})
        white.until(lambda m: m.get('type') == 'player_ready' and m.get('username') == host, 'host ready')
        white.until(lambda m: m.get('type') == 'player_ready' and m.get('username') == guest, 'guest ready')
        white.send({'type': 'start_game', 'gameId': game, 'hostColor': 'white', 'turnTimeLimit': 15})
        start = white.type('game_started')
        black.type('game_started')
        check('real timed match starts from the shipped deal', start['turnNumber'] == 1
              and start['playerWhite'] == host and start['config']['match']['turnTimeLimit'] == 15, start)
        board = start['boardState']

        def pawn_step(color, dr):
            for key, unit in board.items():
                q, r = map(int, key.split(','))
                destination = f'{q},{r + dr}'
                if unit['color'] == color and unit['unit_id'] == 'pawn' and destination not in board:
                    return {'type': 'make_move', 'from': key, 'to': destination}
            raise AssertionError('No free opening pawn step')

        def request(socket, turn, revision, sequence, commands, kind='save_turn_draft'):
            socket.send({'type': kind, 'gameId': game, 'turnNumber': turn, 'revision': revision,
                         'sequence': sequence, 'commands': commands})

        def snapshot(socket):
            socket.send({'type': 'request_game_state', 'gameId': game})
            return socket.type('game_state_update')

        move = pawn_step('white', -1)
        request(white, 1, start['revision'], 1, [move])
        saved = white.type('turn_draft_saved')
        check('saving acknowledges the originating turn and sequence',
              (saved['turnNumber'], saved['sequence']) == (1, 1), saved)
        check('staging sends no position update to the opponent', not any(
            m.get('type') in ('move_made', 'turn_passed', 'game_state_update') for m in black.drain(.15)))
        other = snapshot(black)
        check('opponent sees the committed board without private staging', other['boardState'] == board
              and other['revision'] == start['revision'] and 'turnDraft' not in other, other)

        request(white, 1, start['revision'], 2, [])
        white.type('turn_draft_saved')
        undone = snapshot(white)
        check('Undo replaces the saved turn with an empty draft', undone['turnDraft']['commands'] == []
              and undone['turnDraft']['sequence'] == 2 and undone['boardState'] == board, undone)
        request(white, 1, start['revision'], 3, [move])
        white.type('turn_draft_saved')
        request(white, 1, start['revision'], 4, [dict(move, to='90,90')])
        error = white.type('error')
        check('illegal replacement is refused', error.get('code') == 'INVALID_MOVE', error)
        restored = snapshot(white)
        check('illegal replacement preserves the last valid draft', restored['turnDraft']['sequence'] == 3
              and restored['turnDraft']['commands'] == [move] and restored['boardState'] == board, restored)

        request(white, 1, start['revision'], 5, [move], 'commit_turn')
        white.type('turn_draft_saved')
        committed, other = white.type('game_state_update'), black.type('game_state_update')
        check('End Turn commits one revision and hands the turn over once', committed['turnNumber'] == 2
              and committed['currentTurn'] == guest and committed['revision'] == start['revision'] + 1
              and committed['boardState'][move['to']]['uid'] == board[move['from']]['uid']
              and move['from'] not in committed['boardState'], committed)
        check('both seats receive the same authoritative commit', committed == other)
        check('committed snapshot contains no private draft', 'turnDraft' not in committed)
        request(white, 1, start['revision'], 6, [move], 'commit_turn')
        duplicate = white.type('game_state_update')
        check('duplicate End Turn cannot replay the old move', duplicate['turnNumber'] == 2
              and duplicate['revision'] == committed['revision'] and duplicate['boardState'] == committed['boardState'], duplicate)

        reply = pawn_step('black', 1)
        request(black, 2, committed['revision'], 1, [reply])
        black.type('turn_draft_saved')
        black.close()
        timed = white.until(lambda m: m.get('type') == 'game_state_update' and m.get('committedTurn') == 2,
                            'disconnected player saved-move expiry', seconds=20)
        check('expiry commits the disconnected player saved move', timed['timedOut']
              and timed['turnNumber'] == 3 and timed['currentTurn'] == host
              and timed['revision'] == committed['revision'] + 1
              and timed['boardState'][reply['to']]['uid'] == board[reply['from']]['uid']
              and reply['from'] not in timed['boardState'], timed)
        black = join(guest)
        rejoined = snapshot(black)
        check('rejoin restores the committed position without replaying the draft',
              rejoined['boardState'] == timed['boardState'] and rejoined['revision'] == timed['revision']
              and rejoined['turnNumber'] == 3 and 'turnDraft' not in rejoined, rejoined)
        white.send({'type': 'resign'})
        over, other = white.type('game_over'), black.type('game_over')
        check('match closes normally after the timed commit and rejoin',
              over['winner'] == guest and over == other, over)
    finally:
        for socket in reversed(sockets):
            socket.close()


if __name__ == '__main__':
    step('saved-turn live protocol', run)
    print(f'\n{sum(results)}/{len(results)} checks passed', flush=True)
    raise SystemExit(0 if results and all(results) else 1)
