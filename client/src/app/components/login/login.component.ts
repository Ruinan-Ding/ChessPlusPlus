import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  username: string = '';

  constructor(private router: Router, private authService: AuthService) {}

  login(): void {
    if (!this.username.trim()) {
      alert('Username cannot be empty.');
      return;
    }

    if (this.username.length > 24) {
      alert('Username cannot exceed 24 characters.');
      return;
    }

    this.authService.setUsername(this.username.trim());

    this.router.navigate(['/lobby']);
  }
}
