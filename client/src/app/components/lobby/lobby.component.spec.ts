import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

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

  // The stub's socket is shared by every spec here, and holds its last message.
  afterEach(() => mockWebsocketService.messages$.next(null));

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('names the server hands back', () => {
    const clear = () => {
      localStorage.removeItem('username');
      sessionStorage.removeItem('username');
    };
    afterEach(clear);

    it('keeps a guest name to its tab, and remembers a name only normalized', () => {
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
        type: 'username_assigned', username: 'Alice', originalUsername: 'Ａlice',
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
