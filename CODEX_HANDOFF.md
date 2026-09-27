# Handoff: ChessPlusPlus, 23 Sep 2026

Written by the previous agent (Claude Code) for the next one, Codex. **AGENTS.md is the source of
truth** for how this repo works: architecture, the rules the owner has decided, and why. Read it
first. This note covers only what AGENTS.md does not: where the work stands, how this owner likes to
work, and what is open.

## Where things stand

- **Repo:** https://github.com/Ruinan-Ding/ChessPlusPlus. It is a hex-grid tactics game: a Django
  Channels server in `server/`, an Angular 19 client in `client/`, and the shared config schema in
  `shared/`.
- **Branch:** `feature/dev18`, pushed, clean, with nothing uncommitted. It is 3 commits ahead of
  `main` (`2e7231c`, the merge of PR #18). No pull request has been opened for dev18.

| Commit | What |
|---|---|
| `b454325` | Move each phase's extra turn to its end, as its postmatch (see below) |
| `f54ad44` | Trim unused game-room styles (the compiled stylesheet went from 43.6 kB to 39.4 kB, under the 40 kB budget warning) |
| `aa54e87` | Let `start.sh` run the frontend from WSL |
| `71f9b9c` (on main) | Counted rules moved into the config; `start.sh` works from Git Bash |

- **Tests at `b454325`:** 389 client specs and 239 server tests, all passing. The production build
  is clean.

## The latest change: the postmatch (`b454325`)

The owner's words: *"instead of phase x inizalitzation, make it phase x postmatch, and move the
inization part to the end of the phase. that way you dont have 3 inization turns then start right
away at phase 1 initialization"*

**The schedule, in full turns.** A ply is a hand-over, and ply p is turn ceil(p/2).

| Turns | Stage |
|---|---|
| 1-3 | `Initialization` (the opening, unchanged) |
| 4-8 / 9-13 / 14 | `Phase 1` / `Phase 1 Halftime` / `Phase 1 Postmatch` |
| 15-19 / 20-24 / 25 | Phase 2, the same pattern |
| 26-30 / 31-35 / 36 | Phase 3, the same pattern |
| 37-44 / 45-49 / 50 | `Overtime 1` / `2` / `3` (unchanged) |

**What a postmatch turn allows.** It is the old initialization turn, moved:

- It is a setup turn: nobody attacks and no ability is cast.
- Up to `rules.postmatchEntries` units (default 5) may leave the reserve. This replaces
  `panelMoversPerTurn` for the reserve on that turn.
- Up to `rules.homecomingsPerSetupTurn` units (default 3) may walk home.
- The wrap is shut.

**What does not move.** Every numbered phase still spans 11 turns, so `phaseIndexAt` gives the same
answer as before (turn 14 is Phase 1). The CP a phase hands out and the start of overtime are
unchanged too.

**When each window is open:**

| Window | Turns |
|---|---|
| Setup turns | 1-3, 14, 25, 36 |
| Wrap | 4-8, 15-19, 26-30 |
| Way in | 1-3, 9-14, 20-25, 31-36 |
| Way home | 1-3, 14, 25, and 36 onward |

**Renames:**

- The phase flag `init` is now `postmatch`.
- `isPhaseInitialization` / `is_phase_initialization` are now `isPostmatch` / `is_postmatch`.
- `playStartTurn` is gone.
- The config key `phaseInitEntries` is now `postmatchEntries`, in all three mirrors. It is **not
  migrated**: neither runtime validator rejects an unknown rule key, so an old room reads the
  default.

**Scoring (`game-room.component.ts`):**

- A scoring phase is recorded on the first hand-over of its own postmatch, before any postmatch
  move changes the board. The test is `phase < now || (phase === now && isPostmatch(ply))`.
- On a postmatch turn the live score reads 0, so the phase just recorded is not counted twice.
- As a result, `matchVerdict` can show from turn 36.

**How it was checked:**

- The client (`phases.ts`) and server (`phases.py`) schedules were dumped for plies 1-1106 and came
  out byte-identical.
- 38 stub checks all passed: each rule was broken on purpose and a test caught it.
- An adversarial review with four lenses found no behaviour bugs. Its findings on comments and tests
  are fixed.
- **It has not been seen in a browser.**

## How this owner works

- **Commit only when asked.** Commit as the owner, per command:
  `git -c user.name="Ruinan Ding" -c user.email=ding.r866@gmail.com commit ...`.
  Never change git config.
- **Stub-verification discipline.** For each new or moved rule, break it on purpose, watch a test
  fail, then restore it. Report how many stubs caught something.
- **Don't touch the owner's servers** on ports 8000/4200. Test on spare ports (8001, 8002, 4201)
  and stop them afterwards:
  `BACKEND_PORT=8002 FRONTEND_PORT=4201 ./start.sh`, and `./start.sh -k` to stop.
- **Where the owner runs things:**
  - The owner runs `./start.sh` from **WSL**.
  - `node_modules` and the venv are Windows installs, so under WSL `start.sh` routes both servers
    through `cmd.exe`.
  - It also works from Git Bash and plain Linux.
- **Line endings:**
  - Most source and doc files are CRLF, while `*.sh` is LF (set by `.gitattributes`), and
    `core.autocrlf=true`.
  - Never `sed -i` a CRLF file from Git Bash; for scripted edits, use Python with `newline=''`.
  - **`PUNCHLIST.md` has three lone CRs, on rows 3.10, 3.12 and 3.14, on purpose.** Editors that
    normalise them make git show the whole file as changed. Put them back if that happens.
- **Style:**
  - Comments are long, reasoned, plain English, and explain why. Match them.
  - Quote the owner verbatim, typos included.
  - Record owner decisions in PUNCHLIST.md with a date.
- **The config has three mirrors.** `shared/game-config.schema.json`,
  `server/game/engine/config_loader.py` and `client/src/app/services/config.service.ts` must change
  together. The procedure is in `.claude/skills/config-sync/SKILL.md`.
- **Per-room rules.** One server process plays every room, so read rules with
  `rule_of(config, key)` / `ruleOf(config, key)`, never from a module constant.

**Test commands:**

```bash
cd server && DJANGO_DEBUG=true ./venv/Scripts/python.exe manage.py test game.testsuite
cd client && npx ng test --watch=false --browsers=ChromeHeadless
cd client && npx ng build   # must be clean, with no budget warning
```

## Open items

**Deferred by the owner. Do not start these unasked:**

- **Server-side abilities (PUNCHLIST 6.15).** Owner: "leave it for later". The server ignores
  `moveBonus` and `bonuses` on purpose, so a networked room refuses every cast. Doing this properly
  means the server owns casts, purchases, CP and cooldowns together. It needs four owner rulings
  first:
  - (a) whether CP is earned beyond `rules.cpPerPhase`;
  - (b) loadout rules;
  - (c) cooldowns and cast limits;
  - (d) rough numbers.
- **A networked browser playtest, and PUNCHLIST 6.17.** Waiting until the owner implements the game
  logic.
- **A config editing UI.** Only custom mode would use it, and the owner is unsure about going that
  far.

**Questions waiting on the owner:**

1. Can a unit that used its opening move also walk home?
2. "Once you move another unit, the previous is done". This is enforced; confirm that is intended.
3. Should CP be earned through play? Today it is a flat 100 per phase, handed out by phase index
   and derived in `cpOf`.
4. New with the postmatch: the next phase's CP now arrives on its first playing turn, not on a setup
   turn. During a postmatch a side is still spending the phase that is closing. Is that OK?
5. New with the postmatch: on turn 36 a close match is already bound for overtime, but the header
   reads `PHASE 3 POSTMATCH` until turn 37 shows `OVERTIME 1`. A decided match shows its winner from
   turn 36. Is that OK?

**Known limits, all present before this change:**

- **Late or reloaded clients score a phase late.** A client that misses the moment a phase is
  recorded (a networked reload, or a late join) records it at the next hand-over it sees, off
  whatever board is showing then. Only solo games save the recorded scores.
- **The counted-rule validators disagree on whole-number floats.** The client accepts `5.0`; the
  server rejects it (`isinstance(int)`).
- **Games in progress switch schedule** at deploy. Rooms are short-lived, so this was left alone.

**Housekeeping:**

- `AGENTS.md` says `114 tests` in its commands block (the real count is 239).
- `PUNCHLIST.md` line 219 says 375 client specs and 232 server tests (really 389 and 239).
- Opening a dev18 pull request to main is not done yet. Wait for the owner to ask.
