"""Edge cases for a networked match, against a running server.

    DJANGO_DEBUG=true venv/Scripts/daphne.exe core.asgi:application     # from server/
    venv/Scripts/python.exe scripts/e2e/edges.py                         # in a second shell

Crossed and double-clicked invites, a start racing its readies, inviting a
player in a game, a second tab replacing the first, a token kept alive by
heartbeats, and a disconnect after the result. Two checks wait out the 30s
disconnect grace period, so a run takes about a minute and a half. It reads
and backdates rows in the dev database the server is using.
"""
import json, os, random, string, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from wslib import WS, check, step, results

SERVER = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PY = sys.executable
GRACE = 30  # DISCONNECT_GRACE_SECONDS


def orm(code):
    """Run a line of Django ORM against the dev database the live server uses."""
    out = subprocess.run([PY, 'manage.py', 'shell', '-c', code], cwd=SERVER, capture_output=True,
                         text=True, env={**os.environ, 'DJANGO_DEBUG': 'true'}, timeout=60)
    if out.returncode:
        raise RuntimeError(out.stderr[-500:])
    # The last line: `shell` prints an auto-import banner ahead of anything the code prints.
    return out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ''


tag = ''.join(random.choices(string.digits, k=4))
A, B, C, D = (f'Edge{n}{tag}' for n in 'ABCD')
ctx = {}
print(f'Players {A} {B} {C} {D}')


def lobby(name):
    w = WS('/ws/game/lobby/'); w.type('connection_established')
    w.send({'type': 'join_lobby', 'username': name, 'secret': 's-' + name})
    w.until(lambda m: m.get('type') == 'user_list' and name in json.dumps(m), f'{name} listed')
    return w


def setup():
    for n in (A, B, C, D):
        ctx[n] = lobby(n)
step('lobby setup', setup)

print('\n[7b] crossed invites, sent back to back')
def crossed():
    ctx[C].send({'type': 'game_challenge', 'challenger': C, 'opponent': D})
    ctx[D].send({'type': 'game_challenge', 'challenger': D, 'opponent': C})
    on_c, on_d = ctx[C].drain(3), ctx[D].drain(3)
    delivered = [m for m in on_c + on_d if m.get('type') == 'game_challenge']
    refused = [m.get('code') for m in on_c + on_d if m.get('type') == 'error']
    check('only one of two crossed invites goes through', len(delivered) == 1,
          {'delivered': delivered, 'refused': refused})
    for m in delivered:  # clear it, so C and D are free again
        who = ctx[m['opponent']]
        who.send({'type': 'challenge_decline', 'challenger': m['challenger'], 'opponent': m['opponent']})
    time.sleep(1)
step('crossed invites', crossed)

print('\n[7a] double accept')
def double_accept():
    ctx[A].send({'type': 'game_challenge', 'challenger': A, 'opponent': B})
    ctx[B].type('game_challenge')
    ctx[B].send({'type': 'challenge_accept', 'challenger': A, 'opponent': B})
    ctx[B].send({'type': 'challenge_accept', 'challenger': A, 'opponent': B})
    on_a, on_b = ctx[A].drain(3), ctx[B].drain(3)
    acc_a = [m for m in on_a if m.get('type') == 'challenge_accepted']
    acc_b = [m for m in on_b if m.get('type') == 'challenge_accepted']
    check('a double-clicked accept makes one room', len(acc_a) == 1 and len(acc_b) == 1,
          {'A': acc_a, 'B': acc_b, 'B errors': [m for m in on_b if m.get('type') == 'error']})
    rooms = orm(f"from game.models import GameRoom; print(GameRoom.objects.filter(host='{A}', opponent='{B}').count())")
    check('and the database agrees', rooms == '1', rooms)
    ctx.update(game=acc_a[0]['gameId'], ta=acc_a[0]['token'], tb=acc_b[0]['token'])
step('double accept', double_accept)

print('\n[7c] start sent before the readies are confirmed')
def race_start():
    g = ctx['game']
    ga = WS(f'/ws/game/{g}/'); ga.type('connection_established')
    gb = WS(f'/ws/game/{g}/'); gb.type('connection_established')
    ga.send({'type': 'join_game_room', 'username': A, 'gameId': g, 'token': ctx['ta'], 'secret': 's-' + A}); ga.type('join_game_room_success')
    gb.send({'type': 'join_game_room', 'username': B, 'gameId': g, 'token': ctx['tb'], 'secret': 's-' + B}); gb.type('join_game_room_success')
    ga.send({'type': 'player_ready', 'username': A, 'gameId': g})
    gb.send({'type': 'player_ready', 'username': B, 'gameId': g})
    ga.send({'type': 'start_game', 'gameId': g})
    first = ga.until(lambda m: m.get('type') == 'game_started'
                     or (m.get('type') == 'error' and m.get('code') == 'NOT_ALL_READY'), 'start or refusal')
    if first.get('type') == 'error':
        # Refused honestly. Once both readies have landed, the same start goes through.
        time.sleep(1)
        ga.send({'type': 'start_game', 'gameId': g})
        first = ga.type('game_started')
    started = gb.type('game_started')
    check('an early start is refused or goes through, never half-started',
          first['turnNumber'] == started['turnNumber'] == 1)
    ctx.update(ga=ga, gb=gb, start=started)
