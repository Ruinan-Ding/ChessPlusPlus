# ChessPlusPlus

## Running the Application

### Backend
```bash
cd server
daphne core.asgi:application
```

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