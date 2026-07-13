import { Injectable } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { SharedDataService, ChatMessage } from './shared-data.service';
import { WebsocketService } from './websocket.service';


@Injectable({
  providedIn: 'root'
})
export class LobbyService {
  private messagesSubject = new BehaviorSubject<any | null>(null);
  private connectionSub: Subscription | null = null;
  private messagesSub: Subscription | null = null;

  // Public observable for components that need raw lobby events
  messages$ = this.messagesSubject.asObservable();

  constructor(private shared: SharedDataService, private wsService: WebsocketService) {}

  connect(username: string): void {
    this.wsService.connect('lobby');

    this.connectionSub = this.wsService.connectionStatus$.subscribe(connected => {
      if (connected) {
        this.sendMessage({ type: 'join_lobby', username });
      }
    });

    this.messagesSub = this.wsService.messages$.subscribe(data => {
      if (!data) return;
      try {
        if (data.type === 'chat_message') {
          const msg: ChatMessage = {
            username: data.username,
            content: data.content,
            timestamp: data.timestamp || new Date().toISOString(),
            room: 'lobby'
          };
          this.shared.addLobbyMessage(msg);
        } else if (data.type === 'user_list' || data.type === 'lobby_user_list') {
          this.shared.updateLobbyUsers(data.users || []);
        } else if (data.type === 'username_changed') {
          this.shared.addLobbyMessage({ username: 'System', content: `${data.oldUsername} has changed their name to ${data.newUsername}.`, timestamp: new Date().toISOString(), type: 'system', room: 'lobby' });
        } else if (data.type === 'user_joined') {
          this.shared.addLobbyMessage({ username: 'System', content: `${data.username} has joined the lobby.`, timestamp: new Date().toISOString(), type: 'system', room: 'lobby' });
        } else if (data.type === 'user_left') {
          this.shared.addLobbyMessage({ username: 'System', content: `${data.username} has left the lobby.`, timestamp: new Date().toISOString(), type: 'system', room: 'lobby' });
        }

        this.messagesSubject.next(data);
      } catch (err) {
        console.error('LobbyService: failed to handle message', err);
      }
    });
  }

  sendMessage(message: any): void {
    this.wsService.sendMessage(message);
  }

  /**
   * Check if the lobby WebSocket is currently connected
   */
  isConnected(): boolean {
    return this.wsService.isConnected();
  }

  disconnect(): void {
    if (this.connectionSub) {
      this.connectionSub.unsubscribe();
      this.connectionSub = null;
    }
    if (this.messagesSub) {
      this.messagesSub.unsubscribe();
      this.messagesSub = null;
    }
    this.wsService.sendMessage({ type: 'leave_lobby', username: localStorage.getItem('username') || '' });
    this.wsService.disconnect();
  }
}
