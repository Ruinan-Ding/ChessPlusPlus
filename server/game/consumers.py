"""
WebSocket consumer for game lobby and game room management
Uses Django ORM models instead of in-memory class-level dictionaries
"""
import asyncio
import datetime
import json
import logging
import random
import secrets
import string
import time
import uuid
from collections import deque
from datetime import timedelta

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.db import transaction
from django.utils import timezone

from typing import Optional, Any, Dict, NamedTuple, cast, Union
from .models import (
    GameRoom,
    GameChallenge,
    PlayerConnection,
    PlayerReadyStatus,
    GameState,
)
from .validators import (
    ValidationError, GAME_OPTION_KEYS, validate_required_fields, validate_username,
    validate_status, validate_game_mode, validate_game_options,
    validate_chat_message
)
from .utils import (
    send_json_response, send_error, broadcast_to_group, expire_stale_challenges,
    get_challenge_expiration_time, structured_log, get_idempotency, set_idempotency
)
from .engine import load_config, build_initial_board, DEFAULT_CONFIG
from .engine.config_loader import rule_of
from .engine import economy, panels
from .engine.board import HexBoard, parse_coord, hex_distance
from .engine.game_logic import (
    board_move_landings,
    board_moves_at,
    defeated_sides,
    get_legal_moves_filtered,
    opening_moved_hexes,
    overtime_toll,
    resolve_combat,
    resolve_panel_attack,
)
from .engine.phases import (
    board_moves_per_turn, is_entry_open,
    is_homecoming_open, is_initialization, is_setup_turn, no_attack_message,
)
from .engine.scoring import bank_ended_phases, schedule_ending

logger = logging.getLogger('game')

# Global dictionary to track pending turn-timer tasks per game
# Key: game_id, Value: asyncio.Task
_pending_turn_timers: dict = {}

# Global dictionary to track pending reveal mode requests
# Key: game_id, Value: {'requester': username, 'task': asyncio.Task, 'action': 'enable'|'disable'}
_pending_reveal_requests: dict = {}

# Seconds a disconnected player has to reconnect before their opponent wins
# by forfeit. Keeps a transient network blip / page refresh from instantly
# ending an active game, while still resolving a real abandonment.
DISCONNECT_GRACE_SECONDS = 30

# How long a PlayerConnection row stays believable without a heartbeat. The
# heartbeat runs every 15 seconds, so this is three missed in a row. One
# constant: the roster sweep and the turn timer's liveness check have to agree
# on who is still there, and two literals cannot.
STALE_AFTER = timedelta(seconds=45)

# How many turns a clock may pass with nobody moving before it stops arming
# itself. A tab left open keeps heartbeating, so "connected" is not "playing",
# and with no turn limit set an abandoned room would otherwise write a state
# row every time_limit seconds for the life of the process.
IDLE_PASS_LIMIT = 6


def _ending_name(config: Dict[str, Any]) -> str:
    """
    What a side losing by the match's objective is called. The objective names
    the ending: a regicide leaves most of the army standing, so calling it an
    elimination reads as a bug.
    """
    objective = (config or {}).get('rules', {}).get('objective', 'regicide')
    return 'regicide' if objective == 'regicide' else 'elimination'


class HandOver(NamedTuple):
    """What a hand-over leaves: the board, the phase bank, and the result."""
    board_state: Dict[str, Any]
    phase_bank: Dict[str, Any]
    #: Username of the winner, or '' - for a draw, and while the match goes on.
    winner: str
    #: '' while the match goes on.
    end_reason: str


def _settle_hand_over(state, board, history, beaten) -> HandOver:
    """
    How a hand-over ends the turn, and whether it ends the match. **Every
    hand-over runs through this** - a move and a blow into a panel
    (``_commit_turn``), a pass and the clock's pass (``_settle_pass``) - once
    the turn has done everything it does to *board*, the toll included, with
    *history* holding the turn's own record.

    In order, each only if nothing before it ended the match:

    1. **The board.** *beaten* is every side that has lost on it: both is a
       draw, one is the other's win by the room's objective.
    2. **The schedule.** The phase the hand-over closed banks
       (``scoring.bank_ended_phases``), and then a side past the other's margin
       once Phase 3 has banked and its postmatch is played wins on points, and
       a match still standing once turn 50 is played out is black's
       (``scoring.schedule_ending``). Both were the owner's rules long before
       anything enforced them.
    3. **The turn limit**, ``rules.maxTurns``, checked against the turn just
       played.

    The order lived in two places, and the browser engine's three copies of
    it had already drifted apart (a panel blow that felled both kings gave
    the match to black). One place per engine now; ``settleHandOver`` in
    local-game.service.ts is the other.
    """
    config = state.config_snapshot or {}
    winner, end_reason = '', ''
    if len(beaten) == 2:
        # A counter-attack can kill the attacker's commander on the
        # attacker's own turn: nobody won that.
        end_reason = 'draw_mutual'
        logger.info(f"Game {state.game_id} drawn: both sides fell in one exchange")
    elif beaten:
        loser = beaten[0]
        winner = state.player_black if loser == 'white' else state.player_white
        end_reason = _ending_name(config)
        logger.info(f"Game {state.game_id} decided: {loser} lost")

    board_state = board.to_dict()
    next_ply = state.turn_number + 1
    bank = bank_ended_phases(state.phase_bank, config, board_state, history, next_ply)
    if not end_reason:
        ending = schedule_ending(bank, next_ply)
        if ending:
            color, end_reason = ending
            winner = state.player_white if color == 'white' else state.player_black

    max_turns = config.get('rules', {}).get('maxTurns', 0)
    if not end_reason and max_turns > 0 and state.turn_number >= max_turns:
        end_reason = 'draw_max_turns'
    return HandOver(board_state, bank, winner, end_reason)


def _settle_pass(state) -> HandOver:
    """
    What a passed turn does to the board and to the match. Shared by the pass
    a player asks for and the pass a clock makes when time runs out, which
    were written out twice and would otherwise each need the toll added.

    **A passed turn is still a turn**, so overtime takes its toll on it and the
    board can change though nobody moved. Neither pass used to touch the board
    or ask who was beaten, and before the toll neither needed to - a king on
    1 HP could simply pass his way past it.

    **Only the side the toll touched is judged.** A pass does not change who
    stands where, so nobody else can have lost on it. The felled side is checked
    against its objective, and nothing else is: under `elimination` a king the
    toll kills loses nothing while his army stands.
    """
    config = state.config_snapshot or {}
    radius = config.get('board', {}).get('radius', DEFAULT_CONFIG['board']['radius'])
    mover_color = 'white' if state.current_turn == state.player_white else 'black'
    board = HexBoard.from_dict(radius, state.board_state)

    felled = overtime_toll(board, config, mover_color, state.turn_number)
    beaten = [felled] if felled and felled in defeated_sides(board, config) else []
    # A pass can be the hand-over that closes a phase, or turn 50: it banks and
    # ends the match on the same terms a move does.
    return _settle_hand_over(state, board, list(state.move_history), beaten)

# Global dictionary to track pending disconnect-grace-period tasks.
# Key: (game_id, username), Value: asyncio.Task
_pending_disconnect_timers: dict = {}

# Per-connection flood protection. Rate limiting is naturally per-connection
# here (not shared/Redis-backed) since Channels gives each WebSocket its own
# consumer instance for its whole lifetime - no cross-process state needed.
MAX_MESSAGE_BYTES = 32 * 1024  # comfortably covers a full custom game config
RATE_LIMIT_WINDOW_SECONDS = 10
RATE_LIMIT_MAX_MESSAGES = 30  # ~3/sec sustained, generous burst allowance


# How long a room's access token stays good. Refreshed on every successful
# join (see _handle_join_game_room), so this is how long an *unused* invite
# lasts - not a ceiling on how long a game may run.
GAME_TOKEN_LIFETIME = timedelta(minutes=10)


def _extract_secret(data: Dict[str, Any]) -> str:
    """Pull the client-asserted identity secret out of an incoming message."""
    return str(data.get('secret') or '').strip()[:64]


def _guest_name() -> str:
    """A free-for-the-taking name, for somebody whose own was not."""
    return f"Guest{''.join(random.choices(string.digits, k=6))}"


def _same_secret(stored: str, offered: str) -> bool:
    """Constant-time compare for the two strings that gate access here: a
    room's access token and a browser's identity secret. Encoded rather than
    compared as str because compare_digest rejects non-ASCII text, and both
    of these arrive off the wire."""
    return secrets.compare_digest(str(stored).encode(), str(offered).encode())


class GameConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer handling all game and lobby operations.
    Uses async/await pattern with database operations for thread-safety.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Initialize as strings to satisfy type checks for broadcast/group methods
        self.room_name = 'default'
        self.room_group_name = 'game_default'
        self.username = None
        self.game_id = None
        self.leaving_game_room = False  # Track if user is leaving to lobby
        self._last_activity_update = None  # Throttle activity updates
        self._message_timestamps: deque = deque()  # sliding-window rate limit
    
    async def connect(self):
        """Handle WebSocket connection"""
        try:
            url_route: Dict[str, Any] = cast(Dict[str, Any], self.scope.get('url_route', {}))
            kwargs: Dict[str, Any] = cast(Dict[str, Any], url_route.get('kwargs', {}))
            self.room_name = cast(str, kwargs.get('room_name') or 'default')
            self.room_group_name = f'game_{self.room_name}'
            
            # Only join lobby group immediately - game room groups require validation first
            # This prevents unauthorized users from receiving game room broadcasts
            if self.room_name == 'lobby':
                await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            # For game rooms, we'll add to the group in _handle_join_game_room after validation
            
            await self.accept()
            
            await send_json_response(self, {
                'type': 'connection_established',
                'message': 'Connected to game server'
            })
            
            logger.info(f"Connection established to {self.room_name}")
        except Exception as e:
            logger.error(f"Error in connect: {e}")
            await self.close()
    
    async def disconnect(self, code):
        """
        Handle WebSocket disconnection - cleanup all associated data
        """
        logger.info(f"Disconnect called for {self.username} from {self.room_name} (code: {code})")
        
        try:
            if self.username:
                # If leaving game room to return to lobby, don't clean up - user will rejoin
                if self.leaving_game_room:
                    logger.info(f"User {self.username} leaving game room, will rejoin lobby")
                    # Don't delete the player connection - they're just switching rooms
                    # Clean up game room specific data only
                    if self.game_id:
                        await self._delete_ready_status(self.game_id, self.username)
                else:
                    # Clean up lobby connection
                    if self.room_name == 'lobby':
                        await self._cleanup_lobby_connection()
                    
                    # Clean up game room connection (only if user was validated to be in game)
                    elif self.game_id:
                        await self._cleanup_game_room_connection()
                    else:
                        logger.info(f"User {self.username} disconnecting without validated game_id, skipping cleanup")
            
            # Leave channel group (only if we were in one)
            # For game rooms, users are only added after validation, so this is safe
            if self.room_name == 'lobby' or self.game_id:
                await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        except Exception as e:
            logger.error(f"Error during disconnect cleanup: {e}")
    
    async def _cleanup_lobby_connection(self):
        """Clean up when user disconnects from lobby"""
        try:
            # Check if the player is in-game - if so, don't delete their connection
            # They're just transitioning from lobby to game room
            player_conn = await self._get_player_connection(self.username)
            # In-game: they are mid-transition to a room, not leaving. Or the
            # row has moved on to another channel, which makes this the close
            # of a socket the player has already replaced - see
            # _cleanup_game_room_connection for what that costs.
            if player_conn and (player_conn.status == 'in-game'
                                or player_conn.channel_name != self.channel_name):
                logger.info(f"User {self.username} is elsewhere, not deleting PlayerConnection")
                return
            
            await self._delete_player_connection(self.username, channel_name=self.channel_name)

            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'user_left',
                'username': self.username
            })

            await self._send_user_list()
        except Exception as e:
            logger.error(f"Error cleaning up lobby connection for {self.username}: {e}")
    
    async def _cleanup_game_room_connection(self):
        """Clean up when user disconnects from game room"""
        try:
            game = await self._get_game_by_id(self.game_id)
            if not game:
                return

            # A socket this player has already replaced. Its close can land
            # long after the fact - a half-open connection is only torn down
            # when the OS or a proxy finally gives up on it - and by then the
            # row, the ready flag and the seat all belong to the newer
            # session. _delete_player_connection below has always known this
            # (hence its channel_name guard); nothing above it did, so a late
            # close cleared a live player's ready tick, told the room they had
            # dropped, and armed a forfeit against somebody sitting right
            # there.
            if await self._reclaimed_by_newer_socket(self.username, self.channel_name):
                logger.info(
                    f"Ignoring stale disconnect for {self.username} in game {self.game_id}")
                return

            # Dropping out always clears your ready flag - the room must not be
            # startable while somebody is missing. Tell the room so the other
            # player's list updates instead of showing a stale tick.
            await self._delete_ready_status(self.game_id, self.username)
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'player_unready',
                'username': self.username,
                'silent': True,
            })

            # A page refresh is indistinguishable from a disconnect, so never
            # tear anything down on the spot - always give the player a grace
            # period to come back (cancelled in _handle_join_game_room). What
            # happens if the timer actually fires depends on whether a match
            # was underway; see _start_disconnect_grace_timer. Any turn timer
            # is left running: if the disconnected player was on the clock it
            # should still expire normally.
            await self._start_disconnect_grace_timer(self.game_id, self.username)
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'opponent_disconnected',
                'username': self.username,
                'graceSeconds': DISCONNECT_GRACE_SECONDS,
            })

            await self._delete_player_connection(self.username, channel_name=self.channel_name)
        except Exception as e:
            logger.error(f"Error cleaning up game room connection for {self.username}: {e}")
    
    def _check_rate_limit(self) -> bool:
        """Sliding-window flood guard: True if this message is within the
        allowed rate, False if the connection should be throttled."""
        now = time.monotonic()
        timestamps = self._message_timestamps
        timestamps.append(now)
        while timestamps and now - timestamps[0] > RATE_LIMIT_WINDOW_SECONDS:
            timestamps.popleft()
        return len(timestamps) <= RATE_LIMIT_MAX_MESSAGES

    async def receive(self, text_data=None, bytes_data=None):
        """
        Handle incoming WebSocket messages
        """
        try:
            incoming_data: Union[str, bytes, None] = text_data if text_data is not None else bytes_data
            if incoming_data is None:
                await send_error(self, 'INVALID_JSON', 'Message must be non-empty')
                return

            size = len(incoming_data) if isinstance(incoming_data, bytes) else len(incoming_data.encode('utf-8'))
            if size > MAX_MESSAGE_BYTES:
                await send_error(self, 'MESSAGE_TOO_LARGE', 'Message exceeds the maximum allowed size')
                return

            if not self._check_rate_limit():
                await send_error(self, 'RATE_LIMITED', 'Too many messages - please slow down')
                return

            data = json.loads(incoming_data)
            message_type = data.get('type', '')

            logger.debug(f"Message received from {self.username}: {message_type}")
            structured_log('debug', 'message_received', username=self.username, message_type=message_type)

            handlers = {
                'join_lobby': self._handle_join_lobby,
                'leave_lobby': self._handle_leave_lobby,
                'chat_message': self._handle_chat_message,
                'change_username': self._handle_change_username,
                'set_status': self._handle_set_status,
                'game_challenge': self._handle_game_challenge,
                'challenge_accept': self._handle_challenge_accept,
                'challenge_decline': self._handle_challenge_decline,
                'join_game_room': self._handle_join_game_room,
                'leave_game_room': self._handle_leave_game_room,
                'game_room_message': self._handle_game_room_message,
                'player_ready': self._handle_player_ready,
                'player_unready': self._handle_player_unready,
                'change_game_mode': self._handle_change_game_mode,
                'set_custom_config': self._handle_set_custom_config,
                'request_reveal_mode': self._handle_request_reveal_mode,
                'reveal_response': self._handle_reveal_response,
                'start_game': self._handle_start_game,
                'request_user_list': self._handle_request_user_list,
                'heartbeat': self._handle_heartbeat,
                # Gameplay handlers (in-game)
                'make_move': self._handle_make_move,
                'enter_board': self._handle_enter_board,
                'panel_move': self._handle_panel_move,
                'panel_attack': self._handle_panel_attack,
                'pass_turn': self._handle_pass_turn,
                'resign': self._handle_resign,
                'offer_draw': self._handle_offer_draw,
                'respond_draw': self._handle_respond_draw,
                'request_game_state': self._handle_request_game_state,
            }
            
            handler = handlers.get(message_type)
            if handler:
                # touch last_activity for presence (throttled to every 10 seconds)
                if self.username:
                    now = timezone.now()
                    should_update = (
                        self._last_activity_update is None or
                        (now - self._last_activity_update).total_seconds() > 10
                    )
                    if should_update:
                        try:
                            await self._update_player_activity(self.username)
                            self._last_activity_update = now
                        except Exception:
                            structured_log('warning', 'update_activity_failed', username=self.username)
                await handler(data)
            else:
                logger.warning(f"Unknown message type: {message_type}")
        
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON received: {e}")
            await send_error(self, 'INVALID_JSON', 'Message must be valid JSON')
        except ValidationError as e:
            logger.warning(f"Validation error: {e.message}")
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error processing message: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'An error occurred processing your message')
    
    async def _require_seat(self, game_id: str):
        """The room this player actually holds a seat in, or None.

        Every handler that takes a `gameId` off the wire needs this: proving
        "I am who I say I am" says nothing about whether the room named is
        one of mine. Sends the error itself, so callers just return on None.
        """
        game = await self._get_game_by_id(game_id)
        if not game:
            await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
            return None
        if self.username not in (game.host, game.opponent):
            await send_error(self, 'NOT_IN_GAME', 'You are not in this game')
            return None
        return game

    # ==================== Message Handlers ====================
    
    async def _handle_join_lobby(self, data):
        """Handle user joining the lobby"""
        try:
            username = data.get('username', '').strip()
            original_username = username
            username_was_taken = False
            client_secret = _extract_secret(data)

            validate_username(username)

            existing_connection = await self._get_player_connection(username)
            takeover = False
            if existing_connection and existing_connection.channel_name != self.channel_name:
                # ponytail: single seam for identity verification - replace this
                # comparison with real credential checking if accounts are added later.
                secret_ok = bool(existing_connection.secret) and _same_secret(existing_connection.secret, client_secret)
                # A row nobody has heartbeated for STALE_AFTER is almost
                # certainly abandoned: a server that dies runs no disconnects,
                # so every player's row outlives it, and the sweep that clears
                # them runs a moment later in _get_all_online_users. Left to
                # that sweep alone, the first player back after a restart was
                # renamed to a guest and lost their seat with the name (6.18).
                #
                # **Almost certainly is not certainly, so the secret still
                # decides.** A sleeping laptop misses three heartbeats too, and
                # the name is what holds a seat - freeing the row outright
                # would hand a live player's name, and the game they are sat
                # in, to whoever asked for it next. Staleness widens WHEN the
                # owner may take their row back; it never widens WHO. A row
                # carrying no secret has nothing to check and nothing to
                # protect, so age alone is enough for that one.
                stale = existing_connection.last_activity < timezone.now() - STALE_AFTER
                if (secret_ok and (data.get('rejoining', False) or stale)) \
                        or (stale and not existing_connection.secret):
                    logger.info(f"User {username} taking back their lobby row (stale: {stale})")
                    takeover = True
                else:
                    if data.get('rejoining', False):
                        logger.warning(f"Rejected rejoin claim for '{username}': secret mismatch")
                    # Generate a random username instead of rejecting
                    username = _guest_name()
                    username_was_taken = True
                    logger.info(f"Username '{original_username}' was taken, assigned '{username}' instead")

            # The claim decides it, not the read above. Between the two, a
            # second client that also saw the name free could write it - and
            # update_or_create on the primary key handed it the first client's
            # row, channel name and identity secret with it.
            if not await self._claim_player_connection(username, self.channel_name, client_secret, takeover=takeover):
                username = _guest_name()
                username_was_taken = True
                logger.info(f"Username '{original_username}' was claimed mid-join, assigned '{username}' instead")
                await self._claim_player_connection(username, self.channel_name, client_secret)

            self.username = username
            
            if username_was_taken:
                await send_json_response(self, {
                    'type': 'username_assigned',
                    'username': username,
                    'originalUsername': original_username,
                    'message': f'Username "{original_username}" was taken. You have been assigned "{username}".'
                })
            
            # Notify others (only if not rejoining, to avoid duplicate notifications)
            if not data.get('rejoining', False):
                await broadcast_to_group(self.channel_layer, self.room_group_name, {
                    'type': 'user_joined',
                    'username': username
                })
            
            await self._send_user_list()
            
            logger.info(f"User {username} joined lobby (rejoining: {data.get('rejoining', False)})")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in join_lobby: {e}")
            await send_error(self, 'INTERNAL_ERROR', str(e))
    
    async def _handle_leave_lobby(self, data):
        """Handle user leaving the lobby"""
        try:
            username = data.get('username', '').strip()
            
            if self.username != username:
                await send_error(self, 'INVALID_REQUEST', 'Cannot leave as different user')
                return

            await self._delete_player_connection(username, channel_name=self.channel_name)
            
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'user_left',
                'username': username
            })
            
            await self._send_user_list()
            
            logger.info(f"User {username} left lobby")
        except Exception as e:
            logger.error(f"Error in leave_lobby: {e}")
            await send_error(self, 'INTERNAL_ERROR', str(e))
    
    async def _handle_chat_message(self, data):
        """Handle chat message in lobby (or from game room to lobby)"""
        try:
            if not self.username:
                # Otherwise a socket that connected and never joined talks to
                # the whole lobby as `null`.
                await send_error(self, 'NOT_IN_LOBBY', 'Join the lobby before chatting')
                return

            validate_required_fields(data, ['content'])
            validate_chat_message(data['content'])
            
            # Broadcast to lobby group only
            # Game room users are also in the lobby group, so they'll receive this too
            await broadcast_to_group(self.channel_layer, 'game_lobby', {
                'type': 'chat_message',
                'username': self.username,
                'content': data['content'],
                'timestamp': data.get('timestamp', datetime.datetime.now().isoformat())
            })
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_change_username(self, data):
        """Handle username change request"""
        try:
            old_username = data.get('oldUsername', '').strip()
            new_username = data.get('newUsername', '').strip()
            client_secret = _extract_secret(data)

            validate_username(new_username)

            if self.username != old_username:
                await send_error(self, 'INVALID_REQUEST', 'Cannot change username for another user')
                return

            # Claim first, release second. The read-then-write this replaces
            # could be raced into a takeover, and deleting the old row up front
            # meant a rename that lost that race left the player with no row at
            # all. A claim that fails now costs them nothing. A rename to the
            # name already held touches neither: releasing it would drop the
            # row that was just claimed, and the client is still waiting to be
            # told the change went through.
            if new_username != old_username:
                if not await self._claim_player_connection(new_username, self.channel_name, client_secret):
                    await send_error(self, 'USERNAME_TAKEN', f'Username "{new_username}" is already taken')
                    return
                await self._delete_player_connection(old_username, channel_name=self.channel_name)

            self.username = new_username
            
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'username_changed',
                'oldUsername': old_username,
                'newUsername': new_username
            })
            
            await self._send_user_list()
            
            logger.info(f"User renamed from {old_username} to {new_username}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_set_status(self, data):
        """Handle player status change"""
        try:
            username = data.get('username', '').strip()
            status = data.get('status', '').strip()
            
            if self.username != username:
                await send_error(self, 'INVALID_REQUEST', 'Cannot set status for another user')
                return
            
            validate_status(status)
            
            await self._update_player_status(username, status)
            
            await self._send_user_list()
            
            # If user is in a game room, also send updated player list to that room
            if self.game_id:
                game = await self._get_game_by_id(self.game_id)
                if game:
                    is_inviter = username == game.host
                    await self._send_game_player_list(self.game_id, is_inviter)
            
            logger.info(f"User {username} status changed to {status}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_game_challenge(self, data):
        """Handle game challenge/invitation"""
        try:
            validate_required_fields(data, ['challenger', 'opponent'])
            
            challenger = data.get('challenger', '').strip()
            opponent = data.get('opponent', '').strip()
            
            if self.username != challenger:
                await send_error(self, 'INVALID_REQUEST', 'Can only challenge as yourself')
                return
            
            if challenger == opponent:
                await send_error(self, 'INVALID_OPPONENT', 'Cannot challenge yourself')
                return
            
            # Before deciding who is busy: an invite whose responder simply
            # closed their tab used to stay 'pending' for the life of the
            # database, leaving both of them 'invited' - refused as busy for
            # every future invite - and CHALLENGE_EXISTS refusing this pair
            # specifically, forever. expires_at was written at creation and
            # read by nothing the server runs.
            await self._expire_stale_challenges()

            # Validate both users exist and are online (batch query for efficiency)
            connections = await self._get_player_connections_batch([challenger, opponent])
            challenger_conn = connections.get(challenger)
            opponent_conn = connections.get(opponent)
            
            if not challenger_conn or not opponent_conn:
                await send_error(self, 'USER_NOT_FOUND', 'One or both users not found')
                return
            
            # Check if challenger is available (not already in-game or invited)
            if challenger_conn.status in ['in-game', 'invited']:
                await send_error(self, 'CHALLENGER_BUSY', 'You are already in a game or have a pending invite')
                return
            
            # Check if opponent is available (not already in-game or invited)
            if opponent_conn.status in ['in-game', 'invited']:
                status_msg = 'in a game' if opponent_conn.status == 'in-game' else 'handling an invite'
                await send_error(self, 'OPPONENT_BUSY', f'{opponent} is currently {status_msg}')
                return
            
            # Check if opponent already has a pending challenge from this challenger
            existing = await self._get_challenge(challenger, opponent)
            if existing:
                if existing.status == 'pending':
                    await send_error(self, 'CHALLENGE_EXISTS', 'You have already challenged this user')
                    return
                else:
                    # Delete old declined/expired challenges to allow re-invitation
                    await self._delete_challenge(existing)
            
            idem_key = data.get('idempotency_key')
            if idem_key:
                prior = get_idempotency(idem_key)
                if prior:
                    await send_json_response(self, {
                        'type': 'challenge_existing',
                        'invite_id': prior.get('invite_id')
                    })
                    structured_log('info', 'challenge_idempotent_hit', key=idem_key, challenger=challenger, opponent=opponent)
                    return

            # Both players marked invited in one statement, and only if neither
            # already is. The checks above read the statuses and this used to
            # write them after the invite was made, so two players inviting each
            # other at once both read "online" in between and both invites went
            # out. The read stays for its clearer refusals; this is the guard.
            if not await self._claim_invite_pair(challenger, opponent):
                await send_error(self, 'OPPONENT_BUSY', f'{opponent} is currently handling an invite')
                return

            try:
                challenge = await self._create_challenge(challenger, opponent)
            except Exception:
                # No invite to expire means nothing would ever release them.
                await self._update_player_status(challenger, 'online')
                await self._update_player_status(opponent, 'online')
                raise
            if idem_key:
                try:
                    set_idempotency(idem_key, {'invite_id': challenge.challenge_id}, timeout=60)
                except Exception:
                    structured_log('warning', 'idempotency_set_failed', key=idem_key)
            
            await self._send_user_list()
            
            await self.channel_layer.send(opponent_conn.channel_name, {
                'type': 'send_game_challenge',
                'challenger': challenger,
                'opponent': opponent,
                'invite_id': challenge.challenge_id
            })
            
            logger.info(f"Challenge created: {challenger} -> {opponent}")
            structured_log('info', 'challenge_created', challenger=challenger, opponent=opponent, invite_id=challenge.challenge_id)
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_challenge_accept(self, data):
        """Handle challenge acceptance"""
        try:
            validate_required_fields(data, ['challenger', 'opponent'])
            
            challenger = data.get('challenger', '').strip()
            opponent = data.get('opponent', '').strip()
            
            if self.username != opponent:
                await send_error(self, 'INVALID_REQUEST', 'Only the challenged player can accept')
                return
            
            challenge = await self._get_challenge(challenger, opponent)
            if not challenge or challenge.status != 'pending':
                await send_error(self, 'CHALLENGE_NOT_FOUND', 'Challenge not found or no longer pending')
                return
            
            game_id = str(uuid.uuid4())
            
            idem_key = data.get('idempotency_key')
            if idem_key:
                prior = get_idempotency(idem_key)
                if prior:
                    existing_game_id = prior.get('game_id')
                    await send_json_response(self, {
                        'type': 'game_already_created',
                        'gameId': existing_game_id
                    })
                    structured_log('info', 'game_create_idempotent_hit', key=idem_key, game_id=existing_game_id)
                    return

            logger.info(f"[challenge_accept] Creating game room: challenger={challenger}, opponent={opponent}, game_id={game_id}")
            game = await self._create_game_room(challenger, opponent, game_id)
            logger.info(f"[challenge_accept] Game created: host={game.host}, opponent={game.opponent}, host_token_len={len(game.host_token)}, opponent_token_len={len(game.opponent_token)}")
            if idem_key:
                try:
                    set_idempotency(idem_key, {'game_id': game.game_id}, timeout=300)
                except Exception:
                    structured_log('warning', 'idempotency_set_failed', key=idem_key)
            
            # Delete the challenge now that game is created (prevents CHALLENGE_EXISTS on re-invite)
            await self._delete_challenge(challenge)
            
            # Update both players' status to 'in-game' before they navigate to the game room
            # This prevents the PlayerConnection from being deleted when lobby disconnects
            await self._update_player_status(challenger, 'in-game')
            await self._update_player_status(opponent, 'in-game')
            
            # Notify both players with their respective tokens (batch query for efficiency)
            connections = await self._get_player_connections_batch([challenger, opponent])
            challenger_conn = connections.get(challenger)
            opponent_conn = connections.get(opponent)
            
            if challenger_conn:
                await self.channel_layer.send(challenger_conn.channel_name, {
                    'type': 'send_challenge_accepted',
                    'username': opponent,
                    'gameId': game_id,
                    'token': game.host_token
                })
            
            if opponent_conn:
                await self.channel_layer.send(opponent_conn.channel_name, {
                    'type': 'send_challenge_accepted',
                    'username': opponent,
                    'gameId': game_id,
                    'token': game.opponent_token
                })
            
            await self._send_user_list()
            
            logger.info(f"Challenge accepted: {challenger} <-> {opponent} (game: {game_id})")
            structured_log('info', 'challenge_accepted', challenger=challenger, opponent=opponent, game_id=game_id)
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_challenge_decline(self, data):
        """Handle challenge decline"""
        try:
            validate_required_fields(data, ['challenger', 'opponent'])
            
            challenger = data.get('challenger', '').strip()
            opponent = data.get('opponent', '').strip()
            
            if self.username != opponent:
                await send_error(self, 'INVALID_REQUEST', 'Only the challenged player can decline')
                return
            
            challenge = await self._get_challenge(challenger, opponent)
            if not challenge:
                await send_error(self, 'CHALLENGE_NOT_FOUND', 'Challenge not found')
                return
            
            await self._update_challenge_status(challenge.challenge_id, 'declined')
            
            await self._update_player_status(challenger, 'online')
            await self._update_player_status(opponent, 'online')
            
            await self._send_user_list()
            
            challenger_conn = await self._get_player_connection(challenger)
            if challenger_conn:
                await self.channel_layer.send(challenger_conn.channel_name, {
                    'type': 'send_challenge_declined',
                    'username': opponent
                })
            
            logger.info(f"Challenge declined: {challenger} <- {opponent}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_join_game_room(self, data):
        """Handle player joining a game room"""
        try:
            validate_required_fields(data, ['username', 'gameId', 'token'])
            
            username = data.get('username', '').strip()
            game_id = data.get('gameId', '').strip()
            token = data.get('token', '').strip()
            
            logger.info(f"[join_game_room] User {username} attempting to join game {game_id}")
            
            # Set username if not already set (for new WebSocket connections)
            if not self.username:
                self.username = username
            
            if self.username != username:
                await send_error(self, 'INVALID_REQUEST', 'Can only join as yourself')
                return
            
            game = await self._get_game_by_id(game_id)
            if not game or game.status == 'closed':
                await send_error(self, 'GAME_NOT_FOUND', 'Game room not found')
                return

            logger.info(f"[join_game_room] Game found: host={game.host}, opponent={game.opponent}")

            if username != game.host and username != game.opponent:
                logger.warning(f"[join_game_room] User {username} not in game - host={game.host}, opponent={game.opponent}")
                await send_error(self, 'NOT_IN_GAME', 'You are not in this game')
                return
            
            expected_token = game.host_token if username == game.host else game.opponent_token
            if not expected_token or not _same_secret(expected_token, token):
                await send_error(self, 'INVALID_TOKEN', 'Invalid or missing access token')
                return

            if game.token_expires_at and timezone.now() > game.token_expires_at:
                await send_error(self, 'TOKEN_EXPIRED', 'Access token has expired')
                return

            # Getting this far proves the seat is theirs, so the clock starts
            # over. The client rejoins on every socket reopen, so a token
            # frozen at room creation meant any blip past the ten-minute mark
            # answered TOKEN_EXPIRED, bounced the player to the lobby, and let
            # the disconnect grace timer forfeit a match still being played.
            await self._refresh_game_token(game_id)

            self.game_id = game_id

            # Cancel any pending disconnect-forfeit grace timer
            had_pending_grace = (game_id, username) in _pending_disconnect_timers
            self._cancel_disconnect_timer(game_id, username)

            # The game room may arrive on a fresh WebSocket, so refresh the stored
            # channel - and the identity secret with it. Leaving the room deletes
            # this row, so a rejoin is what recreates it, and recreated without a
            # secret the player came back to the lobby unable to prove their own
            # name and was handed a guest's. The token above has just proved the
            # seat, so the secret offered alongside it is theirs. A client that
            # sends none keeps whatever the row already holds.
            await self._create_or_update_player_connection(
                username, self.channel_name, 'in-game', secret=_extract_secret(data) or None)
            
            # Add to the game room group, but keep lobby group membership for lobby chat
            self.room_name = game_id
            self.room_group_name = f'game_{game_id}'
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            await self.channel_layer.group_add('game_lobby', self.channel_name)
            
            await self._send_user_list()

            logger.info(f"Sending player_list for game {game_id}, is_inviter: {username == game.host}")

            await self._send_game_player_list(game_id, username == game.host)

            if had_pending_grace:
                await broadcast_to_group(self.channel_layer, self.room_group_name, {
                    'type': 'opponent_reconnected',
                    'username': username,
                })

            # Notify client of join success with game status (for reconnection)
            await send_json_response(self, {
                'type': 'join_game_room_success',
                'gameId': game_id,
                'gameStatus': game.status,
            })

            logger.info(f"User {username} joined game room {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_leave_game_room(self, data):
        """Handle player leaving a game room"""
        try:
            validate_required_fields(data, ['username', 'gameId'])
            
            username = data.get('username', '').strip()
            game_id = data.get('gameId', '').strip()
            
            if self.username != username:
                await send_error(self, 'INVALID_REQUEST', 'Can only leave as yourself')
                return
            
            # Verify user is actually in this game before allowing leave
            game = await self._get_game_by_id(game_id)
            if not game:
                logger.warning(f"[leave_game_room] Game {game_id} not found, skipping leave")
                return
            
            if username != game.host and username != game.opponent:
                logger.warning(f"[leave_game_room] User {username} not in game {game_id} (host={game.host}, opponent={game.opponent}), ignoring leave request")
                return
            
            logger.info(f"[leave_game_room] User {username} leaving game {game_id}")

            # Stop any pending turn timer - this room is being abandoned
            self._cancel_turn_timer(game_id)

            # Deliberately leaving an active match forfeits it - record the
            # result and tell both players. (The disconnect path gets a grace
            # period because it can be accidental; walking out is a choice.)
            forfeited = False
            state = await self._get_game_state(game_id)
            if state and not state.is_finished:
                winner = game.opponent if username == game.host else game.host
                if await self._end_game(game_id, state, winner, 'resign'):
                    await self._broadcast_game_over(game_id, winner, 'resign', resignedBy=username)
                    forfeited = True
                    logger.info(f"Game {game_id} forfeited to {winner} - {username} left mid-game")

            # Send to game room BEFORE leaving the group
            game_room_group = f'game_{game_id}'
            await self.channel_layer.group_send(
                game_room_group,
                {
                    'type': 'partner_left',
                    'username': username,
                    'gameId': game_id
                }
            )
            self.leaving_game_room = True

            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
            self.room_name = 'lobby'
            self.room_group_name = 'game_lobby'
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)

            # Update player status back to 'online' (keep the connection alive)
            await self._update_player_status(username, 'online')

            await self._delete_ready_status(game_id, username)

            # Always close the room: there's no way for anyone but the
            # original host/opponent to join it (see _handle_join_game_room),
            # so a deliberate leave - by either player, before or after the
            # game starts - always makes the room unusable. The remaining
            # player is sent back to the lobby by partner_left if they're
            # actively in the room; if they're elsewhere (e.g. configuring),
            # closing it here is what makes their eventual rejoin attempt
            # bounce them to the lobby instead of rejoining a stale room.
            await self._close_game_room(game_id, f"{username} left the game room")

            await self._send_user_list()
            
            logger.info(f"User {username} left game room {game_id}, returning to lobby")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_game_room_message(self, data):
        """Handle game room chat message"""
        try:
            if not self.username or not self.game_id:
                # group_send never asked whether the sender is in the group, so
                # without this a socket opened on a known room id could talk
                # into that room having shown no token at all. game_id is only
                # set by _handle_join_game_room, after the token check.
                await send_error(self, 'NOT_IN_GAME_ROOM', 'You are not in a game room')
                return

            validate_required_fields(data, ['content'])
            validate_chat_message(data['content'])

            # Send directly to game room group (not wrapped in broadcast_message)
            await self.channel_layer.group_send(
                f'game_{self.game_id}',
                {
                    'type': 'game_room_message',
                    'username': self.username,
                    'content': data['content'],
                    'timestamp': data.get('timestamp', datetime.datetime.now().isoformat())
                }
            )
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_player_ready(self, data):
        """Handle player marking themselves as ready"""
        try:
            validate_required_fields(data, ['username', 'gameId'])
            
            username = data.get('username', '').strip()
            game_id = data.get('gameId', '').strip()
            
            if self.username != username:
                await send_error(self, 'INVALID_REQUEST', 'Can only ready yourself')
                return
            
            if not await self._require_seat(game_id):
                return

            await self._set_ready_status(game_id, username, True)

            await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                'type': 'player_ready',
                'username': username
            })
            
            logger.info(f"Player {username} is ready in game {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_player_unready(self, data):
        """Handle player marking themselves as not ready"""
        try:
            validate_required_fields(data, ['username', 'gameId'])
            
            username = data.get('username', '').strip()
            game_id = data.get('gameId', '').strip()
            
            if self.username != username:
                await send_error(self, 'INVALID_REQUEST', 'Can only unready yourself')
                return
            
            if not await self._require_seat(game_id):
                return

            await self._set_ready_status(game_id, username, False)

            silent = data.get('silent', False)
            await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                'type': 'player_unready',
                'username': username,
                'silent': silent
            })
            
            logger.info(f"Player {username} is not ready in game {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_change_game_mode(self, data):
        """Handle game mode change"""
        try:
            validate_required_fields(data, ['mode', 'gameId'])
            
            mode = data.get('mode', '').strip()
            game_id = data.get('gameId', '').strip()
            
            validate_game_mode(mode)
            
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            if self.username != game.host:
                await send_error(self, 'PERMISSION_DENIED', 'Only the host can change game mode')
                return
            
            # None, not {}: a mode change that names no options is not a
            # request to forget the clock the host already picked.
            options = None
            if 'options' in data:
                validate_game_options(data['options'])
                options = data['options']
            
            await self._update_game_mode(game_id, mode, options)

            # Anyone who already readied did so against the OLD settings, so a
            # host change has to send them round again.
            for player in (game.host, game.opponent):
                if player and player != self.username:
                    await self._delete_ready_status(game_id, player)
                    await broadcast_to_group(self.channel_layer, self.room_group_name, {
                        'type': 'player_unready',
                        'username': player,
                        'silent': True,
                    })

            message_data = {
                'type': 'game_mode_changed',
                'mode': mode
            }
            if options:
                message_data['options'] = options
            
            await broadcast_to_group(self.channel_layer, self.room_group_name, message_data)
            
            mode_text = "Default Mode" if mode == "default" else "Custom Mode"
            options_text = ""
            if mode == 'custom' and options:
                option_list = [f"{k}: {v}" for k, v in options.items()]
                if option_list:
                    options_text = f" (Options: {', '.join(option_list)})"
            
            logger.info(f"Game mode changed to {mode_text}{options_text} in game {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)

    async def _handle_set_custom_config(self, data):
        """Handle the host saving a full custom board/unit config for their
        game room (from the setup screen). Only takes effect at game start
        if the room is still in 'custom' mode at that point."""
        try:
            validate_required_fields(data, ['config'])

            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME_ROOM', 'You are not in a game room')
                return

            game = await self._get_game_by_id(self.game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return

            if self.username != game.host:
                await send_error(self, 'PERMISSION_DENIED', 'Only the host can set the game config')
                return

            try:
                config = load_config(data['config'])
            except ValueError as e:
                await send_error(self, 'INVALID_CONFIG', str(e))
                return

            await self._set_custom_config(self.game_id, config)

            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'custom_config_saved',
                'savedBy': self.username,
            })

            logger.info(f"Custom config saved for game {self.game_id} by {self.username}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_set_custom_config: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to save custom config')

    async def _handle_request_reveal_mode(self, data):
        """Handle request to enable/disable reveal mode (requires opponent acceptance)"""
        try:
            validate_required_fields(data, ['gameId', 'action'])
            
            game_id = data.get('gameId', '').strip()
            action = data.get('action', '').strip().lower()
            
            if action not in ['enable', 'disable']:
                await send_error(self, 'INVALID_ACTION', 'Action must be enable or disable')
                return
            
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            if self.username != game.host:
                await send_error(self, 'PERMISSION_DENIED', 'Only the host can request reveal mode changes')
                return
            
            # Get opponent (self.username is always the host here, per the check above)
            opponent = game.opponent
            if not opponent:
                await send_error(self, 'NO_OPPONENT', 'Opponent not found')
                return
            
            if game_id in _pending_reveal_requests:
                old_task = _pending_reveal_requests[game_id].get('task')
                if old_task:
                    old_task.cancel()
            
            async def reveal_timeout():
                try:
                    await asyncio.sleep(5)
                    _pending_reveal_requests.pop(game_id, None)
                    await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                        'type': 'reveal_request_timeout'
                    })
                except asyncio.CancelledError:
                    pass
            
            timeout_task = asyncio.create_task(reveal_timeout())
            _pending_reveal_requests[game_id] = {
                'requester': self.username,
                'task': timeout_task,
                'action': action
            }
            
            await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                'type': 'reveal_mode_requested',
                'username': self.username,
                'action': action
            })
            
            logger.info(f"Reveal mode {action} requested by {self.username} in game {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_request_reveal_mode: {e}")
            await send_error(self, 'INTERNAL_ERROR', 'Failed to request reveal mode')
    
    async def _handle_reveal_response(self, data):
        """Handle opponent's response to reveal mode request"""
        try:
            validate_required_fields(data, ['gameId', 'accepted'])
            
            game_id = data.get('gameId', '').strip()
            accepted = data.get('accepted', False)

            if not await self._require_seat(game_id):
                return

            if game_id not in _pending_reveal_requests:
                await send_error(self, 'NO_PENDING_REQUEST', 'No pending reveal mode request')
                return
            
            request_info = _pending_reveal_requests[game_id]
            requester = request_info['requester']
            action = request_info['action']

            if self.username == requester:
                await send_error(self, 'INVALID_REQUEST', 'You cannot respond to your own reveal mode request')
                return

            if request_info.get('task'):
                request_info['task'].cancel()
            
            del _pending_reveal_requests[game_id]
            
            if accepted:
                await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                    'type': 'reveal_request_accepted',
                    'username': self.username,
                    'enabled': action == 'enable'
                })
                logger.info(f"Reveal mode {action} accepted in game {game_id}")
            else:
                await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                    'type': 'reveal_request_declined',
                    'username': self.username
                })
                logger.info(f"Reveal mode {action} declined in game {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_reveal_response: {e}")
            await send_error(self, 'INTERNAL_ERROR', 'Failed to handle reveal response')
    
    async def _handle_start_game(self, data):
        """Handle game start request: initialise and broadcast the game state."""
        try:
            validate_required_fields(data, ['gameId'])
            game_id = data.get('gameId', '').strip()
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            if self.username != game.host:
                await send_error(self, 'PERMISSION_DENIED', 'Only the host can start the game')
                return
            all_ready = await self._all_players_ready(game_id)
            if not all_ready:
                await send_error(self, 'NOT_ALL_READY', 'Not all players are ready')
                return

            # Reject a replayed start_game while a match is in progress.
            # Ready statuses persist after start, so without this a duplicate
            # message (double-click, retry, or crafted) would re-randomize
            # colours and wipe the live board. A *finished* GameState is fine -
            # that's the rematch flow.
            existing_state = await self._get_game_state(game_id)
            if existing_state and not existing_state.is_finished:
                await send_error(self, 'GAME_IN_PROGRESS', 'The game has already started')
                return

            # Load and validate the config BEFORE mutating any state, so a bad
            # saved custom config fails cleanly instead of leaving the room
            # half-started (players flipped to in-game with no GameState).
            raw_config = game.custom_config if game.game_mode == 'custom' and game.custom_config else None
            try:
                config = load_config(raw_config)
            except ValueError as e:
                await send_error(self, 'INVALID_CONFIG', f'Saved custom config is invalid: {e}')
                return
            requested_time = data.get('turnTimeLimit')
            selected_time = requested_time
            if selected_time is None:
                selected_time = (game.game_options or {}).get('turnTimeLimit')
            if selected_time is None:
                # 0 means unlimited and is the shipped default, so `or 60`
                # would arm a clock on every game that never asked for one.
                selected_time = config.get('rules', {}).get('turnTimeLimit', 60)
            # Somebody asked for this clock, rather than it coming from the
            # config the room already carries.
            chosen = requested_time is not None or (game.game_options or {}).get('turnTimeLimit') is not None
            if chosen:
                # One allow-list, in the validator that already owns it.
                try:
                    validate_game_options({'turnTimeLimit': selected_time})
                except ValidationError as e:
                    await send_error(self, e.code, e.message)
                    return
                config.setdefault('rules', {})['turnTimeLimit'] = selected_time
            elif not isinstance(selected_time, int) or isinstance(selected_time, bool) or selected_time < 0:
                await send_error(self, 'INVALID_CONFIG', 'rules.turnTimeLimit must be a non-negative integer')
                return
            board = build_initial_board(config)

            await self._update_player_status(game.host, 'in-game')
            await self._update_player_status(game.opponent, 'in-game')
            await self._send_user_list()
            await self._send_game_player_list(game_id, is_inviter=(self.username == game.host))

            # The host picks a side, or leaves it to the coin. Only the host
            # reaches here at all - the guard above rejects anyone else - so
            # this is the one seat anybody gets to choose. Anything but the
            # two colours means random, so an old client that sends nothing
            # gets what it always got.
            host_color = data.get('hostColor')
            if host_color == 'white':
                p_white, p_black = game.host, game.opponent
            elif host_color == 'black':
                p_white, p_black = game.opponent, game.host
            elif random.random() < 0.5:
                p_white, p_black = game.host, game.opponent
            else:
                p_white, p_black = game.opponent, game.host

            turn_started_dt = timezone.now()
            await self._create_game_state(
                game_id=game_id,
                board_state=board.to_dict(),
                current_turn=p_white,       # white always moves first
                player_white=p_white,
                player_black=p_black,
                config_snapshot=config,
                turn_started_at=turn_started_dt,
            )

            await self._update_game_status(game_id, 'started')

            await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                'type': 'game_started',
                'gameId': game_id,
                'boardState': board.to_dict(),
                'currentTurn': p_white,
                'turnNumber': 1,
                'playerWhite': p_white,
                'playerBlack': p_black,
                'config': config,
                'turnStartedAt': turn_started_dt.isoformat(),
                'phaseBank': {},
            })

            time_limit = config.get('rules', {}).get('turnTimeLimit', 0)
            if time_limit > 0:
                await self._start_turn_timer(game_id, time_limit, turn_number=1, current_turn=p_white)

            logger.info(f"Game {game_id} started immediately: {p_white} (white) vs {p_black} (black)")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_request_user_list(self, data):
        """Handle request for user list (for real-time sync)"""
        try:
            await self._send_user_list()
        except Exception as e:
            logger.error(f"Error sending user list: {e}")

    # ==================== Turn Timer ====================

    async def _start_turn_timer(self, game_id: str, time_limit: int, turn_number: int,
                                current_turn: str, idle_passes: int = 0):
        """Start (or restart) the turn timer for the given game.

        *idle_passes* counts how many turns in a row this clock has passed
        for nobody: it re-arms itself after each expiry, and with no turn limit
        configured a room left open would pass turns for the life of the
        process. A real move arms a fresh timer at zero.

        turn_number/current_turn fix the exact turn this timer is watching.
        If a move (or any other game-ending event) has already moved the
        game past that turn by the time the timer wakes up, the timer
        recognises itself as stale and does nothing - this prevents a
        timer armed for turn N from mistakenly declaring a winner using
        turn N+1's state after the real turn-N player already moved in time.
        """
        self._cancel_turn_timer(game_id)

        if time_limit <= 0:
            return  # no time limit configured

        async def _timer_task():
            try:
                await asyncio.sleep(time_limit)
                # Timer expiration is an automatic pass, not a game loss.
                state = await self._get_game_state(game_id)
                if not state or state.is_finished:
                    return
                if state.turn_number != turn_number or state.current_turn != current_turn:
                    logger.info(f"Stale turn timer for game {game_id} (armed for turn {turn_number}) ignored")
                    return

                mover = state.current_turn
                next_player = state.player_black if mover == state.player_white else state.player_white
                my_color = 'white' if mover == state.player_white else 'black'
                # A timeout is a pass, so it ends the game on the same terms
                # a deliberate pass does - otherwise two idle players run past
                # maxTurns forever and the draw never arrives. The same terms
                # include overtime's toll: a king on his last HP must not be
                # able to sit out the clock instead of paying it.
                settled = _settle_pass(state)
                turn_started_dt = timezone.now()
                applied = await self._update_game_state(
                    game_id=game_id,
                    board_state=settled.board_state,
                    current_turn=next_player if not settled.end_reason else state.current_turn,
                    turn_number=state.turn_number + 1,
                    move_history=list(state.move_history),
                    winner=settled.winner,
                    end_reason=settled.end_reason,
                    expected_turn_number=state.turn_number,
                    turn_started_at=turn_started_dt,
                    phase_bank=settled.phase_bank,
                )
                if not applied:
                    return
                await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                    'type': 'turn_passed',
                    'passedBy': mover,
                    'color': my_color,
                    'boardState': settled.board_state,
                    'currentTurn': next_player if not settled.end_reason else '',
                    'turnNumber': state.turn_number + 1,
                    'turnStartedAt': turn_started_dt.isoformat(),
                    'timedOut': True,
                    'phaseBank': settled.phase_bank,
                })
                if settled.end_reason:
                    await self._broadcast_game_over(game_id, settled.winner, settled.end_reason)
                    return
                # Only keep the clock running while somebody is still there to
                # watch it: an abandoned room would otherwise re-arm itself
                # every `time_limit` seconds for the life of the process.
                if not await self._any_player_connected([state.player_white, state.player_black]):
                    logger.info(f"Turn timer for game {game_id} stopped: nobody connected")
                    return
                # A tab left open still heartbeats, so "connected" is not
                # "playing". After this many passes with nobody moving, stop
                # writing a state row every time_limit seconds and wait for a
                # move to start the clock again.
                if idle_passes + 1 >= IDLE_PASS_LIMIT:
                    logger.info(f"Turn timer for game {game_id} stopped: "
                                f"{IDLE_PASS_LIMIT} turns passed with no move")
                    return
                await self._start_turn_timer(
                    game_id, time_limit, turn_number=state.turn_number + 1,
                    current_turn=next_player, idle_passes=idle_passes + 1,
                )
                logger.info(f"Turn timer expired in game {game_id}; turn passed")
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.error(f"Error in turn timer for game {game_id}: {e}", exc_info=True)
            finally:
                if _pending_turn_timers.get(game_id) is asyncio.current_task():
                    _pending_turn_timers.pop(game_id, None)

        task = asyncio.create_task(_timer_task())
        _pending_turn_timers[game_id] = task

    def _cancel_turn_timer(self, game_id: Optional[str]):
        """Cancel a running turn timer for the given game (if any).

        A timer's own expiry coroutine calls this (via _broadcast_game_over)
        to retire itself from the tracking dict - in that case the task is
        asyncio.current_task(), and cancelling it would throw CancelledError
        into its own in-flight broadcast. Only cancel a *different* task.
        """
        if game_id is None:
            return
        task = _pending_turn_timers.pop(game_id, None)
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()

    # ==================== Disconnect grace period ====================

    async def _start_disconnect_grace_timer(self, game_id: str, username: str):
        """Give a disconnected player DISCONNECT_GRACE_SECONDS to reconnect.

        If a match was underway it is forfeited to their opponent. If nothing
        was underway there is no game to win, so the room is simply closed and
        the remaining player told it has been abandoned - otherwise they sit
        there forever waiting for somebody who is never coming back.

        Cancelled by _handle_join_game_room if the player rejoins in time.
        """
        self._cancel_disconnect_timer(game_id, username)
        dropped_channel = self.channel_name

        async def _grace_task():
            try:
                await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
                # Cancelling is the usual way this timer stops, but it only
                # covers a rejoin that lands after the timer exists. A join
                # racing the arming above cancels nothing, and forfeits a
                # player who is back at the board. The row is the seat: back
                # in a room on a different socket is back.
                if await self._reclaimed_by_newer_socket(
                        username, dropped_channel, status='in-game'):
                    logger.info(
                        f"Grace timer for {username} in {game_id} stood down - reconnected")
                    return
                game = await self._get_game_by_id(game_id)
                if not game or game.status == 'closed':
                    return
                state = await self._get_game_state(game_id)

                if state and not state.is_finished:
                    winner = game.opponent if username == game.host else game.host
                    if await self._end_game(game_id, state, winner, 'disconnect'):
                        await self._broadcast_game_over(game_id, winner, 'disconnect', disconnectedPlayer=username)
                        await self._close_game_room(game_id, f"{username} did not reconnect within the grace period")
                        await self._send_user_list()
                        logger.info(f"Game {game_id} forfeited to {winner} - {username} did not reconnect in time")
                else:
                    await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
                        'type': 'room_abandoned',
                        'username': username,
                    })
                    await self._close_game_room(game_id, f"{username} did not reconnect within the grace period")
                    await self._send_user_list()
                    logger.info(f"Room {game_id} abandoned - {username} did not reconnect in time")
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.error(f"Error in disconnect grace timer for game {game_id}: {e}", exc_info=True)
            finally:
                _pending_disconnect_timers.pop((game_id, username), None)

        task = asyncio.create_task(_grace_task())
        _pending_disconnect_timers[(game_id, username)] = task

    def _cancel_disconnect_timer(self, game_id: Optional[str], username: Optional[str]):
        """Cancel a pending disconnect-grace timer (if any) - called when the
        player successfully reconnects."""
        if game_id is None or username is None:
            return
        task = _pending_disconnect_timers.pop((game_id, username), None)
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()

    # ==================== Game-over helpers ====================

    async def _end_game(self, game_id: str, state, winner: str, end_reason: str) -> bool:
        """Persist a game ending that leaves the board untouched (resign/timeout/draw).

        Conditional on the game still being at state.turn_number and
        unfinished (see _update_game_state) - if a concurrent move or
        another end-game path already advanced past that turn, this is a
        no-op. Returns True if this call's ending is the one that applied.
        """
        return await self._update_game_state(
            game_id=game_id,
            board_state=state.board_state,
            current_turn=state.current_turn,
            turn_number=state.turn_number,
            move_history=state.move_history,
            winner=winner,
            end_reason=end_reason,
            expected_turn_number=state.turn_number,
        )

    async def _end_game_with_retry(self, game_id: str, winner: str, end_reason: str,
                                    precondition=None) -> bool:
        """End a game, retrying once if a concurrent move advanced the turn
        between the caller's state read and the conditional write.

        Without this, a resign/draw-accept racing an opponent's move fails its
        OCC write (turn number changed) and would be misreported as "game
        already ended" while the game is in fact still running.

        precondition, if given, is re-checked against each fresh state read
        (e.g. "the draw offer is still pending"). Returns True if this call's
        ending applied; False if the game is finished or the precondition no
        longer holds.
        """
        for _ in range(2):
            state = await self._get_game_state(game_id)
            if not state or state.is_finished:
                return False
            if precondition is not None and not precondition(state):
                return False
            if await self._end_game(game_id, state, winner, end_reason):
                return True
        return False

    async def _broadcast_game_over(self, game_id: str, winner: str, end_reason: str, **extra):
        """Cancel the turn timer and notify both players that the game ended."""
        self._cancel_turn_timer(game_id)
        await broadcast_to_group(self.channel_layer, f'game_{game_id}', {
            'type': 'game_over',
            'winner': winner,
            'endReason': end_reason,
            **extra,
        })

    # ==================== Gameplay Handlers ====================

    async def _handle_make_move(self, data):
        """Handle a player submitting a move during an active game."""
        try:
            validate_required_fields(data, ['from', 'to'])

            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state:
                await send_error(self, 'GAME_NOT_STARTED', 'Game state not found')
                return
            if state.is_finished:
                await send_error(self, 'GAME_OVER', 'This game has already ended')
                return
            if state.current_turn != self.username:
                await send_error(self, 'NOT_YOUR_TURN', 'It is not your turn')
                return
            mover = state.current_turn

            from_coord = data['from']  # "q,r"
            to_coord = data['to']      # "q,r"

            config = state.config_snapshot
            radius = config.get('board', {}).get('radius', DEFAULT_CONFIG['board']['radius'])
            board = HexBoard.from_dict(radius, state.board_state)

            # Coordinates come straight off the wire - reject malformed input
            # as a client error, not an INTERNAL_ERROR with a traceback.
            try:
                fq, fr = parse_coord(from_coord)
                tq, tr = parse_coord(to_coord)
            except ValueError:
                await send_error(self, 'INVALID_MOVE', 'Malformed move coordinates')
                return

            piece = board.get(fq, fr)
            if not piece:
                await send_error(self, 'INVALID_MOVE', 'No piece at source coordinate')
                return

            my_color = 'white' if mover == state.player_white else 'black'
            if piece['color'] != my_color:
                await send_error(self, 'INVALID_MOVE', 'That piece is not yours')
                return

            # The setup turns' rules. The board enforced these in its click
            # handler and nowhere else - neither engine had a phase schedule to
            # know what the opening was - so a crafted message could attack on
            # the first turn. Checked before the walk home, because the board
            # locks a unit out before it offers it one.
            #
            # Two predicates, deliberately. **Nobody attacks** on any turn given
            # to setting out, the opening's three and each phase's postmatch;
            # **the one-move-per-phase lock** is the opening's alone, and
            # handing it to a single postmatch turn would stop a unit that had
            # moved in some earlier turn of a phase it has nothing to do with.
            if is_setup_turn(state.turn_number):
                if data.get('attack'):
                    await send_error(
                        self, 'INVALID_MOVE', no_attack_message(state.turn_number))
                    return
                # Moving onto an enemy is an attack too, by another road.
                landing = board.get(tq, tr)
                if landing and landing.get('color') != my_color:
                    await send_error(
                        self, 'INVALID_MOVE', no_attack_message(state.turn_number))
                    return
            if is_initialization(state.turn_number):
                if panels.coord_key(fq, fr) in opening_moved_hexes(
                        list(state.move_history), my_color):
                    await send_error(
                        self, 'INVALID_MOVE', 'That unit has had its move for the opening')
                    return

            # **How many board moves this side still has.** One everywhere the
            # schedule is running; two in Overtime 2 and three in Overtime 3
            # (`board_moves_per_turn`). Counted off the record rather than
            # inferred from "has the turn ended yet", because the moves arrive
            # as separate messages and only the last of them ends it.
            #
            # Checked here for every board move, the walk home included: with
            # an allowance above one, a client that sets `more` on all of them
            # could otherwise play the whole game inside one hand-over.
            moves_allowed = board_moves_per_turn(state.turn_number)
            moves_used = board_moves_at(
                list(state.move_history), state.turn_number, my_color)
            if moves_used >= moves_allowed:
                await send_error(
                    self, 'INVALID_MOVE',
                    f'That side has had all {moves_allowed} of its moves this turn')
                return
            # `more` is the client saying "this is not my last": hold the seat
            # and let the next message in. Honoured only while a move is still
            # to come after this one - a `more` on the last of the allowance
            # ends the turn anyway, since there is nothing it could be holding
            # the seat open for.
            holding = bool(data.get('more')) and moves_used + 1 < moves_allowed
            # **The allowance counts moves; the owner's rule counts units.**
            # A side with three moves could otherwise play A, then B, then A
            # again - each message legal on its own, judged from where the unit
            # stands with a full MOV, so the unit covered twice its budget in
            # one turn. A unit continuing a walk it began arrives as ONE
            # message carrying the origin it really set out from, so a `from`
            # that matches an earlier landing is always a second go.
            if panels.coord_key(fq, fr) in board_move_landings(
                    list(state.move_history), state.turn_number, my_color):
                await send_error(
                    self, 'INVALID_MOVE', 'That unit has already moved this turn')
                return

            # Walking off the board into your own base. It ends the turn like
            # any other move, but its destination is a panel hex the board
            # cannot hold, so it is checked against the panels rather than the
            # legal-move flood - and against the real doorways and the walk to
            # them, not the browser engine's rule of "any off-board hex whose q
            # has the right sign", which would let a unit land in the wrong
            # panel, or come home from anywhere on the board for free.
            if data.get('withdraw'):
                if data.get('attack'):
                    await send_error(
                        self, 'INVALID_MOVE', 'A unit cannot strike and walk home in one turn')
                    return
                # Said by name: `homecoming_targets` offers him nowhere, and
                # "cannot walk home there" would send the player looking for
                # a doorway that works.
                if config.get('units', {}).get(piece['unit_id'], {}).get('commander'):
                    await send_error(self, 'INVALID_MOVE', 'The king never walks home')
                    return
                # The window, then the allowance. A phase's play shuts the base
                # doorways entirely; a setup turn opens them for three units,
                # and overtime opens them with no count at all - a walk home
                # there is an ordinary move that happens to end off the board,
                # and the turn's own move allowance is the only cap it needs.
                if not is_homecoming_open(state.turn_number):
                    await send_error(self, 'INVALID_MOVE', 'The way home is shut')
                    return
                if is_setup_turn(state.turn_number):
                    gone = panels.homecomings_at(
                        list(state.move_history), state.turn_number, my_color)
                    if piece.get('uid') not in gone and len(gone) >= rule_of(
                            config, 'homecomingsPerSetupTurn'):
                        await send_error(
                            self, 'INVALID_MOVE', 'That is all who may walk home this turn')
                        return
                # Said by name, before the generic refusal below can swallow
                # it. `homecoming_targets` returns nothing at all for a unit
                # standing too far up the board, and "cannot walk home there"
                # would send the player looking for a doorway that works when
                # the trouble is where the unit is standing. The same words the
                # browser engine uses, so the two engines cannot disagree.
                if not panels.in_home_rows(my_color, fr, radius):
                    await send_error(
                        self, 'INVALID_MOVE', 'Only your own first three rows walk home')
                    return
                from_key = panels.coord_key(fq, fr)
                to_key = panels.coord_key(tq, tr)
                orientation = config.get('board', {}).get('orientation', 'edge-up')
                occupancy = panels.panel_occupancy(
                    config, radius, list(state.move_history), orientation)
                home = panels.homecoming_targets(
                    config, radius, occupancy, board.to_dict(), from_key, orientation)
                if to_key not in home:
                    await send_error(self, 'INVALID_MOVE', 'That unit cannot walk home there')
                    return

                leaving = board.remove(fq, fr)
                move_record = {
                    'from': from_key,
                    'to': to_key,
                    'unit_id': leaving['unit_id'],
                    'color': leaving['color'],
                    'turn': state.turn_number,
                    'captured': None,
                    'attacked': False,
                    'damage_dealt': 0,
                    'defender_eliminated': False,
                    'moved': True,
                    # The unit as it stood when it left, HP and uid and all:
                    # once it is off the board this record is the only place it
                    # survives, and what the base is rebuilt from on a reload.
                    'withdrawn': True,
                    'unit': dict(leaving),
                }
                # **On a setup turn a walk home is deployment, not the turn's
                # board action**, for the same reason a crossing is: three may
                # go in one turn, and committing the turn on the first would
                # hand the seat over with the other two unreachable - the
                # allowance checked above would be a count that never counted.
                # Overtime keeps it as the turn's action, which is what the
                # window there is for: the toll is running and the turn's own
                # move allowance is the only cap a walk home needs.
                #
                # `holding` covers the other way a walk home is not the turn's
                # last act: in Overtime 2 a side may walk one home and still
                # move another unit, and the first message must not hand over.
                if is_setup_turn(state.turn_number) or holding:
                    if not await self._commit_deployment(
                            state, board.to_dict(), move_record, 'walk home'):
                        return
                else:
                    next_player = (state.player_black if mover == state.player_white
                                   else state.player_white)
                    if not await self._commit_turn(
                            state, board, move_record, config, next_player):
                        return
                logger.info(
                    f"Withdrawal in game {self.game_id}: {from_key}->{to_key} by {self.username}")
                return

            # A turn is "walk, then optionally swing": `to` is where the unit
            # ends up (possibly where it already stands) and `attack` names a
            # hex it strikes from there.
            attack_coord = data.get('attack')
            # A message may also carry moveBonus/bonuses - one-turn ability
            # boosts. They are ignored here: abilities live on the client, so
            # honouring them would hand a free stat upgrade to anyone willing
            # to edit a message. The browser engine that runs solo play takes
            # them, having nobody to cheat.
            if (tq, tr) != (fq, fr):
                legal_dests = get_legal_moves_filtered(
                    board, (fq, fr), config, my_color)
                if (tq, tr) not in legal_dests:
                    await send_error(self, 'INVALID_MOVE', 'Illegal move for this piece')
                    return
            elif not attack_coord:
                await send_error(self, 'INVALID_MOVE', 'A move must change hexes')
                return

            if attack_coord:
                try:
                    aq, ar = parse_coord(attack_coord)
                except ValueError:
                    await send_error(self, 'INVALID_MOVE', 'Malformed attack coordinate')
                    return
                target = board.get(aq, ar)
                if not target or target['color'] == my_color:
                    await send_error(self, 'INVALID_MOVE', 'No enemy unit on the attacked hex')
                    return
                unit_range = config.get('units', {}).get(piece['unit_id'], {}).get('attackRange', 1)
                if hex_distance((tq, tr), (aq, ar)) > unit_range:
                    await send_error(self, 'INVALID_MOVE', 'That hex is out of attack range')
                    return
                if (tq, tr) != (fq, fr):
                    board.move(fq, fr, tq, tr)
                combat = resolve_combat(board, (tq, tr), (aq, ar), config)
                combat['moved'] = (tq, tr) != (fq, fr)
            else:
                combat = resolve_combat(board, (fq, fr), (tq, tr), config)

            next_player = state.player_black if mover == state.player_white else state.player_white
            next_color = 'black' if my_color == 'white' else 'white'

            move_record: dict = {
                'from': from_coord,
                'to': to_coord,
                'unit_id': piece['unit_id'],
                'color': my_color,
                'turn': state.turn_number,
                'captured': combat['captured_unit']['unit_id'] if combat['captured_unit'] else None,
                'attacked': combat['attacked'],
                'damage_dealt': combat['damage_dealt'],
                'defender_eliminated': combat['defender_eliminated'],
                'moved': combat['moved'],
            }
            if attack_coord:
                move_record['attackedHex'] = attack_coord
                move_record['counter_damage'] = combat.get('counter_damage', 0)
                move_record['attacker_eliminated'] = combat.get('attacker_eliminated', False)
            if combat['defender_hp'] is not None:
                move_record['defender_hp'] = combat['defender_hp']

            # Not the turn's last move: the same seat, the same ply, the same
            # clock, and the next message plays the next unit. The turn ends on
            # whichever move comes without `more` - or on the last one the
            # allowance permits, whatever it claims.
            if holding:
                if not await self._commit_deployment(
                        state, board.to_dict(), move_record, 'move'):
                    return
            elif not await self._commit_turn(
                    state, board, move_record, config, next_player):
                return

            logger.info(f"Move in game {self.game_id}: {from_coord}->{to_coord} by {self.username}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_make_move: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process move')

    async def _commit_turn(self, state, board, move_record, config, next_player) -> bool:
        """
        End the mover's turn: *move_record* has been applied to *board*.

        Shared by every message that is the turn's board action - a move, a
        blow into a panel - so there is one place that decides who has lost,
        one turn limit, one optimistic write and one hand-over. They were
        written out in full inside `_handle_make_move`, and a second copy for
        the panel blow is exactly the drift this repo keeps paying for.

        Returns False, having told the client, if a concurrent write won - a
        turn timer that ended the game while this move was in flight.
        """
        new_history = list(state.move_history) + [move_record]

        # Overtime's toll, as the last thing the turn does to the board: after
        # the walk, the blow and the counter, before anyone is judged beaten -
        # so a king the toll kills loses the match in the message that killed
        # him. Only the side that just played pays.
        mover_color = 'white' if state.current_turn == state.player_white else 'black'
        overtime_toll(board, config, mover_color, state.turn_number)

        # Who lost is a property of the board, not of who moved: a
        # counter-attack can kill the attacker's commander on their own turn.
        # The board, the schedule and the turn limit, in that order - see
        # _settle_hand_over.
        settled = _settle_hand_over(state, board, new_history, defeated_sides(board, config))
        board_state, bank = settled.board_state, settled.phase_bank
        winner, end_reason = settled.winner, settled.end_reason

        # Persist updated state - conditional on the game still being at
        # state.turn_number and unfinished, so a turn timer that already
        # ended the game while this move was in flight can't be clobbered.
        next_turn_number = state.turn_number + 1
        turn_started_dt = timezone.now()
        applied = await self._update_game_state(
            game_id=self.game_id,
            board_state=board_state,
            current_turn=next_player if not end_reason else state.current_turn,
            turn_number=next_turn_number,
            move_history=new_history,
            winner=winner,
            end_reason=end_reason,
            expected_turn_number=state.turn_number,
            turn_started_at=turn_started_dt,
            phase_bank=bank,
        )
        if not applied:
            await send_error(self, 'GAME_OVER', 'This game already ended before your move was processed')
            return False

        await broadcast_to_group(self.channel_layer, self.room_group_name, {
            'type': 'move_made',
            'move': move_record,
            'boardState': board_state,
            'currentTurn': next_player if not end_reason else '',
            'turnNumber': next_turn_number,
            'turnStartedAt': turn_started_dt.isoformat(),
            'phaseBank': bank,
        })

        if end_reason:
            await self._broadcast_game_over(self.game_id, winner, end_reason)
        else:
            time_limit = config.get('rules', {}).get('turnTimeLimit', 0)
            if time_limit > 0:
                await self._start_turn_timer(
                    self.game_id, time_limit,
                    turn_number=next_turn_number, current_turn=next_player,
                )
        return True

    async def _handle_panel_attack(self, data):
        """
        A board unit walks, optionally, and strikes a unit standing in a panel.

        Unlike a crossing this IS the turn's board action - there is no
        `make_move` behind it to carry the walk - so it ends the turn.

        The client sends `unit`, `panel` and `counters` because the browser
        engine needs all three. None of them is read here: the defender, the
        panel it stands in, and whether that panel answers are derived by
        `resolve_panel_attack` from the config and the move history. A
        `counters: false` off the wire is precisely how a client would turn off
        the counter-attack against its own blows, and the browser engine would
        let it.
        """
        try:
            validate_required_fields(data, ['from', 'attack'])

            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state:
                await send_error(self, 'GAME_NOT_STARTED', 'Game state not found')
                return
            if state.is_finished:
                await send_error(self, 'GAME_OVER', 'This game has already ended')
                return
            if state.current_turn != self.username:
                await send_error(self, 'NOT_YOUR_TURN', 'It is not your turn')
                return

            mover = state.current_turn
            my_color = 'white' if mover == state.player_white else 'black'
            from_key = str(data['from'])
            # A standing strike names no walk; the browser engine defaults `to`
            # to `from` in the same way.
            to_key = str(data.get('to') or data['from'])
            attack_key = str(data['attack'])

            config = state.config_snapshot
            board_cfg = config.get('board', {})
            radius = board_cfg.get('radius', DEFAULT_CONFIG['board']['radius'])
            orientation = board_cfg.get('orientation', 'edge-up')
            board = HexBoard.from_dict(radius, state.board_state)

            # A blow into a panel is still a blow, and nobody strikes on a turn
            # given to setting out. The board never offered one there; nothing
            # stopped a message from asking.
            if is_setup_turn(state.turn_number):
                await send_error(
                    self, 'INVALID_MOVE', no_attack_message(state.turn_number))
                return

            outcome = resolve_panel_attack(
                board, config, list(state.move_history),
                from_key, to_key, attack_key, my_color, state.turn_number, orientation)
            if 'error' in outcome:
                await send_error(self, 'INVALID_MOVE', outcome['error'])
                return

            next_player = state.player_black if mover == state.player_white else state.player_white
            if not await self._commit_turn(state, board, outcome['record'], config, next_player):
                return

            logger.info(
                f"Panel blow in game {self.game_id}: {from_key}->{to_key} x {attack_key} "
                f"by {self.username} (answered={outcome['counters']})")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_panel_attack: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process panel attack')

    async def _handle_enter_board(self, data):
        """
        Step a reserve unit through the gap onto the battlefield.

        **A crossing is not the turn's board action.** Several may come through
        in one turn, each as its own message, before whatever the turn does on
        the board - so this hands nothing over: no ply bump, no change of turn,
        no turn timer restart. It puts the unit on the board and writes the
        record, and that is all. The browser engine answers the same message
        with a full state snapshot for the same reason, and the client is built
        around that.

        **Nothing about the unit is taken from the wire.** The client sends one,
        because the browser engine needs it, but the panels are derivable from
        the config and the move history (`engine/panels.py`) and the server
        derives them instead. That is the whole difference between this handler
        and the browser engine, which says of this very message that it takes
        the unit, the hex and the HP on trust because it "has nobody to cheat".
        A server does.
        """
        try:
            validate_required_fields(data, ['from', 'to'])

            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state:
                await send_error(self, 'GAME_NOT_STARTED', 'Game state not found')
                return
            if state.is_finished:
                await send_error(self, 'GAME_OVER', 'This game has already ended')
                return
            if state.current_turn != self.username:
                await send_error(self, 'NOT_YOUR_TURN', 'It is not your turn')
                return

            from_key = str(data['from'])
            to_key = str(data['to'])
            config = state.config_snapshot
            board_cfg = config.get('board', {})
            radius = board_cfg.get('radius', DEFAULT_CONFIG['board']['radius'])
            orientation = board_cfg.get('orientation', 'edge-up')
            my_color = 'white' if self.username == state.player_white else 'black'

            history = list(state.move_history)
            occupancy = panels.panel_occupancy(
                config, radius, history, orientation, ply=state.turn_number)
            unit = occupancy.get(from_key)
            if not unit:
                await send_error(self, 'INVALID_MOVE', 'Nothing is standing there')
                return
            if unit.get('color') != my_color:
                await send_error(self, 'INVALID_MOVE', 'That unit is not yours')
                return

            # The reserve's three arrows are shut through a phase's played half
            # and through overtime. Checked before the unit's own allowance, so
            # a shut window is never reported as a spent one.
            if not is_entry_open(state.turn_number):
                await send_error(self, 'INVALID_MOVE', 'The way in is shut')
                return

            # A crossing is a reserve unit's move, so it is held to the same
            # allowance as a walk inside the panel: not locked out of the
            # opening, one of at most three reserve movers this turn - five in a
            # postmatch - and only on what it has not already walked.
            # Without this a unit shuffled to the gateway first crossed on a
            # full MOV it had half spent.
            allowance = panels.panel_allowance(config, history, unit, state.turn_number)
            if allowance is None:
                await send_error(self, 'INVALID_MOVE', 'That unit cannot move again this turn')
                return

            board_state = dict(state.board_state)
            targets = panels.entry_targets(
                config, radius, occupancy, board_state, from_key, orientation,
                moves_left=allowance)
            if to_key not in targets:
                await send_error(self, 'INVALID_MOVE', 'Nothing may enter there')
                return

            # The unit the SERVER derived, not the one the wire offered.
            entering = {
                'unit_id': unit['unit_id'],
                'color': unit['color'],
                'hp': unit['hp'],
                'max_hp': unit['max_hp'],
                'uid': unit['uid'],
            }
            board = HexBoard.from_dict(radius, board_state)
            eq, er = panels.parse_key(to_key)
            board.set_cell(eq, er, entering)

            move_record = {
                'from': from_key,
                'to': to_key,
                'unit_id': entering['unit_id'],
                'color': entering['color'],
                'turn': state.turn_number,
                'captured': None,
                'attacked': False,
                'damage_dealt': 0,
                'defender_eliminated': False,
                'moved': True,
                # What the client's panel derivations read, and the reason the
                # record has to survive verbatim: `entered` takes the unit out
                # of its panel for good, and `unit` carries the uid saying
                # which one. Drop either and the panel re-deals it at home,
                # alive and ready to cross again.
                'entered': True,
                'unit': entering,
            }
            if not await self._commit_deployment(state, board.to_dict(), move_record, 'crossing'):
                return
            logger.info(
                f"Crossing in game {self.game_id}: {from_key}->{to_key} by {self.username}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_enter_board: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process crossing')

    async def _commit_deployment(self, state, board_state, move_record, what) -> bool:
        """
        Record a panel unit's move that is NOT the turn's board action - a
        crossing out of a reserve, or a walk inside a panel - and tell the room.

        **Deployment hands nothing over**: the same seat, the same ply, the same
        clock. Several may come through in one turn, each as its own message,
        before whatever the turn does on the board. Answered with a full
        snapshot, the way the browser engine answers them - `move_made` would
        hand the room a turn that has not happened.

        Shared by both, for the same reason `_commit_turn` is shared by every
        turn-ending action: two copies of one rule drift. Returns False, having
        told the client, if a concurrent write won.
        """
        new_history = list(state.move_history) + [move_record]
        applied = await self._update_game_state(
            game_id=self.game_id,
            board_state=board_state,
            current_turn=state.current_turn,
            turn_number=state.turn_number,
            move_history=new_history,
            winner=state.winner,
            end_reason=state.end_reason,
            expected_turn_number=state.turn_number,
            turn_started_at=state.turn_started_at,
        )
        if not applied:
            await send_error(
                self, 'GAME_OVER', f'This game already ended before your {what} was processed')
            return False

        await broadcast_to_group(self.channel_layer, self.room_group_name, {
            'type': 'game_state_update',
            'gameId': self.game_id,
            'boardState': board_state,
            'currentTurn': state.current_turn,
            'turnNumber': state.turn_number,
            'moveHistory': new_history,
            'playerWhite': state.player_white,
            'playerBlack': state.player_black,
            'winner': state.winner,
            'endReason': state.end_reason,
            'config': state.config_snapshot,
            'turnStartedAt': (state.turn_started_at or timezone.now()).isoformat(),
            'drawOfferedBy': '',
            'phaseBank': state.phase_bank or {},
        })
        return True

    async def _handle_panel_move(self, data):
        """
        Walk a unit inside its own panel - or, from a base, over the wrap into
        its reserve.

        This never reached any engine. The board moved the unit in its own memory
        and sent nothing, so the server's idea of where a panel unit stood was
        wrong from the first shuffle, and a crossing made from the unit's new hex
        was refused as "nothing is standing there". Recorded now, and replayed
        in order by `panel_occupancy`, so the server and both screens agree -
        and so the position survives a reload, where it used to be re-dealt.

        Like a crossing it is deployment, not the turn's action. The walk's MOV
        and the wrap's price are derived here, not read off the message: the
        server works out what the walk cost from where the unit really stands,
        and what the side really has to spend from the history.
        """
        try:
            validate_required_fields(data, ['from', 'to'])

            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state:
                await send_error(self, 'GAME_NOT_STARTED', 'Game state not found')
                return
            if state.is_finished:
                await send_error(self, 'GAME_OVER', 'This game has already ended')
                return
            if state.current_turn != self.username:
                await send_error(self, 'NOT_YOUR_TURN', 'It is not your turn')
                return

            from_key = str(data['from'])
            to_key = str(data['to'])
            config = state.config_snapshot
            board_cfg = config.get('board', {})
            radius = board_cfg.get('radius', DEFAULT_CONFIG['board']['radius'])
            orientation = board_cfg.get('orientation', 'edge-up')
            my_color = 'white' if self.username == state.player_white else 'black'
            ply = state.turn_number
            history = list(state.move_history)

            occupancy = panels.panel_occupancy(config, radius, history, orientation, ply=ply)
            unit = occupancy.get(from_key)
            if not unit:
                await send_error(self, 'INVALID_MOVE', 'Nothing is standing there')
                return
            if unit.get('color') != my_color:
                await send_error(self, 'INVALID_MOVE', 'That unit is not yours')
                return

            points = economy.points_of(my_color, ply, history, config, state.phase_bank)
            targets = panels.panel_move_targets(
                config, radius, history, dict(state.board_state), from_key, ply, points,
                orientation)
            step = targets.get(to_key)
            if not step:
                await send_error(self, 'INVALID_MOVE', 'That unit cannot walk there')
                return

            move_record = {
                'from': from_key,
                'to': to_key,
                'unit_id': unit['unit_id'],
                'color': unit['color'],
                'turn': ply,
                'captured': None,
                'attacked': False,
                'damage_dealt': 0,
                'defender_eliminated': False,
                'moved': True,
                # What the panels are replayed from. `panel` is where the walk
                # BEGAN, which is what decides whose mover it spends - the wrap
                # starts in the base. `cost` is what the next step this turn has
                # left to spend; `price` is what the side paid for the wrap.
                'panelMove': True,
                'panel': unit.get('panel'),
                'cost': step['cost'],
                'price': step['price'],
                'unit': {
                    'unit_id': unit['unit_id'],
                    'color': unit['color'],
                    'hp': unit.get('hp'),
                    'max_hp': unit.get('max_hp'),
                    'uid': unit.get('uid'),
                },
            }
            # Nothing on the board moves: both ends are panel hexes.
            if not await self._commit_deployment(
                    state, dict(state.board_state), move_record, 'panel move'):
                return
            logger.info(
                f"Panel move in game {self.game_id}: {from_key}->{to_key} by {self.username}"
                f" (cost={step['cost']}, price={step['price']})")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_panel_move: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process panel move')

    async def _handle_pass_turn(self, data):
        """Hand the turn over without moving anything - a unit turn is optional."""
        try:
            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state:
                await send_error(self, 'GAME_NOT_STARTED', 'Game state not found')
                return
            if state.is_finished:
                await send_error(self, 'GAME_OVER', 'This game has already ended')
                return

            if state.current_turn != self.username:
                await send_error(self, 'NOT_YOUR_TURN', 'It is not your turn')
                return

            mover = state.current_turn
            my_color = 'white' if mover == state.player_white else 'black'
            next_player = state.player_black if mover == state.player_white else state.player_white

            config = state.config_snapshot
            # The toll, the phase bank, and whether either ended the match -
            # see _settle_pass.
            settled = _settle_pass(state)
            board_state, bank = settled.board_state, settled.phase_bank
            winner, end_reason = settled.winner, settled.end_reason

            next_turn_number = state.turn_number + 1
            turn_started_dt = timezone.now()
            applied = await self._update_game_state(
                game_id=self.game_id,
                board_state=board_state,
                current_turn=next_player if not end_reason else state.current_turn,
                turn_number=next_turn_number,
                move_history=list(state.move_history),
                winner=winner,
                end_reason=end_reason,
                expected_turn_number=state.turn_number,
                turn_started_at=turn_started_dt,
                phase_bank=bank,
            )
            if not applied:
                await send_error(self, 'GAME_OVER', 'This game already ended before your pass was processed')
                return

            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'turn_passed',
                'passedBy': mover,
                'color': my_color,
                # The board the toll left. `applyTurnPassed` already takes one;
                # its own comment said "the networked server sends none".
                'boardState': board_state,
                'currentTurn': next_player if not end_reason else '',
                'turnNumber': next_turn_number,
                'turnStartedAt': turn_started_dt.isoformat(),
                'phaseBank': bank,
            })

            if end_reason:
                await self._broadcast_game_over(self.game_id, winner, end_reason)
            else:
                time_limit = config.get('rules', {}).get('turnTimeLimit', 0)
                if time_limit > 0:
                    await self._start_turn_timer(
                        self.game_id, time_limit,
                        turn_number=next_turn_number, current_turn=next_player,
                    )

            logger.info(f"Turn passed in game {self.game_id} by {mover}")
        except Exception as e:
            logger.error(f"Error in _handle_pass_turn: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to pass the turn')

    async def _handle_resign(self, data):
        """Handle a player resigning from an active game."""
        try:
            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state or state.is_finished:
                await send_error(self, 'GAME_OVER', 'Game is not active')
                return

            winner = state.player_black if self.username == state.player_white else state.player_white

            if await self._end_game_with_retry(self.game_id, winner, 'resign'):
                await self._broadcast_game_over(self.game_id, winner, 'resign', resignedBy=self.username)
                logger.info(f"Player {self.username} resigned in game {self.game_id}")
            else:
                await send_error(self, 'GAME_OVER', 'This game has already ended')
        except Exception as e:
            logger.error(f"Error in _handle_resign: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process resignation')

    async def _handle_offer_draw(self, data):
        """Handle a draw offer from one player."""
        try:
            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state or state.is_finished:
                await send_error(self, 'GAME_OVER', 'Game is not active')
                return

            if state.draw_offered_by:
                await send_error(self, 'DRAW_ALREADY_OFFERED', 'A draw offer is already pending')
                return

            await self._set_draw_offer(self.game_id, self.username)

            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'draw_offered',
                'offeredBy': self.username,
            })

            logger.info(f"Player {self.username} offered a draw in game {self.game_id}")
        except Exception as e:
            logger.error(f"Error in _handle_offer_draw: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to offer draw')

    async def _handle_respond_draw(self, data):
        """Handle acceptance or rejection of a draw offer."""
        try:
            validate_required_fields(data, ['accept'])

            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state or state.is_finished:
                await send_error(self, 'GAME_OVER', 'Game is not active')
                return

            if not state.draw_offered_by:
                await send_error(self, 'NO_DRAW_OFFER', 'There is no pending draw offer')
                return

            if state.draw_offered_by == self.username:
                await send_error(self, 'INVALID_REQUEST', 'You cannot respond to your own draw offer')
                return

            accepted = bool(data['accept'])

            if accepted:
                # Retry guards against racing an opponent's move; the
                # precondition ensures the offer wasn't invalidated by that
                # same move (every state write clears draw_offered_by).
                offer_still_pending = lambda s: s.draw_offered_by and s.draw_offered_by != self.username
                if await self._end_game_with_retry(self.game_id, '', 'draw_agreed',
                                                    precondition=offer_still_pending):
                    await self._broadcast_game_over(self.game_id, '', 'draw_agreed')
                    logger.info(f"Draw agreed in game {self.game_id}")
                else:
                    await send_error(self, 'NO_DRAW_OFFER', 'The draw offer is no longer valid')
            else:
                await self._set_draw_offer(self.game_id, '')  # clear the offer
                await broadcast_to_group(self.channel_layer, self.room_group_name, {
                    'type': 'draw_response',
                    'accepted': False,
                    'declinedBy': self.username,
                })
                logger.info(f"Draw declined by {self.username} in game {self.game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_respond_draw: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process draw response')

    async def _handle_request_game_state(self, data):
        """Send the full current game state to the requesting player."""
        try:
            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME', 'You are not in an active game')
                return

            state = await self._get_game_state(self.game_id)
            if not state:
                await send_error(self, 'GAME_NOT_STARTED', 'Game state not found')
                return

            await send_json_response(self, {
                'type': 'game_state_update',
                'gameId': self.game_id,
                'boardState': state.board_state,
                'currentTurn': state.current_turn,
                'turnNumber': state.turn_number,
                'moveHistory': state.move_history,
                'playerWhite': state.player_white,
                'playerBlack': state.player_black,
                'winner': state.winner,
                'endReason': state.end_reason,
                'config': state.config_snapshot,
                'turnStartedAt': (state.turn_started_at or timezone.now()).isoformat(),
                'drawOfferedBy': state.draw_offered_by or '',
                'phaseBank': state.phase_bank or {},
            })
        except Exception as e:
            logger.error(f"Error in _handle_request_game_state: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to retrieve game state')

    async def _handle_heartbeat(self, data):
        """Handle client heartbeat/presence ping"""
        try:
            if self.username:
                await self._update_player_activity(self.username)
                structured_log('debug', 'heartbeat_received', username=self.username)

            # A socket sitting in a room is a seat in use. The token was only
            # refreshed on join, so a match played for ten minutes without a
            # reload answered TOKEN_EXPIRED to the first rejoin after a dropped
            # connection - and the grace timer forfeited it.
            if self.game_id:
                await self._keep_game_token_alive(self.game_id)

            await send_json_response(self, {
                'type': 'heartbeat_ack',
                'timestamp': timezone.now().isoformat()
            })
        except Exception as e:
            logger.warning(f"Error handling heartbeat: {e}")
    
    # ==================== Database Operations ====================
    
    @database_sync_to_async
    def _get_player_connection(self, username):
        """Get a player connection by username"""
        try:
            return PlayerConnection.objects.get(username=username)  # type: ignore
        except PlayerConnection.DoesNotExist:  # type: ignore
            return None

    @database_sync_to_async
    def _get_player_connections_batch(self, usernames):
        """Get multiple player connections in a single query (batch optimization)"""
        connections = PlayerConnection.objects.filter(username__in=usernames)  # type: ignore
        return {conn.username: conn for conn in connections}

    @database_sync_to_async
    def _update_player_activity(self, username):
        """Update the last_activity timestamp for a player connection"""
        PlayerConnection.objects.filter(username=username).update(last_activity=timezone.now())  # type: ignore
    
    @database_sync_to_async
    def _create_or_update_player_connection(self, username, channel_name, status, secret=None):
        """Create or update a player connection"""
        defaults = {
            'channel_name': channel_name,
            'status': status,
            'last_activity': timezone.now()
        }
        if secret is not None:
            defaults['secret'] = secret
        connection, _ = PlayerConnection.objects.update_or_create(  # type: ignore
            username=username,
            defaults=defaults
        )
        return connection
    
    @database_sync_to_async
    def _claim_player_connection(self, username, channel_name, secret, takeover=False):
        """Take `username` for this channel. True if it is ours afterwards.

        One statement, so there is no window to race: the check-then-write
        this replaces let two clients that both saw the name free both write
        it, and `update_or_create` on the primary key then handed the second
        the first's row - channel name and identity secret with it.

        `takeover` is the rejoin path, where the caller has already matched
        the stored secret and replacing the row is the whole point.
        """
        fields = {
            'channel_name': channel_name,
            'status': 'online',
            'secret': secret,
            'last_activity': timezone.now(),
        }
        if takeover:
            PlayerConnection.objects.update_or_create(  # type: ignore
                username=username, defaults=fields)
            return True
        connection, created = PlayerConnection.objects.get_or_create(  # type: ignore
            username=username, defaults=fields)
        if not created and connection.channel_name == channel_name:
            # The same socket saying hello twice. Already ours; refresh it.
            PlayerConnection.objects.filter(username=username).update(**fields)  # type: ignore
            return True
        return created

    @database_sync_to_async
    def _update_player_status(self, username, status):
        """Update a player's status"""
        rows_updated = PlayerConnection.objects.filter(username=username).update(  # type: ignore
            status=status,
            last_activity=timezone.now()
        )
        logger.debug(f"[_update_player_status] Updated {username} to '{status}' (rows affected: {rows_updated})")
        return rows_updated
    
    @database_sync_to_async
    def _delete_player_connection(self, username, channel_name=None):
        """Delete a player connection. If channel_name is given, only delete
        when the stored row still belongs to that channel - guards a
        late-firing disconnect() from deleting a row a newer, legitimately
        reconnected session has since claimed."""
        qs = PlayerConnection.objects.filter(username=username)  # type: ignore
        if channel_name is not None:
            qs = qs.filter(channel_name=channel_name)
        qs.delete()
    
    @database_sync_to_async
    def _reclaimed_by_newer_socket(self, username, channel_name, status=None):
        """True when this username's row belongs to some *other* channel now.

        The row is the seat - _handle_join_lobby and _handle_join_game_room
        both write their own channel name into it - so a disconnect whose
        channel no longer matches is a socket the player has already
        replaced, arriving late.

        `status` narrows which kind of replacement counts. 'in-game' asks
        specifically whether they are back at a board, because turning up in
        the lobby instead is not a reason to spare their opponent a forfeit.
        """
        rows = PlayerConnection.objects.filter(  # type: ignore
            username=username).exclude(channel_name=channel_name)
        if status is not None:
            rows = rows.filter(status=status)
        return rows.exists()

    @database_sync_to_async
    def _any_player_connected(self, usernames):
        """True while at least one of *usernames* is still heartbeating.

        A row outlives an unclean drop - it is only swept when some other
        request happens to call _get_all_online_users - so a row on its own
        proves nothing. The heartbeat behind it is what does, on the same
        threshold that sweep uses.
        """
        fresh = timezone.now() - STALE_AFTER
        return PlayerConnection.objects.filter(  # type: ignore
            username__in=[u for u in usernames if u],
            last_activity__gte=fresh,
        ).exists()

    @database_sync_to_async
    def _get_all_online_users(self):
        """Get all currently online users, deleting stale connections first"""
        stale_threshold = timezone.now() - STALE_AFTER
        stale_count, _ = PlayerConnection.objects.filter(last_activity__lt=stale_threshold).delete()  # type: ignore
        if stale_count > 0:
            logger.info(f"[_get_all_online_users] Cleaned up {stale_count} stale connections")

        return list(PlayerConnection.objects.filter(  # type: ignore
            status__in=['online', 'invited', 'configuring', 'in-game']
        ).values('username', 'status'))
    
    @database_sync_to_async
    def _get_challenge(self, challenger, responder):
        """Get a challenge between two users"""
        try:
            return GameChallenge.objects.get(challenger=challenger, responder=responder)  # type: ignore
        except GameChallenge.DoesNotExist:  # type: ignore
            return None
    
    @database_sync_to_async
    def _expire_stale_challenges(self):
        """Async wrapper for the shared sweep - see utils.expire_stale_challenges.

        The 30 seconds in get_challenge_expiration_time is the backstop for a
        responder who is no longer there to run the client's own countdown.
        """
        return expire_stale_challenges()

    @database_sync_to_async
    def _create_challenge(self, challenger, responder):
        """Create a new game challenge"""
        challenge = GameChallenge.objects.create(  # type: ignore
            challenger=challenger,
            responder=responder,
            expires_at=get_challenge_expiration_time(),
            status='pending'
        )
        return challenge
    
    @database_sync_to_async
    def _delete_challenge(self, challenge):
        """Delete a game challenge"""
        challenge.delete()
    
    @database_sync_to_async
    def _update_challenge_status(self, challenge_id, status):
        """Update challenge status"""
        GameChallenge.objects.filter(challenge_id=challenge_id).update(status=status)  # type: ignore
    
    @database_sync_to_async
    def _create_game_room(self, host, opponent, game_id):
        """Create a new game room with access tokens"""
        host_token = secrets.token_hex(32)
        opponent_token = secrets.token_hex(32)
        token_expires = timezone.now() + GAME_TOKEN_LIFETIME
        
        game = GameRoom.objects.create(  # type: ignore
            game_id=game_id,
            host=host,
            opponent=opponent,
            status='waiting',
            host_token=host_token,
            opponent_token=opponent_token,
            token_expires_at=token_expires,
        )
        return game
    
    @database_sync_to_async
    def _get_game_by_id(self, game_id):
        """Get a game room by ID"""
        try:
            return GameRoom.objects.get(game_id=game_id)  # type: ignore
        except GameRoom.DoesNotExist:  # type: ignore
            return None
    
    @database_sync_to_async
    def _refresh_game_token(self, game_id):
        """Restart the access token's clock, from now.

        The expiry is there so an invite nobody used goes stale, not so a
        player is locked out of the room they are sitting in - see the call
        site in _handle_join_game_room for what that cost.
        """
        GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
            token_expires_at=timezone.now() + GAME_TOKEN_LIFETIME)

    @database_sync_to_async
    def _keep_game_token_alive(self, game_id):
        """Restart the token's clock from a heartbeat, once half of it has run.

        Heartbeats arrive every fifteen seconds, and the clock only needs
        moving every few minutes. The condition is in the query, so this is one
        statement whether it writes or not.
        """
        now = timezone.now()
        GameRoom.objects.filter(  # type: ignore
            game_id=game_id, token_expires_at__lt=now + GAME_TOKEN_LIFETIME / 2,
        ).update(token_expires_at=now + GAME_TOKEN_LIFETIME)

    @database_sync_to_async
    def _claim_invite_pair(self, challenger, opponent):
        """Mark both players invited, in one statement, if neither is busy.

        All or nothing: a pair where one of them is already taken is rolled
        back rather than left half-claimed.
        """
        with transaction.atomic():
            claimed = PlayerConnection.objects.filter(  # type: ignore
                username__in=[challenger, opponent],
            ).exclude(status__in=['in-game', 'invited']).update(
                status='invited', last_activity=timezone.now())
            if claimed != 2:
                transaction.set_rollback(True)
        return claimed == 2

    @database_sync_to_async
    def _update_game_status(self, game_id, status):
        """Update game status"""
        game = GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
            status=status,
            started_at=timezone.now() if status == 'started' else None
        )
        return game
    
    @database_sync_to_async
    def _update_game_mode(self, game_id, mode, options):
        """
        Update game mode and options.

        *options* of None means the change named none, which is not the same
        as naming an empty set: the settings already on the room stand. A host
        who picked a 60-second clock and then switched mode still has it.
        """
        game = GameRoom.objects.filter(game_id=game_id).first()  # type: ignore
        if not game:
            return
        GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
            game_mode=mode,
            game_options=(game.game_options or {}) if options is None else options
        )

    @database_sync_to_async
    def _set_custom_config(self, game_id, config):
        """Save a validated custom board/unit config for a game room."""
        GameRoom.objects.filter(game_id=game_id).update(custom_config=config)  # type: ignore

    @database_sync_to_async
    def _close_game_room(self, game_id, reason):
        """Close a game room and reset both players' statuses to 'online'"""
        try:
            game = GameRoom.objects.get(game_id=game_id)  # type: ignore
            
            if game.host:
                PlayerConnection.objects.filter(username=game.host).update(status='online')  # type: ignore
            if game.opponent:
                PlayerConnection.objects.filter(username=game.opponent).update(status='online')  # type: ignore
            
            GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
                status='closed',
                closed_at=timezone.now()
            )
            logger.info(f"Game {game_id} closed: {reason} (both players reset to online)")
        except GameRoom.DoesNotExist:  # type: ignore
            logger.warning(f"Game {game_id} not found when closing")
        except Exception as e:
            logger.error(f"Error closing game room {game_id}: {e}")
    
    @database_sync_to_async
    def _set_ready_status(self, game_id, username, is_ready):
        """Set player ready status"""
        try:
            game_room = GameRoom.objects.get(game_id=game_id)
        except GameRoom.DoesNotExist:
            raise ValueError(f"GameRoom with id {game_id} does not exist")
        PlayerReadyStatus.objects.update_or_create(  # type: ignore
            game_id=game_room,
            username=username,
            defaults={'is_ready': is_ready}
        )
    
    @database_sync_to_async
    def _delete_ready_status(self, game_id, username):
        """Delete ready status"""
        PlayerReadyStatus.objects.filter(game_id=game_id, username=username).delete()  # type: ignore
    
    @database_sync_to_async
    def _all_players_ready(self, game_id):
        """True only when BOTH seats have readied.

        `all()` over whatever rows exist answers a different question: a
        disconnect deletes the leaver's row (see _cleanup_game_room_connection),
        so the last row standing was the host's own and the check passed with
        nobody left to play against.
        """
        try:
            game = GameRoom.objects.get(game_id=game_id)  # type: ignore
        except GameRoom.DoesNotExist:  # type: ignore
            return False
        seats = {name for name in (game.host, game.opponent) if name}
        ready = set(PlayerReadyStatus.objects.filter(  # type: ignore
            game_id=game_id, is_ready=True).values_list('username', flat=True))
        return bool(seats) and seats <= ready
    
    @database_sync_to_async
    def _get_ready_statuses(self, game_id):
        """Get a dict of username -> is_ready for all players in a game"""
        statuses = PlayerReadyStatus.objects.filter(game_id=game_id)  # type: ignore
        return {s.username: s.is_ready for s in statuses}

    # -- GameState DB operations --------------------------------------

    @database_sync_to_async
    def _create_game_state(self, game_id, board_state, current_turn, player_white, player_black,
                            config_snapshot, turn_started_at=None):
        """Create (or reset, on rematch) the GameState for a game that just started."""
        game = GameRoom.objects.get(game_id=game_id)
        state, _created = GameState.objects.update_or_create(
            game=game,
            defaults={
                'board_state': board_state,
                'current_turn': current_turn,
                'turn_number': 1,
                'move_history': [],
                'player_white': player_white,
                'player_black': player_black,
                'winner': '',
                'end_reason': '',
                'config_snapshot': config_snapshot,
                'draw_offered_by': '',
                'turn_started_at': turn_started_at or timezone.now(),
                # A rematch reuses the row, and must not inherit the last
                # match's phases.
                'phase_bank': {},
            },
        )
        return state

    @database_sync_to_async
    def _get_game_state(self, game_id):
        """Retrieve the GameState for a game, or None."""
        try:
            return GameState.objects.get(game_id=game_id)  # type: ignore
        except GameState.DoesNotExist:  # type: ignore
            return None

    @database_sync_to_async
    def _update_game_state(self, game_id, board_state, current_turn, turn_number, move_history,
                            winner='', end_reason='', expected_turn_number=None, turn_started_at=None,
                            phase_bank=None):
        """Update the mutable fields of a GameState after a move or game end.

        If expected_turn_number is given, the write is conditional: it only
        applies if the game is still unfinished (end_reason == '') and still
        at exactly that turn_number. This is optimistic concurrency control -
        it stops a stale write (e.g. a move that finishes processing after a
        turn timer already ended the game, or vice versa) from silently
        clobbering whichever result actually landed first.

        Any pending draw offer is cleared by every state write: a move
        invalidates an outstanding offer (matching the client, which already
        clears it locally on move_made), and a finished game has no use for one.

        *phase_bank* is written only when given: a hand-over hands one in, and
        a deployment - which closes no phase - leaves the stored one alone.

        Returns True if the write applied, False if a concurrent write won.
        """
        qs = GameState.objects.filter(game_id=game_id)  # type: ignore
        if expected_turn_number is not None:
            qs = qs.filter(turn_number=expected_turn_number, end_reason='')
        update_fields = {
            'board_state': board_state,
            'current_turn': current_turn,
            'turn_number': turn_number,
            'move_history': move_history,
            'winner': winner,
            'end_reason': end_reason,
            'draw_offered_by': '',
        }
        if turn_started_at is not None:
            update_fields['turn_started_at'] = turn_started_at
        if phase_bank is not None:
            update_fields['phase_bank'] = phase_bank
        rows = qs.update(**update_fields)
        return rows > 0

    @database_sync_to_async
    def _set_draw_offer(self, game_id, username):
        """Set or clear the draw_offered_by field."""
        GameState.objects.filter(game_id=game_id).update(draw_offered_by=username)  # type: ignore
    
    # ==================== Broadcast Handlers ====================
    
    async def broadcast_message(self, event):
        """Generic broadcast message handler"""
        await send_json_response(self, event['data'])
    
    async def send_game_challenge(self, event):
        """Send game challenge to specific user"""
        await send_json_response(self, {
            'type': 'game_challenge',
            'challenger': event['challenger'],
            'opponent': event['opponent'],
            'inviteId': event['invite_id']
        })
    
    async def send_challenge_accepted(self, event):
        """Send challenge acceptance to specific user"""
        await send_json_response(self, {
            'type': 'challenge_accepted',
            'username': event['username'],
            'gameId': event['gameId'],
            'token': event.get('token', '')
        })
    
    async def send_challenge_declined(self, event):
        """Send challenge decline to specific user"""
        await send_json_response(self, {
            'type': 'challenge_declined',
            'username': event['username']
        })
    
    async def game_room_message(self, event):
        """Broadcast game room message"""
        message = {
            'type': 'game_room_message',
            'username': event['username'],
            'content': event['content'],
            'timestamp': event['timestamp']
        }
        # Preserve messageType if present (for system messages)
        if 'messageType' in event:
            message['messageType'] = event['messageType']
        await send_json_response(self, message)
    
    async def partner_left(self, event):
        """Notify a player that their partner has left the game room"""
        # Only send to players who didn't initiate the leave
        if self.username != event['username']:
            await send_json_response(self, {
                'type': 'partner_left',
                'username': event['username'],
                'gameId': event['gameId']
            })
    
    # ==================== Helper Methods ====================
    
    async def _send_user_list(self):
        """Send current user list to all lobby users"""
        try:
            users = await self._get_all_online_users()
            logger.debug(f"[_send_user_list] Sending user list with {len(users)} users")
            await broadcast_to_group(self.channel_layer, 'game_lobby', {
                'type': 'user_list',
                'users': users
            })
        except Exception as e:
            logger.error(f"Error sending user list: {e}")
    
    async def _send_game_player_list(self, game_id, is_inviter):
        """Send player list for a game room"""
        try:
            game = await self._get_game_by_id(game_id)
            if not game:
                logger.warning(f"Game {game_id} not found when sending player list")
                return
            
            # Get actual player statuses and ready states (batch query for efficiency)
            connections = await self._get_player_connections_batch([game.host, game.opponent])
            host_connection = connections.get(game.host)
            opponent_connection = connections.get(game.opponent)
            ready_statuses = await self._get_ready_statuses(game_id)
            
            host_status = host_connection.status if host_connection else 'online'
            opponent_status = opponent_connection.status if opponent_connection else 'online'
            host_ready = ready_statuses.get(game.host, False)
            opponent_ready = ready_statuses.get(game.opponent, False)
            
            players = [
                {'username': game.host, 'status': host_status, 'isReady': host_ready, 'isInviter': True},
                {'username': game.opponent, 'status': opponent_status, 'isReady': opponent_ready, 'isInviter': False}
            ]

            logger.debug(f"Sending player_list to game room {game_id}: {players}")
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'player_list',
                'players': players,
                'isInviter': is_inviter,
                # Settings only ever reached a client through the live
                # game_mode_changed broadcast, so whoever joined after the
                # host chose was shown the component's default instead. Only
                # the settings the validator accepts: the client sends this
                # dict straight back on its next change, and a room row left
                # over from an older build carries keys that are now unknown.
                'gameOptions': {
                    k: v for k, v in (game.game_options or {}).items()
                    if k in GAME_OPTION_KEYS
                },
            })
        except Exception as e:
            logger.error(f"Error sending game player list: {e}")
