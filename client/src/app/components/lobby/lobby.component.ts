import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription } from 'rxjs';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ConnectionDialogComponent } from '../connection-dialog/connection-dialog.component';

interface User {
  username: string;
  status: string; // e.g., 'online', 'in-game'
}

interface ChatMessage {
  username: string;
  content: string;
  timestamp: string;
  type?: string; // Optional, e.g., 'system' for system messages
}

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectionStatusComponent, ConnectionDialogComponent],
  templateUrl: './lobby.component.html',
  styleUrls: ['./lobby.component.scss']
})
export class LobbyComponent implements OnInit, OnDestroy {
  username: string = '';
  users: User[] = [];
  messages: ChatMessage[] = [];
  messageContent: string = '';
  newUsername: string = '';
  showChangeUsername: boolean = false;
  activeInvite: {
    inviter: string;
    inviteId: string;
    timeLeft: number;
    intervalId?: any;
  } | null = null;
  
  private subscription: Subscription | null = null;
  
  constructor(private wsService: WebsocketService) {}
  
  ngOnInit(): void {
    // Generate a random username if none exists
    this.username = localStorage.getItem('username') || this.generateRandomUsername();
    localStorage.setItem('username', this.username);
    this.newUsername = this.username;
    
    // Connect to the lobby
    this.wsService.connect('lobby');
    
    // Wait for connection to be established
    const connectionSub = this.wsService.connectionStatus$.subscribe(connected => {
      if (connected) {
        // Only send join message when connected
        this.wsService.sendMessage({
          type: 'join_lobby',
          username: this.username
        });
        connectionSub.unsubscribe(); // Clean up this temporary subscription
      }
    });
    
    // Subscribe to WebSocket messages
    this.subscription = this.wsService.messages$.subscribe(message => {
      if (!message) return;
      
      switch (message.type) {
        case 'user_list':
          this.users = message.users;
          break;
          
        case 'user_joined':
          this.addSystemMessage(`${message.username} has joined the lobby.`);
          break;
          
        case 'user_left':
          this.addSystemMessage(`${message.username} has left the lobby.`);
          break;
          
        case 'chat_message':
          this.messages.push({
            username: message.username,
            content: message.content,
            timestamp: message.timestamp
          });
          this.scrollChatToBottom();
          break;
          
        case 'username_changed':
          this.addSystemMessage(`${message.oldUsername} has changed their name to ${message.newUsername}.`);
          if (message.oldUsername === this.username) {
            this.username = message.newUsername;
            localStorage.setItem('username', this.username);
          }
          break;
          
        case 'username_error':
          // Handle username error when trying to join the lobby
          alert(message.error);
          
          // If we get back our old attempted username, remove it
          if (message.oldUsername && message.oldUsername === this.username) {
            // Clear the rejected username from localStorage
            localStorage.removeItem('username');
            
            // Generate a new random username
            const newRandomName = this.generateRandomUsername();
            this.username = newRandomName;
            localStorage.setItem('username', newRandomName);
            
            // Try joining again with the new random username
            this.wsService.sendMessage({
              type: 'join_lobby',
              username: newRandomName
            });
            
            this.addSystemMessage(`System assigned you a new username: ${newRandomName}`);
          }
          break;
          
        case 'game_challenge': // Changed from 'game_invite' to 'game_challenge'
          this.handleGameChallenge(message);
          break;
          
        case 'challenge_accepted':
          this.addSystemMessage(`${message.username} has accepted your invitation!`);
          // Set both users back to "invited" status (yellow) after accepting
          this.users = this.users.map(user => {
            if (user.username === message.username || user.username === this.username) {
              return { ...user, status: 'invited' };
            }
            return user;
          });
          break;
          
        case 'challenge_declined':
          this.addSystemMessage(`${message.username} has declined your invitation.`);
          break;
      }
    });
  }
  
