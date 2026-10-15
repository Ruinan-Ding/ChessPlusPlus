import { CpuTurnController } from './cpu-turn-controller';
import type { GameCommand } from './game-command';

describe('CPU turn lifecycle', () => {
  it('ignores replies arriving after cancellation', async () => {
    let resolve!: (value: { commands: GameCommand[]; color: 'black' }) => void;
    const pending = new Promise<{ commands: GameCommand[]; color: 'black' }>(done => resolve = done);
    const apply = jasmine.createSpy('apply').and.resolveTo();
    const controller = new CpuTurnController({ ply: () => 2, canQueue: () => true, current: () => true,
      playbackRunning: () => false, capture: () => 0, analyze: () => pending, apply,
      recover: () => fail('Cancelled replies must not restore old state'), paused: () => {},
      settled: () => {}, changed: () => {}, cancelRequest: () => {} });
    const run = controller.play(2); controller.cancel();
    resolve({ commands: [{ type: 'pass_turn' }], color: 'black' }); await run;
    expect(apply).not.toHaveBeenCalled(); expect(controller.thinking).toBeFalse(); expect(controller.error).toBe('');
  });

  it('rolls back partial execution and retains the outage after restoring a saved UI', async () => {
    let position = 0;
    const paused = jasmine.createSpy('paused');
    const controller = new CpuTurnController({ ply: () => 2, canQueue: () => true, current: () => true,
      playbackRunning: () => false, capture: () => position,
      analyze: async () => ({ color: 'black', commands: [{ type: 'make_move', from: '0,0', to: '1,0' }, { type: 'pass_turn' }] }),
      apply: async command => { position++; if (command.type === 'pass_turn') throw new Error('Rejected commit'); },
      recover: prior => { position = prior; controller.error = ''; controller.outageAt = 0; },
      paused, settled: () => {}, changed: () => {}, cancelRequest: () => {} });
    await controller.play(2);
    expect(position).toBe(0); expect(controller.error).toBe('Rejected commit'); expect(controller.outageAt).toBeGreaterThan(0);
    expect(paused).toHaveBeenCalledTimes(1); expect(controller.thinking).toBeFalse();
    controller.resume(); expect(controller.error).toBe(''); expect(controller.outageAt).toBe(0);
  });
  it('starts one analysis when a queued request is cancelled and requeued before the microtask runs', async () => {
    const analyze = jasmine.createSpy('analyze').and.resolveTo({ color: 'black', commands: [{ type: 'pass_turn' }] });
    const apply = jasmine.createSpy('apply').and.resolveTo();
    const settled = jasmine.createSpy('settled');
    const controller = new CpuTurnController({ ply: () => 2, canQueue: () => true, current: () => true,
      playbackRunning: () => false, capture: () => 0, analyze, apply,
      recover: () => fail('A valid CPU turn must not be rolled back'), paused: () => {},
      settled, changed: () => {}, cancelRequest: () => {} });
    controller.queue(); controller.queue(); controller.cancel(); controller.queue(); controller.queue();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(analyze).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1); expect(controller.thinking).toBeFalse();
  });

  it('does not restore an expired turn when its analysis later rejects', async () => {
    let reject!: (error: Error) => void;
    let ply = 2, position = 10;
    const pending = new Promise<never>((_, fail) => reject = fail);
    const paused = jasmine.createSpy('paused');
    const controller = new CpuTurnController({ ply: () => ply, canQueue: () => true, current: expected => ply === expected,
      playbackRunning: () => false, capture: () => position, analyze: () => pending,
      apply: async () => fail('A failed analysis cannot apply moves'), recover: prior => position = prior,
      paused, settled: () => {}, changed: () => {}, cancelRequest: () => {} });
    const run = controller.play(2);
    ply = 3; position = 20; reject(new Error('Late network failure')); await run;
    expect(position).toBe(20); expect(controller.error).toBe(''); expect(controller.outageAt).toBe(0);
    expect(paused).not.toHaveBeenCalled(); expect(controller.thinking).toBeFalse();
  });

  it('refuses incomplete, oversized and result-bearing batches before applying any command', async () => {
    const invalid: GameCommand[][] = [[], [{ type: 'make_move', from: '0,0', to: '1,0' }],
      [{ type: 'pass_turn' }, { type: 'pass_turn' }],
      [{ type: 'result', reason: 'resign' }, { type: 'pass_turn' }],
      [...Array.from({ length: 128 }, (): GameCommand => ({ type: 'pick_pair', id: 'warcry' })), { type: 'pass_turn' }]];
    for (const commands of invalid) {
      const apply = jasmine.createSpy('apply').and.resolveTo(), recover = jasmine.createSpy('recover');
      const controller = new CpuTurnController({ ply: () => 2, canQueue: () => true, current: () => true,
        playbackRunning: () => false, capture: () => 10, analyze: async () => ({ color: 'black', commands }), apply,
        recover, paused: () => {}, settled: () => {}, changed: () => {}, cancelRequest: () => {} });
      await controller.play(2);
      expect(apply).withContext(JSON.stringify(commands)).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledOnceWith(10); expect(controller.error).toContain('Invalid CPU turn');
    }
  });

});
