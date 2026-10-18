# Deployment foundation

This is the local packaging/configuration implementation of
[REL-004](../specs/REL-004-deployment-foundation.md), following the
[$0-personal-spending plan](../DEPLOYMENT.md). It creates no Azure resources,
registers no domain and publishes no images. Dependency remediation and actual
student eligibility/domain/capacity checks remain launch gates.

## What is included

- Root `Dockerfile`: digest-pinned Node/Python/Caddy images; backend and web
  targets. The backend includes `shared/`, runs as UID 10001, and starts one
  Daphne process plus at most one CPU analysis worker under Compose.
- `compose.yaml`: private backend, Caddy, persistent database/backup/certificate
  volumes, resource/log limits and loopback spare ports by default.
- `core.production`: strict production inputs and proxy/HTTPS/cookie settings;
  local `core.settings` keeps its existing development defaults.
- `/health/live/`: process liveness; `/health/ready/`: database/migration readiness.
- `server/scripts/db_backup.py`: SQLite backup API, integrity verification,
  atomic publication without overwrites, and explicit offline restore to a new
  filename. A local backup volume is not an off-VM backup.
- Build-only GitHub Actions and `deploy/smoke.py`: disposable production checks
  with generated test credentials, new volumes and spare ports. No registry
  publishing, cloud credentials or automatic deployment.

## Isolated local verification

With Docker/Compose running, from the repository root:

```sh
python deploy/smoke.py
```

In this Windows-backed WSL checkout, use
`server/venv/Scripts/python.exe deploy/smoke.py` so Docker receives native paths.

The check builds both targets, runs production checks and migrations on a new
disposable database, verifies the backend runs without root or developer data,
starts Caddy using its localhost CA, verifies HTTPS/assets/
deep links and WSS, plays the existing real-socket PvP scenario, requests a CPU
turn, rejects a hostile origin, restarts its backend and restores a backup to a
new database path. It trusts only the fixture's exported CA for these requests.
It removes only its own uniquely named containers, volumes and image tags on exit.
It never uses ports 4200/8000 or the developer database. The test needs no `.env`.

The CI workflow repeats this check on pushes/PRs. The existing application CI
still owns the engine suites, migrations and recorded online-to-solo comparison.
Container checks do not establish the capacity or public TLS/DNS of an Azure VM.

## Prepare a future host

Do this only after the plan's student funding/domain preflight and deployment
authorization. The safe defaults below are for local ports, not public ACME.

1. Copy `.env.example` to a new private `.env`; preserve an existing production
   file instead of replacing it. On Linux set its mode to 600.
2. Set `CPP_DOMAIN` to the exact chosen hostname, with no scheme or port.
   Generate a unique secret with Python's `secrets.token_urlsafe(64)` and put it
   in `DJANGO_SECRET_KEY`. Keep it stable across redeployments and out of Git.
3. Use the persistent volume path, initially `/data/game.sqlite3`. Production
   rejects a missing/relative path, debug mode, weak secrets and wildcard hosts.
   On the verified public host set `CPP_BIND_ADDRESS=0.0.0.0`,
   `CPP_HTTP_PORT=80` and `CPP_HTTPS_PORT=443`; DNS and the firewall must allow
   certificate issuance. The default 8080/8443 bindings remain loopback-only.
4. Set `CPP_IMAGE_TAG` to the exact source revision. Keep the two image targets
   built from that same source and record base-image digest updates.
5. Build and check before starting the services:

```sh
docker compose config --quiet
docker compose build --pull
docker compose run --rm backend python -m django check --deploy
docker compose run --rm backend python -m django migrate --noinput
docker compose up -d --wait
```

Migrations are explicit; normal startup does not run them. The web service waits
for database readiness. `docker compose down` retains named volumes; adding
`--volumes` deletes them and belongs only to disposable fixtures or deliberate
data removal. Keep one running project/instance; a second project would split
the in-memory channel layer and create separate game data.

Caddy supplies the forwarded HTTPS scheme, so the backend must remain private.
Only Caddy publishes ports. Browser traffic uses the same origin for pages,
game and CPU sockets. Client routes fall back to `index.html`; `/ws/` and
`/health/` reach Django before that fallback. Public `/admin` is blocked.

HSTS starts at one hour and applies to the selected hostname. Django's
`security.W005` and `security.W021` remain visible: include-subdomains and browser
preload are intentionally not enabled before the actual domain's scope and HTTPS
coverage are confirmed. Do not silence them or claim preload readiness. Public
launch must review that policy along with the remaining security/dependency gates.

The default backend memory/CPU limits are a testable starting point, not proof
that a free 1-GiB VM meets the game's load. Measure native VM CPU credits, memory,
timers and concurrent games before choosing any larger credit-funded size.

## Backup and restore

Choose a new backup filename each time. Both commands check the resolved
destination before publication and refuse existing databases or SQLite `-wal`,
`-shm` and `-journal` sidecars, including orphaned sidecars. These files remain
intact; choose a fresh destination instead of deleting them.

This example uses the database path from the running service, including after
a previous restore:

```sh
docker compose exec -T backend sh -c 'python scripts/db_backup.py backup "$DJANGO_DB_PATH" /backups/backup-001.sqlite3'
docker compose cp backend:/backups/backup-001.sqlite3 ./backup-001.sqlite3
```

Move the exported copy to restricted off-VM storage within the verified allowance;
retain and restore-test copies before deleting older backups. Protect them like
the live database: game history includes private reconnect/draft information.
The source can be live, including WAL mode; do not substitute a raw file copy.

For restore, stop the backend and choose an unused destination. The tool cannot
prove that every other process is stopped; `--offline` acknowledges that operator
precondition. It refuses an existing destination or its SQLite sidecar files.

```sh
docker compose stop backend
docker compose run --rm backend python scripts/db_backup.py restore /backups/backup-001.sqlite3 /data/restored-001.sqlite3 --offline
```

Set `.env`'s `DJANGO_DB_PATH=/data/restored-001.sqlite3`, then start the project
again with `docker compose up -d --wait`. Confirm readiness, saved games, drafts
and replay export. The previous database remains intact for recovery. Verify
schema compatibility before changing application revisions; do not overwrite the
old database or remove its sidecars while another process could be using it.

## Checks outside containers

Run the backend suite and migration drift with `DJANGO_DEBUG=true` for every
local `manage.py` invocation. The `test_deployment` module exercises configuration,
probe failures and WAL/restore safety using temporary databases. Client specs and
the production build remain required. No UI template/style changes are part of
this foundation, so it does not replace or claim a new full layout sweep.
