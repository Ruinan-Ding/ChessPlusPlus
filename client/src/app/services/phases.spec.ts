import {
  isInitialization, isWrapOpen, MILESTONES, PHASES, phaseAt, stageAt, turnHeading,
  turnOf,
} from './phases';

/**
 * A full turn is white's hand-over and black's. The engine counts one per
 * hand-over, so every schedule question is asked in those - `ply(4)` is the
 * pair that make up turn 4.
 */
const ply = (turn: number, side: 'white' | 'black' = 'white') =>
  turn * 2 - (side === 'white' ? 1 : 0);

/**
 * The schedule is arithmetic on a table, so the table is what is worth
 * pinning: change a phase's length and every countdown after it moves.
 */
describe('the match schedule', () => {
  it('runs three turns of setup, three ten-turn phases, then overtime', () => {
    expect(PHASES.map(p => p.name)).toEqual([
      'Initialization', 'Phase 1', 'Phase 2', 'Phase 3', 'Overtime',
    ]);
    // Every gear change, in order, and the turn it lands at the end of.
    expect(MILESTONES).toEqual([
      { turn: 3, next: 'Phase 1' },
      { turn: 8, next: 'Phase 1 Halftime' },
      { turn: 13, next: 'Phase 2' },
      { turn: 18, next: 'Phase 2 Halftime' },
      { turn: 23, next: 'Phase 3' },
      { turn: 28, next: 'Phase 3 Halftime' },
      { turn: 33, next: 'Overtime' },
    ]);
  });

  it('places a turn in its phase, and names the opening', () => {
    expect([1, 2, 3].map(t => phaseAt(ply(t)).name)).toEqual(
      ['Initialization', 'Initialization', 'Initialization']);
    expect(phaseAt(ply(4)).name).toBe('Phase 1');
    expect(phaseAt(ply(13, 'black')).name).toBe('Phase 1');
    expect(phaseAt(ply(14)).name).toBe('Phase 2');
    expect(phaseAt(ply(33, 'black')).name).toBe('Phase 3');
    // Overtime runs out the match, so everything past the schedule is in it.
    expect(phaseAt(ply(34)).name).toBe('Overtime');
    expect(phaseAt(ply(500)).name).toBe('Overtime');

    // Both hand-overs of turn 3 are still the opening; turn 4 is not.
    expect([ply(1), ply(3), ply(3, 'black')].every(isInitialization)).toBeTrue();
    expect([ply(4), ply(20)].some(isInitialization)).toBeFalse();
  });

  it('counts the turns left before the next change', () => {
    expect(turnHeading(ply(1))).toBe('Turn 1 - 2 Until Phase 1');
    // Black's half of turn 1 is the same turn, and reads as one.
    expect(turnHeading(ply(1, 'black'))).toBe('Turn 1 - 2 Until Phase 1');
    expect(turnHeading(ply(2))).toBe('Turn 2 - 1 Until Phase 1');
    // A change lands at the end of the turn it is counted to, so the last
    // turn of the initialization is already counting to the next one.
    expect(turnHeading(ply(3))).toBe('Turn 3 - 5 Until Phase 1 Halftime');
    expect(turnHeading(ply(8))).toBe('Turn 8 - 5 Until Phase 2');
    expect(turnHeading(ply(14))).toBe('Turn 14 - 4 Until Phase 2 Halftime');
    expect(turnHeading(ply(28))).toBe('Turn 28 - 5 Until Overtime');
  });

  it('counts the last change on its own turn rather than naming it early', () => {
    // Turn 33 is the last turn of Phase 3, not a turn of Overtime, and there
    // is no further change for it to move on to.
    expect(turnHeading(ply(33))).toBe('Turn 33 - 0 Until Overtime');
  });

  it('stops counting once there is nothing left to count to', () => {
    // Overtime runs out the match, so it has no end to count down to.
    expect(turnHeading(ply(34))).toBe('Turn 34 - Overtime');
    expect(turnHeading(ply(44))).toBe('Turn 44 - Overtime');
  });

  it('pairs the two hand-overs of a turn into one turn', () => {
    // White opens, black answers, and the pair is turn 1.
    expect([1, 2].map(turnOf)).toEqual([1, 1]);
    expect([3, 4].map(turnOf)).toEqual([2, 2]);
    // Which is what puts overtime's first turn at hand-over 67, not 34.
    expect(turnOf(66)).toBe(33);
    expect(turnOf(67)).toBe(34);
  });
});

