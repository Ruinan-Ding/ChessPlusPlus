"""Schedule endings between real sockets against a running server.

    DJANGO_DEBUG=true venv/Scripts/daphne.exe core.asgi:application     # from server/
    venv/Scripts/python.exe scripts/e2e/endings.py                       # in a second shell

The ASGI integration tests also play complete matches. These four matches use
real network sockets, starting with the shipped setup:

* **Turn 50.** Both sides occupy a home-zone outer hex, worth 3 per phase,
  then pass. Their tied tallies survive the early endings and Phase 3;
  overtime takes 28 HP from each king and leaves both standing: Black wins.
  A player rejoins partway and receives the frozen bank.
* **Points.** White holds a home outer hex worth 3; Black holds a side outer
  hex worth 1. Phase multipliers make the final lead 12, enough for White.
  Both Phase 3 postmatch halves still finish before the result.
* **Phase 1.** White occupies no eligible capture hex at tally. Black wins
  after both postmatch halves; a reconnect preserves the pending loss.
* **Phase 2.** White occupies an eligible capture hex, so Phase 1 continues.
  Black tallies zero VP in Phase 2 and loses after the full postmatch.

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
# (-4,9) is a white pawn on the deal. One step up puts it on the outer
# ring of its home capture zone, centred on (-3,6). Outer-ring units score
# only their occupied hex, worth 3; adjacent hexes can only be neutralized.
INTO_ZONE, HOLDS = ('-4,9', '-4,8'), 3


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


def play_out(m, first_move=None, second_move=None, rejoin_at=None):
    """Every ply from 1 until the match ends. Returns what each hand-over said."""
    said, over = {}, None
    for ply in range(1, 120):
        time.sleep(PLY_PACE)
        got, over = hand_over(m, ply, first_move if ply == 1 else second_move if ply == 2 else None)
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


def banks_where_expected(label, said, last, entry_for):
    """
    Each phase banks on the hand-over into its postmatch, as *entry_for* of
    the phase's number says, and never moves after.
    """
    for ply, phase in BANKS_AT.items():
        if ply > last + 1:
            continue
        before = said.get(ply - 1, {}).get('phaseBank', {})
        after = said[ply]['phaseBank'] if ply in said else None
        check(f'{label}: Phase {phase} is not banked before its postmatch', phase not in before, before)
        if after is not None:
            check(f'{label}: Phase {phase} banks on the hand-over into turn {(ply + 1) // 2}',
                  after.get(phase) == entry_for(int(phase)), after.get(phase))
    moved = [(p, phase) for ply, phase in BANKS_AT.items() if ply in said
             for p in sorted(said) if p > ply
             and said[p]['phaseBank'].get(phase) != said[ply]['phaseBank'].get(phase)]
    check(f'{label}: a banked phase never changes afterwards', not moved, moved[:5])


print(f'\n[turn 50]  E2EFiftyA{tag} / E2EFiftyB{tag}')
def fifty():
    m = seat('Fifty')
    king_start_hp = {color: king_hp(m['start']['boardState'], color) for color in ('white', 'black')}
    said, over, last = play_out(m, first_move={'type': 'make_move', 'from': '-4,9', 'to': '-4,8'},
                                 second_move={'type': 'make_move', 'from': '4,-9', 'to': '4,-8'}, rejoin_at=40)
    ctx['fifty'] = m
    check('turn 50: the match runs until black passes the last ply, 100', last == 100, last)
    tied = {'white': 3, 'black': 3}
    banks_where_expected('turn 50', said, last, lambda phase: {'white': 3 * phase, 'black': 3 * phase})
    check("turn 50: a close Phase 3 settles nothing - its postmatch hands on to turn 37",
          said.get(73, {}).get('currentTurn') == m['start']['playerWhite'], said.get(73, {}).get('currentTurn'))
    resync = m.get('resync', {})
    check('turn 50: a player who rejoins mid-match gets the bank with the state',
          resync.get('phaseBank') == {'1': tied} and resync.get('turnNumber') == 41,
          {k: resync.get(k) for k in ('phaseBank', 'turnNumber')})
    before_ot = said[OVERTIME_PLY]['boardState']
    check('turn 50: nothing is tolled before overtime',
          all(king_hp(before_ot, color) == king_start_hp[color] for color in king_start_hp),
          (king_hp(before_ot, 'white'), king_hp(before_ot, 'black')))
    first = said[OVERTIME_PLY + 1]['boardState']
    check("turn 50: overtime's first turn takes 1 off white's king",
          king_hp(first, 'white') == king_start_hp['white'] - 1 and king_hp(first, 'black') == king_start_hp['black'],
          (king_hp(first, 'white'), king_hp(first, 'black')))
    last_board = said[100]['boardState']
    check('turn 50: the toll has taken 28 off white and 23 off black before the last ply',
          king_hp(last_board, 'white') == king_start_hp['white'] - 28 and king_hp(last_board, 'black') == king_start_hp['black'] - 23,
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
    said, over, last = play_out(m, first_move={'type': 'make_move', 'from': frm, 'to': to},
                                 second_move={'type': 'make_move', 'from': '8,-10', 'to': '7,-2'})
    ctx['points'] = m
    check('points: white steps into the capture zone on the first turn',
          said.get(2, {}).get('type') == 'move_made' and said[2]['boardState'].get(to), said.get(2, {}).get('type'))
    check("points: Phase 3's postmatch is still played",
          said.get(72, {}).get('currentTurn') == m['start']['playerBlack'], said.get(72, {}).get('currentTurn'))
    check('points: the match ends as the postmatch does, on the hand-over into turn 37', last == 72, last)
    banks_where_expected('points', said, last, lambda phase: {'white': HOLDS * phase, 'black': phase})
    check(f'points: white, {(HOLDS - 1) * 6} clear, takes it on points',
          over.get('endReason') == 'points' and over.get('winner') == m['start']['playerWhite'], over)
    m['black'].send({'type': 'request_game_state', 'gameId': m['game']})
    st = m['black'].until(lambda x: x.get('type') in ('game_state_update', 'game_state'), 'game state')
    bank = st.get('phaseBank', {})
    check('points: the finished state holds Phase 3 banked as it ended, none of it late',
          bank.get('3') == {'white': HOLDS * 3, 'black': 3} and not any(e.get('late') for e in bank.values()),
          bank)
step('points', points)


for phase, last, loser in [(1, 28, 'white'), (2, 50, 'black')]:
    def early(phase=phase, last=last, loser=loser):
        label = f'Phase{phase}'
        m = seat(label); ctx[label] = m
        first = {'type': 'make_move', 'from': '-4,9', 'to': '-4,8'} if phase == 2 else None
        said, over, ended = play_out(m, first_move=first, rejoin_at=last - 1)
        bank = said[last].get('phaseBank', {}).get(str(phase), {})
        check(f'{label}: tally freezes the pending loser', bank.get('pendingLoss') == loser, bank)
        check(f'{label}: first postmatch half hands over to Black',
              said[last].get('currentTurn') == m['start']['playerBlack'], said[last].get('currentTurn'))
        check(f'{label}: reconnect preserves the pending result',
              m.get('resync', {}).get('phaseBank', {}).get(str(phase)) == bank, m.get('resync', {}).get('phaseBank'))
        check(f'{label}: both postmatch halves finish before the loss', ended == last, ended)
        check(f'{label}: the other side wins on the phase result',
              over.get('endReason') == 'phase_result' and over.get('winner') == m['start']['playerBlack' if loser == 'white' else 'playerWhite'], over)
        m['white'].send({'type': 'request_game_state', 'gameId': m['game']})
        state = m['white'].type('game_state_update')
        check(f'{label}: final snapshot retains result and frozen bank',
              state.get('endReason') == 'phase_result' and state.get('phaseBank', {}).get(str(phase)) == bank, state.get('phaseBank'))
    step(f'Phase {phase} early ending', early)


for m in ctx.values():
    for w in (m or {}).get('lobby', ()) + tuple(m[k] for k in ('white', 'black') if m and k in m):
        w.close()
print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if results and all(results) else 1)
