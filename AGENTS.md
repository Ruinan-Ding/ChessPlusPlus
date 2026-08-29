# AGENTS.md

Guidance for AI agents working in this repo. Human-readable too — `README.md` covers
setup, this covers the things that are easy to get wrong.

## How to work here

**Invoke the `ponytail` plugin for all code work in this repo** — `/ponytail` (default level
`full`). Source: `DietrichGebert/ponytail` marketplace; install with
`/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`.
It is currently installed at *user* scope, so a fresh clone by someone else won't have it.

The plugin is the source of truth for what "lazy" means here — don't restate its rules in
this file, just run it. Sibling skills: `/ponytail-review` (over-engineering review of a
diff), `/ponytail-audit` (whole-repo), `/ponytail-debt` (harvest `ponytail:` comments into a
ledger), `/ponytail-help`.

Two repo-specific notes that override nothing but are easy to get wrong under it:
the engine's config-driven design means a *small* diff in the wrong place silently breaks the
invariants below — read the code a change touches before picking a rung. And the game spec is
the owner's call, never a "reasonable default" (see **Game spec** below).

## What this is

A hex-grid tactical game (Fire-Emblem-style combat, chess-derived turn structure) with a
Django Channels WebSocket backend and an Angular frontend. Units have HP and attack;
combat deals damage rather than capturing outright.

## Commands

```bash
# Server (from server/)
DJANGO_DEBUG=true daphne core.asgi:application        # serve on :8000
DJANGO_DEBUG=true python manage.py test               # 89 tests
DJANGO_DEBUG=true python manage.py test game.testsuite  # 85 tests, engine + consumers + models

# Client (from client/)
ng serve                                              # serve on :4200
ng test
```

`DJANGO_DEBUG=true` is required for **every** local `manage.py` invocation. Without it
`core/settings.py` demands a real `DJANGO_SECRET_KEY`/`DJANGO_ALLOWED_HOSTS` and refuses to
start. That is deliberate — don't "fix" it.

`server/venv/` is gitignored, so a fresh clone has no venv — build one from
`server/requirements.txt`. Once it exists, either activate it (`source venv/Scripts/activate`)
or call the binaries by path without activating: `venv/Scripts/python.exe`,
`venv/Scripts/daphne.exe`. Client tooling is the same story — `ng` is not global, use `npx ng`.

## Architecture invariants

Break these and the design stops working.

**1. The engine contains no unit-specific code.** `board.py`, `move_validator.py`,
`game_logic.py` never branch on a unit id. `'king'`, `'pawn'` etc. are opaque labels; all
movement and combat behaviour is read from config data. Adding a unit type must require
zero engine changes. If you find yourself writing `if unit_id == ...`, the behaviour belongs
in the config schema instead.

**2. Config lives in three places that must stay identical.** See the `config-sync` skill.
Any change to config shape touches all three or validation rejects live configs:

| File | What |
|---|---|
| `shared/game-config.schema.json` | JSON Schema (draft-07), the contract |
| `server/game/engine/config_loader.py` | `DEFAULT_CONFIG` + `_validate_config()` |
| `client/src/app/services/config.service.ts` | `DEFAULT_GAME_CONFIG` (line ~28) + `validateGameRules()` |

**3. Movement is a single `move` stat per unit** (an adjacent-hex step budget), not a pattern
list. `move_validator.get_legal_moves()` floods outward through the six hex neighbours, through
empty hexes only — a unit can never move through or onto an occupied hex, ally or enemy. No
direction/range/canJump DSL, and no white/black mirroring: flood fill is inherently symmetric.

**4. Reveal mode must never inspect config shape.** `_handle_request_reveal_mode` /
`_handle_reveal_response` treat the config as an opaque blob so that new config sections need
no transport-layer changes. Keep it that way.

## Hex geometry

Axial coordinates `(q, r)`, flat-top, radius-N board holds every hex where
`max(|q|, |r|, |q+r|) <= N`. Default radius is 11 (12 cells per edge, 397 hexes).
Reference: https://www.redblobgames.com/grids/hexagons/

