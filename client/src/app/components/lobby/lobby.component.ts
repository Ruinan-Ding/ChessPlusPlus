import { Component, OnInit, OnDestroy, AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WebsocketService } from '../../services/websocket.service';
import { Subject } from 'rxjs';
import { takeUntil, filter } from 'rxjs/operators';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { VolumeControlComponent } from '../volume-control/volume-control.component';
import { ConnectionDialogComponent } from '../connection-dialog/connection-dialog.component';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedDataService, ChatMessage, User, selfFirst } from '../../services/shared-data.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { AuthService } from '../../services/auth.service';
import { parseUsernameInput, randomUsername, USERNAME_INPUT_ERROR } from '../../services/username';
import { readStore, removeStore, writeStore } from '../../services/storage';
import { closeUserMenu, openUserMenu as showUserMenu } from '../../services/user-menu';
import { afterDraw, atNewest } from '../../services/scrolling';

/** What the server answers a refused rename with (validators.py, consumers.py). */
const RENAME_ERRORS = ['USERNAME_TAKEN', 'INVALID_USERNAME', 'USERNAME_TOO_LONG', 'INVALID_TRIPCODE', 'NAME_LOCKED'];

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectionStatusComponent, ConnectionDialogComponent,
    VolumeControlComponent],
  templateUrl: './lobby.component.html',
  styleUrls: ['./lobby.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LobbyComponent implements OnInit, OnDestroy, AfterViewInit {
  private isRejoiningFromNavigation: boolean = false;
  username: string = '';
  users: User[] = [];

  /** Online users with yourself pinned to the top of the list. */
  get sortedUsers(): User[] {
    // With no server there is no roster to speak of - just you.
    if (!this.serverOnline) return [{ username: this.username, status: 'online' } as User];
    return selfFirst(this.users, this.username);
  }

  /** False whenever the socket is down, offline mode included. */
  serverOnline = false;
  messages: ChatMessage[] = [];
  messageContent: string = '';
  newUsername: string = '';
  removeTripcode = false;
  showChangeUsername: boolean = false;
  /** The server had to rename us; the panel is open to offer a better one. */
  nameWasTaken: boolean = false;
  /**
   * Why the name asked for was refused, in the rename panel where it was
   * asked. It went to the chat - under the fold on a phone - and the panel
   * sat open saying nothing.
   */
  renameError = '';

  @ViewChild('lobbyTitle') private lobbyTitle?: ElementRef<HTMLElement>;
  hideTitle = false;
  private titleObserver?: ResizeObserver;

  /** The chat's log, to follow its newest line (onLobbyMessages). */
  @ViewChild('lobbyChat') private chatLog?: ElementRef<HTMLElement>;
  activeInvite: {
    inviter: string;
    inviteId: string;
    timeLeft: number;
  } | null = null;
  invitePending: boolean = false;

  /**
   * No rename with an invite out or in: an invite is addressed to a name, and
   * the server refuses it (NAME_LOCKED) - a rename then freed the old name for
   * whoever took it next, and that player was sent the room when the invite
   * was accepted.
   */
  get renameLocked(): boolean {
    return this.invitePending || !!this.activeInvite;
  }

  get hasTripcode(): boolean {
    return this.authService.hasTripcode();
  }

  /** The base name's length, excluding its optional key. */
  get newUsernameLength(): number {
    return this.newUsername.trim().split('#', 1)[0].length;
  }

  /** A rejoin sent because another connection holds our name - see 'error'. */
  private nameRejoinSent = false;

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
    private route: ActivatedRoute,
    private sharedDataService: SharedDataService,
    private navigationState: NavigationStateService,
    private cdr: ChangeDetectorRef,
    private authService: AuthService
  ) {}
  
  ngOnInit(): void {
    
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    
    this.isRejoiningFromNavigation = this.navigationState.isIntentionalNavigation();
    const navContext = this.navigationState.getNavigationContext();
    
    
    // If context is 'none', we're returning from a game room - apply remaining invite cooldown
    // Cooldown is 5 seconds from when they joined the game room, not from when they left
    if (navContext === 'none' && this.isRejoiningFromNavigation) {
      // A solo room never involved another player, so there is nothing to
      // rate-limit - leaving one must not block the next invite.
      if (readStore('session', 'leftSinglePlayer') === '1') {
        removeStore('session', 'leftSinglePlayer');
      } else if (this.gameRoomJoinTime > 0) {
        const elapsedSeconds = Math.ceil((Date.now() - this.gameRoomJoinTime) / 1000);
        const remainingCooldown = Math.max(0, 5 - elapsedSeconds);
        if (remainingCooldown > 0) {
          this.startInviteCooldownWithDuration(remainingCooldown);
        }
      } else {
        this.startInviteCooldown();
      }
    }
    
    if (this.isRejoiningFromNavigation) {
      this.navigationState.clearIntentionalNavigation();
      // Clear any lingering invite state (user statuses come from the server)
      this.activeInvite = null;
      this.invitePending = false;
    }
    
    // Written back only when it was made up here: the tab's name may be a
    // guest name the server handed out, which is this tab's and nobody's
    // starting name (AuthService).
    const current = this.authService.getUsername();
    this.username = current || randomUsername(this.sharedDataService.getLobbyUsers().map(user => user.username));
    if (!current) this.authService.setUsername(this.username, false, '');
    this.newUsername = this.authService.getBaseUsername();
    
    this.wsService.connectionStatus$.pipe(takeUntil(this.destroy$)).subscribe(connected => {
      this.serverOnline = connected;
      this.cdr.markForCheck();
    });

    this.messages = this.sharedDataService.getLobbyMessages();
    this.sharedDataService.lobbyMessages$.pipe(takeUntil(this.destroy$))
      .subscribe(msgs => this.onLobbyMessages(msgs));
    
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
          // Every join is answered with one, so a rejoin has landed.
          this.nameRejoinSent = false;
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
            console.error('Invalid username_changed message: missing required fields');
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
            this.authService.setUsername(this.username);
            this.keepAssignedName();
          }
          this.cdr.markForCheck();
          break;

        case 'game_challenge':
          this.handleGameChallenge(message);
          break;
          
        case 'challenge_accepted':
          if (!message.username || !message.gameId || !message.token) {
            console.error('Invalid challenge_accepted message: missing required fields');
            break;
          }
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
            this.router.navigate(['/game-room', gameId], { queryParams: { token: gameToken } }).catch(err => {
              console.error('Navigation to game room failed:', err);
            });
          }
          break;
          
        case 'single_player_game_created': {
          if (!message.gameId || !message.token) {
            console.error('Invalid single_player_game_created message', message);
            break;
          }
          // Same hand-off as an accepted challenge: keep the lobby socket alive
          // across the navigation, then open the room with the host token.
          // Only now is a solo room really entered, so only now does leaving
          // one get to skip the invite cooldown - a create that never landed
          // must not hand out that bypass.
          writeStore('session', 'leftSinglePlayer', '1');
          this.navigationState.setIntentionalNavigation('game-room');
          this.router.navigate(['/game-room', message.gameId], {
            queryParams: { token: message.token }
          }).catch(err => console.error('Navigation to solo game room failed:', err));
          break;
        }

        case 'challenge_declined':
          if (!message.username) {
            console.error('Invalid challenge_declined message: missing username field', message);
            break;
          }
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
          this.username = message.username;
          this.addSystemMessage(message.message);
          if (message.reason === 'normalized' || message.reason === 'tripcode') {
            this.authService.setUsername(message.username, true, message.tripcodeToken || '');
            this.keepAssignedName();
          } else {
            // A refused name falls back to a guest identity for this tab only.
            this.authService.setUsername(message.username, false, '');
            this.removeTripcode = false;
            this.nameWasTaken = true;
            this.showChangeUsername = true;
            this.newUsername = '';
            this.renameError = '';
          }
          this.cdr.markForCheck();
          break;

        case 'error':
          console.error('[Lobby] Backend error:', message);
          // A rename refused, with the panel that asked for it open: said
          // there, not in the chat. (There is no `username_error`: the server
          // refuses a name with an error like any other, and the case that
          // alerted on one was never reached.)
          if (this.showChangeUsername && RENAME_ERRORS.includes(message.code)) {
            this.renameError = message.message || 'That name cannot be used.';
            this.cdr.markForCheck();
            break;
          }
          // Another connection - another tab of this browser, or the player
          // whose name this was - holds our name now, and the server refuses
          // whatever this one does in it. Join again, once however many were
          // refused: the server answers with the name, or a guest's. Never as
          // `rejoining`, which would take the name straight back from the
          // other connection and have the two trade it on every action.
          if (message.code === 'NAME_RECLAIMED') {
            this.clearCountdownTimer();
            this.activeInvite = null;
            this.invitePending = false;
            if (!this.nameRejoinSent) {
              this.nameRejoinSent = true;
              this.addSystemMessage('Your name is in use somewhere else - rejoining...');
              this.joinLobby(false);
            }
            this.cdr.markForCheck();
            break;
          }
          if (message.message) {
            this.addSystemMessage(`Error: ${message.message}`);
          }
          // Reset invitePending for challenge-related errors so user can try again
          const challengeErrorCodes = [
            'CHALLENGE_EXISTS', 'OPPONENT_BUSY', 'CHALLENGER_BUSY', 
            'CHALLENGE_NOT_FOUND', 'USER_NOT_FOUND', 'INVALID_OPPONENT'
          ];
          if (message.code && challengeErrorCodes.includes(message.code)) {
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
    
    // Offline connect() records the room for Reconnect without opening a socket.
    this.wsService.connect('lobby');
    if (this.wsService.isOffline()) {
      this.joinLobby();  // answered locally; there is no socket to wait for
    }
    // Join on every connection: now if one is already up, and again after a
    // reconnect (the Reconnect button, or the retry loop coming good).
    this.wsService.connectionStatus$.pipe(
      filter(connected => connected === true),
      takeUntil(this.destroy$)
    ).subscribe(() => this.joinLobby());

    // Sent here by the game room's Single Player button: there is no server to
    // come back to, so deal a local game rather than land in a dead lobby.
    if (this.route.snapshot.queryParamMap.get('solo') === '1') {
      this.startSinglePlayer();
    }
  }
  
  private joinLobby(rejoining = this.isRejoiningFromNavigation): void {
    this.wsService.sendMessage({
      type: 'join_lobby',
      username: this.username,
      ...this.authService.getTripcodeCredentials(),
      rejoining,
      secret: this.authService.getIdentitySecret()
    });
  }

  ngAfterViewInit(): void {
    const title = this.lobbyTitle?.nativeElement;
    if (!title || typeof ResizeObserver === 'undefined') return;
    this.titleObserver = new ResizeObserver(() => {
      const span = title.querySelector('span')!;
      const hidden = span.scrollWidth > span.clientWidth + 1;
      if (hidden !== this.hideTitle) {
        this.hideTitle = hidden;
        this.cdr.markForCheck();
      }
    });
    this.titleObserver.observe(title);
  }

  ngOnDestroy(): void {
    this.titleObserver?.disconnect();
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    // Built on the body, it would outlive the lobby.
    closeUserMenu();

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
  
  private handleBeforeUnload = (_event: BeforeUnloadEvent): void => {
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
  
  /** Close the rename panel, keeping whatever name we currently hold. */
  keepAssignedName(): void {
    this.showChangeUsername = false;
    this.nameWasTaken = false;
    this.renameError = '';
    this.removeTripcode = false;
    this.newUsername = this.authService.getBaseUsername();
    this.cdr.markForCheck();
  }

  changeUsername(): void {
    const trimmedUsername = this.newUsername.trim();
    if (!trimmedUsername && this.nameWasTaken) {
      // Nothing typed after a collision: the random name stands.
      this.keepAssignedName();
      return;
    }
    if (!this.username || typeof this.username !== 'string' || this.username.trim() === '') {
      this.renameError = 'You must be logged in to change your username.';
      return;
    }
    const parsed = parseUsernameInput(trimmedUsername);
    if (!parsed) {
      this.renameError = USERNAME_INPUT_ERROR;
      return;
    }
    if (parsed.username === this.authService.getBaseUsername() && !parsed.tripcodeKey && !this.removeTripcode) {
      this.keepAssignedName();
      return;
    }
    if (this.removeTripcode && parsed.tripcodeKey) {
      this.renameError = 'Remove #key from the name to remove your tripcode.';
      return;
    }
    if ((parsed.tripcodeKey || this.hasTripcode) && this.wsService.isOffline()) {
      this.renameError = 'Tripcodes need a server connection.';
      return;
    }
    let credentials = this.authService.getTripcodeCredentials();
    if (this.removeTripcode) credentials = { tripcodeToken: '' };
    else if (parsed.tripcodeKey) credentials = { tripcodeKey: parsed.tripcodeKey };
    this.renameError = '';
    try {
      this.wsService.sendMessage({
        type: 'change_username',
        ...credentials,
        oldUsername: this.username,
        newUsername: parsed.username,
        secret: this.authService.getIdentitySecret()
      });
    } catch (error) {
      console.error('Failed to change username:', error);
      this.renameError = 'Failed to change username. Please try again.';
    }
  }

  toggleChangeUsername(): void {
    if (this.renameLocked && !this.showChangeUsername) return;
    this.showChangeUsername = !this.showChangeUsername;
    this.removeTripcode = false;
    this.nameWasTaken = false;
    this.renameError = '';
    this.newUsername = this.authService.getBaseUsername();
  }

  openUserMenu(event: MouseEvent, user: User): void {
    event.preventDefault();
    if (user.username === this.username) return;
    const validation = this.canInviteUser(user.username);
    showUserMenu(event, validation.canInvite ? 'Invite' : validation.reason, validation.canInvite,
      () => this.inviteUser(user.username));
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
    if (!this.activeInvite) {
      console.warn('[Lobby] No active invite to respond to');
      return;
    }
    const messageType = response === 'accept' ? 'challenge_accept' : 'challenge_decline';
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
  }
  
  private addSystemMessage(content: string): void {
    this.sharedDataService.addLobbyMessage({
      username: 'System',
      content: content,
      timestamp: new Date().toISOString(),
      type: 'system'
    });
    // The chat follows it if its reader is at the newest line (onLobbyMessages).
  }
  
  /**
   * The chat keeps to its newest line - unless its reader has scrolled back:
   * a line coming in moves it only if it was at its newest, or the line is
   * the reader's own. It used to go to the bottom on every line, pulling a
   * reader off what they were reading (the room's chats had the same, and
   * follow the same rule now).
   */
  private onLobbyMessages(msgs: ChatMessage[]): void {
    const follow = this.chatAtNewest() || msgs[msgs.length - 1]?.username === this.username;
    this.messages = msgs;
    this.cdr.markForCheck();
    if (follow) this.scrollChatToBottom();
  }

  /** At its newest line, give or take a few pixels - or not drawn yet: the room's rule too. */
  private chatAtNewest(): boolean {
    return atNewest(this.chatLog?.nativeElement);
  }

  private scrollChatToBottom(): void {
    // Once the new line is drawn (afterDraw). A 100ms guess pulled a reader
    // scrolling up back down.
    afterDraw(() => {
      const log = this.chatLog?.nativeElement;
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  /** Solo room: you plus a placeholder opponent seat you configure yourself. */
  startSinglePlayer(): void {
    // A solo game has no second player, so it runs entirely in the browser -
    // no room row, no UUID, no token, and it survives losing the server.
    this.wsService.startLocalGame();
    this.wsService.sendMessage({
      type: 'create_single_player_game',
      username: this.username
    });
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
