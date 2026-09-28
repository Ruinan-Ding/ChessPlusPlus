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
      <!-- The state's word, then what it is about. A header short of room
           (the game room's, marked .header-compact) keeps the word alone:
           "Connected" says the same as "Connected to Game Server", and it is
           a quarter of the width the turn banner beside it needs. -->
      <span [ngClass]="{'connected': isConnected, 'offline': !isConnected && isOffline, 'disconnected': !isConnected && !isOffline}"
        >{{ isConnected ? 'Connected' : (isOffline ? 'Offline' : 'Disconnected') }}<span class="status-rest"
        >{{ isConnected ? ' to Game Server' : (isOffline ? '' : ' from Game Server') }}</span></span>
      <!-- Any state without a server needs a visible way back to one. -->
      <button *ngIf="!isConnected" class="reconnect-btn" (click)="reconnect()"
              title="Try the game server again">Reconnect</button>
    </div>
  `,
  styles: [`
    .connection-status {
      /* Sits in headers that have to stay one line, so it takes the font size
         it is given and never wraps - "Disconnected from Game Server" is long
         enough to break the lobby header on its own. */
      padding: 2px 0;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
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
      margin-left: 6px;
      padding: 2px 8px;
      border: 1px solid #2c3e50;
      border-radius: 4px;
      background: #fff;
      color: #2c3e50;
      /* A little under the words beside it, but never under 12px or a 24px
         target (WCAG 2.2, 2.5.8): the game room's header sizes this off a
         unit that bottoms out at 12px, and 0.85 of that was an 11px word on
         an 18px button. */
      font-size: max(12px, 0.85em);
      min-height: 24px;
      white-space: nowrap;
      cursor: pointer;
    }

    .reconnect-btn:hover {
      background: #eef2f6;
    }

    :host-context(.header-compact) .status-rest {
      display: none;
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