import { Injectable } from '@angular/core';
import { websocketUrl } from './websocket.config';
import type { ReplayAction } from './replay-session.service';

export type CpuDifficulty = 'easy' | 'normal' | 'hard';
export type OpponentKind = 'myself' | 'cpu';

@Injectable({ providedIn: 'root' })
export class CpuService {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private pending?: { id: number; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

  think(config: any, actions: ReplayAction[], ply: number, color: string, difficulty: CpuDifficulty, seconds: number): Promise<any[]> {
    this.cancel(false);
    const id = ++this.sequence;
    const socket = this.socket ?? (this.socket = new WebSocket(websocketUrl('/ws/cpu/')));
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        if (this.pending?.id !== id) return;
        clearTimeout(this.pending.timer); this.pending = undefined;
        socket.onclose = null; socket.close(); this.socket = null;
        reject(new Error(message));
      };
      this.pending = { id, reject, timer: setTimeout(() => fail('CPU server did not respond. Please retry.'), 20000) };
      const send = () => socket.send(JSON.stringify({ type: 'think', id, config, actions, ply, color, difficulty,
        budget: Math.max(0.01, Math.min(5, seconds || 5)) }));
      if (socket.readyState === WebSocket.OPEN) send();
      else socket.onopen = send;
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.id !== undefined && message.id !== id) return;
          if (message.type === 'cpu_error') { fail(message.message); return; }
          if (message.type !== 'cpu_turn' || message.ply !== ply || !Array.isArray(message.commands)) { fail('Invalid CPU response.'); return; }
          if (this.pending?.id !== id) return;
          clearTimeout(this.pending.timer); this.pending = undefined;
          resolve(message.commands);
        } catch { fail('Invalid CPU response.'); }
      };
      socket.onerror = () => fail('CPU server is unavailable.');
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        fail('CPU server disconnected.');
      };
    });
  }

  cancel(close = false): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel' }));
      this.pending.reject(new Error('CPU request cancelled.'));
      this.pending = undefined;
    }
    if (this.socket && (close || this.socket.readyState !== WebSocket.OPEN)) {
      this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null;
      this.socket.close(); this.socket = null;
    }
  }
}
