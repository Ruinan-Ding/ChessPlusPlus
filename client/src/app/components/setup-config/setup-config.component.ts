import { Component, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ConfigService } from '../../services/config.service';
import { WebsocketService } from '../../services/websocket.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-setup-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './setup-config.component.html',
  styleUrls: ['./setup-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SetupConfigComponent implements OnInit, OnDestroy {
  jsonConfig = '';
  savedConfig = '';
  savedSuccessfully = false;
  username = '';
  private destroy$ = new Subject<void>();
  
  constructor(
    private router: Router,
    private configService: ConfigService,
    private wsService: WebsocketService,
    private navigationState: NavigationStateService
  ) {}
  
  ngOnInit(): void {
    // Get username from localStorage
    this.username = localStorage.getItem('username') || '';
    // Note: The lobby component already sent set_status: configuring before navigating here
    // So we don't need to send it again
    
    // Initialize with default config
    this.jsonConfig = this.configService.getDefaultConfig();
    this.savedConfig = this.jsonConfig;
    
    // Subscribe to config changes (will be used when UI is implemented)
    this.configService.config$.pipe(takeUntil(this.destroy$)).subscribe(config => {
      // Only update if the stringified value is different to avoid cycles
      const newJsonString = JSON.stringify(config, null, 2);
      if (this.jsonConfig !== newJsonString) {
        this.jsonConfig = newJsonString;
      }
    });
  }

  get hasUnsavedChanges(): boolean {
    // Fast path: string equality (avoids JSON parse when unchanged)
    if (this.jsonConfig === this.savedConfig) return false;

    // Hash-based comparison to avoid deep recursion on every check
    const currentHash = this.stableHash(this.jsonConfig);
    const savedHash = this.stableHash(this.savedConfig);
    return currentHash !== savedHash;
  }

  // Lightweight stable hash for JSON strings; falls back to trimmed string on parse errors
  private stableHash(jsonString: string): string {
    try {
      const parsed = JSON.parse(jsonString);
      const normalized = JSON.stringify(parsed, Object.keys(parsed).sort());
      let hash = 0;
      for (let i = 0; i < normalized.length; i++) {
        const chr = normalized.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
      }
      return hash.toString();
    } catch {
      return jsonString.trim();
    }
  }

  onBack(): void {
    // Check if we came from a game room
    const returnToGameRoom = localStorage.getItem('returnToGameRoom');
    const gameRoomToken = localStorage.getItem('gameRoomToken');
    
    // Determine navigation target and state
    let targetRoute: string[];
    let queryParams: { token?: string } = {};
    if (returnToGameRoom) {
      // Returning to game room - set status back to in-game
      this.navigationState.setIntentionalNavigation('game-room');
      targetRoute = ['/game-room', returnToGameRoom];
      if (gameRoomToken) {
        queryParams = { token: gameRoomToken };
      }
      localStorage.removeItem('returnToGameRoom');
      localStorage.removeItem('gameRoomToken');
      
      // Set status back to in-game
      this.wsService.sendMessage({
        type: 'set_status',
        username: this.username,
        status: 'in-game'
      });
    } else {
      // Returning to lobby
      this.navigationState.setIntentionalNavigation('lobby');
      targetRoute = ['/lobby'];
    }
    
    if (this.hasUnsavedChanges) {
      if (confirm('You have unsaved changes. Do you want to save before going back?')) {
        if (this.saveConfig()) {
          this.router.navigate(targetRoute, { queryParams });
        }
      } else {
        this.router.navigate(targetRoute, { queryParams });
      }
    } else {
      this.router.navigate(targetRoute, { queryParams });
    }
  }

  saveConfig(): boolean {
    const result = this.configService.updateConfig(this.jsonConfig);
    
    if (!result.valid) {
      alert(result.errors?.join('\n') || 'Invalid configuration');
      return false;
    }
    
    this.savedConfig = this.jsonConfig;
    this.savedSuccessfully = true;
    // Reset saved message after 2 seconds
    setTimeout(() => {
      this.savedSuccessfully = false;
    }, 2000);
    
    return true;
  }

  onConfigChange(): void {
    // Only update saved state if there are actual changes
    this.savedSuccessfully = false;
  }

  formatJson(): void {
    try {
      const parsed = JSON.parse(this.jsonConfig);
      this.jsonConfig = JSON.stringify(parsed, null, 2);
      this.savedSuccessfully = false;
    } catch (e) {
      const errorMsg = typeof e === 'object' && e !== null && 'message' in e ? (e as Error).message : String(e);
      alert('Invalid JSON: ' + errorMsg);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}