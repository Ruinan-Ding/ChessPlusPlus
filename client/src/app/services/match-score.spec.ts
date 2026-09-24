import {
  bankEndedPhases, capOf, decidedOnPoints, deathsOf, matchVerdict, scheduleEnding,
} from './match-score';
import { captureZoneHexes } from './hex-rules';

/**
 * The phase bank and the schedule's two endings. ScoringTestCase in the
 * server's test_engine.py pins the same numbers on the same positions, so the
 * two mirrors have one set of answers to agree on.
 */
describe('match-score', () => {
  const PAWN = { units: { pawn: { value: 5 } }, board: { radius: 11 } };
  const pawn = (color: 'white' | 'black') => ({ unit_id: 'pawn', color });

  it('makes five zones of nineteen hexes on the shipped board', () => {
    const zone = captureZoneHexes(11);
    expect(zone.size).toBe(95);
    for (const centre of ['0,0', '7,0', '-7,0', '3,-6', '-3,6']) expect(zone.has(centre)).toBeTrue();
  });

  it('claims a unit its hex and the zone hexes beside it', () => {
    // In the middle of a zone: its own hex and all six around it.
    expect(capOf({ '0,0': pawn('white') }, 11, 'white')).toBe(7);
    // On a zone's rim: only the zone hexes beside it count.
    expect(capOf({ '-5,0': pawn('white') }, 11, 'white')).toBe(4);
    // Two sides touching cancel the hexes both reach: the two they stand on
    // and the two beside both, which leaves three apiece.
    const touching = { '0,0': pawn('white'), '1,0': pawn('black') };
    expect(capOf(touching, 11, 'white')).toBe(3);
    expect(capOf(touching, 11, 'black')).toBe(3);
  });

  it('charges a loss to the phase it happened in', () => {
    const history = [
      // Ply 8, Phase 1: black killed a white pawn.
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
      // Ply 31, Phase 2: white's attacker died to the counter.
      { color: 'white', unit_id: 'pawn', attacker_eliminated: true, turn: 31 },
    ];
    expect(deathsOf(PAWN, history, 'white', 1)).toBe(5);
    expect(deathsOf(PAWN, history, 'white', 2)).toBe(5);
    expect(deathsOf(PAWN, history, 'white')).toBe(10);
    expect(deathsOf(PAWN, history, 'black')).toBe(0);
  });

  it('banks a phase as its postmatch begins, and once', () => {
    const board = { '0,0': pawn('white') };
    const history = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
    ];
    // Handed to ply 26 or before, Phase 1 is still being played.
    expect(bankEndedPhases({}, PAWN, board, history, 26)).toEqual({});
    // Handed to ply 27 - its postmatch - it is over: 7 held, 5 lost.
    const bank = bankEndedPhases({}, PAWN, board, history, 27);
    expect(bank).toEqual({ 1: { white: 2, black: 0 } });
    // The postmatch reshuffles the board; the bank is the play's and stays -
    // and nothing new banked hands the same object back.
    expect(bankEndedPhases(bank, PAWN, {}, history, 29)).toBe(bank);
    // Phase 2 waits for its own postmatch.
    expect(bankEndedPhases(bank, PAWN, board, history, 48)[2]).toBeUndefined();
    expect(bankEndedPhases(bank, PAWN, board, history, 49)[2]).toBeDefined();
  });

  it('decides on points past the margins, or sends it to overtime', () => {
    const settle = (white: number, black: number) => decidedOnPoints({
      1: { white, black }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    });
    // White has to be more than 5 clear; black only more than 3.
    expect(settle(6, 0)).toBe('white');
    expect(settle(5, 0)).toBeNull();
    expect(settle(0, 4)).toBe('black');
    expect(settle(0, 3)).toBeNull();
    // Nothing is decided on two phases of three.
    expect(decidedOnPoints({ 1: { white: 99, black: 0 } })).toBeNull();
  });

  it('ends on points as Phase 3 banks, and for black once turn 50 is played out', () => {
    const clear = { 1: { white: 9, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    const level = { ...clear, 1: { white: 0, black: 0 } };
    // All three in and white past the margin: the hand-over into Phase 3's
    // postmatch, ply 71, is the first that can say so, and ends it.
    expect(scheduleEnding(clear, 71)).toEqual({ winner: 'white', reason: 'points' });
    expect(scheduleEnding(level, 71)).toBeNull();
    // Turn 50 is played out first: its hand-overs are 99 and 100, and a level
    // match ends on the hand-over into turn 51, black's.
    expect(scheduleEnding(level, 100)).toBeNull();
    expect(scheduleEnding(level, 101)).toEqual({ winner: 'black', reason: 'overtime' });
  });

  it('marks a phase banked after its moment late, and decides nothing on it', () => {
    const board = { '0,0': pawn('white') };
    // Banked on the hand-over into its postmatch: on time.
    expect(bankEndedPhases({}, PAWN, board, [], 27)[1].late).toBeUndefined();
    // Banked a hand-over later - a game saved before the engines kept the
    // bank - it is marked, and so is every phase banked with it.
    const late = bankEndedPhases({}, PAWN, board, [], 72);
    expect([1, 2, 3].map(p => late[p].late)).toEqual([true, true, true]);
    // A bank with a late phase in it decides nothing on points, however clear
    // it reads - and a late Phase 1 spoils an on-time Phase 3. The header
    // reads it the same way the engine ends on it.
    const clearButLate = {
      1: { white: 9, black: 0, late: true }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    };
    expect(decidedOnPoints(clearButLate)).toBeNull();
    expect(scheduleEnding(clearButLate, 71)).toBeNull();
    expect(matchVerdict(clearButLate, 72)).toBe('overtime');
    // Turn 50 still ends it: that rule needs no score.
    expect(scheduleEnding(clearButLate, 101)).toEqual({ winner: 'black', reason: 'overtime' });
    expect(matchVerdict(clearButLate, 101)).toBe('black');
  });

  it('reads a bank that went through JSON the same', () => {
    // Keys arrive as strings off the wire.
    const wire = JSON.parse(JSON.stringify({
      1: { white: 9, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    }));
    expect(Object.keys(wire)).toEqual(['1', '2', '3']);
    expect(decidedOnPoints(wire)).toBe('white');
    expect(matchVerdict(wire, 71)).toBe('white');
  });
});
