import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectionStatusComponent } from './components/connection-status/connection-status.component';
import { CommonModule } from '@angular/common';

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