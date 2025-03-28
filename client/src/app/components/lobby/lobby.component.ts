import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { WebsocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';

interface ChatMessage {
  type: string;
  username: string;
  content: string;
  timestamp: string;
}

interface User {
  username: string;
  status: 'online' | 'in-game';
}

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="lobby-container">
      <div class="lobby-header">
        <h2>Game Lobby</h2>
        <div class="user-info">
          <span>Logged in as: <strong>{{ username }}</strong></span>
          <button (click)="logout()" class="logout-button">Logout</button>
        </div>
      </div>
      
      <div class="lobby-content">
        <div class="online-users">
          <h3>Online Players</h3>
          <div class="users-list">
            <div *ngFor="let user of onlineUsers" class="user-item">
              <span>{{ user.username }}</span>
              <button 
                *ngIf="user.username !== username && user.status === 'online'"
                (click)="challengePlayer(user.username)" 
                class="challenge-button"
              >
                Challenge
              </button>
              <span *ngIf="user.status === 'in-game'" class="in-game-badge">In Game</span>
            </div>
            <div *ngIf="onlineUsers.length === 0" class="no-users">
              No players online
            </div>
          </div>
        </div>
        
        <div class="chat-area">
          <div class="chat-messages">
            <div *ngFor="let message of chatMessages" class="message">
              <span class="message-time">[{{ message.timestamp }}]</span>
              <span class="message-author">{{ message.username }}:</span>
              <span class="message-content">{{ message.content }}</span>
            </div>
            <div *ngIf="chatMessages.length === 0" class="no-messages">
              No messages yet. Start the conversation!
            </div>
          </div>
          <div class="chat-input">
            <input 
              type="text" 
              [(ngModel)]="newMessage" 
              placeholder="Type a message..." 
              (keyup.enter)="sendMessage()"
            />
            <button (click)="sendMessage()" [disabled]="!newMessage.trim()">Send</button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .lobby-container {
      max-width: 1000px;
      margin: 20px auto;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      background-color: white;
    }
    
    .lobby-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid #eee;
    }
    
    .user-info {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    
    .logout-button {
      padding: 8px 12px;
      background-color: #e74c3c;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .lobby-content {
      display: flex;
      gap: 20px;
      height: 500px;
    }
    
    .online-users {
      width: 30%;
      border: 1px solid #eee;
      border-radius: 8px;
      padding: 15px;
      overflow-y: auto;
    }
    
    .users-list {
      margin-top: 10px;
    }
    
    .user-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid #eee;
    }
    
    .challenge-button {
      padding: 5px 10px;
      background-color: #2ecc71;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .in-game-badge {
      padding: 3px 8px;
      background-color: #3498db;
      color: white;
      border-radius: 12px;
      font-size: 12px;
    }
    
    .chat-area {
      width: 70%;
      display: flex;
      flex-direction: column;
      border: 1px solid #eee;
      border-radius: 8px;
    }
    
    .chat-messages {
      flex-grow: 1;
      padding: 15px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    
    .message {
      padding: 8px;
      border-radius: 8px;
      background-color: #f8f9fa;
    }
    
    .message-time {
      color: #7f8c8d;
      font-size: 12px;
      margin-right: 8px;
    }
    
    .message-author {
      font-weight: bold;
      margin-right: 8px;
    }
    
    .chat-input {
      display: flex;
      padding: 10px;
      border-top: 1px solid #eee;
    }
    
    .chat-input input {
      flex-grow: 1;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px 0 0 4px;
      font-size: 14px;
    }
    
    .chat-input button {
      padding: 10px 15px;
      background-color: #3498db;
      color: white;
      border: none;
      border-radius: 0 4px 4px 0;
      cursor: pointer;
    }
    
    .no-users, .no-messages {
      padding: 20px;
      text-align: center;
      color: #7f8c8d;
    }
  `]
})
export class LobbyComponent implements OnInit, OnDestroy {
  username: string = '';
  onlineUsers: User[] = [];
  chatMessages: ChatMessage[] = [];
  newMessage: string = '';
  
  private subscriptions: Subscription[] = [];
  
  constructor(
    private wsService: WebsocketService,
    private authService: AuthService,
    private router: Router
  ) {}
  
  ngOnInit(): void {
    // Get username
    this.username = this.authService.getUsername();
    
    if (!this.username) {
      this.router.navigate(['/login']);
      return;
    }
    
    // Connect to the lobby
    this.wsService.connect('lobby');
    
    // Subscribe to WebSocket messages
    this.subscriptions.push(
      this.wsService.messages$.subscribe(message => {
        if (message) {
          this.handleMessage(message);
        }
      })
    );
    
    // Announce presence
    this.wsService.sendMessage({
      type: 'join_lobby',
      username: this.username
    });
  }
  
  ngOnDestroy(): void {
    // Clean up subscriptions
    this.subscriptions.forEach(sub => sub.unsubscribe());
    
    // Announce leaving
    this.wsService.sendMessage({
      type: 'leave_lobby',
      username: this.username
    });
    
    // Disconnect
    this.wsService.disconnect();
  }
  
  handleMessage(message: any): void {
    switch (message.type) {
      case 'chat_message':
        this.chatMessages.push(message);
        break;
      case 'user_list':
        this.onlineUsers = message.users;
        break;
      case 'user_joined':
        this.chatMessages.push({
          type: 'system',
          username: 'System',
          content: `${message.username} joined the lobby`,
          timestamp: new Date().toLocaleTimeString()
        });
        break;
      case 'user_left':
        this.chatMessages.push({
          type: 'system',
          username: 'System',
          content: `${message.username} left the lobby`,
          timestamp: new Date().toLocaleTimeString()
        });
        break;
      case 'game_challenge':
        if (confirm(`${message.challenger} has challenged you to a game. Accept?`)) {
          this.acceptChallenge(message.challenger);
        } else {
          this.declineChallenge(message.challenger);
        }
        break;
      case 'challenge_accepted':
        this.router.navigate(['/game', message.gameId]);
        break;
      case 'challenge_declined':
        alert(`${message.username} declined your challenge.`);
        break;
    }
  }
  
  sendMessage(): void {
    if (!this.newMessage.trim()) return;
    
    const message: ChatMessage = {
      type: 'chat_message',
      username: this.username,
      content: this.newMessage,
      timestamp: new Date().toLocaleTimeString()
    };
    
    this.wsService.sendMessage(message);
    this.newMessage = '';
  }
  
  challengePlayer(opponent: string): void {
    this.wsService.sendMessage({
      type: 'game_challenge',
      challenger: this.username,
      opponent: opponent
    });
  }
  
  acceptChallenge(challenger: string): void {
    this.wsService.sendMessage({
      type: 'challenge_response',
      response: 'accept',
      username: this.username,
      challenger: challenger
    });
  }
  
  declineChallenge(challenger: string): void {
    this.wsService.sendMessage({
      type: 'challenge_response',
      response: 'decline',
      username: this.username,
      challenger: challenger
    });
  }
  
  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}