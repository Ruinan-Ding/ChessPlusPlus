import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { LoginComponent } from './login.component';
import { WebsocketService } from '../../services/websocket.service';

// Stub WebsocketService to prevent WebSocket connection attempts in tests
const mockWebsocketService = {
  connectionStatus$: new BehaviorSubject(false),
  messages$: new BehaviorSubject(null),
  isConnected: () => false,
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

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
