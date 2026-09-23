import {
  isEntryOpen, isHomecomingOpen, isInitialization, isOvertime,
  isPhaseInitialization, isSetupTurn, isWrapOpen, MILESTONES, noAttackMessage,
  OVERTIME_FIRST_TURN, OVERTIME_LAST_TURN, OVERTIME_STAGES, overtimeTollAt,
  overtimeTollOver, PHASES, phaseAt, pointsPerTurnAt, stageAt, turnHeading,
  turnOf, turnPointsBy,
} from './phases';

/**
 * A full turn is white's hand-over and black's. The engine counts one per
 * hand-over, so every schedule question is asked in those - `ply(4)` is the
 * pair that make up turn 4.
 */
const ply = (turn: number, side: 'white' | 'black' = 'white') =>
  turn * 2 - (side === 'white' ? 1 : 0);

/** The turns in 1..39 a predicate says yes to, as full turns. */
const turnsWhere = (open: (ply: number) => boolean) =>
  Array.from({ length: 39 }, (_, i) => i + 1).filter(turn => open(ply(turn)));

/**
 * The schedule is arithmetic on a table, so the table is what is worth
 * pinning: change a phase's length and every countdown after it moves.
 */
describe('the match schedule', () => {
  it('runs three turns of setup, then three phases that each open with one', () => {
    expect(PHASES.map(p => p.name)).toEqual([
      'Initialization', 'Phase 1', 'Phase 2', 'Phase 3', 'Overtime',
    ]);
    // Every gear change, in order, and the turn it lands at the end of. A
    // phase that opens with an initialization turn is two changes: into the
    // setup turn, then out of it into the phase's play.
    expect(MILESTONES).toEqual([
      { turn: 3, next: 'Phase 1 Initialization' },
      { turn: 4, next: 'Phase 1' },
      { turn: 9, next: 'Phase 1 Halftime' },
      { turn: 14, next: 'Phase 2 Initialization' },
      { turn: 15, next: 'Phase 2' },
      { turn: 20, next: 'Phase 2 Halftime' },
      { turn: 25, next: 'Phase 3 Initialization' },
      { turn: 26, next: 'Phase 3' },
      { turn: 31, next: 'Phase 3 Halftime' },
      // Into overtime by its first stretch's name, not the phase's - that is
      // what `stageAt` says on turn 37, and a countdown has to agree with it.
      { turn: 36, next: 'Overtime 1' },
      // Overtime's toll climbs twice, and a turn where the damage doubles is
      // as much a change to count down to as a halftime is. The last stretch
      // has nothing after it to announce, so it pushes nothing.
      { turn: 44, next: 'Overtime 2' },
      { turn: 49, next: 'Overtime 3' },
    ]);
  });

  it('gives each numbered phase an initialization turn its ten do not count', () => {
    expect(turnsWhere(isPhaseInitialization)).toEqual([4, 15, 26]);
    // Both hand-overs of it, so each side gets one to set out on.
    expect([ply(4), ply(4, 'black')].every(isPhaseInitialization)).toBeTrue();
    // Phase 1 still plays ten turns: 5 through 14.
    expect(phaseAt(ply(4)).name).toBe('Phase 1');
    expect(phaseAt(ply(14)).name).toBe('Phase 1');
    expect(phaseAt(ply(15)).name).toBe('Phase 2');
  });

  it('keeps the opening and a phase initialization apart', () => {
    // The opening's one-move-per-phase lock hangs off `isInitialization`, and
    // it must not be handed to a turn it was never about.
    expect(turnsWhere(isInitialization)).toEqual([1, 2, 3]);
    expect(turnsWhere(isSetupTurn)).toEqual([1, 2, 3, 4, 15, 26]);
    expect(isInitialization(ply(4))).toBeFalse();
  });

  it('places a turn in its phase, and names the opening', () => {
    expect([1, 2, 3].map(t => phaseAt(ply(t)).name)).toEqual(
      ['Initialization', 'Initialization', 'Initialization']);
    expect(phaseAt(ply(5)).name).toBe('Phase 1');
    expect(phaseAt(ply(14, 'black')).name).toBe('Phase 1');
    expect(phaseAt(ply(16)).name).toBe('Phase 2');
    expect(phaseAt(ply(36, 'black')).name).toBe('Phase 3');
    // Overtime runs out the match, so everything past the schedule is in it.
    expect(phaseAt(ply(37)).name).toBe('Overtime');
    expect(phaseAt(ply(500)).name).toBe('Overtime');

    // Both hand-overs of turn 3 are still the opening; turn 4 is not.
    expect([ply(1), ply(3), ply(3, 'black')].every(isInitialization)).toBeTrue();
    expect([ply(4), ply(20)].some(isInitialization)).toBeFalse();
  });

  it('counts the turns left before the next change', () => {
    expect(turnHeading(ply(1))).toBe('Turn 1 - 2 Until Phase 1 Initialization');
    // Black's half of turn 1 is the same turn, and reads as one.
    expect(turnHeading(ply(1, 'black'))).toBe('Turn 1 - 2 Until Phase 1 Initialization');
    expect(turnHeading(ply(2))).toBe('Turn 2 - 1 Until Phase 1 Initialization');
    // A change lands at the end of the turn it is counted to, so the last
    // turn of the initialization is already counting to the next one.
    expect(turnHeading(ply(3))).toBe('Turn 3 - 1 Until Phase 1');
    expect(turnHeading(ply(4))).toBe('Turn 4 - 5 Until Phase 1 Halftime');
    expect(turnHeading(ply(9))).toBe('Turn 9 - 5 Until Phase 2 Initialization');
    expect(turnHeading(ply(15))).toBe('Turn 15 - 5 Until Phase 2 Halftime');
    expect(turnHeading(ply(31))).toBe('Turn 31 - 5 Until Overtime 1');
  });

  it('counts the last change on its own turn rather than naming it early', () => {
    // Turn 49 is the last turn of Overtime 2, not a turn of Overtime 3, and
    // there is no further change for it to move on to.
    expect(turnHeading(ply(49))).toBe('Turn 49 - 0 Until Overtime 3');
  });

  it("counts down overtime's own gear changes", () => {
    // Turn 35 gives the warning that overtime is one turn away, and names the
    // stretch it arrives in. Turn 36 has
    // already moved on to the change after it - the same rule every other
    // boundary follows, and why turn 3 reads `1 Until Phase 1` rather than
    // `0 Until Phase 1 Initialization`. It used to read `0 Until Overtime`
    // only because Overtime was the last change on the board; now that its
    // own stretches follow, turn 36 counts to them like any other turn.
    expect(turnHeading(ply(35))).toBe('Turn 35 - 1 Until Overtime 1');
    expect(turnHeading(ply(36))).toBe('Turn 36 - 8 Until Overtime 2');
    expect(turnHeading(ply(37))).toBe('Turn 37 - 7 Until Overtime 2');
    expect(turnHeading(ply(44))).toBe('Turn 44 - 5 Until Overtime 3');
    expect(turnHeading(ply(45))).toBe('Turn 45 - 4 Until Overtime 3');
  });

  it('names the stage, not the phase, once nothing is left to count to', () => {
    // Past the last change it says where you are - and it says it in the
    // stage's name. The phase's would read a plain `Overtime` on the last
    // turn of the match, a stretch the game left thirteen turns earlier.
    expect(turnHeading(ply(50))).toBe('Turn 50 - Overtime 3');
    expect(turnHeading(ply(500))).toBe('Turn 500 - Overtime 3');
  });

  it('pairs the two hand-overs of a turn into one turn', () => {
    // White opens, black answers, and the pair is turn 1.
    expect([1, 2].map(turnOf)).toEqual([1, 1]);
    expect([3, 4].map(turnOf)).toEqual([2, 2]);
    // Which is what puts overtime's first turn at hand-over 73, not 37.
    expect(turnOf(72)).toBe(36);
    expect(turnOf(73)).toBe(37);
  });
});