  ngOnDestroy(): void {
    // Send leave message
    this.wsService.sendMessage({
      type: 'leave_lobby',
      username: this.username
    });
    
    // Disconnect
    this.wsService.disconnect();
    
    // Unsubscribe
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    
    // Clear any active challenge timer
    if (this.activeInvite?.intervalId) {
      clearInterval(this.activeInvite.intervalId);
    }
  }
  
  sendMessage(): void {
    if (!this.messageContent.trim()) return;
    
    this.wsService.sendMessage({
      type: 'chat_message',
      username: this.username,
      content: this.messageContent,
      timestamp: new Date().toISOString()
    });
    
    this.messageContent = '';
  }
  
  changeUsername(): void {
    if (!this.newUsername.trim() || this.newUsername === this.username) {
      this.showChangeUsername = false;
      return;
    }

    // Send the request to change the username
    this.wsService.sendMessage({
      type: 'change_username',
      oldUsername: this.username,
      newUsername: this.newUsername
    });

    // Keep the UI open until the server confirms or rejects the change
  }
  
  toggleChangeUsername(): void {
    this.showChangeUsername = !this.showChangeUsername;
    this.newUsername = this.username;
  }
  
  openUserMenu(event: MouseEvent, user: User): void {
    event.preventDefault();
    
    // Don't allow inviting yourself
    if (user.username === this.username) return;
    
    // Get current user's status
    const currentUserStatus = this.users.find(u => u.username === this.username)?.status;
    
    // Enforce invitation rules:
    // 1. Yellow CAN invite green (online)
    // 2. Yellow CANNOT invite yellow (invited)
    // 3. Green (online) CANNOT invite yellow (invited)
    let canInvite = false;
    let disabledReason = '';
    
    if (currentUserStatus === 'invited' && user.status === 'invited') {
      // Yellow CANNOT invite yellow
      canInvite = false;
      disabledReason = 'Cannot invite another invited player';
    } else if (currentUserStatus === 'online' && user.status === 'invited') {
      // Green CANNOT invite yellow
      canInvite = false;
      disabledReason = 'Cannot invite an invited player';
    } else if (currentUserStatus === 'invited' && user.status === 'online') {
      // Yellow CAN invite green
      canInvite = true;
    } else if (currentUserStatus === 'online' && user.status === 'online') {
      // Green CAN invite green
      canInvite = true;
    } else {
      // Any other combination
      canInvite = false;
      disabledReason = 'Cannot invite this player';
    }
    
    // Also check for active invitations
    if (this.activeInvite && this.activeInvite.inviter === user.username) {
      canInvite = false;
      disabledReason = 'Already invited';
    }
    
    // Remove any existing menus first
    const existingMenus = document.querySelectorAll('.user-context-menu');
    existingMenus.forEach(menu => document.body.removeChild(menu));
    
    // Create the context menu
    const menu = document.createElement('div');
    menu.className = 'user-context-menu';
    
    // Create button based on invitation rules
    menu.innerHTML = canInvite ? 
      `<button>Invite</button>` : 
      `<button disabled>${disabledReason}</button>`;
    menu.style.position = 'absolute';
    
    // Position the menu differently based on event source
    if (event.target instanceof HTMLButtonElement && event.target.classList.contains('action-button')) {
      // If clicked from the three-dots button, position relative to the button
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 5}px`;
    } else {
      // Otherwise, use mouse coordinates (right-click)
      menu.style.left = `${event.pageX}px`;
      menu.style.top = `${event.pageY}px`;
    }
    
    // Add event listener for invite button
    menu.querySelector('button')?.addEventListener('click', () => {
      if (canInvite) {
        this.inviteUser(user.username);
      }
      document.body.removeChild(menu);
    });
    
    // Add menu to body
    document.body.appendChild(menu);
    
    // Close menu when clicking elsewhere
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        document.body.removeChild(menu);
        document.removeEventListener('click', closeMenu);
      }
    };
    
    // Add a delay to prevent immediate closing
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 100);
  }
  
  // Check if there's already an active invitation between the current user and the target user
  alreadyInvited(targetUsername: string): boolean {
    // If there's an active invite dialog for this user, they're already invited
    if (this.activeInvite?.inviter === targetUsername) {
      return true;
    }
    
    // If the target user is already in an invitation with the current user, check the status
    // Get all users who are in challenging status
    const challengingUsers = this.users.filter(u => u.status === 'invited');
    
    // If both the current user and target user are challenging, and they're the only challenging users, or
    // the current user has an active invitation from the target user
    return this.activeInvite?.inviter === targetUsername;
  }
  
  async handleGameChallenge(message: any): Promise<void> {
    // Clear any existing challenge
    if (this.activeInvite?.intervalId) {
      clearInterval(this.activeInvite.intervalId);
    }

    // Set up the new challenge
    this.activeInvite = {
      inviter: message.challenger,
      inviteId: message.challenge_id,
      timeLeft: 5 // Changed from 30 seconds to 5 seconds
    };

    // Update the status of both users to 'yellow' (invited)
    this.users = this.users.map(user => {
      if (user.username === message.challenger || user.username === this.username) {
        return { ...user, status: 'invited' };
      }
      return user;
    });

    // Add system message
    this.addSystemMessage(`${message.challenger} has invited you to a game. You have 5 seconds to accept.`);

    // Start countdown
    this.activeInvite.intervalId = setInterval(() => {
      if (this.activeInvite) {
        this.activeInvite.timeLeft--;

        if (this.activeInvite.timeLeft <= 0) {
          // Time expired, auto-decline
          this.respondToInvite('decline');
        }
      }
    }, 1000);
  }

  inviteUser(opponent: string): void {
    // Only prevent inviting if there's already an active invite dialog
    if (this.activeInvite) return;

    this.wsService.sendMessage({
      type: 'game_challenge',
      challenger: this.username,
      opponent: opponent
    });

    // Update the status of both users to 'yellow' (invited) for the challenger
    this.users = this.users.map(user => {
      if (user.username === opponent || user.username === this.username) {
        return { ...user, status: 'invited' };
      }
      return user;
    });

    this.addSystemMessage(`You have invited ${opponent} to a game.`);
  }

  respondToInvite(response: 'accept' | 'decline'): void {
    if (!this.activeInvite) return;

    this.wsService.sendMessage({
      type: 'challenge_response', // Changed from 'invite_response' to 'challenge_response' to match server expectation
      response: response,
      username: this.username,
      challenger: this.activeInvite.inviter // Changed from 'inviter' to 'challenger' to match server expectation
    });

    // Clear invite
    if (this.activeInvite.intervalId) {
      clearInterval(this.activeInvite.intervalId);
    }

    if (response === 'accept') {
      this.addSystemMessage(`You accepted ${this.activeInvite.inviter}'s invitation.`);

      // Set both users back to 'invited' status (yellow) after accepting
      this.users = this.users.map(user => {
        if (user.username === this.activeInvite?.inviter || user.username === this.username) {
          return { ...user, status: 'invited' };
        }
        return user;
      });
    } else {
      this.addSystemMessage(`You declined ${this.activeInvite.inviter}'s invitation.`);

      // Reset the status of both users to 'online'
      this.users = this.users.map(user => {
        if (user.username === this.activeInvite?.inviter || user.username === this.username) {
          return { ...user, status: 'online' };
        }
        return user;
      });
    }

    this.activeInvite = null;
  }
  
  openSetup(): void {
    // Placeholder for setup configuration
    alert('Setup configuration will be implemented in a future update.');
  }
  
  private generateRandomUsername(): string {
    return `Player${Math.floor(Math.random() * 10000)}`;
  }
  
  private addSystemMessage(content: string): void {
    this.messages.push({
      username: 'System',
      content: content,
      timestamp: new Date().toISOString(),
      type: 'system'
    });
    this.scrollChatToBottom();
  }
  
  private scrollChatToBottom(): void {
    setTimeout(() => {
      const chatContainer = document.querySelector('.chat-messages');
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }, 100);
  }
}
