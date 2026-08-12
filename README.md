# ChessPlusPlus

## Running the Application

### First-time setup
```bash
cd server
python -m venv venv
source venv/Scripts/activate      # Windows; use venv/bin/activate on macOS/Linux
pip install -r requirements.txt

cd ../client
npm install
```

### Backend
```bash
cd server
source venv/Scripts/activate      # or call it by path: venv/Scripts/daphne.exe
DJANGO_DEBUG=true daphne core.asgi:application
```
(Windows cmd: `set DJANGO_DEBUG=true&& daphne core.asgi:application`; PowerShell: `$env:DJANGO_DEBUG='true'; daphne core.asgi:application`)

`daphne: command not found` means the venv isn't active.

`DJANGO_DEBUG=true` must be set for **any** local `manage.py` command too
(`test`, `makemigrations`, `migrate`, `runserver`, etc.) — without it Django
requires a real `DJANGO_SECRET_KEY`/`DJANGO_ALLOWED_HOSTS` and refuses to
start, by design (see `server/core/settings.py`).

### Frontend
```bash
cd client
npx ng serve
```
(`ng` is a local devDependency, not a global install — `npx` resolves it. `ng: command not
found` means you dropped the `npx`.)

Then open: http://localhost:4200

## Maintenance

### Clean up stale connections
If you notice ghost users in the lobby, run:
```bash
cd server
python manage.py cleanup_game_state
```

This removes player connections that haven't sent a heartbeat in 10+ minutes.