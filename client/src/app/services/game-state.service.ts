import { ruleOf } from './config.service';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { PhaseBank } from './match-score';
import { capUnit } from './unit-stats';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Piece on a hex cell: matches the Python CellData dict. */
export interface PieceData {
  unit_id: string;
  color: 'white' | 'black';
  hp: number;
  max_hp: number;
  /** Identity follows the unit through moves; optional for older saves and fixtures. */
  uid?: string;
  /** Rank derived from phase boundaries; older snapshots may not carry it. */
  vet?: number;
  /** Whether the first-star HP bonus is currently applied; panels disable it. */
  veterancyHpActive?: boolean;
  /** Current panel context; omitted after entering the battlefield. */
  panel?: string;
  /** Solo Cast changes control while retaining the owner for regicide and refunds. */
  owner?: 'white' | 'black';
  controlledUntil?: number;
  controlTurn?: number;
}

/** Appearance and identity at the time a replay action occurred. */
export type PieceIdentity = Pick<PieceData, 'unit_id' | 'color' | 'uid'>;

/** Battlefield cells keyed by axial "q,r"; panels are derived separately. */
export type BoardState = Record<string, PieceData>;

/** Committed action history from either engine. */
export interface MoveRecord {
  from: string;
  to: string;
  unit_id: string;
  color: string;
  turn: number;
  captured: string | null;
  attacked: boolean;
  damage_dealt: number;
  defender_eliminated: boolean;
  moved: boolean;
  defender_hp?: number;
  /** Actual combat beats are independent of damage prevented by protection. */
  countered?: boolean;
  counterActor?: PieceIdentity;
  secondStrike?: boolean;
  attackFrom?: string;
  healedHex?: string;
  healed_amount?: number;
  healed_hp?: number;
  healed_unit?: string;
  /** Only present on a move that attacked - see move_record in consumers.py. */
  attacker_eliminated?: boolean;
  /** Panel entry; the unit record retains its identity and HP. */
  entered?: boolean;
  /** Withdrawal; the unit record rebuilds its base presence after reload. */
  withdrawn?: boolean;
  unit?: PieceData;
}

/** Full snapshot of the client-side game state. */
export interface GameSnapshot {
  boardState: BoardState;
  currentTurn: string;
  turnNumber: number;
  playerWhite: string;
  playerBlack: string;
  moveHistory: MoveRecord[];
  config: any;
  winner: string;
  endReason: string;
  /** Seconds allowed per turn (0 = unlimited). */
  turnTimeLimit: number;
  /** ISO clock start; online may be in the future to exclude replay/notice time. */
  turnStartedAt: string;
  /** Username of player who offered a draw, or ''. */
  drawOfferedBy: string;
  /** Monotonic server-side version for ordering network state events. */
  revision: number;
  /**
   * What each scoring phase finished on, as the engine banked it - the
   * server's, or the browser engine's in a solo game. Every hand-over carries
   * the latest; the room shows it rather than keeping a bank of its own.
   */
  phaseBank: PhaseBank;
  /** Present when the server owns multiplayer abilities. */
  abilityState?: any;
}

