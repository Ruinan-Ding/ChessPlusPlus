import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, HostListener, ViewChild } from '@angular/core';
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
import { AnimStep, FallenUnit, GameBoardComponent, SelectedUnit, hexNumberMap } from '../game-board/game-board.component';
import {
  captureClaims, captureScore, hexDistanceKeys, isInsideBoard, strikeDamage, BASE_PANELS,
} from '../../services/hex-rules';
import { buildPlayback } from '../../services/playback';
import {
  OVERTIME_FIRST_PLY, SCORING_PHASES, handOversBy, isInitialization, isOvertime,
  phaseIndexAt, stageAt, turnHeading, turnOf,
} from '../../services/phases';
import { AudioService } from '../../services/audio.service';
import { readStore, removeStore, writeStore } from '../../services/storage';

interface GameOptions {
  reveal?: boolean;
  turnTimeLimit?: number;
}

const LOCAL_UI_STATE_KEY = 'cpp.localGame.ui.v1';

interface LocalUiState {
  myPoints: number;
  opponentPoints: number;
  myCpSpent: number;
  opponentCpSpent: number;
  unitCooldowns: number[];
  opponentCooldowns: number[];
  myCooldowns: number[];
  myLoadout: number[];
  opponentLoadout: number[];
  myPath: number | null;
  opponentPath: number | null;
  myUltimateUsed: boolean;
  opponentUltimateUsed: boolean;
  buffs: Record<string, UnitBuff>;
  abilityUsed: Record<string, boolean>;
  soloColor: 'white' | 'black';
  seatChoice: 'random' | 'white' | 'black';
  phaseBank: Record<number, { white: number; black: number }>;
  stagedActions: StagedAction[];
  swapDebt: { mine: number; opponent: number };
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
  /**
   * What is on the unit, one entry per cast. The numbers above are the sum
   * the board reads; this is the list the unit panel shows, because "-2 ATK"
   * on its own never says what put it there or when it lifts.
   */
  effects: UnitEffect[];
}

interface UnitEffect {
  name: string;
  mov: number;
  atk: number;
  def: number;
  /** Turns left. Everything cast today runs to the caster's next turn. */
  turns: number;
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

/**
 * What a unit mends for each turn it spends in its own base.
 * ponytail: the owner's placeholder - "1hp (for now at least)". A constant
 * because that is all it is; it moves to config when the real number lands.
 */
/**
 * A side's standing: what it holds this phase, what it has banked, and what
 * the two come to. Each phase is scored on its own - cap as the phase ended
 * against the losses taken inside it - so the three add up without charging
 * an early loss again in every later phase.
 */
interface Standing {
  /** Capture hexes held right now. */
  cap: number;
  /** What this phase's losses have cost. */
  death: number;
  /** This phase so far. */
  total: number;
  /** Phases already finished, in order. */
  banked: number[];
  /** Those plus this one - the match score. */
  match: number;
  /** Whether this side is ahead on `match`. */
  leading: boolean;
}

/**
 * How far behind a side may finish the third phase and still force overtime.
 * Black is allowed the wider gap because white moves first: white has to be
 * more than 5 clear to take it outright, black only more than 3.
 */
const OVERTIME_MARGIN = { white: 3, black: 5 };

/**
 * The last full turn of overtime. A match still undecided at the end of it
 * goes to black - so the verdict flips once the match is *past* turn 50, not
 * as it begins.
 */
const OVERTIME_LAST_TURN = 50;

/**
 * What a side is handed at the start of each phase to spend on abilities.
 * Five awards over a match - the opening, the three phases and overtime.
 * ponytail: the owner's placeholder - "for now, just set it to 100".
 */
const CP_PER_PHASE = 100;

/**
 * An HP back per turn for every unit standing in a **base** - the squad dealt
 * there at the start as much as a unit that walked home to mend. One rule for
 * both: they stand in the same panel, and a wound closing itself for one of
 * them while the identical wound stayed open on the unit beside it is the
 * kind of thing a player reads as a bug, because it is.
 *
 * A reserve does not mend. It is a staging area, not a hospital.
 */
const BASE_HEAL_PER_TURN = 1;

/** A unit that walked home, and the hex it stopped on. */
export interface WithdrawnUnit {
  at: string;
  unit: Record<string, any>;
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
  /** When it was staged, so Undo can tell it from a panel walk. */
  at?: number;
  /** What walking home into the base paid back, for Undo to take away again. */
  refund?: number;
  killed?: string;
  /** What died there, so the board can draw its ghost under the skull. */
  killedUnit?: { unit_id: string; color: 'white' | 'black' };
  /** What an ability cast charged, for Undo to hand back. */
  spend?: AbilitySpend;
  /**
   * Set when the swing came out of a panel: the reserve unit that made it,
   * and what it has left once the answer landed. No board holds a reserve, so
   * both ride here - which also means they are dropped wherever staging is.
   */
  panelUnit?: Record<string, any>;
  panelUnitHp?: number;
  /** Which panel it landed in - a base mends its wounded, a reserve does not. */
  panelName?: string;
  /** Whether the defender answered. A base never does, nor does anything out of reach. */
  countered?: boolean;
  /** The panel end was the defender, not the attacker. */
  intoPanel?: boolean;
  /** Whether that panel unit strikes back - a reserve does, a base does not. */
  counters?: boolean;
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
  /** The hex it landed on, or '' for a universal ability that named none. */
  hex?: string;
  /** Points the cast handed back, to take away again on Undo. */
  gain?: number;
  uid: string;
  priorCooldown: number;
  /** Whether that side had already spent its ultimate. */
  priorUltimate?: boolean;
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
      const saved = readStore('local', 'gameRoomMessages');
      if (saved) {
        try {
          this.gameRoomMessages = JSON.parse(saved);
        } catch {
          this.gameRoomMessages = [];
        }
        removeStore('local', 'gameRoomMessages');
      }
      const savedMode = readStore('local', 'gameRoomMode');
      if (savedMode === 'default' || savedMode === 'custom') {
        this.gameMode = savedMode;
      }
      const savedReveal = readStore('local', 'gameRoomReveal');
      if (savedReveal !== null) {
        try {
          this.revealEnabled = JSON.parse(savedReveal);
        } catch { this.revealEnabled = false; }
      }
      const savedOptions = readStore('local', 'gameRoomOptions');
      if (savedOptions) {
        try {
          this.gameOptions = JSON.parse(savedOptions);
        } catch { this.gameOptions = {}; }
      }
      removeStore('local', 'gameRoomMode');
      removeStore('local', 'gameRoomReveal');
      removeStore('local', 'gameRoomOptions');
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
    
    // Only send leave message if not already sent via leaveGameRoom().
    // Never for a solo room: leave_game_room is what clears the saved game,
    // and a browser Back is not the player throwing their position away.
    if (!isIntentionalNav && !this.wsService.isLocal()) {
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
      myCpSpent: this.myCpSpent,
      opponentCpSpent: this.opponentCpSpent,
      unitCooldowns: this.unitCooldowns,
      opponentCooldowns: this.opponentCooldowns,
      myCooldowns: this.myCooldowns,
      myLoadout: this.myLoadout,
      opponentLoadout: this.opponentLoadout,
      myPath: this.myPath,
      opponentPath: this.opponentPath,
      myUltimateUsed: this.myUltimateUsed,
      opponentUltimateUsed: this.opponentUltimateUsed,
      buffs: this.buffs,
      abilityUsed: this.abilityUsed,
      soloColor: this.soloColor,
      seatChoice: this.seatChoice,
      phaseBank: this.phaseBank,
      stagedActions: this.stagedActions,
      swapDebt: this.swapDebt,
      gameRoomMessages: this.gameRoomMessages,
      opponentMoveVisuals: this.opponentMoveVisuals,
    };
    try {
      writeStore('local', LOCAL_UI_STATE_KEY, JSON.stringify(state));
    } catch {
      console.warn('[GameRoom] Could not persist local ability state');
    }
  }

