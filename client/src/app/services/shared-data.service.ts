import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type UserStatus = 'online' | 'invited' | 'configuring' | 'in-game';
export type MessageType = 'system' | 'user';

export interface ChatMessage {
  username: string;
  content: string;
  timestamp: string;
  type?: MessageType;
  room?: string; // Optional room property to identify which chat room the message belongs to
}

export interface User {
  username: string;
  status: UserStatus;
  isReady?: boolean;
  isInviter?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class SharedDataService {
  private lobbyMessagesSubject = new BehaviorSubject<ChatMessage[]>([]);
  private lobbyUsersSubject = new BehaviorSubject<User[]>([]);
  
  // Public Observables
  lobbyMessages$ = this.lobbyMessagesSubject.asObservable();
  lobbyUsers$ = this.lobbyUsersSubject.asObservable();
  
  constructor() {}
  
  // Methods to update messages
  updateLobbyMessages(messages: ChatMessage[]): void {
    this.lobbyMessagesSubject.next(messages);
  }
  
  addLobbyMessage(message: ChatMessage): void {
    const currentMessages = this.lobbyMessagesSubject.value;
    this.lobbyMessagesSubject.next([...currentMessages, message]);
  }
  
  // Methods to update users
  updateLobbyUsers(users: User[]): void {
    this.lobbyUsersSubject.next(users);
  }
  
  // Getters for direct access
  getLobbyMessages(): ChatMessage[] {
    return this.lobbyMessagesSubject.value;
  }
  
  getLobbyUsers(): User[] {
    return this.lobbyUsersSubject.value;
  }
}