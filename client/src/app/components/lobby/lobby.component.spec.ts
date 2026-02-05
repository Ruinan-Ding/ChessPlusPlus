import { ComponentFixture, TestBed } from '@angular/core/testing';
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
        { provide: WebsocketService, useValue: mockWebsocketService }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LobbyComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
