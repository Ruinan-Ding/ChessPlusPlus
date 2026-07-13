import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Router } from '@angular/router';

@Component({
  selector: 'app-connection-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './connection-dialog.component.html',
  styleUrls: ['./connection-dialog.component.scss']
})
export class ConnectionDialogComponent implements OnInit, OnDestroy {
  isReconnecting = false;
  attemptCount = 0;
  maxAttempts = 5;
  connectionFailed = false;
  
  private subscriptions: Subscription[] = [];
  private destroy$ = new Subject<void>();
  
  constructor(
    private wsService: WebsocketService,
    private router: Router
  ) {}
  
  ngOnInit(): void {
    this.wsService.reconnecting$.pipe(takeUntil(this.destroy$)).subscribe(reconnecting => {
      this.isReconnecting = reconnecting;
    });

    this.wsService.reconnectAttempts$.pipe(takeUntil(this.destroy$)).subscribe(attempts => {
      this.attemptCount = attempts;
    });

    this.wsService.connectionFailed$.pipe(takeUntil(this.destroy$)).subscribe(failed => {
      this.connectionFailed = failed;
    });
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
  
  retry(): void {
    const currentRoom = this.wsService.getCurrentRoom();
    this.wsService.connect(currentRoom);
  }
  
  goToLogin(): void {
    this.router.navigate(['/']);
  }
}