Six neighbour directions (`HEX_DIRECTIONS` in `board.py`; `board.neighbours()` /
`valid_neighbours()` reuse them). There is no diagonal direction vocabulary anymore — that only
ever existed for the deleted direction-pattern movement system. `hex_distance()` in `board.py`
is the hex metric — use it, don't re-derive it.

`buildCells()` renders **more than the battlefield**: it fills every hex whose centre falls
inside the battlefield's centre-bounds *plus half a column on each flank*, squaring the board
off with `filler` cells. 541 cells at radius 11 — 397 battlefield, 144 filler; 23 per even row,
24 per odd. Bbox 1164×980. One continuous grid, no overlays.

Three rules, all learned the hard way:

**Fill by pixel bounds, never by row count.** Padding each row to a fixed number of cells looks
equivalent and is not: odd rows are staggered half a cell, so a fixed count shifts the whole
block sideways and leaves one flank a column short — visibly, as alternating gaps down that
edge. Bounding by `|x| <= limitX` is symmetric by construction. Verify by asserting every row
has equal filler counts left and right, and that the bbox centre is 0.

**Half a column of overhang, not a whole one.** Because odd rows are staggered, `limitX += step/2`
reaches the odd rows only and leaves both parities flush at the same outer edge. A full `step`
adds a cell to *every* row, so even rows jut half a hex past odd ones — a visible alternating
overhang down both flanks. This was tried and rejected.

**Don't add rows.** Row count stays 2N+1. Adding rows to force a 1:1 pixel aspect shrinks the
hexagon and was rejected. The block is 1.188:1 and that is intended — a hex grid cannot be both
row-symmetric and pixel-square, because pointy-top rows sit 1.5·S apart vertically but √3·S
apart horizontally, so squaring needs ~1.155× more rows than columns.

The bounds are guarded with `!onBattlefield`, so tuning them can only ever trim filler. Without
that guard, narrowing `limitX` silently shaves the hexagon's own left and right vertices.

Filler hexes are the **reserve panels** (see Game spec): tinted per corner
(`.panel-tl/tr/bl/br`), and each one holds a placeholder squad that can be selected and shuffled
within its own panel. Confinement is enforced by the `zone` argument to `computeMoveCosts()` /
`computeAttackZone()`, which replaces the `isInsideBoard` bound, plus a same-panel requirement on
attack targeting - so a reserve cannot leave its panel and nothing on the battlefield can reach
into one. Battlefield units still bound themselves with `isInsideBoard`, so movement cannot leak
off the board either.

Serialised coords are `"q,r"` strings (`coord_key` / `parse_coord`). `parse_coord` raises
`ValueError` on anything malformed so callers catch one exception type.

## Config pipeline

Setup screen → `set_custom_config` WS message → `config_loader.load_config()` validates →
`GameRoom.custom_config` (DB) → `build_initial_board(config)` at game start.

This path is tested and reusable. New config sections ride it for free — no consumer changes.
Offline single player skips it entirely and builds the board from `ConfigService.getConfig()`.

## Game spec (living — grows as the owner specifies it)

The game's rules are being specified incrementally by the repo owner, decision by decision.
This section is the running record. It is **not** complete and is not meant to be.

**Never invent game behaviour to fill a gap.** If a rule you need isn't written below, stop and
ask. Anything affecting how the game plays or feels — damage numbers, ranges, turn order, what
an ability does, win conditions, costs — is the owner's call, not a reasonable default.
`IMPLEMENTATION_KICKOFF.md` says this explicitly and it still holds. Ask in small themed
batches, most architecturally expensive question first.

**When the owner specifies a new rule, record it here in the same turn.** A decision that lives
only in a chat log is one the next session will silently contradict.

**Expect these to change.** A decision below can be superseded by a later one. When that
happens, edit the entry — don't append a contradiction — and check whether already-written code
depends on the old version.

Decided so far:

- **Movement is a per-unit `move` stat** (adjacent-hex step budget), flood-filled outward
  through the six hex neighbours. A unit can never move through or onto an occupied hex — own or
  enemy blocks equally, so a blocked path must be routed around. Implemented in
  `move_validator.get_legal_moves()`. Placeholder: every unit in `DEFAULT_CONFIG` currently gets
  `move: 6`; real per-unit values come with the real roster.
