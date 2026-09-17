"""The panels in a networked match, between two real sockets, against a running server.

    DJANGO_DEBUG=true venv/Scripts/daphne.exe core.asgi:application     # from server/
    venv/Scripts/python.exe scripts/e2e/panels.py                        # in a second shell

Until the server learned to derive the panels, none of this could happen in a
networked game at all: the room switched it off, because a server with no panel
to look a unit up in rejected the move outright. This drives the three things it
answers now - a crossing, a walk home, and a blow into a panel - and the ways it
refuses them. Exits non-zero if any check fails.
"""
import json, os, random, string, sys
sys.path.insert(0, os.path.dirname(__file__))
from wslib import WS, check, step, results

tag = ''.join(random.choices(string.digits, k=4))
A, B = f'E2EPanelA{tag}', f'E2EPanelB{tag}'
SECRET = {A: 'a-' + tag, B: 'b-' + tag}
ctx = {}
print(f'Players {A} / {B}')

# From the panel deal, which is derived rather than stored (engine/panels.py):
# white's reserve archer, and the board hex one step through its gateway.
ARCHER_AT, LANDS_ON = '7,7', '3,8'
# White's pawn that starts beside its own base doorway.
PAWN_AT, DOORWAY = '-11,11', '-12,11'


print('\n[seat]')
def seat():
    la = WS('/ws/game/lobby/'); la.type('connection_established')
    la.send({'type': 'join_lobby', 'username': A, 'secret': SECRET[A]})
    lb = WS('/ws/game/lobby/'); lb.type('connection_established')
    lb.send({'type': 'join_lobby', 'username': B, 'secret': SECRET[B]})
    la.until(lambda m: m.get('type') == 'user_list' and A in json.dumps(m) and B in json.dumps(m),
             'user list with both')
    la.send({'type': 'game_challenge', 'challenger': A, 'opponent': B})
    lb.type('game_challenge')
    lb.send({'type': 'challenge_accept', 'challenger': A, 'opponent': B})
    ma, mb = la.type('challenge_accepted'), lb.type('challenge_accepted')
    game, token = ma['gameId'], {A: ma['token'], B: mb['token']}

    socks = {}
    for name in (A, B):
        w = WS(f'/ws/game/{game}/'); w.type('connection_established')
        w.send({'type': 'join_game_room', 'username': name, 'gameId': game,
                'token': token[name], 'secret': SECRET[name]})
        w.type('join_game_room_success')
        socks[name] = w
    for name in (A, B):
        socks[name].send({'type': 'player_ready', 'username': name, 'gameId': game})
    socks[A].until(lambda m: m.get('type') == 'player_ready' and m.get('username') == B, 'B ready')
    socks[A].send({'type': 'start_game', 'gameId': game})
    start = socks[A].type('game_started')
    socks[B].type('game_started')
    white, black = socks[start['playerWhite']], socks[start['playerBlack']]
    check('two players are seated in a started room', start['turnNumber'] == 1, start)
    ctx.update(la=la, lb=lb, white=white, black=black, game=game)
step('seat', seat)


