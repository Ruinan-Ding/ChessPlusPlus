import { isInitialization, MILESTONES, PHASES, phaseAt, turnHeading } from './phases';

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
    expect([1, 2, 3].map(t => phaseAt(t).name)).toEqual(
      ['Initialization', 'Initialization', 'Initialization']);
    expect(phaseAt(4).name).toBe('Phase 1');
    expect(phaseAt(13).name).toBe('Phase 1');
    expect(phaseAt(14).name).toBe('Phase 2');
    expect(phaseAt(33).name).toBe('Phase 3');
    // Overtime runs out the match, so everything past the schedule is in it.
    expect(phaseAt(34).name).toBe('Overtime');
    expect(phaseAt(500).name).toBe('Overtime');

    expect([1, 3].every(isInitialization)).toBeTrue();
    expect([4, 20].some(isInitialization)).toBeFalse();
  });

  it('counts the turns left before the next change', () => {
    expect(turnHeading(1)).toBe('Turn 1 - 2 Until Phase 1');
    expect(turnHeading(2)).toBe('Turn 2 - 1 Until Phase 1');
    // A change lands at the end of the turn it is counted to, so the last
    // turn of the initialization is already counting to the next one.
    expect(turnHeading(3)).toBe('Turn 3 - 5 Until Phase 1 Halftime');
    expect(turnHeading(8)).toBe('Turn 8 - 5 Until Phase 2');
    expect(turnHeading(14)).toBe('Turn 14 - 4 Until Phase 2 Halftime');
    expect(turnHeading(28)).toBe('Turn 28 - 5 Until Overtime');
  });

  it('counts the last change on its own turn rather than naming it early', () => {
    // Turn 33 is the last turn of Phase 3, not a turn of Overtime, and there
    // is no further change for it to move on to.
    expect(turnHeading(33)).toBe('Turn 33 - 0 Until Overtime');
  });

  it('stops counting once there is nothing left to count to', () => {
    // Overtime runs out the match, so it has no end to count down to.
    expect(turnHeading(34)).toBe('Turn 34 - Overtime');
    expect(turnHeading(44)).toBe('Turn 44 - Overtime');
  });
});
