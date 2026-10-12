import { buildPlayback, historyPlayback, PlayableAction } from './playback';
import replayCases from '../../../../shared/replay-parity.json';
import timings from '../../../../shared/playback-timings.json';

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

  it('replays a veteran attack before its remaining walk without repeating the attack', () => {
    expect(buildPlayback([
      step('0,0', '1,0'), step('0,0', '1,0', '2,0', { countered: true }),
      step('0,0', '-1,0', '2,0', { afterAttackWalk: true, countered: true }),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'attack', from: '1,0', to: '2,0' },
      { kind: 'counter', from: '2,0', to: '1,0' },
      { kind: 'move', from: '1,0', to: '-1,0' },
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

  it('keeps two units’ moves two moves', () => {
    // The review's case: one "where the unit stands" for the whole turn folded
    // these into a single walk from 0,0 to 6,0 - a move nobody made.
    const turn = [step('0,0', '1,0'), step('5,0', '6,0')];
    expect(buildPlayback(turn, true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'move', from: '5,0', to: '6,0' },
    ]);
    // And staged, each hop starts where its own unit stood.
    expect(buildPlayback(turn)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'move', from: '5,0', to: '6,0' },
    ]);
  });

  it('collapses each unit’s own walk, and keeps the order they acted in', () => {
    expect(buildPlayback([
      step('0,0', '1,0'), step('0,0', '2,0'),
      step('0,0', '2,0', '3,0'),
      step('5,0', '5,1'), step('5,0', '5,2'),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '2,0' },
      { kind: 'attack', from: '2,0', to: '3,0' },
      { kind: 'counter', from: '3,0', to: '2,0' },
      { kind: 'move', from: '5,0', to: '5,2' },
    ]);
  });

  it('plays three walks home as three walks', () => {
    // A setup turn sends up to three units home; each is its own line.
    expect(buildPlayback([
      step('-11,11', '-12,11'), step('-11,10', '-12,10'), step('-10,11', '-13,12'),
    ], true)).toEqual([
      { kind: 'move', from: '-11,11', to: '-12,11' },
      { kind: 'move', from: '-11,10', to: '-12,10' },
      { kind: 'move', from: '-10,11', to: '-13,12' },
    ]);
  });

  it('replays healing as an HP pulse with no attack or counter, following a target that later moves', () => {
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('0,0', '1,0', null, { heal: '3,0', mark: '+13' }),
      step('3,0', '4,0'),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'move', from: '3,0', to: '4,0' },
      { kind: 'heal', from: '4,0', to: '4,0', mark: '+13', brief: true },
    ]);
  });

  it('lands a cast on one unit where that unit ended, not where another did', () => {
    // A mend on A, then B walks. The cast followed "the" acting unit, which
    // after B's walk was B - so A's mend popped over B.
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('0,0', '1,0', null, { spend: { index: 6, hex: '1,0', side: 'mine' } }),
      step('5,0', '6,0'),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'ability', from: '1,0', to: '1,0', index: 6, side: 'mine', brief: true },
      { kind: 'move', from: '5,0', to: '6,0' },
    ]);
    // Cast on B before B moves: B's walk goes first, then the cast where B is.
    expect(buildPlayback([
      step('0,0', '1,0'),
      step('0,0', '1,0', null, { spend: { index: 6, hex: '5,0', side: 'mine' } }),
      step('5,0', '6,0'),
    ], true)).toEqual([
      { kind: 'move', from: '0,0', to: '1,0' },
      { kind: 'move', from: '5,0', to: '6,0' },
      { kind: 'ability', from: '6,0', to: '6,0', index: 6, side: 'mine', brief: true },
    ]);
  });

  it('keeps a multi-recipient cast in one beat and follows each recipient through collapsed moves', () => {
    const visuals = [
      { kind: 'ability' as const, from: '0,0', to: '0,0', uid: 'one', mark: '+4' },
      { kind: 'ability' as const, from: '2,0', to: '2,0', uid: 'two', mark: '-3', hostile: true },
    ];
    const actions = [step('', '', null, { spend: { index: 5, side: 'mine', visuals } }),
      step('0,0', '1,0'), step('2,0', '3,0')];
    const staged = buildPlayback(actions);
    expect(staged[0].targets).toEqual(visuals);
    const recap = buildPlayback(actions, true);
    expect(recap.map(beat => beat.kind)).toEqual(['move', 'move', 'ability']);
    expect(recap[2]).toEqual(jasmine.objectContaining({ index: 5, side: 'mine', brief: true }));
    expect(recap[2].targets).toEqual([
      { ...visuals[0], from: '1,0', to: '1,0' }, { ...visuals[1], from: '3,0', to: '3,0' },
    ]);
    expect(visuals[0].to).toBe('0,0');
    expect(visuals[1].to).toBe('2,0');
    expect(buildPlayback([actions[0], actions[0]], true).length).toBe(2);
  });

  it('retains both combat actors across Rapid Movement and folded walks', () => {
    const actor = { unit_id: 'pawn', color: 'white' as const, uid: 'actor' };
    const counterActor = { unit_id: 'rook', color: 'black' as const, uid: 'defender' };
    const actions = [step('0,0', '1,0', null, { actor }),
      step('0,0', '1,0', '2,0', { actor, counterActor, countered: true, secondStrike: true }),
      step('0,0', '1,1', '2,0', { actor, afterAttackWalk: true })];
    const rapid = buildPlayback(actions, true);
    expect(rapid.map(beat => beat.kind)).toEqual(['move', 'attack', 'counter', 'attack', 'move']);
    expect(rapid.map(beat => beat.actor)).toEqual([actor, actor, counterActor, actor, actor]);
    const folded = buildPlayback([step('0,0', '1,0', null, { actor }),
      step('0,0', '2,0', null, { actor })], true);
    expect(folded).toEqual([{ kind: 'move', from: '0,0', to: '2,0', actor }]);
  });

  it('has nothing to play for a turn that staged nothing', () => {
    expect(buildPlayback([])).toEqual([]);
  });
});


