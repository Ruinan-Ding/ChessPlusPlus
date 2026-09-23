import { ComponentFixture, TestBed } from '@angular/core/testing';

import { VolumeControlComponent } from './volume-control.component';
import { AudioService } from '../../services/audio.service';

describe('VolumeControlComponent', () => {
  let fixture: ComponentFixture<VolumeControlComponent>;
  let audio: AudioService;

  const speaker = (): HTMLButtonElement =>
    fixture.nativeElement.querySelector('.speaker-button');
  const slider = (): HTMLInputElement | null =>
    fixture.nativeElement.querySelector('.volume-slider');

  beforeEach(async () => {
    // The service reads its saved setting on construction, so a leftover mute
    // from another spec would decide what this one renders.
    localStorage.removeItem('cpp.audio.volume');
    localStorage.removeItem('cpp.audio.muted');

    await TestBed.configureTestingModule({
      imports: [VolumeControlComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(VolumeControlComponent);
    audio = TestBed.inject(AudioService);
    fixture.detectChanges();
  });

  it('shows the speaker, so every screen that makes noise can be turned down', () => {
    expect(speaker()).toBeTruthy();
    expect(speaker().textContent!.trim()).toBe('🔊');
  });

  it('mutes and unmutes on click, and says which it did', () => {
    speaker().click();
    fixture.detectChanges();

    expect(audio.muted).toBeTrue();
    expect(speaker().textContent!.trim()).toBe('🔇');
    expect(speaker().getAttribute('aria-label')).toBe('Unmute sounds');

    speaker().click();
    fixture.detectChanges();

    expect(audio.muted).toBeFalse();
    expect(speaker().textContent!.trim()).toBe('🔊');
  });

  it('keeps the slider out of the way until it is wanted', () => {
    expect(slider()).toBeNull();

    // Focus, not only hover: the slider is reachable by keyboard.
    fixture.nativeElement.querySelector('.volume-control')
      .dispatchEvent(new Event('focusin', { bubbles: true }));
    fixture.detectChanges();

    expect(slider()).toBeTruthy();
    expect(slider()!.value).toBe(String(audio.volume * 100));
  });
});
