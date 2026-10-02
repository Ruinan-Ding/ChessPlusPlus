# Handoff: ChessPlusPlus, 2 Oct 2026

Written by Claude Code for the next agent, whichever it is (Codex works in this repo too).
**AGENTS.md is the source of truth** for how this repo works: architecture, the rules the owner
has decided, and why. Read it first. This note covers only what AGENTS.md does not: where the
work stands, how this owner likes to work, the machine, and what is open.

It replaces the note of 23 Sep 2026, a snapshot of `feature/dev18` that had gone out of date.
That one is in the history: `git show 4d5e99f:CODEX_HANDOFF.md`.

## Where things stand

- **Repo:** https://github.com/Ruinan-Ding/ChessPlusPlus. It is a hex-grid tactics game: a Django
  Channels server in `server/`, an Angular 19 client in `client/`, and the shared config schema in
  `shared/`.
- **Branch:** `main` is at `de6cb84`. It is pushed, CI is green and nothing is uncommitted.
  - Every feature branch up to `feature/dev21` is merged, except `feature/dev9`.
  - `feature/dev9` and `copilot/analyze-game-room-code` were never merged. Leave them alone.
  - Start new work on a new branch off `main` (`feature/dev22`).
  - dev19, dev20 and dev21 were merged locally with `--no-ff`, each as a
    `Merge feature/devN: ...` commit. They did not go through pull requests.
- **Tests at `de6cb84`:**
  - 329 server tests and 601 client specs pass.
  - The production build and `makemigrations --check` are clean.
  - Live on 2 Oct, against a running server: `match.py` 22/22, `edges.py` 12/12 and
    `endings.py` 30/30. `panels.py` was not run.
- **Migrations run to 0012.** The owner's own `server/db.sqlite3` was at 0008 on 2 Oct. They have
  been told to run `migrate`. Don't run it on their database unasked.

### What landed since the last note

