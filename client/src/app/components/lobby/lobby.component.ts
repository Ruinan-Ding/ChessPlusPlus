import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription, Subject } from 'rxjs';
import { takeUntil, filter, take, skipWhile } from 'rxjs/operators';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { ConnectionDialogComponent } from '../connection-dialog/connection-dialog.component';
import { Router } from '@angular/router';
import { SharedDataService, ChatMessage, User } from '../../services/shared-data.service';
import { NavigationStateService } from '../../services/navigation-state.service';

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
  private subscription: Subscription | null = null;
  private messagesSubscription: Subscription | null = null;
  private destroy$ = new Subject<void>();
  
  // Invite cooldown after decline/timeout/leaving game room
  private inviteCooldownEndTime: number = 0;
  inviteCooldownRemaining: number = 0;
  private inviteCooldownTimerId: ReturnType<typeof setInterval> | null = null;
  
  // Guard flag to prevent message processing after component destruction
  private isDestroyed: boolean = false;
  
  constructor(
    private wsService: WebsocketService,
    private router: Router,
    private sharedDataService: SharedDataService,
    private navigationState: NavigationStateService,
    private cdr: ChangeDetectorRef
  ) {}
  
  ngOnInit(): void {
    console.log('[Lobby] ngOnInit called');
    
    // Add beforeunload handler to ensure clean disconnect
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    
    // Check if we're coming from a game room or setup with intentional navigation
    this.isRejoiningFromNavigation = this.navigationState.isIntentionalNavigation();
    const navContext = this.navigationState.getNavigationContext();
    
    console.log(`[Lobby] ngOnInit: isIntentionalNavigation=${this.isRejoiningFromNavigation}, navContext=${navContext}`);
    
    // If context is 'none', we're returning from a game room - apply invite cooldown
    // This applies to BOTH the person who left AND the person who was kicked (partner_left)
    if (navContext === 'none' && this.isRejoiningFromNavigation) {
      console.log('[Lobby] Detected return from game room (context: none) - starting invite cooldown');
      // Apply invite cooldown when leaving game room
      this.startInviteCooldown();
    }
    
    // If context is 'lobby', we're returning from setup - no cooldown needed
    if (navContext === 'lobby' && this.isRejoiningFromNavigation) {
      console.log('[Lobby] Detected return from setup (context: lobby) - no cooldown');
    }
    
    if (this.isRejoiningFromNavigation) {
      // Clear the navigation flag
      this.navigationState.clearIntentionalNavigation();
      // Clear any lingering invite state (but do NOT reset user statuses - trust server)
      this.activeInvite = null;
      this.invitePending = false;
      console.log('[Lobby] Rejoining from navigation, will send rejoining: true');
    }
    
    // Generate a random username if none exists
    this.username = localStorage.getItem('username') || this.generateRandomUsername();
    localStorage.setItem('username', this.username);
    this.newUsername = this.username;
    console.log('[Lobby] Username:', this.username);
    
    // Subscribe to shared lobby messages for persistence
    this.messages = this.sharedDataService.getLobbyMessages();
    this.messagesSubscription = this.sharedDataService.lobbyMessages$.pipe(takeUntil(this.destroy$)).subscribe(msgs => {
      this.messages = msgs;
      this.scrollChatToBottom();
    });
    
    // Subscribe to WebSocket messages BEFORE connecting
    this.subscription = this.wsService.messages$.pipe(
      takeUntil(this.destroy$),
      filter(message => message !== null && typeof message === 'object') // Filter out null and invalid messages
    ).subscribe(
      message => {
      
      // Guard against processing messages after component destruction
      if (this.isDestroyed) {
        console.log('[Lobby] Ignoring message - component destroyed');
        return;
      }
      
      switch (message.type) {
        case 'user_list':
          // Validate message has required fields
          if (!Array.isArray(message.users)) {
            console.error('Invalid user_list message: missing or invalid users array', message);
            break;
          }
          
          // Validate each user object in the array
          const validUsers: User[] = [];
          for (const user of message.users) {
            if (!user || typeof user !== 'object') {
              console.warn('Skipping invalid user object:', user);
              continue;
            }
            
            // Validate required user fields
            if (!user.username || typeof user.username !== 'string') {
              console.warn('Skipping user with invalid username:', user);
              continue;
            }
            
            if (!user.status || typeof user.status !== 'string') {
              console.warn('Skipping user with invalid status:', user);
              continue;
            }
            
            // Ensure status is a valid UserStatus value
            const validStatuses: string[] = ['online', 'invited', 'configuring', 'in-game'];
            if (!validStatuses.includes(user.status)) {
              console.warn(`User ${user.username} has invalid status: ${user.status}, defaulting to 'online'`);
              user.status = 'online';
            }
            
            validUsers.push(user);
          }
          
          // Merge server list with any local invited statuses to keep invited users visible
          const serverUsers: User[] = validUsers;
          const previousUsernames = new Set(this.users.map(u => u.username));
          const newUsernames = new Set(serverUsers.map(u => u.username));
          // Find truly joined users
          const joined = serverUsers.filter(u => !previousUsernames.has(u.username));
          // Find truly left users
          const left = this.users.filter(u => !newUsernames.has(u.username));
          // Update users - trust server status completely
          this.users = serverUsers;
          // Only show system messages for real joins/leaves
          joined.forEach(u => {
            if (u.username !== this.username) this.addSystemMessage(`${u.username} has joined the lobby.`);
          });
          left.forEach(u => {
            if (u.username !== this.username) this.addSystemMessage(`${u.username} has left the lobby.`);
          });
          // Clear the rejoining flag (but do NOT reset statuses - trust the server's live statuses)
          if (this.isRejoiningFromNavigation) {
            this.isRejoiningFromNavigation = false;
          }
          // Store users in the shared service
          this.sharedDataService.updateLobbyUsers(this.users);
          this.cdr.markForCheck(); // Trigger change detection
          break;
          
        case 'user_joined':
        case 'user_left':
          // Ignore these events, handled above by user_list diff
          break;
          
        case 'chat_message':
          // Validate required fields
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
          this.cdr.markForCheck(); // Trigger change detection
          break;
          
        case 'username_changed':
          // Validate required fields
          if (!message.oldUsername || !message.newUsername) {
            console.error('Invalid username_changed message: missing required fields', message);
            break;
          }
          this.addSystemMessage(`${message.oldUsername} has changed their name to ${message.newUsername}.`);
          
          // Update the local users array - replace old username with new one
          this.users = this.users.map((user: User) => {
            if (user.username === message.oldUsername) {
              return { ...user, username: message.newUsername };
            }
            return user;
          });
          
          // Also update shared data service
          this.sharedDataService.updateLobbyUsers(this.users);
          
          if (message.oldUsername === this.username) {
            this.username = message.newUsername;
            this.newUsername = message.newUsername;
            localStorage.setItem('username', this.username);
          }
          this.cdr.markForCheck();
          break;
          
        case 'username_error':
          // Validate required fields
          if (!message.error) {
            console.error('Invalid username_error message: missing error field', message);
            break;
          }
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
          // Validate required fields
          if (!message.username || !message.gameId || !message.token) {
            console.error('Invalid challenge_accepted message: missing required fields', message);
            break;
          }
          console.log('[Lobby] Received challenge_accepted:', message);
          this.addSystemMessage(`${message.username} has accepted your invitation!`);
          // Clear invitePending since the challenge is now resolved
          this.invitePending = false;
          // Set both users back to "invited" status (yellow) after accepting
          this.users = this.users.map((user: User) => {
            if (user.username === message.username || user.username === this.username) {
              return { ...user, status: 'invited' };
            }
            return user;
          });
          this.cdr.markForCheck(); // Trigger change detection
          
          // Keep lobby connection alive while in game room
          this.navigationState.setIntentionalNavigation('game-room');
          
          // Navigate to the game room using the game ID with token as query param
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
          // Validate required fields
          if (!message.username) {
            console.error('Invalid challenge_declined message: missing username field', message);
            break;
          }
          console.log('[Lobby] Received challenge_declined:', message);
          this.addSystemMessage(`${message.username} has declined your invitation.`);
          // Clear invitePending since the challenge is now resolved
          this.invitePending = false;
          // Reset the status of both users to 'online' (green)
          this.users = this.users.map((user: User) => {
            if (user.username === message.username || user.username === this.username) {
              return { ...user, status: 'online' };
            }
            return user;
          });
          // Start 5-second invite cooldown
          this.startInviteCooldown();
          this.cdr.markForCheck(); // Trigger change detection
          break;
        
        case 'connection_established':
          // Server confirmation message - no action needed
          console.log('[Lobby] Server connection confirmed');
          break;
        
        case 'broadcast_message':
          // Handle lobby state broadcast from server - process the nested message
          if (message.data && typeof message.data === 'object' && message.data.type) {
            console.log('[Lobby] Received lobby state broadcast:', message.data);
            // Process the nested message inline
            const nestedMessage = message.data;
            
            // Ignore game room specific messages
            if (nestedMessage.type === 'player_list' || nestedMessage.type === 'player_list_update') {
              console.log('[Lobby] Ignoring player_list message (game room specific)');
              break;
            }
            
            // Handle user_list inside broadcast_message
            if (nestedMessage.type === 'user_list' && Array.isArray(nestedMessage.users)) {
              // Validate each user object in the array
              const validUsers: User[] = [];
              for (const user of nestedMessage.users) {
                if (!user || typeof user !== 'object') {
                  console.warn('Skipping invalid user object:', user);
                  continue;
                }
                
                // Validate required user fields
                if (!user.username || typeof user.username !== 'string') {
                  console.warn('Skipping user with invalid username:', user);
                  continue;
                }
                
                if (!user.status || typeof user.status !== 'string') {
                  console.warn('Skipping user with invalid status:', user);
                  continue;
                }
                
                // Ensure status is a valid UserStatus value
                const validStatuses: string[] = ['online', 'invited', 'configuring', 'in-game'];
                if (!validStatuses.includes(user.status)) {
                  console.warn(`User ${user.username} has invalid status: ${user.status}, defaulting to 'online'`);
                  user.status = 'online';
                }
                
                validUsers.push(user);
              }
              
              // Merge server list with any local invited statuses
              const serverUsers: User[] = validUsers;
              const previousUsernames = new Set(this.users.map(u => u.username));
              const newUsernames = new Set(serverUsers.map(u => u.username));
              const joined = serverUsers.filter(u => !previousUsernames.has(u.username));
              const left = this.users.filter(u => !newUsernames.has(u.username));
              
              // Trust server status completely
              this.users = serverUsers;
              
              joined.forEach(u => {
                if (u.username !== this.username) this.addSystemMessage(`${u.username} has joined the lobby.`);
              });
              left.forEach(u => {
                if (u.username !== this.username) this.addSystemMessage(`${u.username} has left the lobby.`);
              });
              
              // Clear the rejoining flag (but do NOT reset statuses - trust the server's live statuses)
              if (this.isRejoiningFromNavigation) {
                this.isRejoiningFromNavigation = false;
              }
              
              this.sharedDataService.updateLobbyUsers(this.users);
              this.cdr.markForCheck(); // Trigger change detection
            }
          }
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
          localStorage.setItem('username', message.username);
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
            // Reset local user statuses back to online
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
          // Unknown message type - log but don't break functionality
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
        rejoining: this.isRejoiningFromNavigation
      });
    } else {
      // Connect to the lobby
      console.log('[Lobby] Connecting to WebSocket lobby...');
      this.wsService.connect('lobby');
      
      // Send join message when connection is established
      this.wsService.connectionStatus$.pipe(
        filter(connected => connected === true),
        take(1),
        takeUntil(this.destroy$)
      ).subscribe(
        () => {
          // Guard against sending if component has been destroyed
          if (this.isDestroyed) {
            console.log('[Lobby] Skipping join_lobby - component destroyed');
            return;
          }
          console.log('[Lobby] Connection established, sending join_lobby message');
          this.wsService.sendMessage({
            type: 'join_lobby',
            username: this.username,
            rejoining: this.isRejoiningFromNavigation
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
    // Mark component as destroyed immediately to prevent any further message processing
    this.isDestroyed = true;
    
    // Remove beforeunload handler
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    
    // Always clear countdown timer first, regardless of connection state
    if (this.countdownTimerId) {
      clearInterval(this.countdownTimerId);
      this.countdownTimerId = null;
    }
    
    // Clear invite cooldown timer
    if (this.inviteCooldownTimerId) {
      clearInterval(this.inviteCooldownTimerId);
      this.inviteCooldownTimerId = null;
    }
    
    // CRITICAL: Always cleanup subscriptions via destroy$ to prevent memory leaks
    // This must happen before any early returns
    this.destroy$.next();
    this.destroy$.complete();
    
    // Check if we're intentionally navigating to setup or game room
    const isIntentionalNav = this.navigationState.isIntentionalNavigation();
    const navContext = this.navigationState.getNavigationContext();
    
    if (isIntentionalNav && (navContext === 'setup' || navContext === 'game-room')) {
      // Do not disconnect or send leave message if navigating to setup or game room
      // Subscriptions already cleaned up above
      return;
    }
    
    // Send leave message for true disconnects
    this.wsService.sendMessage({
      type: 'leave_lobby',
      username: this.username
    });
    
    // Disconnect
    this.wsService.disconnect();
    
    // Unsubscribe (redundant due to destroy$ above, but keeping for explicitness)
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    
    if (this.messagesSubscription) {
      this.messagesSubscription.unsubscribe();
    }
    
    this.destroy$.next();
    this.destroy$.complete();
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
    // Validate message length
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
    // Validate username length
    if (trimmedUsername.length < 1 || trimmedUsername.length > 24) {
      this.addSystemMessage('Username must be between 1 and 24 characters.');
      return;
    }
    try {
      // Send the request to change the username
      this.wsService.sendMessage({
        type: 'change_username',
        oldUsername: this.username,
        newUsername: trimmedUsername
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
    
    // Don't allow inviting yourself
    if (user.username === this.username) return;
    
    // Use centralized validation
    const validation = this.canInviteUser(user.username);
    
    // Remove any existing menus first
    const existingMenus = document.querySelectorAll('.user-context-menu');
    existingMenus.forEach(menu => document.body.removeChild(menu));
    
    // Create the context menu
    const menu = document.createElement('div');
    menu.className = 'user-context-menu';
    
    // Create button based on invitation rules
    menu.innerHTML = validation.canInvite ? 
      `<button>Invite</button>` : 
      `<button disabled>${validation.reason}</button>`;
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
      if (validation.canInvite) {
        this.inviteUser(user.username);
      }
      if (document.body.contains(menu)) {
        document.body.removeChild(menu);
      }
    });
    
    // Add menu to body
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
    
    // Add a delay to prevent immediate closing
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 100);
  }
  
  /**
   * Centralized invitation validation logic.
   * Returns whether the current user can invite the target user and the reason if not.
   */
  private canInviteUser(targetUsername: string): { canInvite: boolean; reason: string } {
    // Check if on invite cooldown
    if (this.inviteCooldownRemaining > 0) {
      return { canInvite: false, reason: `Wait ${this.inviteCooldownRemaining}s before inviting` };
    }
    
    // Check if we have a pending outgoing invite
    if (this.invitePending) {
      return { canInvite: false, reason: 'Invite pending. Wait for response or timeout.' };
    }
    
    // Can't invite yourself
    if (targetUsername === this.username) {
      return { canInvite: false, reason: 'Cannot invite yourself' };
    }
    // Find the target user
    const targetUser = this.users.find(u => u.username === targetUsername);
    if (!targetUser) {
      return { canInvite: false, reason: 'User not found' };
    }
    // Lock out sending new invites while an invite is pending (sent or received)
    if (this.activeInvite) {
      return { canInvite: false, reason: 'You already have a pending invite. Wait for it to be accepted, declined, or time out.' };
    }
    
    // Get current user's status
    const currentUserStatus = this.users.find(u => u.username === this.username)?.status;
    
    // Cannot invite users who are configuring
    if (targetUser.status === 'configuring') {
      return { canInvite: false, reason: 'Cannot invite while configuring setup' };
    }
    
    // Cannot invite users who are in-game
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
   * @deprecated Use canInviteUser() instead. Kept for backwards compatibility.
   */
  alreadyInvited(targetUsername: string): boolean {
    return !this.canInviteUser(targetUsername).canInvite;
  }
  
  private handleGameChallenge(message: any): void {
    console.log('[Lobby] handleGameChallenge called with:', message);
    console.log('[Lobby] Current activeInvite:', this.activeInvite);
    
    // Validate message has required fields (backend sends 'inviteId', not 'challenge_id')
    if (!message?.challenger || !message?.inviteId) {
      console.error('Invalid game challenge message:', message);
      return;
    }
    
    // Don't accept invite if we already have one active
    if (this.activeInvite) {
      console.warn('[Lobby] Already have active invite, ignoring new challenge');
      return;
    }

    // Clear any existing countdown timer
    this.clearCountdownTimer();

    // Set up the new challenge
    this.activeInvite = {
      inviter: message.challenger,
      inviteId: message.inviteId,
      timeLeft: 5 // 5 seconds to accept
    };
    
    console.log('[Lobby] Set activeInvite:', this.activeInvite);

    // Update the status of both users to 'yellow' (invited)
    this.users = this.users.map((user: User) => {
      if (user.username === message.challenger || user.username === this.username) {
        return { ...user, status: 'invited' };
      }
      return user;
    });
    
    this.cdr.markForCheck(); // Trigger change detection for invite dialog

    // Add system message
    this.addSystemMessage(`${message.challenger} has invited you to a game. You have 5 seconds to accept.`);

    // Start countdown with guaranteed cleanup
    this.countdownTimerId = setInterval(() => {
      if (this.activeInvite) {
        this.activeInvite.timeLeft--;
        this.cdr.markForCheck(); // Trigger change detection for countdown update

        if (this.activeInvite.timeLeft <= 0) {
          // Time expired, auto-decline and cleanup
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
    const cooldownSeconds = 5;
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
    // Set navigation state before navigating
    this.navigationState.setIntentionalNavigation('setup');
    this.wsService.sendMessage({
      type: 'set_status',
      username: this.username,
      status: 'configuring'
    });
    this.router.navigate(['/setup']);
  }
}