print('\n[crossing]')
def crossing():
    white, black = ctx['white'], ctx['black']

    black.send({'type': 'enter_board', 'from': '-7,-7', 'to': '-3,-8'})
    e = black.type('error')
    check('only the side to move may cross', e.get('code') == 'NOT_YOUR_TURN', e)

    # Offered a queen with a thousand HP. What is standing there is an archer.
    white.send({
        'type': 'enter_board', 'from': ARCHER_AT, 'to': LANDS_ON,
        'unit': {'unit_id': 'queen', 'color': 'white', 'hp': 1000, 'max_hp': 1000, 'uid': 'rbr4'},
    })
    mine = white.type('game_state_update')
    theirs = black.type('game_state_update')
    landed = mine['boardState'].get(LANDS_ON) or {}
    check('a reserve unit crosses onto the board', landed.get('uid') == 'rbr4', landed)
    check('the server lands the unit it derived, not the one offered',
          landed.get('unit_id') == 'archer' and landed.get('hp') == 16, landed)
    check('the other player sees the same crossing',
          (theirs['boardState'].get(LANDS_ON) or {}).get('uid') == 'rbr4', theirs['boardState'].get(LANDS_ON))
    check('a crossing does not take the turn',
          mine['turnNumber'] == 1 and mine['currentTurn'] == theirs['currentTurn'], mine['turnNumber'])
    last = mine['moveHistory'][-1]
    check('the record carries what the panels are derived from',
          last.get('entered') is True and (last.get('unit') or {}).get('uid') == 'rbr4', last)

    white.send({'type': 'enter_board', 'from': ARCHER_AT, 'to': '3,7'})
    e = white.type('error')
    check('the same unit cannot cross twice', e.get('code') == 'INVALID_MOVE', e)

    white.send({'type': 'enter_board', 'from': '9,3', 'to': LANDS_ON})
    e = white.type('error')
    check('a crossing out of reach is refused', e.get('code') == 'INVALID_MOVE', e)
step('crossing', crossing)


print('\n[blow]')
def blow():
    white = ctx['white']
    # Nothing of white's reaches a black panel from the opening position, so
    # this can only show a refusal over the wire. The blow itself - reserve
    # answers, base never does - is pinned by the consumer tests.
    white.send({'type': 'panel_attack', 'from': '-11,11', 'to': '-11,11', 'attack': '-9,-3',
                'counters': False})
    e = white.type('error')
    check('a blow into a panel out of reach is refused, and answered', e.get('code') == 'INVALID_MOVE', e)
step('blow', blow)


print('\n[walk home]')
def walk_home():
    white, black = ctx['white'], ctx['black']

    white.send({'type': 'make_move', 'from': PAWN_AT, 'to': '12,-11', 'withdraw': True})
    e = white.type('error')
    check("nobody walks home into the other side's base", e.get('code') == 'INVALID_MOVE', e)

    white.send({'type': 'make_move', 'from': PAWN_AT, 'to': DOORWAY, 'withdraw': True})
    mine, theirs = white.type('move_made'), black.type('move_made')
    check('a unit walks home, and it is the turn', mine['turnNumber'] == 2, mine.get('turnNumber'))
    check('it leaves the board for both players',
          PAWN_AT not in mine['boardState'] and PAWN_AT not in theirs['boardState'])
    check('the record keeps the unit that left',
          mine['move'].get('withdrawn') is True and mine['move']['unit'].get('uid') == 'w-11,11',
          mine['move'])
step('walk home', walk_home)


print('\n[shuffle then cross]')
def shuffle_then_cross():
    """
    The hole the recorded panel moves close. A walk inside a panel used to be
    sent to nobody, so the server still had the unit where it was dealt and
    refused the crossing made from where the walk had left it. It is black's
    turn now: black's reserve archer, point-mirrored from white's.
    """
    white, black = ctx['white'], ctx['black']
    black.send({'type': 'panel_move', 'from': '-7,-7', 'to': '-6,-7'})
    mine, theirs = black.type('game_state_update'), white.type('game_state_update')
    walked = mine['moveHistory'][-1]
    check('a walk inside a panel is recorded',
          walked.get('panelMove') is True and walked['unit'].get('uid') == 'rtl4'
          and walked.get('cost') == 1, walked)
    check('the other player receives the walk', theirs['moveHistory'][-1].get('panelMove') is True)
    check('a walk does not take the turn', mine['turnNumber'] == 2)

    black.send({'type': 'enter_board', 'from': '-6,-7', 'to': '-3,-8'})
    crossed = black.type('game_state_update')
    check('the unit crosses from where the walk left it',
          (crossed['boardState'].get('-3,-8') or {}).get('uid') == 'rtl4',
          crossed['boardState'].get('-3,-8'))
step('shuffle then cross', shuffle_then_cross)


for w in [ctx.get('la'), ctx.get('lb'), ctx.get('white'), ctx.get('black')]:
    if w:
        w.close()
print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if results and all(results) else 1)
