import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectionStatusComponent } from './components/connection-status/connection-status.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ConnectionStatusComponent],
  template: `
    <div class="app-container">
      <header>
        <h1>ChessPlusPlus Game</h1>
        <app-connection-status></app-connection-status>
      </header>
      
      <main>
        <div class="game-content">
          <p>Game board will be implemented here</p>
        </div>
      </main>
      
      <footer>
        <p>© 2025 - Real-Time Strategy Game</p>
      </footer>
    </div>
  `,
  styles: [`
    .app-container {
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
      font-family: Arial, sans-serif;
    }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid #ddd;
    }
    
    h1 {
      color: #2c3e50;
      margin: 0;
    }
    
    .game-content {
      min-height: 400px;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 20px;
      display: flex;
      justify-content: center;
      align-items: center;
      background-color: #f5f5f5;
    }
    
    footer {
      margin-top: 30px;
      padding-top: 10px;
      border-top: 1px solid #ddd;
      text-align: center;
      color: #7f8c8d;
    }
  `]
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
    
    .login-form {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    
    .form-group {
      display: flex;
      flex-direction: column;
      text-align: left;
      gap: 8px;
    }
    
    label {
      font-weight: 500;
      color: #34495e;
    }
    
    .form-control {
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 16px;
    }
    
    .login-button {
      padding: 12px;
      background-color: #3498db;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 16px;
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