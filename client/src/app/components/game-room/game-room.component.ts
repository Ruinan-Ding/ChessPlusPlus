import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription } from 'rxjs';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedDataService, ChatMessage, User } from '../../services/shared-data.service';

interface GameOptions {
  reveal?: boolean;
}

@Component({
  selector: 'app-game-room',
  providers: [WebsocketService],
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectionStatusComponent],
  templateUrl: './game-room.component.html',
  styleUrls: ['./game-room.component.scss']
})
export class GameRoomComponent implements OnInit, OnDestroy {
  gameId: string = '';
  username: string = '';
  players: User[] = [];
  lobbyUsers: User[] = [];
  gameRoomMessages: ChatMessage[] = [];
  lobbyMessages: ChatMessage[] = [];
  messageContent: string = '';
  activeTab: 'gameRoom' | 'lobby' = 'gameRoom';
  isInviter: boolean = false;
  gameMode: 'default' | 'custom' = 'default';
  isReady: boolean = false;
  countdownStarted: boolean = false;
  countdown: number = 5;
  countdownInterval: any;
  gameStarted: boolean = false;
  revealEnabled: boolean = false;
  gameOptions: GameOptions = {};
  
  private subscription: Subscription | null = null;
  private lobbySocket: WebSocket | null = null;
  // Subscriptions for shared lobby data
  private lobbyMessagesSub: Subscription | null = null;
  private lobbyUsersSub: Subscription | null = null;
  
  constructor(
    private wsService: WebsocketService,
    private route: ActivatedRoute,
    private router: Router,
    private sharedDataService: SharedDataService
  ) {}
  
