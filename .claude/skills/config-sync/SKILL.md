---
name: config-sync
description: Change the ChessPlusPlus game-config shape without desyncing the schema, the shipped config and the two validators. Use when adding, removing, or altering any field in the game config — units, abilities, rules, board, setup — or when config validation rejects something that looks valid.
---

# Config sync

The shipped config is **one file**, `shared/default-config.json`, and both engines read it:
`config_loader.py` loads it as `DEFAULT_CONFIG`, `config.service.ts` imports it as
`DEFAULT_GAME_CONFIG`. **Changing a number is editing that file and nothing else.** (There used
to be a copy in each engine, kept equal by hand.)

Changing the config's **shape** - adding, renaming or removing a field - touches four places:

| # | File | Contains |
|---|---|---|
| 1 | `shared/game-config.schema.json` | JSON Schema draft-07 — the contract, and where each field is described. `"additionalProperties": false` at most levels: an unknown field is a hard reject there. |
| 2 | `shared/default-config.json` | The shipped values. |
| 3 | `server/game/engine/config_loader.py` | `_validate_config()` |
| 4 | `client/src/app/services/config.service.ts` | `validateGameRules()` |

## Procedure

1. **Schema first.** Add the field to `shared/game-config.schema.json`, with a description of
   what it does and what an omitted one means. Decide deliberately whether it goes in `required`.

2. **Default.** Add it to `shared/default-config.json` with a real value. The schema and this
   file both round-trip through `json.dumps(indent=2, ensure_ascii=False)` byte for byte, so
   they can be edited as data from a script (CRLF line endings).

3. **Validators.** The two are not the same on purpose:
   - `validateGameRules()` (client) guards the setup screen, where a config is written today. It
     may be stricter: it refuses unknown unit and ability fields, missing unit numbers, and every
     ability rule - abilities are the client's alone.
   - `_validate_config()` (server) also loads configs that rooms saved under **older builds**, so
     it refuses only what is *there and wrong* - a field of the wrong type, a value that would
     crash the engine or corrupt the board. Refusing a missing or retired field would strand
     every room holding one.
   - The rule between them: **whatever the client accepts, the server must accept.** A client
     default the server rejects breaks the setup screen with an error the user cannot act on.

4. **Verify.** Both must pass:
   ```bash
   cd server && DJANGO_DEBUG=true python manage.py test game.testsuite
   cd client && ng test
   ```

## Checks

- Round-trip the default through the real path: `load_config(DEFAULT_CONFIG)` must return
  without raising, and `build_initial_board()` on the result must produce the expected piece
  count. `SharedDefaultConfigTestCase` checks the shipped file validates.
- Anything that lands in a board cell (`CellData`) must also survive
  `HexBoard.to_dict()` → `from_dict()`. `board.set()`, `board.move()`, and `from_dict()` each
  carry cell fields *explicitly* — a new field added to `set()` but not to `move()` silently
  resets on every move, and one missed in `from_dict()` resets on every reconnect. This is the
  single most likely place to introduce a bug that tests pass through.
- The server reads `shared/` from the repository root, so a deployment has to build from the
  root (DEPLOYMENT.md, the Dockerfile).

## Removing a field

Delete it from the schema, the shipped file and both validators, and grep for reads of it
(`.get('field'`, `config.field`, `config['field']`) before assuming it is unused. A field left
in the schema but read nowhere is worse than no field — it looks supported. Prefer deleting
dead config over leaving a flag that silently does nothing. **The server must still load a
config that carries it** - a room saved before the removal - so it ignores the field rather
than refusing it.
