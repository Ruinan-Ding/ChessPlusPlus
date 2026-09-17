# Turn's end punchlist

Every rule the owner has given about **mending, the end-of-turn marks, the king's overtime
toll and the counter-attack**, written back in plain terms so it can be corrected.

Status means one thing only:

| Status | Meaning |
|---|---|
| **SEEN** | The owner has watched it work in a running game. |
| **WRITTEN** | Code is in and specs pass. **Nobody has seen it work in a real game.** |
| **OPEN** | Not built, or not understood. |

The owner's note, and the reason this column exists: *"most of the thing you assume is
shipped isnt."* A passing spec is not a working game. Nothing moves to **SEEN** except by
the owner saying so.

---

## 1. Mending

| # | Rule | Status |
|---|---|---|
| 1.1 | At the end of **your** turn, every unit in **your** base heals 1 - if it can. At the end of the opponent's turn, theirs does. Per side, on that side's own turn: a unit standing through a white ply and a black ply gains **1**, not 2. | WRITTEN |
| 1.2 | The base holds **two kinds of unit and both heal** - the squad dealt there at the start, and any unit that walked home. Only the walked-home half used to; that was the bug behind "the base isn't healing". | WRITTEN |
| 1.3 | **The reserve does not heal.** A staging area, not a hospital. | WRITTEN |
| 1.4 | "If it can" - never past `max_hp`, and never back from 0. A unit already at full heals nothing and shows no mark. A unit killed in a panel stays dead. | WRITTEN |
| 1.5 | The rate is **1 HP a turn** (`BASE_HEAL_PER_TURN`) - the owner's placeholder, *"1hp (for now at least)"*. | WRITTEN |

Where it lives: `withdrawnUnits` (walked home) and `panelHp` (dealt squad) in
`game-room.component.ts`, both through one `mendedSince()`.

---

## 2. The marks

| # | Rule | Status |
|---|---|---|
| 2.1 | `+1` **green** on your unit, **blue** on the opponent's. | WRITTEN |
| 2.2 | `-1` **red** on your king, **purple** on the opponent's. | WRITTEN |
| 2.3 | Every mark fires **at once, as the very last beat of the turn commit** - after the walk, the blow, the counter and every ability the turn cast. | WRITTEN |
| 2.4 | Each `+1` **swells like a buff**; each `-1` **shrinks, like being hit**. The swell is tinted to match its own mark. | WRITTEN |
| 2.5 | Marks clear themselves after about two seconds. | WRITTEN |
| 2.6 | **The mark is centred on the face** and drawn **last of everything on the board**, the way the skull is. | WRITTEN (new) |
| 2.7 | **Every commit plays, whether or not it moved anything.** The amber commit wash goes up on every End Turn; the board is handed the recap even when it is empty, holds a beat for the curtain, then settles up and hands the board back. It used to light only when there was something to replay. | WRITTEN (new) |
| 2.9 | **A cast that kills still writes its number**, over the ghost it left. There is no unit to hang it on - the recap plays against the board the turn ended on, and the victim is off it - so the mark goes on the hex instead. | WRITTEN (new) |
| 2.10 | **Undo takes the mark down with the HP.** Mend then Undo used to put the HP back and leave the green `+20` hanging for the rest of its fade. | WRITTEN (new) |
| 2.11 | **The turn that wins the match keeps its commit wash.** A blow or a cast that ends the game resolves synchronously inside `endTurn`, before the board has been handed the turn to replay, and the `game_over` handler dropped the curtain before the recap ever started - so the one turn most worth watching played bare. It comes down at `playbackDone` now, and `game_over` only lifts it when nothing is playing. | WRITTEN (new) |
| 2.8 | **A cast writes what it did to the HP over the unit** - `+20` for a mend, `-14` for a hit - in the same four colours as the turn's-end marks, as the cast's own beat plays. It shows the HP that actually moved: a 20-point mend on a unit three short of full is a `+3`. | WRITTEN (new) |

Where it lives: `pendingUpkeep` / `settleUpkeep()` / `markOf()` in `game-board.component.ts`.

