# Deploying ChessPlusPlus

Step by step, assuming you have never used any of this before. Follow it top to bottom.

Prices and sign-up details were current when this was written and both drift - check what the
sites actually say.

---

## What you are deploying

Two pieces, split on purpose.

| Piece | What it is | Where it goes | Cost |
|---|---|---|---|
| `client/` | Angular. Compiles to plain HTML/JS/CSS - no server needed to run it. | GitHub Pages | free |
| `server/` | Django + daphne, holding WebSockets | Fly.io | ~$0-3/month |

**Solo play never touches the server.** `local-game.service.ts` is the engine for it, and the
login screen offers "Play Offline" when nothing answers. So the site works with the backend
asleep, stopped, or never deployed at all. The server exists for PvP: the lobby, challenges,
and the game state two browsers share.

That is why the split is worth it. A CDN never sleeps and costs nothing, so single player is
always instant; the backend can be a small machine that sleeps when nobody is playing against
anybody.

### The one rule that shapes everything below

**The server must run as exactly one process on one machine.**

`server/core/settings.py` uses `InMemoryChannelLayer` and SQLite. Messages do not cross process
boundaries, so a second worker cannot see the first one's broadcasts - turn timers fire into
nothing, moves never reach the opponent. Every choice below follows from this:

- one machine, `min_machines_running` never above 1, never `fly scale count 2`
- one daphne process, no `--workers`
- no autoscaling platform (this is why not Cloud Run, App Runner, or Lambda)

If this ever needs to be more than one process, `settings.py` already documents the way out:
set `REDIS_URL`, install `channels_redis`, and move off SQLite at the same time. The two
constraints travel together.

---

## Part 0 - four changes the code needs first

None of this is Fly-specific. Any host needs it.

### 0.1 The socket URL is hardcoded to the dev layout

`client/src/app/services/websocket.service.ts` builds the URL from the page's own hostname plus
port 8000, which is true in dev - `ng serve` on 4200, daphne on 8000 - and wrong everywhere
else. From GitHub Pages it would dial `wss://yourname.github.io:8000`, which is nothing.

In `client/src/app/services/websocket.config.ts`, add a host:

```ts
export const WEBSOCKET_CONFIG = {
  HEARTBEAT_INTERVAL_MS: 15000,
  RECONNECT_INTERVAL_MS: 3000,
  MAX_RECONNECT_ATTEMPTS: 5,
  DEFAULT_ROOM: 'default',
  BACKEND_PORT: 8000,
  // Empty means "the host that served this page, on BACKEND_PORT" - the dev
  // layout. A deployed client names its backend here, and the port is unused
  // because a deployed backend is on 443 behind TLS.
  BACKEND_HOST: '',
};
```

Then in `websocket.service.ts`, where `wsUrl` is built:

```ts
const { protocol, hostname } = window.location;
const wsProtocol = protocol === 'https:' ? 'wss' : 'ws';
const backendPort = WEBSOCKET_CONFIG.BACKEND_PORT;
const wsUrl = WEBSOCKET_CONFIG.BACKEND_HOST
  ? `wss://${WEBSOCKET_CONFIG.BACKEND_HOST}/ws/game/${roomName}/`
  : `${wsProtocol}://${hostname}:${backendPort}/ws/game/${roomName}/`;