  ngOnInit(): void {
    // Initialize lobby data from shared service
    this.lobbyMessages = this.sharedDataService.getLobbyMessages();
    this.lobbyUsers = this.sharedDataService.getLobbyUsers();
    // Subscribe to lobby message and user updates (real-time sync)
    this.lobbyMessagesSub = this.sharedDataService.lobbyMessages$.subscribe(msgs => {
      this.lobbyMessages = msgs;
      this.scrollChatToBottom('lobby');
    });
    this.lobbyUsersSub = this.sharedDataService.lobbyUsers$.subscribe(users => this.lobbyUsers = users);

    // Get username from localStorage
    this.username = localStorage.getItem('username') || '';
    if (!this.username) {
      // Redirect to login if no username
      this.router.navigate(['/login']);
      return;
    }

    // Now that username is set, setup a separate WebSocket for lobby chat
    this.lobbySocket = new WebSocket(`ws://localhost:8000/ws/game/lobby/`);
    this.lobbySocket.onopen = () => {
      // Join the lobby with valid username
      this.lobbySocket!.send(JSON.stringify({ type: 'join_lobby', username: this.username }));
    };
    this.lobbySocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'chat_message' || data.type === 'system' || data.type === 'user_joined' || data.type === 'user_left' || data.type === 'username_changed') {
        // Convert system/user events to system chat messages
        let lobbyMsg: ChatMessage;
        if (data.type === 'chat_message') {
          lobbyMsg = {
            username: data.username,
            content: data.content,
            timestamp: data.timestamp,
            room: 'lobby',
            type: undefined
          };
        } else if (data.type === 'user_joined') {
          lobbyMsg = {
            username: 'System',
            content: `${data.username} has joined the lobby.`,
            timestamp: new Date().toISOString(),
            room: 'lobby',
            type: 'system'
          };
        } else if (data.type === 'user_left') {
          lobbyMsg = {
            username: 'System',
            content: `${data.username} has left the lobby.`,
            timestamp: new Date().toISOString(),
            room: 'lobby',
            type: 'system'
          };
        } else if (data.type === 'username_changed') {
          lobbyMsg = {
            username: 'System',
            content: `${data.oldUsername} has changed their name to ${data.newUsername}.`,
            timestamp: new Date().toISOString(),
            room: 'lobby',
            type: 'system'
          };
        } else {
          return;
        }
        this.sharedDataService.addLobbyMessage(lobbyMsg);
        this.scrollChatToBottom('lobby');
      }
    };

    // Get game ID from route parameters
    this.route.params.subscribe(params => {
      this.gameId = params['id'];
      
      // Connect to the game room - use just the gameId, not "game/"
      this.wsService.connect(this.gameId);
      
      // Wait for connection to be established before sending join message
      const connectionSub = this.wsService.connectionStatus$.subscribe(connected => {
        if (connected) {
          // Send join message only after connection is established
          this.wsService.sendMessage({
            type: 'join_game_room',
            username: this.username,
            gameId: this.gameId
          });
          
          // Get cached lobby messages (without adding the room property)
          this.lobbyMessages = this.sharedDataService.getLobbyMessages();
          
          connectionSub.unsubscribe();
        }
      });
      
      // Subscribe to WebSocket messages
      this.subscription = this.wsService.messages$.subscribe(message => {
        if (!message) return;
        this.handleWebSocketMessage(message);
      });
    });
  }
  
  ngOnDestroy(): void {
    // Unsubscribe from shared lobby data
    if (this.lobbyMessagesSub) {
      this.lobbyMessagesSub.unsubscribe();
    }
    if (this.lobbyUsersSub) {
      this.lobbyUsersSub.unsubscribe();
    }

    // Clear any intervals
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    
    // Send leave message
    this.wsService.sendMessage({
      type: 'leave_game_room',
      username: this.username,
      gameId: this.gameId
    });
    
    // Disconnect
    this.wsService.disconnect();
    
    // Unsubscribe
    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    // Close lobby socket when leaving
    if (this.lobbySocket) {
      this.lobbySocket.close(1000);
    }
  }
  
  handleWebSocketMessage(message: any): void {
    switch (message.type) {
      case 'game_room_joined':
        // Set isInviter flag if this user is the original inviter
        this.isInviter = message.isInviter;
        break;
        
      case 'player_list':
        // Store the players list
        this.players = message.players;
        
        // Manually mark the inviter player based on active_games first player
        // When we get the player list after joining, we already know if this user is the inviter
        if (this.isInviter) {
          // If current user is inviter, mark themselves
          this.players = this.players.map(player => {
            if (player.username === this.username) {
              return { ...player, isInviter: true };
            }
            return { ...player, isInviter: false };
          });
        } else {
          // If not inviter, check player list and find the inviter
          // Typically the first player who created the game
          if (this.players.length > 0) {
            const firstPlayer = this.players[0];
            this.players = this.players.map(player => {
              if (player.username === firstPlayer.username) {
                return { ...player, isInviter: true };
              }
              return { ...player, isInviter: false };
            });
          }
        }
        
        // Remove chat messages from users no longer in the player list
        const playerUsernames = new Set(this.players.map(p => p.username));
        this.gameRoomMessages = this.gameRoomMessages.filter(msg => msg.username === 'System' || playerUsernames.has(msg.username));
        
        // Check if all players are ready
        this.checkAllPlayersReady();
        break;
        
      case 'lobby_user_list':
        this.lobbyUsers = message.users;
        // Update shared lobby user list
        this.sharedDataService.updateLobbyUsers(message.users);
        break;
        
      case 'game_room_message':
        this.gameRoomMessages.push({
          username: message.username,
          content: message.content,
          timestamp: message.timestamp,
          room: 'gameRoom',
          type: message.type === 'system' ? 'system' : undefined
        });
        this.scrollChatToBottom('gameRoom');
        break;
        
      case 'lobby_message':
        const lobbyMsg: ChatMessage = {
          username: message.username,
          content: message.content,
          timestamp: message.timestamp,
          room: 'lobby',
          type: message.type === 'system' ? 'system' : undefined
        };
        this.lobbyMessages.push(lobbyMsg);
        // Update shared lobby messages
        this.sharedDataService.addLobbyMessage(lobbyMsg);
        this.scrollChatToBottom('lobby');
        break;
        
      case 'player_ready':
        // Update player ready status
        this.players = this.players.map(player => {
          if (player.username === message.username) {
            return { ...player, isReady: true };
          }
          return player;
        });
        
        // Check if this is the current user
        if (message.username === this.username) {
          this.isReady = true;
        }
        
        // Check if all players are ready
        this.checkAllPlayersReady();
        break;
        
      case 'player_unready':
        // Update player ready status to unready
        this.players = this.players.map(player => {
          if (player.username === message.username) {
            return { ...player, isReady: false };
          }
          return player;
        });
        
        // Check if this is the current user
        if (message.username === this.username) {
          this.isReady = false;
        }
        break;
        
      case 'game_mode_changed':
        this.gameMode = message.mode;
        
        // Update game options if they were included in the message
        if (message.options) {
          this.gameOptions = message.options;
          // Update UI to match options
          this.revealEnabled = message.options.reveal || false;
        }
        break;
        
      case 'game_countdown':
        this.startCountdown();
        break;
        
      case 'game_started':
        // Add a system message and unready all players
        this.addSystemMessage('Game started! Get ready to play!');
        this.players = this.players.map(player => ({ ...player, isReady: false }));
        this.isReady = false;
        break;

      case 'game_reset':
        // Reset local ready states and notify
        this.players = this.players.map(player => ({ ...player, isReady: false }));
        this.isReady = false;
        // Clear auto-start flag for next round
        this.gameStarted = false;
        this.addSystemMessage('Game has been reset. All players need to ready up again.');
        // Auto-ready inviter so they can start the next game
        if (this.isInviter) {
          this.wsService.sendMessage({
            type: 'player_ready',
            username: this.username,
            gameId: this.gameId
          });
        }
        break;

      case 'host_left':
        // Notify players the host has left and trigger leaving the room
        this.addSystemMessage(`Host ${message.username} has left. Closing the room...`);
        // Give user a moment to read then perform leave sequence
        setTimeout(() => {
          this.leaveGameRoom();
        }, 2000);
        break;

      case 'error':
        // Handle case when game room no longer exists (e.g., host disconnected)
        if (message.message === 'Game room not found') {
          this.addSystemMessage('Game room no longer exists. Returning to lobby...');
          setTimeout(() => {
            this.wsService.disconnect();
            this.router.navigate(['/lobby']);
          }, 2000);
        }
        break;
    }
  }
  
  sendMessage(): void {
    if (!this.messageContent.trim()) return;
    const content = this.messageContent.trim();
    const timestamp = new Date().toISOString();
    // Handle chat send based on active tab
    if (this.activeTab === 'gameRoom') {
      // Only send to server; do NOT add locally. Wait for server echo.
      this.wsService.sendMessage({
        type: 'game_room_message',
        username: this.username,
        content: content,
        gameId: this.gameId,
        timestamp: timestamp
      });
      // Clear input
      this.messageContent = '';
      return;
    } else {
      // Send via separate lobby socket
      this.lobbySocket?.send(JSON.stringify({ type: 'chat_message', username: this.username, content, timestamp }));
      // Clearing input; message will arrive via onmessage
      this.messageContent = '';
      return;
    }
  }
  
  changeTab(tab: 'gameRoom' | 'lobby'): void {
    this.activeTab = tab;
    // Wait for DOM update then scroll
    setTimeout(() => {
      this.scrollChatToBottom(tab);
    }, 100);
  }
  
  toggleReady(): void {
    // Toggle the ready status
    const toggleAction = this.isReady ? 'player_unready' : 'player_ready';
    
    this.wsService.sendMessage({
      type: toggleAction,
      username: this.username,
      gameId: this.gameId
    });
    
    // We'll let the server response update our local state
    // instead of updating it directly here
  }
  
  changeGameMode(mode: 'default' | 'custom'): void {
    if (!this.isInviter) return;
    
    this.gameMode = mode;
    if (mode === 'default') {
      // Reset options when switching to default mode
      this.revealEnabled = false;
      this.gameOptions = {};
    }
    
    // Include game options only if they exist and we're in custom mode
    const messageData: any = {
      type: 'change_game_mode',
      mode: mode,
      gameId: this.gameId
    };
    
    // Only include options if in custom mode
    if (mode === 'custom' && Object.keys(this.gameOptions).length > 0) {
      messageData.options = this.gameOptions;
    }
    
    this.wsService.sendMessage(messageData);
  }
  
  updateGameOptions(): void {
    if (!this.isInviter || this.gameMode !== 'custom') return;
    
    // Update game options based on checkbox states
    this.gameOptions = {
      reveal: this.revealEnabled
    };
    
    // Instead of sending a new message type, use the existing change_game_mode type
    // This ensures backward compatibility with the server
    this.wsService.sendMessage({
      type: 'change_game_mode',
      mode: 'custom',
      gameId: this.gameId,
      options: this.gameOptions
    });
    
    // Add system message about the options change
    this.addSystemMessage(`Game options updated: Reveal ${this.revealEnabled ? 'enabled' : 'disabled'}`);
  }
  
  private checkAllPlayersReady(): void {
    const allReady = this.players.length > 0 && this.players.every(player => player.isReady);

    // Enable Start Game button
    // Do NOT automatically start the game here. Only enable the button for the host.
    // The host must manually press the Start Game button to start the game.
  }
  
  private startCountdown(): void {
    this.countdownStarted = true;
    this.countdown = 3; // Changed from 5 to 3
    
    this.countdownInterval = setInterval(() => {
      this.countdown--;
      
      if (this.countdown <= 0) {
        clearInterval(this.countdownInterval);
        this.countdownStarted = false; // Hide the countdown when it reaches 0
      }
    }, 1000);
  }
  
  private scrollChatToBottom(chatType: 'gameRoom' | 'lobby'): void {
    setTimeout(() => {
      const selector = chatType === 'gameRoom' ? '.game-room-messages' : '.lobby-messages';
      const chatContainer = document.querySelector(selector);
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }, 100);
  }
  
  private addSystemMessage(content: string): void {
    // Create a chat message without the room property
    const message: ChatMessage = {
      username: 'System',
      content: content,
      timestamp: new Date().toISOString(),
      type: 'system'
    };
    
    // Add to the appropriate message array
    if (this.activeTab === 'gameRoom') {
      this.gameRoomMessages.push(message);
    } else {
      this.lobbyMessages.push(message);
    }
    
    this.scrollChatToBottom(this.activeTab);
  }
  
  leaveGameRoom(): void {
    // First, send leave message and properly disconnect
    this.wsService.sendMessage({
      type: 'leave_game_room',
      username: this.username,
      gameId: this.gameId
    });
    
    // Set a flag to indicate we're intentionally leaving
    localStorage.setItem('intentionalDisconnect', 'true');
    
    // Disconnect the websocket
    this.wsService.disconnect();
    
    // Clear any intervals to avoid memory leaks
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    
    // Wait briefly for the server to process the leave message
    setTimeout(() => {
      // Navigate to lobby after the leave message has been processed
      this.router.navigate(['/lobby']);
    }, 300);
  }

  /**
   * Determines if the game can be started by the inviter.
   * At least one other player must be present and everyone must be ready.
   */
  canStartGame(): boolean {
    // Game can start if:
    // 1. There are at least 2 players (inviter + at least one other player)
    // 2. All players are ready
    return this.players.length >= 2 && this.players.every(player => player.isReady);
  }
  
  /**
   * Starts the game immediately without countdown
   * Only the inviter can start the game
   */
  startGame(): void {
    if (!this.isInviter) return;
    
    // Immediately start the game
    this.wsService.sendMessage({
      type: 'start_game',
      gameId: this.gameId
    });
  }
  
  // Stub for context menu on lobby user items
  openUserMenu(event: MouseEvent, user: User): void {
    event.preventDefault();

    // Don't allow inviting yourself
    if (user.username === this.username) return;

    // Get current user's status
    const currentUserStatus = this.lobbyUsers.find(u => u.username === this.username)?.status;

    // Enforce invitation rules (mirror lobby logic):
    let canInvite = false;
    let disabledReason = '';

    if (currentUserStatus === 'invited' && user.status === 'invited') {
      canInvite = false;
      disabledReason = 'Cannot invite another invited player';
    } else if (currentUserStatus === 'online' && user.status === 'invited') {
      canInvite = false;
      disabledReason = 'Cannot invite an invited player';
    } else if (currentUserStatus === 'invited' && user.status === 'online') {
      canInvite = true;
    } else if (currentUserStatus === 'online' && user.status === 'online') {
      canInvite = true;
    } else {
      canInvite = false;
      disabledReason = 'Cannot invite this player';
    }

    // Remove any existing menus first
    const existingMenus = document.querySelectorAll('.user-context-menu');
    existingMenus.forEach(menu => document.body.removeChild(menu));

    // Create the context menu
    const menu = document.createElement('div');
    menu.className = 'user-context-menu';
    menu.innerHTML = canInvite ?
      `<button>Invite</button>` :
      `<button disabled>${disabledReason}</button>`;
    menu.style.position = 'absolute';

    // Position the menu relative to the button if possible
    if (event.target instanceof HTMLButtonElement && event.target.classList.contains('action-button')) {
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 5}px`;
    } else {
      menu.style.left = `${event.pageX}px`;
      menu.style.top = `${event.pageY}px`;
    }

    // Add event listener for invite button
    menu.querySelector('button')?.addEventListener('click', () => {
      if (canInvite) {
        this.inviteLobbyUser(user.username);
      }
      document.body.removeChild(menu);
    });

    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        document.body.removeChild(menu);
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 100);
  }

  inviteLobbyUser(opponent: string): void {
    // Only prevent inviting if there's already an active invite dialog
    // (You may want to add more logic here if needed)
    this.wsService.sendMessage({
      type: 'game_challenge',
      challenger: this.username,
      opponent: opponent
    });
  }
}