**Why none of these had been seen - found, and it was not the logic.** The mark was drawn
at `cy - 18` in the per-hex cells group. The HP readout is drawn at `cy - 19` in the *later*
"labels last" group, same anchor, one pixel apart, with a white halo of its own. SVG has no
z-index: last drawn wins. **Every `-1` and `+1` this board has ever owed was rendered
correctly and painted underneath the HP number.** The specs found it in the DOM and passed;
nobody could see it. Now centred on the face at the end of that group, 22px, and a spec
pins the DOM order against `.stat-hp` so it cannot slide back under.

The second half of the same complaint - *"when nothing is moved it takes damage without
playing the animation"* - was the pass path settling on a bare `setTimeout` instead of
through the replay: no beat, no hold, and nothing to tell the room it had happened. A pass
now runs `runPlayback([])`, which walks no steps and then settles, and a new `replaying`
flag stops it paying the upkeep over the top of a recap that is scheduled but has not
started yet.

---

## 3. The king and overtime

Overtime starts at ply 67. Both engines take the toll - the server on a move, a pass and the clock's pass, so a king on his last point cannot pass his way past it.

| # | Rule | Status |
|---|---|---|
| 3.1 | The king loses **1 HP at the end of its own side's turn** - never at the start. Verified: `overtimeToll()` runs before the ply counter is bumped at all three commit paths, and a spec pins it (ply 67, pass, white's king 20 -> 19, black's untouched). | WRITTEN |
| 3.2 | A king on 1 HP **dies of it** and the match ends - regicide, banner, finished position left on screen. | WRITTEN |
| 3.3 | A doomed king wears a **waving skull, centred on the icon, fading transparent to solid** and back. | **SEEN** |
| 3.4 | He **does not die where he stands** - the toll is the last thing the turn does, so he plays the whole turn out on his last HP. Anything that heals him first saves him. He falls when the turn commits, unless somebody kills him sooner. | WRITTEN |
| 3.5 | A healing ability can pull him back off the skull. | WRITTEN (new) |
| 3.6 | **The clock does not end a solo turn.** It used to: `updateTurnClock` committed for you the moment the 60s ran out, and since the toll lands at the *end* of a turn, a doomed king died while you were still deciding how to save him. That is what "the king died before I got its turn" was. In solo the clock now paces and beeps and nothing else. | WRITTEN (new) |
| 3.7 | The `-1` is on the **king's own icon**, over the waving skull when it wears one. See 2.6 - it was there all along, under the HP number. | WRITTEN (new) |
| 3.8 | **The skull warns two of that side's turns out, not one.** A warning that arrives on the turn the king dies is a warning with nothing left to do about it. Two gives a turn to spend on saving him. The last call still reads as the last call: the early warning is amber, slower, peaking short of solid; the turn he actually dies it is red, faster and solid. | WRITTEN (new) |
| 3.9 | **A king the toll kills wears his last `-1`** - on the hex he died on, since he is no longer standing on it, and in his own side's colours. **Only the toll's own kill**: a commander cut down by a blow is owed nothing, or he wears a toll he never paid, written over the top of the recap's real kill number on that same hex. | WRITTEN (new) |
| 3.10 | **No skull over a king standing in his own base.** The toll reads the board alone, so a commander who walked home takes none and mends instead - walking him home is the whole point of warning early, and the board has to admit when it has worked. | WRITTEN (new) |

---

## 4. Combat

| # | Rule | Status |
|---|---|---|
| 4.1 | **A base never counter-attacks.** It is struck and says nothing. A reserve does answer. | WRITTEN |
| 4.2 | **No counter when they cannot reach you back** - an archer striking from three hexes takes nothing from a swordsman whose range is one. | WRITTEN |
| 4.3 | The hover forecast must not promise a counter that is not coming. It checked the defender's reach but not whether it stood in a base. | WRITTEN |
| 4.4 | The counter **animation** must not play when nothing came back - neither the beat as the blow is staged nor the end-of-turn recap. | WRITTEN |
| 4.5 | **A blow that bounces now says `0`.** The forecast used to draw no number at all, which read as the preview being broken. Rarely seen since 4.6 - with a floor of 1 a blow only reads `0` when the attacker has no attack at all. | WRITTEN (new) |
| 4.6 | **A blow that lands always takes something off.** Damage is `attack - defence` floored at **`MIN_STRIKE_DAMAGE` (1)**, not at 0. It used to floor at 0, which left whole matchups unable to hurt each other: a pawn (14 atk) against a shieldman (18 def) or a king (15 def) dealt literally nothing, all game. An attack of **0** is still 0 - the floor lifts a blow that was blunted, not one that was never thrown. The floor is **`rules.minStrikeDamage`** in the config, beside `rangeFalloff`, so it is a dial you turn rather than a constant to keep in step by hand - set it to 0 to have the old rule back. | WRITTEN (new) |