```

Leaving `BACKEND_HOST` empty keeps `./start.sh` working exactly as it does now. You fill it in
at Part 2 step 1, once Fly has told you your hostname.

### 0.2 The database has to live on the volume

The container's own filesystem is wiped on every deploy. Only the mounted volume survives, so
the SQLite file has to be told to live there.

In `server/core/settings.py`:

```python
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        # Deployed, this points at the mounted volume - the container's own
        # filesystem is replaced on every deploy and takes the file with it.
        'NAME': os.environ.get('DJANGO_DB_PATH') or BASE_DIR / 'db.sqlite3',
    }
}
```

Unset locally, so nothing changes for dev.

### 0.3 A `.dockerignore`

Without this the image build copies `server/venv/` - hundreds of megabytes of Windows `.exe`
binaries that cannot run on Linux - and your local `db.sqlite3` with your dev games in it.

Create `server/.dockerignore`:

```
venv/
db.sqlite3
__pycache__/
*.pyc
.pytest_cache/
```

### 0.4 A `Dockerfile`

Create `server/Dockerfile`:

```dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Migrate at start, not as a Fly release_command: release commands run in a
# throwaway machine with no volume mounted, so a SQLite migration there would
# write to a disk that is then discarded.
CMD ["sh", "-c", "python manage.py migrate --noinput && daphne -b 0.0.0.0 -p 8000 core.asgi:application"]
```

Two things to notice. `daphne`, not gunicorn - gunicorn is WSGI and cannot hold a WebSocket,
and every Django deployment guide on the internet will tell you to use it. And Python 3.12,
matching what you develop on; Django 6 needs 3.12 or newer.

---

## Part 1 - the backend on Fly.io

### What Fly is, in plain terms

You hand it a Dockerfile. It runs that container as a small VM with a public hostname and a
working HTTPS certificate, and it can stop the VM when nobody is connected and start it again
when someone knocks. It is the closest thing to renting a tiny Linux box with the tedious parts
already done - no load balancer to configure, no certbot, no nginx.

Four words you will see:

- **app** - your project as Fly sees it. Has one name, globally unique, e.g. `chessplusplus`.
- **machine** - a VM running your container. You want exactly one.
- **volume** - a disk that survives restarts and deploys. SQLite lives here.
- **secret** - an environment variable Fly stores encrypted and injects at runtime.

### Step 1 - make an account

Go to <https://fly.io/app/sign-up>. A card is required even at the bottom end; they use it to
keep the free-ish tier from being farmed. There is a small monthly minimum on some plans - read
what it says at sign-up, because this is the number that decides whether this is $2/month or $5.

### Step 2 - install the CLI

In PowerShell:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Close and reopen the terminal, then check it:

```powershell
fly version
```

### Step 3 - log in

```powershell
fly auth login
```

Opens a browser. Come back when it says you are logged in.

### Step 4 - create the app

From the `server/` directory:

```powershell
fly launch --no-deploy
```

It will detect Django and ask a series of questions.

- **Name**: pick one. It becomes `<name>.fly.dev`, so it must be globally unique.
- **Region**: the nearest one to you. Latency here is the lag between you and your opponent.
- **Postgres / Redis / Upstash / Sentry**: **no to all of them.** You are on SQLite and an
  in-memory channel layer. Saying yes to Postgres attaches a database that costs money and that
  nothing reads.
- **Deploy now**: no. `--no-deploy` should already have handled this.

It writes a `fly.toml`. It will also try to write its own Dockerfile and a Postgres-flavoured
Django setup - **keep the Dockerfile from step 0.4** and overwrite `fly.toml` with the next
step.

### Step 5 - replace `fly.toml`

`fly launch` generates a config for a normal web app. This one is for a single-machine
WebSocket server with a disk:

```toml
app = 'chessplusplus'          # whatever name you chose
primary_region = 'sea'         # whatever region you chose

[build]

[env]
  DJANGO_DB_PATH = '/data/db.sqlite3'

[mounts]
  source = 'data'
  destination = '/data'

[http_service]
  internal_port = 8000
  force_https = true
  # Sleep when idle, wake on the next connection. A held WebSocket counts as
  # an active connection, so a game in progress never puts the machine to
  # sleep underneath itself - only an empty server sleeps.
  auto_stop_machines = 'stop'
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  memory = '512mb'
  cpu_kind = 'shared'
  cpus = 1
