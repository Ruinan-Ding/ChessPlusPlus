import { GameCommand, UnitColor, REPLAY_COMMANDS } from './game-command';

interface CpuHost<Checkpoint> {
  ply(): number;
  canQueue(): boolean;
  current(ply: number): boolean;
  playbackRunning(): boolean;
  capture(): Checkpoint;
  analyze(ply: number): Promise<{ commands: GameCommand[]; color: UnitColor }>;
  apply(command: GameCommand, ply: number, color: UnitColor): Promise<void>;
  recover(checkpoint: Checkpoint): void;
  paused(): void;
  settled(): void;
  changed(): void;
  cancelRequest(): void;
}

/** Keeps queued/late CPU replies and recovery state independent of the room view. */
export class CpuTurnController<Checkpoint> {
  thinking = false;
  executing = false;
  error = '';
  outageAt = 0;
  manualTurn = false;
  private generation = 0;
  private queuedPly = -1;
  constructor(private host: CpuHost<Checkpoint>) {}

  cancel(): void {
    this.generation++; this.queuedPly = -1;
    this.thinking = false; this.executing = false; this.error = '';
    this.host.cancelRequest();
  }

  queue(): void {
    if (!this.host.canQueue() || this.thinking || this.error) return;
    const ply = this.host.ply();
    if (this.queuedPly === ply) return;
    this.queuedPly = ply;
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      if (this.queuedPly === ply && this.host.canQueue()) void this.play(ply);
      else if (this.queuedPly === ply) this.queuedPly = -1;
    });
  }

  async play(ply: number): Promise<void> {
    const generation = ++this.generation, prior = this.host.capture();
    const current = () => generation === this.generation && this.host.current(ply);
    this.thinking = true; this.host.changed();
    try {
      const { commands, color } = await this.host.analyze(ply);
      if (!current()) return;
      while (this.host.playbackRunning()) {
        if (!current()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (commands.length > 128 || commands.some(command => !command || !REPLAY_COMMANDS.has(command.type) || command.type === 'result')) throw new Error('Invalid CPU turn commands.');
      if (commands.at(-1)?.type !== 'pass_turn' || commands.slice(0, -1).some(command => command.type === 'pass_turn')) throw new Error('Invalid CPU turn.');
      for (const command of commands) {
        if (!current()) return;
        await this.host.apply(command, ply, color);
      }
    } catch (error) {
      if (!current()) return;
      this.executing = false;
      this.host.recover(prior);
      this.error = error instanceof Error && error.message ? error.message : 'CPU analysis failed. Please retry.';
      this.outageAt = Date.now();
      this.host.paused();
    } finally {
      if (generation === this.generation) {
        this.executing = false; this.thinking = false;
        this.host.settled(); this.host.changed();
      }
    }
  }

  /** Returning the pause duration keeps the clock itself in the room's existing clock code. */
  resume(): number {
    const elapsed = this.outageAt ? Date.now() - this.outageAt : 0;
    this.outageAt = 0; this.error = ''; this.queuedPly = -1;
    return elapsed;
  }
}
