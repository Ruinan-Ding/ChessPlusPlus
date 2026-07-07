# ChessPlusPlus — Implementation Kickoff Prompt

Paste the block below as the first message in a new session to start the
"real" Fire-Emblem-style unit/ability implementation. It has no memory of
prior conversations, so this is written to stand alone.

---

## Prompt to paste

You're picking up ChessPlusPlus on branch `feature/dev13` (Angular client +
Django Channels/WebSocket server, hex-grid tactical game). A prior session did
a full cleanup refactor, an exhaustive code review, and closed every
correctness bug it found — the engine, config pipeline, and deploy posture
are solid and tested (verify this yourself: `cd server && python manage.py
test game.testsuite` should show all tests passing; `cd client && npm run
build` should be clean). Do not re-derive that work or re-review it.

**What you're actually here for:** the game currently ships with a
config-driven engine that has zero unit-specific code — movement, combat, and
setup are all data, not special-cased logic — but the *content* riding on top
of that engine is 100% placeholder. The units (king/queen/rook/bishop/knight/
pawn), their stats, and the fixed 26-piece setup are stand-ins the user
explicitly does not want kept. The real vision is customizable, Fire-Emblem-
style units. Concretely, right now:

- `server/game/engine/config_loader.py` — `DEFAULT_CONFIG["abilities"] = {}`,
  and nothing anywhere in `server/game/engine/*.py` reads `abilities` at all.
  There is no trigger system, no effect resolution, no hook for it in
  `resolve_combat()` or `move_validator.get_legal_moves()`. This is a
  from-scratch build, not a wire-up.
- `client/src/app/components/setup-config/setup-config.component.html` — the
  unit/ability configuration UI is literally a raw JSON textarea with a
  placeholder comment saying "Configuration UI will be added here."
- Combat today (`server/game/engine/game_logic.py::resolve_combat`) is: melee
  only (you "attack" by moving onto an enemy-occupied hex), flat deterministic
  damage (`attacker's attack stat`, no RNG, no hit/dodge, no crits, no
  counter-attack, no weapon triangle), no terrain, no status effects, no
  experience/leveling/promotion. Units are static for the whole match.
- The config pipeline (setup screen → `set_custom_config` WebSocket message →
  `config_loader.load_config()` validation → `GameRoom.custom_config` → used
  at game start) is real and tested — this part you can build on directly,
  you don't need to touch the transport layer to add new unit content.

**Read before asking anything:** `server/game/engine/board.py`,
`move_validator.py`, `game_logic.py`, `config_loader.py` (movement pattern
vocabulary: direction/range/canJump/moveOnly/captureOnly, and fixed-offset
jumps — read the module docstrings, they explain the two pattern types and
the white-authored/mirror-for-black convention). Also read
`client/src/app/services/config.service.ts` (client-side mirror of the
default config) and `shared/game-config.schema.json` (a schema that's
currently *out of sync* with the real defaults — `radius` cap is wrong and
the movement enum is missing the diagonal/offset patterns actually in use;
don't trust it as ground truth, fix it if you touch it).

**Your job before writing any implementation code: interview the user on the
business logic.** Don't assume, don't invent defaults for anything that
changes game feel or engine architecture. Use `AskUserQuestion` in focused,
themed rounds — not one giant list — ordered from most architecturally
expensive to change later, to cheapest:

1. **Combat model** (the most expensive to change after code exists — this
   decides how much of `move_validator.py`/`game_logic.py` gets rewritten
   vs. extended):
   - Stay melee-only (attack = move into an occupied hex), or add
     ranged/magic units that can attack without moving adjacent? The latter
     means decoupling "legal move destination" from "legal attack target,"
     which today are the same concept.
   - Keep flat deterministic damage, or introduce hit/dodge chance, critical
     hits, or a weapon-triangle-style type advantage system?
   - Should the defender ever counter-attack, or does only the initiator deal
     damage (current behavior)?
   - Any terrain concept (movement cost, defense bonus) on the hex board, or
     stays uniform?

2. **Ability system shape**:
   - Give 3–5 concrete example abilities they actually want (e.g. "heal an
     adjacent ally," "poison on hit," "extra move after a kill") — concrete
     examples are more useful here than an abstract spec, and will reveal
     whether a generic trigger+condition+effect DSL is warranted or a small
     fixed set of special-cased effects is enough to start.
   - Do abilities target self / ally / enemy / an area? Do they have
     cooldowns, charges, or are they always-on passives?
   - Do abilities interact with the turn structure (e.g. "usable once per
     turn" vs. "triggers automatically on X event")?

3. **Unit progression**:
   - Static stats for the whole match (current), or experience/leveling/
     promotion during a game? Does anything persist between games, or is
     every match a fresh roster?

4. **Roster / army composition**:
   - Fixed setup coordinates per config (current — a JSON dict of
     `"q,r": unit_id`), or a point-budget/army-builder flow where each player
     picks their roster before the match starts?
   - Is unit count per side fixed, or part of the customization?

5. **Editor UX** (cheapest to defer/iterate — build last):
   - What should the real (non-JSON) unit editor look like? A visual
     movement-pattern designer with a hex-board preview, a stat/ability
     picker, or something else?
   - Should saved custom configs be reusable presets across multiple games
     (a profile/library), or stay scoped to one `GameRoom` like today?

6. **Interaction with existing features** — briefly confirm: does the
   existing "Reveal mode" option (hides config/setup from the opponent until
   both agree to reveal) need to change to accommodate any of the above, or
   is it orthogonal?

Do not treat this list as exhaustive or as something to present verbatim —
use it to structure your questions, adapt based on what you learn from
earlier answers, and drop items that turn out not to apply. Prioritize
getting section 1 (combat model) nailed down first since it's the one that
determines how much of the engine you're rewriting versus extending.

**Known, non-blocking loose ends** (fix opportunistically, don't let them
block the design conversation): `_handle_request_game_state` in
`consumers.py` fabricates `turnStartedAt` as "now" on reconnect instead of
persisting the real turn-start time; `parse_coord` in `board.py` has no input
validation, so a malformed move coordinate surfaces as a generic
`INTERNAL_ERROR` instead of a proper client-facing error; and the schema
mismatch mentioned above.
