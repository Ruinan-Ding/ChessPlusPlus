import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class WebsocketService {
  private socket: WebSocket | null = null;
  private connectionStatusSubject = new BehaviorSubject<boolean>(false);
  private messagesSubject = new BehaviorSubject<any>(null);
  
  connectionStatus$ = this.connectionStatusSubject.asObservable();
  messages$ = this.messagesSubject.asObservable();

  constructor() {}

  connect(roomName: string = 'default'): void {
    this.disconnect();
    
    this.socket = new WebSocket(`ws://localhost:8000/ws/game/${roomName}/`);
    
    this.socket.onopen = () => {
      console.log('WebSocket connection established');
      this.connectionStatusSubject.next(true);
    };
    
    this.socket.onclose = () => {
      console.log('WebSocket connection closed');
      this.connectionStatusSubject.next(false);
    };
    
    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
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
  }

  sendMessage(message: any): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
    }
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}