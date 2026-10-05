# ChessPlusPlus

A turn-based tactics game on a hex grid - Fire Emblem's shape of combat rather than chess's,
though it started from chess and still uses chess-derived unit names. Django Channels over
WebSocket on the back, Angular on the front.

The engine contains **no unit-specific code**. Movement, combat and setup are read from one
config file; a unit id is an opaque label. Changing what a unit is means editing data, not
Python. That file is `shared/default-config.json`, which the server and the client both load,
with the JSON Schema beside it; each side checks a custom config by the same rules, and
`config-parity.json` holds the cases both have to answer alike.

## How a game works

This is the outline. **Every match rule, with its number, is in
[CONFIG_BLUEPRINT.md](CONFIG_BLUEPRINT.md)** - the owner's checklist - and the reasoning behind
each one is in [AGENTS.md](AGENTS.md).

**The board** is a hexagon of radius 11 (397 hexes), squared off with four corner panels: each
player's **base** and **reserve**. Coordinates are axial `q,r`; a hex is on the battlefield when
`max(|q|, |r|, |q+r|) <= radius`.

**A match** is a three-turn opening, three phases of ten turns, each ending with a postmatch
turn, and overtime if the points are close. What a turn may do depends on where the match is:
the opening and each postmatch are for setting out, with no attacks.

**Sides alternate, and a side moves one unit on the battlefield a turn** - two in Overtime 2
and three in Overtime 3, where switching to another unit ends the first one's move. Besides
that, and as the stage allows, a side may start units moving in its panels, bring them out of
its reserve onto the board, or walk them home into its base. Picking a unit shows two layers at
once: pale green for every hex it could stand on, red for hexes it could not reach but could
still strike from where it can get to. Hovering shows the same for anyone's unit, your
opponent's included - knowing what a thing threatens is half the game.

**Movement** is a flood fill bounded by the unit's `MOV`. A unit walks **through its own side's
units** but may not stop on one; **an enemy blocks** both its hex and the way past it, so going
round one costs the detour. A unit keeps walking on what is left of its budget until it attacks,
heals or the turn ends.

**Attacking** is separate from moving. Reach is a band of hex-distance rings from optional
`attackMinRange` (default 1) through `attackRange`, ignoring obstacles. Explicit attack lists
set each ring's amount; scalar attacks use `rules.rangeFalloff`. The shipped archer attacks
only at rings 3-6, for 4, 3, 2 and 1 before defence, and cannot hit a closer target. Shieldman
has no base attack; Warcry gives it attacks and counters at ring 1. Damage is flat and deterministic:

```
damage = attacker ATK (at that range) - defender DEF
         floored at rules.minStrikeDamage (default 1), capped at ATK
```

**A blow that lands always takes something off.** Armour blunts a hit; it does not turn it
aside. The floor used to be 0, which left some matchups unable to hurt each other. Set
`rules.minStrikeDamage` to 0 for the old behaviour. An attacker with no ATK at all still deals
nothing: the floor lifts a blow that was blunted, not one that was never thrown.

The defender then counters with the same sum reversed, but only if the attacker is inside *its*
range, including its minimum - so an archer striking a melee unit at ring 3 takes nothing
back. A unit at 0 HP dies and never counters. The attacker holds its ground even on a kill; taking the hex would be free
movement, and movement is the thing being budgeted.

**Healing** is the bishop's normal action: it may move, then heal one other friendly
battlefield unit at ring 1 for 8 HP, capped at the target's maximum. Healing spends its attack
action, costs no CP and can be undone before End Turn. It is available in solo and online play;
it is separate from the solo ability catalogue. Every postmatch permits abilities and normal
healing while normal unit attacks remain blocked. Initialization permits neither casts nor
normal healing.

**Veterancy** starts at zero. Both sides' battlefield and green-reserve units gain a star as
Phase 1 starts and as each numbered phase's postmatch starts, up to three. Red-base units gain
none there, but returning veterans keep their stars. Ordinary turns, damage and kills grant
none. At Phase 3 postmatch start, living battlefield and green-reserve units already at
vet 3 heal to full; units gaining their third star then keep their current HP.
The Unit panel shows rows HP/MOV, ATK/DEF and HEL/VET, with each attack or heal amount
labelled by range.

**Bases and reserves** can be struck from the battlefield. A unit in a reserve strikes back; one
in a base never does, but it mends an HP at the end of each of its side's turns - and only while
it stays there. A king never enters either.

**Winning.** A side loses when its king dies (`rules.objective`: `regicide`, or `elimination`
to play until a side has no units at all). The board is asked who has lost - it is never
inferred from whoever moved last, so a unit that kills itself on a counter-attack loses the game
exactly as it should. Each phase is scored on five capture zones; after Phase 3 a side far enough
ahead on points wins, and anything closer goes to overtime, where each king pays a toll every
turn it plays.

