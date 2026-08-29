# ChessPlusPlus

A turn-based tactics game on a hex grid - Fire Emblem's shape of combat rather than chess's,
though it started from chess and still wears its pieces as placeholders. Django Channels over
WebSocket on the back, Angular on the front.

The engine contains **no unit-specific code**. Movement, combat and setup are read from one
config file; a unit id is an opaque label. Changing what a unit is means editing data, not
Python. That config lives in three places that must agree - the JSON Schema in `shared/`, the
server's defaults in `config_loader.py`, and the client's in `config.service.ts`.

## How a game works

**The board** is a hexagon of radius 11 (397 hexes), squared off with four tinted corner
panels - the reserve planes, one pair per player. Coordinates are axial `q,r`; a hex is on the
battlefield when `max(|q|, |r|, |q+r|) <= radius`.

**One unit acts per turn.** Sides alternate. Picking a unit shows two layers at once: pale
green for every hex it could stand on, red for hexes it could not reach but could still strike
from where it can get to. Hovering shows the same for anyone's unit, your opponent's included -
knowing what a thing threatens is half the game.

**Movement** is a flood fill bounded by the unit's `MOV`, through empty hexes only. Units block
each other, ally and enemy alike, so a wall costs you the detour: a hex three steps away around
an obstacle costs three, not the one hex of straight-line distance. A unit keeps walking on
what is left of its budget until it attacks or the turn ends.

**Attacking** is separate from moving. Each unit has an `attackRange` in rings of hex distance,
ignoring obstacles - most reach only the six neighbours, some reach two or three rings out for
less damage each ring (`rules.rangeFalloff`). Damage is flat and deterministic:

```
damage = attacker ATK (at that range) - defender DEF     floored at 0
```

The defender then counters with the same sum reversed, but only if the attacker is inside *its*
range - so a two-ring unit striking a melee unit takes nothing back. A unit at 0 HP dies and
never counters. The attacker holds its ground even on a kill; taking the hex would be free
movement, and movement is the thing being budgeted.

**Losing** is regicide: a side is beaten when it has no unit flagged `commander` left. The
board is asked who has lost - it is never inferred from whoever moved last, so a unit that
kills itself on a counter-attack loses the game exactly as it should.

**A turn is staged before it is sent.** Steps and the attack pile up on a local stack, so the
board shows where the unit would end up; Undo pops one action at a time; End Turn sends the
whole turn as a single `make_move` and the server ends the turn on receipt. Nothing is
committed until then.

**Points and abilities.** Each side banks a point at the start of its turn and one per kill.
Abilities cost points and go on cooldown when used. Using one is click-then-target: press the
slot, then click who it lands on - a friendly unit for a boost, an enemy for damage. Clicking
the wrong kind of target cancels instead. The effect is a one-turn stat change (+MOV, +ATK,
+DEF, or damage); the Unit panel shows
boosted over base, so a +4 on a base 26 reads `30/26`, and +MOV is real extra steps, not just a
number. Each side box holds six slots: four actives, a passive and a once-per-game ultimate.
The passive is always on, never clicked, and unlocked at ★2; the actives are not gated.

**Reserves.** Each player has two corner panels holding units that are not yet in the war. They
can be inspected and shuffled inside their own panel and nothing more: they cannot move or
strike out of it, and nothing on the battlefield can reach in. How they enter play is the next
thing to design.

**Single player needs no server at all.** A solo game runs entirely in the browser and survives
a reload; the lobby lets you in with any name - or none - when the server is unreachable. It
does not *refuse* a server either: when one is up, the socket stays on the lobby, so the roster
and lobby chat are live while you play alone.

### Still placeholder

The unit roster (chess pieces), every stat value, the ability effects and costs, and veterancy
ranks. They are numbers in a config file waiting for the real game design, not mechanics baked
into the engine.

## Running the Application

Both at once, restarting whichever is already running:

```bash
./start.sh          # Ctrl-C stops both
./start.sh -k       # just stop them
```

Both stream into the one terminal. The rest of this
section is what that script does, if you would rather run them by hand.

### First-time setup
```bash
cd server
python -m venv venv
source venv/Scripts/activate      # Windows; use venv/bin/activate on macOS/Linux
pip install -r requirements.txt

cd ../client
npm install
```

### Backend
```bash
cd server
source venv/Scripts/activate      # or call it by path: venv/Scripts/daphne.exe
DJANGO_DEBUG=true daphne core.asgi:application
```
(Windows cmd: `set DJANGO_DEBUG=true&& daphne core.asgi:application`; PowerShell: `$env:DJANGO_DEBUG='true'; daphne core.asgi:application`)

`daphne: command not found` means the venv isn't active.

`DJANGO_DEBUG=true` must be set for **any** local `manage.py` command too
(`test`, `makemigrations`, `migrate`, `runserver`, etc.) — without it Django
requires a real `DJANGO_SECRET_KEY`/`DJANGO_ALLOWED_HOSTS` and refuses to
start, by design (see `server/core/settings.py`).

### Frontend
```bash
cd client
npx ng serve
```
(`ng` is a local devDependency, not a global install — `npx` resolves it. `ng: command not
found` means you dropped the `npx`.)

Then open: http://localhost:4200

## Maintenance

### Clean up stale connections
If you notice ghost users in the lobby, run:
```bash
cd server
python manage.py cleanup_game_state
```

This removes player connections that haven't sent a heartbeat in 10+ minutes.