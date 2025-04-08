import json
import uuid
from datetime import datetime
from channels.generic.websocket import AsyncWebsocketConsumer

class GameConsumer(AsyncWebsocketConsumer):
    # Keep track of connected users
    connected_users = {}
    # Keep track of game challenges
    active_challenges = {}
    # Keep track of game rooms
    active_games = {}
    
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
    
    async def disconnect(self, close_code):
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
        
        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
    
    # Receive message from WebSocket
    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            message_type = data.get('type', '')
            
            # Handle different message types
            if message_type == 'join_lobby':
                self.username = data.get('username')
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
                
                # Check if new username already exists
                if new_username in self.connected_users:
                    # Send error to the requesting user
                    await self.send(text_data=json.dumps({
                        'type': 'username_error',
                        'error': 'This username is already taken.'
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
                
            elif message_type == 'game_challenge':
                challenger = data.get('challenger')
                opponent = data.get('opponent')
                
                # Create a challenge
                challenge_id = str(uuid.uuid4())
                self.active_challenges[challenge_id] = {
                    'challenger': challenger,
                    'opponent': opponent,
                    'timestamp': datetime.now().isoformat()
                }
                
                # Find opponent's channel
                if opponent in self.connected_users:
                    opponent_channel = self.connected_users[opponent]['channel_name']
                    
                    # Send challenge to opponent
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
                
                if challenger in self.connected_users:
                    challenger_channel = self.connected_users[challenger]['channel_name']
                    
                    if response == 'accept':
                        # Create a new game
                        game_id = str(uuid.uuid4())
                        self.active_games[game_id] = {
                            'players': [challenger, username],
                            'status': 'active',
                            'created_at': datetime.now().isoformat()
                        }
                        
                        # Update user statuses
                        self.connected_users[challenger]['status'] = 'in-game'
                        self.connected_users[username]['status'] = 'in-game'
                        
                        # Send updated user list
                        await self.update_user_list()
                        
                        # Notify challenger that challenge was accepted
                        await self.channel_layer.send(
                            challenger_channel,
                            {
                                'type': 'challenge_accepted',
                                'username': username,
                                'gameId': game_id
                            }
                        )
                        
                        # Notify accepter about the game
                        await self.send(text_data=json.dumps({
                            'type': 'challenge_accepted',
                            'username': challenger,
                            'gameId': game_id
                        }))
                        
                    elif response == 'decline':
                        # Notify challenger that challenge was declined
                        await self.channel_layer.send(
                            challenger_channel,
                            {
                                'type': 'challenge_declined',
                                'username': username
                            }
                        )
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
        # Create a list of users
        users = [{'username': username, 'status': user_data['status']} 
                for username, user_data in self.connected_users.items()]
        
        # Send user list to all clients in the lobby
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