---

## 5. Abilities

| # | Rule | Status |
|---|---|---|
| 5.1 | **An ability applies to anything**, panels included. *"though for example ATK ability on base unit is simply pointless but they can do it."* Every ability used to refuse a unit standing in a panel outright. | WRITTEN (new) |
| 5.2 | **Mend** - slot 6 of the pool, paired with Rally. Friendly target, **flat 20 HP**, free, no cooldown cost. *"heal a static 20 for testing purposes."* Its tooltip now says `+20 HP`: `abilityHint` read every field but `heal`, so the one ability added for testing described itself as *"no effect yet"*. | WRITTEN (new) |
| 5.3 | A heal never takes a unit past `max_hp`. | WRITTEN (new) |
| 5.4 | An ability that moves a **panel** unit's HP is recorded in the move history, like a blow into a panel is - it is the only place that HP survives a reload. | WRITTEN (new) |
| 5.7 | **Every cast reaches the browser engine, with the server up or not.** It first went out as messages of its own that only offline mode answered, so with daphne running 5.4 and 5.5 never worked. A turn's casts now ride inside the message that ends the turn - the move, the swing out of a panel, or the pass - which the browser engine always answers. | WRITTEN (new) |
| 5.5 | An ability that moves a **board** unit's HP reaches the engine, which writes it onto the board. **Only the panel half was ever sent.** A mend on a unit standing on the battlefield lived on the room's staged board and nowhere else, so the next state update rolled it straight back off - which is why *healing a king off 1 HP still lost it to overtime the same turn*. The casts land before the toll, so it comes off the healed king. | WRITTEN (new) |
| 5.8 | **A cast lands where it happened in the turn.** One made after the turn's blow used to be struck over again when the blow resolved: a mend after a counter vanished (pawn 4 -> 20 staged, 4 committed), and a panel unit hit then finished by a spell came back from the dead on reload. | WRITTEN (new) |
| 5.9 | **A turn the engine refuses keeps none of its casts.** They used to be kept before the move was looked at, so a refused turn came back half-played. | WRITTEN (new) |
| 5.10 | **Undo takes a cast back on its own** (the button used to grey out over it while R still worked), **puts a panel unit's HP back** (the wound stayed drawn, and the next cast struck from it), **stands an undone kill back up**, and **stops once End Turn has sent the turn**. | WRITTEN (new) |
| 5.6 | A cast that kills a commander ends the match, the same way a blow does. | WRITTEN (new) |

**This is the test rig.** Pick the Mend/Rally pair and a pair with a damage ability in it -
in either order now that 6.9 is fixed, since a pick taken back in the turn it was made
costs nothing. Damage abilities only target enemies, so wound your own base unit from the
**other side's** panel on its turn (solo play drives both). Then watch it mend 1 a turn and
wear its green `+1`, and Mend it back with 20 when you are done. Rally hands out 300 points
so nothing has to be afforded.

---

## 6. Still open