- **Running out of time passes the turn**, it does not lose the game (superseded: the turn
  timer used to end the match against whoever was on the clock). The server owns that clock and
  passes for you; the client renders it and, if you had a turn staged, tries to commit it first.
  Timer choices are `{0, 15, 30, 60, 120, 180, 240, 300}` seconds, 0 meaning unlimited, and the
  allow-list lives in `validators.validate_game_options`.
- **One unit acts per turn**, alternating plies (confirmed — the existing chess-like turn
  plumbing stays as-is; move + attack + ability all resolve inside a single player action).
- **Attack is decoupled from movement.** Units carry `attackRange` in rings of `hex_distance`.
  Implemented — see the Combat section.
- **Damage is flat and deterministic.** No hit/dodge/crit rolls.
- **Counter-attacks:** the defender strikes back if the attacker is inside the defender's range.
- **No terrain.** Uniform board, no movement costs or defence bonuses.
- **A unit turn allows move + attack + ability.** An ultimate excludes attacking that same turn.
- **Abilities are hardcoded effects referenced by id from config JSON.** Import/export works
  immediately; there is deliberately no ability DSL yet.
- **Passive, activatable, and unit-level ultimate** abilities. Activatables recharge over N
  turns; ultimates get 1–2 charges per match.
- **Veterancy:** XP from damage dealt, damage received, and kills. Reaching a rank unlocks an
  ability or passive. Rank is *derived* from XP, never stored.
- **Four reserve planes flank the battlefield** — two per player. They are drawn as *hexes in
  the same grid*, filling the hexagon's bounding square so the whole play area is one square of
  hexagons. They are not part of the battlefield: units there are out of play, and
  `get_legal_moves()` never reaches them.
  - **Left plane** = the player's pool. Completely out of the war: it cannot be attacked or
    interacted with by the opponent at all. Troops are staged *from* here.
  - **Right plane** = staged troops. Every couple of phases of the war, units here can be
    selected and deployed into the player's first row. Unlike the left plane, the right plane
    **can** be attacked, but only in very specific ways.
  - **Placeholder squads sit in all four planes** (`buildReserves()` in
    `game-board.component.ts`): five non-commander units from config per panel, white in the
    bottom pair, black in the top. They are **client-side only** - the server's board is the
    radius-N battlefield and `set_cell()` rejects anything outside it - and **confined to their
    own panel**: `computeMoveCosts()` / `computeAttackZone()` take a `zone` set that replaces
    the radius check, and attack targeting requires both hexes to share a panel, so nothing
    reaches across the wall in either direction. Shuffling one inside its panel is local and
    free: no server message, no move budget, not on the Undo stack, and a reload re-deals them.
    How a reserve enters play is still to be designed.
  - **Deployment is not built.** The panels hold units and take clicks, but there is no way in
    or out of them and no server model: the rules above (left plane untouchable, right plane
    deployable and attackable in specific ways) are the owner's spec, not the code. Do not add
    staging/deployment UI unprompted.
  - **Left and right are from each player's own perspective.** The board is drawn white-at-the
    bottom, and a solo game played as Black rotates the whole SVG 180° (`rotateBoard`) so the
    player still faces up the screen; glyphs counter-rotate through `textTransform()`. That is
    presentation only - `panelOf()` and `buildReserves()` key off unrotated geometry, so panel
    ownership never moves. Multiplayer never rotates.
  - Historically the board never flipped —
    white always sits at the bottom, black at the top, so black faces the other way and his
    left is *screen-right*. The panels therefore pair up diagonally, not by column:

    | screen corner | owner | that player's side | colour |
    |---|---|---|---|
    | bottom-left | white | left | red |
    | bottom-right | white | right | light green |
    | top-right | black | left | dark red |
    | top-left | black | right | dark green |

    Left panels are the red pair, right panels the green pair; white gets the bright shades,
    black the dark ones. Wiring the planes up later must follow this mapping — treating
    screen-left as "left plane" would silently give black the wrong two.
  - Still unspecified: plane capacity (squaring the board yields 236 filler hexes, almost
    certainly more than the real design wants), how troops enter the left plane, the exact
    deployment cadence ("a couple of phases"), what a "phase of the war" is, which first-row
    hexes a deployment can target, and the specific ways the right plane can be attacked.

