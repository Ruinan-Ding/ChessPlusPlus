import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { WebsocketService } from '../../services/websocket.service';
import { ConnectionDialogComponent } from '../connection-dialog/connection-dialog.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectionDialogComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent implements OnInit {
  username: string = '';

  constructor(
    private router: Router,
    private authService: AuthService,
    private wsService: WebsocketService,
  ) {}

  /**
   * Reach for the server here rather than one screen later, so someone with
   * no server behind them is offered offline play before they have typed
   * anything - the connection dialog handles Retry / Play Offline.
   */
  ngOnInit(): void {
    if (!this.wsService.isOffline()) this.wsService.connect('lobby');
  }

  /** The name's length as the server counts it - see login(). */
  get usernameLength(): number {
    return [...this.username.trim()].length;
  }

  login(): void {
    // Counted as the server counts it: trimmed, in characters - `length` is
    // UTF-16 units, so an emoji counted twice and padding counted at all.
    const typed = this.username.trim();
    if (this.usernameLength > 24) {
      alert('Username cannot exceed 24 characters.');
      return;
    }

    // No name given is not an error - take a random one, same as the lobby
    // does for anyone arriving without one. Anything else the server cannot
    // hold comes back as a guest name, with the lobby saying why.
    const name = typed || `Player${Math.floor(Math.random() * 10000)}`;
    this.authService.setUsername(name);

    this.router.navigate(['/lobby']);
  }
}