```

Then check it parses - Fly's config schema changes between versions, and this is the file most
likely to have drifted since this was written:

```powershell
fly config validate
```

**No health check on purpose.** Fly's default HTTP check would request `/`, and
`server/core/urls.py` serves nothing there but `/admin/` - so the check would 404 forever and
Fly would keep restarting a perfectly healthy machine. If you want one, make it a TCP check on
8000, or add a two-line health view to `urls.py` first.

### Step 6 - create the disk

Same region as the app:

```powershell
fly volumes create data --size 1 --region sea
```

1GB, about $0.15/month. `data` must match `source` in `[mounts]`.

### Step 7 - set the secrets

Generate a real Django secret key:

```powershell
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

Then:

```powershell
fly secrets set DJANGO_SECRET_KEY="<the key you just generated>"
fly secrets set DJANGO_ALLOWED_HOSTS="chessplusplus.fly.dev,yourname.github.io"
```

**Both hosts, and this matters.** `server/core/asgi.py` wraps the WebSocket route in
`AllowedHostsOriginValidator`, which checks the browser's `Origin` header against
`ALLOWED_HOSTS`. The page is served from GitHub Pages, so that is the Origin the browser sends.
Leave it out and every socket is rejected before your code ever sees it - and the failure looks
like a plain connection refusal, with the reason only in the server log.

Note that `DJANGO_DEBUG` is deliberately **not** set. It defaults to off, and `settings.py`
refuses to start without a real secret key and an explicit host list when it is off. That is the
intended behaviour: forgetting fails loudly instead of quietly shipping debug mode.

### Step 8 - deploy

```powershell
fly deploy
```

First build takes a few minutes. After that:

```powershell
fly status     # is the machine up
fly logs       # what it is saying
```

You are looking for daphne's `Listening on TCP address 0.0.0.0:8000`.

### Step 9 - check it is really up

```powershell
fly open /admin/
```

A Django login page - unstyled, because `collectstatic` has not run and does not need to for
this app - means the server is alive and answering. If you want the admin styled, that is a
`STATIC_ROOT` setting and a `collectstatic` line in the Dockerfile; nothing else needs it.

---

## Part 2 - the client on GitHub Pages

### Step 1 - point the client at the backend

In `client/src/app/services/websocket.config.ts`, fill in what you left empty in 0.1:

```ts
  BACKEND_HOST: 'chessplusplus.fly.dev',
```

No `wss://`, no port, no trailing slash - just the host.

### Step 2 - know your two Pages gotchas

Both come from Pages being a plain file server with no rules engine.

**Base href.** A project page is served from `https://yourname.github.io/ChessPlusPlus/`, not
from the root. Angular builds absolute asset paths, so without `--base-href` every script and
stylesheet 404s and you get a blank page.

**No SPA fallback.** Your routes are real client-side routes - `/game-room/:id` among them.
Pages looks for a file at that path, does not find one, and serves a 404. That breaks refreshing
mid-game and breaks any room link you send someone. The standard fix is to copy `index.html`
over `404.html`: Pages serves it for anything it cannot find, Angular's router reads the URL and
routes correctly.

Both are handled in the workflow below.

### Step 3 - add the workflow

Create `.github/workflows/pages.yml` at the repository root:

```yaml
name: Deploy client to Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: client/package-lock.json
      - run: npm ci
      - run: npx ng build --configuration production --base-href /ChessPlusPlus/
      # Pages has no SPA fallback, so it serves 404.html for any path with no
      # file behind it. Making that the app means /game-room/xyz loads.
      - run: cp dist/client/browser/index.html dist/client/browser/404.html
      - uses: actions/upload-pages-artifact@v3
        with:
          # Relative to the repo root, not to working-directory. Angular 19's
          # application builder puts the site under browser/.
          path: client/dist/client/browser

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

If your repository is named something other than `ChessPlusPlus`, change the `--base-href` to
match. If you use a user page (`yourname.github.io`) instead of a project page, it is
`--base-href /`.

### Step 4 - turn Pages on

In the repository on GitHub: **Settings → Pages → Build and deployment → Source → GitHub
Actions**. Not "Deploy from a branch" - the workflow above uses the Actions path.

### Step 5 - push and wait

Push to `main`. Watch the run under the **Actions** tab. When it goes green the site is at
`https://yourname.github.io/ChessPlusPlus/`.