describe('historyPlayback', () => {
  it('collapses a received walk into its complete path, including interleaved panel movers', () => {
    expect(historyPlayback([
      { uid: 'a', unit_id: 'pawn', from: '0,0', to: '1,0', moved: true },
      { unit: { uid: 'b' }, unit_id: 'pawn', panelMove: true, from: '4,10', to: '5,10', moved: true },
      { uid: 'a', unit_id: 'pawn', from: '1,0', to: '2,0', moved: true },
      { unit: { uid: 'b' }, unit_id: 'pawn', entered: true, from: '5,10', to: '4,9', moved: true },
    ], () => 0, 'opponent')).toEqual([
      { kind: 'move', from: '0,0', to: '2,0' }, { kind: 'move', from: '4,10', to: '4,9' },
    ]);
  });
  it('uses the initiating unit UID when a panel blow also carries its victim', () => {
    const beats = historyPlayback([
      { unit_id: 'pawn', uid: 'attacker', from: '0,0', to: '1,0', moved: true },
      { unit_id: 'pawn', uid: 'attacker', unit: { uid: 'victim' }, panelAttack: true,
        from: '1,0', to: '2,0', moved: true, attacked: true, attackedHex: '3,0', countered: false },
      { unit_id: 'pawn', uid: 'attacker', from: '2,0', to: '2,1', moved: true },
    ], () => 0, 'opponent');
    expect(beats).toEqual([
      { kind: 'move', from: '0,0', to: '2,0' }, { kind: 'attack', from: '2,0', to: '3,0' },
      { kind: 'move', from: '2,0', to: '2,1' },
    ]);
  });
  it('retains intervening casts while folding the same unit’s consecutive walk', () => {
    const steps = historyPlayback([
      { unit_id: 'pawn', from: '0,0', to: '1,0', moved: true },
      { abilityCast: { id: 'warcry', targets: [{ at: '1,0', uid: 'a' }] } },
      { unit_id: 'pawn', from: '1,0', to: '2,0', moved: true },
    ], () => 0, 'mine');
    expect(steps.map(step => step.kind)).toEqual(['move', 'ability']);
    expect(steps[0]).toEqual({ kind: 'move', from: '0,0', to: '2,0' });
    expect(steps[1].targets?.[0].uid).toBe('a');
  });

  it('keeps movement, attacks, actual counters and Charge in the received order', () => {
    expect(historyPlayback([{ unit_id: 'knight', from: '0,0', to: '1,0', moved: true,
      attacked: true, attackedHex: '2,0', countered: true, secondStrike: true }], () => 0, 'opponent')).toEqual([
        { kind: 'move', from: '0,0', to: '1,0' }, { kind: 'attack', from: '1,0', to: '2,0' },
        { kind: 'counter', from: '2,0', to: '1,0' }, { kind: 'attack', from: '1,0', to: '2,0' },
      ]);
  });
  it('reconstructs killed actors with their actual colour and distinct panel identities', () => {
    const actor = { unit_id: 'knight', color: 'white' as const, uid: 'attacker' };
    const counterActor = { unit_id: 'pawn', color: 'black' as const, uid: 'victim' };
    for (const panel of [false, true]) {
      const record = { ...actor, from: '0,0', to: '1,0', moved: true, attacked: true,
        attackedHex: '2,0', countered: true, secondStrike: true, defender_eliminated: true,
        ...(panel ? { panelAttack: true, unit: { ...counterActor, hp: 5, max_hp: 14 } } : { counterActor }) };
      const beats = historyPlayback([record], () => 0, 'opponent');
      expect(beats.map(beat => beat.actor)).withContext(String(panel)).toEqual([actor, actor, counterActor, actor]);
      expect(beats[2].actor).not.toBe(counterActor);
      if (!panel) {
        const legacy = { ...record, counterActor: undefined, captured: 'pawn' };
        expect(historyPlayback([legacy], () => 0, 'opponent')[2].actor)
          .toEqual({ unit_id: 'pawn', color: 'black', uid: undefined });
      }
    }
  });

  it('reconstructs both walks around combat in a combined solo Rapid Movement record', () => {
    const actor = { unit_id: 'pawn', color: 'white' as const, uid: 'actor' };
    const counterActor = { unit_id: 'pawn', color: 'black' as const, uid: 'target' };
    for (const start of ['0,0', '1,0']) {
      const beats = historyPlayback([{ ...actor, from: start, attackFrom: '1,0', to: '1,1',
        moved: true, attacked: true, attackedHex: '2,0', countered: true, counterActor }], () => 0, 'mine');
      expect(beats).toEqual([
        ...(start === '0,0' ? [{ kind: 'move' as const, from: start, to: '1,0', actor }] : []),
        { kind: 'attack', from: '1,0', to: '2,0', actor },
        { kind: 'counter', from: '2,0', to: '1,0', actor: counterActor },
        { kind: 'move', from: '1,0', to: '1,1', actor },
      ]);
    }
  });

  it('replays a real counter even when protection reduced its damage to zero', () => {
    expect(historyPlayback([{ unit_id: 'knight', from: '0,0', to: '0,0', attacked: true,
      attackedHex: '1,0', countered: true, counter_damage: 0, secondStrike: true }], () => 0, 'opponent')
      .map(step => step.kind)).toEqual(['attack', 'counter', 'attack']);
    expect(historyPlayback([{ unit_id: 'knight', from: '0,0', to: '0,0', attacked: true,
      attackedHex: '1,0', countered: false, counter_damage: 0 }], () => 0, 'opponent')
      .map(step => step.kind)).toEqual(['attack']);
  });
  it('plays all recipients of one ability simultaneously and ignores non-action bookkeeping', () => {
    const steps = historyPlayback([{ unitCast: { id: 'king-call' } },
      { abilityCast: { id: 'king-call', targets: [{ at: '0,0', uid: 'a', color: 'white', delta: 2 },
        { at: '1,0', uid: 'b', color: 'black', delta: -1, hostile: true }] } },
      { panelEffect: true, unit_id: 'pawn', from: '0,0', to: '0,0' }], () => 4, 'mine');
    expect(steps.length).toBe(1); expect(steps[0].targets?.map(target => target.mark)).toEqual(['+2', '-1']);
  });
});

describe('server replay clock parity', () => {
  it('uses the same collapsed beats and durations as the server allowance', () => {
    const beat = (name: keyof Omit<typeof timings, 'speed'>) => Math.round(timings[name] / timings.speed);
    for (const test of replayCases) {
      const steps = historyPlayback(test.records, () => -1, 'opponent');
      expect(steps.map(step => String(step.kind))).withContext(test.name).toEqual(test.kinds);
      const durations = steps.map(step => step.kind === 'pick' ? beat('pick')
        : step.kind === 'move' ? beat('move')
        : step.kind === 'ability' || step.kind === 'heal' ? beat('glowBrief')
        : 2 * beat('strike') + beat('hit'));
      const actual = durations.length ? durations.reduce((sum, ms) => sum + ms + beat('gap'), 0)
        : beat('commit') + beat('gap');
      expect(actual).withContext(test.name).toBe(test.milliseconds);
      for (const step of steps.filter(step => step.kind === 'ability' || step.kind === 'heal')) {
        expect(step.brief).withContext(test.name).toBeTrue();
      }
    }
  });
});
