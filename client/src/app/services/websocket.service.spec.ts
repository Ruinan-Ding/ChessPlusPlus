import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { WebsocketService } from './websocket.service';

/**
 * A socket that never finishes its handshake - what you get from a dead
 * server, and what Chrome hands you for minutes once it starts throttling
 * repeated failed handshakes. The service must not sit on it forever: the
 * connection dialog counts attempts and only offers Retry once they run out.
 */
class StalledSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: StalledSocket[] = [];

  readyState = StalledSocket.CONNECTING;
  onopen: any = null;
  onclose: any = null;
  onerror: any = null;
  onmessage: any = null;

  constructor(public url: string) {
    StalledSocket.instances.push(this);
  }

  close(): void {
    this.readyState = StalledSocket.CLOSED;
  }

  send(): void { /* never open, never sends */ }
}

describe('WebsocketService reconnect escalation', () => {
  let service: WebsocketService;
  let realWebSocket: any;

  beforeEach(() => {
    sessionStorage.removeItem('cpp.localGame');
    localStorage.removeItem('cpp.localGame.v1');
    realWebSocket = (window as any).WebSocket;
    StalledSocket.instances = [];
    (window as any).WebSocket = StalledSocket;
    jasmine.clock().install();

    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { navigate: () => Promise.resolve(true) } }],
    });
    service = TestBed.inject(WebsocketService);
  });

  afterEach(() => {
    jasmine.clock().uninstall();
    (window as any).WebSocket = realWebSocket;
  });

  /** One attempt = the handshake timeout plus the wait before the next try. */
  const runAttempts = (n: number) => {
    for (let i = 0; i < n; i++) jasmine.clock().tick(3000 + 3000);
  };

  it('counts a stalled handshake as a failed attempt instead of hanging', () => {
    let attempts = 0;
    service.reconnectAttempts$.subscribe(n => (attempts = n));

    service.connect('lobby');
    expect(StalledSocket.instances.length).toBe(1);
    expect(attempts).toBe(0);

    runAttempts(1);
    expect(attempts).toBe(1);
    expect(StalledSocket.instances.length).toBe(2); // it tried again
  });

  it('reports failure once the attempts run out, so Retry can be offered', () => {
    let failed = false;
    let connected = true;
    service.connectionFailed$.subscribe(f => (failed = f));
    service.connectionStatus$.subscribe(c => (connected = c));

    service.connect('lobby');
    runAttempts(5);
    expect(failed).toBeFalse(); // still trying

    runAttempts(1);
    expect(failed).toBeTrue();
    expect(connected).toBeFalse(); // never claims a server that isn't there
  });

  it('stays put once the player chooses offline, until they ask to reconnect', () => {
    service.connect('lobby');
    runAttempts(1);
    const before = StalledSocket.instances.length;

    service.playOffline();
    // Everything that would normally reach for a socket: navigating into the
    // lobby, sending, waiting out the retry timers.
    service.connect('lobby');
    service.sendMessage({ type: 'join_lobby', username: 'x' });
    runAttempts(3);

    expect(StalledSocket.instances.length).toBe(before);
    expect(service.isOffline()).toBeTrue();

    service.reconnectToServer();
    expect(StalledSocket.instances.length).toBe(before + 1);
    expect(service.isOffline()).toBeFalse();
  });

  it('leaves a handshake already in flight alone', () => {
    // login, the lobby and the game room all ask for a connection. Tearing
    // down the socket each time is how a connection stays forever pending.
    service.connect('lobby');
    service.connect('lobby');
    service.connect('lobby');

    expect(StalledSocket.instances.length).toBe(1);
  });

  it('lets go of a socket completely when switching rooms', () => {
    service.connect('lobby');
    const first = StalledSocket.instances[0];

    service.connect('game-1');

    // Its close fires later; wired up, it would clear the new handshake's
    // timeout and report the live connection down.
    expect(first.onclose).toBeNull();
    expect(first.readyState).toBe(StalledSocket.CLOSED);
    expect(StalledSocket.instances.length).toBe(2);
  });

  it('caps the backlog and never queues a heartbeat', () => {
    service.connect('lobby');  // connecting, never open: everything queues
    for (let i = 0; i < 50; i++) {
      service.sendMessage({ type: 'chat_message', content: `m${i}` });
    }
    service.sendMessage({ type: 'heartbeat', timestamp: 'now' });

    const queue: any[] = (service as any).sendQueue;
    expect(queue.length).toBe(32);
    expect(queue.some(m => m.type === 'heartbeat')).toBeFalse();
    // The oldest go first, so what survives is what the player did last.
    expect(queue[queue.length - 1].content).toBe('m49');
  });

  it('keeps after the server while a local game runs - solo is not offline', () => {
    service.connect('lobby');
    runAttempts(2);
    const before = StalledSocket.instances.length;

    service.startLocalGame();
    runAttempts(3);

    // A solo game needs no server but does not refuse one: the lobby roster
    // and lobby chat are still the server's to answer.
    expect(StalledSocket.instances.length).toBeGreaterThan(before);
    expect(service.isLocal()).toBeTrue();
    expect(service.isOffline()).toBeFalse();
    expect(service.isConnected()).toBeTrue(); // local can still take messages
  });
});