Assumed by an agent, **not** yet confirmed by the owner — treat as weaker than the above and
re-check before building on it:

- **No line-of-sight for ranged attacks** — range is pure `hex_distance`, and units do not block
  shots. Cheapest option; a real LOS check is the upgrade path.

Deferred, not rejected: global (army-wide) ultimates, stat growth on rank, the real config
editor UI.

Not yet specified at all: the actual unit roster (the config still ships chess-piece
placeholders), concrete stat values, ability numbers, XP thresholds, and how many charges an
ultimate gets.

## Single-player rooms (client-side, offline)

A solo game has no second player, so nothing about it needs a server: no `Game` row, no room
UUID, no access token, no socket. It runs entirely in the browser.

- `connectionStatus$` always reports the **socket**, never local mode - a page that says
  "connected" with no server behind it is the bug this used to have. `isConnected()` answers a
  different question ("can I send?") and is true in local mode; the UI keys the roster heading
  and the status line off `connectionStatus$` / `offline$` instead. Three states, not two:
  connected, deliberately offline, and disconnected-but-still-trying.
- `WebsocketService` is the switch. While **local mode** is on, `sendMessage` goes to
  `LocalGameService` instead of the socket, and that service's replies are pushed into the same
  `messages$` every component already listens to. No component knows the difference — the
  protocol is identical, only the transport changed.
- **A solo game does not mean leaving the server.** `startLocalGame()` leaves the socket up and
  points it at the `lobby` room (the solo game has no server room of its own). Only the game's
  own traffic - the `LOCAL_GAME_TYPES` set in `websocket.service.ts` - is answered by
  `LocalGameService`; lobby roster and lobby chat stay the server's whenever it is there. So the
  status line reads "Connected to Game Server" during single player, and the Lobby tab shows the
  real roster.
- **Offline** and **local game** are two different states. Offline is the player saying "stop
  chasing the server": no socket is opened, no reconnect runs, and `sendMessage` drops rather
  than queues, so entering the lobby or typing a username never drags the dialog back up. The
  status line reads "Offline" with a **Reconnect** button beside it - the only way back, and it
  is always visible whenever there is no connection.
- Local mode means **a solo game is in progress**, nothing else. It is turned on by Single
  Player in the lobby and by the connection dialog's Single Player button, remembered in
  `sessionStorage` so a reload resumes it, and turned off by leaving the room - **not** by
  reconnecting, which only lifts the deliberate silence (see The socket). Entering a room that
  is not the solo one also ends it: a game left behind by a closed tab would otherwise answer
  for a real room. Outside a solo game the app always keeps
  trying to reach the server behind the connection dialog, which is what makes the retry
  mechanism visible. A flag that suppressed the dialog left users with no way back and no
  reconnect attempts.
- The connection dialog is the whole story when there is no server: it counts attempts, offers
  **Single Player** from the first attempt (which just goes offline - the lobby's own Single
  Player button starts the game), and adds **Retry Connection** / **Back to Login** once the
  attempts run out. `connectTimeoutMs` caps a single handshake at 3s — Chrome throttles
  repeated failed WebSocket handshakes, and without the cap an attempt can hang for minutes,
  freezing the counter and never reaching the state where Retry appears.
- The room lives at `/game-room/local?token=local`. Those are literals, not identifiers.
- `LocalGameService` persists the whole game to `localStorage` on every change, so a refresh, a
  dropped connection or a server that was never up resume the same position. **Only a deliberate
  exit clears it**: `leave_game_room` is what calls `clear()`, so the game room does not send one
  on an incidental unmount (a browser Back), and `create_single_player_game` resumes a saved
  game rather than dealing over the top of it. Both used to destroy a position in progress.
- **The offline engine mirrors the server's rules**: setup, movement via `services/hex-rules.ts`,
  combat with counter-attacks, regicide, resign, draw. `hex-rules.ts` is shared by the board's
  preview and the local engine; the damage sums and the defeat check are duplicated from
  `game_logic.py` and have specs pinning them to the same numbers. A rule that lands server-side
  has to land here too, or offline play quietly diverges.