/**
 * The wrap out of a base is on a window, not on all match. Open through the
 * opening, through the first half of each numbered phase, and through
 * overtime - shut from a phase's halftime to the end of it.
 */
describe('isWrapOpen', () => {
  it('is open all through the opening', () => {
    expect([1, 2, 3].map(t => isWrapOpen(ply(t)))).toEqual([true, true, true]);
  });

  it('shuts at each phase halftime and opens again at the next phase', () => {
    // Phase 1 runs 4-13 and breaks after 8; Phase 2 runs 14-23, break at 18.
    expect(isWrapOpen(ply(8))).toBeTrue();
    expect(isWrapOpen(ply(9))).toBeFalse();
    expect(isWrapOpen(ply(13))).toBeFalse();
    expect(isWrapOpen(ply(14))).toBeTrue();
    expect(isWrapOpen(ply(18))).toBeTrue();
    expect(isWrapOpen(ply(19))).toBeFalse();
    expect(isWrapOpen(ply(28))).toBeTrue();
    expect(isWrapOpen(ply(29))).toBeFalse();
    expect(isWrapOpen(ply(33))).toBeFalse();
  });

  it('opens for the whole of overtime, which never breaks', () => {
    expect([34, 40, 50, 90].map(t => isWrapOpen(ply(t)))).toEqual(
      [true, true, true, true]);
  });

  it('answers the same for both hand-overs of a turn', () => {
    // It is a point on the schedule, not something one side holds.
    for (const turn of [8, 9, 18, 19, 34]) {
      expect(isWrapOpen(ply(turn, 'black'))).toBe(isWrapOpen(ply(turn)));
    }
  });

  it('is open exactly when the phase has no halftime left to reach', () => {
    // The rule is read off the schedule, so it holds without the turn
    // numbers above being restated: a phase with a break is open until it,
    // and one without is open throughout.
    for (const turn of [1, 5, 9, 15, 20, 25, 30, 40]) {
      const phase = phaseAt(ply(turn));
      if (!phase.halftime) expect(isWrapOpen(ply(turn))).toBeTrue();
    }
  });
});

/**
 * The name the header puts after whose turn it is. Every stage gets one, not
 * just overtime - and a phase that breaks in the middle is two of them.
 */
describe('stageAt', () => {
  it('names all eight stages of the schedule in order', () => {
    expect([1, 4, 9, 14, 19, 24, 29, 34].map(t => stageAt(ply(t)))).toEqual([
      'Initialization',
      'Phase 1', 'Phase 1 Halftime',
      'Phase 2', 'Phase 2 Halftime',
      'Phase 3', 'Phase 3 Halftime',
      'Overtime',
    ]);
  });

  it('changes name at the break, not at the phase', () => {
    // Turn 8 is the last before Phase 1's halftime; 13 is its last turn.
    expect(stageAt(ply(8))).toBe('Phase 1');
    expect(stageAt(ply(9))).toBe('Phase 1 Halftime');
    expect(stageAt(ply(13))).toBe('Phase 1 Halftime');
    expect(stageAt(ply(14))).toBe('Phase 2');
  });

  it('names the halftime exactly when the wrap is shut', () => {
    // One predicate drives both, so the board can never shut the crossing on
    // a turn the header still calls Phase 1.
    for (let turn = 1; turn <= 40; turn++) {
      expect(isWrapOpen(ply(turn))).toBe(!stageAt(ply(turn)).endsWith('Halftime'));
    }
  });

  it('calls it by the same name the history header counts down to', () => {
    // `turnHeading` says "N Until Phase 1 Halftime"; the stage it arrives at
    // has to be spelled the same or the two read as different things.
    expect(turnHeading(ply(4))).toContain('Until Phase 1 Halftime');
    expect(stageAt(ply(9))).toBe('Phase 1 Halftime');
    expect(MILESTONES.map(m => m.next)).toContain('Phase 1 Halftime');
  });
});
