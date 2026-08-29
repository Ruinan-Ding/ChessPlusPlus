import { buildPlayback, PlayableAction } from './playback';

/**
 * The replay is what the player sees of a turn they already committed, so it
 * has to describe what actually happened: the walk in order, the blow before
 * the answer, and no answer from a unit that died to it.
 */
describe('buildPlayback', () => {
  const step = (from: string, to: string, attack: string | null = null, rest: Partial<PlayableAction> = {})
    : PlayableAction => ({ from, to, attack, ...rest });

  it('follows a walk hop by hop, from where the last hop ended', () => {
    expect(buildPlayback([step('0,0', '1,0'), step('0,0', '2,0')])).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'move', from: '1,0', to: '2,0' },
    ]);
  });

  it('strikes, then takes the answer', () => {
    expect(buildPlayback([step('0,0', '0,0', '1,0')])).toEqual([
      { kind: 'attack', from: '0,0', to: '1,0' },
      { kind: 'counter', from: '1,0', to: '0,0' },
    ]);
  });

  it('gives no answer to a defender that died', () => {
    expect(buildPlayback([step('0,0', '0,0', '1,0', { killed: '1,0' })])).toEqual([
      { kind: 'attack', from: '0,0', to: '1,0' },
    ]);
  });

  it('lights the hex a cast landed on, and walks on from where it stood', () => {
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('', '', null, { spend: { index: 3 }, killed: '2,0' }),
    ])).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'ability', from: '1,0', to: '2,0', index: 3, brief: false },
    ]);
  });

  it('runs the recap casts short, one beat each', () => {
    const cast = (index: number, killed: string): PlayableAction =>
      step('0,0', '0,0', null, { spend: { index }, killed });
    expect(buildPlayback([cast(1, '2,0'), cast(6, '3,0')], true)).toEqual([
      { kind: 'ability', from: '0,0', to: '2,0', index: 1, brief: true },
      { kind: 'ability', from: '0,0', to: '3,0', index: 6, brief: true },
    ]);
  });

  it('collapses a committed walk into the line it amounted to', () => {
    const walk = [step('0,0', '1,0'), step('0,0', '2,0'), step('0,0', '2,-1')];
    expect(buildPlayback(walk, true)).toEqual([
      { kind: 'move', from: '0,0', to: '2,-1' },
    ]);
    // Uncollapsed it is still hop by hop - that is what staging plays.
    expect(buildPlayback(walk).length).toBe(3);
  });

  it('keeps a strike out of the collapsed walk', () => {
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('0,0', '1,0', '2,0', { killed: '2,0' }),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'attack', from: '1,0', to: '2,0' },
    ]);
  });

  it('has nothing to play for a turn that staged nothing', () => {
    expect(buildPlayback([])).toEqual([]);
  });
});
