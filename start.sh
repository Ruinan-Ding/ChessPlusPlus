#!/usr/bin/env bash
# Start both dev servers, restarting whichever is already up.
#
#   ./start.sh          # Ctrl-C stops both
#   ./start.sh -k       # just stop them, start nothing
#
# Both stream into this terminal. Runs from Git Bash or WSL on Windows, or a
# plain Linux/macOS shell. BACKEND_PORT / FRONTEND_PORT move them off 8000 /
# 4200, e.g. to try the script without touching servers already running.
set -u
cd "$(dirname "$0")"
BACKEND_PORT=${BACKEND_PORT:-8000}
FRONTEND_PORT=${FRONTEND_PORT:-4200}

# Restart by port, not by process name: daphne is one python.exe among
# however many are running and ng serve is one node.exe, so matching on name
# is a good way to kill something unrelated. The port is what conflicts.
kill_port() {
  local port=$1 pid
  if command -v netstat.exe >/dev/null 2>&1 && command -v taskkill.exe >/dev/null 2>&1; then
    for pid in $(netstat.exe -ano 2>/dev/null | tr -d '\r' |
        awk -v p=":$port" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {print $5}' | sort -u); do
      echo "  stopping Windows PID $pid on :$port"
      # //PID, not /PID: Git Bash rewrites a lone /PID into a path before
      # taskkill ever sees it. WSL passes either through untouched.
      taskkill.exe //PID "$pid" //F >/dev/null 2>&1 ||
        taskkill.exe /PID "$pid" /F >/dev/null 2>&1 || true
    done
  elif command -v ss >/dev/null 2>&1; then
    for pid in $(ss -ltnp "sport = :$port" 2>/dev/null |
        sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u); do
      echo "  stopping PID $pid on :$port"
      kill "$pid" 2>/dev/null || true
    done
  elif command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | sort -u); do
      echo "  stopping PID $pid on :$port"
      kill "$pid" 2>/dev/null || true
    done
  fi
}

# Stopping needs no venv and starts nothing, so it answers before the checks.
if [ "${1:-}" = "-k" ]; then
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  echo "stopped"
  exit 0
fi

echo "Backend  :$BACKEND_PORT"
kill_port "$BACKEND_PORT"
# Three ways to reach the one venv. A Linux venv runs as it is. A Windows venv
# (Scripts/daphne.exe) runs directly from Git Bash, which hands its
# environment to Windows programs - but not from WSL, which does not, so there
# it goes through cmd.exe and sets the variables on the Windows side.
# `wslpath` only exists inside WSL, which is how the two are told apart.
if [ -x server/venv/bin/daphne ]; then
  (cd server && DJANGO_DEBUG=true ./venv/bin/daphne -p "$BACKEND_PORT" core.asgi:application) &
elif [ -f server/venv/Scripts/daphne.exe ] && command -v wslpath >/dev/null 2>&1; then
  server_win=$(wslpath -w "$PWD/server")
  (cmd.exe /C "cd /d $server_win && set DJANGO_DEBUG=true&& set DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,0.0.0.0&& venv\\Scripts\\daphne.exe -p $BACKEND_PORT core.asgi:application") &
elif [ -f server/venv/Scripts/daphne.exe ]; then
  (cd server && DJANGO_DEBUG=true ./venv/Scripts/daphne.exe -p "$BACKEND_PORT" core.asgi:application) &
else
  echo "No venv at server/venv - run the first-time setup in README.md" >&2
  exit 1
fi
backend=$!

echo "Frontend :$FRONTEND_PORT"
kill_port "$FRONTEND_PORT"
(cd client && npx ng serve --port "$FRONTEND_PORT") &
frontend=$!

# Ctrl-C here should take both with it, not leave one holding a port. Killing
# the subshells is not enough on Windows: a daphne.exe or node.exe started
# under them does not die with them, so stop them by port as well.
stop_both() {
  kill $backend $frontend 2>/dev/null
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  exit 0
}
trap stop_both INT TERM

echo
echo "http://localhost:$FRONTEND_PORT"
wait
