import { TestBed } from '@angular/core/testing';
import { LocalGameService, LOCAL_OPPONENT } from './local-game.service';

/**
 * The offline engine is the only thing standing between the player and the
 * rules when there is no server, so it gets a check: seats, a legal move, an
 * illegal one, and that the game survives being reloaded from cache.
 */
describe('LocalGameService', () => {
  let service: LocalGameService;
  let replies: any[];

  /** Replies are delivered on a macrotask, like socket traffic. */
  const flush = async () => { await new Promise(r => setTimeout(r, 0)); };

  beforeEach(async () => {
    localStorage.removeItem('cpp.localGame.v1');
    TestBed.configureTestingModule({});
    service = TestBed.inject(LocalGameService);
    replies = [];
    service.messages$.subscribe(m => replies.push(m));
    service.send({ type: 'create_single_player_game', username: 'Solo' });
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
  });

  const last = (type: string) => [...replies].reverse().find(m => m.type === type);

  // The stock unit these tests push about is the pawn on -5,9. The two hexes
  // it has been on before, -9,9 and -7,9, have each in turn been dealt an
  // archer; -5,9 is a pawn on the setup as it stands.

  it('starts a game with both setups placed and white to move', () => {
    const started = last('game_started');
    expect(started.playerWhite).toBe('Solo');
    expect(started.playerBlack).toBe(LOCAL_OPPONENT);
    expect(started.currentTurn).toBe('Solo');
    expect(Object.keys(started.boardState).length).toBe(48);   // 24 a side
  });

  it('puts a finished room back to waiting, keeping its settings', async () => {
    service.send({ type: 'change_game_mode', mode: 'default', options: { turnTimeLimit: 30 } });
    service.send({ type: 'resign' });
    await flush();
    expect(last('game_over')).toBeDefined();

    service.send({ type: 'reset_game' });
    await flush();
    expect(last('game_reset')).toBeDefined();

    // Waiting again, with an empty board - and the host's settings survive,
    // because the point of the stop is to change them if you want to.
    service.send({ type: 'join_game_room', username: 'Solo' });
    await flush();
    expect(last('join_game_room_success').gameStatus).toBe('waiting');
    service.send({ type: 'request_game_state' });
    await flush();
    expect(Object.keys(last('game_state_update').boardState).length).toBe(0);

    // And it deals again from there.
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
    expect(Object.keys(last('game_started').boardState).length).toBe(48);
  });

  it('lands a blow in a panel, and the panel answers', async () => {
    // The defender is not on this board - panels are the client's - so it
    // rides in with the message and its remaining HP comes back on the
    // record. `from` is a real board hex: the attacker IS on the board.
    const started = last('game_started');
    const attacker = '-5,9';
    expect(started.boardState[attacker].unit_id).toBe('pawn');

    const home = { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'rtr0' };
    service.send({
      type: 'panel_attack', intoPanel: true,
      from: attacker, attack: '-5,8', unit: home,
    });
    await flush();
    const msg = last('move_made');
    const hit = msg.move;
    expect(hit.panelAttack).toBeTrue();
    expect(hit.intoPanel).toBeTrue();
    service.send({ type: 'request_game_state' });
    await flush();
    expect(last('game_state_update').moveHistory.slice(-1)[0]).toEqual(hit);
    expect(hit.damage_dealt).toBeGreaterThan(0);
    // The panel unit's wound is on the record, not on the board.
    expect(hit.defenderHp).toBeLessThan(40);
    expect(msg.boardState['-5,8']).toBeUndefined();
    // It answers, and the answer lands on the attacker where it stands - a
    // base unit never starts a fight but always finishes its part of one.
    expect(hit.counter_damage).toBeGreaterThan(0);
    expect(msg.boardState[attacker].hp).toBeLessThan(started.boardState[attacker].hp);
    expect(msg.turnNumber).toBe(started.turnNumber + 1);

    // Out of range is refused rather than resolved.
    service.send({
      type: 'panel_attack', intoPanel: true,
      from: attacker, attack: '9,-9', unit: home,
    });
    await flush();
    expect(last('invalid_move')).toBeDefined();
  });

  it('takes no answer from a base, which is struck and says nothing', async () => {
    // Whether a panel answers is the panel's own rule and travels with the
    // message - the client owns panels, this engine has no idea which one a
    // unit is standing in. A reserve strikes back; a base never does.
    const attacker = '-4,9';
    const home = { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'rbl0' };
    const struck = () => last('move_made').move;

    service.send({
      type: 'panel_attack', intoPanel: true, counters: false,
      from: attacker, attack: '-4,8', unit: home,
    });
    await flush();
    expect(struck().damage_dealt).toBeGreaterThan(0);
    expect(struck().counter_damage).toBe(0);
    // Untouched where it stands: nothing answered it.
    expect(last('move_made').boardState[attacker].hp)
      .toBe(last('game_started').boardState[attacker].hp);
  });

  it('walks the attacker before it swings into a panel, and leaves it there', async () => {
    // The blow into a panel is the WHOLE turn - no make_move follows it - so
    // the walk rides with it. Sent without `to`, the engine resolved from
    // where the unit set off and left it there, which read as the unit being
    // teleported back to where it had moved from.
    const started = last('game_started');
    const from = '-5,9', to = '-5,8';
    expect(started.boardState[from].unit_id).toBe('pawn');
    expect(started.boardState[to]).toBeUndefined();

    const home = { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'rtr0' };
    service.send({
      type: 'panel_attack', intoPanel: true,
      from, to, attack: '-5,7', unit: home,
    });
    await flush();
    const msg = last('move_made');
    // It stands where it walked to, not where it started.
    expect(msg.boardState[from]).toBeUndefined();
    expect(msg.boardState[to]).toBeDefined();
    expect(msg.move.moved).toBeTrue();
    expect(msg.move.to).toBe(to);
    // And the range was measured from there: -5,7 is one step from `to` and
    // two from `from`, which a pawn could not reach.
    expect(msg.move.damage_dealt).toBeGreaterThan(0);

    // A walk the rules would refuse is refused here too, not taken on trust.
    // Black's turn now, so the attacker has to be one of black's.
    const theirs = { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'rbl0' };
    service.send({
      type: 'panel_attack', intoPanel: true,
      from: '0,-9', to: '0,5', attack: '0,6', unit: theirs,
    });
    await flush();
    expect(last('invalid_move').message).toBe('Illegal move');
  });

  it('applies a legal move and hands the turn over', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();
    const move = last('move_made');
    expect(move.boardState['-5,8'].unit_id).toBe('pawn');
    expect(move.boardState['-5,9']).toBeUndefined();
    expect(move.currentTurn).toBe(LOCAL_OPPONENT);
    expect(move.turnNumber).toBe(2);
  });

  it('rejects moving the other side and moving out of range', async () => {
    service.send({ type: 'make_move', from: '3,-10', to: '3,-9' }); // black, not their turn
    service.send({ type: 'make_move', from: '-7,10', to: '0,0' }); // far out of range
    await flush();
    expect(replies.filter(m => m.type === 'invalid_move').length).toBe(2);
    expect(last('move_made')).toBeUndefined();
  });

  it('walks reserves in without ending the turn', async () => {
    const started = last('game_started');
    // The panels are the client's own, so each unit arrives with its message
    // - there is nothing at `from` for the engine to pick up.
    const free = ['2,9', '3,8', '1,9', '0,9'].filter(k => !started.boardState[k]).slice(0, 2);
    expect(free.length).toBe(2);
    const unit = (i: number) =>
      ({ unit_id: 'pawn', color: 'white', hp: 10, max_hp: 10, uid: `rbr${i}` });

    service.send({ type: 'enter_board', from: '3,9', to: free[0], unit: unit(0) });
    service.send({ type: 'enter_board', from: '2,10', to: free[1], unit: unit(1) });
    await flush();

    const state = last('game_state_update');
    expect(state.boardState[free[0]].uid).toBe('rbr0');
    expect(state.boardState[free[1]].uid).toBe('rbr1');
    // Deployment, not the turn's action: more than one comes through, and the
    // turn is still ours afterwards.
    expect(state.currentTurn).toBe('Solo');
    expect(state.turnNumber).toBe(1);
  });

  it('refuses an entry onto an occupied hex or off the board', async () => {
    const started = last('game_started');
    const taken = Object.keys(started.boardState)[0];
    const unit = { unit_id: 'pawn', color: 'white', hp: 10, max_hp: 10, uid: 'rbr9' };

    service.send({ type: 'enter_board', from: '3,9', to: taken, unit });
    service.send({ type: 'enter_board', from: '3,9', to: '40,0', unit });
    await flush();

    expect(replies.filter(m => m.type === 'invalid_move').length).toBe(2);
  });

  it('walks a unit home into its own base, and nowhere else', async () => {
    // The enemy's base is off the board and empty too, so nothing but the
    // side check stands between a withdrawal and mending in their back line.
    service.send({ type: 'make_move', from: '-5,9', to: '12,-11', withdraw: true });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();

    // Its own base, which is the point mirror of that, is allowed.
    service.send({ type: 'make_move', from: '-5,9', to: '-12,11', withdraw: true });
    await flush();
    const move = last('move_made');
    expect(move.boardState['-5,9']).toBeUndefined();
    // It leaves the board entirely rather than landing on a hex of it.
    expect(move.boardState['-12,11']).toBeUndefined();

    service.send({ type: 'request_game_state' });
    await flush();
    const history = last('game_state_update').moveHistory;
    const record = history[history.length - 1];
    expect(record.withdrawn).toBeTrue();
    // The unit rides in the record - it is the only place it survives.
    expect(record.unit.unit_id).toBe('pawn');
  });

  it('resumes the cached game after a reload', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();

    const reloaded = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    reloaded.messages$.subscribe(m => seen.push(m));
    reloaded.send({ type: 'join_game_room', username: 'Solo' });
    reloaded.send({ type: 'request_game_state' });
    await flush();

    expect(seen.find(m => m.type === 'join_game_room_success').gameStatus).toBe('started');
    const state = seen.find(m => m.type === 'game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('refuses an attack on a unit that is nowhere near', async () => {
    // The two setups start opposite ends of a radius-11 board.
    service.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '9,-9' });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();
  });

  it('keeps the seat name when the player renames themselves Opponent', async () => {
    // The placeholder's own name: writing it raw into currentTurn used to make
    // every one of the player's moves come back illegal.
    service.send({ type: 'join_game_room', username: LOCAL_OPPONENT });
    await flush();
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();
    expect(last('invalid_move')).toBeUndefined();
    expect(last('move_made').boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('refuses to re-deal a game that is still running', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
    // Still the position we played into, not a fresh board on turn 1.
    service.send({ type: 'request_game_state' });
    await flush();
    const state = last('game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('resumes a saved game rather than dealing over the top of it', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();

    // Entering solo play again - a reload on /lobby?solo=1, or Back into it.
    const fresh = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    fresh.messages$.subscribe(m => seen.push(m));
    fresh.send({ type: 'create_single_player_game', username: 'Solo' });
    fresh.send({ type: 'request_game_state' });
    await flush();

    const state = seen.find(m => m.type === 'game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('lands the ability boosts the panel promises', async () => {
    // Two units toe to toe, written straight into the cache: the real setups
    // start twenty hexes apart and this is about the sums, not the walk.
    const config = (service as any).game.config;
    const position = (hp: number) => ({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: {
        '0,0': { unit_id: 'rook', color: 'white', hp, max_hp: hp, uid: 'w0,0' },
        '1,0': { unit_id: 'rook', color: 'black', hp, max_hp: hp, uid: 'b1,0' },
      },
      currentTurn: 'Solo', turnNumber: 1, moveHistory: [], winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    });

    const strike = async (bonuses?: any) => {
      localStorage.setItem('cpp.localGame.v1', JSON.stringify(position(200)));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      engine.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', bonuses });
      await flush();
      return [...seen].reverse().find(m => m.type === 'move_made').move;
    };

    const plain = await strike();
    expect(plain.damage_dealt).toBeGreaterThan(0);

    // +5 ATK lands five more; +5 on their armour takes five back off.
    expect((await strike({ atk: 5 })).damage_dealt).toBe(plain.damage_dealt + 5);
    expect((await strike({ targetDef: 5 })).damage_dealt).toBe(plain.damage_dealt - 5);
    // Their boost answers on the counter, not on our strike.
    const answered = await strike({ targetAtk: 6 });
    expect(answered.damage_dealt).toBe(plain.damage_dealt);
    expect(answered.counter_damage).toBe(plain.counter_damage + 6);
  });

  it('hands over to nobody on the move that ends the game', async () => {
    // consumers.py sends currentTurn '' with the last move_made; naming the
    // next player starts a clock and sounds a turn for a finished match.
    const config = (service as any).game.config;
    localStorage.setItem('cpp.localGame.v1', JSON.stringify({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: {
        '0,0': { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'w0,0' },
        '1,0': { unit_id: 'king', color: 'black', hp: 5, max_hp: 45, uid: 'b1,0' },
        '-5,0': { unit_id: 'king', color: 'white', hp: 45, max_hp: 45, uid: 'w-5,0' },
      },
      currentTurn: 'Solo', turnNumber: 1, moveHistory: [], winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    }));
    const engine = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    engine.messages$.subscribe(m => seen.push(m));
    engine.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0' });
    await flush();

    const move = seen.find(m => m.type === 'move_made');
    expect(move.move.defender_eliminated).toBeTrue();
    expect(move.currentTurn).toBe('');
    expect(seen.find(m => m.type === 'game_over').endReason).toBe('regicide');
  });

  it('hands over to nobody when a pass runs the turn limit out', async () => {
    const config = JSON.parse(JSON.stringify((service as any).game.config));
    config.rules.maxTurns = 1;
    localStorage.setItem('cpp.localGame.v1', JSON.stringify({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: {}, currentTurn: 'Solo', turnNumber: 1, moveHistory: [],
      winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    }));
    const engine = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    engine.messages$.subscribe(m => seen.push(m));
    engine.send({ type: 'pass_turn' });
    await flush();

    expect(seen.find(m => m.type === 'turn_passed').currentTurn).toBe('');
    expect(seen.find(m => m.type === 'game_over').endReason).toBe('draw_max_turns');
  });

  /**
   * Overtime bleeds a commander an HP at the end of each of its side's turns,
   * and a commander on 1 dies of it. Real damage, not a mark - which is what
   * eventually settles a deathmatch neither side is winning on points.
   */
  describe('the overtime toll', () => {
    /** A game standing at `ply` with both kings on the HP given. */
    const at = (ply: number, whiteHp: number, blackHp = 40) => {
      const config = JSON.parse(JSON.stringify((service as any).game.config));
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-5,0': { unit_id: 'king', color: 'white', hp: whiteHp, max_hp: 45, uid: 'wk' },
          '5,0': { unit_id: 'king', color: 'black', hp: blackHp, max_hp: 45, uid: 'bk' },
        },
        // White plays the odd plies, so an odd `ply` is white's to pay for.
        currentTurn: ply % 2 ? 'Solo' : LOCAL_OPPONENT,
        turnNumber: ply, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      return { engine, seen, find: (t: string) => seen.find(m => m.type === t) };
    };

    it('takes nothing before overtime starts', async () => {
      const g = at(65, 20);          // one full turn short of hand-over 67
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(20);
    });

    it('takes one off the king of whoever just played', async () => {
      const white = at(67, 20);
      white.engine.send({ type: 'pass_turn' });
      await flush();
      let board = white.find('turn_passed').boardState;
      expect(board['-5,0'].hp).toBe(19);   // white paid
      expect(board['5,0'].hp).toBe(40);    // black did not

      const black = at(68, 20);
      black.engine.send({ type: 'pass_turn' });
      await flush();
      board = black.find('turn_passed').boardState;
      expect(board['-5,0'].hp).toBe(20);
      expect(board['5,0'].hp).toBe(39);
    });

    it('kills a king on 1, and the game ends with it', async () => {
      const g = at(67, 1);
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0']).toBeUndefined();
      // Hands over to nobody, and black takes it.
      expect(g.find('turn_passed').currentTurn).toBe('');
      expect(g.find('game_over').endReason).toBe('regicide');
      expect(g.find('game_over').winner).toBe(LOCAL_OPPONENT);
    });

    it('takes its toll after the turn, not before it', async () => {
      // The king walks, and the toll comes off where it ended up - not off
      // the HP it had when the turn started, and not instead of the walk.
      const g = at(67, 20);
      g.engine.send({ type: 'make_move', from: '-5,0', to: '-4,0' });
      await flush();
      const board = g.find('move_made').boardState;
      expect(board['-5,0']).toBeUndefined();
      expect(board['-4,0'].hp).toBe(19);
    });
  });

  it('ends on resign, with the other seat winning', async () => {
    service.send({ type: 'resign' });
    await flush();
    expect(last('game_over')).toEqual(jasmine.objectContaining({
      winner: LOCAL_OPPONENT, endReason: 'resign', resignedBy: 'Solo',
    }));
  });
});
