import { ConfigService, DEFAULT_GAME_CONFIG } from './config.service';
import { parseReplay, replayCommand, REPLAY_MAX_ACTIONS, REPLAY_MAX_BYTES, ReplaySessionService } from './replay-session.service';

const file = () => ({ type: 'chessplusplus-replay', version: 1, config: structuredClone(DEFAULT_GAME_CONFIG),
  players: { white: 'White', black: 'Black' }, actions: [{ ply: 1, color: 'white', command: { type: 'pass_turn' } }] });

describe('Portable replay trust boundary', () => {
  const config = new ConfigService();
  it('accepts the resolved match config and intents without importing computed effects or secrets', () => {
    const raw: any = file(); raw.actions[0].command.effects = [{ hp: 999 }]; raw.actions[0].command.token = 'secret';
    expect(parseReplay(JSON.stringify(raw), config).actions[0].command).toEqual({ type: 'pass_turn' });
    expect(replayCommand({ type: 'cast_ability', id: 'warcry', targetUid: 'wp', bonuses: { atk: 99 } }))
      .toEqual({ type: 'cast_ability', id: 'warcry', targetUid: 'wp' });
  });
  it('keeps only fields relevant to each command and treats inherited names as unknown actions', () => {
    expect(replayCommand({ type: 'pick_path', id: 'bastion', hex: 'unused', attack: 'unused' }))
      .toEqual({ type: 'pick_path', id: 'bastion' });
    expect(replayCommand({ type: 'constructor', from: '0,0' })).toEqual({ type: 'constructor' });
  });
  it('rejects unsupported headers and invalid configs before starting the runtime', () => {
    const raw = file(); raw.version = 2;
    expect(() => parseReplay(JSON.stringify(raw), config)).toThrowError(/format/);
    raw.version = 1; raw.config.units.pawn.move = -1;
    expect(() => parseReplay(JSON.stringify(raw), config)).toThrowError(/configuration/);
  });
  it('refuses a missing match config rather than interpreting moves under current defaults', () => {
    const raw: any = file(); delete raw.config;
    expect(() => parseReplay(JSON.stringify(raw), config)).toThrowError(/configuration/);
  });
  it('bounds bytes, nesting and action count', () => {
    expect(() => parseReplay(' '.repeat(REPLAY_MAX_BYTES + 1), config)).toThrowError(/MiB/);
    expect(() => parseReplay('['.repeat(65) + ']'.repeat(65), config)).toThrowError(/nesting/);
    const raw: any = file(); raw.actions = Array(REPLAY_MAX_ACTIONS + 1).fill(null);
    expect(() => parseReplay(JSON.stringify(raw), config)).toThrowError(/count/);
  });
  it('leaves broken individual actions for runtime validation while filtering their fields', () => {
    const raw: any = file(); raw.actions = [null, { ply: 1, color: 'white', command: { type: 'make_move', from: 'x', hp: 99 } }];
    expect(parseReplay(JSON.stringify(raw), config).actions[1].command).toEqual({ type: 'make_move', from: 'x' });
  });
  it('keeps simultaneous imported files under separate session IDs and saves their headers atomically', async () => {
    const left = new ReplaySessionService(), right = new ReplaySessionService();
    await left.open(parseReplay(JSON.stringify(file()), config));
    const leftKey = sessionStorage.getItem('cpp.replaySessionId')!;
    const other = file(); other.players.white = 'Other White';
    await right.open(parseReplay(JSON.stringify(other), config));
    const rightKey = sessionStorage.getItem('cpp.replaySessionId')!;
    expect(rightKey).not.toBe(leftKey);
    left.session!.cursor = 1; await left.save();
    const restoredRight = new ReplaySessionService(); await restoredRight.restore();
    expect(restoredRight.session!.file.players.white).toBe('Other White'); expect(restoredRight.session!.cursor).toBe(0);
    sessionStorage.setItem('cpp.replaySessionId', leftKey);
    const restoredLeft = new ReplaySessionService(); await restoredLeft.restore();
    expect(restoredLeft.session!.file.players.white).toBe('White'); expect(restoredLeft.session!.cursor).toBe(1);
  });
  it('persists the separate session in IndexedDB without modifying the solo save', async () => {
    const before = localStorage.getItem('cpp.localGame.v1');
    const service = new ReplaySessionService(); await service.open(parseReplay(JSON.stringify(file()), config));
    service.session!.cursor = 1; service.session!.branched = true; await service.save();
    const restored = new ReplaySessionService(); await restored.restore();
    expect(restored.session!.cursor).toBe(1); expect(restored.session!.branched).toBeTrue();
    expect(localStorage.getItem('cpp.localGame.v1')).toBe(before);
  });
});
