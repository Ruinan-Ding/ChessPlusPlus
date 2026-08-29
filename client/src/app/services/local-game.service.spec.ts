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

  it('starts a game with both setups placed and white to move', () => {
    const started = last('game_started');
    expect(started.playerWhite).toBe('Solo');
    expect(started.playerBlack).toBe(LOCAL_OPPONENT);
    expect(started.currentTurn).toBe('Solo');
    expect(Object.keys(started.boardState).length).toBe(32);   // 16 a side
  });

  it('applies a legal move and hands the turn over', async () => {
    service.send({ type: 'make_move', from: '-9,9', to: '-9,8' });
    await flush();
    const move = last('move_made');
    expect(move.boardState['-9,8'].unit_id).toBe('pawn');
    expect(move.boardState['-9,9']).toBeUndefined();
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

  it('resumes the cached game after a reload', async () => {
    service.send({ type: 'make_move', from: '-9,9', to: '-9,8' });
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
    expect(state.boardState['-9,8'].unit_id).toBe('pawn');
  });

  it('refuses an attack on a unit that is nowhere near', async () => {
    // The two setups start opposite ends of a radius-11 board.
    service.send({ type: 'make_move', from: '-9,9', to: '-9,9', attack: '9,-9' });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();
  });

  it('keeps the seat name when the player renames themselves Opponent', async () => {
    // The placeholder's own name: writing it raw into currentTurn used to make
    // every one of the player's moves come back illegal.
    service.send({ type: 'join_game_room', username: LOCAL_OPPONENT });
    await flush();
    service.send({ type: 'make_move', from: '-9,9', to: '-9,8' });
    await flush();
    expect(last('invalid_move')).toBeUndefined();
    expect(last('move_made').boardState['-9,8'].unit_id).toBe('pawn');
  });

  it('refuses to re-deal a game that is still running', async () => {
    service.send({ type: 'make_move', from: '-9,9', to: '-9,8' });
    await flush();
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
    // Still the position we played into, not a fresh board on turn 1.
    service.send({ type: 'request_game_state' });
    await flush();
    const state = last('game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-9,8'].unit_id).toBe('pawn');
  });

  it('resumes a saved game rather than dealing over the top of it', async () => {
    service.send({ type: 'make_move', from: '-9,9', to: '-9,8' });
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
    expect(state.boardState['-9,8'].unit_id).toBe('pawn');
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

  it('ends on resign, with the other seat winning', async () => {
    service.send({ type: 'resign' });
    await flush();
    expect(last('game_over')).toEqual(jasmine.objectContaining({
      winner: LOCAL_OPPONENT, endReason: 'resign', resignedBy: 'Solo',
    }));
  });
});
