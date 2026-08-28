import { Injectable } from '@angular/core';

const VOLUME_KEY = 'cpp.audio.volume';
const MUTED_KEY = 'cpp.audio.muted';
const DEFAULT_VOLUME = 0.5;

/**
 * localStorage *throws* in private browsing and with site data blocked, and
 * these run in field initialisers - unguarded, the root service fails to
 * construct and every component that injects it goes down with it. Sound is
 * optional; the lobby is not.
 */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AudioService {
  volume = this.readVolume();
  muted = this.readMuted();
  private context: AudioContext | null = null;

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    // Sliding to zero is a way of saying "off"; it must not read as unmuted.
    if (this.volume > 0) this.muted = false;
    this.save();
  }

  /** Play the sample that shows how loud the new setting is. */
  previewVolume(): void {
    this.playTone([660, 880, 660], 0.08);
  }

  toggleMute(): void {
    this.muted = !this.muted;
    // Coming back from mute at zero volume would show the speaker on and
    // still play nothing. Unmuting means "I want to hear this".
    if (!this.muted && this.volume <= 0) this.volume = DEFAULT_VOLUME;
    this.save();
  }

  playTone(frequencies: number[], duration: number): void {
    if (this.muted || this.volume <= 0 || typeof AudioContext === 'undefined') return;
    try {
      this.context ??= new AudioContext();
      const context = this.context;
      const play = (): void => {
        const now = context.currentTime;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.3 * this.volume, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration * frequencies.length);
        gain.connect(context.destination);
        frequencies.forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          oscillator.frequency.value = frequency;
          oscillator.type = 'sine';
          oscillator.connect(gain);
          oscillator.start(now + index * duration);
          oscillator.stop(now + (index + 1) * duration);
          // A tone per move, per attack and per timer beep adds up: let the
          // last one take its gain node with it.
          if (index === frequencies.length - 1) {
            oscillator.onended = () => gain.disconnect();
          }
        });
      };
      if (context.state === 'suspended') {
        void context.resume().then(play);
      } else {
        play();
      }
    } catch {
      // Audio is optional and may be unavailable in restricted browsers.
    }
  }

  private readVolume(): number {
    // Number(null) is 0, which passes every guard below - read it as "never
    // set" or a fresh browser starts silent and no sound in the game plays.
    const raw = read(VOLUME_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_VOLUME;
  }

  private readMuted(): boolean {
    return read(MUTED_KEY) === 'true';
  }

  private save(): void {
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
      localStorage.setItem(MUTED_KEY, String(this.muted));
    } catch {
      // Private browsing, or site data blocked. The setting just will not
      // outlive the tab.
    }
  }
}