| Merge | Date | What | Written up in |
|---|---|---|---|
| `84faa6f` (PR #19, dev18) | 26 Sep | The postmatch, and the points, CP and ending rules | PUNCHLIST 6.24-6.38 |
| `75a46a1` (dev19) | 30 Sep | The room laid out for every screen: desktop, landscape tablet, phone, touch | PUNCHLIST 6.39-6.55 |
| `7409799` (dev20) | 1 Oct | Networking that recovers, and names that hold | AGENTS.md only, with no PUNCHLIST row |
| `de6cb84` (dev21) | 2 Oct | Tripcodes, and names held to letters and numbers | PUNCHLIST 6.56, AGENTS.md |

**dev20 in short.** AGENTS.md has the detail and the reasons.

- **Timers survive a restart.**
  - Each absent seat's grace deadline is stored as a `GameDisconnect` row (migration 0010).
  - The turn clock reads `GameState.turn_started_at`.
  - `_resume_game_timers` re-arms both when somebody joins.
- **State is ordered.**
  - Every `GameState` write is conditional on `revision`, and every state broadcast carries that
    revision.
  - The client drops anything older (`acceptStateRevision`).
- **Replaced sockets.** A socket that another one has replaced is refused: `STALE_GAME_SOCKET` in
  a room, `NAME_RECLAIMED` in the lobby. The page then rejoins once.
- **One announcement.** A finished game is announced once, however often it resyncs.
- **Names.**
  - Each tab has its own name, kept in session storage.
  - Names are unique regardless of case (`name_key`, migration 0011).
  - No rename in a room or with an invite out or in (`NAME_LOCKED`). The lock checks the pending
    `GameChallenge` rows, because `set_status` could otherwise hide an invite.
  - A dropped player's row is kept, detached, through their grace period.
- **Security review.** A `/security-review` of the branch found nothing else that qualified once
  that `set_status` bypass was closed.
- **CI.** CI had been red since 29 Sep: `banner-fit.spec.ts` assumed Windows fonts. It now finds
  the width where the stage shrinks instead of assuming 1300px.

**dev21 in short.**

- **Base names** are 1-24 ASCII letters and digits, and nothing else. `System` stays reserved.
- **Tripcodes.** `Name#key` is held as `Name!CODE`, where the code is an HMAC under
  `DJANGO_SECRET_KEY`.
  - The key is never stored or echoed.
  - The browser that typed it keeps a signed proof instead, so a reload keeps the code.
- **Two networking fixes came with it.**
  - A network rejoin releases End Turn's latch.
  - A grace timer is replaced only by the period the database holds.
- **Who wrote it.** This code was found uncommitted in the tree on 2 Oct, the work of another
  session. Claude Code reviewed it, ran everything above, wrote the docs and committed it.

## How this owner works

- **Commit, push and merge only when asked.** Put new work on a branch, not straight on `main`.
- **Git identity and git from WSL.**
  - Commit as Ruinan Ding <ding.r866@gmail.com>. Never change git config.
  - Under WSL, `git` has no identity and no credentials. Commit and push with Windows git through
    `cmd.exe /c "git ..."`, which has both (credential manager).
  - Pass the message on stdin with `-F -`.
  - `git merge` will not read `-F -`. Use `git merge --no-ff --no-commit <branch>`, then
    `git commit -F -`.
- **Commit messages.** Subjects are plain-English sentences, for example "Hold a name to the
  player who has it, and only to them". Bodies say why.
- **Stub-verification discipline.** For each new or moved rule, break it on purpose, watch a test
  fail, then restore it. Report how many stubs caught something.
- **Don't touch the owner's servers** on ports 8000/4200.
  - `start.sh` takes spare ports: `BACKEND_PORT=8002 FRONTEND_PORT=4201 ./start.sh`. Stop it with
    `./start.sh -k`.
  - The e2e scripts take `E2E_PORT`.
  - To run them without touching the owner's database, start the server with a throwaway settings
    module that overrides `DATABASES['default']['NAME']`, through `DJANGO_SETTINGS_MODULE` and
    `PYTHONPATH`. Give `edges.py` the same settings, because it reads the database itself.
- **Where the owner runs things.**
  - The owner runs `./start.sh` from **WSL**.
  - `node_modules` and the venv are Windows installs, so everything goes through `cmd.exe`.
  - WSL's own `node` cannot run `ng`, because esbuild and rollup are installed as their win32
    builds.
- **The Windows toolchain, as of 2 Oct.**
  - Python 3.14.7 is installed through winget, user scope. `py` defaults to 3.14, and 3.12 is
    still installed.
  - `server/venv` was rebuilt on it: Django 6.0.6, channels 4.3.2, daphne 4.2.2.
  - Node 25. The client specs use the installed Chrome (see the commands below).
- **CI.**
  - `.github/workflows/tests.yml` runs on every push and pull request, on Ubuntu: the server
    tests, the migration check, the client specs and the production build.
  - Specs must not depend on Windows fonts.
  - `gh` is not on WSL's path. Windows has it (`cmd.exe /c "gh ..."`), but whether it is logged
    in was never checked. The public API needs neither:
    `curl -s "https://api.github.com/repos/Ruinan-Ding/ChessPlusPlus/actions/runs?branch=<b>&per_page=1"`.
- **Line endings.**
  - Most source and doc files are CRLF, while `*.sh` is LF (set by `.gitattributes`), and
    `core.autocrlf=true`.
  - Never `sed -i` a CRLF file. For scripted edits, use Python with `newline=''`.
  - **`PUNCHLIST.md` has three lone CRs, on rows 3.10, 3.12 and 3.14, on purpose.** They were
    still there on 2 Oct. Editors that normalise them make git show the whole file as changed. Put
    them back if that happens.
- **Style.**
  - Comments are long, reasoned, plain English, and explain why. Match them.
  - Quote the owner verbatim, typos included.
  - Record owner decisions in PUNCHLIST.md with a date.
- **The config has three mirrors.** `shared/game-config.schema.json`,
  `server/game/engine/config_loader.py` and `client/src/app/services/config.service.ts` must change
  together. The procedure is in `.claude/skills/config-sync/SKILL.md`.
- **Per-room rules.** One server process plays every room, so read rules with
  `rule_of(config, key)` / `ruleOf(config, key)`, never from a module constant.
- **The owner's calls.** Game rules are the owner's to decide. `DJANGO_DEBUG=true` in development
  is deliberate (AGENTS.md).

**Test commands, from WSL:**

```bash
cd server && cmd.exe /c "set DJANGO_DEBUG=true&& venv\Scripts\python.exe manage.py test game.testsuite"
cd server && cmd.exe /c "set DJANGO_DEBUG=true&& venv\Scripts\python.exe manage.py makemigrations --check --dry-run"
cd client && cmd.exe /c "set CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe&& npx ng test --watch=false --browsers=ChromeHeadless"
cd client && cmd.exe /c "npx ng build"   # must be clean, with no budget warning
```

## Open items

**Nothing since 26 Sep has been seen by the owner.** PUNCHLIST 6.37-6.56 are all WRITTEN, not
SEEN. None of it has been watched in a running game, and none of it has been tried on a real
phone. Nothing moves to SEEN except by the owner saying so.

**Deferred by the owner. Do not start these unasked:**

- **Server-side abilities (PUNCHLIST 6.15).** Abilities are still solo-only: a networked room
  refuses every cast.
- **A networked browser playtest, and PUNCHLIST 6.17.** Solo play is still laxer than a
  networked game.
- **A config editing UI.** This is carried over from the 23 Sep note, and nothing since says
  otherwise. Only custom mode would use it, and the owner was unsure about going that far.

**The questions in the 23 Sep note:**

- **Overtaken.** Questions 3-5 were about CP through play, when the next phase's CP arrives, and
  the turn-36 header. The owner's rules of 24 Sep overtook them (PUNCHLIST 6.25-6.29).
- **Never answered on record.** Ask before relying on either of these:
  - Question 1: can a unit that used its opening move also walk home?
  - Question 2: "once you move another unit, the previous is done". This is enforced. Is that
    intended?

**Known limits:**

- **The counted-rule validators still disagree on whole-number floats.** The client accepts `5.0`
  (`Number.isInteger`); the server refuses it (`isinstance(int)`).
- **Tripcodes hang on `DJANGO_SECRET_KEY`.** A new key changes every code and invalidates every
  remembered proof (DEPLOYMENT.md).
- **There are no accounts.** A plain name is first-come, and the per-browser secret only guards
  rejoining a name you already hold (DEPLOYMENT.md, "Before you hand the link out").
- **Fixed since the last note:** a late or reloaded client no longer scores a phase late. The
  engines bank each phase themselves (`phase_bank`, migration 0008).

**Housekeeping:**

- The dev20 work has no PUNCHLIST row. Add one if the owner wants the record complete. Ask
  first.