step('start race', race_start)

print('\n[8] inviting a player who is in a game')
def busy():
    ctx[C].send({'type': 'game_challenge', 'challenger': C, 'opponent': A})
    e = ctx[C].until(lambda m: m.get('type') == 'error', 'refusal')
    check('an invite to a player in a game is refused', e.get('code') == 'OPPONENT_BUSY', e)
    stray = [m for m in ctx[A].drain(1.5) if m.get('type') == 'game_challenge']
    check('and never reaches them', not stray, stray)
step('busy invite', busy)

print(f'\n[9] the same player opens a second tab, then the first closes ({GRACE + 3}s)')
def second_tab():
    g = ctx['game']
    b2 = WS(f'/ws/game/{g}/'); b2.type('connection_established')
    b2.send({'type': 'join_game_room', 'username': B, 'gameId': g, 'token': ctx['tb'], 'secret': 's-' + B})
    b2.type('join_game_room_success')
    ctx['ga'].drain(1)
    ctx['gb'].close()  # the old tab
    noise = [m.get('type') for m in ctx['ga'].drain(3)]
    check('the opponent is not told a player left who is still here', 'opponent_disconnected' not in noise, noise)
    later = [m for m in ctx['ga'].drain(GRACE) if m.get('type') == 'game_over']
    check('and no forfeit fires when the grace period runs out', not later, later)
    ctx['gb'] = b2
step('second tab', second_tab)

print('\n[6] a long unbroken session, then a drop')
def token_expiry():
    g = ctx['game']
    # Three seconds left on the clock: the last moments of a ten-minute game
    # played without a reload. The seated client's heartbeat lands, as one does
    # every fifteen seconds, then the old expiry passes and the connection drops.
    orm("from game.models import GameRoom; from django.utils import timezone; from datetime import timedelta; "
        f"GameRoom.objects.filter(game_id='{g}').update(token_expires_at=timezone.now() + timedelta(seconds=3))")
    ctx['ga'].send({'type': 'heartbeat'})
    ctx['ga'].type('heartbeat_ack')
    time.sleep(4)
    ctx['ga'].close()
    time.sleep(1)
    ga = WS(f'/ws/game/{g}/'); ga.type('connection_established')
    ga.send({'type': 'join_game_room', 'username': A, 'gameId': g, 'token': ctx['ta'], 'secret': 's-' + A})
    m = ga.until(lambda m: m.get('type') in ('join_game_room_success', 'error'), 'join answer')
    check('a player in a game past the token lifetime can still rejoin',
          m.get('type') == 'join_game_room_success', m)
    if m.get('type') != 'join_game_room_success':
        # Leave the rest of the run a room to finish in.
        orm("from game.models import GameRoom; from django.utils import timezone; from datetime import timedelta; "
            f"GameRoom.objects.filter(game_id='{g}').update(token_expires_at=timezone.now() + timedelta(minutes=10))")
        ga.close()
        ga = WS(f'/ws/game/{g}/'); ga.type('connection_established')
        ga.send({'type': 'join_game_room', 'username': A, 'gameId': g, 'token': ctx['ta'], 'secret': 's-' + A})
        ga.type('join_game_room_success')
    ctx['ga'] = ga
step('token expiry', token_expiry)

print(f'\n[10] the winner disconnects after the game ends ({GRACE + 3}s)')
def after_end():
    ga, gb = ctx['ga'], ctx['gb']
    loser, winner = A, B
    ga.send({'type': 'resign'})
    over = ga.type('game_over')
    gb.type('game_over')
    check('resign ends it', over.get('winner') == winner and over.get('endReason') == 'resign', over)
    gb.close()
    extra = [m for m in ga.drain(GRACE + 3) if m.get('type') == 'game_over']
    check('no second result is announced after a disconnect', not extra, extra)
    row = orm("from game.models import GameState; "
              f"s = GameState.objects.filter(game_id='{ctx['game']}').first(); print(s.winner, s.end_reason)")
    check('the recorded result is still the resignation', row == f'{winner} resign', row)
step('after end', after_end)

for w in list(ctx.values()):
    if isinstance(w, WS):
        w.close()
print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if results and all(results) else 1)
