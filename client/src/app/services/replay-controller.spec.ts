import { ReplayController } from './replay-controller';
import type { ReplaySession, ReplayFrame } from './replay-session.service';

describe('Replay lifecycle independent of the room view', () => {
  it('rolls back one corrupt action, continues, then branches from an earlier checkpoint', async () => {
    const session: ReplaySession = { file: { type: 'chessplusplus-replay', version: 1, config: {},
      players: { white: 'White', black: 'Black' }, actions: [0, 1, 2].map(() => ({ ply: 1, color: 'white', command: { type: 'pass_turn' } })) },
      cursor: 0, branched: false, skipped: [] };
    let value = 0;
    const controller = new ReplayController({ session: () => session,
      capture: (): ReplayFrame => ({ core: { value }, ui: {} }), restore: frame => value = frame.core.value,
      reset: async () => { value = 0; }, render: async () => {}, disposed: () => false,
      execute: async () => { value++; if (session.cursor === 1) { value += 100; throw new Error('Invalid move'); } },
      beforeSeek: () => {}, settled: () => {}, changed: () => {} });
    controller.ready = true; controller.remember(0, { core: { value: 0 }, ui: {} });
    await controller.seek(3, false);
    expect(value).toBe(2); expect(session.cursor).toBe(3); expect(session.skipped).toEqual([1]);
    expect(controller.error).toContain('Move corrupted'); expect(controller.busy).toBeFalse();
    await controller.seek(1, false); expect(value).toBe(1);
    controller.branch();
    expect(session.branchActions?.length).toBe(1); expect(session.skipped).toEqual([]);
    expect(controller.forwardEnabled).toBeFalse(); expect(session.file.actions.length).toBe(3);
  });
  it('finishes an in-flight action on cancel without executing the next one, then can resume', async () => {
    const session: ReplaySession = { file: { type: 'chessplusplus-replay', version: 1, config: {},
      players: { white: 'White', black: 'Black' }, actions: [0, 1, 2].map(() => ({ ply: 1, color: 'white', command: { type: 'pass_turn' } })) },
      cursor: 0, branched: false, skipped: [] };
    let value = 0, finish!: () => void;
    const inFlight = new Promise<void>(resolve => finish = resolve);
    const controller = new ReplayController({ session: () => session,
      capture: (): ReplayFrame => ({ core: { value }, ui: {} }), restore: frame => value = frame.core.value,
      reset: async () => { value = 0; }, render: async () => {}, disposed: () => false,
      execute: async () => { value++; if (value === 1) await inFlight; },
      beforeSeek: () => {}, settled: () => {}, changed: () => {} });
    controller.ready = true;
    const running = controller.seek(3, true);
    expect(controller.busy).toBeTrue(); controller.cancel(); finish(); await running;
    expect(session.cursor).toBe(1); expect(value).toBe(1); expect(controller.busy).toBeFalse();
    await controller.seek(3, false);
    expect(session.cursor).toBe(3); expect(value).toBe(3); expect(session.skipped).toEqual([]);
  });

  it('reconstructs evicted positions and falls back to reset when no cached frame remains', async () => {
    const session: ReplaySession = { file: { type: 'chessplusplus-replay', version: 1, config: {},
      players: { white: 'White', black: 'Black' }, actions: Array.from({ length: 15 }, () =>
        ({ ply: 1, color: 'white', command: { type: 'pass_turn' } })) }, cursor: 0, branched: false, skipped: [] };
    let value = 0;
    const reset = jasmine.createSpy('reset').and.callFake(async () => { value = 0; });
    const controller = new ReplayController({ session: () => session,
      capture: (): ReplayFrame => ({ core: { value }, ui: {} }), restore: frame => value = frame.core.value,
      reset, render: async () => {}, disposed: () => false, execute: async () => { value++; },
      beforeSeek: () => {}, settled: () => {}, changed: () => {} });
    controller.ready = true; controller.remember(0, { core: { value: 0 }, ui: {} });
    await controller.seek(15, false);
    expect(controller.frames.size).toBe(12); expect(controller.frames.has(0)).toBeTrue();
    expect(controller.frames.has(2)).toBeFalse();
    await controller.seek(2, false);
    expect(value).toBe(2); expect(session.cursor).toBe(2); expect(reset).not.toHaveBeenCalled();
    controller.clear(); await controller.seek(0, false);
    expect(reset).toHaveBeenCalledTimes(1); expect(value).toBe(0); expect(session.cursor).toBe(0);
    expect(controller.cacheSize).toBe(0);
  });

});
