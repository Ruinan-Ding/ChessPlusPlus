"""One full networked match between two real sockets, against a running server.

    DJANGO_DEBUG=true venv/Scripts/daphne.exe core.asgi:application     # from server/
    venv/Scripts/python.exe scripts/e2e/match.py                         # in a second shell

Lobby, invite (declined, then accepted), room tokens, ready, start, moves, a
pass, a dropped player rejoining - and coming back to the lobby under their own
name - then a resignation. Exits non-zero if any check fails.
"""
import json, os, random, string, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from wslib import WS, check, step, results

tag = ''.join(random.choices(string.digits, k=4))
A, B = f'E2EAlice{tag}', f'E2EBob{tag}'
SECRET = {A: 'a-' + tag, B: 'b-' + tag}
ctx = {}
print(f'Players {A} / {B}')

print('\n[lobby]')
def lobby():
    ctx['la'] = WS('/ws/game/lobby/'); ctx['la'].type('connection_established')
    ctx['la'].send({'type': 'join_lobby', 'username': A, 'secret': SECRET[A]})
    ctx['lb'] = WS('/ws/game/lobby/'); ctx['lb'].type('connection_established')
    ctx['lb'].send({'type': 'join_lobby', 'username': B, 'secret': SECRET[B]})
    ctx['la'].until(lambda m: m.get('type') == 'user_list' and A in json.dumps(m) and B in json.dumps(m),
                    'user list with both')
    check('both players appear in the lobby user list', True)
    # A second socket may not take a name that is already held: it gets a guest's.
    x = WS('/ws/game/lobby/'); x.type('connection_established')
    x.send({'type': 'join_lobby', 'username': A, 'secret': 'someone-else'})
    e = x.type('username_assigned')
    check('a held name is not handed to another socket', e.get('username') and e.get('username') != A, e)
    x.close()
    ctx['la'].send({'type': 'chat_message', 'content': 'hello from ' + A})
    m = ctx['lb'].until(lambda m: m.get('type') == 'chat_message' and m.get('username') == A, 'lobby chat')
    check('lobby chat reaches the other player', m.get('content') == 'hello from ' + A, m)
step('lobby', lobby)

print('\n[invite]')
def invite():
    la, lb = ctx['la'], ctx['lb']
    la.send({'type': 'game_challenge', 'challenger': A, 'opponent': B})
    m = lb.type('game_challenge')
    check('invite arrives at the opponent', m.get('challenger') == A, m)
    lb.send({'type': 'challenge_decline', 'challenger': A, 'opponent': B})
    m = la.type('challenge_declined')
    check('decline reaches the challenger', m.get('username') == B, m)
    la.send({'type': 'game_challenge', 'challenger': A, 'opponent': B})
    lb.type('game_challenge')
    lb.send({'type': 'challenge_accept', 'challenger': A, 'opponent': B})
    ma, mb = la.type('challenge_accepted'), lb.type('challenge_accepted')
    ctx.update(game=ma['gameId'], token={A: ma['token'], B: mb['token']})
    check('accept hands both players the same room', ma['gameId'] == mb['gameId'], (ma, mb))
    check('each player gets their own token', ma['token'] and mb['token'] and ma['token'] != mb['token'])
step('invite', invite)


def join_room(name):
    g = ctx['game']
    w = WS(f'/ws/game/{g}/'); w.type('connection_established')
    w.send({'type': 'join_game_room', 'username': name, 'gameId': g,
            'token': ctx['token'][name], 'secret': SECRET[name]})
    w.type('join_game_room_success')
    return w


print('\n[room]')
def room():
    g = ctx['game']
    probe = WS(f'/ws/game/{g}/'); probe.type('connection_established')
    probe.send({'type': 'join_game_room', 'username': B, 'gameId': g, 'token': 'not-the-token'})
    e = probe.type('error')
    check('a wrong room token is refused', 'TOKEN' in json.dumps(e).upper(), e)
    probe.close()
    ga, gb = join_room(A), join_room(B)
    check('both players join the room with their tokens', True)
    ga.send({'type': 'game_room_message', 'content': 'gl hf'})
    m = gb.until(lambda m: m.get('type') == 'game_room_message' and m.get('username') == A, 'room chat')
    check('room chat reaches the other player', m.get('content') == 'gl hf', m)
    ga.send({'type': 'player_ready', 'username': A, 'gameId': g})
    gb.send({'type': 'player_ready', 'username': B, 'gameId': g})
    ga.until(lambda m: m.get('type') == 'player_ready' and m.get('username') == A, 'A ready')
    ga.until(lambda m: m.get('type') == 'player_ready' and m.get('username') == B, 'B ready')
    ga.send({'type': 'start_game', 'gameId': g})
    sa, sb = ga.type('game_started'), gb.type('game_started')
    check('both see the game start', sa['turnNumber'] == 1 and sb['currentTurn'] == sa['currentTurn'])
    check('the two seats are the two players', {sa['playerWhite'], sa['playerBlack']} == {A, B}, sa)
    ctx.update(sock={A: ga, B: gb}, start=sa)
