import { ReplayAction, ReplayFile, ReplayFrame } from './replay-session.service';
import { sectionOf } from './game-rules';
import { attacksAllowed, stageRules } from './phases';
import { migrateConfig } from './game-rules';
import { advanceBuffs, UnitBuff } from './ability-rules';
import { controlsAt, controlledUnit } from './unit-control';
import { combatExchange, CombatBonuses, attackStats, carries } from './unit-combat';
import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { ConfigService, ruleOf } from './config.service';
import { activeVet, kitActive, capStat, capUnit, rankedUnit, unitPassive, unitStats } from './unit-stats';
import type { BoardState } from './game-state.service';
import { BASE_PANELS, computeLegalMoves, computeMoveCosts, canAttack, healingAmount, hexDistanceKeys, inHomeRows, isInsideBoard, panelOfHex } from './hex-rules';
import { boardMoveLandings, boardMoveUids, boardMovesAt, unitActionActor, unitActionUids, finishedUnitUids, battlefieldActionBonus, extraActionUids, lockedPanelUnits, openingMovedHexes, panelMoverAllowed, unitVeterancy, promotionHeals, regenerationHeals } from './history-rules';
import { boardMovesPerTurn, movesPerTurn, overtimeTollAt, isEntryOpen, isHomecomingOpen, isInitialization, isSetupTurn, isWrapOpen, noAttackMessage } from './phases';
import { PhaseBank, bankEndedPhases, halftimeUpAwards, scheduleEnding, withdrawalRefund, withdrawnUnit, unitPoints } from './match-score';

/**
 * Offline single-player engine.
 *
 * A solo game has no second player, so nothing about it needs a server: no
 * Game row, no room UUID, no access token, no socket. This service answers the
 * same message types the consumer does for the solo subset of the protocol,
 * and `WebsocketService` routes to it instead of the socket while local mode
 * is on. Every component keeps talking the same protocol either way.
 *
 * State is written to localStorage on every change, so a refresh, a dropped
 * connection, or a server that was never up at all all resume the same game.
 *
 * It mirrors the server's rules: movement (see hex-rules), combat with
 * counter-attacks, and the regicide win condition. Endings are resign, draw,
 * losing your commander, and scheduled results: an early phase loss after
 * its postmatch, a side past the other's margin once Phase 3 has banked and its postmatch is played, and turn 50
 * played out with both kings standing, which is black's (match-score.ts). Anything the engine learns has to land
 * here too, or offline play quietly diverges from online play.
 *
 * **What it checks, and what it takes on trust.** The server re-derives every
 * move; this engine cannot, because the panels, the points and the abilities
 * are all still the client's own. So it checks what needs none of them: the
 * board move and its reach, the walk home, the opening's rules (no attacks,
 * one move a unit for the phase), a panel's three starts a turn, the wrap's
 * schedule, and - for any unit a panel message names, attacker or defender -
 * that the config knows it, it is not already standing on the board, and it is
 * neither above the HP its config allows nor back from the dead.
 *
 * **The three arrows' schedules and the first three rows** are checked here
 * too, and for the same reason: a window is a question about the ply alone,
 * and "is this hex in your own first three rows" is a question about the hex
 * and the mover's colour. Neither needs a panel. So a crossing must land in
 * its own rows and inside the entry window, a walk home must start in them and
 * inside the homecoming window - three a turn while setting out, uncounted in
 * overtime - and no ability fires during the opening.
 *
 * It takes on trust what an ability is worth (a boost, a mend, a cast's HP)
 * and everything that wants a panel to work out: which panel a unit stands in,
 * what a walk inside one cost. Crossings are identified by their source and
 * destination panels; their UP price and affordability are derived from the
 * match config and committed history. The remaining trust boundaries are
 * 6.15 and 6.17 on the punchlist, and they settle together or not at all.
 */

const STORAGE_KEY = 'cpp.localGame.v1';

/**
 * Whether an ability figure was sent at all, and was not a plain zero.
 *
 * Missing is the only thing that reads as "no ability": the room sends a `0`
 * and an all-zero `bonuses` on ordinary turns, so a zero cannot be a use, but
 * nonsense is not nothing - `'x'` and `Infinity` both mean a figure arrived
 * that the room had no business sending on a turn given to setting out.
 */
function sent(value: unknown): boolean {
  return value !== undefined && value !== null && Number(value) !== 0;
}

/** Matches SINGLE_PLAYER_OPPONENT in server/game/consumers.py. */
export const LOCAL_OPPONENT = 'Opponent';
/** Stands in for the room UUID; there is no room to address. */
export const LOCAL_GAME_ID = 'local';

interface TurnCheckpoint {
  turnNumber: number;
  boardState: BoardState;
  historyLength: number;
  phaseBank?: PhaseBank;
  abilityBuffs?: Record<string, UnitBuff>;
  uiState: any;
  stagedUiState?: any;
  replayLength?: number;
}

interface LocalGame {
  username: string;
  hostColor: 'white' | 'black';
  opponentKind?: 'myself' | 'cpu';
  cpuDifficulty?: 'easy' | 'normal' | 'hard';
  started: boolean;
  boardState: BoardState;
  currentTurn: string;
  turnNumber: number;
  moveHistory: any[];
  winner: string;
  endReason: string;
  config: any;
  turnStartedAt: string;
  mode: string;
  options: any;
  /**
   * What each scoring phase finished on - see match-score.ts. Optional
   * because a game saved before the engine kept one has none, and
   * `bankEndedPhases` reads a missing bank as an empty one.
   */
  phaseBank?: PhaseBank;
  abilityBuffs?: Record<string, UnitBuff>;
  turnCheckpoints?: TurnCheckpoint[];
  replayJournal?: { version: 1; actions: ReplayAction[] };
}

/**
 * The extra steps a message says an ability lent a unit: a whole number, and
 * signed so movement drains constrain committed walks too. No ceiling:
 * the config decides how far an ability sends a unit.
 */
function extraSteps(moveBonus: unknown): number {
  return Math.trunc(Number(moveBonus) || 0);
}

@Injectable({ providedIn: 'root' })
export class LocalGameService {
  private outgoing = new Subject<any>();
  /** Replies, in place of socket traffic. */
  readonly messages$ = this.outgoing.asObservable();

  private game: LocalGame | null = null;
  replayMode = false;
  private pendingRecording: { ply: number; actions: ReplayAction[] } | null = null;
  private rejected = false;

  captureReplayFrame(ui: any): ReplayFrame {
    const { config, turnCheckpoints, replayJournal, ...core } = this.game!;
    return structuredClone({ core, ui });
  }

  restoreReplayFrame(frame: ReplayFrame): void {
    if (!this.replayMode) return;
    this.game = { ...structuredClone(frame.core), config: this.game!.config };
    this.emit({ type: 'turn_rewound', ...this.snapshot(), uiState: structuredClone(frame.ui) });
  }

  openReplay(config: any, username: string, frame?: ReplayFrame): void {
    this.replayMode = true;
    this.pendingRecording = null;
    this.game = frame ? { ...structuredClone(frame.core), config: structuredClone(config) } : {
      ...this.blank(username), started: true, config: structuredClone(config),
      boardState: this.buildBoard(config), turnNumber: 1, turnStartedAt: new Date().toISOString(),
    };
    this.rename(username);
    this.game!.currentTurn = this.seat(this.game!.turnNumber % 2 ? 'white' : 'black');
  }

  closeReplay(): void { this.replayMode = false; this.restore(); }

  captureCpuState(): any { return structuredClone(this.game); }

  restoreCpuState(state: any): any {
    this.game = structuredClone(state); this.pendingRecording = null; this.persist();
    return this.snapshot();
  }

  get replayRecording(): boolean { return !!this.game?.replayJournal; }

  get replayFile(): ReplayFile | null {
    const g = this.game;
    return g?.replayJournal ? { type: 'chessplusplus-replay', version: 1,
      config: structuredClone(g.config), players: { white: this.seat('white'), black: this.seat('black') },
      actions: structuredClone(g.replayJournal.actions) } : null;
  }

  replayResult(reason: string, color: 'white' | 'black'): boolean {
    if (!this.replayMode || !this.game || this.game.endReason
        || !['resign', 'draw_agreed', 'disconnect', 'timeout'].includes(reason)) return false;
    this.over(reason === 'draw_agreed' ? '' : this.seat(color === 'white' ? 'black' : 'white'), reason);
    return true;
  }

  constructor(private configService: ConfigService) {
    this.restore();
  }

  /** Drop the cached game (a deliberate exit, not a disconnect). */
  clear(): void {
    this.game = null;
    if (this.replayMode) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  }

  hasSavedGame(): boolean {
    return !!this.game;
  }

  // -- Protocol -------------------------------------------------------

