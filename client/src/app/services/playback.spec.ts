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

  it('plays a cast on the hex it landed on, not on the caster', () => {
    // The spend records where it landed. Read back off the action's own
    // from/to it gave the caster's hex, so a debuff replayed as a swell on
    // the wrong unit - the one that cast it.
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('', '', null, { spend: { index: 3, hex: '2,0' } }),
    ])).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'ability', from: '2,0', to: '2,0', index: 3, brief: false },
    ]);
  });

  it('still gives a universal ability its beat, naming no hex', () => {
    // It shines in the panel alone. Requiring a hex dropped the beat entirely,
    // so the button never popped in the recap.
    expect(buildPlayback([step('', '', null, { spend: { index: 7 } })])).toEqual([
      { kind: 'ability', from: '', to: '', index: 7, brief: false },
    ]);
  });

  it('names whose panel the slot is in, so one cast lights one list', () => {
    // Both sides draw the same indices, so a beat that named only the index
    // popped the matching button on the opponent's list at the same time.
    expect(buildPlayback([
      step('', '', null, { spend: { index: 3, hex: '2,0', side: 'mine' } }),
    ])).toEqual([
      { kind: 'ability', from: '2,0', to: '2,0', index: 3, side: 'mine', brief: false },
    ]);
  });

  it('gives a unit its own ability and no slot to light with it', () => {
    // A unit's ability shows on the unit alone - the panel button it came
    // from does not pop with it, so the beat names no slot.
    expect(buildPlayback([
      step('0,0', '0,0', null, { spend: { index: 0, row: 'unit', hex: '0,0' } }),
    ])).toEqual([
      { kind: 'ability', from: '0,0', to: '0,0', brief: false },
    ]);
  });

  it('runs the recap casts short, one beat each', () => {
    const cast = (index: number, hex: string): PlayableAction =>
      step('0,0', '0,0', null, { spend: { index, hex } });
    expect(buildPlayback([cast(1, '2,0'), cast(6, '3,0')], true)).toEqual([
      { kind: 'ability', from: '2,0', to: '2,0', index: 1, brief: true },
      { kind: 'ability', from: '3,0', to: '3,0', index: 6, brief: true },
    ]);
  });

  it('walks first, and lands a cast on the acting unit where it ended up', () => {
    // The board already shows the finished position when the recap runs, so a
    // cast played on a hex the unit has left pops an empty hex - and the walk
    // after it reads as the unit teleporting back to start again.
    expect(buildPlayback([
      step('0,0', '0,0', null, { spend: { index: 3, hex: '0,0', side: 'mine' } }),
      step('0,0', '1,0'),
      step('0,0', '2,0'),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '2,0' },
      { kind: 'ability', from: '2,0', to: '2,0', index: 3, side: 'mine', brief: true },
    ]);
  });

  it('leaves a cast on somebody else where it landed', () => {
    // Only the unit that walked follows the walk; an enemy stays put.
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('', '', null, { spend: { index: 5, hex: '4,0', side: 'mine' } }),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'ability', from: '4,0', to: '4,0', index: 5, side: 'mine', brief: true },
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
