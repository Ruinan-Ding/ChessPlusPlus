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

  /**
   * Past every turn given to setting out, where nobody attacks at all.
   *
   * Six plies of passing rather than a turn number written over the cache:
   * the pass is what a real game does to get there, and the specs that need
   * it are about blows, which a setup turn refuses outright. A pass moves
   * nobody, so the board they were written against is the board they get.
   *
   * Six - the opening's three turns and nothing after them. It was eight
   * while Phase 1 opened with an initialization turn of its own, which
   * refused a blow for the same reason; that extra turn is the phase's
   * postmatch now, at its other end, so play starts the moment the opening
   * is over. Ply 7 is turn 4, the first of Phase 1's play.
   */
  const pastOpening = async () => {
    for (let i = 0; i < 6; i++) service.send({ type: 'pass_turn' });
    await flush();
  };

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

  it('records a cast made after a blow into a panel after the blow', async () => {
    // The blow's record used to be the last word on the unit's HP: the cast
    // went ahead of it, so a panel unit struck and then finished by a spell
    // came back from the dead on a reload.
    await pastOpening();
    const home = { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'rtr0' };
    service.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr',
      from: '-5,9', attack: '-5,8', unit: home,
      effects: [{ unit: home, hp: 0, panel: 'tr' }],
    });
    await flush();
    expect(last('move_made').effects[0].defenderHp).toBe(0);
    service.send({ type: 'request_game_state' });
    await flush();
    const history = last('game_state_update').moveHistory;
    expect(history.slice(-2)[0].panelAttack).toBeTrue();
    expect(history.slice(-1)[0]).toEqual(jasmine.objectContaining({ panelEffect: true, defenderHp: 0 }));
  });

  it('lands a blow in a panel, and the panel answers', async () => {
    // The defender is not on this board - panels are the client's - so it
    // rides in with the message and its remaining HP comes back on the
    // record. `from` is a real board hex: the attacker IS on the board.
    const started = last('game_started');
    const attacker = '-5,9';
    expect(started.boardState[attacker].unit_id).toBe('pawn');
    await pastOpening();
    const opened = last('turn_passed').turnNumber;

    const home = { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'rtr0' };
    service.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr',
      from: attacker, attack: '-5,8', unit: home,
    });
    await flush();
    const msg = last('move_made');
    const hit = msg.move;
    expect(hit.panelAttack).toBeTrue();
    expect(hit.intoPanel).toBeTrue();
    // The panel is carried, not derived - this engine has none to look one up
    // in - and kept, because the record is the only place it survives a
    // reload, where it says whether the wound mends.
    expect(hit.panel).toBe('tr');
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
    expect(msg.turnNumber).toBe(opened + 1);

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
    await pastOpening();
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
    await pastOpening();

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

  it('holds the seat for a move that is not the turn’s last', async () => {
    // Ply 89 is turn 45 - Overtime 2, two board moves to a side. The first
    // carries `more`: same seat, same ply, same clock, and the next message
    // plays the next unit. Mirrors `_commit_deployment` on the server.
    const g = (service as any).game;
    g.turnNumber = 2 * 45 - 1;
    const kingOf = (board: any) => Object.values(board).find(
      (c: any) => c.color === 'white' && g.config.units[c.unit_id]?.commander) as any;
    const hpBefore = kingOf(g.boardState).hp;

    service.send({ type: 'make_move', from: '-5,9', to: '-5,8', more: true });
    await flush();
    expect(last('move_made')).toBeUndefined();
    const held = last('game_state_update');
    expect(held.turnNumber).toBe(2 * 45 - 1);
    expect(held.currentTurn).toBe('Solo');
    expect(held.boardState['-5,8'].unit_id).toBe('pawn');

    // The second ends it.
    service.send({ type: 'make_move', from: '-4,9', to: '-4,8' });
    await flush();
    expect(last('move_made').turnNumber).toBe(2 * 45);

    // **The toll was taken once, not once per move.** Overtime 2 takes 2, so a
    // two-move turn costs 2 and not 4 - and Overtime 3, the stretch that
    // allows three, is where charging it per move would hurt most. The held
    // move must leave it alone: the toll is what the END of a turn costs.
    expect(kingOf(last('move_made').boardState).hp).toBe(hpBefore - 2);
    // And the held message took none of it at all.
    expect(kingOf(held.boardState).hp).toBe(hpBefore);
  });

  it('refuses a move once the turn’s allowance is spent', async () => {
    // Ply 7 is turn 4, one board move. The second message is refused rather
    // than quietly played into the next side’s turn.
    await pastOpening();
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8', more: true });
    await flush();
    // `more` on the last move the allowance permits ends the turn anyway -
    // there is nothing left for it to hold the seat open for.
    expect(last('move_made').turnNumber).toBe(8);

    // Wind back into the same hand-over: a second board move is refused.
    (service as any).game.turnNumber = 7;
    (service as any).game.currentTurn = 'Solo';
    service.send({ type: 'make_move', from: '-4,9', to: '-4,8' });
    await flush();
    expect(last('invalid_move').message)
      .toBe('That side has had all 1 of its moves this turn');
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
    // Empty hexes inside white's own first three rows - the only ground a
    // crossing may stop on.
    const free = ['1,9', '-1,9', '-3,9', '-6,9'].filter(k => !started.boardState[k]).slice(0, 2);
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

  it('records a walk inside a panel without ending the turn', async () => {
    // A walk used to reach no engine: the board kept it in its own memory, so
    // a reload re-dealt the unit where it began. Recorded, it is replayed.
    const archer = { unit_id: 'archer', color: 'white', hp: 16, max_hp: 16, uid: 'rbr4' };
    service.send({
      type: 'panel_move', from: '7,7', to: '6,7', unit: archer, panel: 'br', cost: 1, price: 0,
    });
    await flush();

    const state = last('game_state_update');
    const record = state.moveHistory[state.moveHistory.length - 1];
    expect(record.panelMove).toBeTrue();
    expect(record.unit.uid).toBe('rbr4');
    expect(record.panel).toBe('br');
    expect(record.cost).toBe(1);
    expect(record.to).toBe('6,7');
    expect(state.currentTurn).toBe('Solo');
    expect(state.turnNumber).toBe(1);
  });

  it('refuses a walk for the side that is not on turn', async () => {
    service.send({
      type: 'panel_move', from: '-7,-7', to: '-6,-7', panel: 'tl', cost: 1, price: 0,
      unit: { unit_id: 'archer', color: 'black', hp: 16, max_hp: 16, uid: 'rtl4' },
    });
    await flush();
    expect(last('invalid_move')).toBeTruthy();
    expect(last('game_state_update')).toBeUndefined();
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

    // Its own base, which is the point mirror of that, is allowed. Turn 1 is
    // a setup turn, so the walk is deployment: a state update rather than a
    // `move_made`, and the seat stays where it is.
    service.send({ type: 'make_move', from: '-5,9', to: '-12,11', withdraw: true });
    await flush();
    expect(last('move_made')).toBeUndefined();
    const move = last('game_state_update');
    expect(move.boardState['-5,9']).toBeUndefined();
    // It leaves the board entirely rather than landing on a hex of it.
    expect(move.boardState['-12,11']).toBeUndefined();
    expect(move.turnNumber).toBe(1);

    service.send({ type: 'request_game_state' });
    await flush();
    const history = last('game_state_update').moveHistory;
    const record = history[history.length - 1];
    expect(record.withdrawn).toBeTrue();
    // The unit rides in the record - it is the only place it survives.
    expect(record.unit.unit_id).toBe('pawn');
  });

  it('never walks the king home', async () => {
    // The owner's rule. Off the board he counted as no commander, so the walk
    // home lost the match on the spot.
    const started = last('game_started');
    const king = Object.keys(started.boardState).find(k =>
      started.boardState[k].unit_id === 'king' && started.boardState[k].color === 'white')!;
    service.send({ type: 'make_move', from: king, to: '-12,11', withdraw: true });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();
    expect(last('game_over')).toBeUndefined();
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
      // Ply 7: the first on which anybody may swing at all.
      currentTurn: 'Solo', turnNumber: 7, moveHistory: [], winner: '', endReason: '',
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
      // Ply 7: the opening is over and Phase 1 is playing, so the killing blow
      // may land.
      currentTurn: 'Solo', turnNumber: 7, moveHistory: [], winner: '', endReason: '',
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
      const g = at(71, 20);          // one full turn short of hand-over 73
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(20);
    });

    it('takes one off the king of whoever just played', async () => {
      const white = at(73, 20);
      white.engine.send({ type: 'pass_turn' });
      await flush();
      let board = white.find('turn_passed').boardState;
      expect(board['-5,0'].hp).toBe(19);   // white paid
      expect(board['5,0'].hp).toBe(40);    // black did not

      const black = at(74, 20);
      black.engine.send({ type: 'pass_turn' });
      await flush();
      board = black.find('turn_passed').boardState;
      expect(board['-5,0'].hp).toBe(20);
      expect(board['5,0'].hp).toBe(39);
    });

    it('kills a king on 1, and the game ends with it', async () => {
      const g = at(73, 1);
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0']).toBeUndefined();
      // Hands over to nobody, and black takes it.
      expect(g.find('turn_passed').currentTurn).toBe('');
      expect(g.find('game_over').endReason).toBe('regicide');
      expect(g.find('game_over').winner).toBe(LOCAL_OPPONENT);
    });

    it('under elimination, a king the toll kills loses nothing while his army stands', async () => {
      // Elimination ends when a side has no units at all. This called the
      // felled king a defeat on a pass - `move` never did - and the server's
      // pass does not either, so the two engines would disagree about whether
      // a networked match was over.
      const config = JSON.parse(JSON.stringify((service as any).game.config));
      config.rules = { ...config.rules, objective: 'elimination' };
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-5,0': { unit_id: 'king', color: 'white', hp: 1, max_hp: 45, uid: 'wk' },
          '-4,0': { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid: 'wp' },
          '5,0': { unit_id: 'king', color: 'black', hp: 40, max_hp: 45, uid: 'bk' },
        },
        currentTurn: 'Solo', turnNumber: 73, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));

      engine.send({ type: 'pass_turn' });
      await flush();

      const passed = seen.find(m => m.type === 'turn_passed');
      expect(passed.boardState['-5,0']).toBeUndefined();
      expect(passed.currentTurn).toBeTruthy();
      expect(seen.find(m => m.type === 'game_over')).toBeUndefined();
    });

    it('saves a king healed off 1 before the turn commits', async () => {
      // The owner's report: "after healing it from 1hp, it dies next turn
      // anyways". No engine holds an ability, so a heal on a unit standing on
      // the BOARD has to be sent as its own message - only the panel half ever
      // was. The mend lived on the room's staged board, the toll came off the
      // 1 HP the engine still had, and the king died anyway.
      const g = at(73, 1);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: 21 }] });
      await flush();
      // Healed to 21, then the toll: 20.
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(20);
      expect(g.find('game_over')).toBeUndefined();
    });

    it('finds a cast\'s unit by uid when the hex it names is stale', async () => {
      // Addressed by hex alone, a mend on a unit the client had walked fell on
      // an empty square and was silently dropped.
      const g = at(73, 1);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-4,0', uid: 'wk', hp: 21 }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(20);
    });

    it('keeps none of a turn\'s casts when it refuses the turn', async () => {
      // Sent as messages of their own, the casts were kept before the move was
      // looked at, so a refused move came back half-played.
      const g = at(21, 12);
      g.engine.send({
        type: 'make_move', from: '-5,0', to: '9,9',
        effectsBefore: [{ at: '-5,0', uid: 'wk', hp: 40 }],
      });
      await flush();
      expect(g.find('invalid_move')).toBeDefined();
      const game = (g.engine as any).game;
      expect(game.boardState['-5,0'].hp).toBe(12);
      expect(game.moveHistory.length).toBe(0);
    });

    it('never ends the match on a cast that killed nothing', async () => {
      // The same line `pass()` draws: a side can hold no commander on the
      // BOARD for reasons of its own - one that walked home into its base is
      // off the board and still alive. Checking who is beaten on every cast
      // meant a heal on your own pawn could end a match it had no part in.
      // Black holds no commander on the board - a hand-built position. A mend
      // on white's own king must not read that as a regicide.
      const g = at(20, 12, 40);
      delete (g.engine as any).game.boardState['5,0'];
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: 20, uid: 'wk' }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(20);
      expect(g.find('game_over')).toBeUndefined();
    });

    it('lands a cast made after the blow after the blow', async () => {
      // A cast carries the HP the client worked out for the turn, blow
      // included. Sent ahead of the move, the engine wrote it and then
      // resolved the blow over the top: a king mended after taking a counter
      // lost the mend.
      const g = at(21, 40);
      const game = (g.engine as any).game;
      game.boardState = { '-5,0': game.boardState['-5,0'], '-4,0': game.boardState['5,0'] };
      g.engine.send({
        type: 'make_move', from: '-5,0', to: '-5,0', attack: '-4,0',
        effects: [{ at: '-5,0', uid: 'wk', hp: 45 }],
      });
      await flush();
      const made = g.find('move_made');
      expect(made.move.counter_damage).toBeGreaterThan(0);
      expect(made.boardState['-5,0'].hp).toBe(45);
    });

    it('never writes an HP past what the unit can hold', async () => {
      const g = at(20, 12);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: 900, uid: 'wk' }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(45);
    });

    it('ends the match when a cast takes the last king off the board', async () => {
      // A commander killed by an ability is a commander killed. Left out, the
      // game carried on with a side that had already lost.
      const g = at(20, 12);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: 0 }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0']).toBeUndefined();
      expect(g.find('game_over').endReason).toBe('regicide');
      expect(g.find('game_over').winner).toBe(LOCAL_OPPONENT);
    });

    it('takes its toll after the turn, not before it', async () => {
      // The king walks, and the toll comes off where it ended up - not off
      // the HP it had when the turn started, and not instead of the walk.
      const g = at(73, 20);
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

  /**
   * The rules this engine can keep without a panel model, a purse or an
   * ability catalogue - so they hold today and do not have to be written
   * twice when those settle. The board's click handler keeps an honest player
   * inside them; these are what a console runs into.
   *
   * What is deliberately NOT here: how far a panel walk went, which panel a
   * unit stood in, and whether a side could afford the wrap. Each wants
   * something this engine has not got, and the purse also holds what
   * abilities have paid in and out - see 6.15 and 6.17.
   */
  describe('the rules it keeps without a panel', () => {
    /** A reserve unit of white's, as a panel message carries one. */
    const reserve = (uid: string, over: any = {}) => ({
      unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid, ...over,
    });

    /**
     * A cached position at `ply`, white to play, with whatever board is given.
     * The windows are read off the ply and nothing else, so these need no
     * panel, no purse and no history - which is the point of them.
     */
    const at = (ply: number, boardState: any = {}) => {
      const config = (service as any).game.config;
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config, boardState,
        currentTurn: ply % 2 ? 'Solo' : LOCAL_OPPONENT,
        turnNumber: ply, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      return {
        engine, seen,
        refusal: () => seen.filter(m => m.type === 'invalid_move').slice(-1)[0]?.message,
      };
    };

    /**
     * A white pawn standing on `at`, which is all a walk home needs - plus
     * both kings, because a board with no commander on it is a mutual defeat
     * under regicide and the game would end on the first move that committed.
     */
    const walker = (at: string, uid = 'w1') => ({
      [at]: { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid },
    });
    const kings = {
      '0,0': { unit_id: 'king', color: 'white', hp: 45, max_hp: 45, uid: 'wk' },
      '1,0': { unit_id: 'king', color: 'black', hp: 45, max_hp: 45, uid: 'bk' },
    };

    it('refuses an attack in a postmatch, and says which turn', async () => {
      // Turn 14 - Phase 1's postmatch, plies 27 and 28 - refuses a blow for
      // the same reason the opening does, and saying "the opening" there
      // points at a phase that ended at turn 3.
      const g = at(27, { ...kings, ...walker('-5,9') });
      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '-5,8' });
      await flush();
      expect(g.refusal()).toBe('Nobody attacks in the postmatch');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();
    });

    it('lets a blow land on turn 4, which used to be a setup turn and now plays', async () => {
      // Phase 1's extra turn moved from its start to its end, so the turn
      // straight after the opening is a turn of play. Refused here, it would
      // be the four-setup-turn opening the move was made to get rid of.
      const g = at(7, {
        ...kings, ...walker('-5,9'),
        '-5,8': { unit_id: 'pawn', color: 'black', hp: 20, max_hp: 20, uid: 'b1' },
      });
      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '-5,8' });
      await flush();
      expect(g.refusal()).toBeUndefined();
      expect(g.seen.find(m => m.type === 'move_made').move.damage_dealt).toBeGreaterThan(0);
    });

    it('refuses a crossing that would stop past its own first three rows', async () => {
      // Row 8 is one short of white's own ground. The engine has no panel to
      // check the walk with, but where a crossing may STOP is a question about
      // the hex and the mover's colour, and it can answer that.
      service.send({ type: 'enter_board', from: 'bl-1', to: '3,8', unit: reserve('r1') });
      await flush();
      expect(last('invalid_move').message)
        .toBe('A crossing stops in your own first three rows');
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['3,8']).toBeUndefined();
    });

    it('refuses a crossing while the way in is shut', async () => {
      // Ply 15 is turn 8, Phase 1's played first half - when the wrap runs and
      // the three ways in do not.
      const g = at(15);
      g.engine.send({ type: 'enter_board', from: 'bl-1', to: '-10,9', unit: reserve('r1') });
      await flush();
      expect(g.refusal()).toBe('The way in is shut');
    });

    it('starts five out of a reserve in a postmatch, and no more', async () => {
      // Five stands INSTEAD of the per-panel three on that turn, so the fourth
      // and fifth go through and the sixth does not. Ply 27 is turn 14, Phase
      // 1's postmatch.
      const hexes = ['-10,9', '-8,9', '-6,9', '-3,9', '-1,9', '1,9'];
      const g = at(27);
      hexes.forEach((to, i) => g.engine.send({
        type: 'enter_board', from: 'bl-1', to, unit: reserve(`r${i}`),
      }));
      await flush();
      expect(g.refusal()).toBe('That reserve has started its units for the turn');
      g.engine.send({ type: 'request_game_state' });
      await flush();
      const board = g.seen.filter(m => m.type === 'game_state_update').slice(-1)[0].boardState;
      expect(hexes.filter(h => board[h]).length).toBe(5);
    });

    it("reads a postmatch's entries off the game's config", async () => {
      // rules.postmatchEntries: a room that says two stops the third.
      const rules = (service as any).game.config.rules;
      const saved = rules.postmatchEntries;
      rules.postmatchEntries = 2;
      try {
        const g = at(27);
        ['-10,9', '-8,9', '-6,9'].forEach((to, i) => g.engine.send({
          type: 'enter_board', from: 'bl-1', to, unit: reserve(`r${i}`),
        }));
        await flush();
        expect(g.refusal()).toBe('That reserve has started its units for the turn');
      } finally {
        rules.postmatchEntries = saved;
      }
    });

    it('refuses a walk home while the way home is shut', async () => {
      // Both halves of a numbered phase's play shut the base doorways.
      const g = at(15, { ...kings, ...walker('-11,11') });
      g.engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
      await flush();
      expect(g.refusal()).toBe('The way home is shut');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();
    });

    it('refuses a walk home from outside its own first three rows', async () => {
      // Row 8 again: a unit that has pushed up the board walks back down into
      // its own ground before it can walk off it. On a postmatch, where the
      // way home is open, so the rows are what refuse it.
      const g = at(27, { ...kings, ...walker('-11,8') });
      g.engine.send({ type: 'make_move', from: '-11,8', to: '-12,8', withdraw: true });
      await flush();
      expect(g.refusal()).toBe('Only your own first three rows walk home');
    });

    it("reads a setup turn's walks home off the game's config", async () => {
      // rules.homecomingsPerSetupTurn: a room that says one stops the second.
      const rules = (service as any).game.config.rules;
      const saved = rules.homecomingsPerSetupTurn;
      rules.homecomingsPerSetupTurn = 1;
      try {
        const g = at(27, { ...kings, ...walker('-11,11', 'w1'), ...walker('-10,11', 'w2') });
        g.engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
        await flush();
        expect(g.refusal()).toBeUndefined();
        g.engine.send({ type: 'make_move', from: '-10,11', to: '-12,10', withdraw: true });
        await flush();
        expect(g.refusal()).toBe('That is all who may walk home this turn');
      } finally {
        rules.homecomingsPerSetupTurn = saved;
      }
    });

    it('walks three home in a setup turn and no more', async () => {
      // Ply 27, Phase 1's postmatch.
      const g = at(27, {
        ...kings,
        ...walker('-11,11', 'w1'), ...walker('-10,11', 'w2'),
        ...walker('-8,11', 'w3'), ...walker('-7,11', 'w4'),
      });
      // All three inside the one turn, nothing wound between them. A walk
      // home on a setup turn is deployment, not the turn's board action, so
      // it hands the seat to nobody - which is the only reason a count of
      // three is reachable. It used to end the turn on the first walk, and
      // this spec had to put the seat and the ply back by hand to pretend
      // otherwise; that the fake was needed was the bug showing through.
      const walks: Array<[string, string]> = [
        ['-11,11', '-12,11'], ['-10,11', '-12,10'],
        ['-8,11', '-12,9'], ['-7,11', '-12,8'],
      ];
      for (const [from, to] of walks) {
        g.engine.send({ type: 'make_move', from, to, withdraw: true });
        await flush();
      }
      expect(g.refusal()).toBe('That is all who may walk home this turn');
      // Three went, and the turn is still the one they went on.
      expect((g.engine as any).game.turnNumber).toBe(27);
      expect(g.seen.filter(m => m.type === 'game_state_update').length).toBe(3);
      expect(g.seen.filter(m => m.type === 'move_made').length).toBe(0);
    });

    it('counts nobody home in overtime, where the doorways never shut', async () => {
      // The owner's exception: overtime is not a setup turn, so the three do
      // not apply - the turn's own move allowance is the only cap there.
      const g = at(73, { ...kings, ...walker('-11,11') });
      g.engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
      await flush();
      expect(g.refusal()).toBeUndefined();
      expect(g.seen.find(m => m.type === 'move_made')).toBeDefined();
    });

    it('fires no ability on a turn given to setting out', async () => {
      // The one ability rule the engine can keep with the abilities unsettled:
      // it need not know what a cast is worth to know none should have come.
      // Ply 27, Phase 1's postmatch.
      const g = at(27, { ...kings, ...walker('-5,9') });
      g.engine.send({
        type: 'make_move', from: '-5,9', to: '-5,8',
        effectsBefore: [{ uid: 'w1', hp: 6, at: '-5,9' }],
      });
      await flush();
      expect(g.refusal()).toBe('No ability fires while a side is setting out');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();

      // A pass is the other way a cast reaches the engine.
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ uid: 'w1', hp: 6, at: '-5,9' }] });
      await flush();
      expect(g.seen.find(m => m.type === 'turn_passed')).toBeUndefined();

      // A zero is not a use: an ordinary move still goes through.
      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,8', moveBonus: 0, bonuses: {} });
      await flush();
      expect(g.seen.find(m => m.type === 'move_made')).toBeDefined();
    });

    it('reads a bonus as a number, both ways round', async () => {
      // `Number(x) || 0` was inert as a guard: nonsense came back NaN, which
      // is falsy, so it passed for "no ability"; a negative one is truthy, so
      // it refused a move no ability had touched.
      const nonsense = at(27, { ...kings, ...walker('-5,9') });
      nonsense.engine.send({
        type: 'make_move', from: '-5,9', to: '-5,8', moveBonus: 'x' as any,
      });
      await flush();
      expect(nonsense.refusal()).toBe('No ability fires while a side is setting out');

      const negative = at(27, { ...kings, ...walker('-5,9') });
      negative.engine.send({
        type: 'make_move', from: '-5,9', to: '-5,8', bonuses: { atk: -1 } as any,
      });
      await flush();
      expect(negative.refusal()).toBe('No ability fires while a side is setting out');
    });

    it('refuses an attack in the opening', async () => {
      // The board never offered one; nothing else said no, so a crafted
      // message could open the match by swinging.
      service.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '-5,8' });
      await flush();
      expect(last('invalid_move').message).toBe('Nobody attacks in the opening');
      expect(last('move_made')).toBeUndefined();
    });

    it('refuses a blow into a panel in the opening', async () => {
      service.send({
        type: 'panel_attack', intoPanel: true, panel: 'tr',
        from: '-5,9', attack: '-5,8',
        unit: { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'rtr0' },
      });
      await flush();
      expect(last('invalid_move').message).toBe('Nobody attacks in the opening');
      expect(last('move_made')).toBeUndefined();
    });

    it('gives a battlefield unit one move for the whole opening', async () => {
      service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
      await flush();
      expect(last('move_made').move.moved).toBeTrue();
      // Round to white again, still inside the opening.
      service.send({ type: 'pass_turn' });
      await flush();
      expect(last('turn_passed').turnNumber).toBe(3);

      service.send({ type: 'make_move', from: '-5,8', to: '-5,7' });
      await flush();
      expect(last('invalid_move').message).toBe('That unit has had its move for the opening');
      // It has not budged.
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['-5,8'].unit_id).toBe('pawn');
    });

    it('refuses a crossing by a unit already standing on the board', async () => {
      // The uid is the one on -5,9 in the dealt setup, so this is that unit
      // asking to be in two places at once.
      const standing = last('game_started').boardState['-5,9'];
      service.send({
        type: 'enter_board', from: 'bl-1', to: '0,0',
        unit: { ...standing, hp: 20 },
      });
      await flush();
      expect(last('invalid_move').message).toBe('That unit is already on the board');
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['0,0']).toBeUndefined();
    });

    it('refuses a panel message naming a unit the config never heard of', async () => {
      service.send({
        type: 'enter_board', from: 'bl-1', to: '0,0',
        unit: reserve('made-up', { unit_id: 'dragon' }),
      });
      await flush();
      expect(last('invalid_move').message).toBe('No such unit');
    });

    it('clamps a crossing unit to the HP its own config allows', async () => {
      service.send({
        type: 'enter_board', from: 'bl-1', to: '-10,9', unit: reserve('r1', { hp: 9999 }),
      });
      await flush();
      service.send({ type: 'request_game_state' });
      await flush();
      // A pawn's 20, not the 9999 it asked for. A cast may have mended or hurt
      // it in the panel, so a lower number is still taken on trust.
      expect(last('game_state_update').boardState['-10,9'].hp).toBe(20);
    });

    it('starts three of a panel in a turn and no more', async () => {
      const hexes = ['-10,9', '-8,9', '-6,9', '-3,9'];
      hexes.forEach((to, i) => service.send({
        type: 'enter_board', from: 'bl-1', to, unit: reserve(`r${i}`),
      }));
      await flush();
      expect(last('invalid_move').message)
        .toBe('That reserve has started its units for the turn');
      service.send({ type: 'request_game_state' });
      await flush();
      const board = last('game_state_update').boardState;
      expect(hexes.filter(h => board[h]).length).toBe(3);
    });

    it('locks a panel unit out for the rest of the opening once it has moved', async () => {
      // A walk inside a panel, so the unit is still in the panel afterwards -
      // a crossing would put it on the board, which is refused first and for
      // a different reason.
      const walk = (to: string) => service.send({
        type: 'panel_move', from: 'bl-1', to, panel: 'bl', cost: 1, unit: reserve('r1'),
      });
      walk('bl-2');
      await flush();
      expect(last('invalid_move')).toBeUndefined();

      // A panel walk does not end the turn, so two passes come back round to
      // white - still inside the opening.
      service.send({ type: 'pass_turn' });
      service.send({ type: 'pass_turn' });
      await flush();
      expect(last('turn_passed').turnNumber).toBe(3);

      walk('bl-3');
      await flush();
      expect(last('invalid_move').message)
        .toBe('That unit has had its move for the opening');
    });

    it('refuses a crossing by a unit the record says is dead', async () => {
      // A panel unit a cast emptied is off the roster the server rebuilds.
      // Flooring the HP at 1 walked it onto the board instead of refusing it.
      service.send({
        type: 'enter_board', from: 'bl-1', to: '-10,9', unit: reserve('r1', { hp: 0 }),
      });
      await flush();
      expect(last('invalid_move').message).toBe('Nothing is standing there');
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['0,0']).toBeUndefined();
    });

    it("takes a crossing unit's ceiling from config, not from the message", async () => {
      // max_hp is what every later cast is clamped against, so trusting it
      // undid the HP clamp one mend later.
      service.send({
        type: 'enter_board', from: 'bl-1', to: '-10,9',
        unit: reserve('r1', { hp: 20, max_hp: 9999 }),
      });
      await flush();
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['-10,9'].max_hp).toBe(20);
    });

    it('refuses a blow into a panel against a unit the config never heard of', async () => {
      // The defender is named by the message too. Unchecked, strikeDamage read
      // an undefined unit out of config and the record went into the history.
      await pastOpening();
      service.send({
        type: 'panel_attack', intoPanel: true, panel: 'tr', from: '-5,9', attack: '-5,8',
        unit: { unit_id: 'dragon', color: 'black', hp: 1, max_hp: 1, uid: 'z' },
      });
      await flush();
      expect(last('invalid_move').message).toBe('No such unit');
      expect(last('move_made')).toBeUndefined();
    });

    it('refuses the wrap while it is shut', async () => {
      // The schedule needs only the ply, so it needs none of the three things
      // this engine has not got. Turns 9-13 are Phase 1's halftime half, with
      // the wrap shut; ply 19 is turn 10. `panel_move_targets` offers no wrap
      // there at all.
      const config = (service as any).game.config;
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {}, currentTurn: 'Solo', turnNumber: 19, moveHistory: [],
        winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      engine.send({
        type: 'panel_move', from: 'bl-1', to: 'tr-1', panel: 'bl',
        cost: 2, price: 5, unit: reserve('r9'),
      });
      await flush();
      expect(seen.find(m => m.type === 'invalid_move').message).toBe('The wrap is shut');
    });

    it('names the rule that refuses the king his walk home', async () => {
      // "Illegal move" sends the player looking for a doorway that works.
      const config = (service as any).game.config;
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-11,11': { unit_id: 'king', color: 'white', hp: 45, max_hp: 45, uid: 'wk' },
        },
        // Turn 14, Phase 1's postmatch: the way home is open there, so the
        // king is refused by his own rule and not by a shut doorway.
        currentTurn: 'Solo', turnNumber: 27, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
      await flush();
      expect(seen.find(m => m.type === 'invalid_move').message)
        .toBe('The king never walks home');
      expect(seen.find(m => m.type === 'move_made')).toBeUndefined();
    });

    it('charges the wrap what the unit is worth, not what the message says', async () => {
      // The price is a config lookup, so it needs no panel and no purse: a
      // message claiming the crossing was a bargain is corrected. Whether the
      // side could afford it is still the room's - a solo purse holds what
      // abilities paid in and out as well.
      //
      // Past the setup turns first: the wrap is shut on every one of them, so
      // the crossing would be refused before its price was ever worked out.
      await pastOpening();
      service.send({
        type: 'panel_move', from: 'bl-1', to: 'tr-1', panel: 'bl',
        cost: 2, price: 1, unit: reserve('r9'),
      });
      await flush();
      service.send({ type: 'request_game_state' });
      await flush();
      const walk = last('game_state_update').moveHistory.slice(-1)[0];
      expect(walk.panelMove).toBeTrue();
      expect(walk.price).toBe(5);              // the pawn's value, not the 1 sent
      expect(walk.cost).toBe(2);               // what it cost to walk is still theirs
    });
  });
});
