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
has no base attack; Vet 2 Shove unlocks a 4-ATK attack at ring 1. Warcry boosts
Shove but never enables a shieldman counter. Damage is flat and deterministic:

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
battlefield unit at ring 1 for 8 HP or ring 2 for 6 HP, capped at the target's maximum.
Vet 1 adds ring 3 for 4 HP and ring 4 for 2 HP. Healing spends its attack
action, costs no CP and can be undone before End Turn. It is available in solo and online play;
it is separate from the solo ability catalogue. Every postmatch permits abilities and normal
healing while normal unit attacks remain blocked. Initialization permits the path's CP utility, while other casts and
normal healing remain blocked.

**Veterancy** starts at zero. Both sides' battlefield and green-reserve units gain a star as
Phase 1 starts and as each numbered phase's postmatch starts, up to three. Red-base units gain
none there, but returning veterans keep their stars. Ordinary turns, damage and kills grant
none. At Phase 3 postmatch start, living battlefield and green-reserve units already at
vet 3 heal to full; units gaining their third star then keep their current HP.
The Unit panel shows rows HP/MOV, ATK/DEF and HEL/VET, with each attack or heal amount
labelled by range. Unavailable ATK/HEL shows —; buffs cannot create those stats.
A stat reduced to numeric 0 can still be buffed. ATK debuffs stay until expiry even
when ATK is unavailable; they affect Shove if it unlocks before expiry. Vet 2 shieldmen gain Shove’s 4 ATK
for attacks only and never counterattack, even with Warcry.

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

**Early phase results:** White loses at Phase 1 tally if no eligible White unit occupies
a capture-zone hex. Black loses at Phase 2 tally if its phase VP is 0. Each result is
frozen at tally; both postmatch turns still finish before the loss. Killing the other
king during postmatch takes priority.

**A turn is staged before it is sent.** Steps, attacks and casts pile up on a local stack, so
the board shows where each unit would end up; Undo pops one action at a time. End Turn sends
the turn in the order it was played: panel moves, crossings and walks home first, then
battlefield moves. Online, the server saves a private validated draft while you stage;
End Turn commits the complete batch in one revision. Undo updates that saved draft and
a reload restores its preview. The board is committed at End Turn or timer expiry.

**Points and abilities.** Points accrue at the start of each side's turns until overtime,
with a grant as each numbered phase starts. Unit points (UP) start at 10 per side. Battlefield
attack/counter kills and walking home pay unit value in UP; panel and ability kills pay none.
Crossings spend unit value in UP. Each halftime adds that side's current phase VP snapshot
to UP once; CP and UP appear together. Pool
abilities spend points; paths and their abilities spend CP, awarded at postmatch on top of the
starting CP. Unlimited activatable ability labels show remaining/total cooldown and cost, such as `Warcry (0/3) 4`
ready and `Warcry (3/3) 4` just used. Path purchases read `Bastion - 5`, `Onslaught - 10`,
`Sprint - 20`, paid in CP. Using one is click-then-target:
press the slot, then click who it lands on - a friendly unit for a boost, an enemy for damage. Clicking
the wrong kind of target cancels instead. Temporary stat changes (+MOV, +ATK, +DEF and +HEL) last as configured; damage and
healing are immediate; the Unit panel shows current over base, so a +4 on
a pawn's base ATK 8 reads `1:12/8`, and +MOV gives real extra steps. Effects follow unit identity
through moves and solo reloads, and expire on their own caster's turn. An armed friendly
ability takes priority over the bishop's normal healing. **Abilities are solo only for now**:
the server has not implemented authoritative casts, costs, cooldowns or combat boosts.

