import json
import uuid
from datetime import datetime
from channels.generic.websocket import AsyncWebsocketConsumer

class GameConsumer(AsyncWebsocketConsumer):
    # Class-level annotations for instance attributes
    room_name: str
    room_group_name: str
    username: str
    game_id: str

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Initialize instance attributes
        self.room_name = None
        self.room_group_name = None
        self.username = None
        self.game_id = None
        # Class variables remain for shared state

    # Keep track of connected users
    connected_users = {}
    # Keep track of game challenges
    active_challenges = {}
    # Keep track of game rooms
    active_games = {}
    # Keep track of player ready status
    player_ready_status = {}
    # Keep track of players who have left a game room
    players_left = {}
    
    async def connect(self):
        # Get room name from URL
        self.room_name = self.scope['url_route']['kwargs'].get('room_name', 'default')
        self.room_group_name = f'game_{self.room_name}'
        self.username = None

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        # Accept the connection
        await self.accept()
        
        # Send connection confirmation
        await self.send(text_data=json.dumps({
            'type': 'connection_established',
            'message': 'Connected to game server'
        }))
    
    async def disconnect(self, code):
        _ = code  # acknowledge close code to avoid unused argument warning
        # If this was a logged-in user, update user list
        if self.username and self.room_name == 'lobby':
            # Remove user from connected users
            if self.username in self.connected_users:
                del self.connected_users[self.username]
            
            # Notify others that user has left
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'user_left',
                    'username': self.username
                }
            )
            
            # Send updated user list
            await self.update_user_list()
        
        # Handle host leaving game room on disconnect
        if self.username and self.room_name != 'lobby':
            game_id = self.room_name
            if game_id in self.active_games:
                # Check if the disconnecting user is the host (first player)
                if self.active_games[game_id]['players'][0] == self.username:
                    # Notify all players that host has left
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'host_left',
                            'gameId': game_id,
                            'username': self.username
                        }
                    )
                    # Cleanup game data
                    del self.active_games[game_id]
                    self.player_ready_status.pop(game_id, None)
        
        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
    
    # Receive message from WebSocket
    async def receive(self, text_data=None, bytes_data=None):
        # Channels provides text_data or bytes_data
        text_data = text_data or bytes_data
        try:
            data = json.loads(text_data)
            message_type = data.get('type', '')
            
            # Handle different message types
            if message_type == 'join_lobby':
                username = data.get('username')
                rejoining = data.get('rejoining', False)
                
                # Check if username is already taken by another connection
                if username in self.connected_users and self.connected_users[username]['channel_name'] != self.channel_name and not rejoining:
                    # Username already taken, send error
                    await self.send(text_data=json.dumps({
                        'type': 'username_error',
                        'error': 'This username is already taken. Please choose another.',
                        'oldUsername': username
                    }))
                else:
                    # If rejoining from game room, force remove any lingering connections
                    if rejoining and username in self.connected_users:
                        # Update the existing entry instead of considering it a conflict
                        old_channel_name = self.connected_users[username]['channel_name']
                        if old_channel_name != self.channel_name:
                            # Notify the old connection that it's being replaced (if still active)
                            try:
                                await self.channel_layer.send(
                                    old_channel_name,
                                    {
                                        'type': 'force_disconnect',
                                        'message': 'Your session has been replaced by a new connection'
                                    }
                                )
                            except Exception:  # noqa: E722 broad exception suppressed
                                # Ignore errors if the old channel is already gone
                                pass
                    
                    # If this connection had a previous username, remove it
                    if self.username and self.username in self.connected_users:
                        # Notify others that user has left with old name
                        await self.channel_layer.group_send(
                            self.room_group_name,
                            {
                                'type': 'user_left',
                                'username': self.username
                            }
                        )
                        # Remove old username entry
                        del self.connected_users[self.username]
                    
                    # Username is available - update to new username
                    self.username = username
                    self.connected_users[self.username] = {
                        'channel_name': self.channel_name,
                        'status': 'online'
                    }
                    
                    # Notify others that user has joined
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'user_joined',
                            'username': self.username
                        }
                    )
                    
                    # Send updated user list
                    await self.update_user_list()
                
            elif message_type == 'leave_lobby':
                username = data.get('username')
                if username in self.connected_users:
                    del self.connected_users[username]
                
                # Notify others that user has left
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'user_left',
                        'username': username
                    }
                )
                
                # Send updated user list
                await self.update_user_list()
                
            elif message_type == 'chat_message':
                # Broadcast the chat message
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'chat_message',
                        'username': data.get('username'),
                        'content': data.get('content'),
                        'timestamp': data.get('timestamp')
                    }
                )
                
            elif message_type == 'change_username':
                old_username = data.get('oldUsername')
                new_username = data.get('newUsername')
                
                # Check if the new username already exists
                if new_username in self.connected_users:
                    # Send error to the requesting user
                    await self.send(text_data=json.dumps({
                        'type': 'username_error',
                        'error': f'The username "{new_username}" is already taken. Please choose another.'
                    }))
                else:
                    # Update username in connected users
                    if old_username in self.connected_users:
                        user_data = self.connected_users.pop(old_username)
                        self.connected_users[new_username] = user_data
                        self.username = new_username
                        
                        # Notify all users about the name change
                        await self.channel_layer.group_send(
                            self.room_group_name,
                            {
                                'type': 'username_changed',
                                'oldUsername': old_username,
                                'newUsername': new_username
                            }
                        )
                        
                        # Send updated user list
                        await self.update_user_list()
                
            elif message_type == 'set_status':
                username = data.get('username')
                status = data.get('status')
                print(f'[set_status] Received for {username}: {status}')
                if username in self.connected_users and status in ['online', 'configuring']:
                    prev_status = self.connected_users[username]['status']
                    self.connected_users[username]['status'] = status
                    print(f'[set_status] Updated {username} to {status}')
                    # Only send user_left/user_joined if user is actually removed/added, not for status change
                    # So do NOT send any such event here
                    await self.update_user_list()

            elif message_type == 'game_challenge':
                challenger = data.get('challenger')
                opponent = data.get('opponent')

                # Prevent inviting users who are configuring
                if opponent in self.connected_users and self.connected_users[opponent]['status'] == 'configuring':
                    if challenger in self.connected_users:
                        await self.channel_layer.send(
                            self.connected_users[challenger]['channel_name'],
                            {
                                'type': 'game_room_message',
                                'username': 'System',
                                'content': f'{opponent} is configuring setup and cannot be invited right now.',
                                'timestamp': datetime.now().isoformat()
                            }
                        )
                    return

                # Check if challenger is already in a game room
                existing_game_id = None
                for gid, game in self.active_games.items():
                    if challenger in game['players']:
                        existing_game_id = gid
                        break

                # If challenger is in a game, invite to that game
                if existing_game_id:
                    # Max player check
                    if len(self.active_games[existing_game_id]['players']) >= 8:
                        # Optionally notify challenger (client should block invite UI too)
                        if challenger in self.connected_users:
                            await self.channel_layer.send(
                                self.connected_users[challenger]['channel_name'],
                                {
                                    'type': 'game_room_message',
                                    'username': 'System',
                                    'content': 'Game room is full (max 8 players).',
                                    'timestamp': datetime.now().isoformat()
                                }
                            )
                        return
                    # Create a challenge for the existing game
                    challenge_id = str(uuid.uuid4())
                    self.active_challenges[challenge_id] = {
                        'challenger': challenger,
                        'opponent': opponent,
                        'game_id': existing_game_id,
                        'timestamp': datetime.now().isoformat()
                    }
                    if opponent in self.connected_users:
                        opponent_channel = self.connected_users[opponent]['channel_name']
                        await self.channel_layer.send(
                            opponent_channel,
                            {
                                'type': 'game_challenge',
                                'challenger': challenger,
                                'challenge_id': challenge_id,
                                'game_id': existing_game_id
                            }
                        )
                else:
                    # Not in a game, create a new challenge as before
                    challenge_id = str(uuid.uuid4())
                    self.active_challenges[challenge_id] = {
                        'challenger': challenger,
                        'opponent': opponent,
                        'timestamp': datetime.now().isoformat()
                    }
                    if opponent in self.connected_users:
                        opponent_channel = self.connected_users[opponent]['channel_name']
                        await self.channel_layer.send(
                            opponent_channel,
                            {
                                'type': 'game_challenge',
                                'challenger': challenger,
                                'challenge_id': challenge_id
                            }
                        )

            elif message_type == 'challenge_response':
                response = data.get('response')
                username = data.get('username')
                challenger = data.get('challenger')
                challenge_id = None
                for cid, ch in self.active_challenges.items():
                    if ch['challenger'] == challenger and ch['opponent'] == username:
                        challenge_id = cid
                        break
                if challenger in self.connected_users:
                    challenger_channel = self.connected_users[challenger]['channel_name']
                    if response == 'accept':
                        # If this was an invite to an existing game, add to that game
                        game_id = None
                        if challenge_id and 'game_id' in self.active_challenges[challenge_id]:
                            game_id = self.active_challenges[challenge_id]['game_id']
                            # Max player check (shouldn't be needed, but double check)
                            if len(self.active_games[game_id]['players']) >= 8:
                                await self.channel_layer.send(
                                    challenger_channel,
                                    {
                                        'type': 'game_room_message',
                                        'username': 'System',
                                        'content': 'Game room is full (max 8 players).',
                                        'timestamp': datetime.now().isoformat()
                                    }
                                )
                                return
                            # Add new player to the game, keep host as first
                            if username not in self.active_games[game_id]['players']:
                                self.active_games[game_id]['players'].append(username)
                        else:
                            # Create a new game as before
                            game_id = str(uuid.uuid4())
                            self.active_games[game_id] = {
                                'players': [challenger, username],
                                'status': 'active',
                                'created_at': datetime.now().isoformat()
                            }
                        # Update user statuses to 'invited'
                        self.connected_users[challenger]['status'] = 'invited'
                        self.connected_users[username]['status'] = 'invited'
                        await self.update_user_list()
                        await self.channel_layer.send(
                            challenger_channel,
                            {
                                'type': 'challenge_accepted',
                                'username': username,
                                'gameId': game_id
                            }
                        )
                        await self.send(text_data=json.dumps({
                            'type': 'challenge_accepted',
                            'username': challenger,
                            'gameId': game_id
                        }))
                    elif response == 'decline':
                        if username in self.connected_users:
                            self.connected_users[username]['status'] = 'online'
                        if challenger in self.connected_users:
                            self.connected_users[challenger]['status'] = 'online'
                        await self.update_user_list()
                        await self.channel_layer.send(
                            challenger_channel,
                            {
                                'type': 'challenge_declined',
                                'username': username
                            }
                        )
                # Clean up challenge
                if challenge_id:
                    del self.active_challenges[challenge_id]

            elif message_type == 'join_game_room':
                username = data.get('username')
                game_id = data.get('gameId')
                
                # Set this connection's username
                self.username = username
                
                # Check if the game exists
                if game_id not in self.active_games:
                    await self.send(text_data=json.dumps({
                        'type': 'error',
                        'message': 'Game room not found'
                    }))
                    return
                
                # Check if the user is a player in this game
                if username not in self.active_games[game_id]['players']:
                    await self.send(text_data=json.dumps({
                        'type': 'error',
                        'message': 'You are not a player in this game'
                    }))
                    return
                
                # Initialize player ready status for this game if it doesn't exist
                if game_id not in self.player_ready_status:
                    self.player_ready_status[game_id] = {}
                
                # Initialize this player's ready status if it doesn't exist
                if username not in self.player_ready_status[game_id]:
                    self.player_ready_status[game_id][username] = False
                
                # Set game room properties
                self.game_id = game_id
                
                # Determine if this player is the original inviter (first player in the list)
                is_inviter = self.active_games[game_id]['players'][0] == username
                
                # Send confirmation to the player
                await self.send(text_data=json.dumps({
                    'type': 'game_room_joined',
                    'gameId': game_id,
                    'isInviter': is_inviter
                }))
                
                # Create the list of players
                players = []
                for player_name in self.active_games[game_id]['players']:
                    players.append({
                        'username': player_name,
                        'status': self.connected_users.get(player_name, {}).get('status', 'offline'),
                        'isReady': self.player_ready_status[game_id].get(player_name, False)
                    })
                
                # Send player list to ALL players in the game room, not just the joining player
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'player_list_update',
                        'players': players
                    }
                )
                
                # Add a system message to the game room
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'game_room_message',
                        'username': 'System',
                        'content': f'{username} has joined the game room.',
                        'timestamp': datetime.now().isoformat()
                    }
                )
                
                # Send current lobby user list to all players in the game room
                users = [{'username': usr, 'status': udata['status']} for usr, udata in self.connected_users.items()]
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'lobby_user_list',
                        'users': users
                    }
                )
                
            elif message_type == 'leave_game_room':
                username = data.get('username')
                game_id = data.get('gameId')
                
                # Determine if this user is the inviter (host)
                is_host = False
                if game_id in self.active_games and self.active_games[game_id]['players']:
                    is_host = self.active_games[game_id]['players'][0] == username
                
                # If not host, remove player from the room entirely
                if game_id in self.active_games and not is_host:
                    if username in self.active_games[game_id]['players']:
                        self.active_games[game_id]['players'].remove(username)
                    # Also clear their ready status
                    if game_id in self.player_ready_status:
                        self.player_ready_status[game_id].pop(username, None)
                
                # Broadcast updated player list
                if game_id in self.active_games:
                    players = []
                    for player_name in self.active_games[game_id]['players']:
                        players.append({
                            'username': player_name,
                            'status': self.connected_users.get(player_name, {}).get('status', 'offline'),
                            'isReady': self.player_ready_status.get(game_id, {}).get(player_name, False)
                        })
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {'type': 'player_list_update', 'players': players}
                    )
                
                # If host left, notify all to close the room and cleanup
                if is_host and game_id in self.active_games:
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'host_left',
                            'gameId': game_id,
                            'username': username
                        }
                    )
                    # Cleanup the game data
                    del self.active_games[game_id]
                    if game_id in self.player_ready_status:
                        del self.player_ready_status[game_id]
                
                # Note: do not remove non-host players, host removal handled above
                
            elif message_type == 'game_room_message':
                # Chat message in game room
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'game_room_message',
                        'username': data.get('username'),
                        'content': data.get('content'),
                        'timestamp': data.get('timestamp')
                    }
                )
                
            elif message_type == 'lobby_message':
                # Forward lobby chat messages to the lobby group
                lobby_group_name = 'game_lobby'
                await self.channel_layer.group_send(
                    lobby_group_name,
                    {
                        'type': 'chat_message',
                        'username': data.get('username'),
                        'content': data.get('content'),
                        'timestamp': data.get('timestamp')
                    }
                )
                
            elif message_type == 'player_ready':
                username = data.get('username')
                game_id = data.get('gameId')
                
                # Update player ready status
                if game_id in self.player_ready_status:
                    self.player_ready_status[game_id][username] = True
                    
                    # Notify all players about this player's ready status
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'player_ready',
                            'username': username,
                            'gameId': game_id
                        }
                    )
                    
                    # Add a system message
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'game_room_message',
                            'username': 'System',
                            'content': f'{username} is ready to play!',
                            'timestamp': datetime.now().isoformat()
                        }
                    )
                
            elif message_type == 'player_unready':
                username = data.get('username')
                game_id = data.get('gameId')
                
                # Update player ready status
                if game_id in self.player_ready_status:
                    self.player_ready_status[game_id][username] = False
                    
                    # Notify all players about this player's ready status
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'player_unready',
                            'username': username,
                            'gameId': game_id
                        }
                    )
                    
                    # Add a system message
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'game_room_message',
                            'username': 'System',
                            'content': f'{username} is not ready.',
                            'timestamp': datetime.now().isoformat()
                        }
                    )
                
            elif message_type == 'change_game_mode':
                game_id = data.get('gameId')
                mode = data.get('mode')
                
                # Only update if the game exists
                if game_id in self.active_games:
                    # Store the mode and options in the game data
                    self.active_games[game_id]['mode'] = mode
                    
                    # Store options if provided
                    if 'options' in data:
                        self.active_games[game_id]['options'] = data.get('options')
                    
                    # Notify all players about the mode change
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'game_mode_changed',
                            'mode': mode,
                            'gameId': game_id,
                            'options': data.get('options', {})  # Include options in the broadcast
                        }
                    )
                    
                    # Add a system message
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'game_room_message',
                            'username': 'System',
                            'content': f'Game mode set to {mode}.',
                            'timestamp': datetime.now().isoformat()
                        }
                    )
                
            elif message_type == 'all_players_ready':
                game_id = data.get('gameId')
                # Notify all players that everyone is ready, but do NOT start the game automatically
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'all_players_ready',
                        'gameId': game_id
                    }
                )
                # Add a system message
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'game_room_message',
                        'username': 'System',
                        'content': 'All players are ready! Waiting for host to start the game...',
                        'timestamp': datetime.now().isoformat()
                    }
                )
            
            elif message_type == 'reset_game':
                game_id = data.get('gameId')
                
                # Reset the game status and player ready states
                if game_id in self.active_games:
                    # Update game status back to active (not started)
                    self.active_games[game_id]['status'] = 'active'
                    
                    # Reset all players to not ready
                    if game_id in self.player_ready_status:
                        for player in self.player_ready_status[game_id]:
                            self.player_ready_status[game_id][player] = False
                    
                    # Notify all players that the game has been reset
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'game_reset',
                            'gameId': game_id
                        }
                    )
                    
                    # Update player list to show everyone as not ready
                    players = []
                    for player_name in self.active_games[game_id]['players']:
                        players.append({
                            'username': player_name,
                            'status': self.connected_users.get(player_name, {}).get('status', 'offline'),
                            'isReady': False  # Everyone is now not ready
                        })
                    
                    # Send updated player list to all players
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'player_list_update',
                            'players': players
                        }
                    )
                    
                    # Add a system message
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'game_room_message',
                            'username': 'System',
                            'content': 'Game has been reset. All players need to ready up again.',
                            'timestamp': datetime.now().isoformat()
                        }
                    )
            
            elif message_type == 'start_game':
                game_id = data.get('gameId')
                # Only start the game if it exists
                if game_id in self.active_games:
                    # Update game status to started
                    self.active_games[game_id]['status'] = 'started'
                    # Notify all players that the game has started
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {'type': 'game_started', 'gameId': game_id}
                    )
                    # System message for start
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {'type': 'game_room_message', 'username': 'System', 'content': 'Game has started!', 'timestamp': datetime.now().isoformat()}
                    )
                    # Reset statuses for next round
                    self.active_games[game_id]['status'] = 'active'
                    # Reset ready flags
                    if game_id in self.player_ready_status:
                        for player in self.player_ready_status[game_id]:
                            self.player_ready_status[game_id][player] = False
                    # Broadcast updated player_list
                    players = [
                        {'username': p, 'status': self.connected_users.get(p, {}).get('status', 'offline'), 'isReady': False}
                        for p in self.active_games[game_id]['players']
                    ]
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {'type': 'player_list_update', 'players': players}
                    )
            elif message_type == 'request_user_list':
                # Respond to client request for the current user list
                await self.update_user_list()
            else:
                # Echo back any other messages for testing
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'echo_message',
                        'message': data
                    }
                )
                
        except json.JSONDecodeError:
            # Handle invalid JSON
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': 'Invalid JSON format'
            }))
    
    async def update_user_list(self):
        users = [{'username': username, 'status': user_data['status']} 
                for username, user_data in self.connected_users.items()]
        print(f'[update_user_list] Users: {users}')
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'user_list',
                'users': users
            }
        )
    
    # Handler for user joining
    async def user_joined(self, event):
        await self.send(text_data=json.dumps({
            'type': 'user_joined',
            'username': event['username']
        }))
    
    # Handler for user leaving
    async def user_left(self, event):
        await self.send(text_data=json.dumps({
            'type': 'user_left',
            'username': event['username']
        }))
    
    # Handler for user list
    async def user_list(self, event):
        await self.send(text_data=json.dumps({
            'type': 'user_list',
            'users': event['users']
        }))
    
    # Handler for username changes
    async def username_changed(self, event):
        await self.send(text_data=json.dumps({
            'type': 'username_changed',
            'oldUsername': event['oldUsername'],
            'newUsername': event['newUsername']
        }))
    
    # Handler for chat messages
    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'chat_message',
            'username': event['username'],
            'content': event['content'],
            'timestamp': event['timestamp']
        }))
    
    # Handler for game challenges
    async def game_challenge(self, event):
        await self.send(text_data=json.dumps({
            'type': 'game_challenge',
            'challenger': event['challenger'],
            'challenge_id': event['challenge_id']
        }))
    
    # Handler for challenge acceptance
    async def challenge_accepted(self, event):
        await self.send(text_data=json.dumps({
            'type': 'challenge_accepted',
            'username': event['username'],
            'gameId': event['gameId']
        }))
    
    # Handler for challenge decline
    async def challenge_declined(self, event):
        await self.send(text_data=json.dumps({
            'type': 'challenge_declined',
            'username': event['username']
        }))
    
    # Echo handler for testing
    async def echo_message(self, event):
        await self.send(text_data=json.dumps(event['message']))
    
    # Handler for game room messages
    async def game_room_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'game_room_message',
            'username': event['username'],
            'content': event['content'],
            'timestamp': event['timestamp']
        }))
    
    # Handler for player ready status
    async def player_ready(self, event):
        await self.send(text_data=json.dumps({
            'type': 'player_ready',
            'username': event['username'],
            'gameId': event['gameId']
        }))
    
    # Handler for player unready status
    async def player_unready(self, event):
        await self.send(text_data=json.dumps({
            'type': 'player_unready',
            'username': event['username'],
            'gameId': event['gameId']
        }))
    
    # Handler for game mode changes
    async def game_mode_changed(self, event):
        await self.send(text_data=json.dumps({
            'type': 'game_mode_changed',
            'mode': event['mode'],
            'gameId': event['gameId'],
            'options': event.get('options', {})  # Include options in the response
        }))
    
    # Handler for game countdown
    async def game_countdown(self, event):
        await self.send(text_data=json.dumps({
            'type': 'game_countdown',
            'gameId': event['gameId']
        }))
    
    # Handler for all players ready (new handler)
    async def all_players_ready(self, event):
        await self.send(text_data=json.dumps({
            'type': 'all_players_ready',
            'gameId': event['gameId']
        }))
    
    # Handler for game started
    async def game_started(self, event):
        await self.send(text_data=json.dumps({
            'type': 'game_started',
            'gameId': event['gameId']
        }))
        
    # Handler for force disconnect
    async def force_disconnect(self, event):
        # Send a message to the client before closing
        await self.send(text_data=json.dumps({
            'type': 'force_disconnect',
            'message': event['message']
        }))
        
        # Close the connection
        await self.close(code=4000)  # Using a custom close code

    # Handler for player list updates
    async def player_list_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'player_list',
            'players': event['players']
        }))
    
    # Handler for game reset
    async def game_reset(self, event):
        await self.send(text_data=json.dumps({
            'type': 'game_reset',
            'gameId': event['gameId']
        }))
    
    # Handler for host left event
    async def host_left(self, event):
        await self.send(text_data=json.dumps({
            'type': 'host_left',
            'gameId': event['gameId'],
            'username': event['username']
        }))
    
    # Handler for lobby user list
    async def lobby_user_list(self, event):
        await self.send(text_data=json.dumps({
            'type': 'lobby_user_list',
            'users': event['users']
        }))