  /** Handle one client message exactly as the server would for a solo room. */
  send(msg: any): boolean {
    this.rejected = false;
    const startingPly = this.game?.turnNumber;
    const priorBuffs = this.game?.abilityBuffs, priorHistory = this.game?.moveHistory;
    switch (msg?.type) {
      case 'create_single_player_game':
        // A saved game outlives the page, so entering solo play resumes it
        // rather than dealing over the top of a position in progress. A
        // finished one is re-dealt by start_game; leaving the room clears it.
        if (!this.game) this.game = this.blank(msg.username);
        else this.rename(msg.username);
        this.persist();
        this.emit({ type: 'single_player_game_created', gameId: LOCAL_GAME_ID, token: LOCAL_GAME_ID });
        break;

      case 'join_game_room': {
        if (!this.game) this.game = this.blank(msg.username);
        // A cached game outlives the page, so the username may have changed
        // under it; the seat is ours either way.
        this.rename(msg.username);
        this.emitPlayerList();
        this.emit({ type: 'join_game_room_success', gameId: LOCAL_GAME_ID,
                    gameStatus: this.game.started ? 'started' : 'waiting' });
        break;
      }

      case 'request_game_state':
        if (this.game) this.emit({ type: 'game_state_update', ...this.snapshot() });
        break;

      case 'start_game':
        // The server rejects a replayed start while a match is running; here
        // it would silently re-deal the board out from under the player.
        if (this.game?.started && !this.game.endReason) break;
        this.start(msg.hostColor === 'black' ? 'black' : 'white', msg.turnTimeLimit, msg);
        break;

      case 'record_turn':
        if (this.game?.replayJournal && msg.ply === this.game.turnNumber) {
          this.pendingRecording = { ply: msg.ply, actions: structuredClone(msg.actions) };
        }
        break;

      case 'set_cpu_options':
        if (this.game && !this.game.started) {
          this.game.opponentKind = msg.opponentKind === 'cpu' ? 'cpu' : 'myself';
          this.game.cpuDifficulty = ['easy', 'normal', 'hard'].includes(msg.cpuDifficulty) ? msg.cpuDifficulty : 'normal';
          this.persist();
        }
        break;

      case 'cpu_manual':
        if (this.game) { this.game.opponentKind = 'myself'; this.persist(); }
        break;

      case 'checkpoint_turn':
        this.checkpointTurn(msg.turnNumber, msg.uiState, msg.staged === true);
        break;

      case 'rewind_turn':
        this.rewindTurn();
        break;

      case 'reset_game': {
        // A finished game goes back to waiting with the room intact: the host
        // may want a different mode, seat or timer before dealing again. The
        // board is not re-dealt here - `start_game` does that, so the setup
        // screen is a real stop rather than a flicker on the way through.
        if (!this.game) break;
        const { username, mode, options } = this.game;
        this.game = { ...this.blank(username), mode, options };
        this.persist();
        this.emitPlayerList();
        this.emit({ type: 'game_reset' });
        break;
      }

      case 'make_move':
        this.move(
          msg.from, msg.to, msg.attack, msg.moveBonus, msg.bonuses, msg.withdraw,
          msg.effects, msg.effectsBefore, msg.more, msg.heal, msg.afterAttackTo, msg.unitAction, msg.effectsAfterAttack, msg.pathMov);
        break;

      case 'enter_board':
        this.enter(msg.from, msg.to, msg.unit);
        break;

      case 'panel_move':
        this.walkInPanel(msg.from, msg.to, msg.unit, msg.panel, msg.cost, msg.price, msg.effectsBefore);
        break;

      case 'panel_attack':
        this.attackIntoPanel(
          msg.from, msg.to ?? msg.from, msg.attack, msg.unit,
          msg.moveBonus, msg.counters !== false, msg.bonuses, msg.panel,
          msg.effects, msg.effectsBefore, msg.more, msg.afterAttackTo, msg.effectsAfterAttack);
        break;

      case 'pass_turn':
        this.pass(msg.effectsBefore);
        break;

      case 'resign':
        if (this.game?.replayJournal) this.game.replayJournal.actions.push({ ply: this.game.turnNumber,
          color: this.game.hostColor, command: { type: 'result', reason: 'resign' } });
        if (this.game?.started && !this.game.endReason) {
          this.over(this.other(this.game.username), 'resign', { resignedBy: this.game.username });
        }
        break;

      case 'offer_draw':
        // Nobody to accept, so an offer is simply a draw.
        if (this.game?.started && !this.game.endReason) this.over('', 'draw_agreed');
        break;

      case 'change_game_mode':
        if (this.game) {
          this.game.mode = msg.mode ?? 'default';
          this.game.options = msg.options ?? {};
          this.persist();
          this.emit({ type: 'game_mode_changed', mode: this.game.mode, options: this.game.options });
        }
        break;

      case 'game_room_message':
        this.emit({ type: 'game_room_message', username: msg.username,
                    content: msg.content, timestamp: msg.timestamp ?? new Date().toISOString() });
        break;

      case 'chat_message':
        this.emit({ type: 'chat_message', username: msg.username,
                    content: msg.content, timestamp: msg.timestamp ?? new Date().toISOString() });
        break;

      case 'join_lobby':
        this.emit({ type: 'user_list', users: [{ username: msg.username, status: 'online' }] });
        break;

      case 'request_user_list':
        this.emit({ type: 'user_list',
                    users: [{ username: this.game?.username ?? '', status: 'online' }] });
        break;

      // Readiness, status, heartbeats, leaving: nothing to tell anyone.
      default:
        break;
    }
    if (this.rejected && this.pendingRecording) {
      // A partially accepted legacy batch cannot be exported as a complete recording.
      if (this.game) delete this.game.replayJournal;
      this.pendingRecording = null;
    } else if (this.game?.replayJournal && this.pendingRecording && this.game.turnNumber !== startingPly) {
      this.game.replayJournal.actions.push(...this.pendingRecording.actions);
      this.pendingRecording = null;
      this.persist();
    }
    // A rejected action must also discard status changes staged before its walk.
    if (['make_move', 'panel_attack'].includes(msg?.type) && this.game && this.game.moveHistory === priorHistory) {
      this.game.abilityBuffs = priorBuffs;
    }
    return !this.rejected;
  }

  get canRewind(): boolean { return this.rewindIndex() >= 0; }

