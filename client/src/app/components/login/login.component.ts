import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  username: string = '';

  constructor(private router: Router) {}

  login(): void {
    if (!this.username.trim()) {
      alert('Username cannot be empty.');
      return;
    }

    if (this.username.length > 24) {
      alert('Username cannot exceed 24 characters.');
      return;
    }

    // Store username in localStorage
    localStorage.setItem('username', this.username.trim());

    // Navigate to the lobby
    this.router.navigate(['/lobby']);
  }
}
