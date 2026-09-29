import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ConfigService } from '../../services/config.service';
import { WebsocketService } from '../../services/websocket.service';
import { NavigationStateService } from '../../services/navigation-state.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
// Reading storage directly throws in private browsing and with site data
// blocked - and the first two reads below sit in ngOnInit, where that takes
// the whole screen down rather than losing one remembered value.
import { readStore, removeStore } from '../../services/storage';

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
  /**
   * What is wrong with the configuration, over the editor where it is being
   * fixed: the validator's list when a save is refused, the server's word when
   * it refuses one sent from a game room, and a Format of JSON that does not
   * parse. The first and last were an alert - the list gone the moment it was
   * dismissed, while the fixing had only begun.
   */
  errors: string[] = [];
  /** Back pressed with changes unsaved: the choice is up (leaveChoice). */
  leaving = false;
  username = '';
  /** Game room this config applies to, if opened from an active game room. */
  private gameId: string | null = null;
  private destroy$ = new Subject<void>();

  constructor(
    private router: Router,
    private configService: ConfigService,
    private wsService: WebsocketService,
    private navigationState: NavigationStateService,
    private cdr: ChangeDetectorRef,
  ) {}

  /** Where Back goes: the room this was opened from, or the lobby. */
  get backLabel(): string {
    return this.gameId ? 'Back to Room' : 'Back to Lobby';
  }

  ngOnInit(): void {
    this.username = readStore('local', 'username') || '';
    // The lobby already set our status to 'configuring' before navigating here

    // If opened from a game room, remember it so Save can push the config
    // to the server (onBack() still owns clearing this from localStorage).
    this.gameId = readStore('local', 'returnToGameRoom');

    this.jsonConfig = this.configService.getDefaultConfig();
    this.savedConfig = this.jsonConfig;

    // Subscribe to config changes (will be used when UI is implemented)
    this.configService.config$.pipe(takeUntil(this.destroy$)).subscribe(config => {
      // Only update if the stringified value is different to avoid cycles
      const newJsonString = JSON.stringify(config, null, 2);
      if (this.jsonConfig !== newJsonString) {
        this.jsonConfig = newJsonString;
        this.cdr.markForCheck();
      }
    });

    // Listen for the server's response to a saved config (only relevant
    // when this.gameId is set - see saveConfig()). This screen is OnPush, so
    // an answer arriving on the socket has to mark it: it was taken and never
    // drawn - a configuration the server refused looked saved.
    this.wsService.messages$.pipe(takeUntil(this.destroy$)).subscribe(message => {
      if (!message) return;
      if (message.type === 'custom_config_saved') {
        this.errors = [];
        this.showSaved();
      } else if (message.type === 'error' && message.code === 'INVALID_CONFIG') {
        this.errors = [message.message || 'The server rejected this configuration.'];
        this.cdr.markForCheck();
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

  // Stable hash for JSON strings: recursively sorts object keys so two
  // configs that differ only in key order compare equal, then hashes the
  // canonical form. Falls back to trimmed string on parse errors.
  private stableHash(jsonString: string): string {
    try {
      const parsed = JSON.parse(jsonString);
      const normalized = JSON.stringify(this.canonicalize(parsed));
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

  /** Recursively sort object keys so serialization is independent of key order. */
  private canonicalize(value: any): any {
    if (Array.isArray(value)) {
      return value.map(v => this.canonicalize(v));
    }
    if (value && typeof value === 'object') {
      const sorted: Record<string, any> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = this.canonicalize(value[key]);
      }
      return sorted;
    }
    return value;
  }

  /**
   * Back. With changes unsaved it asks first - save and go, discard and go,
   * or stay (leaveChoice). It was the browser's confirm(): "save before going
   * back?", where Cancel - the button anyone wanting to stay would press -
   * went back without saving.
   */
  onBack(): void {
    if (this.hasUnsavedChanges) {
      this.leaving = true;
      return;
    }
    this.leave();
  }

  /**
   * The choice Back put up. A save the validator refuses keeps the editor
   * open, its errors over it - and the room it was opened from with it: this
   * used to clear the way back before asking, so fixing the JSON and pressing
   * Back again landed in the lobby, the room lost.
   */
  leaveChoice(choice: 'save' | 'discard' | 'stay'): void {
    this.leaving = false;
    if (choice === 'stay') return;
    if (choice === 'save' && !this.saveConfig()) return;
    this.leave();
  }

  // Escape is Stay, as it is wherever a dialog is up.
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.leaving) this.leaveChoice('stay');
  }

  // Stay has the focus as the choice goes up: the one that loses nothing.
  @ViewChild('stayButton') set stayButton(button: ElementRef<HTMLButtonElement> | undefined) {
    button?.nativeElement.focus();
  }

  private leave(): void {
    const returnToGameRoom = readStore('local', 'returnToGameRoom');
    const gameRoomToken = readStore('local', 'gameRoomToken');
    
    let targetRoute: string[];
    let queryParams: { token?: string } = {};
    if (returnToGameRoom) {
      // Returning to game room - set status back to in-game
      this.navigationState.setIntentionalNavigation('game-room');
      targetRoute = ['/game-room', returnToGameRoom];
      if (gameRoomToken) {
        queryParams = { token: gameRoomToken };
      }
      // Cleared now that we are certainly going: the navigation below is
      // what uses them.
      removeStore('local', 'returnToGameRoom');
      removeStore('local', 'gameRoomToken');
      
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
    
    this.router.navigate(targetRoute, { queryParams });
  }

  saveConfig(): boolean {
    const result = this.configService.updateConfig(this.jsonConfig);

    if (!result.valid) {
      this.errors = result.errors?.length ? result.errors : ['Invalid configuration'];
      this.cdr.markForCheck();
      return false;
    }

    this.savedConfig = this.jsonConfig;
    this.errors = [];

    if (this.gameId) {
      // Push to the server so it actually takes effect at game start.
      // Success/failure is reported via the custom_config_saved / error
      // messages handled in ngOnInit().
      this.wsService.sendMessage({
        type: 'set_custom_config',
        config: JSON.parse(this.jsonConfig),
      });
    } else {
      // No active game room to attach this config to (opened straight from
      // the lobby) - just confirm the local save.
      this.showSaved();
    }

    return true;
  }

  /** "Saved!" for two seconds - marked each way, the screen being OnPush. */
  private showSaved(): void {
    this.savedSuccessfully = true;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.savedSuccessfully = false;
      this.cdr.markForCheck();
    }, 2000);
  }

  onConfigChange(): void {
    this.savedSuccessfully = false;
  }

  formatJson(): void {
    try {
      const parsed = JSON.parse(this.jsonConfig);
      this.jsonConfig = JSON.stringify(parsed, null, 2);
      this.savedSuccessfully = false;
      // It parses: whatever said it did not is out of date. What the
      // validator said about its rules stands until the next save.
      this.errors = this.errors.filter(error => !/^Invalid JSON/.test(error));
    } catch (e) {
      const errorMsg = typeof e === 'object' && e !== null && 'message' in e ? (e as Error).message : String(e);
      this.errors = ['Invalid JSON: ' + errorMsg];
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}