- **There is no AI.** You drive both sides; the placeholder seat (`Opponent`) has no agency.

**The server has no solo path at all.** `create_single_player_game`, `singlePlayer` in
`game_options`, the `controls_both` branches, the readiness skip and the `hostColor` pick were
deleted once the client stopped reaching them: unreachable, untested code that still carried
live bugs. Every game the server runs has two real players, which is why nobody chooses their
colour there. Wanting server-side solo rooms back (persistent games across devices, say) means
writing them against the protocol `LocalGameService` already implements, not restoring that.
`_send_game_player_list` filters `gameOptions` to `GAME_OPTION_KEYS` on the way out, because a
room row written by an older build still carries keys the validator now rejects — and the client
sends that dict straight back on its next mode change.

## Combat

A unit's turn is "walk, then optionally swing", carried by one `make_move`:
`{from, to, attack?}` where `to` is where the unit ends up (possibly where it already stood)
and `attack` names the hex it strikes from there.

- **Losing**: the objective is `regicide` - a side is beaten when it has no unit flagged
  `commander: true` left (the king). `elimination` (no units at all) is the other accepted
  value, and a side with nothing on the board is out either way. Who lost is read off the
  board by `defeated_sides()`, never inferred from who moved: a counter-attack can kill the
  attacker's own commander on the attacker's turn - and can take both commanders in one
  exchange, which ends `draw_mutual` rather than crediting the survivor of a list order.
  The end reason names the objective (`regicide` / `elimination`); `find_defeated()` still
  answers "is it over" for callers that need nothing else.
- **Reach** is `units.<id>.attackRange` in rings of hex distance, ignoring obstacles. Damage
  falls off `rules.rangeFalloff` (0.25) per ring past the first, floored, never under 1 — see
  `ranged_damage()`.
- **Damage is `attack - defense`**, floored at 0: armour can absorb a hit entirely but never
  heals (`strike_damage()`).
- **The defender counter-attacks** with the same sum reversed, but only if the attacker is
  inside *its* reach — a melee unit cannot answer a bishop three rings out. A unit reduced to
  0 HP never counters.
- **The attacker holds its ground**, even on a kill. Taking the hex would be free movement, and
  attacking is what ends the unit's movement for the turn.
- `hex-rules.ts` mirrors the damage sums client-side (`strikeDamage`, `rangedDamage`,
  `attackTiers`) for the board glyphs and the offline engine. Change one, change both — the
  specs compare them against these numbers.

## Points

Placeholder economy, entirely client-side for now. Points and cooldowns both move at the **start
of a side's turn** (`beginTurnFor`): +1 point banked, and that side's ability cooldowns tick down
one. Kills are credited as they happen - +1 to whoever killed, including the defender when its
counter-swing kills the attacker. Abilities cost points from `abilityCosts` and grey out when
unaffordable or cooling down; nothing else spends them and no ability does anything yet.

## Entering a game room

Measured, so nobody re-guesses it: the server answers `join_game_room` in ~10 ms, `start_game`
in ~43 ms, `request_game_state` in ~2 ms, and the board builds its 541 cells in ~5 ms and first
paints in ~47 ms. None of that is what makes entry feel slow.

What does: **the lazy route chunk**, which used to be fetched at the moment the player clicked
into a room (cold after every dev rebuild — hence "slow sometimes, instant other times"). The
router now runs `withPreloading(PreloadAllModules)`; all four routes are small.

The lobby and the room both **rejoin on every socket connection**, not just the first. It used to `take(1)`,
so a socket that dropped and reconnected left the player in a room the server no longer had them
in — the page just sat there.

## Staged moves (Undo / End Turn)

**End Turn with nothing staged passes** - a unit turn is optional. That is a `pass_turn`
message (`_handle_pass_turn` server-side, mirrored in `LocalGameService`): same seat checks as a
move, turn number advances, board and move history untouched, broadcast as `turn_passed`.


