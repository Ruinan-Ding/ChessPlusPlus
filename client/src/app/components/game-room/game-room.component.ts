import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription, Subject } from 'rxjs';
import { takeUntil, take, filter } from 'rxjs/operators';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedDataService, ChatMessage, User } from '../../services/shared-data.service';
import { LobbyService } from '../../services/lobby.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { GameStateService } from '../../services/game-state.service';
import { GameBoardComponent } from '../game-board/game-board.component';

interface GameOptions {
  reveal?: boolean;
}

@Component({
  selector: 'app-game-room',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectionStatusComponent, GameBoardComponent],
  templateUrl: './game-room.component.html',
  styleUrls: ['./game-room.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GameRoomComponent implements OnInit, OnDestroy {
  gameId: string = '';
  username: string = '';
  accessToken: string = '';  // Token for secure game room access
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
  countdownValue: number = 3;
  countdownInterval: ReturnType<typeof setInterval> | null = null;
  countdownCancelled: boolean = false;
  gameStarted: boolean = false;
  revealEnabled: boolean = false;
  gameOptions: GameOptions = {};
  
  // Reveal mode request modals
  showRevealWaitingModal: boolean = false;  // Host waits for opponent response
  showRevealRequestModal: boolean = false;  // Opponent receives request
  revealRequestCountdown: number = 5;
  revealRequestCountdownInterval: ReturnType<typeof setInterval> | null = null;
  revealRequester: string = '';  // Username of player who requested reveal
  otherPlayerConfiguring: boolean = false;
  
  private subscription: Subscription | null = null;
  // Subscriptions for shared lobby data
  private lobbyMessagesSub: Subscription | null = null;
  private lobbyUsersSub: Subscription | null = null;
  private destroy$ = new Subject<void>();
  
  constructor(
    private wsService: WebsocketService,
    private route: ActivatedRoute,
    private router: Router,
    private sharedDataService: SharedDataService,
    private navigationState: NavigationStateService,
    private lobbyService: LobbyService,
    private cdr: ChangeDetectorRef,
    public gameState: GameStateService
  ) {}
  
  ngOnInit(): void {
    // Only clear messages if not returning from setup
    const isReturningFromSetup = this.navigationState.getNavigationContext() === 'game-room' && 
                                  this.navigationState.isIntentionalNavigation();
    if (isReturningFromSetup) {
      // Restore chat from localStorage if available
      const saved = localStorage.getItem('gameRoomMessages');
      if (saved) {
        try {
          this.gameRoomMessages = JSON.parse(saved);
        } catch {
          this.gameRoomMessages = [];
        }
        localStorage.removeItem('gameRoomMessages');
      }
      // Restore game mode and options if available
      const savedMode = localStorage.getItem('gameRoomMode');
      if (savedMode === 'default' || savedMode === 'custom') {
        this.gameMode = savedMode;
      }
      const savedReveal = localStorage.getItem('gameRoomReveal');
      if (savedReveal !== null) {
        try {
          this.revealEnabled = JSON.parse(savedReveal);
        } catch { this.revealEnabled = false; }
      }
      const savedOptions = localStorage.getItem('gameRoomOptions');
      if (savedOptions) {
        try {
          this.gameOptions = JSON.parse(savedOptions);
        } catch { this.gameOptions = {}; }
      }
      localStorage.removeItem('gameRoomMode');
      localStorage.removeItem('gameRoomReveal');
      localStorage.removeItem('gameRoomOptions');
    } else {
      // Clear any prior game room messages to avoid stale system logs
      this.gameRoomMessages = [];
    }

    // Initialize lobby data from shared service
    this.lobbyMessages = this.sharedDataService.getLobbyMessages();
    this.lobbyUsers = this.sharedDataService.getLobbyUsers();
    // Subscribe to lobby message and user updates (real-time sync)
    this.lobbyMessagesSub = this.sharedDataService.lobbyMessages$.pipe(takeUntil(this.destroy$)).subscribe(msgs => {
      this.lobbyMessages = msgs;
      this.scrollChatToBottom('lobby');
    });
    this.lobbyUsersSub = this.sharedDataService.lobbyUsers$.pipe(takeUntil(this.destroy$)).subscribe(users => this.lobbyUsers = users);

    // Get username from localStorage
    this.username = localStorage.getItem('username') || '';
    if (!this.username) {
      // Redirect to login if no username
      this.router.navigate(['/login']);
      return;
    }

    // Note: Do NOT connect LobbyService here - we use wsService for all messages
    // The backend will route lobby chat messages appropriately

    // Get game ID from route parameters and token from query params
    this.route.params.pipe(takeUntil(this.destroy$)).subscribe(params => {
      this.gameId = params['id'];
      
      // Extract token from query parameters
      this.route.queryParams.pipe(take(1)).subscribe(queryParams => {
        this.accessToken = queryParams['token'] || '';
        
        if (!this.accessToken) {
          console.error('[GameRoom] No access token provided - unauthorized access attempt');
          this.router.navigate(['/lobby']);
          return;
        }
        
        console.log('[GameRoom] Connecting to game room:', this.gameId, 'with token');
        
        // Check if returning from setup (already connected)
        const isReturningFromSetup = this.navigationState.getNavigationContext() === 'game-room' && 
                                      this.navigationState.isIntentionalNavigation();
        
        if (isReturningFromSetup) {
          console.log('[GameRoom] Returning from setup, clearing navigation state');
          this.navigationState.clearIntentionalNavigation();
        }
        
        // Check if already connected to this game room
        if (this.wsService.isConnected()) {
          console.log('[GameRoom] Already connected, sending join_game_room message immediately');
          this.wsService.sendMessage({
            type: 'join_game_room',
            username: this.username,
            gameId: this.gameId,
            token: this.accessToken
          });
          this.lobbyMessages = this.sharedDataService.getLobbyMessages();
        } else {
          // Connect to the game room - use just the gameId, not "game/"
          this.wsService.connect(this.gameId);
          
          // Wait for connection to be established before sending join message
          // Use filter to wait for true value, not just take the first emission
          const connectionSub = this.wsService.connectionStatus$.pipe(
            filter(connected => connected === true),
            take(1)
          ).subscribe(connected => {
            console.log('[GameRoom] Connection established, sending join_game_room message');
            
            // Send join message only after connection is established
            this.wsService.sendMessage({
              type: 'join_game_room',
              username: this.username,
              gameId: this.gameId,
              token: this.accessToken
            });
            
            console.log('[GameRoom] join_game_room message sent');
            
            // Get cached lobby messages (without adding the room property)
            this.lobbyMessages = this.sharedDataService.getLobbyMessages();
          });
        }
      });
      
      // Subscribe to WebSocket messages
      this.subscription = this.wsService.messages$.pipe(takeUntil(this.destroy$)).subscribe(message => {
        if (!message) return;
        this.handleWebSocketMessage(message);
      });
    });
  }
  
  ngOnDestroy(): void {
    // Signal teardown to all subscriptions
    this.destroy$.next();
    this.destroy$.complete();

    // Clear any intervals
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.revealRequestCountdownInterval !== null) {
      clearInterval(this.revealRequestCountdownInterval);
      this.revealRequestCountdownInterval = null;
    }
    
    // Reset game state service
    this.gameState.reset();
    
    // Check if we're intentionally navigating back to lobby
    const isIntentionalNav = this.navigationState.isIntentionalNavigation();
    
    // Only send leave message if not already sent via leaveGameRoom()
    if (!isIntentionalNav) {
      this.wsService.sendMessage({
        type: 'leave_game_room',
        username: this.username,
        gameId: this.gameId
      });
      this.wsService.disconnect();
    }

    // DO NOT disconnect LobbyService here - if returning to lobby, maintain the connection
    // The lobby component will handle its own connection lifecycle
    
    // No need to manually unsubscribe subscriptions that used takeUntil(this.destroy$)
  }
  
  handleWebSocketMessage(message: any): void {
    // Handle broadcast_message wrapper (unwrap to actual message type)
    let actualMessage = message;
    if (message.type === 'broadcast_message' && message.data) {
      actualMessage = message.data;
    }
    switch (actualMessage.type) {
      case 'game_start_placeholder':
        // Set all players' status to 'in-game' (red)
        this.players = this.players.map(player => ({
          ...player,
          status: 'in-game'
        }));
        // Also update lobbyUsers if present
        this.lobbyUsers = this.lobbyUsers.map(user =>
          this.players.some(p => p.username === user.username)
            ? { ...user, status: 'in-game' }
            : user
        );
        this.cdr.markForCheck();
        break;
      case 'game_started':
        // Real game initialisation — reset and load the initial state via GameStateService
        this.gameStarted = true;
        this.isReady = false;  // Reset ready state - button reverts to "Ready" and will be disabled
        // Ensure clean slate by resetting game state first
        this.gameState.reset();
        this.gameState.applyGameStarted(actualMessage);
        
        const myColor = actualMessage.playerWhite === this.username ? 'White' : 'Black';
        this.addSystemMessage(`Game started! You are playing as ${myColor}.`);
        this.addSystemMessage(`${actualMessage.playerWhite} (White) moves first.`);
        this.cdr.markForCheck();
        break;
      case 'move_made':
        // Update local state when a move is broadcast
        this.gameState.applyMoveMade(actualMessage);
        {
          const move = actualMessage.move;
          let moveText = `${move.color} ${move.unit_id}: ${move.from} → ${move.to}`;
          if (move.attacked) {
            moveText += ` — dealt ${move.damage_dealt} dmg`;
            if (move.defender_eliminated) {
              moveText += ` (eliminated ${move.attacked})`;
            } else {
              moveText += ` (${move.attacked} survives, ${move.defender_hp} HP)`;
            }
          }
          this.addSystemMessage(moveText);
        }
        this.cdr.markForCheck();
        break;
      case 'game_over':
        this.gameStarted = false;
        this.gameState.applyGameOver(actualMessage);
        if (actualMessage.winner) {
          this.addSystemMessage(`Game over — ${actualMessage.winner} wins by ${actualMessage.endReason}!`);
        } else {
          this.addSystemMessage(`Game over — Draw (${actualMessage.endReason}).`);
        }
        this.cdr.markForCheck();
        break;
      case 'game_state_update':
        // Full state refresh (e.g., on reconnect)
        this.gameState.applyFullState(actualMessage);
        if (actualMessage.winner) {
          this.addSystemMessage(`Game ended — winner: ${actualMessage.winner}`);
        }
        this.cdr.markForCheck();
        break;
      case 'draw_offered':
        this.gameState.applyDrawOffered(actualMessage.offeredBy);
        this.addSystemMessage(`${actualMessage.offeredBy} offered a draw.`);
        this.cdr.markForCheck();
        break;
      case 'draw_response':
        this.gameState.clearDrawOffer();
        if (!actualMessage.accepted) {
          this.addSystemMessage(`${actualMessage.declinedBy} declined the draw offer.`);
        }
        this.cdr.markForCheck();
        break;
      case 'invalid_move':
        this.addSystemMessage(`Invalid move: ${actualMessage.message}`);
        this.cdr.markForCheck();
        break;
      case 'game_room_joined':
        // Set isInviter flag if this user is the original inviter
        this.isInviter = actualMessage.isInviter;
        break;
      case 'join_game_room_success':
        // Sent after joining the game room – if the game was already started,
        // request a full state resync (reconnection).
        if (actualMessage.gameStatus === 'started') {
          this.gameStarted = true;
          this.wsService.sendMessage({ type: 'request_game_state' });
          this.addSystemMessage('Reconnected — syncing game state…');
          this.cdr.markForCheck();
        }
        break;
      case 'player_list':
      case 'player_list_update': {
        // Handle both message types from backend
        console.log('[GameRoom] Received player list:', actualMessage);
        if (!Array.isArray(actualMessage.players)) {
          console.error('[GameRoom] Invalid player list - missing players array');
          break;
        }
        const previousReadyState = new Map(this.players.map(p => [p.username, p.isReady]));
        this.players = actualMessage.players.map((player: User) => ({
          ...player,
          isReady: typeof player.isReady === 'boolean'
            ? player.isReady
            : (previousReadyState.get(player.username) ?? false)
        }));
        const currentUser = this.players.find(p => p.username === this.username);
        if (currentUser && typeof currentUser.isInviter !== 'undefined') {
          this.isInviter = currentUser.isInviter === true;
        } else if (typeof actualMessage.isInviter !== 'undefined') {
          this.isInviter = actualMessage.isInviter;
        }
        console.log('[GameRoom] Players array:', this.players);
        console.log('[GameRoom] Current user:', this.username);
        console.log('[GameRoom] isInviter:', this.isInviter);
        const playerNames = new Set(this.players.map(p => p.username));
        this.gameRoomMessages = this.gameRoomMessages.filter(
          msg => msg.username === 'System' || playerNames.has(msg.username)
        );
        this.checkAllPlayersReady();
        this.cdr.markForCheck();
        break;
      }
      case 'game_countdown_cancelled':
        // Stop the countdown and reset ready state for all players
        if (this.countdownInterval !== null) {
          clearInterval(this.countdownInterval);
          this.countdownInterval = null;
        }
        this.countdownStarted = false;
        this.countdownValue = 3;
        this.isReady = false;
        this.players = this.players.map(player => ({ ...player, isReady: false }));
        this.addSystemMessage('Game countdown cancelled.');
        this.cdr.markForCheck();
        break;
        
      case 'lobby_user_list':
        console.log('[GameRoom] Received lobby_user_list:', actualMessage.users);
        this.lobbyUsers = actualMessage.users;
        this.sharedDataService.updateLobbyUsers(actualMessage.users);
        this.cdr.markForCheck();
        break;
      case 'user_list':
        console.log('[GameRoom] Received user_list:', actualMessage.users);
        this.lobbyUsers = actualMessage.users;
        this.sharedDataService.updateLobbyUsers(actualMessage.users);
        this.cdr.markForCheck();
        break;
        
      case 'game_room_message':
        // If system message about mode/options, remove prior ones to avoid stale gray messages
        if (actualMessage.username === 'System' && typeof actualMessage.content === 'string') {
          const c = actualMessage.content;
          if (c.includes('Game mode changed') || c.includes('Game options updated')) {
            this.gameRoomMessages = this.gameRoomMessages.filter(msg => {
              if (msg.username !== 'System') return true;
              const mc = msg.content || '';
              return !mc.includes('Game mode changed') && !mc.includes('Game options updated');
            });
          }
        }

        // Create a new array reference instead of mutating to ensure OnPush change detection works
        this.gameRoomMessages = [...this.gameRoomMessages, {
          username: actualMessage.username,
          content: actualMessage.content,
          timestamp: actualMessage.timestamp,
          room: 'gameRoom',
          type: (actualMessage.messageType === 'system' || actualMessage.username === 'System') ? 'system' : undefined
        }];
        this.scrollChatToBottom('gameRoom');
        this.cdr.markForCheck();
        break;
      
      case 'chat_message':
        // Handle lobby chat messages received while in game room
        console.log('[GameRoom] Received lobby chat_message:', actualMessage);
        // Only add via sharedDataService - the subscription to lobbyMessages$ will update our local array
        this.sharedDataService.addLobbyMessage({
          username: actualMessage.username,
          content: actualMessage.content,
          timestamp: actualMessage.timestamp || new Date().toISOString(),
          room: 'lobby'
        });
        this.scrollChatToBottom('lobby');
        this.cdr.markForCheck();
        break;
        
      case 'lobby_message':
        break;
        
      case 'player_ready':
        // Update player ready status
        this.players = this.players.map(player => {
          if (player.username === actualMessage.username) {
            return { ...player, isReady: true };
          }
          return player;
        });
        
        // Check if this is the current user
        if (actualMessage.username === this.username) {
          this.isReady = true;
        }
        
        // Add system message
        this.addSystemMessage(`${actualMessage.username} is ready.`);
        
        // Check if all players are ready
        this.checkAllPlayersReady();
        this.cdr.markForCheck();
        break;
        
      case 'player_unready':
        // Update player ready status to unready
        this.players = this.players.map(player => {
          if (player.username === actualMessage.username) {
            return { ...player, isReady: false };
          }
          return player;
        });

        // Check if this is the current user
        if (actualMessage.username === this.username) {
          this.isReady = false;
        }

        // Only add system message if not silent
        if (!actualMessage.silent) {
          this.addSystemMessage(`${actualMessage.username} is not ready.`);
        }
        this.cdr.markForCheck();
        break;
        
      case 'game_mode_changed':
        this.gameMode = actualMessage.mode;
        
        // Update game options if they were included in the message
        if (actualMessage.options) {
          this.gameOptions = actualMessage.options;
          // Update UI to match options
          this.revealEnabled = actualMessage.options.reveal || false;
        } else if (actualMessage.mode === 'default') {
          // Reset any custom options when returning to default mode
          this.gameOptions = {};
          this.revealEnabled = false;
        }

        // Add system message about mode change
        const modeText = actualMessage.mode === 'default' ? 'Default Mode' : 'Custom Mode';
        let optionsText = '';
        if (actualMessage.mode === 'custom' && actualMessage.options) {
          const optionList = Object.entries(actualMessage.options)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          if (optionList) {
            optionsText = ` (Options: ${optionList})`;
          }
        }
        this.addSystemMessage(`Game mode changed to ${modeText}${optionsText}`);
        
        // Trigger change detection
        this.cdr.markForCheck();
        break;

      case 'reveal_mode_requested':
        // Other player is requesting to toggle reveal mode - show modal popup (no countdown)
        this.revealRequester = actualMessage.username;
        this.showRevealRequestModal = true;
        this.cdr.markForCheck();
        break;

      case 'reveal_request_accepted':
        // The other player accepted our reveal request - NOW start the 5 second cooldown for host
        if (this.revealRequestCountdownInterval) {
          clearInterval(this.revealRequestCountdownInterval);
          this.revealRequestCountdownInterval = null;
        }
        this.showRevealWaitingModal = true;  // Show waiting modal with countdown
        this.revealEnabled = actualMessage.enabled;
        this.gameOptions = { ...this.gameOptions, reveal: actualMessage.enabled };
        
        // Start 5 second cooldown for host
        this.revealRequestCountdown = 5;
        this.revealRequestCountdownInterval = setInterval(() => {
          this.revealRequestCountdown--;
          this.cdr.markForCheck();
          
          if (this.revealRequestCountdown <= 0) {
            // Cooldown complete
            if (this.revealRequestCountdownInterval) {
              clearInterval(this.revealRequestCountdownInterval);
              this.revealRequestCountdownInterval = null;
            }
            this.showRevealWaitingModal = false;
            this.addSystemMessage(`Reveal mode has been ${actualMessage.enabled ? 'enabled' : 'disabled'}.`);
            this.cdr.markForCheck();
          }
        }, 1000);
        
        this.addSystemMessage(`${actualMessage.username} has accepted your Reveal request!`);
        this.cdr.markForCheck();
        break;

      case 'reveal_request_declined':
        // The other player declined our reveal request  
        if (this.revealRequestCountdownInterval) {
          clearInterval(this.revealRequestCountdownInterval);
          this.revealRequestCountdownInterval = null;
        }
        this.showRevealWaitingModal = false;
        this.revealEnabled = false;
        this.addSystemMessage(`${actualMessage.username} has declined your Reveal request.`);
        this.cdr.markForCheck();
        break;

      case 'reveal_request_timeout':
        // Reveal request timed out (opponent didn't respond)
        if (this.revealRequestCountdownInterval) {
          clearInterval(this.revealRequestCountdownInterval);
          this.revealRequestCountdownInterval = null;
        }
        this.showRevealRequestModal = false;
        this.showRevealWaitingModal = false;
        this.revealEnabled = false;
        this.addSystemMessage('Reveal mode request timed out.');
        this.cdr.markForCheck();
        break;

      case 'player_status_changed':
        // Update other player's configuring status
        if (actualMessage.username !== this.username) {
          this.otherPlayerConfiguring = actualMessage.status === 'configuring';
          this.cdr.markForCheck();
        }
        break;

      case 'partner_left':
        // Other player has left the game room - navigate back to lobby
        // Do NOT call leaveGameRoom() as that would send another leave_game_room message
        this.addSystemMessage(`${actualMessage.username} has left the game room. Returning to lobby...`);
        
        // Only the HOST (inviter/person with crown) gets the cooldown, even when kicked
        // This prevents the host from spam-inviting
        console.log('[GameRoom] partner_left: isInviter:', this.isInviter);
        if (this.isInviter) {
          this.navigationState.setIntentionalNavigation('none'); // Triggers cooldown
        } else {
          this.navigationState.setIntentionalNavigation('lobby'); // No cooldown
        }
        
        // Clear any intervals
        if (this.countdownInterval !== null) {
          clearInterval(this.countdownInterval);
          this.countdownInterval = null;
        }
        
        // Navigate to lobby after a brief delay
        setTimeout(() => {
          console.log('[GameRoom] Partner left, navigating to lobby');
          this.router.navigate(['/lobby']);
        }, 300);
        break;

      case 'challenge_declined':
        this.addSystemMessage(`${actualMessage.username} has declined your invitation.`);
        // Request a fresh user list from the server to ensure real-time sync
        this.wsService.sendMessage({ type: 'request_user_list' });
        break;

      case 'error':
        // Handle case when game room no longer exists (e.g., host disconnected)
        if (message.message === 'Game room not found') {
          this.addSystemMessage('Game room no longer exists. Returning to lobby...');
          // Set intentional navigation to prevent ngOnDestroy from sending leave_game_room
          this.navigationState.setIntentionalNavigation('lobby');
          setTimeout(() => {
            this.wsService.disconnect();
            this.router.navigate(['/lobby']);
          }, 300);
        }
        // Handle token-related errors (unauthorized access attempts)
        if (message.code === 'INVALID_TOKEN' || message.code === 'TOKEN_EXPIRED' || message.code === 'NOT_IN_GAME') {
          console.error('[GameRoom] Access denied:', message.message);
          this.addSystemMessage(`Access denied: ${message.message}. Returning to lobby...`);
          // Set intentional navigation to prevent ngOnDestroy from sending leave_game_room
          // (we were never actually in the game, so no leave message should be sent)
          this.navigationState.setIntentionalNavigation('lobby');
          setTimeout(() => {
            this.wsService.disconnect();
            this.router.navigate(['/lobby']);
          }, 300);
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
      // Send lobby chat via wsService - backend will route to lobby group
      this.wsService.sendMessage({ 
        type: 'chat_message', 
        username: this.username, 
        content, 
        timestamp 
      });
      // Clear input
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
    // If countdown is active, treat as cancel
    if (this.countdownStarted) {
      this.cancelCountdown();
      return;
    }
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

  cancelCountdown(): void {
    // Send cancel request to backend so both players' countdowns are stopped and both are unready
    this.wsService.sendMessage({
      type: 'cancel_game_countdown',
      username: this.username,
      gameId: this.gameId
    });
    // Local UI will be reset when backend broadcasts 'game_countdown_cancelled'
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
    
    // Check if other player is configuring - if so, block the reveal toggle
    if (this.otherPlayerConfiguring) {
      this.revealEnabled = !this.revealEnabled; // Revert the toggle
      this.addSystemMessage('Cannot change reveal mode while other player is configuring.');
      this.cdr.markForCheck();
      return;
    }
    
    // When reveal checkbox changes, send a request to the other player
    const wasRevealEnabled = this.gameOptions.reveal || false;
    
    if (this.revealEnabled !== wasRevealEnabled) {
      // Reveal state is changing, send a request
      this.showRevealWaitingModal = true;
      
      this.wsService.sendMessage({
        type: 'request_reveal_mode',
        gameId: this.gameId,
        action: this.revealEnabled ? 'enable' : 'disable'
      });
      
      // Start countdown for host's waiting modal
      this.revealRequestCountdown = 5;
      this.revealRequestCountdownInterval = setInterval(() => {
        this.revealRequestCountdown--;
        this.cdr.markForCheck();
      }, 1000);
      
      this.cdr.markForCheck();
    }
  }

  acceptRevealRequest(): void {
    this.wsService.sendMessage({
      type: 'reveal_response',
      gameId: this.gameId,
      accepted: true
    });
    
    // Clear countdown
    if (this.revealRequestCountdownInterval) {
      clearInterval(this.revealRequestCountdownInterval);
      this.revealRequestCountdownInterval = null;
    }
    
    this.showRevealRequestModal = false;
    this.revealEnabled = true;
    this.gameOptions = { ...this.gameOptions, reveal: true };
    this.cdr.markForCheck();
  }
  declineRevealRequest(): void {
    this.wsService.sendMessage({
      type: 'reveal_response',
      gameId: this.gameId,
      accepted: false
    });
    
    // Clear countdown
    if (this.revealRequestCountdownInterval) {
      clearInterval(this.revealRequestCountdownInterval);
      this.revealRequestCountdownInterval = null;
    }
    
    this.showRevealRequestModal = false;
    this.revealEnabled = false;
    this.cdr.markForCheck();
  }

  getOpponentUsername(): string {
    const opponent = this.players.find(p => p.username !== this.username);
    return opponent?.username || 'opponent';
  }
  
  private checkAllPlayersReady(): void {
    const allReady = this.players.length > 0 && this.players.every(player => player.isReady);

    // Enable Start Game button
    // Do NOT automatically start the game here. Only enable the button for the host.
    // The host must manually press the Start Game button to start the game.
  }
  
  private startCountdown(): void {
    this.countdownStarted = true;
    this.countdownCancelled = false;
    this.countdown = 3; // Changed from 5 to 3

    // Clear any previous countdown before starting a new one
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }

    this.countdownInterval = setInterval(() => {
      if (this.countdownCancelled) {
        clearInterval(this.countdownInterval!);
        this.countdownInterval = null;
        this.countdownStarted = false;
        this.cdr.markForCheck();
        return;
      }
      this.countdown--;
      this.cdr.markForCheck();
      if (this.countdown <= 0) {
        if (this.countdownInterval !== null) {
          clearInterval(this.countdownInterval);
          this.countdownInterval = null;
        }
        this.countdownStarted = false; // Hide the countdown when it reaches 0
        this.isReady = false; // Reset button to 'Ready' state after countdown, matching backend
        // Game will be initialised by 'game_started' message from backend
        this.addSystemMessage('Initialising game...');
        this.cdr.markForCheck();
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
  
  /** Handle a move emitted by the GameBoardComponent. */
  onPlayerMove(event: { from: string; to: string }): void {
    this.wsService.sendMessage({
      type: 'make_move',
      from: event.from,
      to: event.to,
    });
  }

  /** Resign the current game. */
  resign(): void {
    this.wsService.sendMessage({ type: 'resign' });
  }

  /** Offer a draw to the opponent. */
  offerDraw(): void {
    this.wsService.sendMessage({ type: 'offer_draw' });
  }

  /** Accept or decline a draw offer. */
  respondToDraw(accept: boolean): void {
    this.wsService.sendMessage({ type: 'respond_draw', accept });
  }
  
  /**
   * Open the setup configuration screen.
   * Sets status to 'configuring' and navigates to setup.
   */
  openSetup(): void {
    // Save game mode and options to localStorage before navigating
    localStorage.setItem('gameRoomMode', this.gameMode);
    localStorage.setItem('gameRoomReveal', JSON.stringify(this.revealEnabled));
    localStorage.setItem('gameRoomOptions', JSON.stringify(this.gameOptions));
    // Set navigation state before navigating - use 'game-room' context to return here
    this.navigationState.setIntentionalNavigation('game-room');

    // Store game ID and token so setup can return to this game room
    localStorage.setItem('returnToGameRoom', this.gameId);
    localStorage.setItem('gameRoomToken', this.accessToken);

    // Always unset readiness when opening setup (silent)
    this.wsService.sendMessage({
      type: 'player_unready',
      username: this.username,
      gameId: this.gameId,
      silent: true
    });

    // Save game room chat to localStorage before navigating
    localStorage.setItem('gameRoomMessages', JSON.stringify(this.gameRoomMessages));

    // Set status to configuring
    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'configuring'
    });

    // Navigate to setup
    this.router.navigate(['/setup']);
  }
  
  leaveGameRoom(): void {
    // First, send leave message
    this.wsService.sendMessage({
      type: 'leave_game_room',
      username: this.username,
      gameId: this.gameId
    });
    
    console.log('[GameRoom] Sent leave_game_room message, setting navigation state, isInviter:', this.isInviter);
    
    // Only the HOST (inviter/person with crown) gets the cooldown
    // This prevents the host from spam-inviting
    if (this.isInviter) {
      this.navigationState.setIntentionalNavigation('none'); // Triggers cooldown
    } else {
      this.navigationState.setIntentionalNavigation('lobby'); // No cooldown
    }
    
    // Clear any intervals to avoid memory leaks
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    
    // Navigate immediately - the server will process the leave asynchronously
    // DO NOT disconnect - the lobby will reuse the same WebSocket connection
    console.log('[GameRoom] Navigating to lobby (keeping WebSocket connection)');
    this.router.navigate(['/lobby']);
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
   * Only the inviter can start the game. Sends a request to backend, which will broadcast 'game_countdown' to all players.
   * The countdown is only started in response to the 'game_countdown' message from backend, ensuring both players are in sync.
   */
  startGame(): void {
    if (!this.isInviter) return;
    // Only send the request to backend. Do NOT start countdown locally.
    this.wsService.sendMessage({
      type: 'start_game',
      gameId: this.gameId
    });
    // Countdown will be started for all players when 'game_countdown' is received from backend.
  }

  // Format custom options for display in system messages
  private formatOptionsText(options: Record<string, any>): string {
    const parts: string[] = [];
    Object.entries(options).forEach(([key, value]) => {
      if (key === 'reveal') {
        parts.push(`Reveal ${value ? 'enabled' : 'disabled'}`);
      } else {
        parts.push(`${key}: ${value}`);
      }
    });
    return parts.length ? ` (${parts.join(', ')})` : '';
  }
  
  // Stub for context menu on lobby user items
  openUserMenu(event: MouseEvent, user: User): void {
    event.preventDefault();

    // Don't allow inviting yourself
    if (user.username === this.username) return;

    // When in a game room, you cannot invite anyone
    const canInvite = false;
    const disabledReason = "Can't invite while in a game room";

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
      if (document.body.contains(menu)) {
        document.body.removeChild(menu);
      }
    });

    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        if (document.body.contains(menu)) {
          document.body.removeChild(menu);
        }
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
    try {
      if (this.lobbyService && typeof this.lobbyService.sendMessage === 'function') {
        this.lobbyService.sendMessage({
          type: 'game_challenge',
          challenger: this.username,
          opponent: opponent
        });
      } else {
        this.wsService.sendMessage({
          type: 'game_challenge',
          challenger: this.username,
          opponent: opponent
        });
      }
    } catch (e) {
      // fallback
      this.wsService.sendMessage({
        type: 'game_challenge',
        challenger: this.username,
        opponent: opponent
      });
    }

    // Immediately update local lobbyUsers to show both as invited (yellow)
    this.lobbyUsers = this.lobbyUsers.map(user => {
      if (user.username === opponent || user.username === this.username) {
        return { ...user, status: 'invited' };
      }
      return user;
    });
    this.sharedDataService.updateLobbyUsers(this.lobbyUsers);
  }

  getLobbyUserByUsername(username: string): User | undefined {
    return this.lobbyUsers.find(user => user.username === username);
  }
}