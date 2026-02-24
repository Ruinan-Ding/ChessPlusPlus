import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Piece on a hex cell: matches the Python CellData dict. */
export interface PieceData {
  unit_id: string;
  color: 'white' | 'black';
  hp: number;
  max_hp: number;
}

/**
 * Board state as received from the server.
 * Keys are `"q,r"` strings, values are PieceData.
 */
export type BoardState = Record<string, PieceData>;

/** A single move record from the server. */
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
  /** ISO timestamp when the current turn started. */
  turnStartedAt: string;
  /** Username of player who offered a draw, or ''. */
  drawOfferedBy: string;
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
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Centralised reactive store for the live game state.
 *
 * Components subscribe to `state$` (or individual derived observables)
 * and the WebSocket handler calls the `apply*` methods to push updates.
 *
 * This replaces the `(this as any)._initialBoardState` hacks that were
 * previously scattered through the GameRoomComponent.
 */
@Injectable({
  providedIn: 'root',
})
export class GameStateService {
  // ── Internal state ─────────────────────────────────────────────────

  private stateSubject = new BehaviorSubject<GameSnapshot>({ ...EMPTY_SNAPSHOT });

  // ── Public observables ─────────────────────────────────────────────

  /** Full game snapshot (board, turn, history, config, etc.). */
  readonly state$: Observable<GameSnapshot> = this.stateSubject.asObservable();

  // ── Read helpers (synchronous) ─────────────────────────────────────

  get snapshot(): GameSnapshot {
    return this.stateSubject.value;
  }

  get isGameActive(): boolean {
    const s = this.snapshot;
    return s.turnNumber > 0 && !s.endReason;
  }

  get isMyTurn(): boolean {
    return false; // overridden per-component via myColor
  }

  /** Return 'white' | 'black' | '' for the given username. */
  myColor(username: string): 'white' | 'black' | '' {
    const s = this.snapshot;
    if (s.playerWhite === username) return 'white';
    if (s.playerBlack === username) return 'black';
    return '';
  }

  // ── Mutation methods (called from WS handler) ──────────────────────

  /** Apply a `game_started` message. */
  applyGameStarted(msg: any): void {
    const timeLimit = msg.config?.rules?.turnTimeLimit ?? 0;
    this.stateSubject.next({
      boardState: msg.boardState ?? {},
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
    });
  }

  /** Apply a `move_made` message. */
  applyMoveMade(msg: any): void {
    const prev = this.snapshot;
    const move: MoveRecord = msg.move;
    this.stateSubject.next({
      ...prev,
      boardState: msg.boardState ?? prev.boardState,
      currentTurn: msg.currentTurn ?? prev.currentTurn,
      turnNumber: msg.turnNumber ?? prev.turnNumber,
      moveHistory: [...prev.moveHistory, move],
      turnStartedAt: msg.turnStartedAt ?? new Date().toISOString(),
      drawOfferedBy: '',
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
    });
  }

  /** Apply a `game_state_update` (full resync). */
  applyFullState(msg: any): void {
    const timeLimit = msg.config?.rules?.turnTimeLimit ?? 0;
    this.stateSubject.next({
      boardState: msg.boardState ?? {},
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
    });
  }

  /** Record an incoming draw offer. */
  applyDrawOffered(offeredBy: string): void {
    const prev = this.snapshot;
    this.stateSubject.next({ ...prev, drawOfferedBy: offeredBy });
  }

  /** Clear a pending draw offer. */
  clearDrawOffer(): void {
    const prev = this.snapshot;
    this.stateSubject.next({ ...prev, drawOfferedBy: '' });
  }

  /** Reset to blank state (e.g. when leaving game room). */
  reset(): void {
    this.stateSubject.next({ ...EMPTY_SNAPSHOT });
  }
}