step('room', room)

print('\n[play]')
def play():
    s = ctx['start']
    white, black = ctx['sock'][s['playerWhite']], ctx['sock'][s['playerBlack']]
    board = s['boardState']
    # White's pieces sit at positive r, black's at negative; a pawn steps toward the middle.
    def step_for(color, dr):
        for k, p in board.items():
            q, r = map(int, k.split(','))
            to = f'{q},{r + dr}'
            if p['color'] == color and p['unit_id'] == 'pawn' and to not in board:
                return k, to
    wf, wt = step_for('white', -1)
    bf, bt = step_for('black', +1)
    black.send({'type': 'make_move', 'from': bf, 'to': bt})
    e = black.type('error')
    check('the player not on turn is refused', e.get('code') == 'NOT_YOUR_TURN', e)
    white.send({'type': 'make_move', 'from': wf, 'to': wt})
    m1, m2 = white.type('move_made'), black.type('move_made')
    check("white's move reaches both players", m1['move']['to'] == wt and m2['boardState'].get(wt), m1['move'])
    black.send({'type': 'make_move', 'from': bf, 'to': bt})
    black.type('move_made')
    m2 = white.type('move_made')
    check("black's reply reaches both players", m2['move']['to'] == bt and m2['turnNumber'] == 3, m2)
    white.send({'type': 'pass_turn'})
    p = black.type('turn_passed')
    check('a pass hands the turn over', p.get('turnNumber') == 4, p)
    ctx.update(white=white, black=black, bt=bt)
step('play', play)

print('\n[rejoin]')
def rejoin():
    g = ctx['game']
    name = ctx['start']['playerBlack']
    ctx['black'].close()
    time.sleep(1.5)
    nb = join_room(name)
    nb.send({'type': 'request_game_state', 'gameId': g})
    st = nb.until(lambda m: m.get('type') in ('game_state_update', 'game_state'), 'game state')
    check('a dropped player rejoins onto the same position',
          st.get('turnNumber') == 4 and st.get('boardState', {}).get(ctx['bt']) and st.get('currentTurn') == name,
          {k: st.get(k) for k in ('turnNumber', 'currentTurn')})
    q, r = ctx['bt'].split(',')
    nb.send({'type': 'make_move', 'from': ctx['bt'], 'to': f'{q},{int(r) + 1}'})
    m = ctx['white'].type('move_made')
    check('the rejoined player can still move', m['turnNumber'] == 5, m)
    # Back in the lobby on a fresh socket, as the client does. Rejoining the
    # room used to recreate this player's record without their secret, and the
    # lobby then handed them a guest's name.
    back = WS('/ws/game/lobby/'); back.type('connection_established')
    back.send({'type': 'join_lobby', 'username': name, 'secret': SECRET[name], 'rejoining': True})
    seen = []
    while not seen or seen[-1] != 'user_list':
        seen.append(back.recv().get('type'))
    check('a player who rejoined keeps their name in the lobby', 'username_assigned' not in seen, seen)
    ctx.update(black=nb, back=back)
step('rejoin', rejoin)

print('\n[end]')
def end():
    white, black = ctx['white'], ctx['black']
    white.send({'type': 'resign'})
    oa, ob = white.type('game_over'), black.type('game_over')
    check('a resignation ends the game for both', oa['endReason'] == ob['endReason'] == 'resign', (oa, ob))
    check('the other player wins', oa['winner'] == ctx['start']['playerBlack'], oa)
    black.send({'type': 'make_move', 'from': '0,0', 'to': '0,1'})
    e = black.type('error')
    check('nothing moves after the game is over', e.get('code') == 'GAME_OVER', e)
step('end', end)

for w in [ctx.get('la'), ctx.get('lb'), ctx.get('back'), ctx.get('white'), ctx.get('black')]:
    if w:
        w.close()
print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if results and all(results) else 1)
