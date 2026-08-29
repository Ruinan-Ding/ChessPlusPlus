import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { WEBSOCKET_CONFIG } from './websocket.config';
import { LocalGameService } from './local-game.service';
import { readStore, removeStore, writeStore } from './storage';

/** How many messages may wait out an outage before the oldest are dropped. */
const MAX_QUEUED = 32;

/** What a running solo game answers itself, however the server is doing. */
const LOCAL_GAME_TYPES = new Set([
  'create_single_player_game', 'join_game_room', 'leave_game_room', 'request_game_state',
  'start_game', 'make_move', 'pass_turn', 'resign', 'offer_draw', 'change_game_mode',
  'game_room_message',
]);

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private socket: WebSocket | null = null;
  private connectionStatusSubject = new BehaviorSubject<boolean>(false);
  // A plain Subject, deliberately: a BehaviorSubject replays its last value
  // to every new subscriber, so a component entering a room would re-handle
  // whatever message happened to arrive before it existed.
  private messagesSubject = new Subject<any>();
  private reconnectingSubject = new BehaviorSubject<boolean>(false);
  private reconnectAttemptsSubject = new BehaviorSubject<number>(0);
  private connectionFailedSubject = new BehaviorSubject<boolean>(false);
  private offlineSubject = new BehaviorSubject<boolean>(false);

  // A single-player game, answered by LocalGameService instead of the server.
  // It survives a reload so a refresh resumes the game. This says nothing
  // about the socket: a solo game is not a reason to leave the server, and
  // while one is up the lobby roster and lobby chat stay live.
  private localGame = false;
  // Offline: the player chose to stop chasing the server. No socket is opened
  // and no reconnect runs until they ask for one, so entering the lobby or
  // typing a username never drags the connection dialog back up.
  private offline = false;
  
  private maxReconnectAttempts = 5;
  private reconnectInterval = 3000; // 3 seconds
  private reconnectTimeout: any = null;
  /**
   * Give up on a handshake that never resolves. Chrome throttles repeated
   * failed WebSocket handshakes to the same host, so a later attempt can sit
   * "connecting" for minutes - without this the dialog stuck on "Attempt 5 of
   * 5" forever and the Retry button never appeared.
   */
  private connectTimeoutMs = 3000;
  private connectTimeout: any = null;
  private currentRoomName: string = 'default';
  private sendQueue: any[] = [];
  private heartbeatInterval = WEBSOCKET_CONFIG.HEARTBEAT_INTERVAL_MS; // 15s default
  private heartbeatTimer: any = null;
  
  // Public Observables
  connectionStatus$ = this.connectionStatusSubject.asObservable();
  messages$ = this.messagesSubject.asObservable();
  reconnecting$ = this.reconnectingSubject.asObservable();
  reconnectAttempts$ = this.reconnectAttemptsSubject.asObservable();
  connectionFailed$ = this.connectionFailedSubject.asObservable();
  /** True while we are deliberately not talking to a server at all. */
  offline$ = this.offlineSubject.asObservable();

  constructor(private local: LocalGameService) {
    this.localGame = readStore('session', 'cpp.localGame') === '1';
    this.offline = readStore('session', 'cpp.offline') === '1';
    this.local.messages$.subscribe(msg => this.messagesSubject.next(msg));
    if (this.offline) this.goLocal();
  }

  isLocal(): boolean {
    return this.localGame;
  }

  /** True while we are deliberately not talking to a server. */
  isOffline(): boolean {
    return this.offline;
  }

  /**
   * Stop chasing the server and carry on without it. Nothing reconnects until
   * `reconnectToServer()` - the Reconnect button next to the status line.
   */
  playOffline(): void {
    this.offline = true;
    writeStore('session', 'cpp.offline', '1');
    this.goLocal();
  }

  /**
   * Route a single-player game locally - it needs no room and no token. The
   * socket is left alone: solo play works without a server but does not
   * require going without one, and the lobby still wants its roster.
   */
  startLocalGame(): void {
    this.localGame = true;
    writeStore('session', 'cpp.localGame', '1');
    // The solo room has no server counterpart, so the socket belongs to the
    // lobby while it runs.
    if (!this.offline) this.connect('lobby');
  }

  /** Leaving the solo room: the server (or the attempt to reach it) is back. */
  endLocalGame(): void {
    this.localGame = false;
    removeStore('session', 'cpp.localGame');
    this.local.clear();
  }

  /**
   * Give the server another try. A solo game in progress is left alone: it
   * never needed the server and does not end because one turned up, so this
   * only stops the deliberate silence. connect() puts the socket on the
   * lobby while a solo room is open.
   */
  reconnectToServer(): void {
    this.offline = false;
    removeStore('session', 'cpp.offline');
    this.offlineSubject.next(false);
    this.connect(this.currentRoomName);
  }

  /** Close the socket; the local engine answers from here on. */
  private goLocal(): void {
    this.disconnect();
    this.offlineSubject.next(true);
    this.reconnectingSubject.next(false);
    this.connectionFailedSubject.next(false);
    this.connectionStatusSubject.next(false);
  }

  /**
   * Get the current connection status value without subscribing
   */
  isConnected(): boolean {
    // "Can I send?" - local mode can, with no socket at all. The status
    // subject stays an honest report of the socket, so the UI never claims a
    // server connection that does not exist.
    return this.isLocal() || this.connectionStatusSubject.value;
  }

  connect(roomName: string = 'default'): void {
    // A solo game lives in no server room, so its socket sits in the lobby.
    if (this.localGame) roomName = 'lobby';
    if (this.offline) {
      // Deliberately not connected: remember the room and stay put.
      this.currentRoomName = roomName;
      return;
    }
    console.log(`[WebSocket.connect] Connecting to room: ${roomName}`);
    
    // A handshake in flight counts as active: tearing it down and starting
    // over is how repeated connect() calls - login, lobby, the game room -
    // could keep a connection permanently three seconds from ready.
    const state = this.socket?.readyState;
    const isActiveConnection = state === WebSocket.OPEN || state === WebSocket.CONNECTING;

    if (this.currentRoomName !== roomName || !isActiveConnection) {
      this.disconnect();
      this.currentRoomName = roomName;
    } else {
      console.log(`[WebSocket.connect] Already on room: ${roomName}`);
      return;
    }
    
    this.reconnectAttemptsSubject.next(0);
    this.connectionFailedSubject.next(false);
    
    if (this.connectionStatusSubject.value !== false) {
      this.connectionStatusSubject.next(false);
    }
    
    this.createSocket(roomName);
  }

  private createSocket(roomName: string): void {
    this.reconnectingSubject.next(false);
    // Whatever was here is being replaced; let go of it properly so it cannot
    // fire events for its successor.
    this.abandon(this.socket);
    this.socket = null;

    try {
      const { protocol, hostname } = window.location;
      const wsProtocol = protocol === 'https:' ? 'wss' : 'ws';
      const backendPort = WEBSOCKET_CONFIG.BACKEND_PORT;
      const wsUrl = `${wsProtocol}://${hostname}:${backendPort}/ws/game/${roomName}/`;
      console.log(`[WebSocket] Attempting to connect to: ${wsUrl}`);
      this.socket = new WebSocket(wsUrl);

      this.connectTimeout = setTimeout(() => {
        const stalled = this.socket;
        if (!stalled || stalled.readyState === WebSocket.OPEN) return;
        console.log('[WebSocket] Handshake timed out, counting it as a failed attempt');
        // Detach first: this socket's own onclose must not double-count.
        this.abandon(stalled);
        this.socket = null;
        this.connectionStatusSubject.next(false);
        if (!this.isOffline()) this.attemptReconnect();
      }, this.connectTimeoutMs);

      this.socket.onopen = () => {
        this.clearConnectTimeout();
        console.log('[WebSocket] Connection established');
        this.connectionStatusSubject.next(true);
        this.reconnectingSubject.next(false);
        this.reconnectAttemptsSubject.next(0);
        this.connectionFailedSubject.next(false);
        this.startHeartbeat();
        // Flush any queued messages that were sent while connecting
        if (this.sendQueue.length) {
          console.log(`[WebSocket] Flushing ${this.sendQueue.length} queued messages`);
          while (this.sendQueue.length && this.socket && this.socket.readyState === WebSocket.OPEN) {
            const queued = this.sendQueue.shift();
            try {
              this.socket.send(JSON.stringify(queued));
            } catch (err) {
              console.error('[WebSocket] Error sending queued message', err);
              // Put it back and break to avoid tight loop
              this.sendQueue.unshift(queued);
              break;
            }
          }
        }
      };
      
      this.socket.onclose = (event) => {
        console.log('[WebSocket] Connection closed', event.code, event.reason);
        this.clearConnectTimeout();
        this.connectionStatusSubject.next(false);
        // Offline is a choice: don't spin up reconnect attempts behind it.
        if (this.isOffline()) {
          this.stopHeartbeat();
          return;
        }
        
        // Don't try to reconnect if we closed intentionally (code 1000)
        // Also don't try to reconnect if we were force disconnected by server (code 4000)
        if (event.code !== 1000 && event.code !== 4000) {
          this.attemptReconnect();
        } else if (event.code === 4000) {
          console.log('Forced disconnect from server - another session took over');
        }
        this.stopHeartbeat();
      };
      
      this.socket.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        // The onclose handler will be called after this
      };
      
      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[WebSocket] Message received:', data);
          
          if (data.type === 'force_disconnect') {
            console.log('[WebSocket] Forced disconnect from server:', data.message);
            // The connection will be closed by the server immediately after this
            return;
          }
          
          this.messagesSubject.next(data);
        } catch (error) {
          console.error('[WebSocket] Error parsing message:', error);
        }
      };
    } catch (error) {
      console.error('[WebSocket] Error creating WebSocket:', error);
      this.connectionStatusSubject.next(false);
      this.attemptReconnect();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendMessage({ type: 'heartbeat', timestamp: new Date().toISOString() });
      } catch (err) {
        console.error('[WebSocket] Heartbeat send failed', err);
      }
    }, this.heartbeatInterval);
    console.log('[WebSocket] Heartbeat started');
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[WebSocket] Heartbeat stopped');
    }
  }

  /**
   * Let go of a socket for good: its handlers are detached before it closes.
   * A close event fires asynchronously, so a socket left wired up can still
   * run its onclose *after* its replacement has opened - clearing the new
   * handshake timeout, stopping the new heartbeat and reporting the whole
   * connection down while it is in fact up.
   */
  private abandon(socket: WebSocket | null): void {
    if (!socket) return;
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    try { socket.close(1000); } catch { /* already dead */ }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    const currentAttempts = this.reconnectAttemptsSubject.value;
    
    if (currentAttempts < this.maxReconnectAttempts) {
      this.reconnectingSubject.next(true);
      this.reconnectAttemptsSubject.next(currentAttempts + 1);
      
      console.log(`Attempting to reconnect (${currentAttempts + 1}/${this.maxReconnectAttempts})...`);
      
      this.reconnectTimeout = setTimeout(() => {
        this.createSocket(this.currentRoomName);
      }, this.reconnectInterval);
    } else {
      console.log('Max reconnect attempts reached. Connection failed.');
      this.reconnectingSubject.next(false);
      this.connectionFailedSubject.next(true);
    }
  }

  sendMessage(message: any): void {
    // A solo game is answered locally even with a server on the line; only
    // its own traffic is, though - lobby roster and lobby chat are the
    // server's to answer whenever it is there.
    if (this.localGame && (this.offline || LOCAL_GAME_TYPES.has(message?.type))) {
      this.local.send(message);
      if (message?.type === 'leave_game_room') this.endLocalGame();
      return;
    }
    if (this.offline) {
      // No server and no local game: drop it rather than queue it up to be
      // flushed at some surprising later moment.
      console.log('[WebSocket] Offline, dropping message', message?.type);
      return;
    }
    try {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      } else if (message?.type === 'heartbeat') {
        // Presence is about now. A heartbeat delivered late says nothing.
        return;
      } else {
        // Queue messages while connecting/reconnecting so UI actions are not lost
        console.log('[WebSocket] Socket not open, queueing message');
        this.sendQueue.push(message);
        // A long outage must not build a backlog that all lands at once when
        // the server returns: the oldest intentions are the stalest.
        if (this.sendQueue.length > MAX_QUEUED) {
          const dropped = this.sendQueue.shift();
          console.log('[WebSocket] Send queue full, dropping', dropped?.type);
        }
        if (!this.socket) {
          this.connect(this.currentRoomName);
        }
      }
    } catch (err) {
      console.error('[WebSocket] Error sending message:', err);
    }
  }

  disconnect(): void {
    this.clearConnectTimeout();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    this.reconnectingSubject.next(false);
    
    if (this.socket) {
      this.abandon(this.socket);
      this.socket = null;
      // Nothing will report the close now that the handlers are gone, and a
      // deliberate disconnect is still a disconnect.
      this.connectionStatusSubject.next(false);
    }
    this.stopHeartbeat();
  }
  
  // Getter for the current room name (for the ConnectionDialogComponent)
  getCurrentRoom(): string {
    return this.currentRoomName;
  }
}