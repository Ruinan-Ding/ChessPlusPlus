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
import { AuthService } from '../../services/auth.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
// Reading storage directly throws in private browsing and with site data
// blocked - and the first two reads below sit in ngOnInit, where that takes
// the whole screen down rather than losing one remembered value.
import { readStore, removeStore } from '../../services/storage';

/** How long a room's server has to answer a save before it is called unsaved. */
export const SAVE_ANSWER_MS = 8000;

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
  /**
   * Sent to the room's server and not yet answered. A networked room's config
   * is the server's, so it is saved when the server says it is - not when it
   * is sent: "Save and go back" left at once, the server's refusal arrived to
   * a screen already gone, and the match started on the old config.
   */
  saving = false;
  username = '';
  /** Game room this config applies to, if opened from an active game room. */
  private gameId: string | null = null;
  /** What was sent, to be the saved config once the server takes it. */
  private sentConfig: string | null = null;
  /** "Save and go back": go once the save is taken. */
  private leaveWhenSaved = false;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private destroy$ = new Subject<void>();

  constructor(
    private router: Router,
    private configService: ConfigService,
    private wsService: WebsocketService,
    private navigationState: NavigationStateService,
    private cdr: ChangeDetectorRef,
    private authService: AuthService,
  ) {}

  /** Where Back goes: the room this was opened from, or the lobby. */
  get backLabel(): string {
    return this.gameId ? 'Back to Room' : 'Back to Lobby';
  }

  ngOnInit(): void {
    // This tab's name, not the one every tab shares - see AuthService.
    this.username = this.authService.getUsername();
    // The lobby already set our status to 'configuring' before navigating here

    // If opened from a game room, remember it so Save can push the config
    // to the server (onBack() still owns clearing this from localStorage).
    this.gameId = readStore('local', 'returnToGameRoom');

    this.jsonConfig = this.configService.getDefaultConfig();

    // The current config emits immediately; it is the editor's saved baseline.
    this.configService.config$.pipe(takeUntil(this.destroy$)).subscribe(config => {
      // Only update if the stringified value is different to avoid cycles
      const newJsonString = JSON.stringify(config, null, 2);
      if (this.jsonConfig !== newJsonString) {
        this.jsonConfig = newJsonString;
        this.cdr.markForCheck();
      }
    });

    this.savedConfig = this.jsonConfig;

    // Listen for the server's response to a saved config (only relevant
    // when this.gameId is set - see saveConfig()). This screen is OnPush, so
    // an answer arriving on the socket has to mark it: it was taken and never
    // drawn - a configuration the server refused looked saved.
    this.wsService.messages$.pipe(takeUntil(this.destroy$)).subscribe(message => {
      if (!message) return;
      if (message.type === 'custom_config_saved') {
        this.taken();
      } else if (message.type === 'error' && (message.code === 'INVALID_CONFIG' || this.saving)) {
        // While a save waits, any refusal is its answer: not the host, not in
        // the room, the server's own failure - each leaves it unsaved.
        this.refused(message.message || 'The server rejected this configuration.');
      }
    });
  }

  /** The server took what was sent: saved, and gone if that was the choice. */
  private taken(): void {
    clearTimeout(this.answerTimer);
    this.saving = false;
    if (this.sentConfig !== null) this.savedConfig = this.sentConfig;
    this.sentConfig = null;
    this.errors = [];
    this.showSaved();
    if (this.leaveWhenSaved) {
      this.leaveWhenSaved = false;
      this.leave();
    }
  }

  /** Not saved: the editor stays, and says why. */
  private refused(reason: string): void {
    clearTimeout(this.answerTimer);
    this.saving = false;
    this.leaveWhenSaved = false;
    this.errors = [reason];
    this.cdr.markForCheck();
  }

  get hasUnsavedChanges(): boolean {
    // Fast path: string equality (avoids JSON parse when unchanged)
    if (this.jsonConfig === this.savedConfig) return false;

    return this.canonicalJson(this.jsonConfig) !== this.canonicalJson(this.savedConfig);
  }

  /** Compare JSON exactly, ignoring whitespace and object-key order. */
  private canonicalJson(jsonString: string): string {
    try {
      return JSON.stringify(this.canonicalize(JSON.parse(jsonString)));
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
      return Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, this.canonicalize(value[key])]));
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
    if (choice === 'save') {
      if (!this.saveConfig()) return;
      // Sent to a room's server: go when it is taken (taken()), or stay with
      // its reason if it is not (refused()).
      if (this.saving) {
        this.leaveWhenSaved = true;
        return;
      }
    }
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

    this.errors = [];

    // A solo room ('local', a literal) has no server to push to: the browser
    // engine reads this config, and nothing answers a set_custom_config -
    // so "Saved!" never showed there, and it went to the server in the lobby.
    if (this.gameId && this.gameId !== 'local') {
      // Not with the server away: the socket queues what it cannot send and
      // sends it when it is back - after this screen had said "not saved",
      // and after a player told so had chosen Discard. Refused here instead,
      // where nothing is waiting to go.
      if (!this.wsService.isConnected()) {
        this.refused('Not connected to the server, so this was not saved. Try again once it is back.');
        return false;
      }
      // Push to the server so it actually takes effect at game start. Saved
      // when it answers (custom_config_saved / error, in ngOnInit()), or
      // called unsaved if it never does.
      this.saving = true;
      this.sentConfig = this.jsonConfig;
      this.wsService.sendMessage({
        type: 'set_custom_config',
        config: JSON.parse(this.jsonConfig),
      });
      clearTimeout(this.answerTimer);
      this.answerTimer = setTimeout(
        // It went: the server has it, and may yet take it - a late
        // custom_config_saved still marks it saved (taken()).
        () => this.refused('The server did not answer, so this may not have been saved. Try again.'),
        SAVE_ANSWER_MS);
      this.cdr.markForCheck();
    } else {
      // No room's server to attach this config to - the lobby, or a solo room.
      this.savedConfig = this.jsonConfig;
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
    clearTimeout(this.answerTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }
}