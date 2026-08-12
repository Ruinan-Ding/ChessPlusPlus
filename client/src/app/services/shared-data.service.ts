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
/**
 * Return `users` with the current user pinned to the front.
 *
 * Shared so every list that shows people - the lobby's Online Users, the game
 * room's Online Users and its Players list - puts "(You)" in the same place.
 */
export function selfFirst<T extends { username: string }>(users: T[], username: string): T[] {
  return [
    ...users.filter(user => user.username === username),
    ...users.filter(user => user.username !== username),
  ];
}
