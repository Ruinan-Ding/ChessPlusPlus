import {
  bankEndedPhases, capOf, cpAwarded, decidedOnPoints, deathsOf, matchVerdict, phaseTotal,
  scheduleEnding, vpAsPoints,
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

  it('charges nothing for a unit killed in a base, and the full price in a reserve', () => {
    // The owner, 24 Sep 2026: "killing things in base (red panel) should not
    // count towards victory points ... in green panel it ... counts towards
    // victory points".
    const blow = {
      intoPanel: true, panelAttack: true, color: 'white', unit_id: 'pawn', captured: 'pawn',
      defender_eliminated: true, turn: 8,
    };
    expect(deathsOf(PAWN, [{ ...blow, panel: 'tr' }], 'black', 1)).toBe(0);
    expect(deathsOf(PAWN, [{ ...blow, panel: 'tl' }], 'black', 1)).toBe(5);
    // A reserve's counter that kills the attacker counts against the attacker.
    const counter = {
      intoPanel: true, panel: 'tl', color: 'white', unit_id: 'pawn', attacker_eliminated: true, turn: 8,
    };
    expect(deathsOf(PAWN, [counter], 'white', 1)).toBe(5);
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

  it('never banks a phase below nothing', () => {
    // The owner, 24 Sep 2026: "the total points racked shouldnt go negative
    // by death. max is 0". Deaths can take a phase down to 0 and no further;
    // cap still counts in full against what is left.
    expect(phaseTotal(7, 5, 1)).toBe(2);
    expect(phaseTotal(7, 7, 1)).toBe(0);
    expect(phaseTotal(4, 18, 1)).toBe(0);
    expect(phaseTotal(0, 0, 1)).toBe(0);
    // The floor comes before the phase's multiplier: 0 in Phase 3, not -42.
    expect(phaseTotal(4, 18, 3)).toBe(0);
    // A white pawn lost in Phase 1 with nothing held: 0, not -5.
    const history = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
    ];
    expect(bankEndedPhases({}, PAWN, {}, history, 27)).toEqual({ 1: { white: 0, black: 0 } });
  });

  it('awards CP off each banked phase, with the gap to the side behind', () => {
    // The owner, 24 Sep 2026: the side with the higher total gets
    // phase_x + (mine + theirs), the lower that plus abs(mine - theirs), with
    // phase_x 10, 20, 30. Nothing before a phase banks.
    expect(cpAwarded({}, 'white', 10)).toBe(0);
    const one = { 1: { white: 12, black: 4 } };
    expect(cpAwarded(one, 'white', 10)).toBe(26);   // 10 + 16
    expect(cpAwarded(one, 'black', 10)).toBe(34);   // 10 + 16 + 8
    // Level scores award the two the same: Phase 2 adds 20 + 6 to each.
    const two = { ...one, 2: { white: 3, black: 3 } };
    expect(cpAwarded(two, 'white', 10)).toBe(52);
    expect(cpAwarded(two, 'black', 10)).toBe(60);
    // Phase 3, nothing scored: its offset alone, 30.
    const three = { ...two, 3: { white: 0, black: 0 } };
    expect(cpAwarded(three, 'white', 10)).toBe(82);
    // Only the phase's own scores are compared: black leads the match here,
    // and white, behind in Phase 2, is paid its gap.
    const behind = { 1: { white: 0, black: 20 }, 2: { white: 2, black: 6 } };
    expect(cpAwarded(behind, 'white', 10)).toBe((10 + 20 + 20) + (20 + 8 + 4));
    expect(cpAwarded(behind, 'black', 10)).toBe((10 + 20) + (20 + 8));
    // The offset is the config's; a late phase still awards.
    expect(cpAwarded(one, 'white', 5)).toBe(21);
    expect(cpAwarded({ 1: { white: 2, black: 2, late: true } }, 'black', 10)).toBe(14);
  });

  it("multiplies a phase's score by its number", () => {
    // The owner, 24 Sep 2026: "the total victory points for each phase is
    // multiplied by 2 on phase 2, multipled by 3 on phase 3".
    expect([1, 2, 3].map(p => phaseTotal(7, 5, p))).toEqual([2, 4, 6]);
    // Banked that way: one pawn in the middle holds 7, every phase.
    const board = { '0,0': pawn('white') };
    let bank = bankEndedPhases({}, PAWN, board, [], 27);
    bank = bankEndedPhases(bank, PAWN, board, [], 49);
    bank = bankEndedPhases(bank, PAWN, board, [], 71);
    expect([1, 2, 3].map(p => bank[p].white)).toEqual([7, 14, 21]);
  });

  it('converts the victory points at overtime, but never after a points win', () => {
    const close = { 1: { white: 10, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    expect(vpAsPoints(close, 'white', 72)).toBe(0);
    expect(vpAsPoints(close, 'white', 73)).toBe(10);
    expect(vpAsPoints(close, 'black', 73)).toBe(0);
    expect(vpAsPoints(close, 'black', 74)).toBe(0);   // black banked nothing
    // Won on points, the match ends ON hand-over 73 and never reaches overtime.
    const won = { ...close, 1: { white: 30, black: 0 } };
    expect(vpAsPoints(won, 'white', 73)).toBe(0);
  });

  it('decides on points past the margins, or sends it to overtime', () => {
    const settle = (white: number, black: number) => decidedOnPoints({
      1: { white, black }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    });
    // White has to be more than 10 clear; black only more than 5.
    expect(settle(11, 0)).toBe('white');
    expect(settle(10, 0)).toBeNull();
    expect(settle(0, 6)).toBe('black');
    expect(settle(0, 5)).toBeNull();
    // Nothing is decided on two phases of three.
    expect(decidedOnPoints({ 1: { white: 99, black: 0 } })).toBeNull();
  });

  it("ends on points once Phase 3's postmatch is played, and for black once turn 50 is", () => {
    const clear = { 1: { white: 12, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    const level = { ...clear, 1: { white: 0, black: 0 } };
    // All three in and white past the margin: known from the hand-over into
    // Phase 3's postmatch (ply 71), and named in the header from there - but
    // the postmatch is played, and the match ends on the hand-over out of it,
    // into turn 37 (ply 73).
    expect(matchVerdict(clear, 71)).toBe('white');
    expect(scheduleEnding(clear, 71)).toBeNull();
    expect(scheduleEnding(clear, 72)).toBeNull();
    expect(scheduleEnding(clear, 73)).toEqual({ winner: 'white', reason: 'points' });
    expect(scheduleEnding(level, 73)).toBeNull();
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
      1: { white: 12, black: 0, late: true }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    };
    expect(decidedOnPoints(clearButLate)).toBeNull();
    expect(scheduleEnding(clearButLate, 73)).toBeNull();
    expect(matchVerdict(clearButLate, 72)).toBe('overtime');
    // Turn 50 still ends it: that rule needs no score.
    expect(scheduleEnding(clearButLate, 101)).toEqual({ winner: 'black', reason: 'overtime' });
    expect(matchVerdict(clearButLate, 101)).toBe('black');
  });

  it('reads a bank that went through JSON the same', () => {
    // Keys arrive as strings off the wire.
    const wire = JSON.parse(JSON.stringify({
      1: { white: 12, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    }));
    expect(Object.keys(wire)).toEqual(['1', '2', '3']);
    expect(decidedOnPoints(wire)).toBe('white');
    expect(matchVerdict(wire, 71)).toBe('white');
  });
});