Clicking a legal hex no longer sends anything. The move is held in `pendingMove` and shown via
`stagedBoard` (the board with the piece relocated), which is what `[boardState]` renders. **Undo**
drops it; **End Turn** sends the `make_move` that commits it — the server ends the turn on
receipt, so committing and ending the turn are the same message.

This is entirely client-side: no new server message and no change to `make_move` semantics
beyond the optional `attack` and `moveBonus` fields. **One unit per turn** is enforced by the
`movesLeftFor` check in `refreshTargets()`: once something is staged, no other unit is handed
legal targets. `canMove` (bound to `!hasAttacked`) is the separate rule that a swing ends the
unit's movement. With either in force the board still takes clicks, it just hands out no
targets. Selecting is always allowed — enemy units, or your own on the opponent's turn, are
inspect-only for the same reason.

Staging is a **stack** (`stagedActions`), oldest first, each entry holding the board as it looked
*after* that action. Undo pops one, so it walks back step by step and takes an attack back just
as cheaply - no inverse operation to get wrong. `stagedBoard` / `pendingMove` are getters over
the top of the stack.

Only the staged unit may act: with something staged, other units still select and inspect but
get no legal targets, or the staged origin and the unit on screen would drift apart.

A unit keeps its remaining steps: the top entry carries a running `used` count charged by
`computeMoveCosts` (the length of the walk, detours included - the straight-line distance
under-charges a unit that had to go round something, and the server would then reject the turn), the board
recomputes legal targets from what is left after every hop, and the Unit panel's MOV shows what
remains. Attacking is staged too - previewed with the same damage sums the server uses - and
ends the unit's movement for the turn (`canMove` goes false). End Turn sends the whole turn as
one `make_move {from, to, attack?}`.

End Turn deliberately leaves `stagedBoard` in place; the `move_made` handler clears it once the
confirmed board arrives. Clearing it at send time flashed the pre-move position for a frame,
which also dropped the selection sitting on the destination hex.

The selection is **sticky**: it follows a piece to its destination and survives the turn change,
so the Unit panel stays pinned until another unit is clicked or hovered. It only clears when the
selected hex ends up empty.

`stagedBoard` previews combat with the same sums the server uses (`strikeDamage` in
`hex-rules.ts`). The server's result is authoritative: `move_made` replaces the staged board
wholesale, so a divergence corrects itself on commit rather than persisting.

## Ability panels

Both side boxes render the same six slots. Each is live only on its own side's turn, via
`canUseAbilities('mine' | 'opponent')`. The opponent's box additionally requires
`isSinglePlayer`, so in multiplayer it is permanently disabled — you can see your opponent's
abilities but never press them. Ability effects are **client-side only**, so activation is
disabled in multiplayer entirely: nothing about them reaches the server, and a boost the
server never heard of would desync the board. The Unit panel carries one ability and the
passive, for whichever unit is selected.

- **Six slots**: four actives, then the passive (`isPassive()` — index 4) and the ultimate
  (`isUltimate()` — index 5) on their own bottom row. The passive is always on, never cast, no
  cost and no cooldown; the ultimate costs more and is once per game.
- **The passive is earned**: ★2 (`vetNeeded()`), read off the displayed unit's veterancy. The
  actives are not gated - `vetNeeded()` returns 0 for them, and `abilityHint()` leaves the
  requirement clause out entirely rather than printing an empty one.
- **Casting is click-then-target.** `selectAbility()` arms the slot rather than firing it; the
  next unit clicked on the board receives it. A friendly-target ability buffs, an enemy-target
  one damages, and clicking the wrong kind cancels. Points and cooldown are spent on landing,
  not on arming. An offensive cast **stages like a move** - it pushes onto `stagedActions`, so
  it shows through a staged step and Undo takes it back.
- **Effects are one-turn stat boosts** (`abilityEffects`, arbitrary placeholder numbers): +MOV,
  +ATK, +DEF. They live in `buffs`, keyed by hex, and expire in `beginTurnFor()` when the side
  that cast them comes round again. The Unit panel shows boosted-over-base (`statAtk` etc.), so
  a +4 on a base 26 reads `30/26`; **+MOV is real steps**, fed to the board as `unitBuffs` and
  into `movesLeft` once a step is staged.
