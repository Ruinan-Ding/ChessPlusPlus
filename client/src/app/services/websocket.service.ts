import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { WEBSOCKET_CONFIG } from './websocket.config';
import { Router } from '@angular/router';

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private socket: WebSocket | null = null;
  private connectionStatusSubject = new BehaviorSubject<boolean>(false);
  private messagesSubject = new BehaviorSubject<any>(null);
  private reconnectingSubject = new BehaviorSubject<boolean>(false);
  private reconnectAttemptsSubject = new BehaviorSubject<number>(0);
  private connectionFailedSubject = new BehaviorSubject<boolean>(false);
  
  private maxReconnectAttempts = 5;
  private reconnectInterval = 3000; // 3 seconds
  private reconnectTimeout: any = null;
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

  constructor(private router: Router) {}

  /**
   * Get the current connection status value without subscribing
   */
  isConnected(): boolean {
    return this.connectionStatusSubject.value;
  }

  connect(roomName: string = 'default'): void {
    console.log(`[WebSocket.connect] Connecting to room: ${roomName}`);
    
    // Only disconnect if we're switching rooms or the existing socket isn't open
    const isActiveConnection = this.socket && this.socket.readyState === WebSocket.OPEN;
    
    if (this.currentRoomName !== roomName || !isActiveConnection) {
      this.disconnect();
      this.currentRoomName = roomName;
    } else {
      console.log(`[WebSocket.connect] Already connected to room: ${roomName}`);
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
    
    try {
      const { protocol, hostname } = window.location;
      const wsProtocol = protocol === 'https:' ? 'wss' : 'ws';
      const backendPort = WEBSOCKET_CONFIG.BACKEND_PORT;
      const wsUrl = `${wsProtocol}://${hostname}:${backendPort}/ws/game/${roomName}/`;
      console.log(`[WebSocket] Attempting to connect to: ${wsUrl}`);
      this.socket = new WebSocket(wsUrl);
      
      this.socket.onopen = () => {
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
        this.connectionStatusSubject.next(false);
        
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
    try {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      } else {
        // Queue messages while connecting/reconnecting so UI actions are not lost
        console.log('[WebSocket] Socket not open, queueing message');
        this.sendQueue.push(message);
        if (!this.socket) {
          this.connect(this.currentRoomName);
        }
      }
    } catch (err) {
      console.error('[WebSocket] Error sending message:', err);
    }
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    this.reconnectingSubject.next(false);
    
    if (this.socket) {
      try {
        this.socket.close(1000); // Normal closure
      } catch (error) {
        console.error('Error closing WebSocket:', error);
      }
      this.socket = null;
    }
    this.stopHeartbeat();
  }
  
  // Getter for the current room name (for the ConnectionDialogComponent)
  getCurrentRoom(): string {
    return this.currentRoomName;
  }
}