/**
 * Three arrows on a side and three windows. The wrap runs on the played first
 * half of a numbered phase; the reserve's ways in run on the setup turns and
 * each phase's halftime half; the base's ways home run on the setup turns and
 * all of overtime.
 */
describe('the three windows', () => {
  it('opens the wrap only on a numbered phase\'s played first half', () => {
    expect(turnsWhere(isWrapOpen)).toEqual([
      5, 6, 7, 8, 9, 16, 17, 18, 19, 20, 27, 28, 29, 30, 31,
    ]);
  });

  it('shuts the wrap through the opening, the setup turns and overtime', () => {
    // `beforeHalftime` alone used to answer this, and it said yes for every
    // phase with no break to fall either side of - which quietly included the
    // opening and the whole of overtime.
    expect([1, 2, 3].some(t => isWrapOpen(ply(t)))).toBeFalse();
    expect([4, 15, 26].some(t => isWrapOpen(ply(t)))).toBeFalse();
    expect([37, 40, 90].some(t => isWrapOpen(ply(t)))).toBeFalse();
  });

  it('opens the way in on the setup turns and each phase\'s halftime half', () => {
    expect(turnsWhere(isEntryOpen)).toEqual([
      1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 26,
      32, 33, 34, 35, 36,
    ]);
  });

  it('opens the way home on the setup turns and all of overtime', () => {
    expect(turnsWhere(isHomecomingOpen)).toEqual([1, 2, 3, 4, 15, 26, 37, 38, 39]);
  });

  it('never opens the wrap and the way in on the same turn', () => {
    // A side spends a phase's first half sending units out around the outside
    // and its second half bringing them back in.
    for (let turn = 1; turn <= 40; turn++) {
      expect(isWrapOpen(ply(turn)) && isEntryOpen(ply(turn))).toBeFalse();
    }
  });

  it('answers the same for both hand-overs of a turn', () => {
    // They are points on the schedule, not things one side holds.
    for (const turn of [4, 9, 10, 15, 26, 31, 37]) {
      expect(isWrapOpen(ply(turn, 'black'))).toBe(isWrapOpen(ply(turn)));
      expect(isEntryOpen(ply(turn, 'black'))).toBe(isEntryOpen(ply(turn)));
      expect(isHomecomingOpen(ply(turn, 'black'))).toBe(isHomecomingOpen(ply(turn)));
    }
  });
});

