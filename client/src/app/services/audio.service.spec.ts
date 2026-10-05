import { AudioService } from './audio.service';

/**
 * The tones are synthesised, so what can be checked is what was scheduled:
 * which notes, in which wave, starting when on the audio clock. A stand-in
 * AudioContext records every oscillator's start.
 */
describe('AudioService', () => {
  let started: Array<{ at: number; type: string; frequency: number }>;
  let realContext: any;
  let noise: Array<{ at: number; until: number }>;
  let samples: Float32Array;
  let cutoffs: number[];
  let ramps: number[];

  beforeEach(() => {
    started = [];
    noise = []; cutoffs = []; ramps = [];
    realContext = (window as any).AudioContext;
    class FakeContext {
      currentTime = 10;
      state = 'running';
      sampleRate = 48000;
      destination = {};
      createBuffer(_channels: number, length: number): any {
        samples = new Float32Array(length);
        return { getChannelData: () => samples };
      }
      createBufferSource(): any {
        const item = { at: 0, until: 0 };
        return { connect: () => {}, disconnect: () => {},
          start: (at: number) => { item.at = at; noise.push(item); },
          stop: (until: number) => { item.until = until; },
        };
      }
      createBiquadFilter(): any {
        return { Q: { value: 0 }, connect: () => {}, disconnect: () => {},
          frequency: {
            setValueAtTime: (value: number) => cutoffs.push(value),
            exponentialRampToValueAtTime: (value: number) => cutoffs.push(value),
          },
        };
      }
      createGain(): any {
        return {
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: (value: number) => ramps.push(value) },
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

  it('schedules a brief filtered-noise swoosh at the selected volume', () => {
    const audio = service();
    audio.volume = 0.25;
    audio.playSwoosh();
    expect(noise.length).toBe(1);
    expect(noise[0].at).toBe(10);
    expect(noise[0].until - noise[0].at).toBeGreaterThan(0);
    expect(noise[0].until - noise[0].at).toBeLessThan(0.2);
    expect(samples.some(value => value !== 0)).toBeTrue();
    expect(samples.every(value => value >= -1 && value <= 1)).toBeTrue();
    expect(cutoffs[0]).toBeGreaterThan(cutoffs[1]);
    const peak = Math.max(...ramps);
    audio.volume = 0.5;
    ramps = [];
    audio.playSwoosh();
    expect(Math.max(...ramps)).toBeCloseTo(peak * 2);
    audio.volume = 0;
    audio.playSwoosh();
    expect(noise.length).toBe(2);
  });

  it('plays nothing muted', () => {
    const audio = service();
    audio.muted = true;
    audio.playTone([440], 0.1);
    audio.playSwoosh();
    expect(started).toEqual([]);
    expect(noise).toEqual([]);
  });
});
