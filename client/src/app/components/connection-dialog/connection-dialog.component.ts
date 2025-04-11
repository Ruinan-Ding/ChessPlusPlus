import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebsocketService } from '../../services/websocket.service';
import { Subscription } from 'rxjs';
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
  
  constructor(
    private wsService: WebsocketService,
    private router: Router
  ) {}
  
  ngOnInit(): void {
    this.subscriptions.push(
      this.wsService.reconnecting$.subscribe(reconnecting => {
        this.isReconnecting = reconnecting;
      }),
      
      this.wsService.reconnectAttempts$.subscribe(attempts => {
        this.attemptCount = attempts;
      }),
      
      this.wsService.connectionFailed$.subscribe(failed => {
        this.connectionFailed = failed;
      })
    );
  }
  
  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }
  
  retry(): void {
    // Use the getCurrentRoom method to get the current room name
    const currentRoom = this.wsService.getCurrentRoom();
    this.wsService.connect(currentRoom);
  }
  
  goToLogin(): void {
    this.router.navigate(['/']);
  }
}