- **Veterancy is drawn beside the name** in `unitPanelTitle` (`Pawn ★★★ - White`), the same
  placeholder rank the hex draws.
- **Boosts have to be declared on `make_move`.** Both engines re-derive the turn from where
  the unit started, off the unit's own stats, so a boosted move is rejected as illegal and a
  boosted strike lands base damage unless `endTurn()` says otherwise. It sends `moveBonus` (the
  extra steps) and `bonuses` (`{atk, def, targetAtk, targetDef}` - both units, because the
  counter reads the other side's numbers). `LocalGameService.move()` takes them, clamped;
  `strikeDamage(..., atkBonus, defBonus)` applies them **after** ring falloff, which is where
  the hex and the unit panel show them. The server ignores all of it: abilities do not exist
  server-side, so honouring the client's word for a stat is a free upgrade for anyone willing
  to edit a message. Abilities are therefore a solo feature until they live in the engine.
- **Only a rejected move clears the staged turn** (`MOVE_ERROR_CODES`). A chat or invite error
  must not silently bin a turn the player has been building.
- ponytail ceiling: buffs are client-side and hex-keyed. A boost follows a *staged* move, not a
  unit the server moves for us, and a reload drops it.

## Unit identity

Every cell carries a **`uid`**, handed out in `build_initial_board()` (and mirrored by
`LocalGameService.buildBoard()`) as `<colour-initial><origin coord>`. `CellData` is an open dict
and `move()`, `to_dict()` and `from_dict()` all preserve it, so the id follows the unit for the
whole game.

Per-unit state hangs off that id, never off the hex:

- **Boosts** (`buffs` in the game room) are keyed by `uid`, so a boost survives a staged step,
  an Undo and the server's own confirmation with no re-keying anywhere.
- **Veterancy** is `placeholderVet(uid, unit_id)`. Keyed on the hex, as it first was, a unit's
  rank changed every time it walked - and rank gates its ability slots.

Anything per-unit added later (cooldowns, XP, statuses) belongs in the cell for the same reason.
Re-keying per-unit state on every move is a bug waiting for the one caller that forgets.

## The socket

`websocket.service.ts` owns the only socket. Rules it enforces, each one earned:

- **A socket being let go is detached first.** `abandon()` nulls its four handlers before
  closing. A close event fires asynchronously, so a socket left wired up runs its `onclose`
  *after* its replacement has opened - clearing the new handshake timeout, stopping the new
  heartbeat and reporting a live connection as down. `disconnect()` and `createSocket()` both
  route through it, and `disconnect()` reports the close itself since nothing else will.
- **A handshake in flight counts as connected.** `connect()` returns early for both `OPEN` and
  `CONNECTING` on the same room. Login, the lobby and the game room all ask for a connection;
  tearing the socket down on each ask is how a connection stays permanently three seconds from
  ready.
- **The send queue is capped** at `MAX_QUEUED` (32), oldest dropped first, and **heartbeats are
  never queued** - presence delivered late says nothing. Without the cap an outage builds a
  backlog of stale intentions that all land at once when the server returns.
- **`messages$` is a plain Subject**, not a BehaviorSubject: a replayed last message means a
  component entering a room re-handles whatever arrived before it existed.
- **Reconnecting does not end a solo game.** `reconnectToServer()` only clears the deliberate
  silence; the game carries on and the socket goes back to the lobby.

## Known quirks

- **Movement still cannot land on an occupied hex** — attacking is its own thing, carried by the
  optional `attack` field on `make_move` (see Combat). An "attack by moving onto an enemy" click
  does nothing; that path is gone for good.
- `server/game/tests_disabled/` is **not** disabled. Its 4 tests match Django's `test*.py`
  discovery pattern and run under a bare `manage.py test` (89 vs 85). They pass. Left as-is.
- `client/src/app/components/setup-config/setup-config.component.html` is still a raw JSON
  `<textarea>` with a "Configuration UI will be added here" placeholder.
- `abilities` exists in the schema and in `DEFAULT_CONFIG` as `{}`. The engine does not read
  it yet.
- Every unit in `DEFAULT_CONFIG` is a chess-piece placeholder. Nothing depends on them being
  chess pieces.
