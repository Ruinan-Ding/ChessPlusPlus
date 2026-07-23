import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subject } from 'rxjs';
import { takeUntil, take, filter } from 'rxjs/operators';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedDataService, ChatMessage, User } from '../../services/shared-data.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { GameStateService } from '../../services/game-state.service';
import { AuthService } from '../../services/auth.service';
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

  private destroy$ = new Subject<void>();

  constructor(
    private wsService: WebsocketService,
    private route: ActivatedRoute,
    private router: Router,
    private sharedDataService: SharedDataService,
    private navigationState: NavigationStateService,
    private cdr: ChangeDetectorRef,
    public gameState: GameStateService,
    private authService: AuthService
  ) {}
  
  ngOnInit(): void {
    // Only clear messages if not returning from setup
    const isReturningFromSetup = this.navigationState.getNavigationContext() === 'game-room' && 
                                  this.navigationState.isIntentionalNavigation();
    if (isReturningFromSetup) {
      const saved = localStorage.getItem('gameRoomMessages');
      if (saved) {
        try {
          this.gameRoomMessages = JSON.parse(saved);
        } catch {
          this.gameRoomMessages = [];
        }
        localStorage.removeItem('gameRoomMessages');
      }
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

    this.lobbyMessages = this.sharedDataService.getLobbyMessages();
    this.lobbyUsers = this.sharedDataService.getLobbyUsers();
    this.sharedDataService.lobbyMessages$.pipe(takeUntil(this.destroy$)).subscribe(msgs => {
      this.lobbyMessages = msgs;
      this.scrollChatToBottom('lobby');
    });
    this.sharedDataService.lobbyUsers$.pipe(takeUntil(this.destroy$)).subscribe(users => this.lobbyUsers = users);

    this.username = this.authService.getUsername();
    if (!this.username) {
      this.router.navigate(['/login']);
      return;
    }

    // Lobby chat goes through wsService; the backend routes it to the lobby group

    this.route.params.pipe(takeUntil(this.destroy$)).subscribe(params => {
      this.gameId = params['id'];
      
      this.route.queryParams.pipe(take(1)).subscribe(queryParams => {
        this.accessToken = queryParams['token'] || '';
        
        if (!this.accessToken) {
          console.error('[GameRoom] No access token provided - unauthorized access attempt');
          this.router.navigate(['/lobby']);
          return;
        }
        
        console.log('[GameRoom] Connecting to game room:', this.gameId, 'with token');
        
        const isReturningFromSetup = this.navigationState.getNavigationContext() === 'game-room' && 
                                      this.navigationState.isIntentionalNavigation();
        
        if (isReturningFromSetup) {
          console.log('[GameRoom] Returning from setup, clearing navigation state');
          this.navigationState.clearIntentionalNavigation();
        }
        
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
          this.wsService.connect(this.gameId);
          
          // Wait for connection to be established before sending join message
          // Use filter to wait for true value, not just take the first emission
          const connectionSub = this.wsService.connectionStatus$.pipe(
            filter(connected => connected === true),
            take(1)
          ).subscribe(connected => {
            console.log('[GameRoom] Connection established, sending join_game_room message');
            
            this.wsService.sendMessage({
              type: 'join_game_room',
              username: this.username,
              gameId: this.gameId,
              token: this.accessToken
            });
            
            console.log('[GameRoom] join_game_room message sent');
            
            this.lobbyMessages = this.sharedDataService.getLobbyMessages();
          });
        }
      });
      
      this.wsService.messages$.pipe(takeUntil(this.destroy$)).subscribe(message => {
        if (!message) return;
        this.handleWebSocketMessage(message);
      });
    });
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();

    this.clearRevealCountdown();

    this.gameState.reset();
    
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

    // Don't disconnect here when returning to the lobby - the lobby
    // component manages its own connection lifecycle
    
  }
  
  handleWebSocketMessage(message: any): void {
    // Handle broadcast_message wrapper (unwrap to actual message type)
    let actualMessage = message;
    if (message.type === 'broadcast_message' && message.data) {
      actualMessage = message.data;
    }
    switch (actualMessage.type) {
      case 'game_started':
        this.gameStarted = true;
        this.isReady = false;  // Reset ready state - button reverts to "Ready" and will be disabled
        this.gameState.reset();
        this.gameState.applyGameStarted(actualMessage);
        
        const myColor = actualMessage.playerWhite === this.username ? 'White' : 'Black';
        this.addSystemMessage(`Game started! You are playing as ${myColor}.`);
        this.addSystemMessage(`${actualMessage.playerWhite} (White) moves first.`);
        this.cdr.markForCheck();
        break;
      case 'move_made':
        this.gameState.applyMoveMade(actualMessage);
        {
          const move = actualMessage.move;
          let moveText = `${move.color} ${move.unit_id}: ${move.from} -> ${move.to}`;
          if (move.attacked) {
            moveText += ` - dealt ${move.damage_dealt} dmg`;
            if (move.defender_eliminated) {
              moveText += ` (eliminated ${move.captured ?? 'enemy unit'})`;
            } else {
              const defenderUnit = this.gameState.snapshot.boardState[move.to]?.unit_id ?? 'unit';
              moveText += ` (${defenderUnit} survives, ${move.defender_hp} HP)`;
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
          this.addSystemMessage(`Game over - ${actualMessage.winner} wins by ${actualMessage.endReason}!`);
        } else {
          this.addSystemMessage(`Game over - Draw (${actualMessage.endReason}).`);
        }
        this.cdr.markForCheck();
        break;
      case 'game_state_update':
        // Full state refresh (e.g., on reconnect)
        this.gameState.applyFullState(actualMessage);
        if (actualMessage.winner) {
          this.addSystemMessage(`Game ended - winner: ${actualMessage.winner}`);
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
      case 'opponent_disconnected':
        if (actualMessage.username !== this.username) {
          this.addSystemMessage(
            `${actualMessage.username} disconnected. Waiting ${actualMessage.graceSeconds}s for them to reconnect...`
          );
          this.cdr.markForCheck();
        }
        break;
      case 'opponent_reconnected':
        if (actualMessage.username !== this.username) {
          this.addSystemMessage(`${actualMessage.username} reconnected.`);
          this.cdr.markForCheck();
        }
        break;
      case 'game_room_joined':
        this.isInviter = actualMessage.isInviter;
        break;
      case 'join_game_room_success':
        // Sent after joining the game room - if the game was already started,
        // request a full state resync (reconnection).
        if (actualMessage.gameStatus === 'started') {
          this.gameStarted = true;
          this.wsService.sendMessage({ type: 'request_game_state' });
          this.addSystemMessage('Reconnected - syncing game state...');
          this.cdr.markForCheck();
        }
        break;
      case 'player_list':
      case 'player_list_update': {
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
        // Derive from the player list rather than a dedicated status message -
        // the server never emits one, and this list already carries live status.
        const otherPlayer = this.players.find(p => p.username !== this.username);
        this.otherPlayerConfiguring = otherPlayer?.status === 'configuring';
        this.cdr.markForCheck();
        break;
      }

      case 'lobby_user_list':
      case 'user_list':
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
        this.players = this.players.map(player => {
          if (player.username === actualMessage.username) {
            return { ...player, isReady: true };
          }
          return player;
        });
        
        if (actualMessage.username === this.username) {
          this.isReady = true;
        }
        
        this.addSystemMessage(`${actualMessage.username} is ready.`);
        this.cdr.markForCheck();
        break;
        
      case 'player_unready':
        this.players = this.players.map(player => {
          if (player.username === actualMessage.username) {
            return { ...player, isReady: false };
          }
          return player;
        });

        if (actualMessage.username === this.username) {
          this.isReady = false;
        }

        if (!actualMessage.silent) {
          this.addSystemMessage(`${actualMessage.username} is not ready.`);
        }
        this.cdr.markForCheck();
        break;
        
      case 'game_mode_changed':
        this.gameMode = actualMessage.mode;
        
        if (actualMessage.options) {
          this.gameOptions = actualMessage.options;
          // Update UI to match options
          this.revealEnabled = actualMessage.options.reveal || false;
        } else if (actualMessage.mode === 'default') {
          this.gameOptions = {};
          this.revealEnabled = false;
        }

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

        this.cdr.markForCheck();
        break;

      case 'custom_config_saved':
        this.addSystemMessage(`${actualMessage.savedBy} saved a custom game configuration.`);
        this.cdr.markForCheck();
        break;

      case 'reveal_mode_requested':
        // Ignore our own request - only the other player should see the accept/decline modal
        if (actualMessage.username === this.username) break;
        this.revealRequester = actualMessage.username;
        this.showRevealRequestModal = true;
        this.cdr.markForCheck();
        break;

      case 'reveal_request_accepted':
        // Opponent accepted our reveal request - start the 5 second cooldown
        this.clearRevealCountdown();
        this.showRevealWaitingModal = true;  // Show waiting modal with countdown
        this.revealEnabled = actualMessage.enabled;
        this.gameOptions = { ...this.gameOptions, reveal: actualMessage.enabled };
        
        this.revealRequestCountdown = 5;
        this.revealRequestCountdownInterval = setInterval(() => {
          this.revealRequestCountdown--;
          this.cdr.markForCheck();
          
          if (this.revealRequestCountdown <= 0) {
            this.clearRevealCountdown();
            this.showRevealWaitingModal = false;
            this.addSystemMessage(`Reveal mode has been ${actualMessage.enabled ? 'enabled' : 'disabled'}.`);
            this.cdr.markForCheck();
          }
        }, 1000);
        
        this.addSystemMessage(`${actualMessage.username} has accepted your Reveal request!`);
        this.cdr.markForCheck();
        break;

      case 'reveal_request_declined':
        // The other player declined our reveal request - revert to the last confirmed value
        this.clearRevealCountdown();
        this.showRevealWaitingModal = false;
        this.revealEnabled = this.gameOptions.reveal ?? false;
        this.addSystemMessage(`${actualMessage.username} has declined your Reveal request.`);
        this.cdr.markForCheck();
        break;

      case 'reveal_request_timeout':
        // Reveal request timed out (opponent didn't respond) - revert to the last confirmed value
        this.clearRevealCountdown();
        this.showRevealRequestModal = false;
        this.showRevealWaitingModal = false;
        this.revealEnabled = this.gameOptions.reveal ?? false;
        this.addSystemMessage('Reveal mode request timed out.');
        this.cdr.markForCheck();
        break;

      case 'partner_left':
        // Don't call leaveGameRoom() here - that would send another leave_game_room message
        this.addSystemMessage(`${actualMessage.username} has left the game room. Returning to lobby...`);
        
        // Only the host (inviter) gets the cooldown, even when kicked,
        // to keep them from spam-inviting
        console.log('[GameRoom] partner_left: isInviter:', this.isInviter);
        if (this.isInviter) {
          this.navigationState.setIntentionalNavigation('none'); // Triggers cooldown
        } else {
          this.navigationState.setIntentionalNavigation('lobby'); // No cooldown
        }

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
    if (this.activeTab === 'gameRoom') {
      // Send to the server only; the message shows up when the server echoes it back
      this.wsService.sendMessage({
        type: 'game_room_message',
        username: this.username,
        content: content,
        gameId: this.gameId,
        timestamp: timestamp
      });
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
      this.messageContent = '';
      return;
    }
  }
  
  changeTab(tab: 'gameRoom' | 'lobby'): void {
    this.activeTab = tab;
    setTimeout(() => {
      this.scrollChatToBottom(tab);
    }, 100);
  }
  
  toggleReady(): void {
    // Toggle the ready status; the server response updates our local state
    const toggleAction = this.isReady ? 'player_unready' : 'player_ready';
    this.wsService.sendMessage({
      type: toggleAction,
      username: this.username,
      gameId: this.gameId
    });
  }

  changeGameMode(mode: 'default' | 'custom'): void {
    if (!this.isInviter) return;
    
    this.gameMode = mode;
    if (mode === 'default') {
      this.revealEnabled = false;
      this.gameOptions = {};
    }
    
    const messageData: any = {
      type: 'change_game_mode',
      mode: mode,
      gameId: this.gameId
    };
    
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
      this.showRevealWaitingModal = true;
      
      this.wsService.sendMessage({
        type: 'request_reveal_mode',
        gameId: this.gameId,
        action: this.revealEnabled ? 'enable' : 'disable'
      });
      
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
    this.clearRevealCountdown();
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
    this.clearRevealCountdown();
    this.showRevealRequestModal = false;
    this.revealEnabled = false;
    this.cdr.markForCheck();
  }

  /** Stop the reveal-request countdown interval (if running). */
  private clearRevealCountdown(): void {
    if (this.revealRequestCountdownInterval !== null) {
      clearInterval(this.revealRequestCountdownInterval);
      this.revealRequestCountdownInterval = null;
    }
  }

  getOpponentUsername(): string {
    const opponent = this.players.find(p => p.username !== this.username);
    return opponent?.username || 'opponent';
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
    const message: ChatMessage = {
      username: 'System',
      content: content,
      timestamp: new Date().toISOString(),
      type: 'system'
    };
    
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
    localStorage.setItem('gameRoomMode', this.gameMode);
    localStorage.setItem('gameRoomReveal', JSON.stringify(this.revealEnabled));
    localStorage.setItem('gameRoomOptions', JSON.stringify(this.gameOptions));
    // Set navigation state before navigating - use 'game-room' context to return here
    this.navigationState.setIntentionalNavigation('game-room');

    localStorage.setItem('returnToGameRoom', this.gameId);
    localStorage.setItem('gameRoomToken', this.accessToken);

    this.wsService.sendMessage({
      type: 'player_unready',
      username: this.username,
      gameId: this.gameId,
      silent: true
    });

    localStorage.setItem('gameRoomMessages', JSON.stringify(this.gameRoomMessages));

    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'configuring'
    });

    this.router.navigate(['/setup']);
  }
  
  leaveGameRoom(): void {
    this.wsService.sendMessage({
      type: 'leave_game_room',
      username: this.username,
      gameId: this.gameId
    });
    
    console.log('[GameRoom] Sent leave_game_room message, setting navigation state, isInviter:', this.isInviter);
    
    // Only the host (inviter) gets the cooldown, to keep them from spam-inviting
    if (this.isInviter) {
      this.navigationState.setIntentionalNavigation('none'); // Triggers cooldown
    } else {
      this.navigationState.setIntentionalNavigation('lobby'); // No cooldown
    }

    // Navigate immediately - the server will process the leave asynchronously
    // Don't disconnect - the lobby reuses the same WebSocket connection
    console.log('[GameRoom] Navigating to lobby (keeping WebSocket connection)');
    this.router.navigate(['/lobby']);
  }

  /**
   * Determines if the game can be started by the inviter.
   * At least one other player must be present and everyone must be ready.
   */
  canStartGame(): boolean {
    return this.players.length >= 2 && this.players.every(player => player.isReady);
  }
  
  /**
   * Only the inviter can start the game. The backend validates readiness and
   * broadcasts 'game_started' with the initial state to all players.
   */
  startGame(): void {
    if (!this.isInviter) return;
    this.wsService.sendMessage({
      type: 'start_game',
      gameId: this.gameId
    });
  }

  openUserMenu(event: MouseEvent, user: User): void {
    event.preventDefault();

    if (user.username === this.username) return;

    // When in a game room, you cannot invite anyone
    const canInvite = false;
    const disabledReason = "Can't invite while in a game room";

    const existingMenus = document.querySelectorAll('.user-context-menu');
    existingMenus.forEach(menu => document.body.removeChild(menu));

    const menu = document.createElement('div');
    menu.className = 'user-context-menu';
    menu.innerHTML = canInvite ?
      `<button>Invite</button>` :
      `<button disabled>${disabledReason}</button>`;
    menu.style.position = 'absolute';

    if (event.target instanceof HTMLButtonElement && event.target.classList.contains('action-button')) {
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 5}px`;
    } else {
      menu.style.left = `${event.pageX}px`;
      menu.style.top = `${event.pageY}px`;
    }

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
    this.wsService.sendMessage({
      type: 'game_challenge',
      challenger: this.username,
      opponent: opponent
    });

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