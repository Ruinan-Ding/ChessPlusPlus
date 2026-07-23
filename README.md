# ChessPlusPlus

## Running the Application

### Backend
```bash
cd server
DJANGO_DEBUG=true daphne core.asgi:application
```
(Windows cmd: `set DJANGO_DEBUG=true&& daphne core.asgi:application`; PowerShell: `$env:DJANGO_DEBUG='true'; daphne core.asgi:application`)

`DJANGO_DEBUG=true` must be set for **any** local `manage.py` command too
(`test`, `makemigrations`, `migrate`, `runserver`, etc.) — without it Django
requires a real `DJANGO_SECRET_KEY`/`DJANGO_ALLOWED_HOSTS` and refuses to
start, by design (see `server/core/settings.py`).

### Frontend
```bash
cd client
ng serve
```

Then open: http://localhost:4200

## Maintenance

### Clean up stale connections
If you notice ghost users in the lobby, run:
```bash
cd server
python manage.py cleanup_game_state
```

This removes player connections that haven't sent a heartbeat in 10+ minutes.