import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subject } from 'rxjs';
import { takeUntil, take, filter } from 'rxjs/operators';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedDataService, ChatMessage, User, selfFirst } from '../../services/shared-data.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { GameStateService } from '../../services/game-state.service';
import { AuthService } from '../../services/auth.service';
import { GameBoardComponent, SelectedUnit, hexNumberMap } from '../game-board/game-board.component';
import { hexDistanceKeys, strikeDamage } from '../../services/hex-rules';

/** Axial hex distance between two "q,r" coords. */
function hexDistance(from: string, to: string): number {
  const [aq, ar] = from.split(',').map(Number);
  const [bq, br] = to.split(',').map(Number);
  const dq = aq - bq, dr = ar - br;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

interface GameOptions {
  reveal?: boolean;
}

/** One staged action: where the unit ended up and the board it left behind. */
/** A one-turn stat boost an ability put on a unit. */
interface UnitBuff {
  mov: number;
  atk: number;
  def: number;
  /** Whose turn start clears it - the side that cast it. */
  caster: string;
  label: string;
}

/** Server error codes that invalidate a staged turn. Nothing else does. */
const MOVE_ERROR_CODES = new Set(['INVALID_MOVE', 'NOT_YOUR_TURN']);

interface StagedAction {
  board: Record<string, any>;
  /** Where the unit stood at the start of the turn. */
  from: string;
  /** Where it stands after this action. */
  to: string;
  /** Steps walked so far this turn. */
  used: number;
  /** Hex it struck, or null for a plain step. */
  attack: string | null;
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
  gameRoomMessageContent: string = '';
  lobbyMessageContent: string = '';
  /** Which pane the right-hand rail is showing. */
  activeSideTab: 'game' | 'lobby' = 'game';
  isInviter: boolean = false;
  gameMode: 'default' | 'custom' = 'default';
  isReady: boolean = false;
  gameStarted: boolean = false;
  revealEnabled: boolean = false;
  /** Fog of war. Unlike Reveal it needs no opponent confirmation. */
  fogEnabled: boolean = false;
  gameOptions: GameOptions = {};

  // Reveal mode request modals
  showRevealWaitingModal: boolean = false;  // Host waits for opponent response
  showRevealRequestModal: boolean = false;  // Opponent receives request
  revealRequestCountdown: number = 5;
  revealRequestCountdownInterval: ReturnType<typeof setInterval> | null = null;
  revealRequester: string = '';  // Username of player who requested reveal
  otherPlayerConfiguring: boolean = false;

  /** Players currently dropped out, by username - drives the ⚠ badge. */
  disconnectedPlayers = new Set<string>();
  /** Our own socket is down and the service is retrying. */
  isReconnecting: boolean = false;
  reconnectAttempt: number = 0;
  connectionLost: boolean = false;   // retries exhausted

  /** End-of-match popup (also covers "everyone else left"). */
  showEndModal: boolean = false;
  endModalTitle: string = '';
  endModalDetail: string = '';
  private endModalTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Our own connection state - the opponent gets told we dropped via
    // opponent_disconnected, but we only find out from the socket itself.
    this.wsService.reconnecting$.pipe(takeUntil(this.destroy$)).subscribe(retrying => {
      this.isReconnecting = retrying;
      if (retrying) this.connectionLost = false;
      this.cdr.markForCheck();
    });
    this.wsService.reconnectAttempts$.pipe(takeUntil(this.destroy$)).subscribe(n => {
      this.reconnectAttempt = n;
      this.cdr.markForCheck();
    });
    this.wsService.connectionStatus$.pipe(takeUntil(this.destroy$)).subscribe(connected => {
      this.serverOnline = connected;
      this.cdr.markForCheck();
    });
    this.wsService.connectionFailed$.pipe(takeUntil(this.destroy$)).subscribe(failed => {
      if (!failed) return;
      this.isReconnecting = false;
      this.connectionLost = true;
      this.cdr.markForCheck();
    });

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
        
        const join = () => {
          this.wsService.sendMessage({
            type: 'join_game_room',
            username: this.username,
            gameId: this.gameId,
            token: this.accessToken
          });
          this.lobbyMessages = this.sharedDataService.getLobbyMessages();
        };

        // A solo game left behind by a closed tab stays latched in session
        // storage: entering a real room, every message would still be
        // answered by the offline engine while the opponent sat alone.
        if (this.gameId !== 'local' && this.wsService.isLocal()) {
          this.wsService.endLocalGame();
        }
        if (!this.wsService.isOffline()) {
          this.wsService.connect(this.gameId);
        }
        // Offline games have no socket to wait on, so join right away.
        if (this.wsService.isLocal()) {
          join();
        }
        // Every time the socket comes up - now if it already is, and again
        // after any reconnect. A dropped socket loses the server-side group
        // membership, and without rejoining the room just sits there empty.
        this.wsService.connectionStatus$.pipe(
          // A solo game is answered locally and joined once, above: the socket
          // coming and going says nothing about it.
          filter(connected => connected === true && !this.wsService.isLocal()),
          takeUntil(this.destroy$),
        ).subscribe(() => join());
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
    if (this.endModalTimer) {
      clearTimeout(this.endModalTimer);
      this.endModalTimer = null;
    }

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
        this.myPoints = 0;
        this.opponentPoints = 0;
        this.beginTurnFor('white');
        this.cdr.markForCheck();
        break;
      case 'turn_passed':
        this.stagedActions = [];
        this.gameState.applyTurnPassed(actualMessage);
        this.beginTurnFor(actualMessage.color === 'white' ? 'black' : 'white');
        this.addSystemMessage(`${actualMessage.color ?? 'A player'} passed the turn.`);
        this.cdr.markForCheck();
        break;
      case 'move_made': {
        // The staged board stands in until the confirmed one lands, so the
        // position never flickers back and the selection keeps its unit.
        this.stagedActions = [];
        this.gameState.applyMoveMade(actualMessage);
        const m = actualMessage.move ?? {};
        const other = m.color === 'white' ? 'black' : 'white';
        if (m.defender_eliminated) this.awardPoints(m.color, 1);
        if (m.attacker_eliminated) this.awardPoints(other, 1);
        // The turn point belongs to whoever plays next, banked as they start.
        this.beginTurnFor(other);
        {
          const move = actualMessage.move;
          // Quote the same numbers the board draws, not raw axial coords.
          let moveText = `${move.color} ${move.unit_id}: ${this.hexLabel(move.from)} -> ${this.hexLabel(move.to)}`;
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
      }
      case 'game_over': {
        this.gameStarted = false;
        this.gameState.applyGameOver(actualMessage);
        if (actualMessage.winner) {
          this.addSystemMessage(`Game over - ${actualMessage.winner} wins by ${actualMessage.endReason}!`);
        } else {
          this.addSystemMessage(`Game over - Draw (${actualMessage.endReason}).`);
        }
        // Solo: the result banner on the mode screen already says it, and the
        // popup's only button dumps you back in the lobby. Skip it.
        if (!this.isSinglePlayer) {
          const iWon = actualMessage.winner === this.username;
          const title = actualMessage.winner ? (iWon ? 'You won!' : 'You lost') : 'Draw';
          // An opponent who never came back can't rematch, so that ending
          // returns to the lobby on its own; the others wait for the button.
          this.openEndModal(
            title,
            this.endReasonDetail(actualMessage),
            actualMessage.endReason === 'disconnect',
          );
        }
        this.cdr.markForCheck();
        break;
      }
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
        // The offline engine's rejection; same consequence as the server's.
        this.stagedActions = [];
        this.addSystemMessage(`Invalid move: ${actualMessage.message}`);
        this.cdr.markForCheck();
        break;
      case 'opponent_disconnected':
        if (actualMessage.username !== this.username) {
          this.disconnectedPlayers = new Set(this.disconnectedPlayers).add(actualMessage.username);
          this.addSystemMessage(
            `${actualMessage.username} disconnected. Waiting ${actualMessage.graceSeconds}s for them to reconnect...`
          );
          this.cdr.markForCheck();
        }
        break;
      case 'opponent_reconnected':
        if (actualMessage.username !== this.username) {
          const stillOut = new Set(this.disconnectedPlayers);
          stillOut.delete(actualMessage.username);
          this.disconnectedPlayers = stillOut;
          this.addSystemMessage(`${actualMessage.username} reconnected.`);
          this.cdr.markForCheck();
        }
        break;
      case 'room_abandoned':
        // Nothing had started, so there is no game to win - the room simply
        // can't continue with nobody else in it.
        if (actualMessage.username !== this.username) {
          this.openEndModal(
            'No players left',
            `${actualMessage.username} left and did not come back. This room is closed.`,
          );
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
        this.isSinglePlayer = actualMessage.singlePlayer === true;
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
        // A rejected move must not leave the staged position on screen - but
        // a chat, invite or username error has nothing to do with it, and
        // must not silently bin a turn the player has been building.
        if (MOVE_ERROR_CODES.has(actualMessage.code)) this.stagedActions = [];
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
  
  sendGameRoomMessage(): void {
    if (!this.gameRoomMessageContent.trim()) return;
    // Send to the server only; the message shows up when the server echoes it back
    this.wsService.sendMessage({
      type: 'game_room_message',
      username: this.username,
      content: this.gameRoomMessageContent.trim(),
      gameId: this.gameId,
      timestamp: new Date().toISOString()
    });
    this.gameRoomMessageContent = '';
  }

  sendLobbyMessage(): void {
    if (!this.lobbyMessageContent.trim()) return;
    // Send lobby chat via wsService - backend will route to lobby group
    this.wsService.sendMessage({
      type: 'chat_message',
      username: this.username,
      content: this.lobbyMessageContent.trim(),
      timestamp: new Date().toISOString()
    });
    this.lobbyMessageContent = '';
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
      // Solo rooms have no second player to confirm with - apply it directly.
      if (this.isSinglePlayer) {
        this.gameOptions = { ...this.gameOptions, reveal: this.revealEnabled };
        this.cdr.markForCheck();
        return;
      }
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
    
    this.gameRoomMessages.push(message);
    this.scrollChatToBottom('gameRoom');
  }

  /** System log (moves, ready/mode changes, ...) - shown in the History panel. */
  get historyMessages(): ChatMessage[] {
    return this.gameRoomMessages.filter(message => message.type === 'system');
  }

  /** Player chat only; the system log lives in historyMessages. */
  get gameRoomChatMessages(): ChatMessage[] {
    return this.gameRoomMessages.filter(message => message.type !== 'system');
  }

  /** Online users with yourself pinned to the top of the list. */
  get sortedLobbyUsers(): User[] {
    // With no server there is no roster to speak of - just you.
    if (!this.serverOnline) return [{ username: this.username, status: 'online' } as User];
    return selfFirst(this.lobbyUsers, this.username);
  }

  /** False whenever the socket is down, offline mode included. */
  serverOnline = false;

  /** Players with yourself pinned to the top of the list. */
  get sortedPlayers(): User[] {
    return selfFirst(this.players, this.username);
  }

  /** Overlays every hex, panels included, with its number - a reference aid. */
  showHexNumbers = false;

  /** Big win/lose banner shown over the mode screen once a match ends. */
  get resultBanner(): string {
    const s = this.gameState.snapshot;
    if (!s.endReason) return '';
    if (!s.winner) return 'DRAW';
    return s.winner === this.username ? 'YOU WIN' : 'YOU LOST';
  }

  /** Header for the Unit panel: the selected unit, or the bare label. */
  get unitPanelTitle(): string {
    const u = this.displayUnit;
    if (!u) return 'Unit';
    const side = u.color === 'white' ? 'White' : 'Black';
    // Veterancy rides right behind the name, same stars the hex draws.
    const stars = '\u2605'.repeat(Math.max(0, Math.min(3, u.vet)));
    return `${u.name}${stars ? ' ' + stars : ''} - ${side}`;
  }

  /** History header carries the turn number. */
  get historyTitle(): string {
    const turn = this.gameState.snapshot.turnNumber;
    return turn ? `History - Turn ${turn}` : 'History';
  }

  /** The board's number for a "q,r" coord, falling back to the raw coord. */
  private hexLabel(coord: string): string {
    const board = this.gameState.snapshot.config?.board;
    const radius = board?.radius ?? 11;
    const orientation = board?.orientation === 'vertex-up' ? 'vertex-up' : 'edge-up';
    // Numbering belongs to a board, not to a session: a rematch on a
    // different radius - or an orientation the map was never built for -
    // would otherwise label history with numbers drawn nowhere.
    const stamp = `${radius}|${orientation}`;
    if (stamp !== this.hexNumbersFor) {
      this.hexNumbers = hexNumberMap(radius, orientation);
      this.hexNumbersFor = stamp;
    }
    const n = this.hexNumbers[coord];
    return n === undefined ? coord : String(n);
  }

  onHexSelected(unit: SelectedUnit | null): void {
    this.selectedUnit = unit;
    this.cdr.markForCheck();
  }

  /** A deliberate pick - and so the target an armed ability was waiting for. */
  onHexClicked(unit: SelectedUnit | null): void {
    if (unit && this.pendingAbility) this.castOn(unit);
    this.cdr.markForCheck();
  }

  onHexHovered(unit: SelectedUnit | null): void {
    this.hoveredUnit = unit;
    this.cdr.markForCheck();
  }

  /** Hover wins while the cursor is over a unit, otherwise the selection. */
  get displayUnit(): SelectedUnit | null {
    return this.hoveredUnit ?? this.selectedUnit;
  }

  /** Steps already spent this turn by the displayed unit (0 unless staged). */
  get moveUsed(): number {
    const u = this.displayUnit;
    if (!u || !this.pendingMove || this.pendingMove.to !== u.key) return 0;
    return this.pendingMove.used;
  }

  /** Slot 2 is the passive every unit carries - always on, never clicked. */
  isPassive(index: number): boolean {
    return index === 1;
  }

  /**
   * Which veterancy rank unlocks a slot. Both of a unit's own two slots are
   * earned, not given: one star for the ability, two for the passive.
   * ponytail: a flat table, not per-unit - the roster does not exist yet.
   */
  private vetNeeded(index: number): number {
    return this.isPassive(index) ? 2 : 1;
  }

  /** True when the displayed unit has earned that slot. */
  vetUnlocked(index: number): boolean {
    return (this.displayUnit?.vet ?? 0) >= this.vetNeeded(index);
  }

  /** "Ability1 - 3 (2)" while cooling down, "Passive1" for the passive row. */
  abilityLabel(index: number, cooldown: number): string {
    const name = this.abilityEffects[index]?.name ?? `Ability${index + 1}`;
    if (this.isPassive(index)) return name;
    const cost = this.abilityCosts[index] ?? 0;
    return cooldown > 0 ? `${name} - ${cost} (${cooldown})` : `${name} - ${cost}`;
  }

  /** Tooltip: what the slot actually does, and what it costs to get there. */
  abilityHint(index: number): string {
    const e = this.abilityEffects[index];
    if (!e) return '';
    const parts: string[] = [];
    if (e.mov) parts.push(`${e.mov > 0 ? '+' : ''}${e.mov} MOV`);
    if (e.atk) parts.push(`${e.atk > 0 ? '+' : ''}${e.atk} ATK`);
    if (e.def) parts.push(`${e.def > 0 ? '+' : ''}${e.def} DEF`);
    const effect = parts.join(', ') || 'no effect yet';
    const star = '\u2605'.repeat(this.vetNeeded(index));
    return this.isPassive(index)
      ? `${effect} while the unit holds ${star}`
      : `${effect} for one turn - click, then click the unit to boost (needs ${star})`;
  }

  /** True while this slot is waiting for the player to pick a target. */
  isArmed(side: 'mine' | 'opponent', index: number): boolean {
    return this.pendingAbility?.side === side && this.pendingAbility?.index === index;
  }

  /** Affordable, off cooldown, and this side's turn to act. */
  canAfford(side: 'mine' | 'opponent', index: number, cooldown: number): boolean {
    if (cooldown > 0 || !this.canUseAbilities(side)) return false;
    const points = side === 'mine' ? this.myPoints : this.opponentPoints;
    return points >= (this.abilityCosts[index] ?? 0);
  }

  /** Which colour a box belongs to - 'mine' is us, whichever seat we hold. */
  private casterColor(side: 'mine' | 'opponent'): string {
    const mine = this.gameState.myColor(this.username) || 'white';
    return side === 'mine' ? mine : (mine === 'white' ? 'black' : 'white');
  }

  /**
   * Use an ability. A unit already selected is the obvious target, so it
   * lands there at once; with nothing selected the slot arms instead and the
   * next unit clicked on the board takes it. Clicking an armed slot again
   * calls it off.
   */
  useAbility(side: 'mine' | 'opponent', index: number, cooldowns: number[]): void {
    if (this.isPassive(index)) return;  // always on, nothing to cast
    if (!this.canAfford(side, index, cooldowns[index] ?? 0)) return;
    const target = this.selectedUnit;
    if (target && target.color === this.casterColor(side)) {
      this.pendingAbility = { side, index, cooldowns };
      this.castOn(target);
    } else {
      this.pendingAbility = this.isArmed(side, index) ? null : { side, index, cooldowns };
    }
    this.cdr.markForCheck();
  }

  /** Land the armed ability on a unit, paying for it as it goes. */
  private castOn(unit: SelectedUnit): void {
    const armed = this.pendingAbility!;
    // A boost goes on your own unit; clicking an enemy just calls it off.
    if (unit.color === this.casterColor(armed.side)) {
      const e = this.abilityEffects[armed.index];
      const cost = this.abilityCosts[armed.index] ?? 0;
      if (armed.side === 'mine') this.myPoints -= cost; else this.opponentPoints -= cost;
      armed.cooldowns[armed.index] = 3;
      // Keyed by the unit, so the boost follows it through a staged step, an
      // Undo and the server's own confirmation of the move. A fresh object,
      // so the board sees the change and redraws its reach.
      this.buffs = {
        ...this.buffs,
        [unit.uid]: { mov: e.mov, atk: e.atk, def: e.def, caster: this.casterColor(armed.side), label: e.name },
      };
    }
    this.pendingAbility = null;
  }

  /** Extra steps lent to whatever unit stands on `key`, staged board first. */
  private moveBonusFor(key: string): number {
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    const uid = board?.[key]?.uid;
    return (uid ? this.buffs[uid]?.mov : undefined) ?? 0;
  }

  /** The boost on the unit the panel is showing, if it carries one. */
  get displayBuff(): UnitBuff | null {
    const u = this.displayUnit;
    return u ? this.buffs[u.uid] ?? null : null;
  }

  /** Boosted over base, so a +4 on a base 26 reads "30/26". */
  get statAtk(): string {
    const u = this.displayUnit;
    if (!u) return '\u2014';
    const add = this.displayBuff?.atk ?? 0;
    // Multi-ring attacks read "26,19"; every ring gains the same boost.
    const boosted = u.atk.split(',').map(n => String(Number(n) + add)).join(',');
    return `${boosted}/${u.atk}`;
  }

  get statDef(): string {
    const u = this.displayUnit;
    if (!u) return '\u2014';
    return `${(u.def ?? 0) + (this.displayBuff?.def ?? 0)}/${u.def}`;
  }

  get statMov(): string {
    const u = this.displayUnit;
    if (!u) return '\u2014';
    const base = u.mv ?? 0;
    return `${base + (this.displayBuff?.mov ?? 0) - this.moveUsed}/${base}`;
  }

/** Credit a side: a point for starting a turn, a point per unit killed. */
  private awardPoints(color: string, amount: number): void {
    const mine = this.gameState.myColor(this.username);
    const toMe = mine ? color === mine : color === 'white';
    if (toMe) this.myPoints += amount;
    else this.opponentPoints += amount;
  }

  /**
   * A side's turn begins: it banks a point and its abilities tick down one.
   * Called for whoever is *about* to play, never for the side just finished.
   */
  private beginTurnFor(color: string): void {
    if (!color) return;
    // A boost lasts one turn: it runs out when its caster comes round again.
    const kept = Object.fromEntries(
      Object.entries(this.buffs).filter(([, b]) => b.caster !== color),
    );
    if (Object.keys(kept).length !== Object.keys(this.buffs).length) this.buffs = kept;
    this.awardPoints(color, 1);
    const mine = this.gameState.myColor(this.username);
    const isMine = mine ? color === mine : color === 'white';
    const tick = (cds: number[]) => cds.forEach((cd, i) => (cds[i] = Math.max(0, cd - 1)));
    if (isMine) {
      tick(this.myCooldowns);
      tick(this.unitCooldowns);
    } else {
      tick(this.opponentCooldowns);
    }
  }

  /** True while R / TAB / S should act, which is also when the hints show. */
  get shortcutsActive(): boolean {
    return this.windowFocused && !this.chatFocused;
  }

  @HostListener('window:blur')
  onWindowBlur(): void { this.windowFocused = false; this.cdr.markForCheck(); }

  @HostListener('window:focus')
  onWindowFocus(): void { this.windowFocused = true; this.cdr.markForCheck(); }

  @HostListener('window:keydown', ['$event'])
  onShortcut(event: KeyboardEvent): void {
    if (!this.shortcutsActive || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    // Never steal keys from a field, even one outside the chat boxes.
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (event.key === 'Tab') {
      // Tab belongs to the browser whenever the player is on a control:
      // swallowing it everywhere put Undo, End Turn and Resign out of reach
      // of the keyboard, and ended a turn on every attempt to reach them.
      if (target && /^(BUTTON|A)$/.test(target.tagName)) return;
      event.preventDefault();
      this.endTurn();
    } else if (event.key === 'r' || event.key === 'R') {
      this.undoMove();
    } else if (event.key === 's' || event.key === 'S') {
      this.showHexNumbers = !this.showHexNumbers;
      this.cdr.markForCheck();
    }
  }

  /** Solo room: the second seat is a placeholder, so no readying up. */
  isSinglePlayer = false;
  /** Unit under the cursor of the Unit panel; null when nothing is selected. */
  selectedUnit: SelectedUnit | null = null;
  /** Hover preview - takes precedence over the selection while it lasts. */
  hoveredUnit: SelectedUnit | null = null;

  /** What each ability costs in points. Placeholder until abilities exist. */
  abilityCosts = [3, 5, 2, 4];

  /**
   * What each slot does. Arbitrary numbers - this is the proof of concept
   * that an ability can be clicked, aimed at a unit and change its stats for
   * a turn. Slot 2 is the passive: it is not cast, so its numbers are what
   * the unit carries once it has the rank for it.
   */
  readonly abilityEffects = [
    { name: 'Ability1', mov: 2, atk: 0, def: 0 },
    { name: 'Passive1', mov: 0, atk: 0, def: 3 },
    { name: 'Ability3', mov: 0, atk: 4, def: 0 },
    { name: 'Ability4', mov: -1, atk: 2, def: 2 },
  ];

  /**
   * One-turn stat boosts, keyed by the hex the unit stands on.
   * ponytail: client-side and hex-keyed - a boost follows a staged move but
   * not a unit the server moves for us, and a reload drops it.
   */
  buffs: Record<string, UnitBuff> = {};

  /** An ability waiting for its target; null when nothing is armed. */
  pendingAbility: { side: 'mine' | 'opponent'; index: number; cooldowns: number[] } | null = null;

  /** Placeholder ability cooldowns, in turns. Nothing decrements them yet. */
  unitCooldowns = [5, 0];
  opponentCooldowns = [5, 4, 0, 2];
  myCooldowns = [3, 0, 5, 1];

  /** Keyboard shortcuts go quiet while typing or when the window loses focus. */
  windowFocused = true;
  chatFocused = false;

  /** Expandable rail sections. */
  chatExpanded = false;
  usersExpanded = false;
  lobbyChatExpanded = false;
  /** History takes over the whole left column. */
  historyExpanded = false;
  /** Ability points per side. Nothing spends them yet. */
  myPoints = 0;
  opponentPoints = 0;
  /** "q,r" -> the number drawn on that hex, for labelling move history. */
  private hexNumbers: Record<string, number> = {};
  /** Which board the cached numbering was built for - "radius|orientation". */
  private hexNumbersFor = '';
  /** Move made but not yet committed - held here until End Turn. */
  /**
   * Everything staged this turn, oldest first. Each entry carries the board as
   * it looked *after* that action, so Undo is a pop rather than an inverse -
   * which is what lets an attack be taken back as cheaply as a step.
   */
  stagedActions: StagedAction[] = [];

  /** Board with the staged actions applied, or null when nothing is staged. */
  get stagedBoard(): Record<string, any> | null {
    return this.stagedActions.length
      ? this.stagedActions[this.stagedActions.length - 1].board
      : null;
  }

  /** Where the acting unit started, where it stands, and steps spent so far. */
  get pendingMove(): { from: string; to: string; used: number } | null {
    const last = this.stagedActions[this.stagedActions.length - 1];
    return last ? { from: last.from, to: last.to, used: last.used } : null;
  }

  /** A unit that has swung is done for the turn - no more walking. */
  get hasAttacked(): boolean {
    return this.stagedActions.some(a => a.attack !== null);
  }
  /** Which side the host takes in a solo game; the placeholder gets the other. */
  soloColor: 'white' | 'black' = 'white';

  /** True if this player has dropped out and we're waiting on them. */
  isDisconnected(name: string): boolean {
    return this.disconnectedPlayers.has(name);
  }

  /**
   * Show the end-of-room popup. `autoReturn` sends us back to the lobby on a
   * timer, for endings where staying put is pointless (nobody left to play).
   */
  private openEndModal(title: string, detail: string, autoReturn = false): void {
    this.endModalTitle = title;
    this.endModalDetail = detail;
    this.showEndModal = true;
    if (this.endModalTimer) clearTimeout(this.endModalTimer);
    if (autoReturn) {
      this.endModalTimer = setTimeout(() => this.returnToLobby(), 8000);
    }
    this.cdr.markForCheck();
  }

  private endReasonDetail(msg: any): string {
    switch (msg.endReason) {
      case 'disconnect': return `${msg.disconnectedPlayer ?? 'Your opponent'} did not reconnect in time.`;
      case 'resign':     return `${msg.resignedBy ?? 'A player'} resigned.`;
      case 'timeout':    return 'A player ran out of time.';
      case 'elimination': return 'All units on one side were eliminated.';
      case 'draw_agreed': return 'Both players agreed to a draw.';
      case 'draw_max_turns': return 'The turn limit was reached.';
      default: return 'The match has ended.';
    }
  }

  /** Leave for the lobby without re-sending a leave message. */
  returnToLobby(): void {
    if (this.endModalTimer) {
      clearTimeout(this.endModalTimer);
      this.endModalTimer = null;
    }
    this.showEndModal = false;
    this.navigationState.setIntentionalNavigation('lobby');
    this.router.navigate(['/lobby']);
  }

  /** Handle a move emitted by the GameBoardComponent. */
  /**
   * A move is staged, not sent: it shows on the board and can be undone until
   * End Turn commits it. The server still ends the turn on receipt, so
   * committing and ending the turn are one and the same message.
   */
  onPlayerMove(event: { from: string; to: string; cost: number }): void {
    if (this.hasAttacked) return;
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    const next: Record<string, any> = { ...board };
    next[event.to] = next[event.from];
    delete next[event.from];
    // Steps accumulate across hops: a unit keeps walking on what is left of
    // its move until it attacks or the turn ends.
    const prev = this.pendingMove;
    this.stagedActions.push({
      board: next,
      from: prev?.from ?? event.from,
      to: event.to,
      // The board charges the walk it actually plotted, detours included.
      used: (prev?.used ?? 0) + event.cost,
      attack: null,
    });
    this.cdr.markForCheck();
  }

  /**
   * An attack stages like a step, so it can be taken back. The damage is
   * previewed with the same sums the server uses (see hex-rules); the
   * authoritative result arrives with move_made once End Turn sends it.
   */
  onPlayerAttack(event: { from: string; to: string; attack: string }): void {
    if (!this.canEndTurn || this.hasAttacked) return;
    const config = this.gameState.snapshot.config;
    const board = { ...(this.stagedBoard ?? this.gameState.snapshot.boardState) };
    const attacker = board[event.to];
    const target = board[event.attack];
    if (!attacker || !target) return;

    const distance = hexDistanceKeys(event.to, event.attack);
    const dealt = strikeDamage(attacker.unit_id, target.unit_id, distance, config);
    const hurt = { ...target, hp: target.hp - dealt };

    if (hurt.hp <= 0) {
      delete board[event.attack];
    } else {
      board[event.attack] = hurt;
      const theirRange = config?.units?.[target.unit_id]?.attackRange ?? 1;
      if (distance <= theirRange) {
        const counter = strikeDamage(target.unit_id, attacker.unit_id, distance, config);
        const mine = { ...attacker, hp: attacker.hp - counter };
        if (mine.hp <= 0) delete board[event.to];
        else board[event.to] = mine;
      }
    }

    const prev = this.pendingMove;
    this.stagedActions.push({
      board,
      from: prev?.from ?? event.from,
      to: event.to,
      used: prev?.used ?? 0,
      attack: event.attack,
    });
    this.cdr.markForCheck();
  }

  /** Steps the staged unit has left, or null when nothing is staged. */
  get movesLeft(): number | null {
    const pending = this.pendingMove;
    if (!pending) return null;
    if (this.hasAttacked) return 0;
    const unit = this.stagedBoard?.[pending.to];
    const base = this.gameState.snapshot.config?.units?.[unit?.unit_id]?.move ?? 0;
    // A +MOV boost is real steps, not just a number in the panel.
    const total = base + this.moveBonusFor(pending.to);
    return Math.max(0, total - pending.used);
  }

  /** The turn can be ended whenever it is ours, move staged or not. */
  get canEndTurn(): boolean {
    const s = this.gameState.snapshot;
    if (!this.gameStarted || s.endReason || !s.currentTurn) return false;
    return this.isSinglePlayer || s.currentTurn === this.username;
  }

  /** Take back the last staged action - one step, or the attack. */
  undoMove(): void {
    this.stagedActions.pop();
    this.cdr.markForCheck();
  }

  /** Commit the staged move, which also hands the turn over. */
  endTurn(): void {
    if (!this.canEndTurn) return;
    const pending = this.pendingMove;
    if (!pending) {
      // Doing nothing is a legal turn.
      this.wsService.sendMessage({ type: 'pass_turn' });
      return;
    }
    const attack = this.stagedActions.find(a => a.attack !== null)?.attack;
    // Both engines re-check the walk from where it started, so they need to
    // be told about the extra steps or they reject the move outright.
    const moveBonus = this.moveBonusFor(pending.to);
    this.wsService.sendMessage({
      type: 'make_move',
      from: pending.from,
      to: pending.to,
      ...(attack ? { attack } : {}),
      ...(moveBonus ? { moveBonus } : {}),
    });
    // The staged board stays up until move_made confirms it - see the handler.
  }

  /**
   * Each abilities box is live only on its own side's turn, and an opponent's
   * box is never live unless you are driving both sides (solo play).
   */
  canUseAbilities(side: 'mine' | 'opponent'): boolean {
    if (!this.gameStarted) return false;
    const myTurn = this.gameState.snapshot.currentTurn === this.username;
    return side === 'mine' ? myTurn : (this.isSinglePlayer && !myTurn);
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
    if (this.gameStarted) return;

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
    // Custom mode is a stub ("Coming Soon..."), so starting it is blocked.
    if (this.gameMode === 'custom') return false;
    if (this.isSinglePlayer) {
      // Nobody to ready up - the placeholder seat never connects.
      return this.players.length >= 2;
    }
    return this.players.length >= 2 && this.players.every(player => player.isReady);
  }

  /** Flip which side you take; the placeholder always gets the other one. */
  toggleSoloColor(): void {
    this.soloColor = this.soloColor === 'white' ? 'black' : 'white';
  }
  
  /**
   * Only the inviter can start the game. The backend validates readiness and
   * broadcasts 'game_started' with the initial state to all players.
   */
  startGame(): void {
    if (!this.isInviter) return;
    this.wsService.sendMessage({
      type: 'start_game',
      gameId: this.gameId,
      // Ignored by the server for two-player rooms, where colours stay random.
      hostColor: this.isSinglePlayer ? this.soloColor : undefined
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