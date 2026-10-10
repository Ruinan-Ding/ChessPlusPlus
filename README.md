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
cannot initiate attacks. Its Vet 2 Counter strikes back at ring 1 with ATK 4
before DEF; Warcry cannot grant it an initiating attack. Damage is flat and deterministic:

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
Vet 1 adds +2 current/max HP, ring 3 for 4 healing and ring 4 for 2 healing. Healing spends its attack
action, costs no CP and can be undone before End Turn. It is available in solo and online play;
it is separate from pool and unit abilities. Every postmatch permits abilities and normal
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
when ATK is unavailable; they affect the shieldman’s Counter if it unlocks before expiry.
Current/max HP, MOV, DEF, ATK/HEL tiers and unit ranges cap at 99, including
veterancy and temporary boosts. Currencies and unit prices keep their existing rules.

**Bases and reserves** can be struck from the battlefield. A unit in a reserve strikes back; one
in a base never does, but it mends an HP at the end of each of its side's turns - and only while
it stays there. A king never enters either.

**Winning.** A side loses when its king dies (`rules.objective`: `regicide`, or `elimination`
to play until a side has no units at all). The board is asked who has lost - it is never
inferred from whoever moved last, so a unit that kills itself on a counter-attack loses the game
exactly as it should. Each phase is scored on five capture zones; after Phase 3 a side far enough
ahead on points wins (White must lead by more than 50, Black by more than 25), and
anything closer goes to overtime, where each king pays a toll every
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
the turn in the order it was played, including intervening casts, battlefield actions,
panel moves, crossings and walks home. Online, the server saves a private validated draft while you stage;
End Turn commits the complete batch in one revision. Undo updates that saved draft and
a reload restores its preview. The board is committed at End Turn or timer expiry.
**Replay (Z)** shows the last completed turn in yellow, then restores staged moves and
zoom. It spends nothing and does not extend the turn clock. The F shortcut still flips
the board. Flip sits to the left of Start Game and is disabled before the match starts.

**Points and abilities.** Regular points start at 10 and accrue at the start of each side's turns until overtime,
with a grant of 20 as each numbered phase starts. Unit points (UP) start at 10 per side. Battlefield
attack/counter kills pay unit value in UP; panel and ability kills pay none.
Walking home refunds `max(1, value - 1 - current missing HP)` UP, using departure HP.
Crossings spend unit value in UP. Each halftime adds that side's current phase VP snapshot
to UP once; CP and UP appear together. Pool
abilities spend points; paths and their abilities spend CP, awarded once per postmatch on top of
starting CP. Its fixed portion is 10/20/30; VP totals and the shortfall bonus remain. Unlimited activatable ability labels show remaining/total cooldown and cost, such as `Warcry (0/3) 15`
ready and `Warcry (3/3) 15` just used. Path purchases read `Bastion - 10`, `Onslaught - 25`,
`Sprint - 50`, paid in CP. Using one is click-then-target:
press the slot, then click who it lands on - a friendly unit for a boost, an enemy for damage. Clicking
the wrong kind of target cancels instead. Temporary stat changes (+MOV, +ATK, +DEF and +HEL) last as configured; damage and
healing are immediate; the Unit panel shows current over base, so a +4 on
a pawn's base ATK 6 reads `1:10/6`, and +MOV gives real extra steps. Effects follow unit identity
through moves and reloads, and expire on their own caster's turn. An armed friendly
ability takes priority over the bishop's normal healing. **Abilities run in solo and
multiplayer**. Online casts, costs, cooldowns, recipients and combat bonuses are resolved
by the server; saved private drafts restore staged choices and casts after reconnect.

The pool is Warcry/Sap, Bulwark/Weakening, Dash/Mire and Mend/Strike. Pick one pair first;
the second unlocks five full turns later (Turn 1 → Turn 6). Each player has their own wait,
preserved through reload. Stat effects last through
the caster's turn and the opponent's, expiring at the caster's next turn. Sap, Weakening and
Mire each require one selected enemy on the battlefield or in green reserve. Red-base
units are ineligible; only the selected unit receives the effect and keeps it if it
returns to base before expiry.
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
the browser and timer cannot commit it twice. Automatic end-of-turn replay pauses
both the solo and online clocks; the 900 ms turn notice also consumes no turn time
and leaves units playable. Manual Replay (Z) keeps counting. Online presentation time
is determined by the server and preserved through rejoining. An untouched selector preserves an edited
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
Sacrifice selects another friendly battlefield/green-reserve unit: permanently
add one star (max 3), fully heal it, and grant +2 MOV/+6 ATK/+6 DEF for one full
turn. The pawn dies and counts as its side’s loss; independently select an unused
friendly battlefield unit for an extra action. Cost 24 UP/CD 5, no UP reward.
Only Fortress, Ruin and Blitz remain army-wide activated effects; Call affects
adjacent units. Convert is a no-target currency operation and path passives
remain army-wide passives. Solo and multiplayer retain staging, Undo and reload.
Unit veterancy bonuses, passives and abilities work on the battlefield; both
panels retain earned stars with their unit kit inactive. Entering a panel lowers
maximum HP only; leaving adds the Vet 1 HP bonus to current and maximum once
(for example 5/14 → 5/12 → 7/14). Normal bishop healing requires a battlefield source. The Unit panel describes its Vet 1 bonus above
its passive and ability: gray **Not active** at zero stars or in a panel, green **Active** on the battlefield after earning it.
ATK/HEL descriptions show only new or changed tiers: bishop `+2 HP, HEL 3:4 4:2`,
king `+2 MOV, ATK 2:20`. Queen's Vet 2 Persuade boosts adjacent battlefield allies
at her turn start; King's Vet 2 Capture claims its entire occupied capture zone,
except eligible enemies keep their occupied hexes. Opposing active Capture kings
restore normal capture rules; Vet 3 has no priority over Vet 2.
Pawn’s base ATK is 6. Its Vet 2 Checkmate gives +6 ATK/+6 DEF in the enemy’s first three battlefield
rows; +2 MOV applies only to an action starting there and remains for its whole
walk out. Archer’s Vet 2 Quick permits remaining movement after attacking.
Shieldman’s Vet 2 Counter replaces Shove and does not grant a normal attack.
King’s Call affects only adjacent battlefield/green-reserve units, excluding the
king: allies heal 1 and gain +1 ATK/DEF/MOV; enemies take 1 damage and lose
1 ATK/DEF/MOV for one full turn. It costs 4 UP with cooldown 1.
Bishop’s Regenerate heals only on the battlefield. Red-base deaths now count
for attrition VP, while panel kills still grant no UP bounty. Knight costs 30 UP.