  private restoreLocalUiState(): void {
    if (this.gameId !== 'local') return;
    try {
      const raw = readStore('local', LOCAL_UI_STATE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as Partial<LocalUiState>;
      if (Number.isFinite(state.myPoints)) this.myPoints = state.myPoints!;
      if (Number.isFinite(state.opponentPoints)) this.opponentPoints = state.opponentPoints!;
      if (Number.isFinite(state.myCpSpent)) this.myCpSpent = state.myCpSpent!;
      if (Number.isFinite(state.opponentCpSpent)) this.opponentCpSpent = state.opponentCpSpent!;
      if (Array.isArray(state.unitCooldowns)) this.unitCooldowns = state.unitCooldowns;
      if (Array.isArray(state.opponentCooldowns)) this.opponentCooldowns = state.opponentCooldowns;
      if (Array.isArray(state.myCooldowns)) this.myCooldowns = state.myCooldowns;
      if (Array.isArray(state.myLoadout)) this.myLoadout = state.myLoadout;
      // Shape-checked like its neighbours: a stored value from an older
      // build indexes to undefined, and the arithmetic downstream turns that
      // into NaN on the panel rather than failing where it went wrong.
      const debt = state.swapDebt;
      if (debt && Number.isFinite(debt.mine) && Number.isFinite(debt.opponent)) {
        this.swapDebt = { mine: debt.mine, opponent: debt.opponent };
      }
      if (Array.isArray(state.opponentLoadout)) this.opponentLoadout = state.opponentLoadout;
      if (typeof state.myPath === 'number' || state.myPath === null) this.myPath = state.myPath;
      if (typeof state.opponentPath === 'number' || state.opponentPath === null) {
        this.opponentPath = state.opponentPath;
      }
      if (typeof state.myUltimateUsed === 'boolean') this.myUltimateUsed = state.myUltimateUsed;
      if (typeof state.opponentUltimateUsed === 'boolean') this.opponentUltimateUsed = state.opponentUltimateUsed;
      if (state.buffs && typeof state.buffs === 'object') this.buffs = state.buffs;
      if (state.abilityUsed && typeof state.abilityUsed === 'object') this.abilityUsed = state.abilityUsed;
      if (state.soloColor === 'white' || state.soloColor === 'black') this.soloColor = state.soloColor;
      if (state.seatChoice === 'random' || state.seatChoice === 'white'
          || state.seatChoice === 'black') {
        this.seatChoice = state.seatChoice;
      }
      if (state.phaseBank) this.phaseBank = state.phaseBank;
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
      case 'game_reset':
        // Back to the pre-game screen with the room intact. Only enough is
        // cleared here to make the waiting screen coherent - everything a
        // match owns is zeroed by `game_started` when the next one is dealt.
        this.gameStarted = false;
        this.isReady = false;
        this.gameState.reset();
        this.stagedActions = [];
        this.submittedTurn = -1;
        this.recapRunning = false;
        this.selectedUnit = null;
        this.addSystemMessage('Room reset. Set up and start again.');
        this.persistLocalUiState();
        this.cdr.markForCheck();
        break;

      case 'game_started':
        this.gameStarted = true;
        this.isReady = false;  // Reset ready state - button reverts to "Ready" and will be disabled
        this.gameState.reset();
        this.gameState.applyGameStarted(actualMessage);
        
        // Cleared first: these two lines are the only word the player gets on
        // which colour they were dealt, and a reset below them ate both.
        this.gameRoomMessages = [];
        const myColor = actualMessage.playerWhite === this.username ? 'White' : 'Black';
        this.addSystemMessage(`Game started! You are playing as ${myColor}.`);
        this.addSystemMessage(`${actualMessage.playerWhite} (White) moves first.`);
        this.myPoints = 0;
        this.opponentPoints = 0;
        this.myCpSpent = 0;
        this.opponentCpSpent = 0;
        this.phaseBank = {};
        this.standingsCache = null;
        this.unitCooldowns = this.abilityEffects.map(() => 0);
        this.opponentCooldowns = this.abilityEffects.map(() => 0);
        this.myCooldowns = this.abilityEffects.map(() => 0);
        this.myLoadout = [];
        this.opponentLoadout = [];
        this.myPath = null;
        this.opponentPath = null;
        this.abilityGlow = { mine: [], opponent: [] };
        this.abilityPickGlow = { mine: [], opponent: [] };
        this.myUltimateUsed = false;
        this.opponentUltimateUsed = false;
        this.buffs = {};
        this.abilityUsed = {};
        this.opponentMoveVisuals = [];
        // A solo room restores its last session on entry, so a fresh deal has
        // to drop what belonged to the old one - a staged board outlives the
        // game it was staged in otherwise, and hides the new position.
        this.stagedActions = [];
        this.submittedTurn = -1;
        // The recap belongs to the game that just ended. If its board went
        // away mid-replay there was no playbackDone to unlock anything, and
        // a lock left standing here makes the new game unplayable.
        this.recapRunning = false;
        this.glowReveal = [];
        this.swapArmed = null;
        this.swapDebt = { mine: 0, opponent: 0 };
        this.standingsCache = null;
        // Anything opened while waiting belongs to the room, not the game.
        this.abilityFocus = null;
        this.pathFocus = null;
        this.unitAbilityFocus = null;
        this.pendingAbility = null;
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
              // A blow into a panel writes `defenderHp`; one on the board writes
              // `defender_hp`. The panel defender is on no board to look up either,
              // so without both keys the line read "survives, undefined HP".
              moveText += ` (${defenderUnit} survives, `
                + `${(move as any).defenderHp ?? move.defender_hp} HP)`;
            }
          }
          this.addSystemMessage(moveText);
        }
        this.cdr.markForCheck();
        break;
      }
      case 'game_over': {
        this.clearTurnClock();
        // `gameStarted` deliberately stays true: the finished position stays
        // on screen with its result over it, and the setup controls come back
        // only when the host resets the room. `gameOver` is what the rest of
        // the component asks now that started no longer means playable.
        // Whatever the board was replaying is over, and nothing else will
        // announce that it finished, so the curtain comes down here.
        this.recapRunning = false;
        this.glowReveal = [];
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
        // No restoreLocalUiState() here. It reads points, CP, cooldowns,
        // loadouts and the staged turn back off disk, which is right exactly
        // once - at ngOnInit, where it already runs - and wrong every other
        // time, because this component outlives a reconnect and its own
        // fields are then newer than the last persist. `enter()` emits one of
        // these per crossing, so it was running in the middle of committing a
        // turn and rolling back whatever had changed since.
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
        // The offline engine's rejection; same consequence as the server's -
        // including undoing the commit, which this used not to do. The turn
        // did not go through, so the one-commit-per-turn guard has to lift or
        // End Turn is dead for the rest of the turn, and the recap curtain has
        // to come down or the board never takes another click. Both together
        // are what "the game fails to end turn" looked like.
        this.stagedActions = [];
        this.submittedTurn = -1;
        this.recapRunning = false;
        this.glowReveal = [];
        // Crossings go to the engine ahead of the move and it keeps them, so
        // the board's staged copies have to go or End Turn sends them again.
        this.boardRef?.discardCrossings();
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
        if (MOVE_ERROR_CODES.has(actualMessage.code)) {
          this.stagedActions = [];
          // The turn did not go through, so it can be built and sent again -
          // otherwise the one-commit-per-turn guard leaves the player unable
          // to end a turn the server just refused.
          this.submittedTurn = -1;
        }
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
    writeStore('local', 'gameRoomOptions', JSON.stringify(this.gameOptions));
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

  /**
   * Turn the board round to read it from the other side. Cosmetic only - it
   * turns what is drawn, not whose turn it is or which units answer to you.
   *
   * Held apart from the seat's own rotation rather than folded into it, so a
   * black seat (which is already turned) flips back to white's view rather
   * than to no view at all. `boardFlipped` is the two together.
   */
  flipView = false;

  /** Which way up the board is drawn: the seat's rotation, flipped or not. */
  get boardFlipped(): boolean {
    const seat = this.isSinglePlayer && this.soloColor === 'black';
    return seat !== this.flipView;
  }

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
    // Veterancy rides right behind the name, same stars the hex draws.
    const stars = '\u2605'.repeat(Math.max(0, Math.min(3, u.vet)));
    // The side is not part of the name - it sits at the far end of the tab,
    // see unitSideLabel.
    return `${u.name}${stars ? ' ' + stars : ''} - ${u.points} pts`;
  }

  /** Whose unit this is, drawn at the far end of the panel's tab. */
  /**
   * Whether the Unit panel is showing something you cannot act with - one of
   * theirs, or one of yours that has nothing left this turn. The panel
   * darkens for it, the same way the Opponent panel is always dark: a glance
   * at the ground says the unit is a readout, not a control, before a word on
   * it is read.
   *
   * The board decides, not this: which unit may act is its rule set - the
   * turn's one unit, the opening's allowances, a panel's movers - and it
   * hands the answer over with the selection.
   */
  get unitPanelDim(): boolean {
    const unit = this.displayUnit;
    return !!unit && !unit.drivable;
  }

  get unitSideLabel(): string {
    const u = this.displayUnit;
    return u ? (u.color === 'white' ? 'White' : 'Black') : '';
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

  /**
   * Everything riding on the unit the panel is showing: each cast that landed
   * on it, and the passive it has earned. Casts run to the caster's next turn
   * - one turn - and a passive never lifts.
   */
  get displayEffects(): Array<{ name: string; detail: string; life: string }> {
    const rows = (this.displayBuff?.effects ?? []).map(effect => ({
      name: effect.name,
      detail: this.effectSummary(effect),
      life: `${effect.turns} turn${effect.turns === 1 ? '' : 's'}`,
    }));

    // A third star is worth something different to every unit.
    const unit = this.displayUnit;
    if (unit && unit.vet >= 3) {
      const bonus = this.vetBonus[unit.unitId];
      if (bonus) {
        rows.push({
          name: 'Veteran',
          detail: this.effectSummary({ mov: bonus.mov ?? 0, atk: bonus.atk ?? 0, def: bonus.def ?? 0 }),
          life: 'always',
        });
      }
    }

    // The passive is the path's, and it is on every unit this side owns - so
    // it is always in the list, saying either that it is on or what the unit
    // still needs before it is.
    const path = this.pathChoice('mine');
    const passive = path ? this.abilityEffects[path.passive] : null;
    if (passive && unit) {
      const earned = unit.vet >= 1;
      rows.push({
        name: passive.name,
        detail: this.effectSummary(passive) || 'passive',
        life: earned ? 'always' : 'needs ★',
      });
    }
    return rows;
  }

  /** "+2 ATK, -1 MOV" for one effect, or '' when it moves no stat. */
  private effectSummary(effect: { mov: number; atk: number; def: number }): string {
    const parts: string[] = [];
    const sign = (n: number) => `${n > 0 ? '+' : ''}${n}`;
    if (effect.mov) parts.push(`${sign(effect.mov)} MOV`);
    if (effect.atk) parts.push(`${sign(effect.atk)} ATK`);
    if (effect.def) parts.push(`${sign(effect.def)} DEF`);
    return parts.join(', ');
  }

  /** Wounded units pulse their remaining HP, as they do on the board. */
  get hpWave(): string {
    const unit = this.displayUnit;
    return unit && unit.hp != null && unit.hpMax != null && unit.hp < unit.hpMax
      ? 'wave-hurt' : '';
  }

  /**
   * Whether the side to move has already spent its battlefield move for THIS
   * turn of the opening. Each of a side's three opening turns carries one:
   * either send a unit home to the base or move one, three base units and
   * three reserve units besides.
   *
   * Per turn, not per phase. It was once per phase, which left a side with
   * nothing at all to do on its second and third opening turns - the owner's
   * "you disabled all units during initialization". What lasts the phase is
   * the lock on the *unit* that moved (`initMovedHexes`), not the allowance.
   *
   * Read off the move history rather than counted as it goes: a panel walk
   * is client-side and never reaches the record, so every move in there is a
   * battlefield move, and deriving it means a reload and the other player
   * see the same thing.
   */
  get initBoardSpent(): boolean {
    const s = this.gameState.snapshot;
    if (!isInitialization(s.turnNumber)) return false;
    const color = this.gameState.myColor(s.currentTurn);
    if (!color) return false;
    const turn = turnOf(s.turnNumber);
    return (s.moveHistory ?? []).some(
      // A crossing is a reserve's move, not the board move of the opening.
      m => m.color === color && turnOf(m.turn) === turn && !m.entered);
  }

  /**
   * Where this side's already-moved opening units now stand. A unit gets one
   * move for the whole initialization, so the turn's fresh allowance must not
   * hand it a second one.
   *
   * Keyed by the hex it moved to rather than by uid: nothing is captured in
   * the opening, so a unit that has moved is still standing where it landed,
   * and the record carries no uid to key on. A unit sent home has left the
   * board entirely and is not in this.
   */
  private initMovedCache: { history: unknown; turn: number; hexes: string[] } | null = null;

  get initMovedHexes(): string[] {
    const s = this.gameState.snapshot;
    const history = s.moveHistory;
    const turn = s.turnNumber;
    if (this.initMovedCache?.history === history && this.initMovedCache.turn === turn) {
      return this.initMovedCache.hexes;
    }
    let hexes: string[] = [];
    const color = isInitialization(turn) ? this.gameState.myColor(s.currentTurn) : null;
    if (color) {
      hexes = (history ?? [])
        .filter((m: any) => m.color === color && isInitialization(m.turn)
          && !m.entered && !m.withdrawn)
        .map((m: any) => m.to);
    }
    this.initMovedCache = { history, turn, hexes };
    return hexes;
  }

  /**
   * Whether the header draws the phase numbers at all. Overtime scores
   * nothing - it is a deathmatch until a king falls or turn 50 runs out - so
   * the numbers would sit there frozen and mean nothing.
   */
  get showScore(): boolean {
    return !isOvertime(this.gameState.snapshot.turnNumber);
  }

  /** Whether a hex is off the battlefield - where the panels start. */
  private offBoard(key: string): boolean {
    const [q, r] = key.split(',').map(Number);
    const radius = this.gameState.snapshot.config?.board?.radius ?? 11;
    return !isInsideBoard(q, r, radius);
  }

  /**
   * Units that walked home into a base, keyed by where they stopped.
   *
   * The panels are the client's own, so all the engine keeps of a withdrawal
   * is the record of it - and that is enough: the unit travels in the record,
   * so the base rebuilds itself from the history after a reload rather than
   * from anything held here.
   */
  private withdrawnCache:
    { history: unknown; turn: number; units: WithdrawnUnit[] } | null = null;

  /**
   * What a unit in a base has mended since the turn its HP was last written
   * down. Shared by the two derivations that feed a base - the units dealt
   * there and the units that walked home - so they cannot drift apart.
   *
   * Counted in that side's OWN hand-overs, not in plies: a base mends at the
   * end of its owner's turn, so a unit standing through a full turn takes one
   * HP back and not the two a ply count would have given it. `now` is the ply
   * about to be played, so the last one finished is `now - 1`.
   */
  private mendedSince(color: 'white' | 'black', since: number, now: number): number {
    return Math.max(0, handOversBy(color, now - 1) - handOversBy(color, since))
      * BASE_HEAL_PER_TURN;
  }

  get withdrawnUnits(): WithdrawnUnit[] {
    const snapshot = this.gameState.snapshot;
    const history = snapshot.moveHistory;
    const turn = snapshot.turnNumber;
    const cached = this.withdrawnCache;
    if (cached && cached.history === history && cached.turn === turn) return cached.units;
    // Keyed by uid, not by the hex it landed on: a unit shuffled off its
    // landing hex frees it for the next one home, and keying by hex would
    // then have the second record quietly erase the first.
    // Each unit's last word on its own HP, and the turn it was said: the
    // record that brought it home, or a later blow that found it there. The
    // mending runs from whichever came last, so a wound taken in the base is
    // healed off from where it left the unit rather than ignored.
    const base = new Map<string, { at: string; unit: any; hp: number; turn: number }>();
    for (const move of history ?? []) {
      const record = move as any;
      if (!record) continue;
      if (record.withdrawn && record.unit) {
        base.set(record.unit.uid ?? move.to, {
          at: move.to, unit: record.unit, hp: record.unit.hp ?? 0, turn: record.turn,
        });
        continue;
      }
      // Something that set a panel unit's HP while it stood in the base - a
      // blow, or an ability. Reserves are not in here: they are dealt from the
      // roster and read `panelHp` instead.
      if (!record.intoPanel || !record.unit?.uid || record.defenderHp === undefined) continue;
      const standing = base.get(record.unit.uid);
      if (standing) {
        standing.hp = record.defenderHp ?? 0;
        standing.turn = record.turn;
      }
    }
    const units: WithdrawnUnit[] = [];
    for (const stood of base.values()) {
      // Killed where it stood: not drawn, and not mended back to life.
      if (stood.hp <= 0) continue;
      // A unit sitting in the base mends: an HP for every turn since its last
      // word, never past what it started with. Derived rather than tallied,
      // so it reads the same after a reload as it did before one.
      const full = stood.unit.max_hp ?? stood.unit.hp ?? 0;
      const mended = stood.hp + this.mendedSince(stood.unit.color, stood.turn, turn);
      units.push({ at: stood.at, unit: { ...stood.unit, hp: Math.min(full, mended) } });
    }
    this.withdrawnCache = { history, turn, units };
    return units;
  }

  /**
   * Reserves that have walked onto the battlefield, by uid. A panel keeps its
   * dealt squad for the whole game, so without this a unit that crossed and
   * was later killed would be drawn back in its old panel hex, alive and
   * ready to cross again - the board it died on no longer names it.
   */
  private departedCache: { history: unknown; uids: string[] } | null = null;

  get departedUids(): string[] {
    const history = this.gameState.snapshot.moveHistory;
    const cached = this.departedCache;
    if (cached && cached.history === history) return cached.uids;
    const uids: string[] = [];
    for (const move of history ?? []) {
      const record = move as any;
      if (record.entered && record.unit?.uid) uids.push(record.unit.uid);
    }
    this.departedCache = { history, uids };
    return uids;
  }

  private panelHpCache:
    { history: unknown; turn: number; hp: Record<string, number> } | null = null;

  /**
   * Every panel unit that has been in a fight, against what it has left -
   * a base's mending included.
   *
   * Derived from the record rather than tallied: the panel is re-dealt from
   * the roster on every rebuild, so a wound written only into the deal would
   * heal itself on the next one - and this way it reads the same after a
   * reload. The staged wounds of the turn in progress go on top, so a swing
   * shows its cost before it is committed.
   *
   * **A base mends and a reserve does not**, so this reads the panel off the
   * record rather than the unit: a blow in a base closes an HP a turn on the
   * same arithmetic `withdrawnUnits` uses for a unit that walked home there,
   * and a blow in a reserve stays open. Which is why the cache is keyed on
   * the ply as well as on the history: nothing is recorded when a unit mends,
   * so a turn passing is the whole of what changed.
   */
  get panelHp(): Record<string, number> {
    const history = this.gameState.snapshot.moveHistory;
    const turn = this.gameState.snapshot.turnNumber;
    const cached = this.panelHpCache;
    if (!cached || cached.history !== history || cached.turn !== turn) {
      // Each unit's last word on its own HP, and the turn it was said.
      const wounds = new Map<string, {
        left: number; turn: number; full: number;
        color: 'white' | 'black'; mends: boolean;
      }>();
      for (const move of (history ?? []) as any[]) {
        // A blow or an ability - anything that wrote down what a panel unit
        // has left. Both are the unit's last word on its own HP.
        if (!move?.intoPanel || !move.unit?.uid || move.defenderHp === undefined) continue;
        wounds.set(move.unit.uid, {
          left: move.defenderHp ?? 0,
          turn: move.turn,
          full: move.unit.max_hp ?? move.unit.hp ?? 0,
          color: move.unit.color as 'white' | 'black',
          mends: BASE_PANELS.has(move.panel),
        });
      }
      const hp: Record<string, number> = {};
      for (const [uid, wound] of wounds) {
        // Nothing mends back from nothing: 0 is what killed in a panel means.
        hp[uid] = wound.left <= 0 ? 0 : Math.min(wound.full, wound.left
          + (wound.mends ? this.mendedSince(wound.color, wound.turn, turn) : 0));
      }
      this.panelHpCache = { history, turn, hp };
    }
    const settled = this.panelHpCache!.hp;
    const staged = this.stagedActions.filter(a => a.panelUnit);
    if (!staged.length) return settled;
    const hp = { ...settled };
    for (const action of staged) hp[action.panelUnit!['uid']] = action.panelUnitHp!;
    return hp;
  }

  /**
   * The CP a side has: what the phases have handed out so far, less what it
   * has spent. Abilities are bought with this and nothing else - the points
   * beside the Abilities tab stay the board's currency, for wrap crossings
   * and the refund for coming home.
   */
  cpOf(side: 'mine' | 'opponent'): number {
    const phases = phaseIndexAt(this.gameState.snapshot.turnNumber) + 1;
    return CP_PER_PHASE * phases - (side === 'mine' ? this.myCpSpent : this.opponentCpSpent);
  }

  get myCp(): number { return this.cpOf('mine'); }

  /** Take CP off a side; a negative amount hands some back. */
  private spendCp(side: 'mine' | 'opponent', amount: number): void {
    if (side === 'mine') this.myCpSpent += amount;
    else this.opponentCpSpent += amount;
  }

  /**
   * Whether a slot belongs to one of the three paths - a passive, a skill or
   * an ultimate. Those are the special abilities, and they are the ones
   * bought with CP; the eight in the pool are bought with points.
   *
   * Asked of the paths rather than of the slot number, so moving a path's
   * slots around cannot quietly change what they cost.
   */
  isPathSlot(index: number): boolean {
    return this.abilityPaths.some(
      path => path.passive === index || path.skill === index || path.ultimate === index);
  }

  /** What a side has to spend on that slot, in whichever currency buys it. */
  private purseFor(side: 'mine' | 'opponent', index: number): number {
    if (this.isPathSlot(index)) return this.cpOf(side);
    return side === 'mine' ? this.myPoints : this.opponentPoints;
  }

  /** Charge a slot's currency. A negative amount hands it back. */
  private chargeFor(side: 'mine' | 'opponent', index: number, amount: number): void {
    if (this.isPathSlot(index)) { this.spendCp(side, amount); return; }
    if (side === 'mine') this.myPoints -= amount; else this.opponentPoints -= amount;
  }

  /** What buys that slot, named for a hint - and counted, so "1 point" reads. */
  private purseName(index: number, cost: number): string {
    if (this.isPathSlot(index)) return 'CP';
    return cost === 1 ? 'point' : 'points';
  }

  /**
   * The number in the Abilities panel's head: whichever currency the thing
   * being looked at is bought with. A path or one of its abilities is CP;
   * anything else - the pool, or nothing open at all - is points.
   */
  abilityPurseLabel(side: 'mine' | 'opponent'): string {
    const path = this.pathFocusFor(side);
    const focus = this.abilityFocus?.side === side ? this.abilityFocus.index : null;
    if (path || (focus !== null && this.isPathSlot(focus))) return `CP: ${this.cpOf(side)}`;
    if (focus !== null) return `Points: ${side === 'mine' ? this.myPoints : this.opponentPoints}`;
    // Nothing open: a price is no use until there is something to price, so
    // the head carries what the panel is actually asking for.
    return `Pick ${this.picksLeft(side)}`;
  }

  /**
   * Picks a side still has. The pool goes two at a time, so four slots is two
   * picks - and this counts picks, not abilities, because that is the unit
   * the player chooses in.
   */
  picksLeft(side: 'mine' | 'opponent'): number {
    return Math.max(0, Math.floor((this.abilitySlots - this.loadout(side).length) / 2));
  }

  /** Points the side to move has to spend - what the board prices a wrap against. */
  get movePoints(): number {
    const color = this.gameState.myColor(this.gameState.snapshot.currentTurn);
    const mine = this.gameState.myColor(this.username);
    return (mine ? color === mine : color === 'white') ? this.myPoints : this.opponentPoints;
  }

  /**
   * What the side NOT to move has. Only the board's preview reads it: looking
   * at one of their units prices its crossing against their purse.
   */
  get theirMovePoints(): number {
    const color = this.gameState.myColor(this.gameState.snapshot.currentTurn);
    const mine = this.gameState.myColor(this.username);
    return (mine ? color === mine : color === 'white') ? this.opponentPoints : this.myPoints;
  }

  /** A unit bought its way across the wrap. */
  onWrapCrossed(cost: number): void {
    const color = this.gameState.myColor(this.gameState.snapshot.currentTurn);
    this.awardPoints(color, -cost);
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /** History header carries the turn and where it sits in the schedule. */
  get historyTitle(): string {
    const turn = this.gameState.snapshot.turnNumber;
    return turn ? turnHeading(turn) : 'History';
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

    // A panel is a unit like any other to an ability - the owner's rule:
    // "abilities can apply to anything. though for example ATK ability on
    // base unit is simply pointless but they can do it."
    if (!unit) {
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
  /**
   * Move a unit's HP by `delta`, wherever it happens to be standing.
   *
   * A unit on the battlefield keeps its HP on the board, so the change goes
   * onto the staged copy. A unit in a panel is on no board at all - its HP
   * exists only in the move history - so the change is staged the way a blow
   * into a panel is, and goes out as its own message when the turn commits.
   * Callers should not have to know which kind of hex they landed on.
   */
  private hpChange(unit: SelectedUnit, delta: number, board: Record<string, any>): {
    board: Record<string, any>;
    killed?: string;
    killedUnit?: { unit_id: string; color: 'white' | 'black' };
    panelUnit?: Record<string, any>;
    panelUnitHp?: number;
    panelName?: string;
  } {
    if (unit.panel) {
      const full = unit.hpMax ?? unit.hp ?? 0;
      const left = Math.max(0, Math.min(full, (unit.hp ?? 0) + delta));
      return {
        board,
        panelName: unit.panel,
        panelUnitHp: left,
        // The whole unit rides along: the record is the only place a panel
        // unit survives, so a name for it is not enough.
        panelUnit: {
          unit_id: unit.unitId, color: unit.color, uid: unit.uid,
          hp: unit.hp ?? 0, max_hp: full,
        },
        ...(left <= 0
          ? { killed: unit.key, killedUnit: { unit_id: unit.unitId, color: unit.color } }
          : {}),
      };
    }
    const standing = board[unit.key];
    if (!standing) return { board };
    const full = standing.max_hp ?? standing.hp ?? 0;
    const left = Math.max(0, Math.min(full, (standing.hp ?? 0) + delta));
    const next = { ...board };
    if (left <= 0) {
      delete next[unit.key];
      return {
        board: next, killed: unit.key,
        killedUnit: { unit_id: standing.unit_id, color: standing.color },
      };
    }
    next[unit.key] = { ...standing, hp: left };
    return { board: next };
  }

  private castOffensiveOn(unit: SelectedUnit): void {
    const armed = this.pendingAbility;
    if (!armed) return;
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    const effect = this.abilityEffects[armed.index];
    const cost = this.abilityCosts[armed.index] ?? 0;
    if (unit.color === this.casterColor(armed.side)) return;
    if (!unit.panel && !board[unit.key]) return;
    const hit = this.hpChange(unit, -(effect.damage ?? 0), board);
    // Onto the staged stack like everything else, so it shows through a
    // staged step and Undo takes it back. A held-aside board was invisible
    // whenever anything else was staged, and Undo never cleared it.
    const prev = this.stagedActions[this.stagedActions.length - 1];
    const spend = this.spendOf(unit.uid, armed.side, armed.side, armed.index, unit.key);
    this.stagedActions.push({
      at: Date.now(),
      from: prev?.from ?? '',
      to: prev?.to ?? '',
      used: prev?.used ?? 0,
      attack: null,
      spend,
      ...hit,
    });
    // A sapped stat is a boost with the sign flipped, and the mark rides in
    // the same entry: a separate debuff map expired a ply before the penalty
    // it stood for, leaving lowered numbers with nothing explaining them.
    this.buffs = {
      ...this.buffs,
      [unit.uid]: this.stack(unit.uid, effect, this.casterColor(armed.side), true),
    };
    this.playSteps([{
      kind: 'ability', from: unit.key, to: unit.key,
      index: armed.index, side: armed.side, hostile: true,
    }]);
    this.chargeFor(armed.side, armed.index, cost);
    armed.cooldowns[armed.index] = 3;
    this.markUsed(armed.side, armed.index);
    this.pendingAbility = null;
    this.clearAbilityFocus();
    this.persistLocalUiState();
    this.addSystemMessage(`${effect.name} hit ${unit.unitId} for ${effect.damage ?? 0} damage (scaffold).`);
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
    return this.abilityPaths.some(path => path.passive === index);
  }

  isUltimate(index: number): boolean {
    return this.abilityPaths.some(path => path.ultimate === index);
  }

  /** The path a side took, or null. */
  pathOf(side: 'mine' | 'opponent'): number | null {
    return side === 'mine' ? this.myPath : this.opponentPath;
  }

  pathChoice(side: 'mine' | 'opponent') {
    const taken = this.pathOf(side);
    return taken === null ? null : this.abilityPaths[taken];
  }

  /** "Bastion - 6", for the three buttons standing in for a locked path. */
  pathLabel(index: number): string {
    const path = this.abilityPaths[index];
    return `${path.name} - ${path.cost}`;
  }

  pathHint(index: number): string {
    const path = this.abilityPaths[index];
    return `${path.cost} points: ${this.abilityEffects[path.passive].name} on every unit you own, `
      + `plus ${this.abilityEffects[path.skill].name} and `
      + `${this.abilityEffects[path.ultimate].name}.`;
  }

  canUnlockPath(side: 'mine' | 'opponent', index: number): boolean {
    if (this.pathOf(side) !== null || !this.canChooseAbilities(side)) return false;
    return this.cpOf(side) >= this.abilityPaths[index].cost;
  }

  /**
   * The path a side is reading about before committing to it. One per match
   * and paid for once, so it gets the same look-then-confirm the abilities
   * have rather than going through on the first click.
   */
  pathFocus: { side: 'mine' | 'opponent'; index: number } | null = null;

  /** The path this side is currently reading, and what it grants, or null. */
  pathFocusFor(side: 'mine' | 'opponent') {
    if (this.pathFocus?.side !== side) return null;
    return { index: this.pathFocus.index, path: this.abilityPaths[this.pathFocus.index] };
  }

  focusPath(side: 'mine' | 'opponent', index: number): void {
    this.pathFocus = this.pathFocus?.side === side && this.pathFocus.index === index
      ? null : { side, index };
    this.cdr.markForCheck();
  }

  clearPathFocus(): void {
    this.pathFocus = null;
    this.cdr.markForCheck();
  }

  /** Why this path cannot be taken, for the confirmation screen to say. */
  pathBlocker(side: 'mine' | 'opponent', index: number): string {
    if (this.canUnlockPath(side, index)) return '';
    if (this.pathOf(side) !== null) return 'You have already taken a path.';
    if (!this.canChooseAbilities(side)) return 'Unavailable: not your turn.';
    return `Unavailable: costs ${this.abilityPaths[index].cost} CP, `
      + `you have ${this.cpOf(side)}.`;
  }

  /**
   * The line under a path's buttons. Always says something: a line that comes
   * and goes moves everything under it, and when there is nothing stopping you
   * the useful thing to say is what the screen is for.
   */
  pathNote(side: 'mine' | 'opponent', index: number): string {
    return this.pathBlocker(side, index)
      || 'Pick to take the path.';
  }

  /** Take a path. One per match, paid for once, kept for the rest of it. */
  unlockPath(side: 'mine' | 'opponent', index: number): void {
    if (!this.canUnlockPath(side, index)) return;
    this.pathFocus = null;
    const path = this.abilityPaths[index];
    this.spendCp(side, path.cost);
    if (side === 'mine') this.myPath = index; else this.opponentPath = index;
    // The passive is what names the path, so it is the slot that flashes -
    // and markPicked lights the other two with it.
    this.flashPick(side, path.passive);
    this.addSystemMessage(`${side === 'mine' ? 'You' : 'Your opponent'} took the ${path.name} path.`);
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /**
   * The pool in its own order. Picking marks an ability rather than moving
   * it: a list that reshuffles under the cursor is harder to read than one
   * that stays put.
   */
  abilityOrder(side: 'mine' | 'opponent'): number[] {
    return this.abilityPool;
  }

  loadout(side: 'mine' | 'opponent'): number[] {
    return side === 'mine' ? this.myLoadout : this.opponentLoadout;
  }

  isPicked(side: 'mine' | 'opponent', index: number): boolean {
    return this.loadout(side).includes(index);
  }

  /** Your turn, still a free slot, and this one is not already in it. */
  canPick(side: 'mine' | 'opponent', index: number): boolean {
    // A pick is a move: it is for the match, the other player is told about
    // it, and it happens on your own turn. Without this it could be taken at
    // any moment, including in the middle of theirs.
    // Room for the pair, not for one: a pick brings two, so a single slot
    // left is not a pick that can be made.
    return this.canChooseAbilities(side)
      && this.isPoolAbility(index)
      && !this.pairOf(index).some(i => this.isPicked(side, i))
      && this.loadout(side).length + 2 <= this.abilitySlots;
  }

  /** One of the eight a side chooses four of. Path abilities are not. */
  isPoolAbility(index: number): boolean {
    return this.abilityPool.includes(index);
  }

  /**
   * The pool is picked in **pairs**: taking one takes the ability beside it.
   * Four slots and two to a pick means two picks a match.
   *
   * The pairing is the panel's own layout - two columns, so a row is a pair -
   * which is what `^ 1` says: 0 with 1, 2 with 3, and so on. The line drawn
   * between them is the same fact, said on screen.
   */
  partnerOf(index: number): number {
    return index ^ 1;
  }

  /** Both halves of a pick, in panel order. */
  pairOf(index: number): number[] {
    const partner = this.partnerOf(index);
    return index < partner ? [index, partner] : [partner, index];
  }

  /** The left half of a pair, which is where the connecting line starts. */
  isPairLeft(index: number): boolean {
    return this.isPoolAbility(index) && index % 2 === 0;
  }

  /** The path an ability comes with, whether or not anybody has taken it. */
  pathOwning(index: number) {
    return this.abilityPaths.find(
      p => p.passive === index || p.skill === index || p.ultimate === index) ?? null;
  }

  /** Whether the focused ability is one this side could still take up. */
  get focusedAbilityCanBePicked(): boolean {
    const f = this.abilityFocus;
    return !!f && this.isPoolAbility(f.index) && !this.isPicked(f.side, f.index);
  }

  /**
   * Whether the detail shows a Use button at all. A path's ultimate shows one
   * before the path is taken - greyed, because seeing what you would get is
   * the point of reading it - but a pool ability you have not picked shows
   * Pick instead, since picking is the thing to do there.
   */
  get focusedAbilityShowsUse(): boolean {
    const f = this.abilityFocus;
    if (!f || !this.focusedAbilityIsUniversal) return false;
    return this.focusedAbilityIsCarried || !!this.pathOwning(f.index);
  }

  /**
   * Take an ability into the four. A pick is for the match - there is no
   * putting one back - and the other player sees which one it was, glowing
   * on your list through their next turn.
   */
  pickAbility(side: 'mine' | 'opponent', index: number): void {
    // Only the pool is picked into the four. A path's skill arrives with the
    // path or not at all - without this it could be taken on its own from the
    // screen that shows what a path would grant.
    if (!this.isPoolAbility(index)) return;
    if (!this.canPick(side, index)) return;
    // Both halves, always: the pair is the unit of choice.
    const pair = this.pairOf(index);
    const next = [...this.loadout(side), ...pair];
    if (side === 'mine') this.myLoadout = next; else this.opponentLoadout = next;
    // Slots Reselect freed are refilled cold. Swapping changes what you
    // carry; it is not a way to hand yourself a ready ability mid-match.
    // Three turns, the same as any cast leaves behind.
    for (const i of pair) {
      if (this.swapDebt[side] > 0) {
        this.swapDebt[side]--;
        this.cooldownRow(side)[i] = 3;
      }
    }
    for (const i of pair) this.flashPick(side, i);
    // Picking is not using: back to the list with nothing armed, and the
    // ability is opened again when it is actually wanted.
    this.clearAbilityFocus();
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /**
   * Whose + is armed. While it is, that side's carried four are offered back:
   * clicking one gives it up and frees the slot. Anything else puts it away -
   * another click on the +, a click on any other ability, Back, or the turn
   * ending - so it cannot be left armed over a board nobody is looking at.
   */
  swapArmed: 'mine' | 'opponent' | null = null;

  /**
   * Slots given up this way and not yet refilled. One pick each, and each of
   * those comes in on cooldown. Kept as a count rather than a flag because
   * two can be given up before either is replaced.
   */
  swapDebt = { mine: 0, opponent: 0 };

  /** The + has something to offer: your turn, and one of the four is cold. */
  canSwap(side: 'mine' | 'opponent'): boolean {
    return this.canChooseAbilities(side)
      && this.loadout(side).some(i => !(this.cooldownRow(side)[i] ?? 0));
  }

  toggleSwap(side: 'mine' | 'opponent'): void {
    if (this.swapArmed !== side && !this.canSwap(side)) return;
    this.swapArmed = this.swapArmed === side ? null : side;
    this.cdr.markForCheck();
  }

  /** Offered back right now - and what the yellow ring is drawn on. */
  canReset(side: 'mine' | 'opponent', index: number): boolean {
    return this.swapArmed === side
      && this.canChooseAbilities(side)
      && this.isPicked(side, index)
      && !(this.cooldownRow(side)[index] ?? 0);
  }

  /**
   * Give a carried ability up, freeing its slot for another. Only a cold one:
   * an ability is not swapped out from under the cooldown it is serving.
   */
  resetAbility(side: 'mine' | 'opponent', index: number): void {
    if (!this.canReset(side, index)) return;
    // A pair came in together and goes back together, or a slot is left
    // holding half a pick that can never be completed.
    const pair = this.pairOf(index);
    const next = this.loadout(side).filter(i => !pair.includes(i));
    if (side === 'mine') this.myLoadout = next; else this.opponentLoadout = next;
    this.swapDebt[side] += pair.length;
    this.swapArmed = null;
    // Taken up and given back inside one turn is not a pick: the glow comes
    // down with it, and the recap has nothing left to replay for it.
    this.pickedThisTurn = this.pickedThisTurn.filter(
      p => !(p.side === side && pair.includes(p.index)));
    if (pair.some(i => this.abilityPickGlow[side].includes(i))) {
      this.abilityPickGlow = {
        ...this.abilityPickGlow,
        [side]: this.abilityPickGlow[side].filter(i => !pair.includes(i)),
      };
    }
    // The detail was open on something this side no longer carries, and it
    // would go on offering to use it. Same reason pickAbility clears it.
    if (this.abilityFocus?.side === side && pair.includes(this.abilityFocus.index)) {
      this.clearAbilityFocus();
    }
    const name = this.abilityEffects[index]?.name ?? 'an ability';
    this.addSystemMessage(
      `${side === 'mine' ? 'You' : 'Your opponent'} gave up ${name}.`);
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /**
   * Which veterancy rank unlocks a slot: the passive comes first at one star,
   * the unit's active skill at two. Three is not a slot at all - it is the
   * stat bonus in `vetBonus`.
   * ponytail: a flat table, not per-unit - the roster does not exist yet.
   */
  private vetNeeded(index: number): number {
    return this.isPassive(index) ? 1 : 2;
  }

  /** True when the displayed unit has earned that slot. */
  vetUnlocked(index: number): boolean {
    return (this.displayUnit?.vet ?? 0) >= this.vetNeeded(index);
  }

  /** "Ability1 - 3 (2)" while cooling down, "Passive1" for the passive row. */
  abilityLabel(index: number, cooldown: number): string {
    const name = this.abilityEffects[index]?.name ?? `Ability${index + 1}`;
    // A passive costs nothing and never cools down, so it is just its name.
    if (this.isPassive(index)) return name;
    const cost = this.abilityCosts[index] ?? 0;
    return `${name} (${cooldown ?? 0}) - ${cost}`;
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
    if (e.points) {
      parts.push(`${e.points > 0 ? '+' : ''}${e.points} point${Math.abs(e.points) === 1 ? '' : 's'}`);
    }
    const effect = parts.join(', ') || 'no effect yet';
    const need = this.vetNeeded(index);
    const star = '\u2605'.repeat(need);

    if (this.isPassive(index)) {
      return need ? `${effect} while the unit holds ${star}` : `${effect}, always on`;
    }
    // A universal ability lands on the side, not on a unit: telling the
    // player to click one is an instruction they cannot follow.
    if (e.target === 'universal') {
      return `${effect} - used from here, it needs no target`;
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
      this.isPicked('mine', focus.index) &&
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
    const spend = this.spendOf(unit.uid, 'mine', 'unit', focus.index, unit.key);
    this.chargeFor('mine', focus.index, cost);
    focus.cooldowns[focus.index] = 3;
    this.buffs = {
      ...this.buffs,
      [unit.uid]: this.stack(unit.uid, effect, this.casterColor('mine')),
    };
    this.abilityUsed = { ...this.abilityUsed, [unit.uid]: true };
    // A unit's own ability shines on the unit and nowhere else.
    this.playSteps([{ kind: 'ability', from: unit.key, to: unit.key }]);
    this.markUsed('mine', focus.index);
    // A heal moves HP rather than a stat, and HP lives somewhere different
    // for a unit in a panel - see hpChange.
    if (effect.heal) this.stageHeal(unit, effect.heal, spend);
    else this.stageSpend(spend);
    this.addSystemMessage(`${effect.name} applied to ${unit.name}.`);
    this.persistLocalUiState();
    this.unitAbilityFocus = null;
    this.cdr.markForCheck();
  }

  unitAbilityIsPassive(): boolean {
    return !!this.unitAbilityFocus && this.isPassive(this.unitAbilityFocus.index);
  }

  selectAbility(side: 'mine' | 'opponent', index: number, cooldowns: number[]): void {
    // Every ability button on both panels arrives here, so the swap is read
    // in one place: while the + is armed a click gives that one up rather
    // than opening it, and a click on anything else puts the + away.
    if (this.canReset(side, index)) { this.resetAbility(side, index); return; }
    this.swapArmed = null;
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
    const f = this.abilityFocus;
    if (!f) return '';
    const hint = this.abilityHint(f.index);
    // A pool ability is never taken alone, so the panel says what comes with
    // it - before it is picked, when that is still a choice.
    const partner = this.partnerAlsoPicked;
    return partner ? `${hint} Also picks ${partner}.` : hint;
  }

  /**
   * The name of the ability the focused one would bring with it, or '' when
   * there is nothing to say - a path ability, or a pair already carried.
   */
  get partnerAlsoPicked(): string {
    const f = this.abilityFocus;
    if (!f || !this.isPoolAbility(f.index) || this.isPicked(f.side, f.index)) return '';
    return this.abilityEffects[this.partnerOf(f.index)]?.name ?? '';
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

  /**
   * The line under a focused ability. Always says something, and says a
   * different thing depending on what you opened: why it cannot be used, or
   * what to do with it now that it can. A line that comes and goes moves
   * everything under it, which is the other reason it is never empty.
   */
  get focusedAbilityNote(): string {
    const f = this.abilityFocus;
    if (!f) return '';
    if (this.focusedAbilityIsPassive) {
      return 'Always on at ★.';
    }
    const blocked = this.focusedAbilityBlocker;
    if (blocked) return blocked;
    switch (this.abilityTargetMode(f.index)) {
      case 'universal': return 'Ready - press Use.';
      case 'enemy': return 'Ready - click an enemy to hit.';
      default: return 'Ready - click one of yours.';
    }
  }

  /**
   * The one line at the bottom of an ability panel. Always there, whatever the
   * panel is showing - a line that comes and goes moves what is above it, and
   * a panel with nothing open still owes the player a word about why.
   */
  abilityNote(side: 'mine' | 'opponent'): string {
    if (this.swapArmed === side) return 'Click one of the four you carry to give it up.';
    if (this.pathFocus?.side === side) return this.pathNote(side, this.pathFocus.index);
    if (this.abilityFocus?.side === side) return this.focusedAbilityNote;
    if (!this.gameStarted) return 'The game has not started yet.';
    return this.canChooseAbilities(side)
      ? 'Click an ability to read it.'
      : this.abilityBlockedNote;
  }

  /**
   * The one thing a panel offers right now, in the row beneath it: taking an
   * ability or a path up, or using one that needs no target. Blank when there
   * is nothing - the row is drawn either way, so opening something never
   * changes how tall the panel is.
   */
  actionLabel(side: 'mine' | 'opponent'): string {
    if (this.pathFocusFor(side)) return 'Pick';
    if (this.abilityFocus?.side !== side) return '';
    if (this.focusedAbilityCanBePicked) return 'Pick';
    return this.focusedAbilityShowsUse ? 'Use' : '';
  }

  actionEnabled(side: 'mine' | 'opponent'): boolean {
    const path = this.pathFocusFor(side);
    if (path) return this.canUnlockPath(side, path.index);
    const f = this.abilityFocus;
    if (f?.side !== side) return false;
    if (this.focusedAbilityCanBePicked) return this.canPick(side, f.index);
    return this.focusedAbilityShowsUse && this.focusedAbilityCanActivate();
  }

  takeAction(side: 'mine' | 'opponent'): void {
    const path = this.pathFocusFor(side);
    if (path) { this.unlockPath(side, path.index); return; }
    const f = this.abilityFocus;
    if (f?.side !== side) return;
    if (this.focusedAbilityCanBePicked) this.pickAbility(side, f.index);
    else if (this.focusedAbilityShowsUse) this.activateFocusedAbility();
  }

  /** Something is open in this panel to back out of. */
  canGoBack(side: 'mine' | 'opponent'): boolean {
    return this.swapArmed === side
      || !!this.pathFocusFor(side) || this.abilityFocus?.side === side;
  }

  goBack(side: 'mine' | 'opponent'): void {
    // Closing the path screen takes the + off the panel with it, so the swap
    // goes too rather than staying armed with no button to show for it.
    this.swapArmed = null;
    if (this.abilityFocus?.side === side) this.clearAbilityFocus();
    else this.clearPathFocus();
  }

  /** The same line for the unit's own ability, which needs no target. */
  get unitAbilityNote(): string {
    const focus = this.unitAbilityFocus;
    if (!focus) return '';
    if (this.unitAbilityIsPassive()) {
      return 'Always on at ★.';
    }
    if (this.unitAbilityCanActivate()) return 'Ready - press Use.';
    const unit = this.displayUnit;
    if (!unit) return 'Unavailable: no unit selected.';
    if (!this.isPicked('mine', focus.index)) return 'Not carried - pick it first.';
    if (unit.vet < this.vetNeeded(focus.index)) {
      return `Unavailable: needs ${'\u2605'.repeat(this.vetNeeded(focus.index))}.`;
    }
    const cooldown = focus.cooldowns[focus.index] ?? 0;
    if (cooldown > 0) {
      return `On cooldown: ${cooldown} more turn${cooldown > 1 ? 's' : ''}.`;
    }
    if (!this.canUseAbilities('mine')) return this.abilityBlockedNote;
    const cost = this.abilityCosts[focus.index] ?? 0;
    return `Unavailable: costs ${cost} ${this.purseName(focus.index, cost)}, `
      + `you have ${this.purseFor('mine', focus.index)}.`;
  }

  /** Why the focused ability cannot be used, for the detail view to say. */
  get focusedAbilityBlocker(): string {
    const f = this.abilityFocus;
    if (!f || this.focusedAbilityCanActivate()) return '';
    if (this.isUltimate(f.index) && this.ultimateUsed(f.side)) return 'Unavailable: already spent.';
    const path = this.pathChoice(f.side);
    const fromPath = path && (f.index === path.skill || f.index === path.ultimate);
    if (!fromPath) {
      // It may belong to a path nobody has taken - readable from the screen
      // that shows what that path grants, but not yours until the path is.
      const owner = this.pathOwning(f.index);
      if (owner) return `Comes with the ${owner.name} path.`;
      if (!this.isPicked(f.side, f.index)) {
        // Whose turn it is comes first: otherwise a full-slots message stands
        // in for every reason a pick is refused.
        if (!this.canChooseAbilities(f.side)) return 'Unavailable: not your turn.';
        return this.loadout(f.side).length + 2 <= this.abilitySlots
          ? 'Not carried - pick it first.'
          : 'All four slots are taken.';
      }
    }
    const cooldown = f.cooldowns[f.index] ?? 0;
    if (cooldown > 0) return `On cooldown: ${cooldown} more turn${cooldown > 1 ? 's' : ''}.`;
    if (!this.canUseAbilities(f.side)) return 'Unavailable: not your turn.';
    const cost = this.abilityCosts[f.index] ?? 0;
    return `Unavailable: costs ${cost} ${this.purseName(f.index, cost)}, `
      + `you have ${this.purseFor(f.side, f.index)}.`;
  }

  private abilityCanActivate(side: 'mine' | 'opponent', index: number, cooldown: number): boolean {
    if (this.isPassive(index) || (this.isUltimate(index) && this.ultimateUsed(side))) return false;
    // A path's own skill and ultimate come with the path; everything else on
    // the panel is pool, and only the four a side carries can be used.
    const path = this.pathChoice(side);
    if (path && (index === path.skill || index === path.ultimate)) return this.canAfford(side, index, cooldown);
    if (this.isUltimate(index) || this.abilityPool.indexOf(index) < 0) return false;
    if (!this.isPicked(side, index)) return false;
    return this.canAfford(side, index, cooldown);
  }

  /**
   * Remember what a side just cast, so the other player can see it on their
   * own turn. beginTurnFor clears it when the caster comes round again.
   */
  /**
   * Note a slot this side took up, for the other player's next turn. A path is
   * named by its passive, and that is the one slot that lights - the skill and
   * the ultimate arrive with it and speak for themselves.
   */
  private markPicked(side: 'mine' | 'opponent', index: number): void {
    if (this.abilityPickGlow[side].includes(index)) return;
    this.abilityPickGlow = {
      ...this.abilityPickGlow,
      [side]: [...this.abilityPickGlow[side], index],
    };
  }

  /**
   * Slots the commit replay has not reached yet - taken up or spent. Purely a
   * curtain over the two glows so the recap can draw them one at a time; the
   * glows themselves never come down, and this is emptied when the replay
   * ends and when the turn does, so an interrupted one cannot leave a slot
   * plain for the turn it is meant to be read on.
   */
  private glowReveal: Array<{
    side: 'mine' | 'opponent'; index: number; kind: 'pick' | 'used';
  }> = [];
  // Deliberately NOT cleared in beginTurnFor. Committing a turn hands the
  // board over and the recap plays afterwards, so in a solo game the reply
  // that starts the next turn arrives - on a microtask - before the first
  // beat, which is scheduled on a timer. Clearing it there tore the curtain
  // down before anything had been drawn behind it, and every slot came up
  // lit at once. onPlaybackDone lifts what is left; game_started and
  // game_over clear it for the case where the board goes away mid-recap.

  private hidden(side: 'mine' | 'opponent', index: number, kind: 'pick' | 'used'): boolean {
    return this.glowReveal.some(g => g.side === side && g.index === index && g.kind === kind);
  }

  /** True while this ability is one of those that side took up last turn. */
  isRecentPick(side: 'mine' | 'opponent', index: number): boolean {
    return this.abilityPickGlow[side].includes(index) && !this.hidden(side, index, 'pick');
  }

  private markUsed(side: 'mine' | 'opponent', index: number): void {
    // Every one of them, not just the last: a turn spent on three abilities
    // shows the other player all three.
    if (this.abilityGlow[side].includes(index)) return;
    this.abilityGlow = { ...this.abilityGlow, [side]: [...this.abilityGlow[side], index] };
  }

  /** True while this ability is one of those that side used last turn. */
  isRecent(side: 'mine' | 'opponent', index: number): boolean {
    return this.abilityGlow[side].includes(index) && !this.hidden(side, index, 'used');
  }

  clearAbilityFocus(): void {
    this.abilityFocus = null;
    this.pendingAbility = null;
    // Leaving an ability leaves the path that was open behind it too: a path
    // read but not taken is not somewhere to come back to, and landing on it
    // again after backing out of one of its abilities reads as a stuck screen.
    this.pathFocus = null;
    this.cdr.markForCheck();
  }

  activateFocusedAbility(): void {
    if (!this.abilityFocus || !this.focusedAbilityIsUniversal || !this.focusedAbilityCanActivate()) return;
    const { side, index, cooldowns } = this.abilityFocus;
    // Noted before anything is spent: a cast that changes no hex still has to
    // be undoable, or its points and its ultimate are gone for good.
    const spend = this.spendOf('', side, side, index);
    const cost = this.abilityCosts[index] ?? 0;
    // Cost and grant are the same currency, whichever one buys this slot.
    this.chargeFor(side, index, cost - (this.abilityEffects[index].points ?? 0));
    cooldowns[index] = 3;
    this.playSteps([{ kind: 'ability', from: '', to: '', index, side }]);
    if (this.isUltimate(index)) {
      if (side === 'mine') this.myUltimateUsed = true;
      else this.opponentUltimateUsed = true;
    }
    // The one cast path that never said so: an ultimate, or any universal
    // ability, was spent without the other player ever seeing it glow.
    this.markUsed(side, index);
    this.playAbilitySound();
    this.addSystemMessage(`${this.abilityEffects[index].name} used.`);
    this.stageSpend(spend);
    this.persistLocalUiState();
    this.clearAbilityFocus();
  }

  /**
   * Whether the focused ability is one this side actually carries - one of
   * the four picked from the pool, or the skill or ultimate its path granted.
   * Nothing else can be used, so nothing else offers a Use button.
   */
  get focusedAbilityIsCarried(): boolean {
    const f = this.abilityFocus;
    if (!f) return false;
    const path = this.pathChoice(f.side);
    if (path && (f.index === path.skill || f.index === path.ultimate)) return true;
    return this.isPicked(f.side, f.index);
  }

  /** True while this slot is waiting for the player to pick a target. */
  isArmed(side: 'mine' | 'opponent', index: number): boolean {
    return this.pendingAbility?.side === side && this.pendingAbility?.index === index;
  }

  /** Affordable, off cooldown, and this side's turn to act. */
  canAfford(side: 'mine' | 'opponent', index: number, cooldown: number): boolean {
    if (cooldown > 0 || !this.canUseAbilities(side) || (this.isUltimate(index) && this.ultimateUsed(side))) return false;
    return this.purseFor(side, index) >= (this.abilityCosts[index] ?? 0);
  }

  /**
   * Abilities are a default-mode feature. A custom board can carry units the
   * pool was never written for, so rather than offer boosts that mean nothing
   * against them, the three panels say so and stay out of the way.
   */
  get abilitiesComingSoon(): boolean {
    return this.gameMode === 'custom';
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
      // Noted before a thing is spent: taken afterwards it recorded the
      // cooldown this cast had just set, so Undo put the ability back on a
      // three-turn cooldown it had never been on.
      // Keyed by the unit, so the boost follows it through a staged step, an
      // Undo and the server's own confirmation of the move. A fresh object,
      // so the board sees the change and redraws its reach.
      const spend = this.spendOf(unit.uid, armed.side, armed.side, armed.index, unit.key);
      this.chargeFor(armed.side, armed.index, cost);
      armed.cooldowns[armed.index] = 3;
      this.playSteps([{
        kind: 'ability', from: unit.key, to: unit.key,
        index: armed.index, side: armed.side,
      }]);
      this.buffs = {
        ...this.buffs,
        [unit.uid]: this.stack(unit.uid, e, this.casterColor(armed.side)),
      };
      this.abilityUsed = { ...this.abilityUsed, [unit.uid]: true };
      this.markUsed(armed.side, armed.index);
      // A heal is HP, not a stat, so it goes wherever this unit keeps its HP -
      // the staged board, or the panel overlay for a unit standing in one.
      if (e.heal) this.stageHeal(unit, e.heal, spend);
      else this.stageSpend(spend);
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
      effects: [
        ...(held?.effects ?? []),
        { name: effect.name, mov: effect.mov, atk: effect.atk, def: effect.def, turns: 1 },
      ],
    };
  }

  /**
   * Whether a boost changes the game or is only drawn on the panel.
   *
   * Abilities live on the client, so the only engine that honours them is the
   * one in this browser. A server game is decided by the server, which ignores
   * every bonus a message carries: offering the extra reach there stages a
   * walk it rejects as illegal, and the extra damage promises a trade it then
   * contradicts. So the numbers still show on the unit, and nothing else.
   * ponytail: one predicate, to lift the day abilities live in the engine.
   */
  get buffsBind(): boolean {
    return this.isSinglePlayer;
  }

  /**
   * Whether stepping out of the reserve is offered. Same shape as the boost
   * gate above and for the same reason: the panels are the client's own, so
   * the only engine that can take a unit out of one is this browser's. A
   * server game would reject the move outright - it has no panel to look the
   * unit up in - so the gap is drawn there and does not open.
   * ponytail: one predicate, to lift the day reserves live in the engine.
   */
  get entryBind(): boolean {
    return this.isSinglePlayer;
  }

  /** The boosts the board may act on - none of them in a server game. */
  get boardBuffs(): Record<string, UnitBuff> {
    return this.buffsBind ? this.buffs : {};
  }

  /** A one-turn boost on whatever unit stands on `key`, staged board first. */
  private bonusFor(key: string, stat: 'mov' | 'atk' | 'def'): number {
    if (!this.buffsBind) return 0;
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    const uid = board?.[key]?.uid;
    return (uid ? this.buffs[uid]?.[stat] : undefined) ?? 0;
  }

  /** Extra steps lent to whatever unit stands on `key`. */
  private moveBonusFor(key: string): number {
    return this.bonusFor(key, 'mov');
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
  // The panel draws these from statParts, one span per half so only the
  // modified number waves. These are the same numbers as one string, and
  // exist only to be measured - statFontSize sizes the cell by its length.
  // Derived rather than worked out again: two ways to build "20/20, 15/15"
  // is two things to keep in step, and the one that drifts is the width.
  get statAtk(): string { return this.statText('atk'); }
  get statDef(): string { return this.statText('def'); }
  get statMov(): string { return this.statText('mov'); }

  private statText(stat: 'atk' | 'def' | 'mov'): string {
    const parts = this.statParts(stat);
    // Each ring is shown as current/original, e.g. "20/20, 15/15".
    return parts.length ? parts.map(p => `${p.now}/${p.base}`).join(', ') : '\u2014';
  }

  /**
   * A stat split into the halves it is drawn as: what the unit has now, and
   * what it started with. Only the first waves - the base is what the boost
   * is being read against, and a number that moves is no use as a reference.
   * Attack comes as one pair per ring.
   */
  statParts(stat: 'atk' | 'def' | 'mov'): Array<{ now: string; base: string }> {
    const u = this.displayUnit;
    if (!u) return [];
    const add = this.displayBuff?.[stat] ?? 0;
    if (stat === 'atk') {
      return u.atk.split(',').map(n => {
        const base = Number(n);
        return { now: String(base + add), base: String(base) };
      });
    }
    const base = (stat === 'def' ? u.def : u.mv) ?? 0;
    const spent = stat === 'mov' ? this.moveUsed : 0;
    return [{ now: String(base + add - spent), base: String(base) }];
  }

/** Credit a side: a point for starting a turn, a point per unit killed. */
  /**
   * What a side's dead have cost it, by the config's own unit values - a pawn
   * is 5 there, so losing one is 5 against you.
   *
   * Read off the move history rather than tallied as the moves land. The
   * server ships the whole history with every state update, so both players
   * and any reconnect derive the same number from the same record; a running
   * count only ever matches for a client that watched every move of the game
   * live, which is exactly the client that does not need one.
   */
  /**
   * How many of your units are still standing on the battlefield - 24 on a
   * fresh board. Counted off the staged position, the one being drawn, so a
   * unit walked home reads as gone the moment it goes rather than after the
   * turn is committed.
   *
   * The battlefield alone: the panels are the client's own and never reach
   * `boardState`, so a reserve waiting its turn is not part of this.
   */
  get liveUnits(): number {
    return this.headCount(piece => piece.color === this.myFieldColor);
  }

  /** The same head count for the other side, to read yours against. */
  get opponentUnits(): number {
    return this.headCount(piece => piece.color !== this.myFieldColor);
  }

  private get myFieldColor(): string {
    return this.gameState.myColor(this.username) || 'white';
  }

  /**
   * Units standing on the battlefield, off the position being drawn.
   *
   * `offBoard` rather than a bare colour count: a unit walking home is staged
   * under its *base's* panel key, so it sat in `stagedBoard` looking alive and
   * the count only dropped when the engine's `move_made` landed - the opposite
   * of reading as gone the moment it goes.
   */
  private headCount(match: (piece: any) => boolean): number {
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState ?? {};
    return Object.entries(board)
      .filter(([key, piece]: [string, any]) => !!piece && match(piece) && !this.offBoard(key))
      .length;
  }

  private deathsOf(color: 'white' | 'black', phase?: number): number {
    const snapshot = this.gameState.snapshot;
    const units = snapshot.config?.units ?? {};
    const value = (unitId: string | null | undefined) =>
      (unitId ? units[unitId]?.value : 0) ?? 0;
    let total = 0;
    for (const move of snapshot.moveHistory ?? []) {
      // Each phase is scored on its own, so a loss counts against the phase
      // it happened in and no other - otherwise summing the three would
      // charge the early deaths again every time.
      if (phase !== undefined && phaseIndexAt(move.turn) !== phase) continue;
      // The defender belongs to whoever was not moving; a counter-attack
      // kills the mover's own unit.
      if (move.defender_eliminated && move.color !== color) total += value(move.captured);
      if (move.attacker_eliminated && move.color === color) total += value(move.unit_id);
    }
    return total;
  }

  /**
   * Both halves of the score cost a pass over data the template asks for on
   * every change-detection run - including one per mouse move across the
   * board. The board and the history are each replaced wholesale rather than
   * edited, so their identities are all the cache key needed.
   */
  private standingsCache: {
    board: unknown; history: unknown; turn: number; bank: unknown;
    standings: { mine: Standing; opponent: Standing };
  } | null = null;

  /**
   * What each phase finished on, once it has. Kept rather than derived: a
   * phase's cap is the board as it stood when the phase ended, and that board
   * is gone by the time anything asks. Persisted with the rest of the local
   * UI state, so a reload does not forget the match so far.
   * ponytail ceiling: a client that is not running when a phase ends banks
   * nothing for it - the board it would read has already moved on. Deriving
   * it needs a board snapshot per phase, which is the server's to keep.
   */
  phaseBank: Record<number, { white: number; black: number }> = {};

  /** What a side is holding right now, however far through the phase it is. */
  private capOf(color: 'white' | 'black'): number {
    const snapshot = this.gameState.snapshot;
    // The staged board, the same one being drawn: a unit walked out of a zone
    // has left it as far as the eye is concerned, so the score says so before
    // the turn is committed rather than after.
    const board = this.stagedBoard ?? snapshot.boardState ?? {};
    return captureScore(
      captureClaims(board, snapshot.config?.board?.radius ?? 11), color);
  }

  /**
   * Bank the score of every scoring phase that has ended without one.
   *
   * Read on the first turn of the next phase, which is the one moment the
   * board still shows the position the old phase finished on: a turn's move
   * is applied before its number is handed on.
   */
  private bankEndedPhases(): void {
    const now = phaseIndexAt(this.gameState.snapshot.turnNumber);
    let banked = false;
    for (const phase of SCORING_PHASES) {
      if (phase >= now || this.phaseBank[phase]) continue;
      this.phaseBank[phase] = {
        white: this.capOf('white') - this.deathsOf('white', phase),
        black: this.capOf('black') - this.deathsOf('black', phase),
      };
      banked = true;
    }
    if (banked) {
      this.standingsCache = null;
      this.persistLocalUiState();
    }
  }

  /**
   * What overtime has bled off a side: a point for each turn it ends, charged
   * **white first** and alternating from there.
   *
   * Deliberately not whose turn it was. On the shipped schedule overtime
   * opens on turn 34, which is black's - white plays the odd numbers - so
   * following the board would charge black first. The owner's rule is that
   * white is charged first, which is the same way round as every other tie
   * here: white moves first, so white pays for it.
   *
   * Counted rather than tallied, so it reads the same after a reload.
   */
  private overtimeTicks(color: 'white' | 'black'): number {
    const played = this.gameState.snapshot.turnNumber - OVERTIME_FIRST_PLY;
    if (played <= 0) return 0;
    return color === 'white' ? Math.ceil(played / 2) : Math.floor(played / 2);
  }

  /**
   * What the match comes to once the third phase is in: white's score against
   * black's, and what that settles.
   *
   * `null` while any scoring phase is still to be banked - nothing is decided
   * until all three are. Otherwise a side takes it outright by finishing more
   * than the other's margin clear; anything closer goes to overtime, and an
   * overtime that reaches its last turn goes to black.
   *
   * ponytail: the verdict is read, not enforced. The engine ends a game on
   * elimination, resignation or the clock and knows nothing of capture zones,
   * so this says who is winning rather than stopping the match.
   */
  get matchVerdict(): 'white' | 'black' | 'overtime' | null {
    if (SCORING_PHASES.some(phase => !this.phaseBank[phase])) return null;
    const standing = this.standings();
    const mineColor = this.gameState.myColor(this.username) || 'white';
    const white = mineColor === 'black' ? standing.opponent : standing.mine;
    const black = mineColor === 'black' ? standing.mine : standing.opponent;
    const lead = white.match - black.match;
    if (lead > OVERTIME_MARGIN.black) return 'white';
    if (-lead > OVERTIME_MARGIN.white) return 'black';
    // At the *end* of the last turn, so turn 50 itself is still played out.
    return turnOf(this.gameState.snapshot.turnNumber) > OVERTIME_LAST_TURN
      ? 'black' : 'overtime';
  }

  /** The verdict in the header's own terms, or '' while nothing is settled. */
  get verdictLabel(): string {
    const verdict = this.matchVerdict;
    if (!verdict) return '';
    if (verdict === 'overtime') return 'OVERTIME';
    const mine = this.gameState.myColor(this.username) || 'white';
    return verdict === mine ? 'YOU WIN' : 'OPPONENT WINS';
  }

  /**
   * What the header says after whose turn it is: where the match has got to.
   * The stage of the schedule by name - INITIALIZATION, PHASE 1, PHASE 1
   * HALFTIME, and so on to OVERTIME - giving way to the result once there is
   * one to give way to.
   *
   * Overtime is both a stage and a verdict, and reads the same either way,
   * so the stage covers it and nothing is lost. The header used to name
   * overtime and nothing else, which left the other seven stages unnamed.
   */
  get stageLabel(): string {
    const verdict = this.matchVerdict;
    if (verdict && verdict !== 'overtime') return this.verdictLabel;
    return stageAt(this.gameState.snapshot.turnNumber).toUpperCase();
  }

  /**
   * Both sides at once: this phase's live score, the phases already banked,
   * and what the two add up to. Computed together because who is ahead is a
   * comparison, and the template asks for all of it on every pass.
   */
  private standings(): { mine: Standing; opponent: Standing } {
    const snapshot = this.gameState.snapshot;
    const board = this.stagedBoard ?? snapshot.boardState ?? {};
    const history = snapshot.moveHistory;
    const turn = snapshot.turnNumber;
    const phase = phaseIndexAt(turn);
    const cache = this.standingsCache;
    if (cache && cache.board === board && cache.history === history
        && cache.turn === turn && cache.bank === this.phaseBank) {
      return cache.standings;
    }

    const mineColor = this.gameState.myColor(this.username) || 'white';
    // Nothing is scored in the opening: no unit can be killed and no zone is
    // capped, so the header reads a flat 0 - 0 = 0 rather than counting hexes
    // towards a phase that banks nothing.
    const opening = isInitialization(snapshot.turnNumber);
    const build = (color: 'white' | 'black'): Standing => {
      const cap = opening ? 0 : this.capOf(color);
      const death = this.deathsOf(color, phase);
      const total = cap - death;
      const banked = SCORING_PHASES
        .filter(index => this.phaseBank[index])
        .map(index => this.phaseBank[index][color]);
      // The three phases are what the match is summed from. The opening banks
      // nothing, and overtime is not a phase but a decider: it takes points
      // away rather than adding a score of its own.
      const running = SCORING_PHASES.includes(phase) ? total : 0;
      const match = banked.reduce((sum, value) => sum + value, 0)
        + running - this.overtimeTicks(color);
      return { cap, death, total, banked, match, leading: false };
    };
    const white = build('white');
    const black = build('black');
    // Only a lead glows; level pegging lights neither.
    if (white.match > black.match) white.leading = true;
    else if (black.match > white.match) black.leading = true;

    const standings = mineColor === 'black'
      ? { mine: black, opponent: white }
      : { mine: white, opponent: black };
    this.standingsCache = { board, history, turn, bank: this.phaseBank, standings };
    return standings;
  }

  /**
   * A side's standing: the capture hexes it holds right now against what its
   * losses have cost it. Cap is read off the board every time rather than
   * banked - it is what you are holding, and it drops the moment you walk
   * away - while deaths only ever add up.
   *
   * One record rather than two loose numbers because the match is meant to
   * run in phases: each one ends by taking a snapshot of exactly this, and
   * the snapshots are summed to decide the winner. This is the shape a phase
   * would keep, so adding them is a list and a bank step, not a rewrite.
   * ponytail: one live phase - nothing is banked and nothing is summed yet.
   */
  phaseScore(side: 'mine' | 'opponent'): Standing {
    return this.standings()[side];
  }

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
    // The turn just handed over is the last of its phase often enough that
    // this is where a phase ends - and the board has not moved on yet.
    this.bankEndedPhases();
    // A boost lasts one turn: it runs out when its caster comes round again.
    const kept = Object.fromEntries(
      Object.entries(this.buffs).filter(([, b]) => b.caster !== color),
    );
    if (Object.keys(kept).length !== Object.keys(this.buffs).length) this.buffs = kept;
    // Spending an ability marks the unit for the turn it was spent in.
    this.abilityUsed = {};
    this.pickedThisTurn = [];
    this.swapArmed = null;
    this.awardPoints(color, 1);
    const mine = this.gameState.myColor(this.username);
    const isMine = mine ? color === mine : color === 'white';
    // The glow is for the other player's turn: it lifts when whoever cast it
    // is up again.
    const side = isMine ? 'mine' : 'opponent';
    if (this.abilityGlow[side].length) this.abilityGlow = { ...this.abilityGlow, [side]: [] };
    if (this.abilityPickGlow[side].length) {
      this.abilityPickGlow = { ...this.abilityPickGlow, [side]: [] };
    }
    const tick = (cds: number[]) => cds.forEach((cd, i) => (cds[i] = Math.max(0, cd - 1)));
    if (isMine) {
      tick(this.myCooldowns);
      tick(this.unitCooldowns);
    } else {
      tick(this.opponentCooldowns);
    }
    this.persistLocalUiState();
  }

  /** True while R / TAB / S / F should act, which is also when the hints show. */
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
    } else if (event.key === 'f' || event.key === 'F') {
      this.flipView = !this.flipView;
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
  // Pool, then each path's passive (free with the path), skill and ultimate.
  // Slot 7 (Rally) is free on purpose - see abilityEffects.
  // ponytail: slot 6 is free like slot 7 beside it - the pair is the owner's
  // testing bench, a heal and a purse, picked together in one go.
  abilityCosts = [3, 5, 1, 4, 3, 2, 0, 0, 0, 4, 8, 0, 5, 8, 0, 3, 8];

  /**
   * What each slot does. Arbitrary numbers - this is the proof of concept
   * that an ability can be clicked, aimed at a unit and change its stats for
   * a turn. Slot 5 is the passive: it is not cast, so its numbers are what
   * the unit carries once it has the rank for it.
   */
  readonly abilityEffects = [
    // Slots 0-7 are the pool a side picks four of; between them they can put
    // a unit into every state the board draws: lifted, dragged, wounded.
    { name: 'Dash', target: 'friendly' as const, mov: 2, atk: 0, def: 0 },
    { name: 'Focus', target: 'friendly' as const, mov: 0, atk: 2, def: 0 },
    { name: 'Bulwark', target: 'friendly' as const, mov: 0, atk: 0, def: 3 },
    { name: 'Sap', target: 'enemy' as const, mov: -2, atk: -2, def: -2, damage: 6 },
    { name: 'Arc Bolt', target: 'enemy' as const, mov: 0, atk: 0, def: 0, damage: 8 },
    { name: 'Mire', target: 'enemy' as const, mov: -3, atk: 0, def: 0 },
    // ponytail: the owner's other testing lever, and Rally's partner in the
    // pool - "heal a static 20 for testing purposes". Flat, free, and the only
    // way to put HP back into a unit by hand.
    { name: 'Mend', target: 'friendly' as const, mov: 0, atk: 0, def: 0, heal: 20 },
    // ponytail: the owner's testing lever - free, and hands out 300 points,
    // so any priced rule (a wrap crossing, a path, an ultimate) can be tried
    // without playing thirty turns to afford it. Put it back to 2 / 1 point
    // when the real numbers land.
    { name: 'Rally', target: 'universal' as const, mov: 0, atk: 0, def: 0, points: 300 },
    // 8-16: three paths of three. A side unlocks one path and gets its
    // passive (global, on every unit it owns), its skill and its ultimate.
    // A passive carries its path's name: the path IS its passive, and the
    // owner asked for them back in step after a spell apart.
    { name: 'Bastion', target: 'friendly' as const, mov: 0, atk: 0, def: 1 },
    { name: 'Anchor', target: 'friendly' as const, mov: 0, atk: 0, def: 4 },
    { name: 'Fortress', target: 'universal' as const, mov: 0, atk: 0, def: 0, points: 4 },

    { name: 'Onslaught', target: 'friendly' as const, mov: 0, atk: 1, def: 0 },
    { name: 'Cleave', target: 'enemy' as const, mov: 0, atk: 0, def: 0, damage: 10 },
    { name: 'Ruin', target: 'universal' as const, mov: 0, atk: 0, def: 0, points: 5 },

    { name: 'Tempo', target: 'friendly' as const, mov: 1, atk: 0, def: 0 },
    { name: 'Surge', target: 'friendly' as const, mov: 3, atk: 0, def: 0 },
    { name: 'Blitz', target: 'universal' as const, mov: 0, atk: 0, def: 0, points: 3 },
  ];

  /**
   * The three ways a side can go, named for the passive each one grants. One
   * per match: unlocking costs CP, and what it buys - a global passive, a
   * skill and an ultimate - is that path's alone.
   */
  readonly abilityPaths = [
    { name: 'Bastion', cost: 6, passive: 8, skill: 9, ultimate: 10 },
    { name: 'Onslaught', cost: 7, passive: 11, skill: 12, ultimate: 13 },
    { name: 'Tempo', cost: 5, passive: 14, skill: 15, ultimate: 16 },
  ];

  /** Which path each side took, or null while the choice is still open. */
  myPath: number | null = null;
  opponentPath: number | null = null;

  /**
   * What a third star is worth, per unit. Placeholder numbers, and shown in
   * the unit panel only.
   * ponytail: display-only - veterancy itself is a client-side placeholder
   * (placeholderVet), and neither engine knows about it, so feeding these
   * into combat would put the two sides' maths out of step. Wire it through
   * hex-rules and the server together, or not at all.
   */
  readonly vetBonus: Record<string, { mov?: number; atk?: number; def?: number }> = {
    king:   { def: 2 },
    queen:  { atk: 2 },
    rook:   { def: 2, atk: 1 },
    bishop: { atk: 2 },
    knight: { mov: 1, atk: 1 },
    pawn:   { atk: 1, def: 1 },
  };

  /**
   * Indices of the pool a side picks from, and how many it may hold. Picked
   * in pairs (see `pairOf`), so four slots is two picks.
   */
  readonly abilityPool = [0, 1, 2, 3, 4, 5, 6, 7];
  readonly abilitySlots = 4;
  /**
   * The four each side is carrying, in the order they were picked. Empty
   * until then: nothing is chosen for you, the picks happen in the game.
   */
  myLoadout: number[] = [];
  opponentLoadout: number[] = [];
  /**
   * The ability each side used last, for the other player to see. It glows on
   * that side's list until the side that cast it comes round again - one turn
   * of the opponent's, which is the turn they need it in.
   */
  abilityGlow: { mine: number[]; opponent: number[] } = { mine: [], opponent: [] };
  /**
   * And what each side *took up* last turn, kept apart from what it spent: a
   * pick and a cast are different news, so they read differently - a pick
   * fills the slot yellow, a cast glows around it.
   */
  abilityPickGlow: { mine: number[]; opponent: number[] } = { mine: [], opponent: [] };

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
  // One slot per ability: the pool of eight, then three paths of three.
  unitCooldowns = new Array(17).fill(0);
  opponentCooldowns = new Array(17).fill(0);
  myCooldowns = new Array(17).fill(0);
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

  /**
   * CP already spent on abilities. What a side *has* is derived from this and
   * the phase (see `cpOf`) rather than tallied, so a phase's award cannot be
   * collected twice by a reload - the same reason the phase bank is read off
   * the record rather than accumulated.
   */
  myCpSpent = 0;
  opponentCpSpent = 0;
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
  onPlayerMove(event: { from: string; to: string; cost: number; refund?: number }): void {
    if (this.hasAttacked) return;
    // Walking home into the base pays the unit's worth back to whoever
    // brought it in - the same number the wrap charged to send one out.
    if (event.refund) {
      this.awardPoints(this.gameState.myColor(this.gameState.snapshot.currentTurn), event.refund);
    }
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    const next: Record<string, any> = { ...board };
    next[event.to] = next[event.from];
    delete next[event.from];
    // Steps accumulate across hops: a unit keeps walking on what is left of
    // its move until it attacks or the turn ends.
    const prev = this.pendingMove;
    this.stagedActions.push({
      at: Date.now(),
      board: next,
      from: prev?.from ?? event.from,
      to: event.to,
      // The board charges the walk it actually plotted, detours included.
      used: (prev?.used ?? 0) + event.cost,
      attack: null,
      ...(event.refund ? { refund: event.refund } : {}),
    });
    // Each step plays as it is staged, and never blocks the next one.
    this.playSteps([{ kind: 'move', from: event.from, to: event.to }]);
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /**
   * An attack stages like a step, so it can be taken back. The damage is
   * previewed with the same sums the server uses (see hex-rules); the
   * authoritative result arrives with move_made once End Turn sends it.
   */
  onPlayerAttack(event: {
    from: string; to: string; attack: string;
    targetUnit?: Record<string, any>; panel?: string; counters?: boolean;
  }): void {
    if (!this.canEndTurn || this.hasAttacked) return;
    const config = this.gameState.snapshot.config;
    const board = { ...(this.stagedBoard ?? this.gameState.snapshot.boardState) };
    // A blow landing in a panel comes with the unit it lands on: no board
    // holds a panel, so it is the only way to name one. Everything below then
    // reads the same either way - the only difference is where the wound is
    // written back, and whether it is answered.
    const intoPanel = !!event.targetUnit;
    const attacker = board[event.to];
    const target = event.targetUnit ?? board[event.attack];
    // What the panel unit has left once the exchange is over.
    let panelUnitHp = (event.targetUnit ?? {})['hp'] as number;
    if (!attacker || !target) return;

    const distance = hexDistanceKeys(event.to, event.attack);
    // An ATK or DEF boost is real damage, not just a number in the panel.
    const dealt = strikeDamage(
      attacker.unit_id, target.unit_id, distance, config,
      this.bonusFor(event.to, 'atk'), this.bonusFor(event.attack, 'def'));
    const hurt = { ...target, hp: target.hp - dealt };

    // At most one of the two dies: a defender that falls never counters.
    let killed: string | undefined;
    let killedUnit: { unit_id: string; color: 'white' | 'black' } | undefined;
    // Whether it answered at all, which is three separate refusals: it died,
    // it is in a base, or we struck it from outside its own reach. Recorded
    // rather than re-guessed, because every replay of this turn needs it.
    let answered = false;

    if (hurt.hp <= 0) {
      // A panel unit that falls is simply not dealt again - 0 is what says
      // so - and nothing on the board changes where it stood.
      if (intoPanel) panelUnitHp = 0;
      else delete board[event.attack];
      killed = event.attack;
      killedUnit = { unit_id: target.unit_id, color: target.color };
    } else {
      if (intoPanel) panelUnitHp = hurt.hp;
      else board[event.attack] = hurt;
      // A panel answers only if it is a reserve: the base is struck and says
      // nothing. The preview has to agree with the engine on that, or a base
      // blow shows a counter it never takes.
      const theirRange = config?.units?.[target.unit_id]?.attackRange ?? 1;
      if ((!intoPanel || event.counters) && distance <= theirRange) {
        answered = true;
        const counter = strikeDamage(
          target.unit_id, attacker.unit_id, distance, config,
          this.bonusFor(event.attack, 'atk'), this.bonusFor(event.to, 'def'));
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
      at: Date.now(),
      board,
      from: prev?.from ?? event.from,
      to: event.to,
      used: prev?.used ?? 0,
      attack: event.attack,
      killed,
      killedUnit,
      countered: answered,
      // Set only for a swing out of a panel - what tells the commit to send
      // it as its own message rather than folding it into the turn's move.
      ...(intoPanel
        ? {
            panelUnit: target, panelUnitHp, intoPanel: true,
            panelName: event.panel, counters: !!event.counters,
          }
        : {}),
    });
    // The blow, and the answer only if there was one. Played unconditionally
    // before, so a base absorbed a blow and appeared to hit back for nothing,
    // and so did a unit struck from three hexes away by an archer it could
    // not have reached.
    this.playSteps(answered
      ? [
          { kind: 'attack', from: event.to, to: event.attack },
          { kind: 'counter', from: event.attack, to: event.to },
        ]
      : [{ kind: 'attack', from: event.to, to: event.attack }]);
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
    if (this.recapRunning) return false;
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
    // Each turn starts owing nothing; what its own replay costs is added back
    // as that replay ends.
    this.playbackOwed = 0;
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
    const elapsed = (Date.now() - new Date(state.turnStartedAt).getTime() - this.playbackOwed) / 1000;
    return Math.max(0, Math.ceil(limit - elapsed));
  }

  private clearTurnClock(): void {
    if (this.turnClock) {
      clearInterval(this.turnClock);
      this.turnClock = null;
    }
  }

  private updateTurnClock(): void {
    // A turn being replayed is not a turn being spent.
    if (this.playbackRunning) return;
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

  /**
   * The turn just committed, one beat at a time: each step walked, each blow
   * struck and answered, each cast lit. Staging stays instant - this is the
   * replay, and it runs after the move has already gone to the server.
   */
  playback: AnimStep[] = [];
  /** Something to take back: a staged board action, or a panel walk. */
  get canUndo(): boolean {
    return !!this.pendingMove || !!this.boardRef?.lastPanelMove;
  }

  /** The board, for the walks it keeps its own stack of. */
  @ViewChild(GameBoardComponent) private boardRef?: GameBoardComponent;

  /** True while the board is playing; the clock waits for it. */
  playbackRunning = false;
  /**
   * True while a *committed* turn is playing itself back. Staging animations
   * never lock anything - rapid input is meant to skip them - but the recap
   * is the turn being shown, and acting over it means acting on a board that
   * is not the one on screen.
   */
  recapRunning = false;

  /**
   * Whose turn the indicator names. While a committed turn plays back it
   * holds on whoever just moved rather than following the board, which has
   * already handed over - the animation belongs to the turn being watched,
   * not the one about to start.
   */
  get indicatorMine(): boolean {
    return this.recapRunning ? !this.isYourTurn : this.isYourTurn;
  }
  private playbackStarted = 0;
  /** Milliseconds of animation to forgive the current turn's clock. */
  private playbackOwed = 0;

  /**
   * Hand the board something to play. A new list interrupts whatever is still
   * running, which is what makes rapid input feel instant: the board is
   * already showing the position, so the beats nobody waited for are dropped.
   */
  /**
   * Note a slot just taken up and flash it. Kept for the recap as well: what
   * a turn did includes what it took up, not only what it spent.
   */
  private flashPick(side: 'mine' | 'opponent', index: number): void {
    // Yellow the moment it is taken, not when its beat plays: the beat is the
    // flash, and hanging the colour off it meant a replay that was interrupted
    // - or a tab the browser throttled - left the slot plain for the whole of
    // the other player's turn, which is exactly when it is meant to be read.
    this.markPicked(side, index);
    this.pickedThisTurn = [...this.pickedThisTurn, { side, index }];
    this.playPickSound();
    this.playSteps([{ kind: 'pick', from: '', to: '', index, side }]);
  }

  /** Fill in which ability beats were cast at an enemy. */
  private markHostile(steps: AnimStep[]): AnimStep[] {
    return steps.map(step => step.kind === 'ability' && step.index != null
      ? { ...step, hostile: this.abilityTargetMode(step.index) === 'enemy' }
      : step);
  }

  private playSteps(steps: AnimStep[]): void {
    if (!steps.length) return;
    this.playback = steps;
    this.playbackRunning = true;
    this.playbackStarted = Date.now();
  }

  /** The slot lighting up with the unit it is landing on, or null. */
  castingIndex: number | null = null;
  /** Whose panel that slot is in - both sides draw the same indices, so
   *  without this your cast popped the same button on the opponent's list. */
  castingSide: 'mine' | 'opponent' | null = null;
  /** Whether that beat is a slot being taken up rather than used. */
  castingPick = false;
  /**
   * What this side took up this turn, in order. Picks are not staged - there
   * is no taking one back - so they are kept here for the recap to replay,
   * and cleared when the side comes round again.
   */
  private pickedThisTurn: Array<{ side: 'mine' | 'opponent'; index: number }> = [];
  /** That shine belongs to the end-of-turn recap, so it runs short. */
  castingBrief = false;

  /** One sound per beat, as the board reaches it, and the slot behind it. */
  onPlaybackStep(step: AnimStep): void {
    const slotted = step.kind === 'ability' || step.kind === 'pick';
    this.castingIndex = slotted ? step.index ?? null : null;
    this.castingSide = slotted ? step.side ?? null : null;
    this.castingPick = step.kind === 'pick';
    // Each beat draws its own card back in, so a committed turn's picks and
    // casts come up one after another rather than all at once.
    if (slotted && step.side && step.index != null) {
      const kind = step.kind === 'pick' ? 'pick' : 'used';
      this.glowReveal = this.glowReveal.filter(
        g => !(g.side === step.side && g.index === step.index && g.kind === kind));
    }
    this.castingBrief = !!step.brief;
    if (step.kind === 'move') this.playMoveSound();
    else if (step.kind === 'ability') this.playAbilitySound();
    else this.playAttackSound();
    this.cdr.markForCheck();
  }

  /** True while this slot is the one being cast in the replay. */
  isCasting(side: 'mine' | 'opponent', index: number): boolean {
    return !this.castingPick && this.castingSide === side && this.castingIndex === index;
  }

  /** True while this slot is the one being taken up. */
  isPicking(side: 'mine' | 'opponent', index: number): boolean {
    return this.castingPick && this.castingSide === side && this.castingIndex === index;
  }

  onPlaybackDone(): void {
    // Before the guard: whatever else is true, the recap is over. The player
    // has their board back, and nothing stays curtained past a replay - an
    // interrupted one would otherwise leave a slot plain for the whole of
    // the turn it is meant to be read on. Nothing spurious reaches here: the
    // board cancels a run the moment its list is replaced.
    this.recapRunning = false;
    this.glowReveal = [];
    if (!this.playbackRunning) return;
    this.playbackRunning = false;
    this.castingIndex = null;
    this.castingSide = null;
    this.castingPick = false;
    // Watching the replay is not thinking time: the clock is handed back
    // whatever the animation took.
    this.playbackOwed += Date.now() - this.playbackStarted;
    // The list is NOT cleared here. Clearing it means a sequence that finishes
    // just after a longer one replaced it - a commit landing while a pick is
    // still flashing - hands the board an empty list and stops the run that
    // superseded it. Every playSteps builds a fresh array, so there is nothing
    // this needs to clear anyway.
    this.updateTurnClock();
    this.cdr.markForCheck();
  }

  /** Take back the last staged action - a step, the attack, or a cast. */
  undoMove(): void {
    // Two stacks: board actions staged here, panel walks kept by the board.
    // Undo takes back whichever happened last, so it always takes back the
    // thing just done rather than reaching past it.
    const staged = this.stagedActions[this.stagedActions.length - 1];
    const walkedAt = this.boardRef?.lastPanelMove ?? 0;
    if (walkedAt && walkedAt > (staged?.at ?? 0)) {
      const refund = this.boardRef!.undoPanelMove();
      // A crossing it had paid for is paid back with it.
      if (refund) {
        this.awardPoints(this.gameState.myColor(this.gameState.snapshot.currentTurn), refund);
      }
      this.persistLocalUiState();
      this.cdr.markForCheck();
      return;
    }
    const undone = this.stagedActions.pop();
    // A withdrawal paid on the way in; taking it back takes the points too.
    if (undone?.refund) {
      this.awardPoints(this.gameState.myColor(this.gameState.snapshot.currentTurn), -undone.refund);
    }
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
  /**
   * A cast that moved a unit's HP: the spend rides on the same entry as the
   * change, so Undo takes both back together.
   */
  private stageHeal(unit: SelectedUnit, amount: number, spend: AbilitySpend): void {
    const prev = this.stagedActions[this.stagedActions.length - 1];
    const board = this.stagedBoard ?? this.gameState.snapshot.boardState;
    this.stagedActions.push({
      at: Date.now(),
      from: prev?.from ?? '',
      to: prev?.to ?? '',
      used: prev?.used ?? 0,
      attack: null,
      spend,
      ...this.hpChange(unit, amount, board),
    });
  }

  private stageSpend(spend: AbilitySpend): void {
    const prev = this.stagedActions[this.stagedActions.length - 1];
    this.stagedActions.push({
      at: Date.now(),
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
    /** Where it lands. Only the recap reads it, and only to play it there. */
    hex = '',
  ): AbilitySpend {
    return {
      side, row, index, hex,
      cost: this.abilityCosts[index] ?? 0,
      gain: this.abilityEffects[index]?.points ?? 0,
      uid,
      priorCooldown: this.cooldownRow(row)[index] ?? 0,
      priorUltimate: this.ultimateUsed(side),
      priorBuff: this.buffs[uid] ?? null,
      priorUsed: !!this.abilityUsed[uid],
    };
  }

  private cooldownRow(row: 'mine' | 'opponent' | 'unit'): number[] {
    if (row === 'unit') return this.unitCooldowns;
    return row === 'mine' ? this.myCooldowns : this.opponentCooldowns;
  }

  private refund(spend: AbilitySpend): void {
    // A stack restored from disk predates the two fields below.
    const net = spend.cost - (spend.gain ?? 0);
    this.chargeFor(spend.side, spend.index, -net);
    if (spend.side === 'mine') {
      this.myUltimateUsed = spend.priorUltimate ?? this.myUltimateUsed;
    } else {
      this.opponentUltimateUsed = spend.priorUltimate ?? this.opponentUltimateUsed;
    }
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
  /** The turn a commit has already gone out for; a second click is a no-op. */
  private submittedTurn = -1;

  endTurn(): void {
    if (!this.canEndTurn) return;
    // A double-click, or the clock firing into a click, sends a second
    // make_move for the same turn. The server rejects the late one as
    // GAME_OVER, and that error clears a turn already staged behind it.
    if (this.submittedTurn === this.gameState.snapshot.turnNumber) return;
    // Cleared again if the engine rejects what this sends, so a refusal costs
    // the staged turn but not the chance to play another one.
    this.submittedTurn = this.gameState.snapshot.turnNumber;
    // Opponent action overlays describe the immediately preceding opponent
    // turn. Once our turn ends, they no longer belong on the board.
    this.opponentMoveVisuals = [];
    // A new turn interrupts whatever is still playing: a fresh list is its own
    // instruction to the board to drop the rest and start again.
    // The whole turn again, with the walk collapsed into the one line it
    // amounted to, and every cast lit in the order it was made.
    // What was taken up leads the recap; what it was spent on follows.
    const recap = [
      ...this.pickedThisTurn.map(p => ({
        kind: 'pick' as const, from: '', to: '', index: p.index, side: p.side,
      })),
      ...this.markHostile(buildPlayback(this.stagedActions, true)),
    ];
    // Neither glow is ever taken down - each goes up when its slot is taken
    // or spent and stays up until this side plays again, so the other player
    // reads both for their whole turn. What the recap does is draw a curtain
    // over everything this turn touched and lift it one beat at a time, so a
    // turn that picked three and cast two looks like five things, in order.
    this.glowReveal = recap
      .filter(step => step.side && step.index != null)
      .map(step => ({
        side: step.side!,
        index: step.index!,
        kind: (step.kind === 'pick' ? 'pick' : 'used') as 'pick' | 'used',
      }));
    // Only lock if there is something to watch: a turn that did nothing plays
    // nothing, so nothing would ever arrive to unlock it again.
    this.recapRunning = recap.length > 0;
    this.playSteps(recap);
    this.persistLocalUiState();
    this.playEndTurnSound();
    // Ending a turn cancels any ability detail/targeting state, including
    // the yellow/red target indicators on the board.
    this.abilityFocus = null;
    this.pathFocus = null;
    this.pendingAbility = null;
    this.unitAbilityFocus = null;
    this.cdr.markForCheck();
    // Crossings are their own thing: several may come through in a turn, and
    // none of them is the turn's board action, so each goes as its own
    // message before whatever the turn did on the board.
    for (const entry of this.boardRef?.pendingEntries ?? []) {
      this.wsService.sendMessage({ type: 'enter_board', ...entry });
    }
    // And so does an ability that moved a panel unit's HP, for exactly the
    // same reason: no engine holds a panel, so the record is the only place
    // that HP survives a reload. The turn's blow is not one of these - it
    // goes out below as a panel_attack, which resolves as well as records.
    for (const step of this.stagedActions) {
      if (!step.panelUnit || step.attack !== null) continue;
      this.wsService.sendMessage({
        type: 'panel_effect',
        unit: step.panelUnit, hp: step.panelUnitHp, panel: step.panelName,
      });
    }
    const pending = this.pendingMove;
    if (!pending) {
      // Doing nothing is a legal turn.
      this.wsService.sendMessage({ type: 'pass_turn' });
      return;
    }
    const attack = this.stagedActions.find(a => a.attack !== null)?.attack;
    // A swing out of a panel is its own message, for the same reason a
    // crossing is: the attacker is the client's and no engine holds it.
    const swung = this.stagedActions.find(a => a.attack !== null && a.panelUnit);
    if (swung) {
      // `to` as well as `from`: a unit may walk and then swing, and this
      // message is the whole turn - there is no make_move behind it to carry
      // the walk. Without it the engine resolved the blow from where the unit
      // started and left it there, which read as being teleported back.
      this.wsService.sendMessage({
        type: 'panel_attack',
        from: swung.from, to: swung.to, attack: swung.attack, unit: swung.panelUnit,
        // Which panel took the blow. The engine keeps it on the record and
        // nothing else: it is what tells the mending a base from a reserve
        // after a reload, when the board that knew is long gone.
        panel: swung.panelName,
        ...(this.moveBonusFor(swung.to) ? { moveBonus: this.moveBonusFor(swung.to) } : {}),
        // The same bonuses `make_move` carries, for the same reason: the
        // engine re-resolves the blow and would otherwise disagree with the
        // preview the room already drew. `targetDef`/`targetAtk` are the
        // panel unit's, which stands on `attack`.
        bonuses: {
          atk: this.bonusFor(swung.to, 'atk'),
          def: this.bonusFor(swung.to, 'def'),
          targetAtk: swung.attack ? this.bonusFor(swung.attack, 'atk') : 0,
          targetDef: swung.attack ? this.bonusFor(swung.attack, 'def') : 0,
        },
        // Whether the panel answers is the panel's rule, and the client owns
        // panels - the engine has no idea which one a unit is standing in.
        counters: swung.counters !== false,
      });
      this.persistLocalUiState();
      return;
    }
    // Both engines re-check the walk from where it started, so they need to
    // be told about the extra steps or they reject the move outright.
    const moveBonus = this.moveBonusFor(pending.to);
    // ponytail: the local engine honours these; a server game does not, for
    // the same reason it ignores moveBonus - abilities live on the client, so
    // taking the client's word for a stat would be a free upgrade. Move
    // abilities into the engine and both sides can read them off the board.
    const bonuses = {
      atk: this.bonusFor(pending.to, 'atk'),
      def: this.bonusFor(pending.to, 'def'),
      targetAtk: attack ? this.bonusFor(attack, 'atk') : 0,
      targetDef: attack ? this.bonusFor(attack, 'def') : 0,
    };
    const boosted = Object.values(bonuses).some(v => v !== 0);
    this.wsService.sendMessage({
      type: 'make_move',
      from: pending.from,
      to: pending.to,
      ...(attack ? { attack } : {}),
      ...(moveBonus ? { moveBonus } : {}),
      ...(boosted ? { bonuses } : {}),
      // Walking off the board into a base: the panel is the client's, so no
      // engine re-derives the walk - it takes the unit off the board and
      // keeps the record. Only the browser engine answers it, which is why
      // the board only offers it there (`entryBind`).
      ...(this.offBoard(pending.to) ? { withdraw: true } : {}),
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

  /** Taking a slot up: brighter and shorter than using one. */
  private playPickSound(): void {
    this.playTone([700, 1050], 0.07);
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
  /** Why a panel is closed - the opening shuts them all, whoever's turn it is. */
  get abilityBlockedNote(): string {
    return isInitialization(this.gameState.snapshot.turnNumber)
      ? 'Unavailable: no abilities during the initialization.'
      : 'Unavailable: not your turn.';
  }

  /**
   * Whether this side may *choose* right now - take a pair up, take a path,
   * hand a pair back. Allowed through the opening: the opening is when a side
   * sets itself out, so it is exactly when choosing belongs.
   */
  canChooseAbilities(side: 'mine' | 'opponent'): boolean {
    // Ability effects are currently client-side scaffolding. Keep them out of
    // multiplayer until the server has an authoritative ability protocol.
    if (!this.gameStarted || !this.isSinglePlayer || this.recapRunning) return false;
    // A finished match is a position to look at, not one to act in.
    if (this.gameOver) return false;
    const myTurn = this.gameState.snapshot.currentTurn === this.username;
    return side === 'mine' ? myTurn : !myTurn;
  }

  /**
   * Whether this side may *cast* right now. Choosing plus one rule more:
   * nothing is cast in the opening - no pool ability, no path skill or
   * ultimate, no unit ability. Everything that spends one runs through here,
   * so this is the one place it has to be said.
   */
  canUseAbilities(side: 'mine' | 'opponent'): boolean {
    return this.canChooseAbilities(side)
      && !isInitialization(this.gameState.snapshot.turnNumber);
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

    writeStore('local', 'gameRoomMode', this.gameMode);
    writeStore('local', 'gameRoomReveal', JSON.stringify(this.revealEnabled));
    writeStore('local', 'gameRoomOptions', JSON.stringify(this.gameOptions));
    // Set navigation state before navigating - use 'game-room' context to return here
    this.navigationState.setIntentionalNavigation('game-room');

    writeStore('local', 'returnToGameRoom', this.gameId);
    writeStore('local', 'gameRoomToken', this.accessToken);

    this.wsService.sendMessage({
      type: 'player_unready',
      username: this.username,
      gameId: this.gameId,
      silent: true
    });

    writeStore('local', 'gameRoomMessages', JSON.stringify(this.gameRoomMessages));

    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'configuring'
    });

    this.router.navigate(['/setup']);
  }
  
  leaveGameRoom(): void {
    if (this.isSinglePlayer || this.gameId === 'local') {
      removeStore('local', LOCAL_UI_STATE_KEY);
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

  /**
   * Which side the host takes. Random by default, and only the host is asked
   * - in a two-player room the server refuses a start from anyone else, so
   * the one seat anybody chooses is this one.
   */
  seatChoice: 'random' | 'white' | 'black' = 'random';

  readonly seatChoices: Array<{ value: 'random' | 'white' | 'black'; label: string }> = [
    { value: 'random', label: 'Random' },
    { value: 'white', label: 'White' },
    { value: 'black', label: 'Black' },
  ];

  setSeatChoice(choice: 'random' | 'white' | 'black'): void {
    this.seatChoice = choice;
    this.persistLocalUiState();
    this.cdr.markForCheck();
  }

  /** The seat to play, with a random pick settled now. */
  private resolveSeat(): 'white' | 'black' {
    if (this.seatChoice !== 'random') return this.seatChoice;
    return Math.random() < 0.5 ? 'white' : 'black';
  }
  
  /**
   * Only the inviter can start the game. The backend validates readiness and
   * broadcasts 'game_started' with the initial state to all players.
   */
  /** The match is over and the board is a finished position. */
  get gameOver(): boolean {
    return this.gameStarted && !!this.gameState.snapshot.endReason;
  }

  /**
   * The start button never leaves the rail. It reads `Start Game` before a
   * match and `Restart Game` after one, and sits greyed through the match
   * itself so the rail keeps its shape rather than swapping controls in and
   * out under the player.
   */
  get startButtonDisabled(): boolean {
    // No server has a restart protocol, so the browser engine is the only
    // place the button can do anything once a match is over.
    if (this.gameOver) return !this.isSinglePlayer;
    if (this.gameStarted) return true;
    return !this.canStartGame();
  }

  get startButtonHint(): string {
    if (this.gameOver) {
      return this.isSinglePlayer
        ? 'Back to the setup screen, ready to play again.'
        : 'Restarting a two-player game is not built yet.';
    }
    if (this.gameStarted) return 'The match is running.';
    return this.canStartGame() ? '' : 'Waiting for both players to be ready.';
  }

  /**
   * Put a finished room back to waiting: the board goes, the setup controls
   * come back, and the host deals again with Start Game. The host's alone -
   * the same seat that starts a match is the one that ends its aftermath.
   */
  restartGame(): void {
    if (!this.isInviter || !this.gameOver) return;
    this.wsService.sendMessage({ type: 'reset_game', gameId: this.gameId });
  }

  startGame(): void {
    if (!this.isInviter) return;
    this.wsService.sendMessage({
      type: 'start_game',
      gameId: this.gameId,
      // Deliberately not sending turnTimeLimit: a pick already reached the
      // server through change_game_mode, and sending it unconditionally made
      // every start look like a pick - overwriting a custom config's own
      // limit (an "unlimited" game silently ran on 60s).
      // The host's side. Solo settles a random pick here, because the
      // browser engine takes the colour it is given; a two-player room sends
      // the choice itself and lets the server toss for 'random', since the
      // server is what owns the seating either way.
      hostColor: this.isSinglePlayer
        ? (this.soloColor = this.resolveSeat())
        : (this.seatChoice === 'random' ? undefined : this.seatChoice),
    });
    if (this.isSinglePlayer) this.persistLocalUiState();
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