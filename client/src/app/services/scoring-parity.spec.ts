import fixtures from './scoring-parity.json';
import { captureClaims, captureZoneHexes } from './hex-rules';
import {
  PhaseBank, bankEndedPhases, cpAwarded, decidedOnPoints, deathsOf, phaseTotal, scheduleEnding,
  scheduledPoints, vpAsPoints,
} from './match-score';
import { overtimeTollAt, turnPointsBy } from './phases';

/**
 * The client's scoring against the fixtures the server is tested against too.
 *
 * `scoring-parity.json` holds fixed cases and the server engine's answers to
 * them, written by `server/scripts/make_scoring_parity.py`; the server's
 * `test_scoring_parity.py` asserts its own engine against the same file. So a
 * rule changed on one side alone fails one of the two suites, where each
 * side's own specs - pinning their own numbers - would pass.
 *
 * A failure here means this engine no longer says what the server says. If
 * the rules changed on purpose, change them in both engines and regenerate;
 * if not, this engine has drifted.
 */
describe('scoring parity with the server', () => {
  const sides = ['white', 'black'] as const;

  it('draws the same capture zones', () => {
    for (const [radius, hexes] of Object.entries(fixtures.zones)) {
      expect([...captureZoneHexes(Number(radius))].sort()).withContext(radius).toEqual(hexes);
    }
  });

  it('pays the same points and takes the same toll, every ply', () => {
    for (const [ply, white, black, toll] of fixtures.plies) {
      expect([turnPointsBy('white', ply), turnPointsBy('black', ply), overtimeTollAt(ply)])
        .withContext(`ply ${ply}`).toEqual([white, black, toll]);
    }
  });

  it("totals a phase the same", () => {
    for (const [multiplier, cap, deaths, total] of fixtures.totals) {
      expect(phaseTotal(cap, deaths, multiplier)).withContext(`${multiplier} ${cap} ${deaths}`).toBe(total);
    }
  });

  it('answers every case the same', () => {
    fixtures.cases.forEach((c: any, i: number) => {
      const bank = c.bank as PhaseBank;
      const expected = c.expect;
      const ending = scheduleEnding(bank, c.ply);
      const claims = Object.fromEntries([...captureClaims(c.board, c.config.board.radius)].sort());
      const actual = {
        claims,
        bank: bankEndedPhases(bank, c.config, c.board, c.history, c.ply),
        deaths: sides.map(side => [1, 2, 3, undefined].map(p => deathsOf(c.config, c.history, side, p))),
        decided: decidedOnPoints(bank),
        ending: ending ? [ending.winner, ending.reason] : null,
        cp: sides.map(side => cpAwarded(bank, side, 5)),
        vp: [72, 73, 74, c.ply].map(p => [p, ...sides.map(side => vpAsPoints(bank, side, p))]),
        scheduled: sides.map(side => scheduledPoints(bank, side, c.ply)),
      };
      // Through JSON, as the fixture went: a bank's keys are strings there.
      expect(JSON.parse(JSON.stringify(actual))).withContext(`case ${i}`).toEqual(expected);
    });
  });
});
