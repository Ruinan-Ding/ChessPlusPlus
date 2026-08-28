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
    expect(Object.keys(started.boardState).length).toBe(26);
  });

  it('applies a legal move and hands the turn over', async () => {
    service.send({ type: 'make_move', from: '-7,10', to: '-8,10' });
    await flush();
    const move = last('move_made');
    expect(move.boardState['-8,10'].unit_id).toBe('pawn');
    expect(move.boardState['-7,10']).toBeUndefined();
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
    service.send({ type: 'make_move', from: '-7,10', to: '-8,10' });
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
    expect(state.boardState['-8,10'].unit_id).toBe('pawn');
  });

  it('refuses an attack on a unit that is nowhere near', async () => {
    // The two setups start opposite ends of a radius-11 board.
    service.send({ type: 'make_move', from: '-7,10', to: '-7,10', attack: '3,-10' });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();
  });

  it('keeps the seat name when the player renames themselves Opponent', async () => {
    // The placeholder's own name: writing it raw into currentTurn used to make
    // every one of the player's moves come back illegal.
    service.send({ type: 'join_game_room', username: LOCAL_OPPONENT });
    await flush();
    service.send({ type: 'make_move', from: '-7,10', to: '-8,10' });
    await flush();
    expect(last('invalid_move')).toBeUndefined();
    expect(last('move_made').boardState['-8,10'].unit_id).toBe('pawn');
  });

  it('refuses to re-deal a game that is still running', async () => {
    service.send({ type: 'make_move', from: '-7,10', to: '-8,10' });
    await flush();
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
    // Still the position we played into, not a fresh board on turn 1.
    service.send({ type: 'request_game_state' });
    await flush();
    const state = last('game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-8,10'].unit_id).toBe('pawn');
  });

  it('ends on resign, with the other seat winning', async () => {
    service.send({ type: 'resign' });
    await flush();
    expect(last('game_over')).toEqual(jasmine.objectContaining({
      winner: LOCAL_OPPONENT, endReason: 'resign', resignedBy: 'Solo',
    }));
  });
});
