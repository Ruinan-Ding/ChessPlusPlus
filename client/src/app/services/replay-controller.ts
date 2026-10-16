import { ReplayFrame, ReplaySession, REPLAY_CACHE_BYTES, REPLAY_MAX_FRAME_BYTES, replayFrameBytes } from './replay-session.service';
import type { ReplayAction } from './game-command';

interface ReplayHost {
  session(): ReplaySession | null;
  capture(): ReplayFrame;
  restore(frame: ReplayFrame): void;
  reset(): Promise<void>;
  render(): Promise<void>;
  execute(action: ReplayAction, animate: boolean): Promise<void>;
  disposed(): boolean;
  beforeSeek(): void;
  settled(): void;
  changed(): void;
}

/** Owns tape navigation, bounded checkpoints, rollback and cancellation; rendering is supplied by the room. */
export class ReplayController {
  busy = false;
  ready = false;
  playing = false;
  error = '';
  corruptions: string[] = [];
  readonly frames = new Map<number, ReplayFrame>();
  private skipped = new Set<number>();
  private frameSizes = new Map<number, number>();
  cacheSize = 0;
  private seekToken = 0;

  constructor(private host: ReplayHost) {}
  get actions(): ReplayAction[] { return this.host.session()?.branchActions ?? this.host.session()?.file.actions ?? []; }
  get cursor(): number { return this.host.session()?.cursor ?? 0; }
  get readOnly(): boolean { return !!this.host.session() && !this.host.session()!.branched; }
  get forwardEnabled(): boolean { return this.ready && !this.busy && this.readOnly && this.cursor < this.actions.length; }
  restoreSkipped(indices: number[]): void { this.skipped = new Set(indices); }

  clear(): void {
    this.frames.clear(); this.frameSizes.clear(); this.cacheSize = 0;
  }

  remember(cursor: number, frame: ReplayFrame): void {
    const bytes = replayFrameBytes(frame);
    this.cacheSize -= this.frameSizes.get(cursor) ?? 0;
    this.frameSizes.delete(cursor); this.frames.delete(cursor);
    if (bytes > REPLAY_MAX_FRAME_BYTES) return;
    while (this.frames.size && (this.frames.size >= 12 || this.cacheSize + bytes > REPLAY_CACHE_BYTES)) {
      const key = [...this.frames.keys()].find(index => index !== 0) ?? 0;
      this.cacheSize -= this.frameSizes.get(key) ?? 0;
      this.frameSizes.delete(key); this.frames.delete(key);
    }
    this.frames.set(cursor, frame); this.frameSizes.set(cursor, bytes); this.cacheSize += bytes;
  }

  branch(): void {
    const session = this.host.session();
    if (!session || this.busy || session.branched) return;
    this.playing = false;
    const skipped = new Set(session.skipped);
    session.branchActions = session.file.actions.slice(0, session.cursor).filter((_, i) => !skipped.has(i));
    this.skipped.clear();
    session.cursor = session.branchActions.length; session.skipped = []; session.branched = true;
    this.clear(); this.remember(session.cursor, this.host.capture());
    this.host.settled(); this.host.changed();
  }

  async navigate(kind: 'step-back' | 'step-next' | 'turn-back' | 'turn-next'): Promise<void> {
    if (this.busy || !this.ready) return;
    if (kind.endsWith('next') && !this.forwardEnabled) return;
    this.playing = false;
    const cursor = this.cursor, tape = this.actions;
    let target = kind === 'step-back' ? cursor - 1 : cursor + 1;
    if (kind === 'turn-next') {
      const next = tape.findIndex((action, i) => i >= cursor && (action.command.type === 'pass_turn' || action.command.type === 'result'));
      target = next < 0 ? tape.length : next > cursor ? next : (() => {
        const later = tape.findIndex((action, i) => i > cursor && (action.command.type === 'pass_turn' || action.command.type === 'result'));
        return later < 0 ? tape.length : later;
      })();
    } else if (kind === 'turn-back') {
      const endings = tape.map((action, i) => (action.command.type === 'pass_turn' || action.command.type === 'result') && i < cursor ? i : -1).filter(i => i >= 0);
      target = endings.at(-1) ?? 0;
    }
    await this.seek(Math.max(0, Math.min(tape.length, target)), true);
  }

  async toggleAutoplay(): Promise<void> {
    if (this.playing) { this.playing = false; return; }
    if (!this.forwardEnabled) return;
    this.playing = true;
    while (this.playing && this.readOnly && this.cursor < this.actions.length) {
      await this.seek(this.cursor + 1, true);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.playing = false; this.host.changed();
  }

  cancel(): void { this.playing = false; this.seekToken++; }

  async seek(target: number, animate: boolean): Promise<void> {
    const session = this.host.session();
    if (!session || this.busy) return;
    this.host.beforeSeek();
    this.busy = true;
    const token = ++this.seekToken;
    try {
      if (target < session.cursor) {
        const closest = [...this.frames.keys()].filter(i => i <= target).sort((a, b) => b - a)[0];
        if (closest !== undefined) {
          this.host.restore(this.frames.get(closest)!); session.cursor = closest;
          await this.host.render();
        } else {
          await this.host.reset();
          session.cursor = 0;
        }
      }
      while (session.cursor < target && token === this.seekToken && !this.host.disposed()) {
        const index = session.cursor, action = this.actions[index];
        const before = this.host.capture();
        let error = '';
        try {
          if (replayFrameBytes(before) > REPLAY_MAX_FRAME_BYTES) throw new Error('Replay state exceeds the 8 MiB processing limit.');
          await this.host.execute(action, animate && index === target - 1);
          if (replayFrameBytes(this.host.capture()) > REPLAY_MAX_FRAME_BYTES) {
            throw new Error('Replay state exceeds the 8 MiB processing limit.');
          }
        }
        catch (failure) {
          error = failure instanceof Error ? failure.message : 'Invalid action';
          this.host.restore(before); await this.host.render();
        }
        if (error) {
          const message = `Step ${index + 1}: ${error}`;
          if (!this.skipped.has(index)) {
            this.skipped.add(index); session.skipped.push(index);
            this.corruptions.push(message);
            if (this.corruptions.length > 100) this.corruptions.shift();
          }
          this.error = `Move corrupted (${session.skipped.length}). ${message}`;
        }
        session.cursor++;
        this.remember(session.cursor, this.host.capture());
        await new Promise(resolve => setTimeout(resolve));
      }
      if (session.branched) {
        session.branchActions = session.branchActions!.slice(0, session.cursor);
        session.skipped = session.skipped.filter(i => i < session.cursor);
        this.skipped = new Set(session.skipped);
        for (const key of this.frames.keys()) if (key > session.cursor) {
          this.cacheSize -= this.frameSizes.get(key) ?? 0;
          this.frameSizes.delete(key); this.frames.delete(key);
        }
      }
    } finally {
      this.busy = false;
      this.host.settled(); this.host.changed();
    }
  }

}
