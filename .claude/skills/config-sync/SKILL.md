---
name: config-sync
description: Change the ChessPlusPlus game-config shape without desyncing its three mirrors. Use when adding, removing, or altering any field in the game config — units, abilities, rules, board, setup — or when config validation rejects something that looks valid.
---

# Config sync

The game config is defined in **three** places. They are not generated from each other, so a
change to one alone produces a config that one side accepts and another rejects.

| # | File | Contains |
|---|---|---|
| 1 | `shared/game-config.schema.json` | JSON Schema draft-07 — the contract. Note `"additionalProperties": false` at most levels: an unknown field is a hard reject, not a warning. |
| 2 | `server/game/engine/config_loader.py` | `DEFAULT_CONFIG` (~line 37) and `_validate_config()` (~line 172) |
| 3 | `client/src/app/services/config.service.ts` | `DEFAULT_GAME_CONFIG` (~line 28) and `validateGameRules()` (~line 173) |

## Procedure

Do all four steps. Stopping after two is the failure mode this skill exists to prevent.

1. **Schema first.** Add the field to `shared/game-config.schema.json`. Decide deliberately
   whether it goes in `required`. Because `additionalProperties: false` is set, a field absent
   from the schema is rejected outright even if both defaults carry it.

2. **Server.** Add it to `DEFAULT_CONFIG` with a real default value. Then check
   `_validate_config()` — it is hand-written and only covers `version`, `board.radius`,
   `units`, and `setup`. Add a check only if a bad value would crash the engine or corrupt
   board state. It does not need to restate the whole schema; that is not duplication worth
   maintaining.

3. **Client.** Mirror the exact same default into `DEFAULT_GAME_CONFIG`. Values must match the
   server's byte for byte — a client default the server rejects breaks the setup screen with a
   validation error the user cannot act on. Update `validateGameRules()` only if you added a
   server-side check in step 2.

4. **Verify.** Both must pass:
   ```bash
   cd server && DJANGO_DEBUG=true python manage.py test game.testsuite
   cd client && ng test
   ```

## Checks

- Round-trip the default through the real path: `load_config(DEFAULT_CONFIG)` must return
  without raising, and `build_initial_board()` on the result must produce the expected piece
  count.
- Anything that lands in a board cell (`CellData`) must also survive
  `HexBoard.to_dict()` → `from_dict()`. `board.set()`, `board.move()`, and `from_dict()` each
  carry cell fields *explicitly* — a new field added to `set()` but not to `move()` silently
  resets on every move, and one missed in `from_dict()` resets on every reconnect. This is the
  single most likely place to introduce a bug that tests pass through.

## Removing a field

Delete it from all three, and grep for reads of it (`.get('field'`, `config.field`,
`config['field']`) before assuming it is unused. A field left in the schema but read nowhere is
worse than no field — it looks supported. Prefer deleting dead config over leaving a flag that
silently does nothing.
