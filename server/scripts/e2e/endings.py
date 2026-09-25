"""The schedule's two endings, played out between real sockets against a running server.

    DJANGO_DEBUG=true venv/Scripts/daphne.exe core.asgi:application     # from server/
    venv/Scripts/python.exe scripts/e2e/endings.py                       # in a second shell

The unit tests reach turn 50 by winding a stored game forward. Here every one of
the hundred plies is played: two matches, start to finish.

* **Turn 50.** Both sides pass every turn. Each phase banks 0-0 on the
  hand-over into its postmatch - the deal claims no capture hex - so Phase 3
  settles nothing and the match runs into overtime, where the toll takes 21
  off each king (8 x 1, 5 x 2, 1 x 3) and leaves both standing: black's.
  A player drops and rejoins partway, and gets the bank back with the state.
* **Points.** White steps one unit into a capture zone on the first turn and
  both sides pass the rest. It holds 5 hexes as each phase banks, 15 clear
  when Phase 3 does - more than 5 - so the match ends there, on turn 36.

Exits non-zero if any check fails.
"""
import json, os, random, string, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from wslib import WS, check, step, results

tag = ''.join(random.choices(string.digits, k=4))
ctx = {}

# The hand-overs into the three postmatches (turns 14, 25, 36), where each
# phase banks, and the ply overtime starts on (turn 37).
BANKS_AT = {27: '1', 49: '2', 71: '3'}
# The server throttles a socket past 30 messages in 10 seconds (consumers.py,
# RATE_LIMIT_*). Each side sends every other ply, so a ply every 0.2s keeps
# each at 25 in 10 seconds.
PLY_PACE = 0.2
OVERTIME_PLY = 73
KING_HP = 45
# (-4,9) is a white unit on the deal; one step up puts it on the edge of the
# capture zone round (-3,6), where it holds its own hex and the four zone hexes
# beside it: (-3,8), (-5,8), (-4,7), (-3,7).
INTO_ZONE, HOLDS = ('-4,9', '-4,8'), 5


def seat(label):
    a, b = f'E2E{label}A{tag}', f'E2E{label}B{tag}'
    secret = {a: 'a-' + tag, b: 'b-' + tag}
    la = WS('/ws/game/lobby/'); la.type('connection_established')
    la.send({'type': 'join_lobby', 'username': a, 'secret': secret[a]})
    lb = WS('/ws/game/lobby/'); lb.type('connection_established')
    lb.send({'type': 'join_lobby', 'username': b, 'secret': secret[b]})
    la.until(lambda m: m.get('type') == 'user_list' and a in json.dumps(m) and b in json.dumps(m),
             'user list with both')
    la.send({'type': 'game_challenge', 'challenger': a, 'opponent': b})
    lb.type('game_challenge')
    lb.send({'type': 'challenge_accept', 'challenger': a, 'opponent': b})
    ma, mb = la.type('challenge_accepted'), lb.type('challenge_accepted')
    game, token = ma['gameId'], {a: ma['token'], b: mb['token']}

    def join(name):
        w = WS(f'/ws/game/{game}/'); w.type('connection_established')
        w.send({'type': 'join_game_room', 'username': name, 'gameId': game,
                'token': token[name], 'secret': secret[name]})
        w.type('join_game_room_success')
        return w

    socks = {name: join(name) for name in (a, b)}
    for name in (a, b):
        socks[name].send({'type': 'player_ready', 'username': name, 'gameId': game})
    socks[a].until(lambda m: m.get('type') == 'player_ready' and m.get('username') == b, 'B ready')
    socks[a].send({'type': 'start_game', 'gameId': game})
    start = socks[a].type('game_started')
    socks[b].type('game_started')
    check(f'{label}: two players are seated in a started room',
          start['turnNumber'] == 1 and start.get('phaseBank') == {}, start.get('phaseBank'))
    return {'game': game, 'start': start, 'join': join, 'lobby': (la, lb),
            'white': socks[start['playerWhite']], 'black': socks[start['playerBlack']]}


def king_hp(board, color):
    return next(p['hp'] for p in board.values() if p['unit_id'] == 'king' and p['color'] == color)


def hand_over(m, ply, send):
    """
    Play *ply* with *send* (a pass unless given) and read the hand-over off
    both sockets. Returns the turn_passed / move_made the other side got, and
    the game_over if the hand-over ended the match.
    """
    mover, other = (m['white'], m['black']) if ply % 2 else (m['black'], m['white'])
    mover.send(send or {'type': 'pass_turn'})
    seen = lambda msg: ((msg.get('type') in ('turn_passed', 'move_made') and msg.get('turnNumber') == ply + 1)
                        or msg.get('type') == 'game_over')
    got = other.until(seen, f'the hand-over into ply {ply + 1}')
    mover.until(seen, f'the hand-over into ply {ply + 1} (mover)')
    if got['type'] == 'game_over':
        return None, got
    over = None
    if not got.get('currentTurn'):
        over = other.type('game_over')
        mover.type('game_over')
    return got, over


def play_out(m, first_move=None, rejoin_at=None):
    """Every ply from 1 until the match ends. Returns what each hand-over said."""
    said, over = {}, None
    for ply in range(1, 120):
        time.sleep(PLY_PACE)
        got, over = hand_over(m, ply, first_move if ply == 1 else None)
        if got:
            said[ply + 1] = got
        if over:
            return said, over, ply
        if ply == rejoin_at:
            name = m['start']['playerBlack']
            m['black'].close()
            m['black'] = m['join'](name)
            m['black'].send({'type': 'request_game_state', 'gameId': m['game']})
            m['resync'] = m['black'].until(
                lambda x: x.get('type') in ('game_state_update', 'game_state'), 'game state')
    return said, over, None


