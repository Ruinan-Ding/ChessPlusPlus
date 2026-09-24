import {
  isEntryOpen, isHomecomingOpen, isInitialization, isOvertime,
  isPostmatch, isSetupTurn, isWrapOpen, MILESTONES, noAttackMessage,
  OVERTIME_FIRST_PLY, OVERTIME_FIRST_TURN, OVERTIME_LAST_TURN, OVERTIME_STAGES,
  overtimeTollAt, overtimeTollOver, PHASES, phaseAt, phaseIndexAt,
  pointsPerTurnAt, stageAt, turnHeading, turnOf, turnPointsBy,
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
  it('runs three turns of setup, then three phases that each close with one', () => {
    expect(PHASES.map(p => p.name)).toEqual([
      'Initialization', 'Phase 1', 'Phase 2', 'Phase 3', 'Overtime',
    ]);
    // Every gear change, in order, and the turn it lands at the end of. A
    // phase that closes with a postmatch is two changes at its end: into the
    // setup turn once its ten are played, then out of it into what follows.
    expect(MILESTONES).toEqual([
      { turn: 3, next: 'Phase 1' },
      { turn: 8, next: 'Phase 1 Halftime' },
      { turn: 13, next: 'Phase 1 Postmatch' },
      { turn: 14, next: 'Phase 2' },
      { turn: 19, next: 'Phase 2 Halftime' },
      { turn: 24, next: 'Phase 2 Postmatch' },
      { turn: 25, next: 'Phase 3' },
      { turn: 30, next: 'Phase 3 Halftime' },
      { turn: 35, next: 'Phase 3 Postmatch' },
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

  it('closes each numbered phase with a postmatch its ten do not count', () => {
    expect(turnsWhere(isPostmatch)).toEqual([14, 25, 36]);
    // Both hand-overs of it, so each side gets one to set out on - and as
    // plies, which is what every caller actually asks with.
    expect([27, 28, 49, 50, 71, 72].every(isPostmatch)).toBeTrue();
    expect([26, 29, 48, 51, 70, 73].some(isPostmatch)).toBeFalse();
    // Phase 1 still plays ten turns, 4 through 13, and the postmatch after
    // them is still Phase 1's: it belongs to the phase it closes.
    expect(phaseAt(ply(4)).name).toBe('Phase 1');
    expect(phaseAt(ply(13)).name).toBe('Phase 1');
    expect(phaseAt(ply(14, 'black')).name).toBe('Phase 1');
    expect(phaseAt(ply(15)).name).toBe('Phase 2');
    // Which is why nothing that counts by phase moved: every ply is in the
    // phase it was in before the extra turn moved to the other end.
    expect([27, 28].map(phaseIndexAt)).toEqual([1, 1]);
    expect([49, 50, 71, 72].map(phaseIndexAt)).toEqual([2, 2, 3, 3]);
    expect(OVERTIME_FIRST_PLY).toBe(73);
  });

  it('plays the moment the opening is over', () => {
    // The point of moving the extra turn: the opening's three used to run
    // straight on into Phase 1's own setup turn, four in a row.
    expect(isSetupTurn(ply(3, 'black'))).toBeTrue();
    expect(isSetupTurn(ply(4))).toBeFalse();
    expect(stageAt(ply(4))).toBe('Phase 1');
  });

  it('keeps the opening and a postmatch apart', () => {
    // The opening's one-move-per-phase lock hangs off `isInitialization`, and
    // it must not be handed to a turn it was never about.
    expect(turnsWhere(isInitialization)).toEqual([1, 2, 3]);
    expect(turnsWhere(isSetupTurn)).toEqual([1, 2, 3, 14, 25, 36]);
    expect(isInitialization(ply(14))).toBeFalse();
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
    expect(turnHeading(ply(1))).toBe('Turn 1 - 2 Until Phase 1');
    // Black's half of turn 1 is the same turn, and reads as one.
    expect(turnHeading(ply(1, 'black'))).toBe('Turn 1 - 2 Until Phase 1');
    expect(turnHeading(ply(2))).toBe('Turn 2 - 1 Until Phase 1');
    // A change lands at the end of the turn it is counted to, so the last
    // turn of the opening is already counting to the next one - and with no
    // setup turn between the opening and Phase 1's play any more, that is
    // the halftime.
    expect(turnHeading(ply(3))).toBe('Turn 3 - 5 Until Phase 1 Halftime');
    expect(turnHeading(ply(4))).toBe('Turn 4 - 4 Until Phase 1 Halftime');
    expect(turnHeading(ply(9))).toBe('Turn 9 - 4 Until Phase 1 Postmatch');
    expect(turnHeading(ply(12))).toBe('Turn 12 - 1 Until Phase 1 Postmatch');
    // The same rule carries the countdown over the postmatch: turn 13 hands
    // over to it, so it is already counting to the phase after.
    expect(turnHeading(ply(13))).toBe('Turn 13 - 1 Until Phase 2');
    expect(turnHeading(ply(14))).toBe('Turn 14 - 5 Until Phase 2 Halftime');
    expect(turnHeading(ply(15))).toBe('Turn 15 - 4 Until Phase 2 Halftime');
    expect(turnHeading(ply(31))).toBe('Turn 31 - 4 Until Phase 3 Postmatch');
  });

  it('counts the last change on its own turn rather than naming it early', () => {
    // Turn 49 is the last turn of Overtime 2, not a turn of Overtime 3, and
    // there is no further change for it to move on to.
    expect(turnHeading(ply(49))).toBe('Turn 49 - 0 Until Overtime 3');
  });

  it("counts down overtime's own gear changes", () => {
    // Turn 35 gives the warning that overtime is one turn away, and names the
    // stretch it arrives in: turn 36 between them is Phase 3's postmatch.
    // Turn 36 has already moved on to the change after it - the same rule
    // every other boundary follows, and why turn 13 reads `1 Until Phase 2`
    // rather than `0 Until Phase 1 Postmatch`. It used to read `0 Until
    // Overtime` only because Overtime was the last change on the board; now
    // that its own stretches follow, turn 36 counts to them like any other.
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
      4, 5, 6, 7, 8, 15, 16, 17, 18, 19, 26, 27, 28, 29, 30,
    ]);
  });

  it('shuts the wrap through the opening, the postmatches and overtime', () => {
    // `beforeHalftime` alone used to answer this, and it said yes for every
    // phase with no break to fall either side of - which quietly included the
    // opening and the whole of overtime.
    expect([1, 2, 3].some(t => isWrapOpen(ply(t)))).toBeFalse();
    expect([14, 25, 36].some(t => isWrapOpen(ply(t)))).toBeFalse();
    expect([37, 40, 90].some(t => isWrapOpen(ply(t)))).toBeFalse();
  });

  it('opens the way in on the setup turns and each phase\'s halftime half', () => {
    // Each halftime half runs straight on into its phase's postmatch, which
    // is a setup turn: so the way in, once open, stays open to the phase's end.
    expect(turnsWhere(isEntryOpen)).toEqual([
      1, 2, 3, 9, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 25,
      31, 32, 33, 34, 35, 36,
    ]);
  });

  it('opens the way home on the setup turns and all of overtime', () => {
    // Phase 3's postmatch runs straight on into overtime, so from turn 36 the
    // doorways home never shut again.
    expect(turnsWhere(isHomecomingOpen)).toEqual([1, 2, 3, 14, 25, 36, 37, 38, 39]);
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
    for (const turn of [3, 4, 8, 9, 13, 14, 15, 25, 30, 31, 36, 37]) {
      expect(isWrapOpen(ply(turn, 'black'))).toBe(isWrapOpen(ply(turn)));
      expect(isEntryOpen(ply(turn, 'black'))).toBe(isEntryOpen(ply(turn)));
      expect(isHomecomingOpen(ply(turn, 'black'))).toBe(isHomecomingOpen(ply(turn)));
    }
  });
});

/**
 * The name the header puts after whose turn it is. Every stage gets one, not
 * just overtime - and a phase that breaks in the middle is two of them, on top
 * of the postmatch it closes with.
 */
describe('stageAt', () => {
  it('names all thirteen stages of the schedule in order', () => {
    expect([1, 4, 9, 14, 15, 20, 25, 26, 31, 36, 37, 45, 50]
      .map(t => stageAt(ply(t)))).toEqual([
      'Initialization',
      'Phase 1', 'Phase 1 Halftime', 'Phase 1 Postmatch',
      'Phase 2', 'Phase 2 Halftime', 'Phase 2 Postmatch',
      'Phase 3', 'Phase 3 Halftime', 'Phase 3 Postmatch',
      'Overtime 1', 'Overtime 2', 'Overtime 3',
    ]);
  });

  it('names every turn of the match, both hand-overs alike', () => {
    // The whole table, turn by turn, so a stage one turn early or late at any
    // boundary shows up here rather than on somebody's header.
    const expected = (turn: number): string => {
      if (turn <= 3) return 'Initialization';
      if (turn <= 8) return 'Phase 1';
      if (turn <= 13) return 'Phase 1 Halftime';
      if (turn === 14) return 'Phase 1 Postmatch';
      if (turn <= 19) return 'Phase 2';
      if (turn <= 24) return 'Phase 2 Halftime';
      if (turn === 25) return 'Phase 2 Postmatch';
      if (turn <= 30) return 'Phase 3';
      if (turn <= 35) return 'Phase 3 Halftime';
      if (turn === 36) return 'Phase 3 Postmatch';
      if (turn <= 44) return 'Overtime 1';
      if (turn <= 49) return 'Overtime 2';
      return 'Overtime 3';
    };
    for (let turn = 1; turn <= 52; turn++) {
      expect(stageAt(ply(turn))).withContext(`turn ${turn}`).toBe(expected(turn));
      expect(stageAt(ply(turn, 'black'))).withContext(`turn ${turn}`).toBe(expected(turn));
    }
  });

  it('changes name at the break, not at the phase', () => {
    // Turn 8 is the last before Phase 1's halftime; 13 is its last turn of
    // play, and 14 the postmatch that closes it.
    expect(stageAt(ply(8))).toBe('Phase 1');
    expect(stageAt(ply(9))).toBe('Phase 1 Halftime');
    expect(stageAt(ply(13))).toBe('Phase 1 Halftime');
    expect(stageAt(ply(14))).toBe('Phase 1 Postmatch');
    expect(stageAt(ply(15))).toBe('Phase 2');
  });

  it('names the halftime exactly when the way in is open and the wrap is not', () => {
    // One predicate drives all three, so the board can never shut the crossing
    // on a turn the header still calls Phase 1.
    for (let turn = 4; turn <= 36; turn++) {
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
    expect(stageAt(ply(9))).toBe('Phase 1 Halftime');
    expect(MILESTONES.map(m => m.next)).toContain('Phase 1 Halftime');
    // And the same for the stage a phase now closes with.
    expect(turnHeading(ply(12))).toContain('Until Phase 1 Postmatch');
    expect(stageAt(ply(14))).toBe('Phase 1 Postmatch');
    expect(MILESTONES.map(m => m.next)).toContain('Phase 1 Postmatch');
    // Nothing is counted down to that the header never names.
    expect(MILESTONES.map(m => m.next).some(n => n.endsWith('Initialization'))).toBeFalse();
  });
});

describe('noAttackMessage', () => {
  it('names the turn that refused the blow, not the phase before it', () => {
    // "the opening" on turn 14 would send the player looking at a phase that
    // ended at turn 3.
    expect(noAttackMessage(ply(1))).toBe('Nobody attacks in the opening');
    expect(noAttackMessage(ply(3, 'black'))).toBe('Nobody attacks in the opening');
    expect(noAttackMessage(ply(14))).toBe('Nobody attacks in the postmatch');
    expect(noAttackMessage(ply(14, 'black'))).toBe('Nobody attacks in the postmatch');
    expect(noAttackMessage(ply(36))).toBe('Nobody attacks in the postmatch');
  });

  it('says nothing at all on a turn that refuses no blow', () => {
    // Asked as "not the opening, so a postmatch", it would answer `Nobody
    // attacks in the postmatch` for every playable turn of every phase -
    // which is what a caller reading it as a general "why was this refused?"
    // would have got, and it is exported for exactly that. (It did, when the
    // extra turn was a phase's initialization.) Turn 4 is the one that used
    // to be a setup turn and now plays.
    expect(noAttackMessage(ply(4))).toBe('');
    expect(noAttackMessage(ply(13, 'black'))).toBe('');
    expect(noAttackMessage(ply(15))).toBe('');
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
 * to hold overtime's end stayed behind when each numbered phase gained its
 * extra turn (an initialization at its start then, a postmatch at its end now)
 * and pushed overtime three turns later, and cost overtime three of its turns
 * without a single test noticing.
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