| # | Item |
|---|---|
| ~~6.1~~ | **"Some shit simply doesn't seem to take any hit."** Done - the formula floors at **`rules.minStrikeDamage`** (default 1) instead of 0, so a pawn (14 atk) takes 1 off a shieldman (18 def) rather than nothing, and no matchup is dead any more. The worst of it was the shieldman: on 8 attack he dealt literally **0 to seven of the eight unit types**, everything but the archer. An attack of **0** still deals 0: the floor lifts a blow that was blunted, not one that was never thrown. It lives in the **config**, beside `rangeFalloff` - it began as a constant hand-copied into `hex-rules.ts` and `game_logic.py` with prose warning that the two must agree, which is the sort of pairing that drifts silently. Set the dial to 0 to restore the old rule. |
| ~~6.2~~ | **The forecast showed nothing on the base unit.** Done twice. The zero-drawn-as-blank half was fixed earlier (`0` in grey). The *other* half you suspected was real and is now found: `forecastDamage` subtracted two `twoDigits`-clamped numbers, and `twoDigits` caps at **99** - so on a config with units above 99 HP the whole blow vanished (120 struck for 21 is 99 before and 99 after, a delta of nothing, drawn as a bounce). It reads the unit's real HP now. Unreachable on the default roster; it was waiting for a custom config. |
| ~~6.3~~ | **Overtime takes only HP.** Done - `overtimeTicks()` is gone and the standings no longer subtract anything for overtime. |
| ~~6.4~~ | **Warn a turn earlier at 2?** Done - yes. The skull was `<= 1` HP, i.e. exactly the kings the toll kills at *this* commit, which is a warning that arrives with nothing left to do about it. It now warns `DOOM_WARNING_TURNS` (2) of that side's turns out, so there is a turn in hand to walk him home or land a heal. The two are still tellable apart: the early one is amber, slower, and peaks short of solid; the last call is red, faster, solid - the look the skull has always had, now reserved for the turn it was describing (`.doom-skull.imminent`, `dyingKing()`). |
| ~~6.6~~ | **A cast that kills shows no number.** Done - see 2.9. The mark is keyed to the hex when nobody is left standing to wear it. |
| ~~6.7~~ | **Undo leaves the cast's mark up.** Done - see 2.10. `clearMarks()` on the board, called from `undoMove`. |
| ~~6.8~~ | **A winning cast loses its commit wash.** Done - see 2.11. |
| ~~6.9~~ | **The four-ability cap makes the test rig order-sensitive.** Done, and the cap is kept - it is a balance decision, not a bug. What was wrong was the trap around it: taking a pick back cost `swapDebt`, so whatever refilled the slot came in on a 3-turn cooldown, and changing your mind about a pick nobody had used yet was punished like a mid-match swap. **A pick taken back in the turn it was made is now free.** A swap in any later turn still costs, which is the rule the debt existed for: it is not a way to hand yourself a ready ability mid-match. Order no longer matters, so the rig below works whichever pair you take first. The test is the **whole pair, picked this turn and every half of it still cold** - Reselect gives the pair back through whichever half you click, so testing only the clicked one left a way to cast Mend, hand the pair back through untouched Rally, and pick a fresh pair cold in the same turn. Cast once, re-armed free, every turn. |
| ~~6.10~~ | **The marks are drawn right and rendered tiny in a narrow window.** Improved, not abolished. The cause was two **fixed-width** rails: 260 + 320 + two 20px gaps came off the top whatever the window was, leaving the board ~300px in a 940px one, the whole SVG scaled to ~0.25x, and a 22px mark landing at ~6px. Both rails are `clamp()`ed now (190-260 and 230-320), which hands the board back ~160px at narrow widths and still opens out fully once there is room. The board is scaled to fit, so a small window still means a small board - that part is geometry, not a bug. |
| ~~6.12~~ | **A cast on a unit that walked home is not drawn until the turn commits.** Done. The base is fed by two derivations and only one of them - `panelHp` - laid the staged turn on top; `withdrawnUnits` did not, so `absorbWithdrawn` wrote the committed HP straight over the staged one. `stageWithdrawn()` now applies the same overlay, outside the cache, for the same reason `panelHp` does. The half that actually cost you a cast is fixed with it: a second Mend in the same turn read that stale number and wiped out the first, so two mends were worth one. A staged kill takes the unit off the base, and Undo stands it back up. |
| ~~6.11~~ | **A king that dies of the toll wears no `-1`.** Done. It is the same shape as the old 6.6 and takes the same answer: nobody is left standing to hang the number on, so it hangs on the hex he died on. `kingHex` remembers where each commander was last seen - written on every rebuild, read only once he is gone, because by the time `markOvertimeToll` runs the board has already been rebuilt without him. It is drawn in his own side's colours: an empty hex belongs to nobody, and reading the absence drew your own king's last toll in the opponent's purple. |
| 6.5 | **Everything but abilities reaches a networked game now.** Three stages; **1 and 2 done, 3 done except abilities** (see 6.15). Nothing needed a migration: the panels, where every panel unit stands, and each side's points are all derived from the config and the move history, which the server already stores. The server answers a crossing (`enter_board`), a blow into a panel (`panel_attack`), a walk home (`make_move` + `withdraw`), and - new in stage 3 - **a walk inside a panel or the wrap out of a base (`panel_move`)**, which used to reach no engine at all. It takes **overtime's toll** on a move, a pass and the clock's pass, and enforces **the opening's rules**. It derives what the browser engine takes on trust: the unit, its panel, whether that panel answers a blow, the walk and its MOV, the wrap and its price. Gates: `entryBind` (panels) and `tollBind` (the toll and its skull) are on in every room; `buffsBind` (abilities) stays solo. Watched over real sockets against a running server by `server/scripts/e2e/panels.py` (18/18), with `match.py` 22/22 and `edges.py` 12/12 - **not SEEN**: nobody has played a networked game with any of this in a browser yet. Expect the server to refuse things solo play allows (6.17). |
| 6.13 | **A king who walks home loses the match on the spot.** Both engines judge defeat off the board alone, so under regicide a commander in his own base counts as no commander. More evidence he is meant to live, found in stage 3: the browser engine's own **pass** refuses to judge a side beaten for having no commander on the board, *because* "one that walked home into its base is off the board and alive" - it is the **move** that walks him home that judges him dead. The two engines are kept agreeing rather than one being fixed quietly. **Your call:** should a king in his base still count for regicide? |
| ~~6.14~~ | **A reserve's three-movers-a-turn cap is not enforced by the server.** Answered and done. The client's `PANEL_MOVERS_PER_TURN` is **three per base and three per reserve, each turn**, never three between them; a unit already counted keeps spending its MOV, a crossing counts against the reserve, and the wrap against the base. The server enforces it (`panel_allowance`), along with MOV already walked this turn and the opening's once-a-phase lock - none of which a crossing was held to before. |
| 6.15 | **Abilities stay solo until the real catalogue settles. Decided by the owner, 16 Sep 2026.** The catalogue is hard-coded on the room component and labelled a placeholder throughout (`abilityCosts` "Placeholder until abilities exist", `abilityEffects` "Arbitrary numbers - this is the proof of concept"; the config schema's `abilities` slot "PLACEHOLDER"), and two pool abilities are **testing levers**: Mend (free, heals 20) and **Rally (free, hands out 300 points)**. Moving that to the server would freeze a placeholder into the protocol, and put a free 300 points a cast into networked play - which breaks the price of the wrap. **When the catalogue settles, move the system and not the content:** abilities keyed by a stable `id` (not their index 0-16, which a reordered list would re-point in every recorded game), the catalogue in the config so a balance change is a config edit, and the testing levers kept out of networked play. **Not** a straight port of the current arrays. Meanwhile a networked room opens the ability panels but says why nothing can be picked, unlocked or cast - it used to say "not your turn", which was false on your own turn. |
| ~~6.16~~ | **A reserve unit that crossed and later walked home vanished.** Found and fixed in stage 3; it was reachable in solo play before. The room's `departedUids` was every unit that had *ever* crossed, and the board hides any panel unit named in it, so the walk home put the unit back in its base and the board filtered it straight out again. It is now whose *last* move was a crossing, replayed in order - the same replay the server does. |
| 6.17 | **Solo play is laxer than a networked game.** The browser engine still takes crossings, walks, the wrap, blows into panels and casts on trust, and enforces none of the opening's rules (no attacks, one move per battlefield unit for the phase) - it imports only the overtime constants from `phases.ts`. The board's click handler keeps an honest player inside the rules either way, but a console can do in solo what the server now refuses. Nobody to cheat in solo, which is the engine's own reason; worth knowing when something "works in solo" and not networked. |

---

## What has actually been watched

Driven through a running solo game on **2 Sep 2026** - daphne up, so `offline` was false and
every message took the socket path, which is the one that mattered for 5.7. **This is not
SEEN**: the owner has still not watched any of it, and the column above is unchanged.

| Rule | What was watched |
|---|---|
| 2.1 / 2.2 | All four colours on screen: green `heal-mark` for my mend, red `toll-mark` for my king, purple `toll-mark mark-theirs` for theirs. Computed fill `rgb(185,28,28)`. |
| 2.3 | One commit's timeline: cast's `+20` at 1.6s, overtime's `-1` at 2.6s. The toll last, after everything the turn did. |
| 2.5 | Up at 3.0s, gone by 5.0s. |
| 2.6 / 3.7 | The mark is SVG element **2382 of 2392** and **nothing painted after it overlaps it**. On screen: a red `-1` centred on the king's face, over the crown, white halo, on top. |
| 2.7 | End Turn with nothing staged: the amber wash up 2.4s -> 3.4s, then the toll paid. A turn that moved nothing played. |
| 2.8 | A big green `+20` on the king's face as Mend landed, HP 1 -> 21. |
| 2.11 | At 5.9s into the winning commit: `gameOver` true, `recapRunning` **still true**, wash still up. It came down at 6.5s on `playbackDone`. |
| 3.1 | Four commits, alternating: white 45->44, black 45->44, white ->43, ->42. Never on the side that was not playing. |
| 3.2 | Regicide, **YOU WIN** banner, finished position left on screen, Restart offered. |
| 3.4 / 3.5 / 5.5 / 5.7 | **The headline.** King on 1 HP, Mend, End Turn: 1 + 20 = 21, toll takes 1, **20 left and the match went on**. *"after healing it form 1hp, it dies next turn anyways"* - not any more. |

Not watched on 2 Sep, and still only specs then: **all of §1**, **all of §4**, and
**2.9 / 2.10 / 5.4** - each needed a damaging ability the loadout had no room for. All of them
have been watched since; see below.

### Watched again, 14-15 Sep 2026

Driven through running games - solo, and two players on two browser identities - with daphne
up. **Still not SEEN**: the owner has not watched these either. Clicks were real on the board;
some panel buttons were pressed through page scripts, which fire the same handlers.

| Rule | What was watched |
|---|---|
| 1.1 / 1.2 | Black's dealt base knight, wounded 28 -> 20: **+1 at the end of each black turn** (20 -> 21 -> ... -> 27) and nothing on white's. Two base units mended in the same beat. |
| 1.2 | The walked-home half: a white archer withdrew at 9 HP and was on **10** at the end of its side's next turn, green `+1`. |
| 1.3 | Black's reserve queen, struck to 28, **stayed 28** across five black turns while the base beside it mended. |
| 1.4 | A rook at 40/40 got no `+1`. A base archer killed by a spell **stayed dead**, after a reload too (it did not before 5.8). |
| 2.4 | Each `+1` on the opponent's units swelled in `#38bdf8`. |
| 2.6 | Checked again: no drawn element after a mark overlaps it. |
| 2.9 | `-4` written on the hex a killing Sap emptied - **red** for your own unit since the colour fix (it was purple). |
| 2.10 | The cast's mark gone within 0.2s of Undo. |
| 3.6 | 15s clock: 30s into white's first turn, still turn 1. |
| 4.1 | A pawn struck white's base rook: 1 damage, **counter 0**, and a queen's blow into black's base the same. A pawn struck black's **reserve** queen and took **16** back. |
| 4.2 | An archer struck a pawn (range 1) from three hexes: **counter 0**. |
| 4.3 | The hover preview showed no counter for the base and the out-of-reach pawn, and `-16` on the attacker for the reserve. |
| 4.4 | Replays played move + attack only for those two, and move + attack + counter for the reserve. |
| 4.5 | Pawn onto shieldman: the preview drew `0` in grey (`rgb(107,114,128)`). |
| 5.1 / 5.3 | Arc Bolt on black's base knight; Mend on white's base rook at 35/40 wrote `+5`. |
| 5.4 | The panel cast's record in the history, `defenderHp` intact after reload. |
| 5.6 | Black's Sap killed white's king - **its HP set to 5 by hand first**, the only rigged step - and the match ended by regicide, YOU LOST, Restart offered. |

Found by watching, and fixed: 5.8, 5.9, 5.10, the kill mark's colour (2.9), Mend's tooltip
claiming "for one turn", a room token that expired mid-game, crossed invites both going
through, and a player renamed to a guest after rejoining a room.

Not re-watched since 2 Sep: **§3.1-3.5 and 3.7** (nothing there has changed since).

## What is checked, and what that is worth

- **267 client specs**, **201 server tests**, production build clean apart from a standing
  SCSS budget warning.
- **Live network checks** in `server/scripts/e2e/`: a full match between two real sockets
  (`match.py`) and its edge cases (`edges.py`), run against a running server.
- Specs cover the logic end to end: the engine resolves a panel blow, the room stages and
  sends it, the derivations read it back, and the marks are owed and paid.
- **They do not cover a person clicking through a real match.** That is the gap this
  document's status column exists to name.
