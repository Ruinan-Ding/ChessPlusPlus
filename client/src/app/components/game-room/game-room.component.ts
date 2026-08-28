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
import { FallenUnit, GameBoardComponent, SelectedUnit, hexNumberMap } from '../game-board/game-board.component';
import { hexDistanceKeys, strikeDamage } from '../../services/hex-rules';
import { AudioService } from '../../services/audio.service';

interface GameOptions {
  reveal?: boolean;
  turnTimeLimit?: number;
}

const LOCAL_UI_STATE_KEY = 'cpp.localGame.ui.v1';

interface LocalUiState {
  myPoints: number;
  opponentPoints: number;
  unitCooldowns: number[];
  opponentCooldowns: number[];
  myCooldowns: number[];
  myUltimateUsed: boolean;
  opponentUltimateUsed: boolean;
  buffs: Record<string, UnitBuff>;
  abilityUsed: Record<string, boolean>;
  soloColor: 'white' | 'black';
  stagedActions: StagedAction[];
  gameRoomMessages: ChatMessage[];
  opponentMoveVisuals: OpponentMoveVisual[];
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
  /** Which directions this unit has been pushed - it can be both at once. */
  up?: boolean;
  down?: boolean;
}

/**
 * Server error codes that invalidate a staged turn. Every code _handle_make_move
 * can answer a commit with belongs here: one it does not name leaves the staged
 * board on screen showing a position the server never accepted - which is how a
 * clock race (client and server both passing) left a unit standing somewhere it
 * had never moved.
 */
const MOVE_ERROR_CODES = new Set([
  'INVALID_MOVE', 'NOT_YOUR_TURN', 'GAME_OVER', 'GAME_NOT_STARTED',
  'NOT_IN_GAME', 'INTERNAL_ERROR',
]);

/** What a room starts with when nobody has picked a clock. */
const DEFAULT_TURN_TIME_LIMIT = 60;

interface OpponentMoveVisual {
  from: string;
  to: string;
  attack?: string;
  killed?: string;
  killedUnit?: { unit_id: string; color: 'white' | 'black' };
}

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
  killed?: string;
  /** What died there, so the board can draw its ghost under the skull. */
  killedUnit?: { unit_id: string; color: 'white' | 'black' };
  /** What an ability cast charged, for Undo to hand back. */
  spend?: AbilitySpend;
}

/**
 * Everything a cast took, and what the unit held before it. Data rather than
 * a closure because the staged stack is persisted as JSON.
 */
interface AbilitySpend {
  /** Whose points paid. */
  side: 'mine' | 'opponent';
  /** Which cooldown row was armed - the unit's own, or a side's. */
  row: 'mine' | 'opponent' | 'unit';
  index: number;
  cost: number;
  uid: string;
  priorCooldown: number;
  priorBuff: UnitBuff | null;
  priorUsed: boolean;
}

