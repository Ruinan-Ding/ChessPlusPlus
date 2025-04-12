import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
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
  
  // Public Observables
  connectionStatus$ = this.connectionStatusSubject.asObservable();
  messages$ = this.messagesSubject.asObservable();
  reconnecting$ = this.reconnectingSubject.asObservable();
  reconnectAttempts$ = this.reconnectAttemptsSubject.asObservable();
  connectionFailed$ = this.connectionFailedSubject.asObservable();

  constructor(private router: Router) {}

  connect(roomName: string = 'default'): void {
    this.disconnect();
    
    this.currentRoomName = roomName;
    this.reconnectAttemptsSubject.next(0);
    this.connectionFailedSubject.next(false);
    
    this.createSocket(roomName);
  }

  private createSocket(roomName: string): void {
    // Force reconnecting to be false when creating a new socket
    this.reconnectingSubject.next(false);
    
    try {
      this.socket = new WebSocket(`ws://localhost:8000/ws/game/${roomName}/`);
      
      this.socket.onopen = () => {
        console.log('WebSocket connection established');
        this.connectionStatusSubject.next(true);
        this.reconnectingSubject.next(false);
        this.reconnectAttemptsSubject.next(0);
        this.connectionFailedSubject.next(false);
      };
      
      this.socket.onclose = (event) => {
        console.log('WebSocket connection closed', event);
        this.connectionStatusSubject.next(false);
        
        // Don't try to reconnect if we closed intentionally (code 1000)
        if (event.code !== 1000) {
          this.attemptReconnect();
        }
      };
      
      this.socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        // The onclose handler will be called after this
      };
      
      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Message received:', data);
          this.messagesSubject.next(data);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      this.connectionStatusSubject.next(false);
      this.attemptReconnect();
    }
  }

  private attemptReconnect(): void {
    // Clear any existing reconnect timeout
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
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected, cannot send message');
    }
  }

  disconnect(): void {
    // Clear any reconnect timeout
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
  }
  
  // Getter for the current room name (for the ConnectionDialogComponent)
  getCurrentRoom(): string {
    return this.currentRoomName;
  }
}