  private rewindIndex(): number {
    const g = this.game;
    if (!g?.started) return -1;
    const checkpoints = g.turnCheckpoints ?? [];
    // Resignation and agreed draws end the current ply; settled turns advance it.
    const ply = ['resign', 'draw_agreed'].includes(g.endReason) ? g.turnNumber : g.turnNumber - 1;
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (checkpoints[i].turnNumber === ply) return i;
    }
    return -1;
  }

  private checkpointTurn(ply: number, uiState: any, staged: boolean): void {
    const g = this.game;
    if (!g?.started || g.endReason || ply !== g.turnNumber || !uiState) return;
    if (staged) {
      const checkpoint = g.turnCheckpoints?.find(turn => turn.turnNumber === ply);
      if (!checkpoint) return; // A resumed mid-turn save cannot supply its missing start.
      checkpoint.stagedUiState = structuredClone(uiState);
      this.persist();
      return;
    }
    if (g.moveHistory.some(move => move.turn === ply && !move.promotionHeal && !move.halftimeUp)) return;
    if (g.turnCheckpoints?.some(checkpoint => checkpoint.turnNumber === ply)) return;
    // Config and history already live in the save; retain only each turn's state.
    // ponytail: localStorage quota limits large custom matches; move checkpoints to IndexedDB if needed.
    g.turnCheckpoints = [...(g.turnCheckpoints ?? []), structuredClone({
      turnNumber: ply, boardState: g.boardState, historyLength: g.moveHistory.length,
      phaseBank: g.phaseBank, abilityBuffs: g.abilityBuffs, uiState, replayLength: g.replayJournal?.actions.length,
    })];
    this.persist();
  }

  private rewindTurn(): void {
    const index = this.rewindIndex();
    if (index < 0) return;
    const g = this.game!, checkpoint = structuredClone(g.turnCheckpoints![index]);
    g.turnCheckpoints = g.turnCheckpoints!.slice(0, index + 1);
    if (g.replayJournal && checkpoint.replayLength !== undefined) g.replayJournal.actions.length = checkpoint.replayLength;
    this.pendingRecording = null;
    g.boardState = checkpoint.boardState;
    g.moveHistory = g.moveHistory.slice(0, checkpoint.historyLength);
    g.phaseBank = checkpoint.phaseBank;
    g.abilityBuffs = checkpoint.abilityBuffs;
    g.turnNumber = checkpoint.turnNumber;
    g.currentTurn = this.seat(g.turnNumber % 2 ? 'white' : 'black');
    g.winner = ''; g.endReason = '';
    g.turnStartedAt = new Date().toISOString();
    this.persist();
    this.emit({ type: 'turn_rewound', ...this.snapshot(), uiState: checkpoint.stagedUiState ?? checkpoint.uiState });
  }

  // -- Game mechanics -------------------------------------------------

  private blank(username: string): LocalGame {
    return {
      username: this.seatName(username),
      hostColor: 'white',
      started: false,
      boardState: {},
      currentTurn: '',
      turnNumber: 0,
      moveHistory: [],
      winner: '',
      endReason: '',
      config: null,
      turnStartedAt: '',
      mode: 'default',
      options: {},
      phaseBank: {},
    };
  }

  private start(hostColor: 'white' | 'black', turnTimeLimit?: number, options: any = {}): void {
    const username = this.game?.username ?? '';
    const config = migrateConfig(this.configService.getConfig());
    const selectedTime = Number.isInteger(turnTimeLimit) ? turnTimeLimit : this.game?.options?.turnTimeLimit;
    if (Number.isInteger(selectedTime)) {
      config.match.turnTimeLimit = selectedTime;
    }
    this.game = {
      ...this.blank(username),
      hostColor,
      opponentKind: options.opponentKind === 'cpu' ? 'cpu' : 'myself',
      cpuDifficulty: ['easy', 'normal', 'hard'].includes(options.cpuDifficulty) ? options.cpuDifficulty : 'normal',
      started: true,
      config,
      boardState: this.buildBoard(config),
      replayJournal: { version: 1, actions: [] },
      turnNumber: 1,
      turnStartedAt: new Date().toISOString(),
    };
    this.game.currentTurn = this.seat('white');
    this.persist();
    this.emit({ type: 'game_started', ...this.snapshot() });
  }

  /** Place the configured setup, exactly as build_initial_board does. */
  private buildBoard(config: any): Record<string, any> {
    const radius: number = config?.board?.radius ?? 11;
    const board: Record<string, any> = {};
    for (const color of ['white', 'black'] as const) {
      const placement = config?.setup?.[color] ?? {};
      for (const [coord, unitId] of Object.entries(placement)) {
        const [q, r] = String(coord).split(',').map(Number);
        if (!Number.isInteger(q) || !Number.isInteger(r)) continue;
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > radius) continue;
        const hp: number = unitStats(unitId as string, config, sectionOf(config, 'veterancy').kitZones.includes('battlefield') ? sectionOf(config, 'veterancy').startingRank : -1).hp ?? 1;
        // uid mirrors build_initial_board: identity that survives moves.
        board[`${q},${r}`] = {
          unit_id: unitId, color, hp, max_hp: hp, uid: `${color[0]}${q},${r}`, vet: sectionOf(config, 'veterancy').startingRank, veterancyHpActive: sectionOf(config, 'veterancy').kitZones.includes('battlefield') && sectionOf(config, 'veterancy').startingRank >= sectionOf(config, 'veterancy').statUnlock,
        };
      }
    }
    return board;
  }

  /**
   * What is wrong with a unit that arrived inside a panel message, or null if
   * nothing is. Mirrors the checks `_handle_panel_move` makes on the server
   * that need no panel to make.
   *
   * A panel unit is the client's word entirely - no engine here holds the
   * panels - but three things can be told without one: the config knows what
   * it is, it is not a second copy of something already standing on the board,
   * and the opening has not already spent its one move for the phase.
   *
   * `moving` is false for the unit on the RECEIVING end of a blow, which has
   * not moved and so spends no allowance - but is still named by a message and
   * still has to be a unit that exists and is not on the board. Without this
   * the swing landed on whatever the message described, `strikeDamage` read an
   * undefined unit out of config, and the record went into the history for the
   * panels to replay.
   */
  private panelUnitFault(unit: any, moving = true): string | null {
    const g = this.game!;
    if (!g.config?.units?.[unit?.unit_id]) return 'No such unit';
    if (Object.values(g.boardState).some((p: any) => p?.uid && p.uid === unit?.uid)) {
      return 'That unit is already on the board';
    }
    if (moving && lockedPanelUnits(g.moveHistory, g.turnNumber, this.game?.config).has(unit?.uid)) {
      return 'That unit has had its move for the opening';
    }
    return null;
  }

  /**
   * Whether a message brought an ability onto a turn that forbids one.
   *
   * The opening permits CP utilities; every postmatch permits casts. The engine
   * checks this window without needing to resolve the solo catalogue.
   *
   * A zero is not a use. The room sends `moveBonus: 0` and an all-zero
   * `bonuses` on ordinary turns, and refusing those would refuse every move.
   */
  private abilityFault(
    moveBonus?: number, bonuses?: any, effects?: any[], effectsBefore?: any[], effectsAfterAttack?: any[],
  ): boolean {
    const g = this.game!;
    if (!isInitialization(g.turnNumber, g.config) || ['poolAbilities', 'unitAbilities', 'cpSkills', 'cpUltimates'].some(key => stageRules(g.turnNumber, g.config)[key])) return false;
    const stage = stageRules(g.turnNumber, g.config);
    const casts = [...(effects ?? []), ...(effectsBefore ?? []), ...(effectsAfterAttack ?? [])];
    if (casts.length && !stage.cpUtilities) return true;
    if (casts.some(e => {
      if (e.abilityCast) {
        const cast = e.abilityCast, entry = g.config.abilities?.catalogue?.[cast.id];
        return cast.row !== 'path' || entry?.target !== 'universal' || cast.up !== entry.up
          || e.color !== this.colorOf(g.currentTurn)
          || !g.config.abilities.paths.some((path: any) => path.utility === cast.id)
          || Object.keys(e).some(key => !['castId', 'color', 'abilityCast'].includes(key));
      }
      return !e.promotion?.uid || e.hp !== e.promotion.hp
        || !Number.isInteger(e.promotion.vet) || e.promotion.vet < 1 || e.promotion.vet > 3
        || Object.keys(e).some(key => !['promotion', 'at', 'uid', 'hp', 'unit', 'panel'].includes(key));
    })) return true;
    // **Sent at all, and not a zero.** `Number(x) || 0` read as a guard let
    // `moveBonus: 'x'` through as though no ability had come: NaN is falsy, so
    // nonsense was indistinguishable from nothing. Asked this way round the
    // missing case is the only one that passes, so NaN and Infinity are both
    // read as what they are - a bonus that arrived and is not zero.
    if (sent(moveBonus)) return true;
    return Object.entries(bonuses ?? {}).some(([stat, value]) => sent(value)
      && !(stage.attack && ['atk', 'def', 'targetAtk', 'targetDef'].includes(stat))
      && !(stage.normalHeal && stat === 'hel'));
  }

  /**
   * Walk a unit in from a panel. Deployment rather than the turn's action -
   * several may come through in a turn - so unlike a move this hands the turn
   * to nobody and counts no ply.
   *
   * The unit arrives with the message: the panels are the client's own and no
   * engine holds them, so there is nothing here to look it up in. Which panel
   * it stood in and how far it walked to the gateway are still taken on trust -
   * both need the panel model this engine has not got - but what can be
   * checked without one is: the config knows the unit, it is not already
   * standing on the board, the opening has not locked it, its reserve has an
   * allowance left, and it lands somewhere real and empty.
   */
  private enter(from: string, to: string, unit: any): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    const radius: number = g.config?.board?.radius ?? 11;
    const [tq, tr] = String(to).split(',').map(Number);
    if (!unit || unit.color !== this.colorOf(g.currentTurn) || g.boardState[from]
        || !Number.isInteger(tq) || !Number.isInteger(tr)
        || !isInsideBoard(tq, tr, radius) || g.boardState[to]) {
      this.emit({ type: 'invalid_move', message: 'Nothing may enter there' });
      return;
    }
    if (carries(this.game?.abilityBuffs?.[unit?.uid], 'action-lock')) {
      this.emit({ type: 'invalid_move', message: 'This unit cannot act this turn' }); return;
    }
    const wrong = this.panelUnitFault(unit)
      ?? (this.unitWalkEnded(unit.uid, to, [], { ...unit, panel: panelOfHex(from, g.config?.board?.orientation) }) ? 'Movement ends after using a unit ability' : null);
    if (wrong) {
      this.emit({ type: 'invalid_move', message: wrong });
      return;
    }
    // The window first, so a shut one is never reported as a spent allowance.
    // The reserve's three arrows run on the setup turns and on each phase's
    // halftime half - the mirror image of the wrap, which runs on the halves
    // between them.
    if (!isEntryOpen(g.turnNumber, this.game?.config)) {
      this.emit({ type: 'invalid_move', message: 'The way in is shut' });
      return;
    }
    // And it lands in its own first three rows. The one part of a crossing
    // this engine can check for itself: where a unit may STOP is a question
    // about the destination hex and the mover's colour, and needs neither the
    // panel it came from nor the walk that got it to the gateway.
    const physicalSide = from.startsWith('-') ? 'black' : 'white';
    if (!inHomeRows(unit.owner ? physicalSide : unit.color, tr, radius, this.game?.config)) {
      this.emit({ type: 'invalid_move', message: 'A crossing stops in your own first three rows' });
      return;
    }
    // A crossing spends one of the reserve's three starts for the turn - five
    // in a postmatch - and the opening gives a unit one move for the whole
    // phase.
    if (!panelMoverAllowed(g.moveHistory, g.turnNumber, unit.color, unit.uid, panelOfHex(from, g.config?.board?.orientation) || undefined, g.config)) {
      this.emit({ type: 'invalid_move', message: 'That reserve has started its units for the turn' });
      return;
    }
    // Its HP is the client's word, like a boost - a cast may have mended or
    // hurt it in the panel - but not above what its own config allows.
    const full = unitStats(unit.unit_id, g.config, unit.veterancyHpActive ? unit.vet : -1)?.hp ?? unit.max_hp ?? 1;
    const hp = Math.min(full, Math.trunc(Number(unit.hp) || 0));
    // **Not back from the dead, either.** A panel unit a cast emptied is off
    // the roster the server rebuilds (`deal_panels` skips anything on 0), so
    // flooring this at 1 would walk a dead unit onto the board rather than
    // refuse it.
    if (hp <= 0) {
      this.emit({ type: 'invalid_move', message: 'Nothing is standing there' });
      return;
    }
    // `max_hp` is taken from config too, not just `hp`. It is the ceiling
    // every later cast is clamped against (`landOnBoard`), so accepting the
    // message's word for it undoes the clamp above one mend later.
    const { panel: _panel, ...fieldUnit } = unit;
    unit = rankedUnit({ ...fieldUnit, hp, max_hp: full,
      ...(g.config.units[unit.unit_id]?.veterancy?.hp && unit.veterancyHpActive === undefined ? { veterancyHpActive: false } : {}) }, g.config, unit.vet ?? 0);
    g.boardState = { ...g.boardState, [to]: unit };
    g.moveHistory = [...g.moveHistory, {
      from, to, unit_id: unit.unit_id, color: unit.color, turn: g.turnNumber,
      captured: null, attacked: false, damage_dealt: 0,
      defender_eliminated: false, moved: true,
      // What tells the opening's one-board-move rule this was not it - and
      // the unit, so the client knows which reserve has left for good. A hex
      // it once stood on says nothing: the board it walked onto forgets it
      // the moment it dies.
      entered: true, unit,
    }];
    this.persist();
    this.emit({ type: 'game_state_update', ...this.snapshot() });
  }

  /**
   * A walk inside a panel, or the wrap out of a base. Recorded rather than
   * resolved: like a crossing it is deployment, not the turn's action, so the
   * ply and the seat stay where they are.
   *
   * These used to reach no engine at all. The board moved the unit in its own
   * memory, so a reload re-dealt it to where it began and the other player
   * never saw it move. Recorded, the panels are replayed from the history in
   * order - here and on the server, which re-derives the walk's cost and the
   * wrap's price where this engine takes them as sent, having nobody to cheat.
   */
  private walkInPanel(
    from: string, to: string, unit: any, panel?: string, cost?: number, price?: number, effectsBefore?: any[],
  ): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    if (!unit?.uid || unit.color !== this.colorOf(g.currentTurn) || !from || !to || from === to) {
      this.emit({ type: 'invalid_move', message: 'That unit cannot walk there' });
      return;
    }
    if (carries(this.game?.abilityBuffs?.[unit?.uid], 'action-lock')) {
      this.emit({ type: 'invalid_move', message: 'This unit cannot act this turn' }); return;
    }
    const wrong = this.panelUnitFault(unit)
      ?? (this.unitWalkEnded(unit.uid, to, [], { ...unit, panel: panelOfHex(from, g.config?.board?.orientation) }) ? 'Movement ends after using a unit ability' : null);
    if (wrong) {
      this.emit({ type: 'invalid_move', message: wrong });
      return;
    }
    // One of the panel's three starts for the turn, and not a unit the opening
    // has already spent. Where the walk goes and what it costs to get there
    // are still the client's - both want the panel model this engine has not
    // got, and the cost wants the boost that may have lent the steps.
    if (!panelMoverAllowed(g.moveHistory, g.turnNumber, unit.color, unit.uid, panel, g.config)) {
      this.emit({ type: 'invalid_move', message: 'That panel has started its units for the turn' });
      return;
    }
    const wrap = BASE_PANELS.has(panelOfHex(from, g.config?.board?.orientation))
      && !BASE_PANELS.has(panelOfHex(to, g.config?.board?.orientation));
    if (wrap && !isWrapOpen(g.turnNumber, this.game?.config)) {
      this.emit({ type: 'invalid_move', message: 'The wrap is shut' });
      return;
    }
    // Only currency records precede panel walks; unit HP/status casts keep their existing resolution points.
    if (effectsBefore?.some(effect => !effect.abilityCast?.up) || this.abilityFault(0, null, undefined, effectsBefore)) {
      this.emit({ type: 'invalid_move', message: 'Invalid ability reward before a panel walk' }); return;
    }
    const before = this.landEffects({ ...g.boardState }, effectsBefore);
    const history = [...g.moveHistory, ...before.records];
    // Geometry remains the room's; the price and UP affordability are derived here.
    const worth = Math.max(0, Math.trunc(Number(g.config?.units?.[unit.unit_id]?.value) || 0))
      * sectionOf(g.config, 'economy').wrapPriceMultiplier;
    if (wrap && unitPoints(g.config, history, unit.color) < worth) {
      this.emit({ type: 'invalid_move', message: 'Not enough UP for the crossing' });
      return;
    }
    g.moveHistory = [...history, {
      from, to, unit_id: unit.unit_id, color: unit.color, turn: g.turnNumber,
      captured: null, attacked: false, damage_dealt: 0,
      defender_eliminated: false, moved: true,
      panelMove: true,
      ...(panel ? { panel } : {}),
      cost: Math.max(0, Math.trunc(Number(cost) || 0)),
      price: wrap ? worth : 0,
      unit,
    }];
    this.persist();
    this.emit({ type: 'game_state_update', ...this.snapshot() });
  }

  /**
   * A blow from the battlefield that lands inside a panel - a reserve or a
   * base unit on the receiving end.
   *
   * The mirror of `panelAttack`: this time the *defender* is the one no board
   * holds, so it arrives with the message and its remaining HP goes back on
   * the record. The attacker is on the board, so the answer lands normally.
   *
   * A base unit never starts a fight, but it finishes its part of one: it
   * counters like anything else if the attacker is inside its reach.
   */
  private attackIntoPanel(
    from: string, to: string, attack: string, unit: any, moveBonus?: number,
    counters = true,
    // What the abilities are worth to this blow. The board path has taken
    // these since boosts landed; without them here the room previewed a
    // buffed swing with one number and committed it with another, and the
    // panel's drawn HP jumped when the record arrived.
    bonuses?: Partial<CombatBonuses>,
    // Which panel took it. Carried, not derived: this engine has no panels to
    // look one up in, and the record is the only place it survives a reload -
    // where it is what tells the mending a base from a reserve.
    panel?: string,
    /** The turn's casts after its blow, and before it - see `landEffects`. */
    effects?: any[],
    effectsBefore?: any[],
    /** Another board move follows in this turn - see `holding` in `move`. */
    more?: boolean,
    afterAttackTo?: string,
    effectsAfterAttack?: any[],
  ): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    if (!this.unitCastOrderValid(effectsBefore) || !this.unitCastOrderValid([...(effectsAfterAttack ?? []), ...(effects ?? [])], g.boardState[from]?.uid)) {
      this.emit({ type: 'invalid_move', message: 'A unit ability must be used before its attack' }); return;
    }
    unit = { ...unit, panel: panel ?? panelOfHex(attack, g.config?.board?.orientation) };
    const start = { ...g.boardState };
    const before = this.landEffects(start, effectsBefore);
    const attacker = start[from];
    const movingColor = this.colorOf(g.currentTurn);
    if (from !== to && this.unitWalkEnded(attacker?.uid, to, before.records)) {
      this.emit({ type: 'invalid_move', message: 'Movement ends after using a unit ability' }); return;
    }
    const extraUids = extraActionUids([...g.moveHistory, ...before.records], g.turnNumber, movingColor);
    if (finishedUnitUids([...g.moveHistory, ...before.records], g.turnNumber, movingColor, g.config, 'battlefield').has(attacker?.uid ?? '')) {
      this.emit({ type: 'invalid_move', message: 'That unit has already moved this turn' }); return;
    }
    if (!attacker || attacker.color !== movingColor || !unit || unit.color === movingColor) {
      this.emit({ type: 'invalid_move', message: 'Nothing to attack there' });
      return;
    }
    // Nobody attacks on a turn given to setting out, a panel being no
    // exception - the board never offered one there, and until now nothing
    // else said no.
    if (!attacksAllowed(g.turnNumber, g.config)) {
      this.emit({ type: 'invalid_move', message: noAttackMessage(g.turnNumber, this.game?.config) });
      return;
    }
    // One of the turn's board moves like any other - the allowance, the
    // one-move-per-unit rule and `more`, exactly as `move` asks them. Ending
    // the turn outright threw away every other move an overtime turn had
    // staged alongside the blow. Mirrors `_claim_board_move` in consumers.py.
    const normalAllowance = boardMovesPerTurn(g.turnNumber, this.game?.config) + battlefieldActionBonus([...g.moveHistory, ...before.records], g.turnNumber, movingColor);
    const moveAllowance = normalAllowance + extraUids.length;
    const movesUsed = boardMovesAt(g.moveHistory, g.turnNumber, movingColor, g.config);
    const extraUsed = g.moveHistory.filter((record: any) => record.turn === g.turnNumber && extraUids.includes(record.uid)).length;
    if (extraUids.length && !extraUids.includes(attacker?.uid ?? '') && movesUsed - extraUsed >= normalAllowance) {
      this.emit({ type: 'invalid_move', message: 'Only the controlled unit has an extra action' }); return;
    }
    if (movesUsed >= moveAllowance && !boardMoveUids([...g.moveHistory, ...before.records], g.turnNumber, movingColor, g.config).has(attacker?.uid ?? '')) {
      this.emit({
        type: 'invalid_move',
        message: `That side has had all ${moveAllowance} of its moves this turn`,
      });
      return;
    }
    if (boardMoveLandings(g.moveHistory, g.turnNumber, movingColor, this.game?.config).has(from)) {
      this.emit({ type: 'invalid_move', message: 'That unit has already moved this turn' });
      return;
    }
    const holding = !!more;
    // The defender is named by the message too, so it gets the same checks the
    // walkers get, less the opening's lock - it is not the one moving.
    if (carries(g.abilityBuffs?.[attacker.uid!], 'action-lock')) {
      this.emit({ type: 'invalid_move', message: 'This unit cannot act this turn' }); return;
    }
    const bad = this.panelUnitFault(unit, false);
    if (bad) {
      this.emit({ type: 'invalid_move', message: bad });
      return;
    }
    // The walk comes with the swing - this message is the whole turn - so it
    // is re-derived here exactly as `move` does, and applied before anything
    // is measured. Range is read from where the unit ENDS UP, not where it
    // set off from.
    const radius: number = g.config?.board?.radius ?? 11;
    const [q, r] = String(from).split(',').map(Number);
    const bonus = extraSteps(moveBonus);
    const budget = bonus
      ? capStat((unitStats(attacker.unit_id, g.config, activeVet(attacker, undefined, g.config))?.move ?? 0) + bonus)
      : undefined;
    const walked = to !== from;
    if (walked
        && !computeLegalMoves(start, q, r, g.config, radius, budget).has(to)) {
      this.emit({ type: 'invalid_move', message: 'Illegal move' });
      return;
    }

    const board = { ...start };
    if (walked) {
      board[to] = attacker;
      delete board[from];
    }

    if (unitStats(attacker.unit_id, g.config, activeVet(attacker, undefined, g.config))?.heal?.length) {
      this.emit({ type: 'invalid_move', message: 'This unit heals instead of attacking' });
      return;
    }
    const distance = hexDistanceKeys(to, attack);
    if (!canAttack(attackStats(attacker.unit_id, g.config, activeVet(attacker, undefined, g.config), false, true, bonuses?.atkSet), distance, bonuses?.atkSet === undefined ? bonuses?.atk ?? 0 : 0)) {
      this.emit({ type: 'invalid_move', message: 'Out of range' });
      return;
    }

    const exchange = combatExchange(attacker, unit, distance, g.config, {
      ...bonuses,
      atk: bonuses?.atk ?? 0, def: bonuses?.def ?? 0, targetAtk: bonuses?.targetAtk ?? 0, targetDef: bonuses?.targetDef ?? 0,
      charge: bonuses?.charge, nullify: bonuses?.nullify,
    }, counters);
    const record: any = {
      from, to, unit_id: attacker.unit_id, color: attacker.color, turn: g.turnNumber,
      ...(attacker.uid ? { uid: attacker.uid } : {}),
      captured: exchange.targetHp <= 0 ? unit.unit_id : null, attacked: true, attackedHex: attack,
      damage_dealt: exchange.damage + exchange.secondDamage, defender_eliminated: exchange.targetHp <= 0,
      moved: walked, counter_damage: exchange.counterDamage + exchange.secondCounterDamage, countered: exchange.countered, attacker_eliminated: exchange.attackerHp <= 0,
      ...(exchange.leechHeal ? { leech_heal: exchange.leechHeal } : {}),
      panelAttack: true, intoPanel: true, unit, defenderHp: exchange.targetHp,
      counterActor: { unit_id: unit.unit_id, color: unit.color, uid: unit.uid },
      ...(exchange.secondStrike ? { secondStrike: true } : {}),
      ...(exchange.secondCounter ? { secondCounter: true, second_counter_damage: exchange.secondCounterDamage } : {}), ...(panel ? { panel } : {}),
    };
    if (exchange.attackerHp <= 0) delete board[to]; else board[to] = { ...attacker, hp: exchange.attackerHp };
    const between = this.landEffects(board, effectsAfterAttack).records;
    if (afterAttackTo && !this.finishRapidMove(board, start, from, to, afterAttackTo, attacker, budget, record)) return;

    // Held: the seat, the ply and the clock stay put, and the toll waits for
    // the turn's last move - the same as a held `move`.
    if (holding) {
      g.boardState = board;
      g.moveHistory = [...g.moveHistory, ...before.records, record, ...between, ...this.landEffects(board, effects).records];
      this.persist();
      this.emit({ type: 'game_state_update', ...this.snapshot() });
      return;
    }
    this.commitPanelBlow(record, board, before.records, [...between, ...this.landEffects(board, effects).records]);
  }

  /**
   * What a cast leaves a panel unit with, in the shape a blow into a panel
   * writes. The panels are the client's, so nothing is resolved here: the
   * record is the one place that HP survives a reload.
   */
  private panelEffectRecord(unit: any, hp: number, panel?: string): any {
    const left = Math.max(0, Math.trunc(hp));
    return {
      from: '', to: '', unit_id: unit.unit_id, color: unit.color, turn: this.game!.turnNumber,
      captured: null, attacked: false, damage_dealt: 0, moved: false,
      defender_eliminated: left <= 0,
      intoPanel: true, panelEffect: true, unit, defenderHp: left,
      ...(panel ? { panel } : {}),
    };
  }

  /**
   * Land a list of the turn's casts on `board`, in order.
   *
   * Every cast rides inside the one message that ends the turn - the move, the
   * swing into a panel, or the pass. The lists separate casts before the
   * action, between combat and Rapid Movement, and after the action.
   *
   * Before, they went out as messages of their own ahead of the move. Two
   * things broke. A cast carries the HP worked out for the turn so far, blow
   * included, so one made after the blow was struck over again when the move
   * resolved - a mend after a counter was lost. And a move this engine
   * refused came back half-played: the casts had already been kept. Landed
   * here instead, the earlier ones go on a copy the move is measured against,
   * the later ones after it, the toll after both - and a refusal keeps none.
   *
   * Solo accepts its own UI's resolved effects. Online commands carry only
   * intent; the server derives HP and modifiers from authoritative ability state.
   *
   * Returns the panel records, and whether a cast took a unit off the board.
   */
  private unitCastOrderValid(effects: any[] = [], attackedUid?: string, healedUid?: string): boolean {
    const g = this.game;
    if (!g) return false;
    const history: any[] = [...g.moveHistory], color = this.colorOf(g.currentTurn);
    for (const effect of effects) {
      const record = { turn: g.turnNumber, ...effect }, uid = effect.unitCast?.uid;
      if (uid) {
        const actor = unitActionActor(record, g.config);
        if (!actor) return false;
        const unit = Object.values(g.boardState).find(piece => piece.uid === uid);
        const trait = unit && unitPassive(unit.unit_id, g.config, activeVet(unit, unit.panel, g.config));
        const freeOrder = trait?.effect === 'rapid-movement' && !!trait.freeOrder;
        if ((uid === attackedUid && !freeOrder) || uid === healedUid || finishedUnitUids(history, g.turnNumber, color, g.config, actor.category).has(uid)
            || history.some(move => move.turn === g.turnNumber && ((move.entered && move.unit?.uid === uid)
              || ((move.uid ?? move.unit?.uid) === uid && !move.panelEffect && (move.healedHex || (move.attacked && !freeOrder)))))) return false;
        const actors = unitActionUids(history, g.turnNumber, color, actor.category, g.config);
        const limit = movesPerTurn(g.turnNumber, actor.category, g.config)
          + (actor.category === 'battlefield' ? battlefieldActionBonus(history, g.turnNumber, color) : 0);
        if (!actors.has(uid) && !extraActionUids(history, g.turnNumber, color).includes(uid) && actors.size >= limit) return false;
      }
      history.push(record);
    }
    return true;
  }

  private unitWalkEnded(uid: string | undefined, destination: string, before: any[] = [], panelUnit?: any): boolean {
    const unit = panelUnit ?? Object.values(this.game?.boardState ?? {}).find(piece => piece.uid === uid);
    const trait = unit && unitPassive(unit.unit_id, this.game!.config, activeVet(unit, unit.panel, this.game!.config));
    if (trait?.effect === 'rapid-movement' && trait.freeOrder) return false;
    return !!uid && [...(this.game?.moveHistory ?? []), ...before].some(record => record.turn === this.game?.turnNumber
      && record.unitCast?.uid === uid && record.unitCast.at !== destination);
  }

  private landEffects(board: Record<string, any>, effects?: any[]): { records: any[]; killed: boolean } {
    const records: any[] = [];
    let killed = false;
    // Sacrifice removes its caster; invulnerability blocks HP damage only.
    const removals = new Set<string>();
    for (const e of Array.isArray(effects) ? effects : []) {
      if (e.status?.uid) {
        const buffs = { ...(this.game!.abilityBuffs ?? {}) };
        if (e.status.buff) buffs[e.status.uid] = e.status.buff; else delete buffs[e.status.uid];
        this.game!.abilityBuffs = buffs;
        records.push({ turn: this.game!.turnNumber, status: e.status });
      }
      if (e.promotion?.uid) {
        const key = Object.keys(board).find(at => board[at].uid === e.promotion.uid);
        if (key) board[key] = { ...board[key], vet: e.promotion.vet, max_hp: e.promotion.max_hp, veterancyHpActive: e.promotion.veterancyHpActive };
        records.push({ turn: this.game!.turnNumber, promotion: e.promotion });
      }
      if (e.unitCast) {
        records.push({ turn: this.game!.turnNumber, castId: e.castId, unitCast: e.unitCast });
        if (this.game!.config?.abilities?.catalogue?.[e.unitCast.id]?.effect === 'sacrifice') removals.add(e.unitCast.uid);
      }
      if (e.abilityCast) records.push({ turn: this.game!.turnNumber, castId: e.castId, color: e.color, abilityCast: e.abilityCast });
      if (e.battlefieldActions) records.push({ turn: this.game!.turnNumber, color: e.color, battlefieldActions: e.battlefieldActions });
      if (e.extraUnit) records.push({ turn: this.game!.turnNumber, extraUnit: e.extraUnit });
      if (e.control) {
        const key = Object.keys(board).find(at => board[at].uid === e.control.uid);
        if (key) board[key] = { ...board[key], ...e.control };
        records.push({ turn: this.game!.turnNumber, control: e.control, at: e.at, controlSource: e.controlSource });
      }
      if (typeof e?.hp !== 'number') continue;
      if (e.unit?.uid) {
        const record = this.panelEffectRecord(e.unit, e.hp, e.panel);
        if (e.hp <= 0) { record.captured = e.unit.unit_id; record.color = e.unit.color === 'white' ? 'black' : 'white'; }
        if (e.at) record.attackedHex = e.at;
        records.push(record);
      } else if (e.at) {
        const key = (e.uid && Object.keys(board).find(k => board[k]?.uid === e.uid)) || e.at;
        const unit = board[key];
        if (this.landOnBoard(board, e.at, e.hp, e.uid, removals.has(e.uid)) && Math.trunc(e.hp) <= 0) {
          killed = true;
          records.push({ turn: this.game!.turnNumber, abilityDeath: { unit_id: unit.unit_id, color: unit.color, uid: unit.uid } });
        }
      }
    }
    return { records, killed };
  }

  /** Write a cast's HP onto a board unit, wherever it now stands. False if nothing changed. */
  private landOnBoard(board: Record<string, any>, at: string, hp: number, uid?: string, removal = false): boolean {
    // Where the unit actually stands. The client can walk a unit after a cast
    // has landed on it, and the walk arrives after this - so the hex the cast
    // names is where the client has it, not where this engine does. The uid
    // is what survives that; the hex is the fallback for a board without one.
    const key = (uid && Object.keys(board).find(k => board[k]?.uid === uid)) || at;
    const standing = board[key];
    if (!standing) return false;
    // Clamped at both ends. The room clamps too, but this is the copy that is
    // persisted and handed back, and it should not be able to hold an HP its
    // own config says is impossible whatever it was sent.
    const left = capStat(Math.min(standing.max_hp ?? Infinity, Math.trunc(hp)));
    if (!removal && left < standing.hp && carries(this.game?.abilityBuffs?.[standing.uid], 'invulnerable')) return false;
    if (left === standing.hp) return false;
    if (left <= 0) delete board[key];
    else board[key] = { ...standing, hp: left };
    return true;
  }

  /** What both panel blows do once the damage is worked out: end the turn. */
  private commitPanelBlow(record: any, board: any, before: any[] = [], after: any[] = []): void {
    const g = this.game!;
    this.overtimeToll(board);
    g.boardState = board;
    g.moveHistory = [...g.moveHistory, ...before, record, ...after];
    const historyLength = g.moveHistory.length;
    const ending = this.settleHandOver(this.defeatedSides(board));
    after.push(...g.moveHistory.slice(historyLength));
    this.emit({
      // Under `move`, like every other move_made: applyMoveMade reads that
      // key and nothing else. Spread flat, the record went out looking
      // complete and arrived as an `undefined` pushed onto the history.
      type: 'move_made',
      move: record,
      ...(before.length ? { effectsBefore: before } : {}),
      ...(after.length ? { effects: after } : {}),
      boardState: board,
      currentTurn: ending ? '' : g.currentTurn,
      turnNumber: g.turnNumber,
      turnStartedAt: g.turnStartedAt,
      phaseBank: g.phaseBank,
    });
    if (ending) this.over(ending.winner, ending.reason);
  }

  private move(
    from: string, to: string, attack?: string, moveBonus?: number,
    bonuses?: Partial<CombatBonuses>,
    withdraw?: boolean,
    /** The turn's casts after its board action, and before it - see `landEffects`. */
    effects?: any[],
    effectsBefore?: any[],
    /**
     * Whether another board move follows this one in the same turn. Overtime's
     * later stretches allow two and three, and only the last hands the seat
     * over - see `holding` below.
     */
    more?: boolean,
    heal?: string,
    afterAttackTo?: string,
    unitAction = false,
    effectsAfterAttack?: any[],
    pathMov = 0,
  ): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    // Before `landEffects`, which would otherwise write the cast onto the
    // board on its way to being refused.
    if (this.abilityFault(pathMov ? Number(moveBonus) - pathMov : moveBonus, bonuses, effects, effectsBefore, effectsAfterAttack)) {
      this.emit({ type: 'invalid_move', message: 'No ability fires while a side is setting out' });
      return;
    }

    if (heal && (attack || withdraw)) {
      this.emit({ type: 'invalid_move', message: 'Heal, attack or walk home: choose one' });
      return;
    }
    const start = { ...g.boardState };
    if (!this.unitCastOrderValid(effectsBefore) || !this.unitCastOrderValid([...(effectsAfterAttack ?? []), ...(effects ?? [])], attack || heal ? g.boardState[from]?.uid : undefined, heal ? g.boardState[from]?.uid : undefined)) {
      this.emit({ type: 'invalid_move', message: 'A unit ability must be used before its attack' }); return;
    }
    const before = this.landEffects(start, effectsBefore);
    const piece = start[from];
    const radius: number = g.config?.board?.radius ?? 11;
    const [q, r] = String(from).split(',').map(Number);
    const movingColor = this.colorOf(g.currentTurn);
    const extraUids = extraActionUids([...g.moveHistory, ...before.records], g.turnNumber, movingColor);
    const casting = unitAction && before.records.some(record => record.controlSource === piece?.uid);
    if (finishedUnitUids([...g.moveHistory, ...before.records], g.turnNumber, movingColor, g.config, 'battlefield').has(piece?.uid ?? '')) {
      this.emit({ type: 'invalid_move', message: 'That unit has already moved this turn' }); return;
    }

    const relocating = to !== from;
    // Steps lent by an ability, on top of the unit's own move stat.
    const bonus = extraSteps(moveBonus);
    // Ability boosts, the client's word for them - taken because solo play
    // has nobody to cheat. Whole numbers, and no ceiling: they were capped at
    // 10 steps and +/-20, which the config never said, so a Surge of 12 was
    // offered on the board and refused here as an illegal move.
    const stat = (v: unknown) => Math.trunc(Number(v) || 0);
    if (relocating && this.unitWalkEnded(piece?.uid, to, before.records)) {
      this.emit({ type: 'invalid_move', message: 'Movement ends after using a unit ability' }); return;
    }
    if (carries(g.abilityBuffs?.[piece?.uid ?? ''], 'action-lock')) {
      this.emit({ type: 'invalid_move', message: 'This unit cannot act this turn' }); return;
    }
    const atkUp = stat(bonuses?.atk), defUp = stat(bonuses?.def);
    const theirAtkUp = stat(bonuses?.targetAtk), theirDefUp = stat(bonuses?.targetDef);
    const budget = bonus
      ? capStat((unitStats(piece?.unit_id ?? '', g.config, activeVet(piece, undefined, g.config)).move ?? 0) + bonus)
      : undefined;
    // Walking off the board into a base. The panels are the client's own, so
    // the walk is not re-derived here - but it has to be a walk, off the
    // board, and nothing swings on the way out.
    const [tq, tr] = String(to).split(',').map(Number);
    // Each side's base sits on its own side of the board - white's at
    // negative q, black's at positive - the same convention the wrap tips are
    // built on. Coarse, but it is the difference between walking home and
    // walking into the enemy's back line to mend there.
    // ponytail: a real panel model in the engine replaces this with a lookup.
    const ownSide = movingColor === 'white' ? tq < 0 : tq > 0;
    // The king never walks home - the owner's rule. Off the board he counted
    // as no commander, so the walk lost the match on the spot.
    const king = !!g.config?.units?.[piece?.unit_id]?.commander;
    const leaving = !!withdraw && !afterAttackTo && relocating && !attack && !king
      && Number.isInteger(tq) && Number.isInteger(tr)
      && !isInsideBoard(tq, tr, radius) && !start[to] && ownSide;
    // Say which rule refused him, as the consumer does. Folded into the
    // general refusal below he came back "Illegal move", which sends the
    // player looking for a doorway that works - the exact outcome the server
    // spells the message out to avoid.
    if (withdraw && !afterAttackTo && king && piece?.color === movingColor) {
      this.emit({ type: 'invalid_move', message: 'The king never walks home' });
      return;
    }
    // The rest of the walk home: when, from where, and how many. Checked
    // before the general refusal for the same reason the king is - "Illegal
    // move" would send the player hunting for a doorway that works.
    if (withdraw && !afterAttackTo && piece?.color === movingColor) {
      // A phase's play shuts the base doorways; a setup turn opens them for
      // three units, and overtime opens them with no count at all - there a
      // walk home is an ordinary move that happens to end off the board, and
      // the turn's own move allowance is the only cap it needs.
      if (!isHomecomingOpen(g.turnNumber, this.game?.config)) {
        this.emit({ type: 'invalid_move', message: 'The way home is shut' });
        return;
      }
      // Only out of your own first three rows: a unit that has pushed up the
      // board walks back down into its own ground before it walks off it.
      // Where it STANDS, which this engine knows - not the route to the
      // doorway, which wants the panel model it has not got.
      if (!inHomeRows(movingColor, r, radius, this.game?.config)) {
        this.emit({ type: 'invalid_move', message: 'Only your own first three rows walk home' });
        return;
      }

    }
    if (!piece || piece.color !== movingColor || !Number.isInteger(q) || !Number.isInteger(r)
        || (withdraw && !afterAttackTo
            ? !leaving
            : (relocating
               && !computeLegalMoves(start, q, r, g.config, radius, budget).has(to)))
        || (!relocating && !attack && !heal && !casting)) {
      this.emit({ type: 'invalid_move', message: 'Illegal move' });
      return;
    }

    // The setup turns' rules. The board's click handler enforced these and
    // nothing else did, so a crafted message could attack on the first turn or
    // walk one unit up the board three turns running. Mirrors the block in
    // `_handle_make_move`; a boost changes how FAR a unit goes, never how many
    // times it goes, so none of this waits on the abilities settling.
    //
    // Two predicates, deliberately. Nobody attacks on any turn given to
    // setting out; the one-move-per-phase lock is the opening's alone, and
    // handing it to a single postmatch turn would stop a unit that had moved
    // in some earlier turn of a phase it has nothing to do with.
    if (!attacksAllowed(g.turnNumber, g.config)) {
      // Landing on an enemy is an attack too, by another road.
      if (attack
          || (relocating && start[to] && start[to].color !== movingColor)) {
        this.emit({ type: 'invalid_move', message: noAttackMessage(g.turnNumber, this.game?.config) });
        return;
      }
    }
    if (heal && !stageRules(g.turnNumber, g.config).normalHeal) {
      this.emit({ type: 'invalid_move', message: 'Healing is disabled in this stage' }); return;
    }
    if (isInitialization(g.turnNumber, this.game?.config)
        && openingMovedHexes(g.moveHistory, movingColor, this.game?.config).has(`${q},${r}`)) {
      this.emit({ type: 'invalid_move', message: 'That unit has had its move for the opening' });
      return;
    }

    // **How many board moves this side still has.** One everywhere the
    // schedule is running, two in Overtime 2 and three in Overtime 3. Counted
    // off the record rather than inferred from "has the turn ended", because
    // the moves arrive as separate messages and only the last ends it.
    //
    // A setup turn's walk home is not a board move and is checked above
    // against its own three; this guard sits below that block so the two
    // never both charge one walk.
    const normalAllowance = boardMovesPerTurn(g.turnNumber, this.game?.config) + battlefieldActionBonus([...g.moveHistory, ...before.records], g.turnNumber, movingColor);
    const moveAllowance = normalAllowance + extraUids.length;
    const movesUsed = boardMovesAt(g.moveHistory, g.turnNumber, movingColor, g.config);
    const extraUsed = g.moveHistory.filter((record: any) => record.turn === g.turnNumber && extraUids.includes(record.uid)).length;
    if (extraUids.length && !extraUids.includes(piece?.uid ?? '') && movesUsed - extraUsed >= normalAllowance) {
      this.emit({ type: 'invalid_move', message: 'Only the controlled unit has an extra action' }); return;
    }
    if (movesUsed >= moveAllowance && !boardMoveUids([...g.moveHistory, ...before.records], g.turnNumber, movingColor, g.config).has(piece?.uid ?? '')) {
      this.emit({
        type: 'invalid_move',
        message: `That side has had all ${moveAllowance} of its moves this turn`,
      });
      return;
    }
    // `more` is the caller saying "this is not my last". Honoured only while
    // another move is still to come: a `more` on the last of the allowance
    // ends the turn anyway, there being nothing left for it to hold the seat
    // open for. Mirrors `holding` in `_handle_make_move`.
    const holding = !!more;
    // The allowance counts moves; the owner's rule counts units. Without this
    // a side with three could play A, then B, then A again - each message
    // legal on its own, so the unit covered twice its MOV in one turn.
    if (boardMoveLandings(g.moveHistory, g.turnNumber, movingColor, this.game?.config).has(from)) {
      this.emit({ type: 'invalid_move', message: 'That unit has already moved this turn' });
      return;
    }

    const board = { ...start };
    if (relocating) {
      // A unit walking home leaves the board rather than landing on it: the
      // base it stops in is a panel, which no engine holds.
      if (!leaving) board[to] = piece;
      delete board[from];
    }

    const record: any = {
      from, to, unit_id: piece.unit_id, color: piece.color, turn: g.turnNumber,
      ...(piece.uid ? { uid: piece.uid } : {}),
      captured: null, attacked: false, damage_dealt: 0,
      defender_eliminated: false, moved: relocating,
      // The unit rides in the record: it is the only place it survives once
      // it is off the board, and what the base is rebuilt from on a reload.
      ...(leaving ? { withdrawn: true, unit: withdrawnUnit(g.config, piece, panelOfHex(to, g.config?.board?.orientation)),
        ...(sectionOf(g.config, 'economy').walkHomeRefund.resetVeterancy ? { veterancyReset: true } : {}),
        refund: withdrawalRefund(g.config, piece), refundColor: piece.owner ?? piece.color } : {}),
    };

    // Setup withdrawals hold the seat so the remaining category actions can commit before the final pass.
    if (leaving && isSetupTurn(g.turnNumber, this.game?.config) && !extraUids.includes(piece.uid ?? '')) {
      g.boardState = board;
      g.moveHistory = [...g.moveHistory, ...before.records, record, ...this.landEffects(board, effects).records];
      this.persist();
      this.emit({ type: 'game_state_update', ...this.snapshot() });
      return;
    }

    if (heal) {
      const target = board[heal];
      const parts = typeof heal === 'string' ? heal.split(',') : [];
      const [hq, hr] = parts.map(s => s.trim() ? Number(s) : NaN);
      const distance = typeof heal === 'string' ? hexDistanceKeys(to, heal) : NaN;
      const range = unitStats(piece.unit_id, g.config, activeVet(piece, undefined, g.config))?.heal?.length ?? 0;
      if (parts.length !== 2 || !Number.isInteger(hq) || !Number.isInteger(hr) || !isInsideBoard(hq, hr, radius)
          || !isInsideBoard(tq, tr, radius) || !target || target.color !== piece.color
          || heal === to || distance < 1 || distance > range) {
        this.emit({ type: 'invalid_move', message: 'Healing needs another friendly battlefield unit in range' });
        return;
      }
      const amount = healingAmount(piece.unit_id, target, distance, g.config, activeVet(piece, undefined, g.config), bonuses?.hel ?? 0, bonuses?.helSet);
      board[heal] = { ...target, hp: target.hp + amount };
      Object.assign(record, {
        healedHex: heal, healed_amount: amount, healed_hp: board[heal].hp, healed_unit: target.unit_id,
      });
    }
    if (attack) {
      if (unitStats(piece.unit_id, g.config, activeVet(piece, undefined, g.config))?.heal?.length) {
        this.emit({ type: 'invalid_move', message: 'This unit heals instead of attacking' });
        return;
      }
      const target = board[attack];
      if (!target || target.color === piece.color
          || !canAttack(attackStats(piece.unit_id, g.config, activeVet(piece, undefined, g.config), false, true, bonuses?.atkSet), hexDistanceKeys(to, attack), bonuses?.atkSet === undefined ? atkUp : 0)) {
        this.emit({ type: 'invalid_move', message: 'Nothing to attack there' });
        return;
      }
      const distance = hexDistanceKeys(to, attack);
      const exchange = combatExchange(piece, target, distance, g.config, {
        ...bonuses,
        atk: atkUp, def: defUp, targetAtk: theirAtkUp, targetDef: theirDefUp, charge: bonuses?.charge, nullify: bonuses?.nullify,
      });
      Object.assign(record, { attacked: true, attackedHex: attack,
        counterActor: { unit_id: target.unit_id, color: target.color, uid: target.uid }, damage_dealt: exchange.damage + exchange.secondDamage,
        counter_damage: exchange.counterDamage + exchange.secondCounterDamage, countered: exchange.countered, attacker_eliminated: exchange.attackerHp <= 0,
        defender_eliminated: exchange.targetHp <= 0,
        ...(exchange.leechHeal ? { leech_heal: exchange.leechHeal } : {}),
        ...(exchange.secondStrike ? { secondStrike: true } : {}),
      ...(exchange.secondCounter ? { secondCounter: true, second_counter_damage: exchange.secondCounterDamage } : {}),
      });
      if (exchange.targetHp <= 0) { record.captured = target.unit_id; delete board[attack]; }
      else { board[attack] = { ...target, hp: exchange.targetHp }; record.defender_hp = exchange.targetHp; }
      if (exchange.attackerHp <= 0) delete board[to]; else board[to] = { ...piece, hp: exchange.attackerHp };
    }

    const between = this.landEffects(board, effectsAfterAttack).records;
    if (afterAttackTo && !this.finishRapidMove(board, start, from, to, afterAttackTo, piece, budget, record)) return;

    // Not the turn's last move: hold the seat. The same shape as a setup
    // turn's walk home above, and the same reason the server has
    // `_commit_deployment` - the ply, the seat and the clock all stay put, and
    // the next message plays the next unit.
    //
    // **The toll is deliberately not taken here.** It is what the END of a
    // turn costs, and one per move would bleed a king three points on an
    // Overtime 3 turn - which is the stretch that allows three moves, so the
    // mistake would land exactly where it hurts most. Nor does the ply move,
    // so nothing else that counts turns double-counts either.
    if (holding) {
      g.boardState = board;
      g.moveHistory = [...g.moveHistory, ...before.records, record, ...between, ...this.landEffects(board, effects).records];
      this.persist();
      this.emit({ type: 'game_state_update', ...this.snapshot() });
      return;
    }

    const after = [...between, ...this.landEffects(board, effects).records];
    this.overtimeToll(board);
    g.boardState = board;
    g.moveHistory = [...g.moveHistory, ...before.records, record, ...after];
    // Whoever lost their commander loses, whichever side was moving - a
    // counter-attack can take the attacker's king on the attacker's own turn,
    // and can take both commanders at once, which is nobody's win.
    const historyLength = g.moveHistory.length;
    const ending = this.settleHandOver(this.defeatedSides(board));
    after.push(...g.moveHistory.slice(historyLength));
    // consumers.py sends `currentTurn: ''` on the move that ends a game -
    // naming the next player starts a clock and sounds a turn for a match
    // that is already over, in the moment before game_over lands.
    this.emit({
      type: 'move_made',
      move: record,
      // The turn's casts on either side of the board action, recorded there.
      ...(before.records.length ? { effectsBefore: before.records } : {}),
      ...(after.length ? { effects: after } : {}),
      boardState: g.boardState,
      currentTurn: ending ? '' : g.currentTurn,
      turnNumber: g.turnNumber,
      turnStartedAt: g.turnStartedAt,
      phaseBank: g.phaseBank,
    });
    if (ending) this.over(ending.winner, ending.reason);
  }

  /**
   * Hand the seat over and settle the match. **Every hand-over ends here** -
   * a move, a blow into a panel, a pass - once the turn has done everything
   * it does to `g.boardState`, the toll included, and `g.moveHistory` holds
   * its records. Mirrors `_settle_hand_over` in consumers.py.
   *
   * In order, each only if nothing before it ended the match:
   *
   * 1. **The board.** `beaten` is every side that has lost on it: both is a
   *    draw, one is the other's win by the objective.
   * 2. **The schedule.** The phase the hand-over closed banks
   *    (`bankEndedPhases`), and then a side past the other's margin once
   *    Phase 3 has banked and its postmatch is played wins on points, and a
   *    match still standing once turn 50 is played out is black's
   *    (`scheduleEnding`).
   * 3. **The turn limit**, `match.maxTurns`, checked against the turn just
   *    played - the server checks it before it counts the next one, and
   *    mirroring anything else leaves the two a ply apart.
   *
   * The order used to be written out in each of the three, and they had
   * drifted: a panel blow that felled both kings gave the match to black.
   *
   * Returns the ending, or `null` while the match goes on. The caller emits
   * its own message first - with `currentTurn: ''` on an ending - and then
   * hands the ending to `over`.
   */
  private finishRapidMove(board: BoardState, start: BoardState, from: string, at: string, to: string,
    unit: any, budget: number | undefined, record: any): boolean {
    const g = this.game!;
    const [q, r] = from.split(',').map(Number);
    const [aq, ar] = at.split(',').map(Number);
    const radius = g.config.board.radius;
    const total = budget ?? unitStats(unit.unit_id, g.config, activeVet(unit, undefined, g.config)).move ?? 0;
    const spent = at === from ? 0 : computeMoveCosts(start, q, r, g.config, radius, total).get(at);
    const [tq, tr] = String(to).split(',').map(Number);
    const leaving = Number.isInteger(tq) && Number.isInteger(tr) && !isInsideBoard(tq, tr, radius);
    const left = spent === undefined ? -1 : total - spent;
    // Panel routes are supplied by the board, as on an ordinary solo withdrawal.
    const reachable = leaving
      ? isHomecomingOpen(g.turnNumber, this.game?.config) && !g.config.units[unit.unit_id]?.commander
        && inHomeRows(unit.color, ar, radius, this.game?.config)
        && panelOfHex(to, g.config.board.orientation) === (unit.color === 'white' ? 'bl' : 'tr')
        && hexDistanceKeys(at, to) <= left && !board[to]
      : computeMoveCosts(board, aq, ar, g.config, radius, Math.max(0, left)).has(to);
    if (!record.attacked || !board[at] || unitPassive(unit.unit_id, g.config, activeVet(unit, undefined, g.config))?.effect !== 'rapid-movement'
        || spent === undefined || left < 0 || !reachable) {
      this.emit({ type: 'invalid_move', message: 'Rapid Movement needs remaining MOV after an attack' });
      return false;
    }
    if (leaving) {
      if (record.intoPanel) record.panelDefender = record.unit;
      Object.assign(record, { withdrawn: true, unit: withdrawnUnit(g.config, board[at], panelOfHex(to, g.config?.board?.orientation)),
        ...(sectionOf(g.config, 'economy').walkHomeRefund.resetVeterancy ? { veterancyReset: true } : {}),
        refund: withdrawalRefund(g.config, board[at]), refundColor: unit.owner ?? unit.color });
    } else board[to] = board[at];
    delete board[at];
    record.attackFrom = at;
    record.to = to;
    record.moved = true;
    return true;
  }

  private settleHandOver(beaten: string[]): { winner: string; reason: string } | null {
    const g = this.game!;
    g.moveHistory = [...g.moveHistory, ...regenerationHeals(
      g.config, g.boardState, g.moveHistory, g.turnNumber, this.colorOf(g.currentTurn))];
    const maxTurns: number = ruleOf(g.config, 'maxTurns');
    const outOfTurns = maxTurns > 0 && g.turnNumber >= maxTurns;
    g.turnNumber += 1;
    g.currentTurn = this.other(g.currentTurn);
    g.abilityBuffs = advanceBuffs(g.abilityBuffs ?? {}, this.colorOf(g.currentTurn), g.turnNumber);
    g.turnStartedAt = new Date().toISOString();
    this.rankBoard();
    g.moveHistory = [...g.moveHistory, ...promotionHeals(g.config, g.boardState, g.moveHistory, g.turnNumber),
      ...halftimeUpAwards(g.config, g.boardState, g.moveHistory, g.turnNumber)];
    g.phaseBank = bankEndedPhases(g.phaseBank, g.config, g.boardState, g.moveHistory, g.turnNumber);
    const controls = controlsAt(g.moveHistory, g.turnNumber);
    for (const [at, piece] of Object.entries(g.boardState)) g.boardState[at] = controlledUnit(piece, controls, g.turnNumber);
    this.persist();
    if (beaten.length === 2) return { winner: '', reason: 'draw_mutual' };
    if (beaten.length) {
      return { winner: this.seat(beaten[0] === 'white' ? 'black' : 'white'), reason: this.endReasonName() };
    }
    const schedule = scheduleEnding(g.phaseBank, g.turnNumber, this.game?.config);
    if (schedule) return { winner: schedule.winner ? this.seat(schedule.winner) : '', reason: schedule.reason };
    if (outOfTurns) return { winner: '', reason: 'draw_max_turns' };
    return null;
  }

  /** What the objective calls a decided game. Mirrors consumers.py. */
  private endReasonName(): string {
    return (ruleOf(this.game?.config, 'objective')) === 'regicide'
      ? 'regicide' : 'elimination';
  }

  /**
   * Overtime's toll, taken at the very end of a turn: the side that just
   * played loses HP off its commander.
   *
   * **Real damage, not a mark.** A king on the toll or less dies of it, which
   * is the owner's rule - and it is what eventually settles a deathmatch
   * neither side is winning on points. How much climbs 1, 3, 5 through
   * overtime's three stretches, so a match that will not end has its ending
   * brought forward rather than merely waited for. It lands after everything else the turn did, so a blow
   * struck this turn is resolved before the toll rather than after it, and a
   * king killed in the fight is already gone when this looks for one.
   *
   * Read off `currentTurn` rather than off the ply's parity: the side that
   * just played is known here for certain, and cannot drift from it.
   *
   * Returns the side it felled, if it felled one - which a pass needs, since
   * a pass has no other reason to look at whether anybody is beaten and must
   * not start doing so for a board that was already in that state.
   *
   * Not the browser engine's alone any more: `game_logic.overtime_toll` takes
   * the same toll on a move, a pass and the clock's pass, which is why the
   * board's mark is over HP that really moved in a networked room too. The
   * schedule is the fourth mirror that made possible, and `phases.py` carries
   * the warning about keeping it in step.
   */
  private overtimeToll(board: Record<string, any>): 'white' | 'black' | null {
    const g = this.game!;
    // Still the ply just played: it is bumped after this. How much it costs is
    // the ply's business - overtime runs in three stretches and the toll
    // climbs 1, 3, 5 through them - and `overtimeTollAt` answers 0 outside
    // overtime, so it is the "not yet" gate as well as the amount. A
    // `turnNumber < OVERTIME_FIRST_PLY` test beside it would be a second
    // place holding the schedule, and the two could come to disagree.
    const toll = overtimeTollAt(g.turnNumber, this.game?.config);
    if (!toll) return null;
    const color = this.colorOf(g.currentTurn);
    const config = g.config;
    const at = Object.keys(board).find(key => (board[key]?.owner ?? board[key]?.color) === color
      && config?.units?.[board[key].unit_id]?.commander);
    if (!at) return null;
    if (carries(g.abilityBuffs?.[board[at].uid], 'invulnerable')) return null;
    const hp = (board[at].hp ?? 0) - toll;
    if (hp > 0) {
      board[at] = { ...board[at], hp };
      return null;
    }
    delete board[at];
    return color as 'white' | 'black';
  }

  private defeatedSides(board: Record<string, any>): Array<'white' | 'black'> {
    const config = this.game?.config;
    const objective = ruleOf(config, 'objective');
    const cells = Object.values(board);
    const out: Array<'white' | 'black'> = [];
    for (const color of ['white', 'black'] as const) {
      const mine = cells.filter((c: any) => (c.owner ?? c.color) === color);
      if (!mine.length) out.push(color);
      else if (objective === 'regicide'
          && !mine.some((c: any) => config?.units?.[c.unit_id]?.commander)) {
        out.push(color);
      }
    }
    return out;
  }

  /** End the turn having done nothing - a unit turn is optional. */
  private pass(effectsBefore?: any[]): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    // A pass is the other way a cast reaches the engine, so it is the other
    // place the opening has to refuse one. Postmatch casts can arrive on
    // a pass or a move, while normal attacks remain forbidden.
    if (this.abilityFault(0, null, undefined, effectsBefore)) {
      this.emit({ type: 'invalid_move', message: 'No ability fires while a side is setting out' });
      return;
    }
    const passedBy = g.currentTurn;
    const color = this.colorOf(passedBy);
    // A passed turn is still a turn: overtime takes its toll on it, so the
    // board can change even though nobody moved. Hence the copy, and the
    // board on the message - `applyTurnPassed` takes one when there is one.
    const board = { ...g.boardState };
    // The turn's casts land first, so a king healed off 1 pays the toll from
    // the healed HP.
    if (!this.unitCastOrderValid(effectsBefore)) {
      this.emit({ type: 'invalid_move', message: 'A unit ability must be used before its attack' }); return;
    }
    const cast = this.landEffects(board, effectsBefore);
    // Casts and earlier held combat can also have removed a commander;
    // the closing pass must resolve them before scheduled endings.
    const felled = this.overtimeToll(board);
    const combatDeath = g.moveHistory.some(move => move.turn === g.turnNumber
      && (move.defender_eliminated || move.attacker_eliminated));
    // The felled side is judged by the objective, like every other ending -
    // and only that side, for the reason above. This used to be `[felled]`
    // outright, which under `elimination` called a king the toll killed a
    // defeat while his army still stood; `move` never did, and the server's
    // `_settle_pass` does not either. Under regicide it is the same answer.
    const beaten = cast.killed || combatDeath
      ? this.defeatedSides(board)
      : felled ? this.defeatedSides(board).filter(side => side === felled) : [];
    g.boardState = board;
    if (cast.records.length) g.moveHistory = [...g.moveHistory, ...cast.records];
    // A pass can be the hand-over that closes a phase, or turn 50.
    const historyLength = g.moveHistory.length;
    const ending = this.settleHandOver(beaten);
    const promotions = g.moveHistory.slice(historyLength);
    this.emit({
      type: 'turn_passed', passedBy, color, boardState: board,
      ...(cast.records.length ? { effectsBefore: cast.records } : {}),
      ...(promotions.length ? { effects: promotions } : {}),
      // As above: a pass that runs the turn limit out hands over to nobody.
      currentTurn: ending ? '' : g.currentTurn,
      turnNumber: g.turnNumber, turnStartedAt: g.turnStartedAt,
      phaseBank: g.phaseBank,
    });
    if (ending) this.over(ending.winner, ending.reason);
  }

  private over(winner: string, endReason: string, extra: any = {}): void {
    const g = this.game!;
    g.winner = winner;
    g.endReason = endReason;
    g.currentTurn = '';
    this.persist();
    this.emit({ type: 'game_over', winner, endReason, ...extra });
  }

  // -- Seats ----------------------------------------------------------

  /** Who holds a colour: the host took `hostColor`, the placeholder the rest. */
  private seat(color: 'white' | 'black'): string {
    const g = this.game!;
    return g.hostColor === color ? g.username : LOCAL_OPPONENT;
  }

  /**
   * The placeholder seat's name is reserved. Two seats sharing a name makes
   * other() hand back the player it was given, so the turn never changes
   * hands and the game sits on one side forever.
   */
  private seatName(username: string): string {
    const name = username ?? '';
    return name === LOCAL_OPPONENT ? `${name} (you)` : name;
  }

  private colorOf(username: string): 'white' | 'black' {
    return username === this.seat('white') ? 'white' : 'black';
  }

  private other(username: string): string {
    const g = this.game!;
    return username === g.username ? LOCAL_OPPONENT : g.username;
  }

  private rename(username: string): void {
    const g = this.game!;
    const name = this.seatName(username);
    if (!name || name === g.username) return;
    const old = g.username;
    g.username = name;
    // The seat name, not the raw one: a player calling themselves "Opponent"
    // would otherwise write the placeholder's own name into currentTurn, and
    // every one of their moves comes back illegal.
    if (g.currentTurn === old) g.currentTurn = name;
    if (g.winner === old) g.winner = name;
    this.persist();
  }

  // -- Plumbing -------------------------------------------------------

  private snapshot(): any {
    const g = this.game!;
    g.boardState = Object.fromEntries(Object.entries(g.boardState).map(([at, unit]) => [at, capUnit(unit)]));
    return {
      gameId: LOCAL_GAME_ID,
      opponentKind: g.opponentKind ?? 'myself', cpuDifficulty: g.cpuDifficulty ?? 'normal',
      boardState: g.boardState,
      currentTurn: g.currentTurn,
      turnNumber: g.turnNumber,
      playerWhite: this.seat('white'),
      playerBlack: this.seat('black'),
      moveHistory: g.moveHistory,
      config: g.config,
      winner: g.winner,
      endReason: g.endReason,
      turnStartedAt: g.turnStartedAt,
      drawOfferedBy: '',
      phaseBank: g.phaseBank ?? {},
      replayJournal: g.replayJournal ?? null,
    };
  }

  private emitPlayerList(): void {
    const g = this.game!;
    this.emit({
      type: 'player_list',
      singlePlayer: true,
      isInviter: true,
      players: [
        // Readiness is meaningless solo - the room shows a colour toggle instead.
        { username: g.username, isReady: false, isInviter: true, status: 'in-game' },
        { username: LOCAL_OPPONENT, isReady: false, isInviter: false, status: 'in-game' },
      ],
    });
  }

  /**
   * Delivered after the current stack, like real socket traffic, so a sender
   * never sees its own reply mid-call. A microtask rather than a timer:
   * background tabs throttle timers to about one a minute, which would stall
   * an offline game the moment the tab lost focus.
   */
  private emit(msg: any): void {
    if (msg.type === 'invalid_move' || msg.type === 'error') this.rejected = true;
    queueMicrotask(() => this.outgoing.next(msg));
  }

  private rankBoard(): void {
    const g = this.game;
    if (!g) return;
    const radius = g.config?.board?.radius ?? 11;
    const orientation = g.config?.board?.orientation ?? 'edge-up';
    for (const [at, unit] of Object.entries(g.boardState)) {
      if (!unit) continue;
      const vet = unitVeterancy(unit.uid ?? `${unit.color[0]}${at}`, at,
        g.moveHistory, g.turnNumber, radius, orientation, this.game?.config);
      g.boardState[at] = rankedUnit(unit, g.config, vet);
    }
  }

  private persist(): void {
    this.rankBoard();
    if (this.replayMode) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.game));
    } catch { /* storage full or blocked - the game just won't survive a reload */ }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.game = raw ? JSON.parse(raw) : null;
      if (this.game?.config) this.game.config = migrateConfig(this.game.config);
      if (this.game) this.game.boardState = Object.fromEntries(Object.entries(this.game.boardState)
        .map(([at, unit]) => [at, capUnit(unit)]));
      if (this.game?.turnCheckpoints !== undefined) {
        const g = this.game;
        g.turnCheckpoints = Array.isArray(g.turnCheckpoints) ? g.turnCheckpoints.filter(checkpoint =>
          Number.isSafeInteger(checkpoint?.turnNumber) && checkpoint.turnNumber > 0 && checkpoint.turnNumber <= g.turnNumber
          && Number.isSafeInteger(checkpoint.historyLength) && checkpoint.historyLength >= 0 && checkpoint.historyLength <= g.moveHistory.length
          && checkpoint.boardState && typeof checkpoint.boardState === 'object' && !Array.isArray(checkpoint.boardState)
          && checkpoint.uiState && typeof checkpoint.uiState === 'object') : [];
      }
      this.rankBoard();
    } catch {
      this.game = null;
    }
  }
}
