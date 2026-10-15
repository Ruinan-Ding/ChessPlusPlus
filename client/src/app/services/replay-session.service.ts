import { CommandInput, ReplayAction, replayCommand } from './game-command';
import { Injectable } from '@angular/core';
import { ConfigService } from './config.service';
import { readStore, writeStore } from './storage';
import { migrateConfig } from './game-rules';

export { replayCommand, REPLAY_COMMANDS } from './game-command';
export type { ReplayAction, RecordedAction } from './game-command';
export type ReplayCommand = CommandInput;
export interface ReplayFile {
  type: 'chessplusplus-replay';
  version: 1;
  config: any;
  players: { white: string; black: string };
  actions: ReplayAction[];
}
export interface ReplayFrame { core: any; ui: any; }
export interface ReplaySession {
  file: ReplayFile;
  cursor: number;
  branched: boolean;
  skipped: number[];
  branchActions?: ReplayAction[];
  frame?: ReplayFrame;
}

export const REPLAY_MAX_BYTES = 20 * 1024 * 1024;
export const REPLAY_MAX_ACTIONS = 100000;
export const REPLAY_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const REPLAY_CACHE_BYTES = 16 * 1024 * 1024;
export const replayFrameBytes = (frame: ReplayFrame): number => JSON.stringify(frame).length * 2;
export function parseReplay(text: string, configService: ConfigService): ReplayFile {
  if (new TextEncoder().encode(text).length > REPLAY_MAX_BYTES) throw new Error('Replay exceeds 20 MiB.');
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') { if (++depth > 64) throw new Error('Replay nesting exceeds 64.'); }
    else if (c === '}' || c === ']') depth--;
  }
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error('Replay is not valid JSON.'); }
  if (raw?.type !== 'chessplusplus-replay' || raw.version !== 1) throw new Error('Unsupported replay format.');
  if (!Array.isArray(raw.actions) || raw.actions.length > REPLAY_MAX_ACTIONS) throw new Error('Invalid replay action count.');
  if (!raw.players || !['white', 'black'].every(side => typeof raw.players[side] === 'string'
      && raw.players[side].length > 0 && raw.players[side].length <= 256)) throw new Error('Invalid replay player names.');
  if (!raw.config || typeof raw.config !== 'object' || Array.isArray(raw.config)) throw new Error('Replay configuration is missing.');
  const config = migrateConfig(raw.config);
  const check = configService.validateGameRules(config);
  if (!check.valid) throw new Error('Invalid replay configuration: ' + check.errors?.join('; '));
  return { type: 'chessplusplus-replay', version: 1, config,
    players: { white: raw.players.white, black: raw.players.black },
    actions: raw.actions.map((a: any) => ({ ply: a?.ply, color: a?.color, command: replayCommand(a?.command) })) };
}

export function downloadReplay(file: ReplayFile): void {
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'chessplusplus-replay.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

@Injectable({ providedIn: 'root' })
export class ReplaySessionService {
  session: ReplaySession | null = null;
  storageError = '';
  private writes: Promise<void> = Promise.resolve();
  private sessionKey = '';
  private pending?: { key: string; state: any };
  private saving = false;

  async open(file: ReplayFile): Promise<void> {
    await this.writes;
    const key = crypto.randomUUID();
    const session: ReplaySession = { file: structuredClone(file), cursor: 0, branched: false, skipped: [] };
    const { file: archive, ...state } = session;
    await this.transaction('readwrite', store => [store.put(archive, key + '/file'), store.put(state, key + '/state')]);
    this.session = session; this.sessionKey = key;
    writeStore('session', 'cpp.replaySessionId', key);
  }

  async restore(): Promise<void> {
    const key = readStore('session', 'cpp.replaySessionId');
    if (!key) { this.session = null; return; }
    const [saved, file] = await this.transaction('readonly', store => [store.get(key + '/state'), store.get(key + '/file')]);
    this.session = saved && file ? { ...saved, file } : null;
    this.sessionKey = key;
  }

  save(): Promise<void> {
    if (!this.session || !this.sessionKey) return Promise.resolve();
    const { file, ...state } = this.session;
    this.pending = { key: this.sessionKey, state: structuredClone(state) };
    if (!this.saving) {
      this.saving = true;
      this.writes = this.writes.then(async () => {
        try {
          while (this.pending) {
            const next = this.pending; this.pending = undefined;
            try {
              await this.transaction('readwrite', store => store.put(next.state, next.key + '/state'));
              this.storageError = '';
            } catch { this.storageError = 'Replay session could not be saved. Download it before leaving.'; }
          }
        } finally { this.saving = false; }
      });
    }
    return this.writes;
  }

  private transaction(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest | IDBRequest[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open('cpp.replay.v1', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('sessions');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('sessions', mode);
        const request = operation(tx.objectStore('sessions'));
        tx.oncomplete = () => { db.close(); resolve(Array.isArray(request) ? request.map(item => item.result) : request.result); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
}
