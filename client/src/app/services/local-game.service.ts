import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { ConfigService } from './config.service';
import { computeLegalMoves, hexDistanceKeys, isInsideBoard, strikeDamage } from './hex-rules';
import { OVERTIME_FIRST_PLY } from './phases';

/**
 * What overtime costs a commander at the end of each of its side's turns.
 * ponytail: the owner's number - one. A constant because that is all it is.
 */
const OVERTIME_TOLL = 1;

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
 * and losing your commander. Anything the engine learns has to land here too,
 * or offline play quietly diverges from online play.
 */

const STORAGE_KEY = 'cpp.localGame.v1';
/** Matches SINGLE_PLAYER_OPPONENT in server/game/consumers.py. */
export const LOCAL_OPPONENT = 'Opponent';
/** Stands in for the room UUID; there is no room to address. */
export const LOCAL_GAME_ID = 'local';

interface LocalGame {
  username: string;
  hostColor: 'white' | 'black';
  started: boolean;
  boardState: Record<string, any>;
  currentTurn: string;
  turnNumber: number;
  moveHistory: any[];
  winner: string;
  endReason: string;
  config: any;
  turnStartedAt: string;
  mode: string;
  options: any;
}

@Injectable({ providedIn: 'root' })
export class LocalGameService {
  private outgoing = new Subject<any>();
  /** Replies, in place of socket traffic. */
  readonly messages$ = this.outgoing.asObservable();

  private game: LocalGame | null = null;

  constructor(private configService: ConfigService) {
    this.restore();
  }

  /** Drop the cached game (a deliberate exit, not a disconnect). */
  clear(): void {
    this.game = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  }

  hasSavedGame(): boolean {
    return !!this.game;
  }

  // -- Protocol -------------------------------------------------------

