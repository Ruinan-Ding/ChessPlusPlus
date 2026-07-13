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
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConnectionStatusComponent implements OnInit, OnDestroy {
  isConnected = false;
  private subscription: Subscription | null = null;
  private destroy$ = new Subject<void>();

  constructor(
    private wsService: WebsocketService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.isConnected = this.wsService.isConnected();
    this.subscription = this.wsService.connectionStatus$.pipe(takeUntil(this.destroy$)).subscribe(
      (status: boolean) => {
        console.log('Connection status updated:', status);
        this.isConnected = status;
        this.cdr.markForCheck();
      }
    );
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