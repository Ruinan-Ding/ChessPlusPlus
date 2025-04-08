import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <router-outlet></router-outlet>
  `,
  styles: []
})
export class AppComponent {
  title = 'ChessPlusPlus';
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="login-container">
      <h2>Welcome to ChessPlusPlus</h2>
      <div class="login-form">
        <div class="form-group">
          <label for="username">Enter your username:</label>
          <input 
            type="text" 
            id="username" 
            [(ngModel)]="username" 
            placeholder="Username" 
            class="form-control"
            (keyup.enter)="login()"
          >
        </div>
        <button (click)="login()" [disabled]="!username.trim()" class="login-button">
          Enter Lobby
        </button>
      </div>
    </div>
  `,
  styles: [`
    .login-container {
      max-width: 400px;
      margin: 100px auto;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      background-color: white;
      text-align: center;
    }
    
    h2 {
      margin-bottom: 30px;
      color: #2c3e50;
    }
    
    .form-group {
      margin-bottom: 20px;
      text-align: left;
    }
    
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
      color: #34495e;
    }
    
    .form-control {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 1rem;
    }
    
    .login-button {
      width: 100%;
      padding: 12px;
      background-color: #3498db;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
      transition: background-color 0.3s;
    }
    
    .login-button:hover {
      background-color: #2980b9;
    }
    
    .login-button:disabled {
      background-color: #95a5a6;
      cursor: not-allowed;
    }
  `]
})
export class LoginComponent {
  username: string = '';
  
  constructor(private router: Router) {}
  
  login(): void {
    if (this.username.trim()) {
      // Store username in localStorage
      localStorage.setItem('username', this.username.trim());
      
      // Navigate to lobby
      this.router.navigate(['/lobby']);
    }
  }
}