  /** Handle one client message exactly as the server would for a solo room. */
  send(msg: any): void {
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
        this.start(msg.hostColor === 'black' ? 'black' : 'white', msg.turnTimeLimit);
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
        this.move(msg.from, msg.to, msg.attack, msg.moveBonus, msg.bonuses, msg.withdraw);
        break;

      case 'enter_board':
        this.enter(msg.from, msg.to, msg.unit);
        break;

      case 'panel_attack':
        this.attackIntoPanel(
          msg.from, msg.to ?? msg.from, msg.attack, msg.unit,
          msg.moveBonus, msg.counters !== false, msg.bonuses);
        break;

      case 'pass_turn':
        this.pass();
        break;

      case 'resign':
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
    };
  }

  private start(hostColor: 'white' | 'black', turnTimeLimit?: number): void {
    const username = this.game?.username ?? '';
    const config = JSON.parse(JSON.stringify(this.configService.getConfig()));
    const selectedTime = Number.isInteger(turnTimeLimit) ? turnTimeLimit : this.game?.options?.turnTimeLimit;
    if (Number.isInteger(selectedTime)) {
      config.rules = { ...(config.rules ?? {}), turnTimeLimit: selectedTime };
    }
    this.game = {
      ...this.blank(username),
      hostColor,
      started: true,
      config,
      boardState: this.buildBoard(config),
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
        const hp: number = config?.units?.[unitId as string]?.hp ?? 1;
        // uid mirrors build_initial_board: identity that survives moves.
        board[`${q},${r}`] = {
          unit_id: unitId, color, hp, max_hp: hp, uid: `${color[0]}${q},${r}`,
        };
      }
    }
    return board;
  }

  /**
   * Walk a unit in from a panel. Deployment rather than the turn's action -
   * several may come through in a turn - so unlike a move this hands the turn
   * to nobody and counts no ply.
   *
   * The unit arrives with the message: the panels are the client's own and no
   * engine holds them, so there is nothing here to look it up in. Taken on
   * trust for the same reason a boost is - this engine has nobody to cheat -
   * after checking it lands somewhere real and empty.
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
    bonuses?: { atk?: number; def?: number; targetAtk?: number; targetDef?: number },
  ): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    const attacker = g.boardState[from];
    const movingColor = this.colorOf(g.currentTurn);
    if (!attacker || attacker.color !== movingColor || !unit || unit.color === movingColor) {
      this.emit({ type: 'invalid_move', message: 'Nothing to attack there' });
      return;
    }
    // The walk comes with the swing - this message is the whole turn - so it
    // is re-derived here exactly as `move` does, and applied before anything
    // is measured. Range is read from where the unit ENDS UP, not where it
    // set off from.
    const radius: number = g.config?.board?.radius ?? 11;
    const [q, r] = String(from).split(',').map(Number);
    const bonus = Math.max(0, Math.min(10, Number(moveBonus) || 0));
    const budget = bonus
      ? (g.config?.units?.[attacker.unit_id]?.move ?? 0) + bonus
      : undefined;
    const walked = to !== from;
    if (walked
        && !computeLegalMoves(g.boardState, q, r, g.config, radius, budget).has(to)) {
      this.emit({ type: 'invalid_move', message: 'Illegal move' });
      return;
    }

    const board = { ...g.boardState };
    if (walked) {
      board[to] = attacker;
      delete board[from];
    }

    const distance = hexDistanceKeys(to, attack);
    const range = g.config?.units?.[attacker.unit_id]?.attackRange ?? 1;
    if (distance > range) {
      this.emit({ type: 'invalid_move', message: 'Out of range' });
      return;
    }

    const dealt = strikeDamage(
      attacker.unit_id, unit.unit_id, distance, g.config,
      bonuses?.atk ?? 0, bonuses?.targetDef ?? 0);
    const left = Math.max(0, (unit.hp ?? 0) - dealt);
    const record: any = {
      from, to, unit_id: attacker.unit_id, color: attacker.color, turn: g.turnNumber,
      captured: null, attacked: true, attackedHex: attack, damage_dealt: dealt,
      defender_eliminated: false, moved: walked, counter_damage: 0,
      attacker_eliminated: false,
      // The panel end of the blow, and what it has left: the record is the
      // only place a panel unit's HP survives.
      panelAttack: true, intoPanel: true, unit, defenderHp: left,
    };

    if (left <= 0) {
      record.defender_eliminated = true;
      record.captured = unit.unit_id;
    } else {
      // Whether it answers at all is the panel's rule, and the client owns
      // panels - this engine has no idea which one a unit is standing in. A
      // reserve strikes back; a base never does.
      const theirRange = g.config?.units?.[unit.unit_id]?.attackRange ?? 1;
      if (counters && distance <= theirRange) {
        const counter = strikeDamage(
          unit.unit_id, attacker.unit_id, distance, g.config,
          bonuses?.targetAtk ?? 0, bonuses?.def ?? 0);
        record.counter_damage = counter;
        // Onto where it stands now, not where it set off from.
        const mine = { ...attacker, hp: attacker.hp - counter };
        if (mine.hp <= 0) {
          record.attacker_eliminated = true;
          delete board[to];
        } else {
          board[to] = mine;
        }
      }
    }
    this.commitPanelBlow(record, board);
  }

  /** What both panel blows do once the damage is worked out: end the turn. */
  private commitPanelBlow(record: any, board: any): void {
    const g = this.game!;
    this.overtimeToll(board);
    g.boardState = board;
    g.moveHistory = [...g.moveHistory, record];
    const defeated = this.defeatedSides(board);
    const maxTurns: number = g.config?.rules?.maxTurns ?? 0;
    const outOfTurns = maxTurns > 0 && g.turnNumber >= maxTurns;
    g.turnNumber += 1;
    g.currentTurn = this.other(g.currentTurn);
    g.turnStartedAt = new Date().toISOString();
    this.persist();
    const ending = defeated.length > 0 || outOfTurns;
    this.emit({
      // Under `move`, like every other move_made: applyMoveMade reads that
      // key and nothing else. Spread flat, the record went out looking
      // complete and arrived as an `undefined` pushed onto the history.
      type: 'move_made',
      move: record,
      boardState: board,
      currentTurn: ending ? '' : g.currentTurn,
      turnNumber: g.turnNumber,
      turnStartedAt: g.turnStartedAt,
    });
    if (defeated.length) {
      this.over(this.seat(defeated[0] === 'white' ? 'black' : 'white'), this.endReasonName());
    } else if (outOfTurns) {
      this.over('', 'draw_max_turns');
    }
  }

  private move(
    from: string, to: string, attack?: string, moveBonus?: number,
    bonuses?: { atk?: number; def?: number; targetAtk?: number; targetDef?: number },
    withdraw?: boolean,
  ): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;

    const piece = g.boardState[from];
    const radius: number = g.config?.board?.radius ?? 11;
    const [q, r] = String(from).split(',').map(Number);
    const movingColor = this.colorOf(g.currentTurn);

    const relocating = to !== from;
    // Steps lent by a one-turn ability, on top of the unit's own move stat.
    const bonus = Math.max(0, Math.min(10, Number(moveBonus) || 0));
    // One-turn ability boosts, the client's word for them - taken because
    // solo play has nobody to cheat. Clamped like the move bonus above.
    const stat = (v: unknown) => Math.max(-20, Math.min(20, Number(v) || 0));
    const atkUp = stat(bonuses?.atk), defUp = stat(bonuses?.def);
    const theirAtkUp = stat(bonuses?.targetAtk), theirDefUp = stat(bonuses?.targetDef);
    const budget = bonus
      ? (g.config?.units?.[piece?.unit_id]?.move ?? 0) + bonus
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
    const leaving = !!withdraw && relocating && !attack
      && Number.isInteger(tq) && Number.isInteger(tr)
      && !isInsideBoard(tq, tr, radius) && !g.boardState[to] && ownSide;
    if (!piece || piece.color !== movingColor || !Number.isInteger(q) || !Number.isInteger(r)
        || (withdraw
            ? !leaving
            : (relocating
               && !computeLegalMoves(g.boardState, q, r, g.config, radius, budget).has(to)))
        || (!relocating && !attack)) {
      this.emit({ type: 'invalid_move', message: 'Illegal move' });
      return;
    }

    const board = { ...g.boardState };
    if (relocating) {
      // A unit walking home leaves the board rather than landing on it: the
      // base it stops in is a panel, which no engine holds.
      if (!leaving) board[to] = piece;
      delete board[from];
    }

    const record: any = {
      from, to, unit_id: piece.unit_id, color: piece.color, turn: g.turnNumber,
      captured: null, attacked: false, damage_dealt: 0,
      defender_eliminated: false, moved: relocating,
      // The unit rides in the record: it is the only place it survives once
      // it is off the board, and what the base is rebuilt from on a reload.
      ...(leaving ? { withdrawn: true, unit: piece } : {}),
    };

    if (attack) {
      const target = board[attack];
      const range = g.config?.units?.[piece.unit_id]?.attackRange ?? 1;
      if (!target || target.color === piece.color || hexDistanceKeys(to, attack) > range) {
        this.emit({ type: 'invalid_move', message: 'Nothing to attack there' });
        return;
      }
      const distance = hexDistanceKeys(to, attack);
      const dealt = strikeDamage(
        piece.unit_id, target.unit_id, distance, g.config, atkUp, theirDefUp);
      const hurt = { ...target, hp: target.hp - dealt };
      record.attacked = true;
      record.attackedHex = attack;
      record.damage_dealt = dealt;
      record.counter_damage = 0;
      record.attacker_eliminated = false;

      if (hurt.hp <= 0) {
        record.defender_eliminated = true;
        record.captured = target.unit_id;
        delete board[attack];
      } else {
        board[attack] = hurt;
        record.defender_hp = hurt.hp;
        // The survivor answers, if we are inside its own reach.
        const theirRange = g.config?.units?.[target.unit_id]?.attackRange ?? 1;
        if (distance <= theirRange) {
          const counter = strikeDamage(
            target.unit_id, piece.unit_id, distance, g.config, theirAtkUp, defUp);
          record.counter_damage = counter;
          const mine = { ...board[to], hp: board[to].hp - counter };
          if (mine.hp <= 0) {
            record.attacker_eliminated = true;
            delete board[to];
          } else {
            board[to] = mine;
          }
        }
      }
    }

    this.overtimeToll(board);
    g.boardState = board;
    g.moveHistory = [...g.moveHistory, record];
    const defeated = this.defeatedSides(board);
    // The server checks the turn limit against the turn just played, before
    // it counts the next one - mirror that or the two disagree by a ply.
    const maxTurns: number = g.config?.rules?.maxTurns ?? 0;
    const outOfTurns = maxTurns > 0 && g.turnNumber >= maxTurns;
    g.turnNumber += 1;
    g.currentTurn = this.other(g.currentTurn);
    g.turnStartedAt = new Date().toISOString();
    this.persist();
    // consumers.py sends `currentTurn: ''` on the move that ends a game -
    // naming the next player starts a clock and sounds a turn for a match
    // that is already over, in the moment before game_over lands.
    const ending = defeated.length > 0 || outOfTurns;
    this.emit({
      type: 'move_made',
      move: record,
      boardState: g.boardState,
      currentTurn: ending ? '' : g.currentTurn,
      turnNumber: g.turnNumber,
      turnStartedAt: g.turnStartedAt,
    });

    // Whoever lost their commander loses, whichever side was moving - a
    // counter-attack can take the attacker's king on the attacker's own turn,
    // and can take both commanders at once, which is nobody's win.
    if (defeated.length === 2) {
      this.over('', 'draw_mutual');
    } else if (defeated.length) {
      this.over(this.seat(defeated[0] === 'white' ? 'black' : 'white'), this.endReasonName());
    } else if (outOfTurns) {
      this.over('', 'draw_max_turns');
    }
  }

  /** What the objective calls a decided game. Mirrors consumers.py. */
  private endReasonName(): string {
    return (this.game?.config?.rules?.objective ?? 'regicide') === 'regicide'
      ? 'regicide' : 'elimination';
  }

  /**
   * Every colour that has lost. Mirrors defeated_sides() in game_logic.py: no
   * commander under `regicide`, no units at all otherwise. Both can fall in
   * one exchange, and that is a draw rather than a win for the survivor of a
   * list order.
   */
  /**
   * Overtime's toll, taken at the very end of a turn: the side that just
   * played loses an HP off its commander.
   *
   * **Real damage, not a mark.** A king on 1 dies of it, which is the owner's
   * rule - and it is what eventually settles a deathmatch neither side is
   * winning on points. It lands after everything else the turn did, so a blow
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
   * ponytail: the browser engine's alone. The schedule that says where
   * overtime starts lives in `phases.ts`, and porting it to Python would make
   * a fourth thing to keep in step - see the config mirror this repo already
   * carries. A networked game takes no toll.
   */
  private overtimeToll(board: Record<string, any>): 'white' | 'black' | null {
    const g = this.game!;
    // Still the ply just played: it is bumped after this.
    if (g.turnNumber < OVERTIME_FIRST_PLY) return null;
    const color = this.colorOf(g.currentTurn);
    const config = g.config;
    const at = Object.keys(board).find(key => board[key]?.color === color
      && config?.units?.[board[key].unit_id]?.commander);
    if (!at) return null;
    const hp = (board[at].hp ?? 0) - OVERTIME_TOLL;
    if (hp > 0) {
      board[at] = { ...board[at], hp };
      return null;
    }
    delete board[at];
    return color as 'white' | 'black';
  }

  private defeatedSides(board: Record<string, any>): Array<'white' | 'black'> {
    const config = this.game?.config;
    const objective = config?.rules?.objective ?? 'regicide';
    const cells = Object.values(board);
    const out: Array<'white' | 'black'> = [];
    for (const color of ['white', 'black'] as const) {
      const mine = cells.filter((c: any) => c.color === color);
      if (!mine.length) out.push(color);
      else if (objective === 'regicide'
          && !mine.some((c: any) => config?.units?.[c.unit_id]?.commander)) {
        out.push(color);
      }
    }
    return out;
  }

  /** End the turn having done nothing - a unit turn is optional. */
  private pass(): void {
    const g = this.game;
    if (!g || !g.started || g.endReason) return;
    const passedBy = g.currentTurn;
    const color = this.colorOf(passedBy);
    // A passed turn is still a turn: overtime takes its toll on it, so the
    // board can change even though nobody moved. Hence the copy, and the
    // board on the message - `applyTurnPassed` takes one when there is one.
    const board = { ...g.boardState };
    // Only a king the toll itself felled ends the game here. A pass has never
    // looked at who is beaten, and must not start: the board it was handed
    // may already have been in that state for reasons of its own.
    const felled = this.overtimeToll(board);
    g.boardState = board;
    const maxTurns: number = g.config?.rules?.maxTurns ?? 0;
    const outOfTurns = maxTurns > 0 && g.turnNumber >= maxTurns;
    g.turnNumber += 1;
    g.currentTurn = this.other(passedBy);
    g.turnStartedAt = new Date().toISOString();
    this.persist();
    const ending = !!felled || outOfTurns;
    this.emit({
      type: 'turn_passed', passedBy, color, boardState: board,
      // As above: a pass that runs the turn limit out hands over to nobody.
      currentTurn: ending ? '' : g.currentTurn,
      turnNumber: g.turnNumber, turnStartedAt: g.turnStartedAt,
    });
    if (felled) {
      this.over(this.seat(felled === 'white' ? 'black' : 'white'), this.endReasonName());
    } else if (outOfTurns) {
      this.over('', 'draw_max_turns');
    }
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
    return {
      gameId: LOCAL_GAME_ID,
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
    queueMicrotask(() => this.outgoing.next(msg));
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.game));
    } catch { /* storage full or blocked - the game just won't survive a reload */ }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.game = raw ? JSON.parse(raw) : null;
    } catch {
      this.game = null;
    }
  }
}
