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

Overtime starts at ply 67. Solo play only - no server takes the toll.

| # | Rule | Status |
|---|---|---|
| 3.1 | The king loses **1 HP at the end of its own side's turn** - never at the start. Verified: `overtimeToll()` runs before the ply counter is bumped at all three commit paths, and a spec pins it (ply 67, pass, white's king 20 -> 19, black's untouched). | WRITTEN |
| 3.2 | A king on 1 HP **dies of it** and the match ends - regicide, banner, finished position left on screen. | WRITTEN |
| 3.3 | A doomed king wears a **waving skull, centred on the icon, fading transparent to solid** and back. | **SEEN** |
| 3.4 | He **does not die where he stands** - the toll is the last thing the turn does, so he plays the whole turn out on his last HP. Anything that heals him first saves him. He falls when the turn commits, unless somebody kills him sooner. | WRITTEN |
| 3.5 | A healing ability can pull him back off the skull. | WRITTEN (new) |
| 3.6 | **The clock does not end a solo turn.** It used to: `updateTurnClock` committed for you the moment the 60s ran out, and since the toll lands at the *end* of a turn, a doomed king died while you were still deciding how to save him. That is what "the king died before I got its turn" was. In solo the clock now paces and beeps and nothing else. | WRITTEN (new) |
| 3.7 | The `-1` is on the **king's own icon**, over the waving skull when it wears one. See 2.6 - it was there all along, under the HP number. | WRITTEN (new) |

---

## 4. Combat

| # | Rule | Status |
|---|---|---|
| 4.1 | **A base never counter-attacks.** It is struck and says nothing. A reserve does answer. | WRITTEN |
| 4.2 | **No counter when they cannot reach you back** - an archer striking from three hexes takes nothing from a swordsman whose range is one. | WRITTEN |
| 4.3 | The hover forecast must not promise a counter that is not coming. It checked the defender's reach but not whether it stood in a base. | WRITTEN |
| 4.4 | The counter **animation** must not play when nothing came back - neither the beat as the blow is staged nor the end-of-turn recap. | WRITTEN |
| 4.5 | **A blow that bounces now says `0`.** Damage is `attack - defence` floored at zero, so whole matchups deal literally nothing; the forecast used to draw no number at all, which read as the preview being broken. | WRITTEN (new) |

---

## 5. Abilities

| # | Rule | Status |
|---|---|---|
| 5.1 | **An ability applies to anything**, panels included. *"though for example ATK ability on base unit is simply pointless but they can do it."* Every ability used to refuse a unit standing in a panel outright. | WRITTEN (new) |
| 5.2 | **Mend** - slot 6 of the pool, paired with Rally. Friendly target, **flat 20 HP**, free, no cooldown cost. *"heal a static 20 for testing purposes."* | WRITTEN (new) |
| 5.3 | A heal never takes a unit past `max_hp`. | WRITTEN (new) |
| 5.4 | An ability that moves a **panel** unit's HP is recorded in the move history, like a blow into a panel is - it is the only place that HP survives a reload. | WRITTEN (new) |
| 5.7 | **Both effect messages are routed to the browser engine** (`LOCAL_GAME_TYPES`). Neither was. A solo game keeps the socket up when a server is reachable, and only listed types are answered locally - so `panel_effect` and `unit_effect` were posted to a server that has never heard of them and dropped. **5.4 has never worked outside offline mode**, and 5.5's fix would not have either. | WRITTEN (new) |
| 5.5 | An ability that moves a **board** unit's HP is sent to the engine as `unit_effect`, and the engine writes it onto the board. **Only the panel half was ever sent.** A mend on a unit standing on the battlefield lived on the room's staged board and nowhere else, so the next state update rolled it straight back off - which is why *healing a king off 1 HP still lost it to overtime the same turn*. Sent ahead of the turn's own move or pass, so the toll comes off the healed king. Addressed by uid as well as hex, since the walk goes out after the cast. | WRITTEN (new) |
| 5.6 | A cast that kills a commander ends the match, the same way a blow does. | WRITTEN (new) |

**This is the test rig.** Pick the Mend/Rally pair, hit one of your own base units with a
damage ability to wound it, then watch it mend 1 a turn and wear its green `+1`. Mend it
back with 20 when you are done. Rally hands out 300 points so nothing has to be afforded.

---

## 6. Still open

| # | Item |
|---|---|
| 6.1 | **"Some shit simply doesn't seem to take any hit."** Partly explained: `strikeDamage` is `attack - defence` floored at 0, so a pawn (14 atk) takes **nothing** off a shieldman (18 def) or a king (15 def). That is the formula working as written, not a delivery bug - but it may not be the formula you want. A floor of 1, or a percentage, would remove the dead matchups. **Your call.** |
| 6.2 | **The forecast showed nothing on the base unit.** Same cause as 6.1 - a zero was drawn as blank. Now draws `0` in grey. If you were seeing a blank where the damage was *not* zero, that is a different bug and still unfound. |
| ~~6.3~~ | **Overtime takes only HP.** Done - `overtimeTicks()` is gone and the standings no longer subtract anything for overtime. |
| 6.4 | Skull threshold is `<= 1` HP, i.e. exactly the kings the toll kills. Warn a turn earlier at 2? |
| 6.6 | **A cast that kills shows no number.** `showMark` needs a unit to mark and the victim is already off the board by the time the beat plays. The skull and the ghost cover it, so it is left alone - say if you want the `-14` over the corpse. |
| 6.7 | **Undo leaves the cast's mark up.** Mend, then Undo inside a second and a half: the HP goes back and the green `+20` stays until its own timer runs out. Cosmetic, and nothing currently takes a mark down early. |
| 6.8 | **A winning cast loses its commit wash.** `over()` fires synchronously inside `endTurn`, and the `game_over` handler drops `recapRunning` before the board has seen the new recap - so the one turn most worth watching plays without the amber curtain. |
| 6.5 | Nothing here reaches a networked game. Panels, crossings, the toll and abilities are all gated to solo (`entryBind`) because no server holds a panel. |

---

## What is checked, and what that is worth

- **227 client specs**, **89 server tests**, production build clean apart from a standing
  SCSS budget warning.
- Specs cover the logic end to end: the engine resolves a panel blow, the room stages and
  sends it, the derivations read it back, and the marks are owed and paid.
- **They do not cover a person clicking through a real match.** That is the gap this
  document's status column exists to name.
