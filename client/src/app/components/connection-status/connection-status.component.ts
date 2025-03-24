import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-connection-status',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="connection-status">
      <span [ngClass]="{'connected': isConnected, 'disconnected': !isConnected}">
        {{ isConnected ? 'Connected to Game Server' : 'Disconnected from Game Server' }}
      </span>
    </div>
  `,
  styles: [`
    .connection-status {
      padding: 10px;
      margin: 10px 0;
      border-radius: 4px;
      display: inline-block;
    }
    
    .connected {
      color: green;
      font-weight: bold;
    }
    
    .disconnected {
      color: red;
      font-weight: bold;
    }
  `]
})
export class ConnectionStatusComponent implements OnInit, OnDestroy {
  isConnected = false;
  private subscription: Subscription | null = null;

  constructor(private wsService: WebsocketService) {}

  ngOnInit(): void {
    // Connect to the WebSocket server
    this.wsService.connect();
    
    // Subscribe to connection status updates
    this.subscription = this.wsService.connectionStatus$.subscribe(
      (status: boolean) => {
        this.isConnected = status;
      }
    );
  }

  ngOnDestroy(): void {
    // Clean up subscription and disconnect WebSocket
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    this.wsService.disconnect();
  }
}