/**
 * The name the header puts after whose turn it is. Every stage gets one, not
 * just overtime - and a phase that breaks in the middle is two of them, on top
 * of the initialization turn it opens with.
 */
describe('stageAt', () => {
  it('names all thirteen stages of the schedule in order', () => {
    expect([1, 4, 5, 10, 15, 16, 21, 26, 27, 32, 37, 45, 50]
      .map(t => stageAt(ply(t)))).toEqual([
      'Initialization',
      'Phase 1 Initialization', 'Phase 1', 'Phase 1 Halftime',
      'Phase 2 Initialization', 'Phase 2', 'Phase 2 Halftime',
      'Phase 3 Initialization', 'Phase 3', 'Phase 3 Halftime',
      'Overtime 1', 'Overtime 2', 'Overtime 3',
    ]);
  });

  it('changes name at the break, not at the phase', () => {
    // Turn 9 is the last before Phase 1's halftime; 14 is its last turn.
    expect(stageAt(ply(9))).toBe('Phase 1');
    expect(stageAt(ply(10))).toBe('Phase 1 Halftime');
    expect(stageAt(ply(14))).toBe('Phase 1 Halftime');
    expect(stageAt(ply(15))).toBe('Phase 2 Initialization');
  });

  it('names the halftime exactly when the way in is open and the wrap is not', () => {
    // One predicate drives all three, so the board can never shut the crossing
    // on a turn the header still calls Phase 1.
    for (let turn = 5; turn <= 36; turn++) {
      const halftime = stageAt(ply(turn)).endsWith('Halftime');
      if (halftime) {
        expect(isWrapOpen(ply(turn))).toBeFalse();
        expect(isEntryOpen(ply(turn))).toBeTrue();
      }
    }
  });

  it('calls it by the same name the history header counts down to', () => {
    // `turnHeading` says "N Until Phase 1 Halftime"; the stage it arrives at
    // has to be spelled the same or the two read as different things.
    expect(turnHeading(ply(5))).toContain('Until Phase 1 Halftime');
    expect(stageAt(ply(10))).toBe('Phase 1 Halftime');
    expect(MILESTONES.map(m => m.next)).toContain('Phase 1 Halftime');
    // And the same for the stage a phase now opens with.
    expect(turnHeading(ply(3))).toContain('Until Phase 1');
    expect(stageAt(ply(4))).toBe('Phase 1 Initialization');
    expect(MILESTONES.map(m => m.next)).toContain('Phase 1 Initialization');
  });
});

