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
from django.utils import timezone

from typing import Optional, Any, Dict, cast, Union
from .models import (
    GameRoom,
    GameChallenge,
    PlayerConnection,
    PlayerReadyStatus,
    GameState,
)
from .validators import (
    ValidationError, validate_required_fields, validate_username,
    validate_status, validate_game_mode, validate_game_options,
    validate_chat_message
)
from .utils import (
    send_json_response, send_error, broadcast_to_group,
    get_challenge_expiration_time, structured_log, get_idempotency, set_idempotency
)
from .engine import load_config, build_initial_board, DEFAULT_CONFIG
from .engine.board import HexBoard, parse_coord
from .engine.game_logic import get_legal_moves_filtered, resolve_combat, detect_outcome

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

# Global dictionary to track pending disconnect-grace-period tasks.
# Key: (game_id, username), Value: asyncio.Task
_pending_disconnect_timers: dict = {}

# Per-connection flood protection. Rate limiting is naturally per-connection
# here (not shared/Redis-backed) since Channels gives each WebSocket its own
# consumer instance for its whole lifetime - no cross-process state needed.
MAX_MESSAGE_BYTES = 32 * 1024  # comfortably covers a full custom game config
RATE_LIMIT_WINDOW_SECONDS = 10
RATE_LIMIT_MAX_MESSAGES = 30  # ~3/sec sustained, generous burst allowance


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
            if player_conn and player_conn.status == 'in-game':
                logger.info(f"User {self.username} is in-game, not deleting PlayerConnection")
                return
            
            await self._delete_player_connection(self.username)
            
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

            state = await self._get_game_state(self.game_id)
            if state and not state.is_finished:
                # A match is actively in progress - don't end it or close the
                # room immediately (the player may just be refreshing the
                # page). Leave the turn timer running as-is - if the
                # disconnecting player was on the clock, it will still
                # correctly expire and end the game; if not, nothing about
                # it should change. Instead, give them a grace period to
                # reconnect before forfeiting the game to their opponent.
                await self._start_disconnect_grace_timer(self.game_id, self.username)
                await broadcast_to_group(self.channel_layer, self.room_group_name, {
                    'type': 'opponent_disconnected',
                    'username': self.username,
                    'graceSeconds': DISCONNECT_GRACE_SECONDS,
                })
            elif game.host == self.username:
                # No active match to protect (not yet started, or already
                # over) - safe to close the room immediately if the host left.
                await self._close_game_room(game.game_id, f"{self.username} (host) disconnected")
                await self._send_user_list()

            await self._delete_ready_status(self.game_id, self.username)

            await self._delete_player_connection(self.username)
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
    
    # ==================== Message Handlers ====================
    
    async def _handle_join_lobby(self, data):
        """Handle user joining the lobby"""
        try:
            username = data.get('username', '').strip()
            original_username = username
            username_was_taken = False
            
            validate_username(username)
            
            existing_connection = await self._get_player_connection(username)
            if existing_connection and existing_connection.channel_name != self.channel_name:
                if data.get('rejoining', False):
                    logger.info(f"User {username} rejoining lobby with new channel")
                else:
                    # Generate a random username instead of rejecting
                    random_suffix = ''.join(random.choices(string.digits, k=6))
                    username = f"Guest{random_suffix}"
                    username_was_taken = True
                    logger.info(f"Username '{original_username}' was taken, assigned '{username}' instead")
            
            self.username = username
            await self._create_or_update_player_connection(username, self.channel_name, 'online')
            
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
            
            await self._delete_player_connection(username)
            
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
            
            validate_username(new_username)
            
            if self.username != old_username:
                await send_error(self, 'INVALID_REQUEST', 'Cannot change username for another user')
                return
            
            existing = await self._get_player_connection(new_username)
            if existing:
                await send_error(self, 'USERNAME_TAKEN', f'Username "{new_username}" is already taken')
                return
            
            # Update in database - first delete old, then create new to avoid duplicates
            # This is more reliable than updating in place
            await self._delete_player_connection(old_username)
            await self._create_or_update_player_connection(new_username, self.channel_name, 'online')
            
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

            challenge = await self._create_challenge(challenger, opponent)
            if idem_key:
                try:
                    set_idempotency(idem_key, {'invite_id': challenge.challenge_id}, timeout=60)
                except Exception:
                    structured_log('warning', 'idempotency_set_failed', key=idem_key)
            
            # Set both players' status to 'invited' so third parties can't invite them
            await self._update_player_status(challenger, 'invited')
            await self._update_player_status(opponent, 'invited')
            
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
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game room not found')
                return
            
            logger.info(f"[join_game_room] Game found: host={game.host}, opponent={game.opponent}")
            
            if username != game.host and username != game.opponent:
                logger.warning(f"[join_game_room] User {username} not in game - host={game.host}, opponent={game.opponent}")
                await send_error(self, 'NOT_IN_GAME', 'You are not in this game')
                return
            
            expected_token = game.host_token if username == game.host else game.opponent_token
            if not expected_token or token != expected_token:
                await send_error(self, 'INVALID_TOKEN', 'Invalid or missing access token')
                return
            
            if game.token_expires_at and timezone.now() > game.token_expires_at:
                await send_error(self, 'TOKEN_EXPIRED', 'Access token has expired')
                return
            
            self.game_id = game_id

            # Cancel any pending disconnect-forfeit grace timer
            had_pending_grace = (game_id, username) in _pending_disconnect_timers
            self._cancel_disconnect_timer(game_id, username)

            # The game room may arrive on a fresh WebSocket, so refresh the stored channel
            await self._create_or_update_player_connection(username, self.channel_name, 'in-game')
            
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

            # Close the room if the host left, or if leaving forfeited the match
            # (the remaining player is sent back to the lobby by partner_left
            # either way, so the room must not linger as 'started').
            if username == game.host or forfeited:
                await self._close_game_room(game_id, f"{username} left the game room")

            await self._send_user_list()
            
            logger.info(f"User {username} left game room {game_id}, returning to lobby")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_game_room_message(self, data):
        """Handle game room chat message"""
        try:
            validate_required_fields(data, ['content'])
            validate_chat_message(data['content'])
            
            # Send directly to game room group (not wrapped in broadcast_message)
            await self.channel_layer.group_send(
                self.room_group_name,
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
            
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            await self._set_ready_status(game_id, username, True)
            
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
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
            
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            await self._set_ready_status(game_id, username, False)

            silent = data.get('silent', False)
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
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
            
            options = {}
            if mode == 'custom':
                if 'options' in data:
                    validate_game_options(data['options'])
                    options = data['options']
            
            await self._update_game_mode(game_id, mode, options)
            
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
            board = build_initial_board(config)

            await self._update_player_status(game.host, 'in-game')
            await self._update_player_status(game.opponent, 'in-game')
            await self._send_user_list()
            await self._send_game_player_list(game_id, is_inviter=(self.username == game.host))

            if random.random() < 0.5:
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

    async def _start_turn_timer(self, game_id: str, time_limit: int, turn_number: int, current_turn: str):
        """Start (or restart) the turn timer for the given game.

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
                # Timer expired - the current player loses, unless the game
                # has already moved on since this timer was armed.
                state = await self._get_game_state(game_id)
                if not state or state.is_finished:
                    return
                if state.turn_number != turn_number or state.current_turn != current_turn:
                    logger.info(f"Stale turn timer for game {game_id} (armed for turn {turn_number}) ignored")
                    return

                winner = state.player_black if state.current_turn == state.player_white else state.player_white
                if await self._end_game(game_id, state, winner, 'timeout'):
                    await self._broadcast_game_over(game_id, winner, 'timeout')
                    logger.info(f"Turn timer expired in game {game_id} - {winner} wins")
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.error(f"Error in turn timer for game {game_id}: {e}", exc_info=True)
            finally:
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
        """Give a disconnected player DISCONNECT_GRACE_SECONDS to reconnect
        before forfeiting the game to their opponent.

        Cancelled by _handle_join_game_room if the player rejoins in time.
        """
        self._cancel_disconnect_timer(game_id, username)

        async def _grace_task():
            try:
                await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
                state = await self._get_game_state(game_id)
                if not state or state.is_finished:
                    return
                game = await self._get_game_by_id(game_id)
                if not game:
                    return

                winner = game.opponent if username == game.host else game.host
                if await self._end_game(game_id, state, winner, 'disconnect'):
                    await self._broadcast_game_over(game_id, winner, 'disconnect', disconnectedPlayer=username)
                    await self._close_game_room(game_id, f"{username} did not reconnect within the grace period")
                    await self._send_user_list()
                    logger.info(f"Game {game_id} forfeited to {winner} - {username} did not reconnect in time")
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
            except (ValueError, IndexError, TypeError, AttributeError):
                await send_error(self, 'INVALID_MOVE', 'Malformed move coordinates')
                return

            piece = board.get(fq, fr)
            if not piece:
                await send_error(self, 'INVALID_MOVE', 'No piece at source coordinate')
                return

            my_color = 'white' if self.username == state.player_white else 'black'
            if piece['color'] != my_color:
                await send_error(self, 'INVALID_MOVE', 'That piece is not yours')
                return

            legal_dests = get_legal_moves_filtered(board, (fq, fr), config, my_color)
            if (tq, tr) not in legal_dests:
                await send_error(self, 'INVALID_MOVE', 'Illegal move for this piece')
                return

            combat = resolve_combat(board, (fq, fr), (tq, tr), config)

            next_player = state.player_black if self.username == state.player_white else state.player_white
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
            if combat['defender_hp'] is not None:
                move_record['defender_hp'] = combat['defender_hp']

            new_history = list(state.move_history) + [move_record]

            winner = ''
            end_reason = ''
            outcome = detect_outcome(board, next_color, config)
            if outcome == 'elimination':
                winner = self.username
                end_reason = 'elimination'

            max_turns = config.get('rules', {}).get('maxTurns', 0)
            if not end_reason and max_turns > 0 and state.turn_number >= max_turns:
                end_reason = 'draw_max_turns'

            # Persist updated state - conditional on the game still being at
            # state.turn_number and unfinished, so a turn timer that already
            # ended the game while this move was in flight can't be clobbered.
            next_turn_number = state.turn_number + 1
            turn_started_dt = timezone.now()
            applied = await self._update_game_state(
                game_id=self.game_id,
                board_state=board.to_dict(),
                current_turn=next_player if not end_reason else state.current_turn,
                turn_number=next_turn_number,
                move_history=new_history,
                winner=winner,
                end_reason=end_reason,
                expected_turn_number=state.turn_number,
                turn_started_at=turn_started_dt,
            )
            if not applied:
                await send_error(self, 'GAME_OVER', 'This game already ended before your move was processed')
                return

            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'move_made',
                'move': move_record,
                'boardState': board.to_dict(),
                'currentTurn': next_player if not end_reason else '',
                'turnNumber': next_turn_number,
                'turnStartedAt': turn_started_dt.isoformat(),
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

            logger.info(f"Move in game {self.game_id}: {from_coord}->{to_coord} by {self.username}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
        except Exception as e:
            logger.error(f"Error in _handle_make_move: {e}", exc_info=True)
            await send_error(self, 'INTERNAL_ERROR', 'Failed to process move')

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
    def _create_or_update_player_connection(self, username, channel_name, status):
        """Create or update a player connection"""
        connection, _ = PlayerConnection.objects.update_or_create(  # type: ignore
            username=username,
            defaults={
                'channel_name': channel_name,
                'status': status,
                'last_activity': timezone.now()
            }
        )
        return connection
    
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
    def _delete_player_connection(self, username):
        """Delete a player connection"""
        PlayerConnection.objects.filter(username=username).delete()  # type: ignore
    
    @database_sync_to_async
    def _get_all_online_users(self):
        """Get all currently online users, deleting stale connections first"""
        # Consider connections stale if no heartbeat in 45 seconds
        # (heartbeat interval is 15 seconds, so 3 missed heartbeats = stale)
        stale_threshold = timezone.now() - timedelta(seconds=45)
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
        token_expires = timezone.now() + timedelta(minutes=10)
        
        game = GameRoom.objects.create(  # type: ignore
            game_id=game_id,
            host=host,
            opponent=opponent,
            status='waiting',
            host_token=host_token,
            opponent_token=opponent_token,
            token_expires_at=token_expires
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
    def _update_game_status(self, game_id, status):
        """Update game status"""
        game = GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
            status=status,
            started_at=timezone.now() if status == 'started' else None
        )
        return game
    
    @database_sync_to_async
    def _update_game_mode(self, game_id, mode, options):
        """Update game mode and options"""
        GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
            game_mode=mode,
            game_options=options
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
        """Check if all players in a game are ready"""
        statuses = PlayerReadyStatus.objects.filter(game_id=game_id)  # type: ignore
        return statuses.exists() and all(s.is_ready for s in statuses)
    
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
                            winner='', end_reason='', expected_turn_number=None, turn_started_at=None):
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
                'isInviter': is_inviter
            })
        except Exception as e:
            logger.error(f"Error sending game player list: {e}")