Every push to `main` redeploys the client from then on. The backend does not - that is `fly
deploy`, by hand.

---

## Part 3 - after it is up

### What it costs

| | |
|---|---|
| GitHub Pages | $0 |
| Fly machine, 512MB shared-cpu-1x | ~$3.19/month if it never slept |
| Fly volume, 1GB | ~$0.15/month |
| Bandwidth | negligible - this app sends small JSON messages |

With `auto_stop_machines`, you pay for the hours it actually runs. A machine that only wakes
when two people play a match costs well under a dollar. Watch what `fly dashboard` reports for
the first month rather than trusting the estimate.

To halve the machine cost, try `memory = '256mb'`. Django plus channels is usually happy there;
if it gets OOM-killed you will see it in `fly logs`, and you put it back.

### Redeploying

- **Client**: push to `main`. The workflow does it.
- **Server**: `fly deploy` from `server/`.
- **A config change only** (`fly.toml`): `fly deploy` as well.
- **A new secret**: `fly secrets set ...` restarts the machine on its own.

### Turning it off

```powershell
fly apps destroy chessplusplus
```

Deletes the app, the machine and the volume, and the billing with it. The Pages site stays up
and single player keeps working, because it always did.

---

## Gotchas, and what they look like

| Symptom | Cause |
|---|---|
| Site loads, "Play Offline" appears immediately | `BACKEND_HOST` not set, or the machine is down. Check `fly status`. |
| Socket closes instantly, no server-side error visible | The Pages origin is missing from `DJANGO_ALLOWED_HOSTS`. `AllowedHostsOriginValidator` rejects it before your code runs; the reason is in `fly logs`. |
| Blank page, console full of 404s for JS | Wrong `--base-href`. |
| Refreshing a game room 404s | The `404.html` copy did not happen. |
| Moves work but the opponent never sees them | More than one machine. `fly scale count 1`. |
| Rooms vanish after every deploy | `DJANGO_DB_PATH` not set, so SQLite is on the container's own disk. |
| Machine restarts every minute | A health check hitting `/`, which serves nothing. Remove it or make it TCP. |
| Build fails on `cryptography` or `Twisted` | Almost always `venv/` being copied in. Check `.dockerignore`. |

---

## What survives a restart, and what does not

**Survives** - it is all in the database on the volume: rooms, board state, whose turn it is,
move history, the frozen config snapshot, ready status.

**Does not survive**: the turn timers. `_pending_turn_timers` and `_pending_disconnect_timers`
in `consumers.py` are in-process `asyncio` tasks. A deploy or a restart drops them silently -
the game is still there and still playable, but the clock on the current turn stops, and a
disconnect grace period in flight never resolves into a forfeit.

In practice: do not deploy while someone is mid-match. If this becomes a real problem the fix is
to derive the deadline from the persisted `turn_started_at` on reconnect rather than trusting an
in-memory task, but nothing needs that yet.

Auto-stop does not cause this. Fly counts a held WebSocket as an active connection, so a machine
with a game on it stays awake.

---

## Before you hand the link out

There are no accounts. A username is claimed first-come, and the per-browser secret in
`PlayerConnection` only guards *rejoining* a connection you already hold - it is not a password
and there is no recovery. Once you disconnect, the name is free for anyone. That is a deliberate
choice for now, not an oversight, but it is worth knowing before the URL goes anywhere public:
anyone who has it can join the lobby as anyone who is not currently connected.

`/admin/` is exposed on the Fly host. There is no superuser until you make one
(`fly ssh console` then `python manage.py createsuperuser`), so it is a login page nobody can
pass - but if you do create one, that password is the keys to every game record.
