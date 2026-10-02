import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../services/auth.service';
import { LobbyComponent } from './lobby.component';
import { WebsocketService } from '../../services/websocket.service';

// Stub WebsocketService to prevent WebSocket connection attempts in tests
const mockWebsocketService = {
  connectionStatus$: new BehaviorSubject(false),
  messages$: new BehaviorSubject(null),
  reconnecting$: new BehaviorSubject(false),
  reconnectAttempts$: new BehaviorSubject(0),
  connectionFailed$: new BehaviorSubject(false),
  offline$: new BehaviorSubject(false),
  isLocal: () => false,
  isOffline: () => false,
  reconnectToServer: () => {},
  playOffline: () => {},
  startLocalGame: () => {},
  isConnected: () => false,
  connect: () => {},
  disconnect: () => {},
  sendMessage: () => {},
  startHeartbeat: () => {},
  stopHeartbeat: () => {}
};

describe('LobbyComponent', () => {
  let component: LobbyComponent;
  let fixture: ComponentFixture<LobbyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LobbyComponent],
      providers: [
        // The lobby reads ?solo=1 off ActivatedRoute, which only exists with
        // a router configured.
        provideRouter([]),
        { provide: WebsocketService, useValue: mockWebsocketService }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LobbyComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    mockWebsocketService.messages$.next(null);
    mockWebsocketService.connectionStatus$.next(false);
    TestBed.inject(AuthService).logout();
  });

  it('retains a tripcode for renames and reconnects, changes its key, and can remove it', () => {
    const sent: any[] = [];
    spyOn(mockWebsocketService, 'sendMessage').and.callFake(((m: any) => sent.push(m)) as any);
    const socket = mockWebsocketService.messages$ as BehaviorSubject<any>;
    const ack = (username: string, token: string) => socket.next({
      type: 'username_assigned', reason: 'tripcode', username, tripcodeToken: token, message: 'saved'
    });
    ack('Alice!ABCDEFGHIJK2', 'private-proof');
    component.newUsername = 'Bob';
    component.changeUsername();
    expect(sent.at(-1).tripcodeToken).toBe('private-proof');
    expect(sent.at(-1).newUsername).toBe('Bob');
    component.newUsername = 'Bob#new key';
    component.changeUsername();
    expect(sent.at(-1).tripcodeKey).toBe('new key');
    expect(sent.at(-1).tripcodeToken).toBeUndefined();
    ack('Bob!ABCDEFGHIJK3', 'new-proof');
    expect(component.newUsername).toBe('Bob');
    expect(component.showChangeUsername).toBeFalse();
    mockWebsocketService.connectionStatus$.next(true);
    expect(sent.at(-1).tripcodeToken).toBe('new-proof');
    component.removeTripcode = true;
    component.changeUsername();
    expect(sent.at(-1).tripcodeToken).toBe('');
    socket.next({ type: 'username_assigned', reason: 'normalized', username: 'Bob', tripcodeToken: '', message: 'saved' });
    expect(TestBed.inject(AuthService).hasTripcode()).toBeFalse();
  });

  it('sends all 128 emoji from native rename entry and refuses 129 without truncating', async () => {
    const sent: any[] = [];
    spyOn(mockWebsocketService, 'sendMessage').and.callFake(((m: any) => sent.push(m)) as any);
    component.toggleChangeUsername();
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.change-username input[type=text]');
    const name = 'B'.repeat(24);
    for (const length of [128, 129]) {
      const key = '😀'.repeat(length);
      const value = `${name}#${key}`;
      await fixture.whenStable();
      input.focus();
      input.select();
      expect(document.execCommand('insertText', false, value)).toBeTrue();
      await fixture.whenStable();
      expect(input.value).toBe(value);
      expect(component.newUsername).toBe(value);
      expect(component.newUsernameLength).toBe(24);
      component.changeUsername();
      if (length === 128) {
        expect(sent.at(-1)).toEqual(jasmine.objectContaining({
          type: 'change_username', newUsername: name, tripcodeKey: key
        }));
        expect(component.renameError).toBe('');
      } else {
        expect(component.renameError).toContain('128 characters');
        expect(component.newUsername).toBe(value);
      }
    }
    expect(sent.filter(m => m.type === 'change_username').length).toBe(1);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('names the server hands back', () => {
    const clear = () => {
      localStorage.removeItem('username');
      sessionStorage.removeItem('username');
    };
    afterEach(clear);

    it('keeps a guest name to its tab, and remembers a canonical name', () => {
      const socket = mockWebsocketService.messages$ as BehaviorSubject<any>;
      localStorage.setItem('username', 'Chosen');
      socket.next({
        type: 'username_assigned', username: 'Guest123456', originalUsername: 'Chosen',
        reason: 'taken', message: 'Username "Chosen" was taken.',
      });
      expect(component.username).toBe('Guest123456');
      expect(sessionStorage.getItem('username')).toBe('Guest123456');
      expect(localStorage.getItem('username')).toBe('Chosen');
      expect(component.showChangeUsername).toBeTrue();

      component.keepAssignedName();
      socket.next({
        type: 'username_assigned', username: 'Alice', originalUsername: 'alice',
        reason: 'normalized', message: 'Your name is saved as "Alice".',
      });
      expect(component.username).toBe('Alice');
      expect(localStorage.getItem('username')).toBe('Alice');
      expect(component.showChangeUsername).toBeFalse();
    });

    it('joins again once when another connection holds its name', () => {
      const sent: any[] = [];
      // The stub's sendMessage takes nothing, so the fake is cast to fit it.
      spyOn(mockWebsocketService, 'sendMessage').and.callFake(((m: any) => { sent.push(m); }) as any);
      const socket = mockWebsocketService.messages$ as BehaviorSubject<any>;
      const joins = () => sent.filter(m => m.type === 'join_lobby').length;
      const reclaimed = { type: 'error', code: 'NAME_RECLAIMED', message: 'in use' };

      socket.next({ ...reclaimed });
      socket.next({ ...reclaimed });
      expect(joins()).toBe(1);
      // Never as a rejoin: that would take the name straight back.
      expect(sent.find(m => m.type === 'join_lobby').rejoining).toBeFalse();

      // Answered - every join gets a user list - so a later one may rejoin again.
      socket.next({ type: 'user_list', users: [] });
      socket.next({ ...reclaimed });
      expect(joins()).toBe(2);
    });

    it('can invite again as a guest after its old name was reclaimed', () => {
      const sent: any[] = [];
      spyOn(mockWebsocketService, 'sendMessage').and.callFake(((m: any) => sent.push(m)) as any);
      const socket = mockWebsocketService.messages$ as BehaviorSubject<any>;
      component.users = [{ username: component.username, status: 'online' }, { username: 'bob', status: 'online' }];
      component.inviteUser('bob');
      expect(component.invitePending).toBeTrue();

      socket.next({ type: 'error', code: 'NAME_RECLAIMED', message: 'in use' });
      expect(component.invitePending).toBeFalse();
      socket.next({ type: 'username_assigned', username: 'Guest123456', reason: 'taken', message: 'taken' });
      socket.next({ type: 'user_list', users: [{ username: 'Guest123456', status: 'online' }, { username: 'bob', status: 'online' }] });
      expect(component.renameLocked).toBeFalse();
      expect((component as any).canInviteUser('bob').canInvite).toBeTrue();
      component.inviteUser('bob');
      const invites = sent.filter(m => m.type === 'game_challenge');
      expect(invites.length).toBe(2);
      expect(invites[1].challenger).toBe('Guest123456');
    });

    it('clears an incoming invitation and its countdown when its name is reclaimed', () => {
      const socket = mockWebsocketService.messages$ as BehaviorSubject<any>;
      socket.next({ type: 'game_challenge', challenger: 'bob', inviteId: 'old-invite' });
      expect(component.activeInvite).not.toBeNull();
      expect((component as any).countdownTimerId).not.toBeNull();
      socket.next({ type: 'error', code: 'NAME_RECLAIMED', message: 'in use' });
      expect(component.activeInvite).toBeNull();
      expect((component as any).countdownTimerId).toBeNull();
      expect(component.renameLocked).toBeFalse();
    });

    it('offers no rename with an invite out', () => {
      component.invitePending = true;
      expect(component.renameLocked).toBeTrue();
      component.toggleChangeUsername();
      expect(component.showChangeUsername).toBeFalse();
    });
  });

  it('says why a rename was refused in the rename panel, and shuts it once one goes through', () => {
    const socket = mockWebsocketService.messages$ as BehaviorSubject<any>;
    component.toggleChangeUsername();
    fixture.detectChanges();
    // The server refuses a name with an error like any other. It went to the
    // chat - under the fold on a phone - and the panel said nothing.
    socket.next({ type: 'error', code: 'USERNAME_TAKEN', message: 'Username "Bo" is already taken' });
    fixture.detectChanges();
    const said = fixture.nativeElement.querySelector('.change-username .rename-error');
    expect(said?.textContent.trim()).toBe('Username "Bo" is already taken');
    expect(component.messages.some(m => m.content.includes('already taken'))).toBeFalse();

    // Typing again clears it.
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.change-username input');
    input.value = 'Bob';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(component.renameError).toBe('');
    expect(fixture.nativeElement.querySelector('.change-username .rename-error')).toBeNull();

    // Through: the panel shuts. It stayed open, holding the new name.
    socket.next({ type: 'username_changed', oldUsername: component.username, newUsername: 'Bob' });
    expect(component.username).toBe('Bob');
    expect(component.showChangeUsername).toBeFalse();

    // With the panel shut, an error is the chat's, as it always was.
    socket.next({ type: 'error', code: 'USERNAME_TAKEN', message: 'Username "Zed" is already taken' });
    expect(component.renameError).toBe('');
    expect(component.messages.some(m => m.content.includes('"Zed" is already taken'))).toBeTrue();
  });

  it('leaves a reader where they are in the chat, and follows only from its newest line', () => {
    const c = component as any;
    const scrolled = spyOn(c, 'scrollChatToBottom');
    const log = { scrollHeight: 500, scrollTop: 0, clientHeight: 100 };
    c.chatLog = { nativeElement: log };
    const line = (username: string) => [...component.messages, { username, content: 'hi', timestamp: '' }];

    // Reading back: somebody else's line leaves them there; their own does not.
    c.onLobbyMessages(line('Zed'));
    expect(scrolled).not.toHaveBeenCalled();
    c.onLobbyMessages(line(component.username));
    expect(scrolled).toHaveBeenCalledTimes(1);
    // At the newest line: it follows.
    log.scrollTop = 400;
    c.onLobbyMessages(line('Zed'));
    expect(scrolled).toHaveBeenCalledTimes(2);
  });
});
