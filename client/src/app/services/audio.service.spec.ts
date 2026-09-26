import { AudioService } from './audio.service';

/**
 * The tones are synthesised, so what can be checked is what was scheduled:
 * which notes, in which wave, starting when on the audio clock. A stand-in
 * AudioContext records every oscillator's start.
 */
describe('AudioService', () => {
  let started: Array<{ at: number; type: string; frequency: number }>;
  let realContext: any;

  beforeEach(() => {
    started = [];
    realContext = (window as any).AudioContext;
    class FakeContext {
      currentTime = 10;
      state = 'running';
      destination = {};
      createGain(): any {
        return {
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: () => {}, disconnect: () => {},
        };
      }
      createOscillator(): any {
        const oscillator: any = {
          frequency: { value: 0 }, type: 'sine', connect: () => {}, stop: () => {},
          start: (at: number) => started.push({ at, type: oscillator.type, frequency: oscillator.frequency.value }),
        };
        return oscillator;
      }
    }
    (window as any).AudioContext = FakeContext;
  });

  afterEach(() => { (window as any).AudioContext = realContext; });

  const service = (): AudioService => {
    const audio = new AudioService();
    audio.muted = false;
    audio.volume = 0.5;
    return audio;
  };

  it('plays a run of sine notes straight away by default', () => {
    service().playTone([440, 550], 0.1);
    expect(started.map(s => s.type)).toEqual(['sine', 'sine']);
    expect(started.map(s => s.frequency)).toEqual([440, 550]);
    expect(started[0].at).toBeCloseTo(10, 6);
    expect(started[1].at).toBeCloseTo(10.1, 6);
  });

  it('starts a delayed run later on the audio clock, in the wave it asks for', () => {
    // What keeps two sounds for one moment from playing over each other:
    // the toll's knell, then the mend's chime once it has finished.
    service().playTone([440, 550], 0.1, { type: 'triangle', delay: 0.5 });
    expect(started.map(s => s.type)).toEqual(['triangle', 'triangle']);
    expect(started[0].at).toBeCloseTo(10.5, 6);
    expect(started[1].at).toBeCloseTo(10.6, 6);
  });

  it('plays nothing muted', () => {
    const audio = service();
    audio.muted = true;
    audio.playTone([440], 0.1);
    expect(started).toEqual([]);
  });
});
