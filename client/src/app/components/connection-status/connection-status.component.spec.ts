import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { ConnectionStatusComponent } from './connection-status.component';
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

describe('ConnectionStatusComponent', () => {
  let component: ConnectionStatusComponent;
  let fixture: ComponentFixture<ConnectionStatusComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectionStatusComponent],
      providers: [
        { provide: WebsocketService, useValue: mockWebsocketService }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ConnectionStatusComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