Each side has separate battlefield, base and reserve allowances: 1/2/3 units
in Initialization turns 1/2/3, one in normal play, three at postmatch and 1/2/3
in Overtime stages. Moving a different unit in a category ends the previous
walk until Undo. Units move only once through Initialization. Walking home
spends a battlefield action; reserve entry ends that unit’s action, stops in
the first three home rows and cannot attack on the same turn.

The owner's current roster and first-star numbers
are in [shared/default-config.json](shared/default-config.json), with the earned-star schedule
and specified kits in [AGENTS.md](AGENTS.md). Vet 2 passives and Vet 3 UP abilities run in
solo and authoritative multiplayer, with Undo, cooldowns and reload support;
Bastion (10 CP), Onslaught (25 CP) and Sprint (50 CP) have their specified passives,
utilities, hex skills and one-use ultimates in both modes. Convert, Strengthen and Recharge
each have five uses per initialization, numbered phase or overtime, and cooldown 1.
Their labels show remaining phase uses, e.g. `Convert (5) 25`. Halftime/postmatch share
the numbered phase budget; all overtime stages share one budget. These utilities can
be used during initialization; other casts remain blocked there. Drain, Cleave and Trap
have cooldown 1 and three uses per match, shown as `Trap (3) 50`. Ultimates show `(1)`,
then `(0)` after use. Cooling CP utilities/skills and exhausted buttons stay grey
and remain clickable for explanations. Undo and reload preserve the use budget. Hex skills target any rendered hex
including empty hexes and panels. Recharge opens an explanation before selecting either
half of a carried pair; both positive cooldowns fall by 1 but stop at 1, while abilities
already ready stay at 0. It cannot make a used ability ready again in the same turn.
Temporary effects last through the opponent's turn. Strengthen adds a star to a friendly
battlefield or green-reserve unit, capped at 3; it cannot target a red-base unit.
In reserve, earned stars remain inactive until the unit enters the battlefield.
All three path passives and ultimates include battlefield, green reserve and red base.
Bastion Drain sets centre ATK/HEL to zero, drains ring 1 by 4 and boosts ring 2 by 2 for either
side, without granting absent ATK/HEL. Cleave follows a board-wide horizontal line: 5 damage
on the centre, 3 on the nearest two hexes each side, and 1 HP healing farther out. Trap
follows a board-wide X: the centre locks actions and strips positive temporary buffs,
the nearest two hexes in each diagonal direction lose 4 MOV, and farther X occupants gain
2 MOV. All three shapes include panel hexes and affect current occupants of either side.
Blitz boosts HEL only on existing healers. Older saved catalogues retain their rules.
Unit values now cost 12 UP for pawn/archer/shieldman, 24 for rook, 30 for knight,
32 for bishop, 48 for queen and 64 for king. Those values set battlefield kill payouts and attrition losses; withdrawal refunds
deduct one UP and current missing HP, with a one-UP floor. Starting UP remains 10; the shipped setup already
places 24 battlefield units per side. Vet 3 ability costs are Sacrifice 24, Snare 8,
Taunt 6, Bash/Charge 16, Cast 32, Nullify 12 and Call 4 UP.
Pool costs are Warcry/Bulwark 25, Sap 35, Weakening 15, Dash/Strike 20 and
Mire/Mend 10 regular points. Convert spends 25 CP for 50 regular points. CP skill/ultimate costs
are Drain 50/Fortress 250, Cleave 50/Ruin 250 and Trap 50/Blitz 250; Strengthen and
Recharge each cost 25 CP. These are the owner's 9 Oct prices; path purchases,
cooldowns, effects and use limits are unchanged.
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
Authoritative multiplayer ability coverage is in `test_online_abilities.py`; rendered
room tests and separate native Chrome checks cover staging, targeting and reconnect.
Regression coverage includes Strengthen followed by phase promotion, reserve ability
casualties, stationary panel action locks, and completed panel/multi-step Replay after reload.
Equivalent coordinate spellings share movement costs; pass broadcasts refresh ability
expiry/cooldowns, and protected counters and Charge strikes remain visible in completed
Replay even when they deal zero damage. Panel attack replay follows the attacker’s UID.
Replay also retains actors that died or moved again after combat, including Rapid Movement
and a Charge victim's counter. Older saved frames recover missing actor identity from history.
Upgrading the backend requires migration **0014_ability_state** before starting the new
server. Existing rows keep an empty default until their first batched turn.

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