describe('noAttackMessage', () => {
  it('names the turn that refused the blow, not the phase before it', () => {
    // "the opening" on turn 15 would send the player looking at a phase that
    // ended ten turns earlier.
    expect(noAttackMessage(ply(1))).toBe('Nobody attacks in the opening');
    expect(noAttackMessage(ply(3, 'black'))).toBe('Nobody attacks in the opening');
    expect(noAttackMessage(ply(4))).toBe('Nobody attacks in a phase initialization');
    expect(noAttackMessage(ply(26))).toBe('Nobody attacks in a phase initialization');
  });

  it('says nothing at all on a turn that refuses no blow', () => {
    // Asked as "not the opening, so a phase initialization", it answered
    // `Nobody attacks in a phase initialization` for every playable turn of
    // every phase - which is what a caller reading it as a general "why was
    // this refused?" would have got, and it is exported for exactly that.
    expect(noAttackMessage(ply(5))).toBe('');
    expect(noAttackMessage(ply(20))).toBe('');
    expect(noAttackMessage(ply(40))).toBe('');
  });
});

/**
 * Overtime in three stretches, and a toll that climbs through them.
 *
 * The point of the escalation is that a match neither side can win on points
 * or on the board still ends: the last turn takes three, and anything still
 * standing after it is black's. So what is worth pinning here is not just the
 * numbers but that they are read off the schedule - the literal 50 that used
 * to hold overtime's end stayed behind when the initialization turns pushed
 * overtime three turns later, and cost overtime three of its turns without a
 * single test noticing.
 */
