#!/usr/bin/env bash
# Start both dev servers, restarting whichever is already up.
#
#   ./start.sh          # Ctrl-C stops both
#   ./start.sh -k       # just stop them, start nothing
#
# Both stream into this terminal. Run from Git Bash on Windows.
set -u
cd "$(dirname "$0")"

# Restart by port, not by process name: daphne is one python.exe among
# however many are running and ng serve is one node.exe, so matching on name
# is a good way to kill something unrelated. The port is what conflicts.
# Windows has no lsof or fuser, so netstat says who holds it - and its output
# is CRLF, which would otherwise ride along into the PID.
kill_port() {
  local port=$1 pid
  for pid in $(netstat -ano | tr -d '\r' \
      | awk -v p=":$port" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {print $5}' | sort -u); do
    echo "  stopping PID $pid on :$port"
    taskkill //PID "$pid" //F >/dev/null 2>&1 || true
  done
}

# Stopping needs no venv and starts nothing, so it answers before the checks.
if [ "${1:-}" = "-k" ]; then
  kill_port 8000
  kill_port 4200
  echo "stopped"
  exit 0
fi

if [ ! -x server/venv/Scripts/daphne.exe ]; then
  echo "No venv at server/venv - run the first-time setup in README.md" >&2
  exit 1
fi

echo "Backend  :8000"
kill_port 8000
(cd server && DJANGO_DEBUG=true ./venv/Scripts/daphne.exe -p 8000 core.asgi:application) &
backend=$!

echo "Frontend :4200"
kill_port 4200
(cd client && npx ng serve) &
frontend=$!

# Ctrl-C here should take both with it, not leave one holding a port.
trap 'kill $backend $frontend 2>/dev/null' INT TERM

echo
echo "http://localhost:4200"
wait
