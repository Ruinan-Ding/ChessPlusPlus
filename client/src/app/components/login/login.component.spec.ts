import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { BehaviorSubject } from 'rxjs';

import { LoginComponent } from './login.component';
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
  isConnected: () => false,
  playOffline: () => {},
  reconnectToServer: () => {},
  connect: () => {},
  disconnect: () => {},
  sendMessage: () => {},
  startHeartbeat: () => {},
  stopHeartbeat: () => {}
};

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        { provide: WebsocketService, useValue: mockWebsocketService }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => TestBed.inject(AuthService).logout());

  it('uses Name#key without persisting the entered key and shows the warning', () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const auth = TestBed.inject(AuthService);
    component.username = 'Alice123#test key';
    component.login();
    expect(auth.getUsername()).toBe('Alice123');
    expect(auth.getTripcodeCredentials()).toEqual({ tripcodeKey: 'test key' });
    expect(component.username).toBe('Alice123');
    expect(navigate).toHaveBeenCalledWith(['/lobby']);
    expect(fixture.nativeElement.textContent).toContain('Don’t use passwords or sensitive information');
  });

  it('preserves native entry of 128 emoji and refuses 129 without truncating', async () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const auth = TestBed.inject(AuthService);
    const name = 'A'.repeat(24);
    const input: HTMLInputElement = fixture.nativeElement.querySelector('#username');
    for (const length of [128, 129]) {
      const key = '😀'.repeat(length);
      const value = `${name}#${key}`;
      fixture.detectChanges();
      await fixture.whenStable();
      input.focus();
      input.select();
      // Setting .value directly bypasses the browser's maxlength behavior.
      expect(document.execCommand('insertText', false, value)).toBeTrue();
      await fixture.whenStable();
      expect(input.value).toBe(value);
      expect(component.username).toBe(value);
      expect(component.usernameLength).toBe(24);
      component.login();
      if (length === 128) {
        expect(auth.getTripcodeCredentials()).toEqual({ tripcodeKey: key });
        expect(component.loginError).toBe('');
      } else {
        expect(component.loginError).toContain('128 characters');
        expect(component.username).toBe(value);
      }
    }
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('rejects spaces and a second # before joining', () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate');
    for (const name of ['Alice Smith', 'Alice#one#two', '']) {
      component.username = name;
      component.login();
      expect(component.loginError).toContain('1–24 letters or numbers');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('#username').getAttribute('aria-invalid')).toBe('true');
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
