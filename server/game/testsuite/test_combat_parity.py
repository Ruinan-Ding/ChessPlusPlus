"""Both engines consume these attack-ring cases, including zero tiers."""
import json
from pathlib import Path

from django.test import SimpleTestCase

from game.engine.game_logic import can_attack


class CombatParityTestCase(SimpleTestCase):
    def test_ring_eligibility_matches_the_shared_cases(self):
        path = Path(__file__).resolve().parents[3] / 'client/src/app/services/combat-parity.json'
        for case in json.loads(path.read_text(encoding='utf-8')):
            with self.subTest(case=case):
                self.assertEqual(can_attack(case['unit'], case['distance']), case['canAttack'])