describe("overtime's three stretches", () => {
  it('runs them 37-44, 45-49 and 50, counted off the schedule', () => {
    expect(OVERTIME_FIRST_TURN).toBe(37);
    expect(OVERTIME_LAST_TURN).toBe(50);
    // Nothing above is written down: move a phase and both move with it.
    expect(OVERTIME_LAST_TURN - OVERTIME_FIRST_TURN + 1)
      .toBe(OVERTIME_STAGES.reduce((sum, stage) => sum + stage.turns, 0));
    const stages = Array.from({ length: 14 }, (_, i) => stageAt(ply(37 + i)));
    expect(stages).toEqual([
      ...Array(8).fill('Overtime 1'),
      ...Array(5).fill('Overtime 2'),
      'Overtime 3',
    ]);
  });

  it('climbs the toll 1, 2, 3 through them', () => {
    expect([37, 44].map(t => overtimeTollAt(ply(t)))).toEqual([1, 1]);
    expect([45, 49].map(t => overtimeTollAt(ply(t)))).toEqual([2, 2]);
    expect(overtimeTollAt(ply(50))).toBe(3);
    // Both hand-overs of a turn are in the same stretch: a stretch changes at
    // a turn boundary, so the two sides of turn 45 pay the same.
    expect(overtimeTollAt(ply(45, 'black'))).toBe(2);
  });

  it("takes nothing before overtime, which is also the engines' gate", () => {
    // `overtimeTollAt` answering 0 is what both engines test instead of
    // keeping a `ply < OVERTIME_FIRST_PLY` of their own beside it - one
    // question with one answer, rather than two that can come to disagree.
    expect([1, 4, 20, 36].map(t => overtimeTollAt(ply(t)))).toEqual([0, 0, 0, 0]);
    expect(overtimeTollAt(ply(36, 'black'))).toBe(0);
    expect(overtimeTollAt(ply(37))).toBe(1);
  });

  it('keeps taking the heaviest toll past the last turn', () => {
    // The verdict past turn 50 is black's, but it is read and not enforced -
    // so a game played on has to keep paying rather than quietly stop. `null`
    // there would have been a king who bleeds for fourteen turns and then
    // becomes immortal.
    expect(isOvertime(ply(500))).toBeTrue();
    expect(overtimeTollAt(ply(51))).toBe(3);
    expect(overtimeTollAt(ply(500))).toBe(3);
  });

  it('pays 1, 3 and 5 a turn through the three stretches', () => {
    // The toll takes and the purse gives, and they climb together: the
    // pressure to finish comes with the means to. These are POINTS - the
    // board's currency, what the pool abilities and the wrap crossing are
    // bought with - not the match score, which overtime still does not touch.
    expect([1, 20, 36, 37, 44].map(t => pointsPerTurnAt(ply(t)))).toEqual([1, 1, 1, 1, 1]);
    expect([45, 49].map(t => pointsPerTurnAt(ply(t)))).toEqual([3, 3]);
    expect(pointsPerTurnAt(ply(50))).toBe(5);
    // Past the last turn it keeps paying, for the reason the toll keeps taking.
    expect(pointsPerTurnAt(ply(500))).toBe(5);
  });

  it("adds a side's turns up at the rate each one paid", () => {
    // Flat all the way to the end of overtime's first stretch: 44 turns, 44
    // points. `handOversBy * POINTS_PER_TURN` was right up to exactly here.
    expect(turnPointsBy('white', ply(44))).toBe(44);
    expect(turnPointsBy('black', ply(44, 'black'))).toBe(44);
    // Then turn 45 pays three, not one.
    expect(turnPointsBy('white', ply(45))).toBe(47);
    expect(turnPointsBy('white', ply(49))).toBe(59);
    // And the last turn pays five: 44 + 5x3 + 5.
    expect(turnPointsBy('white', ply(50))).toBe(64);
    // A side is paid at the START of its own turn, so black has nothing until
    // its first hand-over - the rule the flat version already kept.
    expect(turnPointsBy('black', 1)).toBe(0);
    expect(turnPointsBy('black', 2)).toBe(1);
    expect(turnPointsBy('white', 1)).toBe(1);
  });

  it("sums a side's next turns rather than multiplying one of them", () => {
    // What the board's skull warns on. A side pays once a full turn, so this
    // steps two plies at a time - and because the toll climbs, the same king
    // on the same HP is warned about at different distances in each stretch.
    expect(overtimeTollOver(ply(37), 2)).toBe(2);
    // Turn 44 is the last of the first stretch: this turn costs 1, his next
    // costs 2. Multiplying either one would have answered 2 or 4.
    expect(overtimeTollOver(ply(44), 2)).toBe(3);
    expect(overtimeTollOver(ply(49), 2)).toBe(5);
    expect(overtimeTollOver(ply(37), 1)).toBe(1);
    // Asked from before overtime it still looks forward: turn 36 pays nothing
    // and turn 37 pays one. Not a gate - `doomState` asks `isOvertime` before
    // it asks this, and putting a second gate here would be one more copy of
    // where overtime starts.
    expect(overtimeTollOver(ply(36), 2)).toBe(1);
  });
});