The pool is Warcry/Sap, Bulwark/Weakening, Dash/Mire and Mend/Strike. Stat effects last through
the caster's turn and the opponent's, expiring at the caster's next turn. Sap, Weakening and
Mire affect the enemy battlefield and green-reserve units present when cast. Red-base units
and later arrivals are excluded; affected returnees keep the effect until it expires.
Costs, cooldowns and amounts are in [AGENTS.md](AGENTS.md#ability-panels). Effects on
multiple recipients animate together as one cast, including in the turn recap.
Exhausted abilities turn grey; clicking still shows their description and "Used up" status.

A 0.9-second announcement slides in from the right, holds the centre for about half a second, then exits
left with a short swoosh after the board replay, without blocking clicks. Each side gets
`Turn N` above `White` or `Black` in a matching white/black box. Stage changes show the larger
stage name above it, including halftimes, postmatches and numbered overtime stages.

**Lobby entry** accepts a blank name: the game picks a random name for that tab. The server
claims names atomically and assigns another free guest name if a candidate is already held.
Whitespace-only entry works too; nonempty names still follow the displayed name rules.

**The timer selector follows the setup.** The shipped default is Unlimited. Choosing a timed
option starts a visible countdown, with beeps during the last five seconds and a stronger
beep at zero. Expiry commits the staged turn, passing if empty. Online, the server commits
the latest validated saved draft even if its player disconnects during the grace period;
the browser and timer cannot commit it twice. An untouched selector preserves an edited
solo config's own limit.

**Board readability:** a gold outline traces the outer hex edges around the battlefield
and all four panels. Blue seams mark where each base/reserve panel meets the battlefield.
White's base and reserve, and Black's darker panels, use contrasting hex outlines so neighbouring
cells remain distinct. The outline follows the hex-shaped perimeter. Your green turn
background slowly brightens; the opponent's red background slowly dims. Reduced motion
keeps these backgrounds steady. Closed-arrow crosses use lighter red for visibility over
dark units. Unit passive/ability details stay pinned to their unit and close when another
unit is selected or the selection is cleared, including the first touch tap on a
normal healing or attack target.

**Single player needs no server at all.** A solo game runs entirely in the browser and survives
a reload; the lobby lets you in with any name - or none - when the server is unreachable. It
does not *refuse* a server either: when one is up, the socket stays on the lobby, so the roster
and lobby chat are live while you play alone.

### Implementation status

The first four ability pairs and all eight unit veterancy kits are implemented.
Vet 1 changes movement, combat, healing and current/max HP in both engines, including after
reload; red-base units gain no rank there. The owner's 4 Oct roster and first-star numbers
are in [shared/default-config.json](shared/default-config.json), with the earned-star schedule
and specified kits in [AGENTS.md](AGENTS.md). Vet 2 passives and Vet 3 UP abilities run in
solo, with Undo, cooldowns and reload support. Online ability execution remains deferred;
Bastion (5 CP), Onslaught (10 CP) and Sprint (20 CP) have their specified passives,
utilities, hex skills and one-use ultimates in solo. Convert, Strengthen and Recharge
each have five uses per initialization, numbered phase or overtime, and cooldown 1.
Their labels show remaining phase uses, e.g. `Convert (5) 3`. Halftime/postmatch share
the numbered phase budget; all overtime stages share one budget. These utilities can
be used during initialization; other casts remain blocked there. Sap, Cleave and Trap
have cooldown 1 and three uses per match, shown as `Trap (3) 15`. Ultimates show `(1)`,
then `(0)` after use. Cooling CP utilities/skills and exhausted buttons stay grey
and remain clickable for explanations. Undo and reload preserve the use budget. Hex skills target any rendered hex
including empty hexes and panels. Recharge opens an explanation before selecting either
half of a carried pair; both positive cooldowns fall by 1 but stop at 1, while abilities
already ready stay at 0. It cannot make a used ability ready again in the same turn.
Temporary effects last through the opponent's turn. Strengthen adds a star, capped at 3.
Bastion Sap sets centre ATK/HEL to zero; Blitz boosts HEL only on existing healers.
The full costs, cooldowns, scopes and interactions are recorded in [AGENTS.md](AGENTS.md).

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

## Testing

The regular client suite includes `game-room.integration.spec.ts`: rendered button and hex
clicks pass through the real room, WebsocketService, LocalGameService, GameStateService and
saved state. It plays a complete 72-ply match from the shipped setup and checks all eight
unit abilities, the three CP paths, pool targeting, Undo, cooldowns, expiry, reload, restart,
draws and deliberate exit. Tactical ability cases arrange a saved position; the complete match
uses actual turn commits throughout. Sound and animation delays are skipped in these tests.

The server suite includes `FullMatchLiveIntegrationTests`, which starts two seated ASGI
connections and plays every turn to a points finish or the end of overtime. Both players'
broadcasts are checked against the database, with phase banks, veterancy, halftime UP,
revision ordering and restored results. `TurnDraftTests` and `TurnDraftProtocolTests`
check private staging, malformed inputs, stale seats and revisions, atomic panel/combat/heal
batches, deadline races, phase boundaries and disconnected-player commits. These run
automatically in the existing CI jobs.

From `client/`, run `npx ng test --watch=false --browsers=ChromeHeadless --code-coverage`.
From `server/`, run `DJANGO_DEBUG=true python manage.py test` (or `game.testsuite` for the
canonical suite). Windows installs used from WSL need the `cmd.exe` commands in
[CODEX_HANDOFF.md](CODEX_HANDOFF.md). Coverage reports are generated in `client/coverage/`.

Integration tests exercise gameplay and protocol boundaries. Real socket/browser checks
remain separate: `server/scripts/e2e/` covers live connections and rejoining; its
`drafts.py` also checks saved-turn privacy, Undo, duplicate commits and a real 15-second
disconnected-player expiry from the shipped deal.
`client/scripts/layout-sweep.mjs` checks responsive layouts and reachable controls against
a running client. See [AGENTS.md](AGENTS.md) for commands and spare-port guidance.
Online ability execution remains deferred under PUNCHLIST 6.15.

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