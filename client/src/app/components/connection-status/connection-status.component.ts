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
    // Don't connect here, just subscribe to status updates
    this.subscription = this.wsService.connectionStatus$.subscribe(
      (status: boolean) => {
        this.isConnected = status;
      }
    );
  }

  ngOnDestroy(): void {
    // Clean up subscription but don't disconnect
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    // Remove this line - don't disconnect when the status component is destroyed
    // this.wsService.disconnect();
  }
}