const EMPTY_SNAPSHOT: GameSnapshot = {
  boardState: {},
  currentTurn: '',
  turnNumber: 0,
  playerWhite: '',
  playerBlack: '',
  moveHistory: [],
  config: null,
  winner: '',
  endReason: '',
  turnTimeLimit: 0,
  turnStartedAt: '',
  drawOfferedBy: '',
  revision: 0,
  phaseBank: {},
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Centralised reactive store for the live game state.
 *
 * Components subscribe to `state$` (or individual derived observables)
 * and the WebSocket handler calls the `apply*` methods to push updates.
 */
@Injectable({
  providedIn: 'root',
})
export class GameStateService {
  // -- Internal state -------------------------------------------------

  private stateSubject = new BehaviorSubject<GameSnapshot>({ ...EMPTY_SNAPSHOT });

  // -- Public observables ---------------------------------------------

  /** Full game snapshot (board, turn, history, config, etc.). */
  readonly state$: Observable<GameSnapshot> = this.stateSubject.asObservable();

  // -- Read helpers (synchronous) -------------------------------------

  get snapshot(): GameSnapshot {
    return this.stateSubject.value;
  }

  get isGameActive(): boolean {
    const s = this.snapshot;
    return s.turnNumber > 0 && !s.endReason;
  }

  /** Return 'white' | 'black' | '' for the given username. */
  myColor(username: string): 'white' | 'black' | '' {
    const s = this.snapshot;
    if (s.playerWhite === username) return 'white';
    if (s.playerBlack === username) return 'black';
    return '';
  }

  // -- Mutation methods (called from WS handler) ----------------------

  private capBoard(board: BoardState): BoardState {
    return Object.fromEntries(Object.entries(board).map(([at, unit]) => [at, capUnit(unit)]));
  }

  /** Apply a `game_started` message. */
  applyGameStarted(msg: any): void {
    const timeLimit = ruleOf(msg.config, 'turnTimeLimit');
    this.stateSubject.next({
      boardState: this.capBoard(msg.boardState ?? {}),
      currentTurn: msg.currentTurn ?? '',
      turnNumber: msg.turnNumber ?? 1,
      playerWhite: msg.playerWhite ?? '',
      playerBlack: msg.playerBlack ?? '',
      moveHistory: [],
      config: msg.config ?? null,
      winner: '',
      endReason: '',
      turnTimeLimit: timeLimit,
      turnStartedAt: msg.turnStartedAt ?? new Date().toISOString(),
      drawOfferedBy: '',
      revision: msg.revision ?? 0,
      phaseBank: msg.phaseBank ?? {},
      ...(msg.abilityState ? { abilityState: msg.abilityState } : {}),
    });
  }

  /** Apply a `move_made` message. */
  applyMoveMade(msg: any): void {
    const prev = this.snapshot;
    const move: MoveRecord = msg.move;
    this.stateSubject.next({
      ...prev,
      boardState: msg.boardState ? this.capBoard(msg.boardState) : prev.boardState,
      currentTurn: msg.currentTurn ?? prev.currentTurn,
      turnNumber: msg.turnNumber ?? prev.turnNumber,
      // Casts retain their order around the move; boundary heals follow it.
      moveHistory: [...prev.moveHistory, ...(msg.effectsBefore ?? []), move, ...(msg.effects ?? [])],
      turnStartedAt: msg.turnStartedAt ?? new Date().toISOString(),
      drawOfferedBy: '',
      revision: msg.revision ?? prev.revision,
      phaseBank: msg.phaseBank ?? prev.phaseBank,
      ...(msg.abilityState ? { abilityState: msg.abilityState } : {}),
    });
  }

  /**
   * Apply a `turn_passed` message - the turn moves on, and usually the board
   * does not. Usually: overtime's toll is taken at the end of a turn whether
   * or not anybody moved, so both engines send the board they left behind. The
   * server did not always; a message without one leaves the board standing.
   */
  applyTurnPassed(msg: any): void {
    const prev = this.snapshot;
    this.stateSubject.next({
      ...prev,
      boardState: msg.boardState ? this.capBoard(msg.boardState) : prev.boardState,
      currentTurn: msg.currentTurn ?? prev.currentTurn,
      turnNumber: msg.turnNumber ?? prev.turnNumber,
      // Panel casts and boundary heals share the same persistent record.
      moveHistory: msg.effectsBefore || msg.effects
        ? [...prev.moveHistory, ...(msg.effectsBefore ?? []), ...(msg.effects ?? [])] : prev.moveHistory,
      turnStartedAt: msg.turnStartedAt ?? new Date().toISOString(),
      drawOfferedBy: '',
      revision: msg.revision ?? prev.revision,
      phaseBank: msg.phaseBank ?? prev.phaseBank,
      ...(msg.abilityState ? { abilityState: msg.abilityState } : {}),
    });
  }

  /** Apply a `game_over` message. */
  applyGameOver(msg: any): void {
    const prev = this.snapshot;
    this.stateSubject.next({
      ...prev,
      winner: msg.winner ?? '',
      endReason: msg.endReason ?? '',
      currentTurn: '',
      revision: msg.revision ?? prev.revision,
    });
  }

  /** Apply a `game_state_update` (full resync). */
  applyFullState(msg: any): void {
    const timeLimit = ruleOf(msg.config, 'turnTimeLimit');
    this.stateSubject.next({
      boardState: this.capBoard(msg.boardState ?? {}),
      currentTurn: msg.currentTurn ?? '',
      turnNumber: msg.turnNumber ?? 0,
      playerWhite: msg.playerWhite ?? '',
      playerBlack: msg.playerBlack ?? '',
      moveHistory: msg.moveHistory ?? [],
      config: msg.config ?? null,
      winner: msg.winner ?? '',
      endReason: msg.endReason ?? '',
      turnTimeLimit: timeLimit,
      turnStartedAt: msg.turnStartedAt ?? new Date().toISOString(),
      drawOfferedBy: msg.drawOfferedBy ?? '',
      revision: msg.revision ?? this.snapshot.revision,
      phaseBank: msg.phaseBank ?? {},
      ...(msg.abilityState ? { abilityState: msg.abilityState } : {}),
    });
  }

  /** Record an incoming draw offer. */
  applyDrawOffered(offeredBy: string, revision?: number): void {
    const prev = this.snapshot;
    this.stateSubject.next({
      ...prev, drawOfferedBy: offeredBy, revision: revision ?? prev.revision,
    });
  }

  /** Clear a pending draw offer. */
  clearDrawOffer(revision?: number): void {
    const prev = this.snapshot;
    this.stateSubject.next({
      ...prev, drawOfferedBy: '', revision: revision ?? prev.revision,
    });
  }

  /** Reset to blank state (e.g. when leaving game room). */
  reset(): void {
    this.stateSubject.next({ ...EMPTY_SNAPSHOT });
  }
}