/** One fallen unit for the board, or nothing if this action killed nobody. */
function fallen(
  key: string | undefined,
  unit: { unit_id: string; color: 'white' | 'black' } | undefined,
): FallenUnit[] {
  return key && unit ? [{ key, unit_id: unit.unit_id, color: unit.color }] : [];
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
  // Empty until something is actually chosen: a seeded limit is
  // indistinguishable from a pick, and the server treats a pick as authority
  // over the config. selectedTurnTimeLimit supplies the display default.
  gameOptions: GameOptions = {};
  readonly turnTimeChoices = [15, 30, 60, 120, 180, 240, 300, 0];
  turnSecondsRemaining = 0;
  private turnClock: ReturnType<typeof setInterval> | null = null;
  private lastTimerBeep = -1;

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
    private authService: AuthService,
    private audioService: AudioService
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
      if (this.gameId === 'local') this.restoreLocalUiState();
      
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
    this.clearTurnClock();
    if (this.endModalTimer) {
      clearTimeout(this.endModalTimer);
      this.endModalTimer = null;
    }

    const isIntentionalNav = this.navigationState.isIntentionalNavigation();
    if (!isIntentionalNav) this.persistLocalUiState();

    this.gameState.reset();
    
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

  private persistLocalUiState(): void {
    if (this.gameId !== 'local') return;
    const state: LocalUiState = {
      myPoints: this.myPoints,
      opponentPoints: this.opponentPoints,
      unitCooldowns: this.unitCooldowns,
      opponentCooldowns: this.opponentCooldowns,
      myCooldowns: this.myCooldowns,
      myUltimateUsed: this.myUltimateUsed,
      opponentUltimateUsed: this.opponentUltimateUsed,
      buffs: this.buffs,
      abilityUsed: this.abilityUsed,
      soloColor: this.soloColor,
      stagedActions: this.stagedActions,
      gameRoomMessages: this.gameRoomMessages,
      opponentMoveVisuals: this.opponentMoveVisuals,
    };
    try {
      localStorage.setItem(LOCAL_UI_STATE_KEY, JSON.stringify(state));
    } catch {
      console.warn('[GameRoom] Could not persist local ability state');
    }
  }

  private restoreLocalUiState(): void {
    if (this.gameId !== 'local') return;
    try {
      const raw = localStorage.getItem(LOCAL_UI_STATE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as Partial<LocalUiState>;
      if (Number.isFinite(state.myPoints)) this.myPoints = state.myPoints!;
      if (Number.isFinite(state.opponentPoints)) this.opponentPoints = state.opponentPoints!;
      if (Array.isArray(state.unitCooldowns)) this.unitCooldowns = state.unitCooldowns;
      if (Array.isArray(state.opponentCooldowns)) this.opponentCooldowns = state.opponentCooldowns;
      if (Array.isArray(state.myCooldowns)) this.myCooldowns = state.myCooldowns;
      if (typeof state.myUltimateUsed === 'boolean') this.myUltimateUsed = state.myUltimateUsed;
      if (typeof state.opponentUltimateUsed === 'boolean') this.opponentUltimateUsed = state.opponentUltimateUsed;
      if (state.buffs && typeof state.buffs === 'object') this.buffs = state.buffs;
      if (state.abilityUsed && typeof state.abilityUsed === 'object') this.abilityUsed = state.abilityUsed;
      if (state.soloColor === 'white' || state.soloColor === 'black') this.soloColor = state.soloColor;
      if (Array.isArray(state.stagedActions)) this.stagedActions = state.stagedActions;
      if (Array.isArray(state.gameRoomMessages)) {
        this.gameRoomMessages = state.gameRoomMessages.filter(
          message => message.content !== 'Reconnected - syncing game state...'
        );
      }
      if (Array.isArray(state.opponentMoveVisuals)) this.opponentMoveVisuals = state.opponentMoveVisuals;
      this.cdr.markForCheck();
    } catch {
      console.warn('[GameRoom] Ignoring invalid saved local ability state');
    }
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
        this.unitCooldowns = [0, 0];
        this.opponentCooldowns = [0, 0, 0, 0, 0, 0];
        this.myCooldowns = [0, 0, 0, 0, 0, 0];
        this.myUltimateUsed = false;
        this.opponentUltimateUsed = false;
        this.buffs = {};
        this.abilityUsed = {};
        this.opponentMoveVisuals = [];
        // A solo room restores its last session on entry, so a fresh deal has
        // to drop what belonged to the old one - a staged board outlives the
        // game it was staged in otherwise, and hides the new position.
        this.stagedActions = [];
        this.gameRoomMessages = [];
        this.beginTurnFor('white');
        this.playTurnSoundIfNeeded(null);
        this.startTurnClock();
        this.cdr.markForCheck();
        break;
      case 'turn_passed':
        // The server passes for us when the clock runs out. If we were still
        // building a turn, it is gone - say so rather than let it vanish.
        if (actualMessage.timedOut && this.stagedActions.length) {
          this.addSystemMessage('Time ran out - your staged turn was not sent.');
        }
        this.stagedActions = [];
        const previousPassedTurn = this.gameState.snapshot.currentTurn;
        this.gameState.applyTurnPassed(actualMessage);
        this.beginTurnFor(actualMessage.color === 'white' ? 'black' : 'white');
        this.playTurnSoundIfNeeded(previousPassedTurn);
        this.startTurnClock();
        this.persistLocalUiState();
        this.addSystemMessage(`${actualMessage.color ?? 'A player'} passed the turn.`);
        this.cdr.markForCheck();
        break;
      case 'move_made': {
        // The staged board stands in until the confirmed one lands, so the
        // position never flickers back and the selection keeps its unit.
        this.stagedActions = [];
        const previousMoveTurn = this.gameState.snapshot.currentTurn;
        this.gameState.applyMoveMade(actualMessage);
        const m = actualMessage.move ?? {};
        const other = m.color === 'white' ? 'black' : 'white';
        const moveColor = String(m.color ?? '').toLowerCase();
        const mine = String(this.gameState.myColor(this.username) || 'white').toLowerCase();
        // Solo play changes seats every turn, so the move that just landed
        // always belongs to the side being handed over - it gets the same
        // arrow, attack line and skull an opponent's move would.
        if (moveColor && (this.isSinglePlayer || moveColor !== mine)) {
          this.opponentMoveVisuals = [{
            from: m.from,
            to: m.to,
            attack: m.attackedHex,
            killed: m.defender_eliminated ? m.attackedHex : undefined,
            killedUnit: m.defender_eliminated && m.captured
              ? { unit_id: m.captured, color: other as 'white' | 'black' }
              : undefined,
          }];
        }
        if (m.defender_eliminated) this.awardPoints(m.color, 1);
        if (m.attacker_eliminated) this.awardPoints(other, 1);
        // The turn point belongs to whoever plays next, banked as they start.
        this.beginTurnFor(other);
        this.playTurnSoundIfNeeded(previousMoveTurn);
        this.startTurnClock();
        this.persistLocalUiState();
        {
          const move = actualMessage.move;
          // Quote the same numbers the board draws, not raw axial coords.
          let moveText = `${move.color} ${move.unit_id}: ${this.hexLabel(move.from)} -> ${this.hexLabel(move.to)}`;
          if (move.attacked) {
            moveText += ` - dealt ${move.damage_dealt} dmg`;
            if (move.defender_eliminated) {
              moveText += ` (eliminated ${move.captured ?? 'enemy unit'})`;
            } else {
              // The defender stands on the hex that was struck; move.to is
              // where the attacker ended up, which is a different unit for
              // every ranged trade.
              const struck = move.attackedHex ?? move.to;
              const defenderUnit = this.gameState.snapshot.boardState[struck]?.unit_id ?? 'unit';
              moveText += ` (${defenderUnit} survives, ${move.defender_hp} HP)`;
            }
          }
          this.addSystemMessage(moveText);
        }
        this.cdr.markForCheck();
        break;
      }
      case 'game_over': {
        this.clearTurnClock();
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
        if (this.gameId === 'local') this.restoreLocalUiState();
        // A refresh or reconnect lands here, not on game_started: without
        // this the countdown, the warning beeps and the auto-pass all stay
        // asleep until the next move.
        this.startTurnClock();
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
          if (this.gameId !== 'local') {
            this.addSystemMessage('Reconnected - syncing game state...');
          }
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
        // Settings arrive here for anyone who joined after the host chose
        // them; game_mode_changed only reaches whoever was already in.
        if (actualMessage.gameOptions && typeof actualMessage.gameOptions === 'object') {
          this.gameOptions = { ...this.gameOptions, ...actualMessage.gameOptions };
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
        this.persistLocalUiState();
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
          this.gameOptions = { turnTimeLimit: 60 };
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
      this.gameOptions = this.gameOptions.turnTimeLimit !== undefined
        ? { turnTimeLimit: this.gameOptions.turnTimeLimit }
        : {};
    }
    
    const messageData: any = {
      type: 'change_game_mode',
      mode: mode,
      gameId: this.gameId
    };
    
    if (Object.keys(this.gameOptions).length > 0) {
      messageData.options = this.gameOptions;
    }

    this.wsService.sendMessage(messageData);
  }

  setTurnTimeLimit(value: string | number): void {
    if (!this.isInviter) return;
    const limit = Number(value);
    if (!this.turnTimeChoices.includes(limit)) return;
    this.gameOptions = { ...this.gameOptions, turnTimeLimit: limit };
    localStorage.setItem('gameRoomOptions', JSON.stringify(this.gameOptions));
    this.wsService.sendMessage({
      type: 'change_game_mode',
      mode: this.gameMode,
      gameId: this.gameId,
      options: this.gameOptions,
    });
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
    
    this.gameRoomMessages = [...this.gameRoomMessages, message];
    this.persistLocalUiState();
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

  get unitAbilityTitle(): string {
    if (!this.unitAbilityFocus) return this.unitPanelTitle;
    return `${this.unitPanelTitle} - ${this.abilityEffects[this.unitAbilityFocus.index]?.name ?? 'Ability'}`;
  }

  /**
   * How a panel number should pulse: out of its own colour to white when the
   * stat was lifted and to black when it was dragged down - MOV's yellow
   * included, that being the one stat with no number on the hex.
   */
  panelWave(stat: 'atk' | 'def' | 'mov'): string {
    const moved = this.displayBuff?.[stat] ?? 0;
    if (!moved) return '';
    return moved > 0 ? 'wave-up' : 'wave-down';
  }

  /** Wounded units pulse their remaining HP, as they do on the board. */
  get hpWave(): string {
    const unit = this.displayUnit;
    return unit && unit.hp != null && unit.hpMax != null && unit.hp < unit.hpMax
      ? 'wave-hurt' : '';
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
    if (!this.pendingAbility) {
      this.cdr.markForCheck();
      return;
    }

    if (!unit || unit.panel) {
      this.clearAbilityFocus();
    } else if (this.abilityTargetMode(this.pendingAbility.index) === 'enemy') {
      if (unit.color !== this.casterColor(this.pendingAbility.side)) {
        this.castOffensiveOn(unit);
      } else {
        this.clearAbilityFocus();
      }
    } else if (unit.color === this.casterColor(this.pendingAbility.side)) {
      this.castOn(unit);
    } else {
      this.clearAbilityFocus();
    }
    this.cdr.markForCheck();
  }

  /** Local-only damage preview for the click-to-target offensive scaffold. */
  private castOffensiveOn(unit: SelectedUnit): void {
    const armed = this.pendingAbility;
    if (!armed) return;
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    const effect = this.abilityEffects[armed.index];
    const cost = this.abilityCosts[armed.index] ?? 0;
    const next = { ...board };
    const target = board[unit.key];
    if (!target || target.color === this.casterColor(armed.side)) return;
    const damaged = { ...target, hp: target.hp - (effect.damage ?? 0) };
    if (damaged.hp <= 0) delete next[unit.key];
    else next[unit.key] = damaged;
    // Onto the staged stack like everything else, so it shows through a
    // staged step and Undo takes it back. A held-aside board was invisible
    // whenever anything else was staged, and Undo never cleared it.
    const prev = this.stagedActions[this.stagedActions.length - 1];
    const spend = this.spendOf(unit.uid, armed.side, armed.side, armed.index);
    this.stagedActions.push({
      board: next,
      from: prev?.from ?? '',
      to: prev?.to ?? '',
      used: prev?.used ?? 0,
      attack: null,
      killed: damaged.hp <= 0 ? unit.key : undefined,
      killedUnit: damaged.hp <= 0 ? { unit_id: target.unit_id, color: target.color } : undefined,
      spend,
    });
    // A sapped stat is a boost with the sign flipped, and the mark rides in
    // the same entry: a separate debuff map expired a ply before the penalty
    // it stood for, leaving lowered numbers with nothing explaining them.
    this.buffs = {
      ...this.buffs,
      [unit.uid]: this.stack(unit.uid, effect, this.casterColor(armed.side), true),
    };
    if (armed.side === 'mine') this.myPoints -= cost; else this.opponentPoints -= cost;
    armed.cooldowns[armed.index] = 3;
    this.pendingAbility = null;
    this.clearAbilityFocus();
    this.playDebuffSound();
    this.persistLocalUiState();
    this.addSystemMessage(`${effect.name} hit ${target.unit_id} for ${effect.damage ?? 0} damage (scaffold).`);
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

  /** Slot 5 is the passive every unit carries - always on, never cast. */
  isPassive(index: number): boolean {
    return index === 4;
  }

  isUltimate(index: number): boolean {
    return index === 5;
  }

  /**
   * Which veterancy rank unlocks a slot. Both of a unit's own two slots are
   * earned, not given: one star for the ability, two for the passive.
   * ponytail: a flat table, not per-unit - the roster does not exist yet.
   */
  private vetNeeded(index: number): number {
    return this.isPassive(index) ? 2 : 0;
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

  private ultimateUsed(side: 'mine' | 'opponent'): boolean {
    return side === 'mine' ? this.myUltimateUsed : this.opponentUltimateUsed;
  }

  abilityFontSize(index: number, cooldown: number): string {
    const length = this.abilityLabel(index, cooldown).length;
    return `${Math.max(9, 14 - Math.max(0, length - 16) * 0.35)}px`;
  }

  /**
   * Tooltip: what the slot does, how it is used, and any rank it needs.
   * Built from its parts - the previous version pasted an empty `(needs )`
   * into every ungated slot and then tried to strip it back out with a regex
   * that could not match one.
   */
  abilityHint(index: number, forOwnUnit = false): string {
    const e = this.abilityEffects[index];
    if (!e) return '';
    const parts: string[] = [];
    if (e.mov) parts.push(`${e.mov > 0 ? '+' : ''}${e.mov} MOV`);
    if (e.atk) parts.push(`${e.atk > 0 ? '+' : ''}${e.atk} ATK`);
    if (e.def) parts.push(`${e.def > 0 ? '+' : ''}${e.def} DEF`);
    if (e.damage) parts.push(`${e.damage} damage`);
    if (e.points) parts.push(`${e.points > 0 ? '+' : ''}${e.points} point`);
    const effect = parts.join(', ') || 'no effect yet';
    const need = this.vetNeeded(index);
    const star = '\u2605'.repeat(need);

    if (this.isPassive(index)) {
      return need ? `${effect} while the unit holds ${star}` : `${effect}, always on`;
    }
    const lasts = e.target === 'enemy' ? '' : ' for one turn';
    const how = forOwnUnit
      ? 'applies to this unit'
      : e.target === 'enemy'
        ? 'click the ability, then click an enemy'
        : 'click, then click the unit to boost';
    return `${effect}${lasts} - ${how}${need ? ` (needs ${star})` : ''}`;
  }

  unitAbilityHint(index: number): string {
    return this.abilityHint(index, true);
  }

  abilityTargetMode(index: number): 'friendly' | 'enemy' | 'universal' {
    return this.abilityEffects[index]?.target ?? 'friendly';
  }

  activeBoardAbilityMode(): 'friendly' | 'enemy' | null {
    if (!this.pendingAbility) return null;
    const mode = this.abilityTargetMode(this.pendingAbility.index);
    return mode === 'universal' ? null : mode;
  }

  activeBoardAbilityCasterColor(): 'white' | 'black' | '' {
    return this.pendingAbility ? this.casterColor(this.pendingAbility.side) as 'white' | 'black' : '';
  }

  abilityFocus: { side: 'mine' | 'opponent'; index: number; cooldowns: number[] } | null = null;
  unitAbilityFocus: { index: number; cooldowns: number[] } | null = null;

  selectUnitAbility(index: number): void {
    if (!this.displayUnit || this.displayUnit.panel) return;
    if (this.unitAbilityFocus?.index === index) {
      this.unitAbilityFocus = null;
    } else {
      this.unitAbilityFocus = { index, cooldowns: this.unitCooldowns };
    }
    this.cdr.markForCheck();
  }

  unitAbilityCanActivate(): boolean {
    const focus = this.unitAbilityFocus;
    const unit = this.displayUnit;
    // displayUnit follows the cursor, so a reserve the pointer crossed on the
    // way to the button must not be what the points are spent on.
    return this.isSinglePlayer && !!focus && !this.isPassive(focus.index) && !!unit &&
      !unit.panel &&
      unit.color === this.casterColor('mine') &&
      this.vetUnlocked(focus.index) &&
      this.canAfford('mine', focus.index, focus.cooldowns[focus.index] ?? 0);
  }

  activateUnitAbility(): void {
    const focus = this.unitAbilityFocus;
    const unit = this.displayUnit;
    if (!this.isSinglePlayer || !focus || !unit || !this.unitAbilityCanActivate()) return;
    const effect = this.abilityEffects[focus.index];
    const cost = this.abilityCosts[focus.index] ?? 0;
    const spend = this.spendOf(unit.uid, 'mine', 'unit', focus.index);
    this.myPoints -= cost;
    focus.cooldowns[focus.index] = 3;
    this.buffs = {
      ...this.buffs,
      [unit.uid]: this.stack(unit.uid, effect, this.casterColor('mine')),
    };
    this.abilityUsed = { ...this.abilityUsed, [unit.uid]: true };
    this.stageSpend(spend);
    this.addSystemMessage(`${effect.name} applied to ${unit.name}.`);
    this.persistLocalUiState();
    this.unitAbilityFocus = null;
    this.playBuffSound();
    this.cdr.markForCheck();
  }

  unitAbilityIsPassive(): boolean {
    return !!this.unitAbilityFocus && this.isPassive(this.unitAbilityFocus.index);
  }

  selectAbility(side: 'mine' | 'opponent', index: number, cooldowns: number[]): void {
    if (this.isAbilityFocused(side, index)) {
      this.clearAbilityFocus();
      return;
    }
    this.abilityFocus = { side, index, cooldowns };
    const mode = this.abilityTargetMode(index);
    this.pendingAbility = mode === 'universal' || !this.abilityCanActivate(side, index, cooldowns[index] ?? 0)
      ? null
      : this.abilityFocus;
    this.cdr.markForCheck();
  }

  isAbilityFocused(side: 'mine' | 'opponent', index: number): boolean {
    return this.abilityFocus?.side === side && this.abilityFocus.index === index;
  }

  isAbilityFocusedSide(side: 'mine' | 'opponent'): boolean {
    return this.abilityFocus?.side === side;
  }

  abilityHeader(side: 'mine' | 'opponent', label: string): string {
    return this.abilityFocus?.side === side
      ? `${label} - ${this.abilityEffects[this.abilityFocus.index]?.name ?? 'Ability'}`
      : label;
  }

  get focusedAbilityDescription(): string {
    if (!this.abilityFocus) return '';
    return this.abilityHint(this.abilityFocus.index);
  }

  get focusedAbilityIsTargeted(): boolean {
    if (!this.abilityFocus) return false;
    return this.abilityTargetMode(this.abilityFocus.index) !== 'universal';
  }

  get focusedAbilityIsUniversal(): boolean {
    return !!this.abilityFocus && this.abilityTargetMode(this.abilityFocus.index) === 'universal';
  }

  get focusedAbilityIsPassive(): boolean {
    return !!this.abilityFocus && this.isPassive(this.abilityFocus.index);
  }

  focusedAbilityCanActivate(): boolean {
    if (!this.abilityFocus) return false;
    return this.abilityCanActivate(
      this.abilityFocus.side,
      this.abilityFocus.index,
      this.abilityFocus.cooldowns[this.abilityFocus.index] ?? 0,
    );
  }

  private abilityCanActivate(side: 'mine' | 'opponent', index: number, cooldown: number): boolean {
    if (this.isPassive(index) || (this.isUltimate(index) && this.ultimateUsed(side))) return false;
    return this.canAfford(side, index, cooldown);
  }

  clearAbilityFocus(): void {
    this.abilityFocus = null;
    this.pendingAbility = null;
    this.cdr.markForCheck();
  }

  activateFocusedAbility(): void {
    if (!this.abilityFocus || !this.focusedAbilityIsUniversal || !this.focusedAbilityCanActivate()) return;
    const { side, index, cooldowns } = this.abilityFocus;
    const cost = this.abilityCosts[index] ?? 0;
    if (side === 'mine') this.myPoints -= cost; else this.opponentPoints -= cost;
    const points = this.abilityEffects[index].points ?? 0;
    if (side === 'mine') this.myPoints += points; else this.opponentPoints += points;
    cooldowns[index] = 3;
    if (this.isUltimate(index)) {
      if (side === 'mine') this.myUltimateUsed = true;
      else this.opponentUltimateUsed = true;
    }
    this.playAbilitySound();
    this.addSystemMessage(`${this.abilityEffects[index].name} used.`);
    this.persistLocalUiState();
    this.clearAbilityFocus();
  }

  /** True while this slot is waiting for the player to pick a target. */
  isArmed(side: 'mine' | 'opponent', index: number): boolean {
    return this.pendingAbility?.side === side && this.pendingAbility?.index === index;
  }

  /** Affordable, off cooldown, and this side's turn to act. */
  canAfford(side: 'mine' | 'opponent', index: number, cooldown: number): boolean {
    if (cooldown > 0 || !this.canUseAbilities(side) || (this.isUltimate(index) && this.ultimateUsed(side))) return false;
    const points = side === 'mine' ? this.myPoints : this.opponentPoints;
    return points >= (this.abilityCosts[index] ?? 0);
  }

  /** Which colour a box belongs to - 'mine' is us, whichever seat we hold. */
  private casterColor(side: 'mine' | 'opponent'): string {
    const mine = this.gameState.myColor(this.username) || 'white';
    return side === 'mine' ? mine : (mine === 'white' ? 'black' : 'white');
  }

  /** Land the armed ability on a unit, paying for it as it goes. */
  private castOn(unit: SelectedUnit): void {
    const armed = this.pendingAbility!;
    if (this.abilityTargetMode(armed.index) !== 'friendly') return;
    // A boost goes on your own unit; clicking an enemy just calls it off.
    if (unit.color === this.casterColor(armed.side)) {
      const e = this.abilityEffects[armed.index];
      const cost = this.abilityCosts[armed.index] ?? 0;
      if (armed.side === 'mine') this.myPoints -= cost; else this.opponentPoints -= cost;
      armed.cooldowns[armed.index] = 3;
      // Keyed by the unit, so the boost follows it through a staged step, an
      // Undo and the server's own confirmation of the move. A fresh object,
      // so the board sees the change and redraws its reach.
      const spend = this.spendOf(unit.uid, armed.side, armed.side, armed.index);
      this.buffs = {
        ...this.buffs,
        [unit.uid]: this.stack(unit.uid, e, this.casterColor(armed.side)),
      };
      this.abilityUsed = { ...this.abilityUsed, [unit.uid]: true };
      this.stageSpend(spend);
      this.playBuffSound();
    }
    this.pendingAbility = null;
    this.clearAbilityFocus();
  }

  /**
   * Fold an effect into whatever the unit is already carrying: the numbers
   * add up, and each direction it has been pushed is remembered separately -
   * a boost and a drag cancelling out numerically still leaves both marks on
   * the unit, which is what the board draws its arrows from.
   */
  private stack(
    uid: string,
    effect: { name: string; mov: number; atk: number; def: number },
    caster: string,
    hostile = false,
  ): UnitBuff {
    const held = this.buffs[uid];
    const mov = (held?.mov ?? 0) + effect.mov;
    const atk = (held?.atk ?? 0) + effect.atk;
    const def = (held?.def ?? 0) + effect.def;
    const lifted = effect.mov > 0 || effect.atk > 0 || effect.def > 0;
    // An offensive cast that only deals damage still counts as a drag: the
    // unit was hit by something, and the board should say so.
    const dragged = hostile || effect.mov < 0 || effect.atk < 0 || effect.def < 0;
    return {
      mov, atk, def,
      caster: held?.caster ?? caster,
      label: effect.name,
      up: held?.up || lifted,
      down: held?.down || dragged,
    };
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

  /**
   * Shrink a stat until it fits beside its label on one line. The cell is
   * half a narrow panel, and "26,19/26,19" is a lot of characters.
   */
  statFontSize(text: string): string {
    return `${Math.max(0.6, 1 - Math.max(0, text.length - 7) * 0.055)}rem`;
  }

  /** Boosted over base, so a +4 on a base 26 reads "30/26". */
  get statAtk(): string {
    const u = this.displayUnit;
    if (!u) return '\u2014';
    const add = this.displayBuff?.atk ?? 0;
    // Each ring is shown as current/original, e.g. "20/20, 15/15".
    return u.atk.split(',').map(n => {
      const original = Number(n);
      return `${original + add}/${original}`;
    }).join(', ');
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
    // Spending an ability marks the unit for the turn it was spent in.
    this.abilityUsed = {};
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
    this.persistLocalUiState();
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
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;

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
  abilityCosts = [3, 5, 1, 4, 0, 8];

  /**
   * What each slot does. Arbitrary numbers - this is the proof of concept
   * that an ability can be clicked, aimed at a unit and change its stats for
   * a turn. Slot 5 is the passive: it is not cast, so its numbers are what
   * the unit carries once it has the rank for it.
   */
  readonly abilityEffects = [
    { name: 'Dash', target: 'friendly' as const, mov: 2, atk: 0, def: 0 },
    { name: 'Focus', target: 'friendly' as const, mov: 0, atk: 2, def: 0 },
    { name: 'Bulwark', target: 'friendly' as const, mov: 0, atk: 0, def: 3 },
    // Between them the four clickable slots can put a unit into every state
    // the board draws: lifted, dragged down, and wounded.
    { name: 'Sap', target: 'enemy' as const, mov: -2, atk: -2, def: -2, damage: 6 },
    { name: 'Vigil', target: 'friendly' as const, mov: 0, atk: 0, def: 0 },
    { name: 'Cataclysm', target: 'universal' as const, mov: 0, atk: 0, def: 0, points: 3 },
  ];

  /**
   * One-turn stat boosts, keyed by the hex the unit stands on.
   * ponytail: client-side and hex-keyed - a boost follows a staged move but
   * not a unit the server moves for us, and a reload drops it.
   */
  buffs: Record<string, UnitBuff> = {};
  /** Units that have spent an ability this turn, keyed by uid. */
  abilityUsed: Record<string, boolean> = {};

  /** Local-only board preview for the offensive ability scaffold. */

  /** An ability waiting for its target; null when nothing is armed. */
  pendingAbility: { side: 'mine' | 'opponent'; index: number; cooldowns: number[] } | null = null;

  /** Placeholder ability cooldowns, in turns. Nothing decrements them yet. */
  unitCooldowns = [0, 0];
  opponentCooldowns = [0, 0, 0, 0, 0, 0];
  myCooldowns = [0, 0, 0, 0, 0, 0];
  myUltimateUsed = false;
  opponentUltimateUsed = false;

  /** Keyboard shortcuts go quiet while typing or when the window loses focus. */
  windowFocused = true;
  chatFocused = false;

  /** Expandable rail sections. */
  playersExpanded = false;
  chatExpanded = false;
  usersExpanded = false;
  lobbyChatExpanded = false;
  /** History takes over the whole left column. */
  historyExpanded = false;
  /** Ability points per side. */
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

  get movementArrows(): Array<{ from: string; to: string }> {
    return this.stagedActions
      .map((action, index) => ({
        from: index > 0 ? this.stagedActions[index - 1].to : action.from,
        to: action.to,
      }))
      // An ability staged before any step carries no hexes of its own, and
      // the step after it would otherwise inherit that empty origin.
      .filter(arrow => !!arrow.from && !!arrow.to && arrow.from !== arrow.to);
  }

  get attackMarkers(): Array<{ from: string; to: string }> {
    return this.stagedActions
      .filter(action => !!action.attack)
      .map(action => ({ from: action.to, to: action.attack! }));
  }

  private opponentMoveVisuals: OpponentMoveVisual[] = [];

  get opponentMovementArrows(): Array<{ from: string; to: string }> {
    return this.opponentMoveVisuals
      .filter(move => move.from !== move.to)
      .map(move => ({ from: move.from, to: move.to }));
  }

  get opponentAttackMarkers(): Array<{ from: string; to: string }> {
    return this.opponentMoveVisuals
      .filter(move => !!move.attack)
      .map(move => ({ from: move.to, to: move.attack! }));
  }

  get opponentKillMarkers(): FallenUnit[] {
    return this.opponentMoveVisuals.flatMap(move => fallen(move.killed, move.killedUnit));
  }

  get killMarkers(): FallenUnit[] {
    return this.stagedActions.flatMap(action => fallen(action.killed, action.killedUnit));
  }

  /** Where the acting unit started, where it stands, and steps spent so far. */
  get pendingMove(): { from: string; to: string; used: number } | null {
    const last = this.stagedActions[this.stagedActions.length - 1];
    // An ability cast with nothing else staged carries no move to commit.
    return last?.from ? { from: last.from, to: last.to, used: last.used } : null;
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
      case 'regicide': return 'A commander was killed.';
      case 'draw_mutual': return 'Both sides fell in the same exchange.';
      case 'draw_agreed': return 'Both players agreed to a draw.';
      case 'draw_max_turns': return 'The turn limit was reached.';
      default: return 'The match has ended.';
    }
  }

  /**
   * The server dropped out from under this match. Stop chasing it and open a
   * solo game instead - that one runs in the browser and needs no server. The
   * header's Reconnect button is the way back if the server returns.
   */
  playSinglePlayer(): void {
    this.wsService.playOffline();
    this.returnToLobby(true);
  }

  /** Leave for the lobby without re-sending a leave message. */
  returnToLobby(solo = false): void {
    if (this.endModalTimer) {
      clearTimeout(this.endModalTimer);
      this.endModalTimer = null;
    }
    this.showEndModal = false;
    this.navigationState.setIntentionalNavigation('lobby');
    // The lobby owns the solo-game handshake, so it deals the game on arrival.
    this.router.navigate(['/lobby'], solo ? { queryParams: { solo: 1 } } : {});
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
    this.playMoveSound();
    this.persistLocalUiState();
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

    // At most one of the two dies: a defender that falls never counters.
    let killed: string | undefined;
    let killedUnit: { unit_id: string; color: 'white' | 'black' } | undefined;

    if (hurt.hp <= 0) {
      delete board[event.attack];
      killed = event.attack;
      killedUnit = { unit_id: target.unit_id, color: target.color };
    } else {
      board[event.attack] = hurt;
      const theirRange = config?.units?.[target.unit_id]?.attackRange ?? 1;
      if (distance <= theirRange) {
        const counter = strikeDamage(target.unit_id, attacker.unit_id, distance, config);
        const mine = { ...attacker, hp: attacker.hp - counter };
        if (mine.hp <= 0) {
          delete board[event.to];
          // Our own unit dying to the counter is still a death: without this
          // it simply vanished from the preview, no skull, no ghost.
          killed = event.to;
          killedUnit = { unit_id: attacker.unit_id, color: attacker.color };
        } else {
          board[event.to] = mine;
        }
      }
    }

    const prev = this.pendingMove;
    this.stagedActions.push({
      board,
      from: prev?.from ?? event.from,
      to: event.to,
      used: prev?.used ?? 0,
      attack: event.attack,
      killed,
      killedUnit,
    });
    this.playAttackSound();
    this.persistLocalUiState();
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

  get isYourTurn(): boolean {
    const s = this.gameState.snapshot;
    return !!this.gameStarted && !s.endReason && s.currentTurn === this.username;
  }

  get selectedTurnTimeLimit(): number {
    // The snapshot's 0 means "unlimited" but also stands in for "no game
    // yet", and it is not nullish - so `?? 60` could never fire and any
    // options blob without the field silently selected Unlimited. A live
    // game's own limit wins; otherwise the room's options, then the default.
    if (this.gameStarted) return this.gameState.snapshot.turnTimeLimit;
    return this.gameOptions.turnTimeLimit ?? DEFAULT_TURN_TIME_LIMIT;
  }

  get formattedTurnTime(): string {
    if (!this.selectedTurnTimeLimit) return '';
    const seconds = Math.max(0, this.turnSecondsRemaining);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  formattedTurnOption(seconds: number): string {
    return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
  }

  private startTurnClock(): void {
    this.clearTurnClock();
    // Arriving into a turn that has already run out must not fire the
    // end-of-turn beep and pass on the spot, so an expired clock starts
    // already spent.
    this.lastTimerBeep = this.secondsRemaining() > 0 ? -1 : 0;
    this.updateTurnClock();
    if (this.gameState.snapshot.turnTimeLimit <= 0) return;
    this.turnClock = setInterval(() => this.updateTurnClock(), 250);
  }

  /** Seconds left on the current turn; 0 when no clock is running. */
  private secondsRemaining(): number {
    const state = this.gameState.snapshot;
    const limit = state.turnTimeLimit;
    if (!this.gameStarted || state.endReason || limit <= 0 || !state.turnStartedAt) return 0;
    const elapsed = (Date.now() - new Date(state.turnStartedAt).getTime()) / 1000;
    return Math.max(0, Math.ceil(limit - elapsed));
  }

  private clearTurnClock(): void {
    if (this.turnClock) {
      clearInterval(this.turnClock);
      this.turnClock = null;
    }
  }

  private updateTurnClock(): void {
    const state = this.gameState.snapshot;
    if (!this.gameStarted || state.endReason || state.turnTimeLimit <= 0 || !state.turnStartedAt) {
      this.turnSecondsRemaining = 0;
      return;
    }
    const remaining = this.secondsRemaining();
    this.turnSecondsRemaining = remaining;
    if (remaining > 0 && remaining <= 5 && remaining !== this.lastTimerBeep) {
      this.lastTimerBeep = remaining;
      this.playTone([880], 0.08);
    } else if (remaining === 0 && this.lastTimerBeep !== 0) {
      this.lastTimerBeep = 0;
      this.playTone([220, 110], 0.12);
      // The server passes for us when its own clock expires, so an empty
      // turn needs nothing from us. Staged work is worth one attempt at
      // committing before that lands - the two are checked against the same
      // turn number, so the loser is rejected rather than applied twice.
      if (this.canEndTurn && (this.isSinglePlayer || this.pendingMove)) this.endTurn();
    }
    this.cdr.markForCheck();
  }

  /** Take back the last staged action - a step, the attack, or a cast. */
  undoMove(): void {
    const undone = this.stagedActions.pop();
    // A cast took points, a cooldown, a mark and a stat stack. Popping the
    // board back without those left the ability half-spent for the rest of
    // the game.
    if (undone?.spend) this.refund(undone.spend);
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /**
   * A cast that changed no hexes still goes on the staged stack, carrying
   * what it spent - otherwise Undo has nothing to pop and the points are
   * gone for good.
   */
  private stageSpend(spend: AbilitySpend): void {
    const prev = this.stagedActions[this.stagedActions.length - 1];
    this.stagedActions.push({
      board: this.stagedBoard ?? this.gameState.snapshot.boardState,
      from: prev?.from ?? '',
      to: prev?.to ?? '',
      used: prev?.used ?? 0,
      attack: null,
      spend,
    });
  }

  /** Note what a cast is about to take, before it takes it. */
  private spendOf(
    uid: string,
    side: 'mine' | 'opponent',
    row: 'mine' | 'opponent' | 'unit',
    index: number,
  ): AbilitySpend {
    return {
      side, row, index,
      cost: this.abilityCosts[index] ?? 0,
      uid,
      priorCooldown: this.cooldownRow(row)[index] ?? 0,
      priorBuff: this.buffs[uid] ?? null,
      priorUsed: !!this.abilityUsed[uid],
    };
  }

  private cooldownRow(row: 'mine' | 'opponent' | 'unit'): number[] {
    if (row === 'unit') return this.unitCooldowns;
    return row === 'mine' ? this.myCooldowns : this.opponentCooldowns;
  }

  private refund(spend: AbilitySpend): void {
    if (spend.side === 'mine') this.myPoints += spend.cost;
    else this.opponentPoints += spend.cost;
    this.cooldownRow(spend.row)[spend.index] = spend.priorCooldown;

    const buffs = { ...this.buffs };
    if (spend.priorBuff) buffs[spend.uid] = spend.priorBuff;
    else delete buffs[spend.uid];
    this.buffs = buffs;

    const used = { ...this.abilityUsed };
    if (spend.priorUsed) used[spend.uid] = true;
    else delete used[spend.uid];
    this.abilityUsed = used;
  }

  /** Commit the staged move, which also hands the turn over. */
  endTurn(): void {
    if (!this.canEndTurn) return;
    // Opponent action overlays describe the immediately preceding opponent
    // turn. Once our turn ends, they no longer belong on the board.
    this.opponentMoveVisuals = [];
    this.persistLocalUiState();
    this.playEndTurnSound();
    // Ending a turn cancels any ability detail/targeting state, including
    // the yellow/red target indicators on the board.
    this.abilityFocus = null;
    this.pendingAbility = null;
    this.unitAbilityFocus = null;
    this.cdr.markForCheck();
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
    this.persistLocalUiState();
    // The staged board stays up until move_made confirms it - see the handler.
  }

  private playTurnSoundIfNeeded(previousTurn: string | null): void {
    if (previousTurn === this.username || !this.isYourTurn) return;
    this.playTone([660, 880], 0.12);
  }

  private playEndTurnSound(): void {
    this.playTone([440, 330], 0.1);
  }

  private playBuffSound(): void {
    this.playTone([520, 700, 900], 0.08);
  }

  private playDebuffSound(): void {
    this.playTone([260, 190, 130], 0.1);
  }

  private playAbilitySound(): void {
    this.playTone([380, 520, 680], 0.08);
  }

  private playMoveSound(): void {
    // Four audible footfalls make movement unmistakable, even on laptop
    // speakers where the shorter notification tones can disappear.
    this.playTone([220, 280, 220, 280], 0.16);
  }

  private playAttackSound(): void {
    this.playTone([120, 260, 110], 0.06);
  }

  private playTone(frequencies: number[], duration: number): void {
    this.audioService.playTone(frequencies, duration);
  }

  /**
   * Each abilities box is live only on its own side's turn, and an opponent's
   * box is never live unless you are driving both sides (solo play).
   */
  canUseAbilities(side: 'mine' | 'opponent'): boolean {
    // Ability effects are currently client-side scaffolding. Keep them out of
    // multiplayer until the server has an authoritative ability protocol.
    if (!this.gameStarted || !this.isSinglePlayer) return false;
    const myTurn = this.gameState.snapshot.currentTurn === this.username;
    return side === 'mine' ? myTurn : !myTurn;
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
    if (this.isSinglePlayer || this.gameId === 'local') {
      localStorage.removeItem(LOCAL_UI_STATE_KEY);
    }
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
    this.persistLocalUiState();
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
      // Deliberately not sending turnTimeLimit: a pick already reached the
      // server through change_game_mode, and sending it unconditionally made
      // every start look like a pick - overwriting a custom config's own
      // limit (an "unlimited" game silently ran on 60s).
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