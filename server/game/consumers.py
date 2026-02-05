"""
WebSocket consumer for game lobby and game room management
Uses Django ORM models instead of in-memory class-level dictionaries
"""
import json
import logging
import uuid
from datetime import datetime
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.utils import timezone

from typing import Optional, Any, Dict, cast, Union
from .models import (
    GameRoom,
    GameChallenge,
    PlayerConnection,
    PlayerReadyStatus,
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

logger = logging.getLogger('game')

# Global dictionary to track pending countdown tasks per game
# Key: game_id, Value: asyncio.Task
_pending_countdown_tasks: dict = {}


class GameConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer handling all game and lobby operations.
    Uses async/await pattern with database operations for thread-safety.
    """

    async def _handle_cancel_game_countdown(self, data):
        """Handle cancellation of the game start countdown by either player."""
        try:
            # Only allow if user is in a game room
            if not self.game_id or not self.username:
                await send_error(self, 'NOT_IN_GAME_ROOM', 'You are not in a game room')
                return

            # Cancel any pending countdown task for this game
            if self.game_id in _pending_countdown_tasks:
                task = _pending_countdown_tasks.pop(self.game_id)
                task.cancel()
                logger.info(f"Cancelled pending countdown task for game {self.game_id}")

            # Unset ready for both players
            await self._set_ready_status(self.game_id, self.username, False)
            # Get game and both players
            game = await self._get_game_by_id(self.game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            # Unset ready for the other player
            other_player = game.host if game.host != self.username else game.opponent
            if other_player:
                await self._set_ready_status(self.game_id, other_player, False)

            # Broadcast cancellation to both players in the game room (wrapped for frontend)
            await broadcast_to_group(self.channel_layer, f'game_{self.game_id}', {
                'type': 'broadcast_message',
                'data': {
                    'type': 'game_countdown_cancelled',
                    'by': self.username
                }
            })
            logger.info(f"Game countdown cancelled by {self.username} in game {self.game_id}")
        except Exception as e:
            logger.error(f"Error in _handle_cancel_game_countdown: {e}")
            await send_error(self, 'INTERNAL_ERROR', 'Failed to cancel game countdown')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Initialize as strings to satisfy type checks for broadcast/group methods
        self.room_name = 'default'
        self.room_group_name = 'game_default'
        self.username = None
        self.game_id = None
        self.leaving_game_room = False  # Track if user is leaving to lobby
        self._last_activity_update = None  # Throttle activity updates
    
    async def connect(self):
        """Handle WebSocket connection"""
        try:
            # Get room name from URL route
            url_route: Dict[str, Any] = cast(Dict[str, Any], self.scope.get('url_route', {}))
            kwargs: Dict[str, Any] = cast(Dict[str, Any], url_route.get('kwargs', {}))
            self.room_name = cast(str, kwargs.get('room_name') or 'default')
            self.room_group_name = f'game_{self.room_name}'
            
            # Only join lobby group immediately - game room groups require validation first
            # This prevents unauthorized users from receiving game room broadcasts
            if self.room_name == 'lobby':
                await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            # For game rooms, we'll add to the group in _handle_join_game_room after validation
            
            # Accept connection
            await self.accept()
            
            # Send confirmation
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
                    # If user was never validated (no game_id), just log and do nothing
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
            
            # Remove from database
            await self._delete_player_connection(self.username)
            
            # Notify other lobby users
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'user_left',
                'username': self.username
            })
            
            # Send updated user list
            await self._send_user_list()
        except Exception as e:
            logger.error(f"Error cleaning up lobby connection for {self.username}: {e}")
    
    async def _cleanup_game_room_connection(self):
        """Clean up when user disconnects from game room"""
        try:
            game = await self._get_game_by_id(self.game_id)
            if not game:
                return
            
            # If host left, close the game
            if game.host == self.username:
                await self._close_game_room(game.game_id, f"{self.username} (host) disconnected")
            
            # Remove player from ready status
            await self._delete_ready_status(self.game_id, self.username)
            
            # Clean up player connection
            await self._delete_player_connection(self.username)
        except Exception as e:
            logger.error(f"Error cleaning up game room connection for {self.username}: {e}")
    
    async def receive(self, text_data=None, bytes_data=None):
        """
        Handle incoming WebSocket messages
        """
        try:
            incoming_data: Union[str, bytes, None] = text_data if text_data is not None else bytes_data
            if incoming_data is None:
                await send_error(self, 'INVALID_JSON', 'Message must be non-empty')
                return
            data = json.loads(incoming_data)
            message_type = data.get('type', '')
            
            logger.debug(f"Message received from {self.username}: {message_type}")
            structured_log('debug', 'message_received', username=self.username, message_type=message_type)
            
            # Route message to appropriate handler
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
            'start_game': self._handle_start_game,
            'request_user_list': self._handle_request_user_list,
            'heartbeat': self._handle_heartbeat,
            'cancel_game_countdown': self._handle_cancel_game_countdown,
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
            
            # Validate username
            validate_username(username)
            
            # Check if username already taken
            existing_connection = await self._get_player_connection(username)
            if existing_connection and existing_connection.channel_name != self.channel_name:
                # If rejoining, allow it and update the connection
                if data.get('rejoining', False):
                    logger.info(f"User {username} rejoining lobby with new channel")
                else:
                    # Generate a random username instead of rejecting
                    import random
                    import string
                    random_suffix = ''.join(random.choices(string.digits, k=6))
                    username = f"Guest{random_suffix}"
                    username_was_taken = True
                    logger.info(f"Username '{original_username}' was taken, assigned '{username}' instead")
            
            # Save connection (will update if already exists)
            self.username = username
            await self._create_or_update_player_connection(username, self.channel_name, 'online')
            
            # If username was changed, notify the client of their new username
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
            
            # Send user list to all lobby users
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
            
            # Remove connection
            await self._delete_player_connection(username)
            
            # Notify others
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'user_left',
                'username': username
            })
            
            # Send updated user list
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
                'timestamp': data.get('timestamp', datetime.now().isoformat())
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
            
            # Check if new username already taken
            existing = await self._get_player_connection(new_username)
            if existing:
                await send_error(self, 'USERNAME_TAKEN', f'Username "{new_username}" is already taken')
                return
            
            # Update in database - first delete old, then create new to avoid duplicates
            # This is more reliable than updating in place
            await self._delete_player_connection(old_username)
            await self._create_or_update_player_connection(new_username, self.channel_name, 'online')
            
            self.username = new_username
            
            # Notify others
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'username_changed',
                'oldUsername': old_username,
                'newUsername': new_username
            })
            
            # Send updated user list
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
            
            # Update in database
            await self._update_player_status(username, status)
            
            # Send updated user list to lobby
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
            
            # Create challenge
            # Idempotency: check for key
            idem_key = data.get('idempotency_key')
            if idem_key:
                prior = get_idempotency(idem_key)
                if prior:
                    # Return prior invite id if present
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
            
            # Broadcast updated user list to lobby
            await self._send_user_list()
            
            # Notify opponent
            await self.channel_layer.send(opponent_conn.channel_name, {
                'type': 'send_game_challenge',
                'challenger': challenger,
                'opponent': opponent,
                'invite_id': challenge.challenge_id
            })
            
            logger.info(f"Challenge created: {challenger} → {opponent}")
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
            
            # Get challenge
            challenge = await self._get_challenge(challenger, opponent)
            if not challenge or challenge.status != 'pending':
                await send_error(self, 'CHALLENGE_NOT_FOUND', 'Challenge not found or no longer pending')
                return
            
            # Generate a unique game ID
            game_id = str(uuid.uuid4())
            
            # Create game room
            # Idempotency for game creation
            idem_key = data.get('idempotency_key')
            if idem_key:
                prior = get_idempotency(idem_key)
                if prior:
                    # If game already created, respond with existing game id
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
            
            # Update both players' status to 'in-game' BEFORE they navigate to game room
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
                    'token': game.host_token  # Host gets host_token
                })
            
            if opponent_conn:
                await self.channel_layer.send(opponent_conn.channel_name, {
                    'type': 'send_challenge_accepted',
                    'username': opponent,
                    'gameId': game_id,
                    'token': game.opponent_token  # Opponent gets opponent_token
                })
            
            # Broadcast updated user list to lobby so everyone sees the 'in-game' status
            await self._send_user_list()
            
            logger.info(f"Challenge accepted: {challenger} ↔ {opponent} (game: {game_id})")
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
            
            # Get challenge
            challenge = await self._get_challenge(challenger, opponent)
            if not challenge:
                await send_error(self, 'CHALLENGE_NOT_FOUND', 'Challenge not found')
                return
            
            # Update challenge status
            await self._update_challenge_status(challenge.challenge_id, 'declined')
            
            # Reset both players' status back to 'online'
            await self._update_player_status(challenger, 'online')
            await self._update_player_status(opponent, 'online')
            
            # Broadcast updated user list to lobby
            await self._send_user_list()
            
            # Notify challenger
            challenger_conn = await self._get_player_connection(challenger)
            if challenger_conn:
                await self.channel_layer.send(challenger_conn.channel_name, {
                    'type': 'send_challenge_declined',
                    'username': opponent
                })
            
            logger.info(f"Challenge declined: {challenger} ← {opponent}")
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
            
            # Get game
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game room not found')
                return
            
            logger.info(f"[join_game_room] Game found: host={game.host}, opponent={game.opponent}")
            
            # Verify user is in this game
            if username != game.host and username != game.opponent:
                logger.warning(f"[join_game_room] User {username} not in game - host={game.host}, opponent={game.opponent}")
                await send_error(self, 'NOT_IN_GAME', 'You are not in this game')
                return
            
            # Validate the access token
            expected_token = game.host_token if username == game.host else game.opponent_token
            if not expected_token or token != expected_token:
                await send_error(self, 'INVALID_TOKEN', 'Invalid or missing access token')
                return
            
            # Check if token has expired
            if game.token_expires_at and timezone.now() > game.token_expires_at:
                await send_error(self, 'TOKEN_EXPIRED', 'Access token has expired')
                return
            
            # Store game_id for this connection
            self.game_id = game_id
            
            # Update player connection with new channel and status
            # This is important when the game room uses a different WebSocket connection
            await self._create_or_update_player_connection(username, self.channel_name, 'in-game')
            
            # Add to game room group (but KEEP lobby group membership for lobby chat)
            # Don't discard from lobby group - users in game room should still receive lobby messages
            self.room_name = game_id
            self.room_group_name = f'game_{game_id}'
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            # Also ensure we're still in lobby group for lobby chat
            await self.channel_layer.group_add('game_lobby', self.channel_name)
            
            # Broadcast updated user list to lobby
            await self._send_user_list()
            
            logger.info(f"Sending player_list for game {game_id}, is_inviter: {username == game.host}")
            
            # Send player list
            await self._send_game_player_list(game_id, username == game.host)
            
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
            
            # Check if PlayerConnection exists at START
            exists_at_start = await database_sync_to_async(
                PlayerConnection.objects.filter(username=username).exists
            )()
            logger.info(f"[leave_game_room] PlayerConnection exists at start: {exists_at_start}")
            
            if exists_at_start:
                conn = await database_sync_to_async(
                    lambda: PlayerConnection.objects.get(username=username)
                )()
                logger.info(f"[leave_game_room] Current PlayerConnection: username={conn.username}, status={conn.status}, channel={conn.channel_name}")
            
            # Notify other player(s) in the game room that this player left
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
            logger.info(f"[leave_game_room] Sent partner_left notification to {game_room_group}")
            
            # Mark that this user is leaving to return to lobby
            self.leaving_game_room = True
            logger.info(f"[leave_game_room] Set leaving_game_room flag to True")
            
            # Switch back to lobby group
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
            self.room_name = 'lobby'
            self.room_group_name = 'game_lobby'
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            logger.info(f"[leave_game_room] Switched to lobby group")
            
            # Update player status back to 'online' (keep the connection alive)
            await self._update_player_status(username, 'online')
            logger.info(f"[leave_game_room] Updated status to 'online'")
            
            # Clean up ready status
            await self._delete_ready_status(game_id, username)
            
            # Broadcast updated user list to lobby
            logger.info(f"[leave_game_room] Broadcasting updated user list")
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
                    'timestamp': data.get('timestamp', datetime.now().isoformat())
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
            
            # Verify game exists
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            # Mark as ready
            await self._set_ready_status(game_id, username, True)
            
            # Broadcast to game room
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
            
            # Verify game exists
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            # Mark as not ready
            await self._set_ready_status(game_id, username, False)

            # Broadcast to game room, include silent flag if present
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
            
            # Verify game exists
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            
            # Only host can change mode
            if self.username != game.host:
                await send_error(self, 'PERMISSION_DENIED', 'Only the host can change game mode')
                return
            
            # Validate and update options if custom mode
            options = {}
            if mode == 'custom':
                if 'options' in data:
                    validate_game_options(data['options'])
                    options = data['options']
            
            # Update game
            await self._update_game_mode(game_id, mode, options)
            
            # Broadcast to game room
            message_data = {
                'type': 'game_mode_changed',
                'mode': mode
            }
            if options:
                message_data['options'] = options
            
            await broadcast_to_group(self.channel_layer, self.room_group_name, message_data)
            
            # Log mode change instead of sending system message
            mode_text = "Default Mode" if mode == "default" else "Custom Mode"
            options_text = ""
            if mode == 'custom' and options:
                option_list = [f"{k}: {v}" for k, v in options.items()]
                if option_list:
                    options_text = f" (Options: {', '.join(option_list)})"
            
            logger.info(f"Game mode changed to {mode_text}{options_text} in game {game_id}")
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_start_game(self, data):
        """Handle game start request (placeholder logic)"""
        import asyncio
        try:
            validate_required_fields(data, ['gameId'])
            game_id = data.get('gameId', '').strip()
            # Verify game exists
            game = await self._get_game_by_id(game_id)
            if not game:
                await send_error(self, 'GAME_NOT_FOUND', 'Game not found')
                return
            # Only host can start
            if self.username != game.host:
                await send_error(self, 'PERMISSION_DENIED', 'Only the host can start the game')
                return
            # Check all players are ready
            all_ready = await self._all_players_ready(game_id)
            if not all_ready:
                await send_error(self, 'NOT_ALL_READY', 'Not all players are ready')
                return
            
            # Cancel any existing countdown task for this game (in case of rapid restarts)
            if game_id in _pending_countdown_tasks:
                old_task = _pending_countdown_tasks.pop(game_id)
                old_task.cancel()
                logger.info(f"Cancelled old countdown task for game {game_id}")
            
            # Set both players' status to 'in-game' (red)
            await self._update_player_status(game.host, 'in-game')
            await self._update_player_status(game.opponent, 'in-game')
            # Broadcast updated user list to lobby and game room
            await self._send_user_list()
            await self._send_game_player_list(game_id, is_inviter=(self.username == game.host))
            # Broadcast a "game_start_placeholder" event to game room for UI
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'game_start_placeholder'
            })
            # Broadcast countdown (for UI) -- use direct group_send for perfect sync
            import datetime
            logger.info(f"[DEBUG] Sending game_countdown at {datetime.datetime.now().isoformat(timespec='milliseconds')}")
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'game_countdown'
                }
            )
            logger.info(f"Game {game_id} placeholder start: players set to in-game (red)")
            
            # After 3 seconds, reset ready status and set status back to 'in-game' (yellow) in a background task
            # Store reference to task so it can be cancelled if countdown is cancelled
            async def post_countdown():
                try:
                    await asyncio.sleep(3)
                    # Check if this task was cancelled
                    if game_id not in _pending_countdown_tasks:
                        logger.info(f"Game {game_id} countdown task was cancelled, skipping reset")
                        return
                    # Remove from pending tasks before executing
                    _pending_countdown_tasks.pop(game_id, None)
                    await self._set_ready_status(game_id, game.host, False)
                    await self._set_ready_status(game_id, game.opponent, False)
                    await self._update_player_status(game.host, 'in-game')
                    await self._update_player_status(game.opponent, 'in-game')
                    await self._send_user_list()
                    await self._send_game_player_list(game_id, is_inviter=(self.username == game.host))
                    logger.info(f"Game {game_id} placeholder: ready status reset, players remain in-game (yellow)")
                except asyncio.CancelledError:
                    logger.info(f"Game {game_id} countdown task cancelled")
                except Exception as e:
                    logger.error(f"Error in post_countdown for game {game_id}: {e}")
            
            task = asyncio.create_task(post_countdown())
            _pending_countdown_tasks[game_id] = task
        except ValidationError as e:
            await send_error(self, e.code, e.message)
    
    async def _handle_request_user_list(self, data):
        """Handle request for user list (for real-time sync)"""
        try:
            await self._send_user_list()
        except Exception as e:
            logger.error(f"Error sending user list: {e}")

    async def _handle_heartbeat(self, data):
        """Handle client heartbeat/presence ping"""
        try:
            # Update last_activity
            if self.username:
                await self._update_player_activity(self.username)
                structured_log('debug', 'heartbeat_received', username=self.username)

            # Reply with ack
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
        logger.info(f"[_update_player_status] Updated {username} to '{status}' (rows affected: {rows_updated})")
        return rows_updated
    
    @database_sync_to_async
    def _update_player_connection_username(self, old_username, new_username):
        """Update a player's username"""
        try:
            conn = PlayerConnection.objects.get(username=old_username)  # type: ignore
            conn.username = new_username
            conn.save()
            logger.info(f"[_update_player_connection_username] Updated {old_username} to {new_username}")
            return True
        except PlayerConnection.DoesNotExist:  # type: ignore
            logger.warning(f"[_update_player_connection_username] Connection not found for {old_username}")
            return False
    
    @database_sync_to_async
    def _delete_player_connection(self, username):
        """Delete a player connection"""
        PlayerConnection.objects.filter(username=username).delete()  # type: ignore
    
    @database_sync_to_async
    def _get_all_online_users(self):
        """Get all currently online users, excluding stale connections"""
        from datetime import timedelta
        
        # Consider connections stale if no heartbeat in 45 seconds
        # (heartbeat interval is 15 seconds, so 3 missed heartbeats = stale)
        stale_threshold = timezone.now() - timedelta(seconds=45)
        
        # First, delete stale connections
        stale_count = PlayerConnection.objects.filter(last_activity__lt=stale_threshold).count()  # type: ignore
        if stale_count > 0:
            logger.info(f"[_get_all_online_users] Cleaning up {stale_count} stale connections")
            PlayerConnection.objects.filter(last_activity__lt=stale_threshold).delete()  # type: ignore
        
        all_connections = list(PlayerConnection.objects.all().values('username', 'status', 'channel_name'))  # type: ignore
        logger.info(f"[_get_all_online_users] All connections in DB: {all_connections}")
        
        filtered = list(PlayerConnection.objects.filter(  # type: ignore
            status__in=['online', 'invited', 'configuring', 'in-game']
        ).values('username', 'status'))
        logger.info(f"[_get_all_online_users] Filtered connections: {filtered}")
        
        return filtered
    
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
        import secrets
        from datetime import timedelta
        
        # Generate secure tokens for each player (32 bytes = 64 hex chars)
        host_token = secrets.token_hex(32)
        opponent_token = secrets.token_hex(32)
        # Tokens expire in 10 minutes
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
    def _close_game_room(self, game_id, reason):
        """Close a game room"""
        GameRoom.objects.filter(game_id=game_id).update(  # type: ignore
            status='closed',
            closed_at=timezone.now()
        )
        logger.info(f"Game {game_id} closed: {reason}")
    
    @database_sync_to_async
    def _set_ready_status(self, game_id, username, is_ready):
        """Set player ready status"""
        from game.models import GameRoom, PlayerReadyStatus
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
            'token': event.get('token', '')  # Include access token
        })
    
    async def send_challenge_declined(self, event):
        """Send challenge decline to specific user"""
        await send_json_response(self, {
            'type': 'challenge_declined',
            'username': event['username']
        })
    
    async def user_joined(self, event):
        """Broadcast user joined message"""
        await send_json_response(self, {
            'type': 'user_joined',
            'username': event['username']
        })
    
    async def user_left(self, event):
        """Broadcast user left message"""
        await send_json_response(self, {
            'type': 'user_left',
            'username': event['username']
        })
    
    async def username_changed(self, event):
        """Broadcast username change"""
        await send_json_response(self, {
            'type': 'username_changed',
            'oldUsername': event['oldUsername'],
            'newUsername': event['newUsername']
        })
    
    async def chat_message(self, event):
        """Broadcast chat message"""
        await send_json_response(self, {
            'type': 'chat_message',
            'username': event['username'],
            'content': event['content'],
            'timestamp': event['timestamp']
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
    
    async def player_ready(self, event):
        """Broadcast player ready"""
        await send_json_response(self, {
            'type': 'player_ready',
            'username': event['username']
        })
    
    async def player_unready(self, event):
        """Broadcast player unready"""
        await send_json_response(self, {
            'type': 'player_unready',
            'username': event['username']
        })
    
    async def game_mode_changed(self, event):
        """Broadcast game mode change"""
        message = {
            'type': 'game_mode_changed',
            'mode': event['mode']
        }
        if 'options' in event:
            message['options'] = event['options']
        await send_json_response(self, message)
    
    async def game_countdown(self, event):
        """Broadcast game countdown"""
        import datetime
        logger.info(f"[DEBUG] {self.username} received game_countdown at {datetime.datetime.now().isoformat(timespec='milliseconds')}")
        await send_json_response(self, {'type': 'game_countdown'})
    
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
            logger.info(f"[_send_user_list] Sending user list with {len(users)} users: {users}")
            await broadcast_to_group(self.channel_layer, 'game_lobby', {
                'type': 'broadcast_message',
                'data': {
                    'type': 'user_list',
                    'users': users
                }
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
            
            logger.info(f"Sending player_list to game room {game_id}, group: {self.room_group_name}, players: {players}")
            
            await broadcast_to_group(self.channel_layer, self.room_group_name, {
                'type': 'broadcast_message',
                'data': {
                    'type': 'player_list',
                    'players': players,
                    'isInviter': is_inviter
                }
            })
            
            logger.info(f"player_list broadcast complete for game {game_id}")
        except Exception as e:
            logger.error(f"Error sending game player list: {e}")
