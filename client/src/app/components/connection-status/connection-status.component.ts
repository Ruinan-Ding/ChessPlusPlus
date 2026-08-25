import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-connection-status',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="connection-status">
      <span [ngClass]="{'connected': isConnected, 'offline': !isConnected && isOffline, 'disconnected': !isConnected && !isOffline}">
        {{ isConnected ? 'Connected to Game Server' : (isOffline ? 'Offline' : 'Disconnected from Game Server') }}
      </span>
      <!-- Any state without a server needs a visible way back to one. -->
      <button *ngIf="!isConnected" class="reconnect-btn" (click)="reconnect()"
              title="Try the game server again">Reconnect</button>
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

    .offline {
      color: #b7791f;
      font-weight: bold;
    }

    .reconnect-btn {
      margin-left: 8px;
      padding: 2px 10px;
      border: 1px solid #2c3e50;
      border-radius: 4px;
      background: #fff;
      color: #2c3e50;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .reconnect-btn:hover {
      background: #eef2f6;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConnectionStatusComponent implements OnInit, OnDestroy {
  isConnected = false;
  /** Deliberately serverless - a different thing from a socket that dropped. */
  isOffline = false;
  private subscription: Subscription | null = null;
  private destroy$ = new Subject<void>();

  constructor(
    private wsService: WebsocketService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Only the socket may claim a server; a solo game is not a connection and
    // not a disconnection either.
    this.wsService.offline$.pipe(takeUntil(this.destroy$)).subscribe(off => {
      this.isOffline = off;
      this.cdr.markForCheck();
    });
    this.subscription = this.wsService.connectionStatus$.pipe(takeUntil(this.destroy$)).subscribe(
      (status: boolean) => {
        console.log('Connection status updated:', status);
        this.isConnected = status;
        this.cdr.markForCheck();
      }
    );
  }

  /** Leave offline mode and try the server again. */
  reconnect(): void {
    this.wsService.reconnectToServer();
  }

  ngOnDestroy(): void {
    // Clean up subscription but don't disconnect
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    this.destroy$.next();
    this.destroy$.complete();
  }
}