"""The unit-stat ceiling applies to actual rules, not only their readouts."""
import copy

from django.test import SimpleTestCase

from game.engine.ability_rules import initial_state
from game.engine.board import HexBoard
from game.engine.config_loader import DEFAULT_CONFIG
from game.engine.economy import unit_points_of
from game.engine.game_logic import resolve_heal, strike_damage
from game.engine.move_validator import get_legal_moves
from game.engine.panels import move_costs, panel_allowance
from game.engine.unit_combat import exchange
from game.engine.unit_stats import cap_unit, ranked_unit, unit_stats


class UnitStatLimitTests(SimpleTestCase):
    def setUp(self):
        self.config = copy.deepcopy(DEFAULT_CONFIG)
        self.config['setup'] = {'white': {}, 'black': {}}
        self.config['units']['capped'] = {
            'hp': 98, 'move': 95, 'attack': [98, 150], 'attackRange': 2,
            'defense': 95, 'value': 250,
            'veterancy': {'hp': 4, 'move': 8, 'attack': 4, 'defense': 10},
        }

    def test_base_veterancy_and_profile_stats_are_bounded_without_changing_config(self):
        self.config['units']['capped']['heal'] = [150, 98]
        self.config['units']['capped']['attackRange'] = 150
        before = copy.deepcopy(self.config)
        stats = unit_stats('capped', self.config, 1)
        self.assertEqual([stats[k] for k in ('hp', 'move', 'defense', 'attackRange')], [99] * 4)
        self.assertEqual(stats['attack'], [99, 99])
        self.assertEqual(stats['heal'], [99, 98])
        self.assertEqual(stats['value'], 250)
        self.assertEqual(self.config, before)

    def test_hp_creation_restore_and_first_star_preserve_metadata_and_never_revive(self):
        unit = {'unit_id': 'capped', 'color': 'white', 'uid': 'same', 'hp': 95, 'max_hp': 98, 'vet': 0}
        ranked = ranked_unit(unit, self.config, 1)
        self.assertEqual((ranked['hp'], ranked['max_hp'], ranked['uid']), (99, 99, 'same'))
        self.assertEqual(ranked_unit(ranked, self.config, 2), {**ranked, 'vet': 2})
        self.assertEqual(ranked_unit({**unit, 'hp': 0}, self.config, 1)['hp'], 0)
        board = HexBoard.from_dict(2, {'0,0': {**unit, 'hp': 150, 'max_hp': 200}})
        self.assertEqual(board.get(0, 0), {**unit, 'hp': 99, 'max_hp': 99})
        self.assertEqual(unit['hp'], 95)
        self.assertEqual(cap_unit({'unit_id': 'legacy', 'color': 'white'}), {'unit_id': 'legacy', 'color': 'white'})

    def test_combat_caps_attack_and_defense_before_subtraction_and_bounds_hp(self):
        self.config['units']['source'] = {'attack': 95, 'attackRange': 1, 'defense': 0}
        self.config['units']['target'] = {'attack': 0, 'attackRange': 1, 'defense': 95}
        source = {'unit_id': 'source', 'color': 'white', 'hp': 200, 'max_hp': 250, 'uid': 'source'}
        target = {'unit_id': 'target', 'color': 'black', 'hp': 200, 'max_hp': 250, 'uid': 'target'}
        abilities = initial_state()
        abilities['buffs'] = {'source': {'atk': 20}, 'target': {'def': 10}}
        result = exchange(source, target, 1, self.config, abilities)
        self.assertEqual((result['damage'], result['attacker_hp'], result['target_hp']), (1, 99, 98))
        abilities['buffs'] = {'source': {'effects': [{'setAtk': 150}]}, 'target': {'effects': [{'setDef': 0}]}}
        result = exchange(source, target, 1, self.config, abilities)
        self.assertEqual((result['damage'], result['attacker_hp'], result['target_hp']), (99, 99, 0))
        self.assertEqual(strike_damage({'attack': 150, 'attackRange': 1}, {'defense': 150}, 1, self.config), 1)
        self.assertEqual(source['hp'], 200)

    def test_movement_ceiling_precedes_spent_budget_on_board_and_in_panels(self):
        unit = {'unit_id': 'capped', 'color': 'white', 'uid': 'walker', 'hp': 98, 'max_hp': 98}
        abilities = initial_state()
        abilities['buffs']['walker'] = {'mov': 20}
        board = HexBoard.from_dict(101, {'0,0': unit})
        destinations = get_legal_moves(board, (0, 0), self.config, 'white', ability_state=abilities)
        self.assertIn((99, 0), destinations)
        self.assertNotIn((100, 0), destinations)
        destinations = get_legal_moves(board, (0, 0), self.config, 'white', -95, abilities)
        self.assertIn((4, 0), destinations)
        self.assertNotIn((5, 0), destinations)
        history = [{'turn': 7, 'panelMove': True, 'unit': unit, 'from': '0,0', 'to': '1,0', 'cost': 95}]
        self.assertEqual(panel_allowance(self.config, history, {**unit, 'panel': 'tl'}, 7, abilities), 4)
        corridor = {f'{n},0' for n in range(102)}
        costs, _ = move_costs({'0,0': unit}, 0, 0, self.config, 102, 150, zone=corridor)
        self.assertEqual(costs['99,0'], 99)
        self.assertNotIn('100,0', costs)

    def test_normal_healing_caps_hel_and_max_hp_after_modifiers(self):
        self.config['units']['healer'] = {'heal': [98], 'hp': 200, 'defense': 0, 'attack': 0}
        board = HexBoard.from_dict(2, {
            '0,0': {'unit_id': 'healer', 'color': 'white', 'uid': 'healer', 'hp': 200, 'max_hp': 200},
            '1,0': {'unit_id': 'capped', 'color': 'white', 'uid': 'target', 'hp': 1, 'max_hp': 200},
        })
        abilities = initial_state()
        abilities['buffs']['healer'] = {'hel': 20}
        result = resolve_heal(board, (0, 0), (1, 0), self.config, abilities)
        self.assertEqual((result['healed_amount'], result['healed_hp']), (98, 99))
        self.assertEqual(board.get(1, 0)['max_hp'], 99)

    def test_unit_price_and_currency_payouts_are_independent_of_the_unit_stat_cap(self):
        self.assertEqual(unit_points_of('white', [{'defender_eliminated': True, 'captured': 'capped', 'color': 'white'}], self.config), 260)

    def test_panel_hp_transition_is_idempotent_retains_stars_and_survives_board_serialization(self):
        unit = dict(unit_id='pawn', color='white', uid='same', hp=5, max_hp=14, vet=2)
        panel = ranked_unit(unit, self.config, 2, active=False)
        self.assertEqual((panel['hp'], panel['max_hp'], panel['vet']), (5, 12, 2))
        self.assertEqual(ranked_unit(panel, self.config, 3, active=False)['hp'], 5)
        restored = HexBoard.from_dict(2, {'0,0': panel}).get(0, 0)
        field = ranked_unit(restored, self.config, 2)
        self.assertEqual((field['hp'], field['max_hp']), (7, 14))
        self.assertEqual(ranked_unit(field, self.config, 2), field)
        self.assertEqual(ranked_unit({**panel, 'hp': 0}, self.config, 2)['hp'], 0)
        capped = ranked_unit(dict(unit_id='capped', hp=98, max_hp=98, vet=0), self.config, 1)
        self.assertEqual(ranked_unit(capped, self.config, 1, active=False)['max_hp'], 98)
