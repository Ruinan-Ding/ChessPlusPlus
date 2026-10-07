import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { parseUsernameInput, randomUsername, USERNAME_INPUT_ERROR } from '../../services/username';
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
  loginError = '';

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

  /** The base name's length, excluding its optional key. */
  get usernameLength(): number {
    return this.username.trim().split('#', 1)[0].length;
  }

  login(): void {
    const automatic = !this.username.trim();
    const parsed = automatic ? { username: randomUsername(), tripcodeKey: '' } : parseUsernameInput(this.username);
    if (!parsed) {
      this.loginError = USERNAME_INPUT_ERROR;
      return;
    }
    if (parsed.tripcodeKey && this.wsService.isOffline()) {
      this.loginError = 'Tripcodes need a server connection.';
      return;
    }
    this.authService.setUsername(parsed.username, !automatic, '');
    this.authService.setTripcodeKey(parsed.tripcodeKey);
    this.username = parsed.username;
    this.loginError = '';
    this.router.navigate(['/lobby']);
  }
}