def banks_where_expected(label, said, last, entry):
    """Each phase banks on the hand-over into its postmatch, and never moves after."""
    for ply, phase in BANKS_AT.items():
        if ply > last + 1:
            continue
        before = said.get(ply - 1, {}).get('phaseBank', {})
        after = said[ply]['phaseBank'] if ply in said else None
        check(f'{label}: Phase {phase} is not banked before its postmatch', phase not in before, before)
        if after is not None:
            check(f'{label}: Phase {phase} banks on the hand-over into turn {(ply + 1) // 2}',
                  after.get(phase) == entry, after.get(phase))
    moved = [(p, phase) for ply, phase in BANKS_AT.items() if ply in said
             for p in sorted(said) if p > ply
             and said[p]['phaseBank'].get(phase) != said[ply]['phaseBank'].get(phase)]
    check(f'{label}: a banked phase never changes afterwards', not moved, moved[:5])


print(f'\n[turn 50]  E2EFiftyA{tag} / E2EFiftyB{tag}')
def fifty():
    m = seat('Fifty')
    said, over, last = play_out(m, rejoin_at=40)
    ctx['fifty'] = m
    check('turn 50: the match runs until black passes the last ply, 100', last == 100, last)
    zero = {'white': 0, 'black': 0}
    banks_where_expected('turn 50', said, last, zero)
    check('turn 50: a close Phase 3 settles nothing - turn 37 is handed on',
          said.get(71, {}).get('currentTurn') == m['start']['playerWhite'], said.get(71, {}).get('currentTurn'))
    resync = m.get('resync', {})
    check('turn 50: a player who rejoins mid-match gets the bank with the state',
          resync.get('phaseBank') == {'1': zero} and resync.get('turnNumber') == 41,
          {k: resync.get(k) for k in ('phaseBank', 'turnNumber')})
    before_ot = said[OVERTIME_PLY]['boardState']
    check('turn 50: nothing is tolled before overtime',
          king_hp(before_ot, 'white') == king_hp(before_ot, 'black') == KING_HP,
          (king_hp(before_ot, 'white'), king_hp(before_ot, 'black')))
    first = said[OVERTIME_PLY + 1]['boardState']
    check("turn 50: overtime's first turn takes 1 off white's king",
          king_hp(first, 'white') == KING_HP - 1 and king_hp(first, 'black') == KING_HP,
          (king_hp(first, 'white'), king_hp(first, 'black')))
    last_board = said[100]['boardState']
    check('turn 50: the toll has taken 21 off white and 18 off black before the last ply',
          king_hp(last_board, 'white') == KING_HP - 21 and king_hp(last_board, 'black') == KING_HP - 18,
          (king_hp(last_board, 'white'), king_hp(last_board, 'black')))
    check('turn 50: both kings standing at the end is black\'s, on overtime',
          over.get('endReason') == 'overtime' and over.get('winner') == m['start']['playerBlack'], over)
    m['white'].send({'type': 'make_move', 'from': '0,9', 'to': '0,8'})
    e = m['white'].type('error')
    check('turn 50: nothing moves after it', e.get('code') == 'GAME_OVER', e)
    m['white'].send({'type': 'request_game_state', 'gameId': m['game']})
    st = m['white'].until(lambda x: x.get('type') in ('game_state_update', 'game_state'), 'game state')
    check('turn 50: the finished state holds all three phases and turn 51',
          sorted(st.get('phaseBank', {})) == ['1', '2', '3'] and st.get('turnNumber') == 101,
          {k: st.get(k) for k in ('phaseBank', 'turnNumber')})
step('turn 50', fifty)


print(f'\n[points]  E2EPointsA{tag} / E2EPointsB{tag}')
def points():
    m = seat('Points')
    frm, to = INTO_ZONE
    said, over, last = play_out(m, first_move={'type': 'make_move', 'from': frm, 'to': to})
    ctx['points'] = m
    check('points: white steps into the capture zone on the first turn',
          said.get(2, {}).get('type') == 'move_made' and said[2]['boardState'].get(to), said.get(2, {}).get('type'))
    check('points: the match ends on the hand-over into Phase 3\'s postmatch, ply 71', last == 70, last)
    banks_where_expected('points', said, last, {'white': HOLDS, 'black': 0})
    check('points: white, 15 clear, takes it on points',
          over.get('endReason') == 'points' and over.get('winner') == m['start']['playerWhite'], over)
    m['black'].send({'type': 'request_game_state', 'gameId': m['game']})
    st = m['black'].until(lambda x: x.get('type') in ('game_state_update', 'game_state'), 'game state')
    bank = st.get('phaseBank', {})
    check('points: the finished state holds Phase 3 banked as it ended, none of it late',
          bank.get('3') == {'white': HOLDS, 'black': 0} and not any(e.get('late') for e in bank.values()),
          bank)
step('points', points)


for m in (ctx.get('fifty'), ctx.get('points')):
    for w in (m or {}).get('lobby', ()) + tuple(m[k] for k in ('white', 'black') if m and k in m):
        w.close()
print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if results and all(results) else 1)
