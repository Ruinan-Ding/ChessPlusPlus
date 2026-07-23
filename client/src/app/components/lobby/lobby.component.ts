import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subject } from 'rxjs';
import { takeUntil, filter, take } from 'rxjs/operators';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ConnectionDialogComponent } from '../connection-dialog/connection-dialog.component';
import { Router } from '@angular/router';
import { SharedDataService, ChatMessage, User } from '../../services/shared-data.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectionStatusComponent, ConnectionDialogComponent],
  templateUrl: './lobby.component.html',
  styleUrls: ['./lobby.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LobbyComponent implements OnInit, OnDestroy {
  private isRejoiningFromNavigation: boolean = false;
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
  } | null = null;
  invitePending: boolean = false;
  
  private countdownTimerId: ReturnType<typeof setInterval> | null = null;
  private destroy$ = new Subject<void>();

  // Invite cooldown: 5 seconds from when they join the game room (not from when they leave)
  private gameRoomJoinTime: number = 0;  // Timestamp when player joined game room
  private inviteCooldownEndTime: number = 0;
  inviteCooldownRemaining: number = 0;
  private inviteCooldownTimerId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private wsService: WebsocketService,
    private router: Router,
    private sharedDataService: SharedDataService,
    private navigationState: NavigationStateService,
    private cdr: ChangeDetectorRef,
    private authService: AuthService
  ) {}
  
  ngOnInit(): void {
    console.log('[Lobby] ngOnInit called');
    
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    
    this.isRejoiningFromNavigation = this.navigationState.isIntentionalNavigation();
    const navContext = this.navigationState.getNavigationContext();
    
    console.log(`[Lobby] ngOnInit: isIntentionalNavigation=${this.isRejoiningFromNavigation}, navContext=${navContext}`);
    
    // If context is 'none', we're returning from a game room - apply remaining invite cooldown
    // Cooldown is 5 seconds from when they joined the game room, not from when they left
    if (navContext === 'none' && this.isRejoiningFromNavigation) {
      if (this.gameRoomJoinTime > 0) {
        console.log('[Lobby] Detected return from game room - applying remaining cooldown');
        const elapsedSeconds = Math.ceil((Date.now() - this.gameRoomJoinTime) / 1000);
        const remainingCooldown = Math.max(0, 5 - elapsedSeconds);
        if (remainingCooldown > 0) {
          this.startInviteCooldownWithDuration(remainingCooldown);
        } else {
          console.log('[Lobby] Cooldown already expired');
        }
      } else {
        console.log('[Lobby] No game room join time recorded, applying full cooldown');
        this.startInviteCooldown();
      }
    }
    
    // If context is 'lobby', we're returning from setup - no cooldown needed
    if (navContext === 'lobby' && this.isRejoiningFromNavigation) {
      console.log('[Lobby] Detected return from setup (context: lobby) - no cooldown');
    }
    
    if (this.isRejoiningFromNavigation) {
      this.navigationState.clearIntentionalNavigation();
      // Clear any lingering invite state (user statuses come from the server)
      this.activeInvite = null;
      this.invitePending = false;
      console.log('[Lobby] Rejoining from navigation, will send rejoining: true');
    }
    
    this.username = this.authService.getUsername() || this.generateRandomUsername();
    this.authService.setUsername(this.username);
    this.newUsername = this.username;
    console.log('[Lobby] Username:', this.username);
    
    this.messages = this.sharedDataService.getLobbyMessages();
    this.sharedDataService.lobbyMessages$.pipe(takeUntil(this.destroy$)).subscribe(msgs => {
      this.messages = msgs;
      this.scrollChatToBottom();
    });
    
    // Subscribe to WebSocket messages before connecting
    this.wsService.messages$.pipe(
      takeUntil(this.destroy$),
      filter(message => message !== null && typeof message === 'object') // Filter out null and invalid messages
    ).subscribe(
      rawMessage => {

      // Unwrap the server's broadcast_message envelope (group broadcasts)
      let message = rawMessage;
      if (message.type === 'broadcast_message' && message.data && typeof message.data === 'object') {
        message = message.data;
      }

      switch (message.type) {
        case 'user_list':
          this.applyUserList(message);
          break;

        case 'user_joined':
        case 'user_left':
          // Ignore these events, handled above by user_list diff
          break;
          
        case 'chat_message':
          if (!message.username || !message.content || !message.timestamp) {
            console.error('Invalid chat_message: missing required fields', message);
            break;
          }
          // Only add to shared service; UI will update via subscription
          this.sharedDataService.addLobbyMessage({
            username: message.username,
            content: message.content,
            timestamp: message.timestamp
          });
          this.cdr.markForCheck();
          break;
          
        case 'username_changed':
          if (!message.oldUsername || !message.newUsername) {
            console.error('Invalid username_changed message: missing required fields', message);
            break;
          }
          this.addSystemMessage(`${message.oldUsername} has changed their name to ${message.newUsername}.`);
          
          this.users = this.users.map((user: User) => {
            if (user.username === message.oldUsername) {
              return { ...user, username: message.newUsername };
            }
            return user;
          });
          
          this.sharedDataService.updateLobbyUsers(this.users);
          
          if (message.oldUsername === this.username) {
            this.username = message.newUsername;
            this.newUsername = message.newUsername;
            this.authService.setUsername(this.username);
          }
          this.cdr.markForCheck();
          break;
          
        case 'username_error':
          if (!message.error) {
            console.error('Invalid username_error message: missing error field', message);
            break;
          }
          alert(message.error);
          
          if (message.oldUsername && message.oldUsername === this.username) {
            const newRandomName = this.generateRandomUsername();
            this.username = newRandomName;
            this.authService.setUsername(newRandomName);

            this.wsService.sendMessage({
              type: 'join_lobby',
              username: newRandomName,
              secret: this.authService.getIdentitySecret()
            });
            
            this.addSystemMessage(`System assigned you a new username: ${newRandomName}`);
          }
          break;
          
        case 'game_challenge':
          this.handleGameChallenge(message);
          break;
          
        case 'challenge_accepted':
          if (!message.username || !message.gameId || !message.token) {
            console.error('Invalid challenge_accepted message: missing required fields', message);
            break;
          }
          console.log('[Lobby] Received challenge_accepted:', message);
          this.addSystemMessage(`${message.username} has accepted your invitation!`);
          this.invitePending = false;
          this.gameRoomJoinTime = Date.now();
          this.startInviteCooldown();
          this.users = this.users.map((user: User) => {
            if (user.username === message.username || user.username === this.username) {
              return { ...user, status: 'invited' };
            }
            return user;
          });
          this.cdr.markForCheck();
          
          // Keep lobby connection alive while in game room
          this.navigationState.setIntentionalNavigation('game-room');
          
          const gameId = message.gameId;
          const gameToken = message.token;
          if (gameId && this.router) {
            console.log('[Lobby] Navigating to game room:', gameId, 'with token');
            this.router.navigate(['/game-room', gameId], { queryParams: { token: gameToken } }).catch(err => {
              console.error('Navigation to game room failed:', err);
            });
          }
          break;
          
        case 'challenge_declined':
          if (!message.username) {
            console.error('Invalid challenge_declined message: missing username field', message);
            break;
          }
          console.log('[Lobby] Received challenge_declined:', message);
          this.addSystemMessage(`${message.username} has declined your invitation.`);
          this.invitePending = false;
          this.users = this.users.map((user: User) => {
            if (user.username === message.username || user.username === this.username) {
              return { ...user, status: 'online' };
            }
            return user;
          });
          this.startInviteCooldown();
          this.cdr.markForCheck();
          break;
        
        case 'connection_established':
          // Server confirmation message - no action needed
          console.log('[Lobby] Server connection confirmed');
          break;
        
        case 'heartbeat_ack':
          // Heartbeat acknowledgment - no action needed
          break;

        // Ignore game-room scoped messages that can arrive while lobby is still connected
        case 'game_room_message':
        case 'game_mode_changed':
        case 'player_list':
        case 'player_list_update':
          // These are handled in game-room component; safely ignore in lobby
          break;
        
        case 'username_assigned':
          // Server assigned a different username because the requested one was taken
          console.log('[Lobby] Username was taken, assigned new username:', message.username);
          this.username = message.username;
          this.authService.setUsername(message.username);
          this.addSystemMessage(message.message);
          this.cdr.markForCheck();
          break;
        
        case 'error':
          console.error('[Lobby] Backend error:', message);
          if (message.message) {
            this.addSystemMessage(`Error: ${message.message}`);
          }
          // Reset invitePending for challenge-related errors so user can try again
          const challengeErrorCodes = [
            'CHALLENGE_EXISTS', 'OPPONENT_BUSY', 'CHALLENGER_BUSY', 
            'CHALLENGE_NOT_FOUND', 'USER_NOT_FOUND', 'INVALID_OPPONENT'
          ];
          if (message.code && challengeErrorCodes.includes(message.code)) {
            console.log(`[Lobby] ${message.code} - resetting invite state`);
            this.invitePending = false;
            this.users = this.users.map((user: User) => {
              if (user.username === this.username) {
                return { ...user, status: 'online' };
              }
              return user;
            });
          }
          this.cdr.markForCheck();
          break;
        
        default:
          console.warn('Received unknown message type:', message.type);
      }
      },
      error => {
        console.error('[Lobby] WebSocket message error:', error);
        this.addSystemMessage('An error occurred while receiving messages.');
      }
    );
    
    // Check if already connected (e.g., returning from game room or setup)
    if (this.wsService.isConnected()) {
      console.log('[Lobby] Already connected, sending join_lobby message immediately');
      this.wsService.sendMessage({
        type: 'join_lobby',
        username: this.username,
        rejoining: this.isRejoiningFromNavigation,
        secret: this.authService.getIdentitySecret()
      });
    } else {
      console.log('[Lobby] Connecting to WebSocket lobby...');
      this.wsService.connect('lobby');
      
      this.wsService.connectionStatus$.pipe(
        filter(connected => connected === true),
        take(1),
        takeUntil(this.destroy$)
      ).subscribe(
        () => {
          console.log('[Lobby] Connection established, sending join_lobby message');
          this.wsService.sendMessage({
            type: 'join_lobby',
            username: this.username,
            rejoining: this.isRejoiningFromNavigation,
            secret: this.authService.getIdentitySecret()
          });
        },
        error => {
          console.error('[Lobby] WebSocket connection error:', error);
          this.addSystemMessage('Connection error. Please refresh the page.');
        }
      );
    }
  }
  
  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.handleBeforeUnload);

    this.clearCountdownTimer();
    if (this.inviteCooldownTimerId) {
      clearInterval(this.inviteCooldownTimerId);
      this.inviteCooldownTimerId = null;
    }

    this.destroy$.next();
    this.destroy$.complete();

    // Keep the WebSocket alive when intentionally navigating to setup or game room
    const isIntentionalNav = this.navigationState.isIntentionalNavigation();
    const navContext = this.navigationState.getNavigationContext();
    if (isIntentionalNav && (navContext === 'setup' || navContext === 'game-room')) {
      return;
    }

    // Send leave message for true disconnects
    this.wsService.sendMessage({
      type: 'leave_lobby',
      username: this.username
    });
    this.wsService.disconnect();
  }
  
  private handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    // Send leave_lobby message immediately on window close
    if (this.wsService.isConnected() && this.username) {
      this.wsService.sendMessage({
        type: 'leave_lobby',
        username: this.username
      });
    }
  };
  
  
  sendMessage(): void {
    const trimmedContent = this.messageContent.trim();
    if (!trimmedContent) return;
    if (!this.username || typeof this.username !== 'string' || this.username.trim() === '') {
      this.addSystemMessage('You must be logged in to send messages.');
      return;
    }
    if (trimmedContent.length > 1000) {
      this.addSystemMessage('Message is too long (max 1000 characters).');
      return;
    }
    try {
      this.wsService.sendMessage({
        type: 'chat_message',
        username: this.username,
        content: trimmedContent,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      this.addSystemMessage('Failed to send message. Please try again.');
      return;
    }
    this.messageContent = '';
  }
  
  changeUsername(): void {
    const trimmedUsername = this.newUsername.trim();
    if (!this.username || typeof this.username !== 'string' || this.username.trim() === '') {
      this.addSystemMessage('You must be logged in to change your username.');
      return;
    }
    if (!trimmedUsername || trimmedUsername === this.username) {
      this.showChangeUsername = false;
      return;
    }
    if (trimmedUsername.length < 1 || trimmedUsername.length > 24) {
      this.addSystemMessage('Username must be between 1 and 24 characters.');
      return;
    }
    try {
      this.wsService.sendMessage({
        type: 'change_username',
        oldUsername: this.username,
        newUsername: trimmedUsername,
        secret: this.authService.getIdentitySecret()
      });
    } catch (error) {
      console.error('Failed to change username:', error);
      this.addSystemMessage('Failed to change username. Please try again.');
    }
    // Keep the UI open until the server confirms or rejects the change
  }
  
  toggleChangeUsername(): void {
    this.showChangeUsername = !this.showChangeUsername;
    this.newUsername = this.username;
  }
  
  openUserMenu(event: MouseEvent, user: User): void {
    event.preventDefault();
    
    if (user.username === this.username) return;
    
    const validation = this.canInviteUser(user.username);
    
    const existingMenus = document.querySelectorAll('.user-context-menu');
    existingMenus.forEach(menu => document.body.removeChild(menu));
    
    const menu = document.createElement('div');
    menu.className = 'user-context-menu';
    
    menu.innerHTML = validation.canInvite ? 
      `<button>Invite</button>` : 
      `<button disabled>${validation.reason}</button>`;
    menu.style.position = 'absolute';
    
    if (event.target instanceof HTMLButtonElement && event.target.classList.contains('action-button')) {
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      menu.style.left = `${rect.left}px`;
      menu.style.top = `${rect.bottom + 5}px`;
    } else {
      menu.style.left = `${event.pageX}px`;
      menu.style.top = `${event.pageY}px`;
    }
    
    menu.querySelector('button')?.addEventListener('click', () => {
      if (validation.canInvite) {
        this.inviteUser(user.username);
      }
      if (document.body.contains(menu)) {
        document.body.removeChild(menu);
      }
    });
    
    document.body.appendChild(menu);
    
    // Close menu when clicking elsewhere
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        if (document.body.contains(menu)) {
          document.body.removeChild(menu);
        }
        document.removeEventListener('click', closeMenu);
      }
    };
    
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 100);
  }
  
  /**
   * Centralized invitation validation logic.
   * Returns whether the current user can invite the target user and the reason if not.
   */
  private canInviteUser(targetUsername: string): { canInvite: boolean; reason: string } {
    if (this.inviteCooldownRemaining > 0) {
      return { canInvite: false, reason: `Wait ${this.inviteCooldownRemaining}s before inviting` };
    }
    
    if (this.invitePending) {
      return { canInvite: false, reason: 'Invite pending. Wait for response or timeout.' };
    }
    
    if (targetUsername === this.username) {
      return { canInvite: false, reason: 'Cannot invite yourself' };
    }
    const targetUser = this.users.find(u => u.username === targetUsername);
    if (!targetUser) {
      return { canInvite: false, reason: 'User not found' };
    }
    // Lock out sending new invites while an invite is pending (sent or received)
    if (this.activeInvite) {
      return { canInvite: false, reason: 'You already have a pending invite. Wait for it to be accepted, declined, or time out.' };
    }
    
    const currentUserStatus = this.users.find(u => u.username === this.username)?.status;
    
    if (targetUser.status === 'configuring') {
      return { canInvite: false, reason: 'Cannot invite while configuring setup' };
    }
    
    if (targetUser.status === 'in-game') {
      return { canInvite: false, reason: 'User is already in a game' };
    }
    
    // Invitation rules based on status combinations:
    // Yellow (invited) CAN invite green (online) - allows counter-invites
    if (currentUserStatus === 'invited' && targetUser.status === 'online') {
      return { canInvite: true, reason: '' };
    }
    
    // Green (online) CAN invite green (online)
    if (currentUserStatus === 'online' && targetUser.status === 'online') {
      return { canInvite: true, reason: '' };
    }
    
    // Yellow CANNOT invite yellow - both are in pending invites
    if (currentUserStatus === 'invited' && targetUser.status === 'invited') {
      return { canInvite: false, reason: 'Both players have pending invites' };
    }
    
    // Green CANNOT invite yellow - target has a pending invite
    if (currentUserStatus === 'online' && targetUser.status === 'invited') {
      return { canInvite: false, reason: 'User has a pending invite' };
    }
    
    // Any other combination is not allowed
    return { canInvite: false, reason: 'Cannot invite this player' };
  }
  
  /**
   * Apply a server `user_list` message: validate each entry, diff against the
   * current list for join/leave system messages, and sync the shared service.
   */
  private applyUserList(message: any): void {
    if (!Array.isArray(message.users)) {
      console.error('Invalid user_list message: missing or invalid users array', message);
      return;
    }

    const validStatuses: string[] = ['online', 'invited', 'configuring', 'in-game'];
    const serverUsers: User[] = [];
    for (const user of message.users) {
      if (!user || typeof user !== 'object' ||
          !user.username || typeof user.username !== 'string' ||
          !user.status || typeof user.status !== 'string') {
        console.warn('Skipping invalid user object:', user);
        continue;
      }
      if (!validStatuses.includes(user.status)) {
        console.warn(`User ${user.username} has invalid status: ${user.status}, defaulting to 'online'`);
        user.status = 'online';
      }
      serverUsers.push(user);
    }

    const previousUsernames = new Set(this.users.map(u => u.username));
    const newUsernames = new Set(serverUsers.map(u => u.username));
    const joined = serverUsers.filter(u => !previousUsernames.has(u.username));
    const left = this.users.filter(u => !newUsernames.has(u.username));

    this.users = serverUsers;

    // Only show system messages for real joins/leaves
    joined.forEach(u => {
      if (u.username !== this.username) this.addSystemMessage(`${u.username} has joined the lobby.`);
    });
    left.forEach(u => {
      if (u.username !== this.username) this.addSystemMessage(`${u.username} has left the lobby.`);
    });

    // Clear the rejoining flag; statuses come from the server's live list
    this.isRejoiningFromNavigation = false;

    this.sharedDataService.updateLobbyUsers(this.users);
    this.cdr.markForCheck();
  }

  private handleGameChallenge(message: any): void {
    console.log('[Lobby] handleGameChallenge called with:', message);
    console.log('[Lobby] Current activeInvite:', this.activeInvite);
    
    // Validate message has required fields (backend sends 'inviteId', not 'challenge_id')
    if (!message?.challenger || !message?.inviteId) {
      console.error('Invalid game challenge message:', message);
      return;
    }
    
    if (this.activeInvite) {
      console.warn('[Lobby] Already have active invite, ignoring new challenge');
      return;
    }

    this.clearCountdownTimer();

    this.activeInvite = {
      inviter: message.challenger,
      inviteId: message.inviteId,
      timeLeft: 5 // 5 seconds to accept
    };
    
    console.log('[Lobby] Set activeInvite:', this.activeInvite);

    this.users = this.users.map((user: User) => {
      if (user.username === message.challenger || user.username === this.username) {
        return { ...user, status: 'invited' };
      }
      return user;
    });
    
    this.cdr.markForCheck();

    this.addSystemMessage(`${message.challenger} has invited you to a game. You have 5 seconds to accept.`);

    this.countdownTimerId = setInterval(() => {
      if (this.activeInvite) {
        this.activeInvite.timeLeft--;
        this.cdr.markForCheck();

        if (this.activeInvite.timeLeft <= 0) {
          console.log('[Lobby] Invite timer expired, auto-declining');
          this.clearCountdownTimer();
          this.respondToInvite('decline');
        }
      }
    }, 1000);
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimerId) {
      clearInterval(this.countdownTimerId);
      this.countdownTimerId = null;
    }
  }

  inviteUser(opponent: string): void {
    console.log('[Lobby] inviteUser called with opponent:', opponent);
    if (!opponent || typeof opponent !== 'string') {
      console.error('Invalid opponent username:', opponent);
      return;
    }
    if (this.activeInvite || this.invitePending) {
      this.addSystemMessage('You already have a pending invite. Wait for it to be accepted, declined, or time out.');
      return;
    }
    const opponentExists = this.users.some(u => u.username === opponent);
    if (!opponentExists) {
      console.error('Opponent not found in user list:', opponent);
      this.addSystemMessage('User not found. Cannot send invitation.');
      return;
    }
    if (!this.username || typeof this.username !== 'string' || this.username.trim() === '') {
      this.addSystemMessage('You must be logged in to challenge another player.');
      return;
    }
    try {
      const message = {
        type: 'game_challenge',
        challenger: this.username,
        opponent: opponent
      };
      console.log('[Lobby] Sending game_challenge message:', JSON.stringify(message));
      this.wsService.sendMessage(message);
      this.invitePending = true;
    } catch (error) {
      console.error('Failed to send challenge:', error);
      this.addSystemMessage('Failed to send invitation. Please try again.');
      return;
    }
    this.users = this.users.map((user: User) => {
      if (user.username === opponent || user.username === this.username) {
        return { ...user, status: 'invited' };
      }
      return user;
    });
    this.cdr.markForCheck();
    this.addSystemMessage(`You have invited ${opponent} to a game.`);
  }

  respondToInvite(response: 'accept' | 'decline'): void {
    console.log('[Lobby] respondToInvite called with:', response);
    console.log('[Lobby] Current activeInvite:', this.activeInvite);
    if (!this.activeInvite) {
      console.warn('[Lobby] No active invite to respond to');
      return;
    }
    const messageType = response === 'accept' ? 'challenge_accept' : 'challenge_decline';
    console.log('[Lobby] Sending', messageType, 'message');
    this.wsService.sendMessage({
      type: messageType,
      username: this.username,
      challenger: this.activeInvite.inviter,
      opponent: this.username,
      challenge_id: this.activeInvite.inviteId
    });
    this.clearCountdownTimer();
    if (response === 'accept') {
      this.addSystemMessage(`You accepted ${this.activeInvite.inviter}'s invitation.`);
      this.users = this.users.map((user: User) => {
        if (user.username === this.activeInvite?.inviter || user.username === this.username) {
          return { ...user, status: 'invited' };
        }
        return user;
      });
      this.cdr.markForCheck();
    } else {
      this.addSystemMessage(`You declined ${this.activeInvite.inviter}'s invitation.`);
      this.users = this.users.map((user: User) => {
        if (user.username === this.activeInvite?.inviter || user.username === this.username) {
          return { ...user, status: 'online' };
        }
        return user;
      });
      this.cdr.markForCheck();
      this.wsService.sendMessage({ type: 'request_user_list' });
      this.invitePending = false;
    }
    this.activeInvite = null;
    this.invitePending = false;
    this.cdr.markForCheck();
  }

  private startInviteCooldown(): void {
    this.startInviteCooldownWithDuration(5);
  }

  private startInviteCooldownWithDuration(cooldownSeconds: number): void {
    this.inviteCooldownEndTime = Date.now() + (cooldownSeconds * 1000);
    this.inviteCooldownRemaining = cooldownSeconds;
    if (this.inviteCooldownTimerId) {
      clearInterval(this.inviteCooldownTimerId);
    }
    this.inviteCooldownTimerId = setInterval(() => {
      const remaining = Math.ceil((this.inviteCooldownEndTime - Date.now()) / 1000);
      this.inviteCooldownRemaining = remaining > 0 ? remaining : 0;
      if (this.inviteCooldownRemaining <= 0) {
        if (this.inviteCooldownTimerId) {
          clearInterval(this.inviteCooldownTimerId);
          this.inviteCooldownTimerId = null;
        }
        this.invitePending = false;
      }
      this.cdr.markForCheck();
    }, 1000);
    console.log('[Lobby] Started 5-second invite cooldown');
  }
  
  private addSystemMessage(content: string): void {
    this.sharedDataService.addLobbyMessage({
      username: 'System',
      content: content,
      timestamp: new Date().toISOString(),
      type: 'system'
    });
    // scrollChatToBottom will be triggered by the subscription
  }
  
  private scrollChatToBottom(): void {
    setTimeout(() => {
      const chatContainer = document.querySelector('.chat-messages');
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }, 100);
  }
  
  private generateRandomUsername(): string {
    return `Player${Math.floor(Math.random() * 10000)}`;
  }
  
  openSetup(): void {
    this.navigationState.setIntentionalNavigation('setup');
    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'configuring'
    });
    this.router.navigate(['/setup']);
  }
}
