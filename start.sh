#!/usr/bin/env bash
# Start both dev servers, restarting whichever is already up.
#
#   ./start.sh          # Ctrl-C stops both
#   ./start.sh -k       # just stop them, start nothing
#
# Both stream into this terminal. Run from Git Bash or WSL on Windows.
set -u
cd "$(dirname "$0")"

# Restart by port, not by process name: daphne is one python.exe among
# however many are running and ng serve is one node.exe, so matching on name
# is a good way to kill something unrelated. The port is what conflicts.
kill_port() {
  local port=$1 pid
  if command -v netstat.exe >/dev/null 2>&1 && command -v taskkill.exe >/dev/null 2>&1; then
    for pid in $(netstat.exe -ano 2>/dev/null | tr -d '\r' |
        awk -v p=":$port" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {print $5}' | sort -u); do
      echo "  stopping Windows PID $pid on :$port"
      taskkill.exe /PID "$pid" /F >/dev/null 2>&1 || true
    done
  elif command -v ss >/dev/null 2>&1; then
    for pid in $(ss -ltnp "sport = :$port" 2>/dev/null |
        sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u); do
      echo "  stopping PID $pid on :$port"
      kill "$pid" 2>/dev/null || true
    done
  elif command -v netstat >/dev/null 2>&1; then
    for pid in $(netstat -ano | tr -d '\r' |
        awk -v p=":$port" '$1=="TCP" && $2 ~ p"$" && $4=="LISTENING" {print $5}' | sort -u); do
      echo "  stopping PID $pid on :$port"
      taskkill /PID "$pid" /F >/dev/null 2>&1 || true
    done
  fi
}

# Stopping needs no venv and starts nothing, so it answers before the checks.
if [ "${1:-}" = "-k" ]; then
  kill_port 8000
  kill_port 4200
  echo "stopped"
  exit 0
fi

if [ ! -f server/venv/Scripts/daphne.exe ]; then
  echo "No venv at server/venv - run the first-time setup in README.md" >&2
  exit 1
fi

echo "Backend  :8000"
kill_port 8000
if [ -x server/venv/bin/daphne ]; then
  (cd server && DJANGO_DEBUG=true ./venv/bin/daphne -p 8000 core.asgi:application) &
elif command -v cmd.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
  server_win=$(wslpath -w "$PWD/server")
  (cmd.exe /C "cd /d $server_win && set DJANGO_DEBUG=true&& set DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,0.0.0.0&& venv\\Scripts\\daphne.exe -p 8000 core.asgi:application") &
else
  echo "No runnable Daphne environment found under server/venv" >&2
  exit 1
fi
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
