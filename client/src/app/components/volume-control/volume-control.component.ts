import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AudioService } from '../../services/audio.service';

/**
 * The speaker and its slider, shared by every screen that makes noise.
 *
 * It lived inline in the lobby, which is the one screen that plays almost
 * nothing - the game room has a tone for every move, blow, cast, commit and
 * timer beep and had no way to turn any of it down. Copying the markup across
 * would have left two of them to drift apart, so it moved here instead.
 *
 * Sits beside the `<h1>` on both screens: the same place, and always with room
 * to its right for the slider to open into.
 */
@Component({
  selector: 'app-volume-control',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Focus opens it too, or the slider is mouse-only. -->
    <div class="volume-control"
         (mouseenter)="open = true" (mouseleave)="open = false"
         (focusin)="open = true" (focusout)="open = false">
      <button type="button" class="speaker-button" (click)="audio.toggleMute()"
              [attr.aria-label]="audio.muted ? 'Unmute sounds' : 'Mute sounds'">
        {{ audio.muted ? '🔇' : '🔊' }}
      </button>
      <div class="volume-popover" *ngIf="open">
        <input class="volume-slider" type="range" min="0" max="100"
               [ngModel]="audio.volume * 100"
               (ngModelChange)="audio.setVolume($event / 100)"
               (change)="audio.previewVolume()"
               aria-label="Volume">
        <span class="volume-value">{{ audio.volume * 100 | number:'1.0-0' }}%</span>
      </div>
    </div>
  `,
  styles: [`
    :host { display: inline-flex; }

    .volume-control {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      position: relative;
    }

    /* An invisible bridge to the slider: without it, moving the pointer off
       the speaker closes the thing you were reaching for. */
    .volume-control::after {
      content: '';
      position: absolute;
      left: 100%;
      top: -8px;
      width: 150px;
      height: 36px;
    }

    .speaker-button {
      border: 0;
      background: transparent;
      cursor: pointer;
      font-size: 1.1rem;
      padding: 0 2px;
    }

    /* Out of the flow, so a header that has to stay on one line does not
       reflow every time the pointer passes over the speaker - and on its own
       surface, because it opens over whatever the header was showing there.
       In the game room that is the running score. */
    .volume-popover {
      position: absolute;
      left: calc(100% + 4px);
      top: 50%;
      transform: translateY(-50%);
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
    }

    .volume-slider {
      width: 110px;
      cursor: pointer;
    }

    .volume-value {
      font-size: 0.7rem;
      font-weight: normal;
      color: #2c3e50;
      min-width: 28px;
    }
  `],
})
export class VolumeControlComponent {
  open = false;

  constructor(public audio: AudioService) {}
}
