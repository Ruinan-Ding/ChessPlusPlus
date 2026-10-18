# REL-004: Local deployment foundation

Status: Done locally after recovery review fix; implementation committed in `1011146`; unscheduled. Source: owner asks to add all six proposed
repository additions after the reviewed [student plan](../DEPLOYMENT.md).
Scope: reproducible images, Compose/Caddy, production settings/env template,
health endpoints, SQLite backup/restore tooling and build-only CI. No game/balance
changes, sibling edits, cloud resources, DNS, owner application database/service
changes or publication. Dependency remediation remains a separate launch gate.

## Requirements / observable examples

- R1/A1: Build backend/web targets with shared contracts and compiled frontend;
  exclude local secrets/venvs/databases. Backend runs without root, using one
  Daphne process and bounded CPU analysis.
- R2/A2: Compose persists data/certificates and serves HTTPS/static/deep links and
  game/CPU WSS through Caddy. Migrations are explicit; missing production inputs
  fail closed. Only the proxy publishes ports, initially on spare loopback ports.
- R3/A3: Development defaults remain. Production enables trusted private-proxy,
  HTTPS, secure cookies and host-scoped HSTS. Domain-dependent subdomain/preload
  policy stays visible rather than being enabled or silenced prematurely.
- R4/A4: Liveness needs no DB; readiness fails generically for unavailable DB or
  unapplied migrations. Container probes work under the production HTTPS policy.
- R5/A5: Back up committed live WAL consistently. Restore requires offline
  acknowledgement and a new destination; bad input/existing destinations/sidecars
  cannot destroy data. Verify restored rows, integrity and CLI refusal paths.
- R6/A6: CI verifies isolated disposable containers without image publication,
  deployment credentials or cloud actions. Unchanged application CI remains.

## Decision / continuation

Source `16ae570`, clean start on `feature/deployment-scaffold`. Digest-pinned
multi-stage images use Node 22/Python 3.14/Caddy; a single private application
process preserves the in-memory channel contract. Explicit migrations and
new-path restores preserve operator control. [Operator guide](../deploy/README.md)
owns commands; the student plan owns funding/domain/target decisions.

Lead owns touched files; no delegated writers. Native Ponytail invocation is
unavailable; its installed full guidance is applied. Docker Desktop was started
with explicit owner approval; its unrelated workloads are preserved. Actual
cloud provisioning and owner application restarts/migrations are outside scope.

## Verification, 17 Oct 2026

| Acceptance | Evidence |
|---|---|
| R1/A1 | Real Linux backend/web images build. Disposable checks assert UID 10001 and absence of the developer DB/venv. Shared contract files and existing game/client source retain their hashes. |
| R2/A2 | Container HTTPS/assets/deep links, HTTP redirect, private backend, public admin rejection and real WSS. Existing PvP scenario passes 28/28, including identity, both seats, moves, reconnect and terminal refusal; CPU requests and hostile-origin rejection pass. Restart retains saved rows. |
| R3/A3 | Production checks exit 0 with W005/W021 visible and explained in the operator guide. Missing/weak secrets, debug, wildcard hosts and missing/relative DB paths are refused. Existing development defaults pass. |
| R4/A4 | Healthy/unavailable/pending-migration cases, safe methods and generic errors covered. Real container readiness permits startup and recovers after restart/restore. |
| R5/A5 | WAL/rollback, corrupt/missing sources, overwrite and sidecar refusals, CLI exit codes and restored contents tested. Container backs up live, stops the backend, restores to a new path and reopens it with the same saved-row count. |
| R6/A6 | Local execution of the CI smoke command passes; workflow YAML/read-only permissions and cleanup are checked. GitHub-hosted execution awaits publication and is not claimed. |

**607 backend tests (14 new deployment regressions), 1,082 client specs,
production build and migration drift checks pass.** Initial genuine Red checks
reproduced missing health routing and ignored DB override; initial Windows
fixture/fsync failures were corrected. A rejected Angular `--port` harness option
was a setup error, followed by all specs passing on an external spare-port config.
No game schema/defaults/dependencies changed. A separate native Caddy/Daphne
fixture verifies TLS/WSS and Chrome loading the compiled login page; this is not
a new full gameplay browser/layout sweep. No UI template/style changed.

Lead source/security/compatibility review and structural/link/whitespace checks
complete the local evidence. No independent implementation review was available.
WRITTEN; owner authorized branch publication on 18 Oct 2026. Implementation is
committed in `1011146`; owner-SEEN and deployed are not claimed. Full logs/source manifest:
Windows Temp `cpp-deployment-scaffold-e6r03edw/RESULTS.md`.

Remaining launch work: dependency remediation, actual student/account/domain
preflight, VM resource/load measurements, public DNS/HTTPS/WSS and recovery checks.
Docker's local CA and desktop resources establish none of those target properties.

## Recovery review follow-up

Owner asks to fix the reported recovery corruption. R5/A5 also requires both
backup and restore to reject SQLite sidecars at the resolved destination before
publication, preserving orphaned files and dangling aliases. This includes a
sidecar arriving during copying. The earlier 607-test/container evidence predates
this uncovered defect and is retained as scoped history. Lead owns the recovery
script/tests and status/guide updates; no new publication or owner-data actions.

The original guard covered restore's unresolved path only. The shared backup
function now checks `-wal`, `-shm` and `-journal` at the resolved destination
immediately before atomic publication. It preserves orphaned files and dangling
aliases; sidecars appearing during the copy also refuse publication. The duplicate
restore guard is removed. Three new regressions and expanded CLI checks cover
backup/restore, resolved symlinks, a replayable WAL arriving during copying and
refusal without partial files or false success. A baseline reproduction reopened
stale rows while integrity still reported `ok`; the fixed tool refuses that path.

Broader checks exposed two pre-existing verification assumptions. The live socket
scenario sent both readiness requests and then assumed A's event arrived first;
logs show B's event arriving first and being consumed. It now waits for A's
acknowledgement before requesting B's readiness. A tactical CPU quality assertion
failed during concurrent Docker work but passed isolated and in the serial full
suite. That test now uses process CPU time for search budgets; only its clock is
substituted, and runtime thinking deadlines/game mechanics are unchanged. Initial
failures and their logs are retained rather than replaced by passing retries.

Verification: the final backend suite passes 610 tests (one Windows symlink
method skipped for missing OS privileges). All 17 deployment checks pass on Linux
without skips, including that method; the revised CPU assertion also passes on
Linux. Container HTTPS/WSS, all 28 PvP checks, CPU/origin checks, restart persistence
and stopped-backend restore pass. Migration drift, source preservation, syntax,
links and whitespace checks pass. Disposable resources are removed. No frontend,
style, schema or gameplay implementation changed; the earlier 1,082 client
specs/build evidence is reused, not rerun. This correction is lead-reviewed; no
independent follow-up review is claimed. Owner data/services are preserved, and
all existing launch gates remain. Full follow-up logs/source hashes: Windows Temp
`cpp-deployment-scaffold-e6r03edw/review-sidecars-1bsofajz/RESULTS.md`.