**Capture zones** have cumulative unit permissions: pawn, archer and shieldman can capture
or neutralize their own 3x zone; bishop, rook and knight can also work the middle 2x and side
1x zones; king and queen can work every zone. An outer-ring unit scores only the hex it stands
on, but disrupts adjacent enemy claims. An inner-ring unit also scores adjacent zone hexes.
A centre unit controls all nineteen hexes only while no eligible enemy is inside that zone;
otherwise its normal adjacent claims apply. Solid gold outlines mark centres, dashed gold
outlines the inner ring; black's 3x zone is dark blue and white's is light blue.

**A turn is staged before it is sent.** Steps, attacks and casts pile up on a local stack, so
the board shows where each unit would end up; Undo pops one action at a time. End Turn sends
the turn in the order it was played: the panel moves, crossings and walks home first, then one
message per battlefield move, each but the last marked `more` - and only the last hands the
turn over. Nothing is committed until then.

**Points and abilities.** Points accrue at the start of each side's turns until overtime,
with a grant as each numbered phase starts. Unit points (UP) start at 10 per side. Battlefield
attack/counter kills and walking home pay unit value in UP; panel and ability kills pay none.
Crossings spend unit value in UP. Each halftime adds that side's current phase VP snapshot
to UP once; CP and UP appear together. Pool
abilities spend points; paths and their abilities spend CP, awarded at postmatch on top of the
starting CP. Activatable abilities have configured cooldowns. Using one is click-then-target:
press the slot, then click who it lands on - a friendly unit for a boost, an enemy for damage. Clicking
the wrong kind of target cancels instead. The effect is a stat change (+MOV, +ATK, +DEF, or
damage) for as long as the ability says; the Unit panel shows current over base, so a +4 on
a pawn's base ATK 8 reads `1:12/8`, and +MOV gives real extra steps. Effects follow unit identity
through moves and solo reloads, and expire on their own caster's turn. An armed friendly
ability takes priority over the bishop's normal healing. **Abilities are solo only for now**:
the server has not implemented authoritative casts, costs, cooldowns or combat boosts.

The pool is Warcry/Sap, Bulwark/Weakening, Dash/Mire and Mend/Strike. Stat effects last through
the caster's turn and the opponent's, expiring at the caster's next turn. Sap, Weakening and
Mire affect the enemy battlefield and green-reserve units present when cast. Red-base units
and later arrivals are excluded; affected returnees keep the effect until it expires.
Costs, cooldowns and amounts are in [AGENTS.md](AGENTS.md#ability-panels).

A 0.6-second announcement slides in from the right, pauses briefly at the centre, then exits
left with a short swoosh, marking each full turn without blocking clicks. Stage changes show
the larger stage name above its turn number, including halftimes, postmatches and numbered overtime stages.

**Single player needs no server at all.** A solo game runs entirely in the browser and survives
a reload; the lobby lets you in with any name - or none - when the server is unreachable. It
does not *refuse* a server either: when one is up, the socket stays on the lobby, so the roster
and lobby chat are live while you play alone.

### Still placeholder

The first four ability pairs and all eight unit veterancy kits are implemented.
Vet 1 changes movement, combat, healing and current/max HP in both engines, including after
reload; red-base units gain no rank there. The owner's 4 Oct roster and first-star numbers
are in [shared/default-config.json](shared/default-config.json), with the earned-star schedule
and specified kits in [AGENTS.md](AGENTS.md). Vet 2 passives and Vet 3 UP abilities run in
solo, with Undo, cooldowns and reload support. Online ability execution remains deferred;
CP path effects await their rules.

## Running the Application

Both at once, restarting whichever is already running:

```bash
./start.sh          # Ctrl-C stops both
./start.sh -k       # just stop them
```

Both stream into the one terminal. It brings the database up to date first
(`manage.py migrate`, which does nothing when there is nothing to apply), and
starts nothing if that fails. The rest of this section is what that script
does, if you would rather run them by hand.

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
DJANGO_DEBUG=true python manage.py cleanup_game_state
```

This removes player connections that haven't sent a heartbeat in 10+ minutes, clears
invites nobody ever answered (releasing both players from "invited", which otherwise
refuses every future invite as busy), and deletes game rooms closed more than 7 days ago.

Nothing schedules this - the server sweeps stale connections on its own every time it
sends a user list, and clears dead invites on every new invite, so running it is a manual
tidy-up rather than a requirement. `--closed-days` and `--stale-minutes` set the two
thresholds; `--closed-days` **deletes** rooms and their game states, so check before
running it against a database you care about.