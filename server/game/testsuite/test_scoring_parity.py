"""
The server's scoring against the fixtures the client is tested against too.

``client/src/app/services/scoring-parity.json`` holds fixed cases and this
engine's answers to them, written by ``scripts/make_scoring_parity.py``; the
client's ``scoring-parity.spec.ts`` asserts its own engine gives the same
answers. So a rule changed on one side alone fails one of the two suites,
where each side's own tests - pinning their own numbers - would pass.

A failure here means this engine no longer says what the file says. If the
rules changed on purpose, change them in both engines and regenerate; if
not, this engine has drifted.
"""
import json
import os

from django.test import SimpleTestCase

from game.engine import phases, scoring

FIXTURES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', '..',
    'client', 'src', 'app', 'services', 'scoring-parity.json')


class ScoringParityTestCase(SimpleTestCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with open(FIXTURES, encoding='utf-8') as f:
            cls.fixtures = json.load(f)

    def test_the_capture_zones(self):
        for radius, hexes in self.fixtures['zones'].items():
            self.assertEqual(sorted(scoring.capture_zone_hexes(int(radius))), hexes, radius)

    def test_the_points_and_the_toll_every_ply(self):
        for ply, white, black, toll in self.fixtures['plies']:
            self.assertEqual(
                [phases.turn_points_by('white', ply), phases.turn_points_by('black', ply),
                 phases.overtime_toll_at(ply)],
                [white, black, toll], f'ply {ply}')

    def test_a_phase_s_total(self):
        for multiplier, cap, deaths, total in self.fixtures['totals']:
            self.assertEqual(scoring.phase_total(cap, deaths, multiplier), total,
                             (multiplier, cap, deaths))

    def test_every_case(self):
        for i, case in enumerate(self.fixtures['cases']):
            config, board, history, bank, ply = (
                case['config'], case['board'], case['history'], case['bank'], case['ply'])
            expect = case['expect']
            radius = config['board']['radius']
            ending = scoring.schedule_ending(bank, ply)
            with self.subTest(case=i):
                self.assertEqual(dict(scoring.capture_claims(board, radius)), expect['claims'])
                self.assertEqual(
                    scoring.bank_ended_phases(bank, config, board, history, ply), expect['bank'])
                self.assertEqual(
                    [[scoring.deaths_of(config, history, side, p) for p in (1, 2, 3, None)]
                     for side in ('white', 'black')], expect['deaths'])
                self.assertEqual(scoring.decided_on_points(bank), expect['decided'])
                self.assertEqual(list(ending) if ending else None, expect['ending'])
                self.assertEqual(
                    [scoring.cp_awarded(bank, side, 5) for side in ('white', 'black')],
                    expect['cp'])
                self.assertEqual(
                    [[p] + [scoring.vp_as_points(bank, side, p) for side in ('white', 'black')]
                     for p in (72, 73, 74, ply)], expect['vp'])
                self.assertEqual(
                    [scoring.scheduled_points(bank, side, ply) for side in ('white', 'black')],
                    expect['scheduled'])
