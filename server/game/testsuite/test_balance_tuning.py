"""Balance knobs change effects and transactions without changing saved defaults."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from game.engine import economy, game_rules, panels, scoring
from game.engine.ability_rules import AbilityContext, initial_state
from game.engine.config_loader import load_config
from game.engine.unit_combat import exchange


FROZEN_CONFIG = Path(__file__).resolve().parents[3] / 'shared/testing/balance-config.json'


class BalanceTuningTests(SimpleTestCase):
    def setUp(self):
        self.config = json.loads(FROZEN_CONFIG.read_text(encoding='utf-8'))
        self.config['setup'] = {'white': {}, 'black': {}}
        self.config['economy']['upAtStart'] = 1000
        self.config['match']['cpAtStart'] = 1000
        self.config['match']['objective'] = 'elimination'
        for kind, attack in [('queen', 9), ('rook', 2), ('bishop', 0)]:
            self.config['units'][kind].update(hp=40, attack=attack, attackMinRange=1,
                attackRange=1, defense=0, veterancy={})
        self.config['abilities']['catalogue']['queen-leech'].update(atk=0, **{'def': 0})
        self.state = SimpleNamespace(config_snapshot=self.config, ability_state=initial_state(),
            turn_number=55, current_turn='alice', player_white='alice', player_black='bob',
            board_state={}, move_history=[], phase_bank={})
        self.ctx = AbilityContext(self.state)

    def put(self, key, kind='queen', color='white', hp=2, maximum=40):
        unit = {'unit_id': kind, 'color': color, 'uid': key, 'vet': 3,
                'hp': hp, 'max_hp': maximum}
        self.state.board_state[key] = unit
        return unit

    def test_leech_percentage_is_saved_and_rounded_per_strike_before_counters(self):
        queen = self.put('0,0')
        rook = self.put('1,0', 'rook', 'black', 40)
        entry = self.ctx.catalogue['queen-leech']
        entry['lifestealPercent'] = 50
        self.ctx.cast({'type': 'cast_ability', 'id': 'queen-leech', 'unitUid': queen['uid']})
        buff = self.ctx.data['buffs'].get(queen['uid'], {})
        self.assertEqual(buff.get('effects', [{}])[0].get('lifestealPercent'), 50)
        # A saved cast keeps its ratio even if a later preset is edited. Charge
        # heals on each initiating strike, with integer rounding before summing.
        entry['lifestealPercent'] = 0
        self.ctx.add_buff(queen, {'name': 'Charge', 'effect': 'charge'})
        restored = json.loads(json.dumps(self.ctx.data))
        result = exchange(queen, rook, 1, self.config, restored)
        self.assertEqual((result['damage'], result['counter_damage'], result['second_damage']), (9, 2, 9))
        self.assertEqual((result['leech_heal'], result['attacker_hp']), (8, 8))

    def test_leech_omission_zero_actual_damage_and_latest_effect(self):
        queen = self.put('0,0')
        rook = self.put('1,0', 'rook', 'black', 40)
        for percent, expected in [(None, 9), (0, 0), (33, 2), (100, 9)]:
            with self.subTest(percent=percent):
                effect = {'name': 'Leech', 'effect': 'leech'}
                if percent is not None:
                    effect['lifestealPercent'] = percent
                self.ctx.data['buffs'] = {}
                self.ctx.add_buff(queen, effect)
                result = exchange(queen, rook, 1, self.config, self.ctx.data, counters=False)
                self.assertEqual(result['leech_heal'], expected)
        self.ctx.data['buffs'] = {}
        self.ctx.add_buff(queen, {'name': 'Earlier', 'effect': 'leech', 'lifestealPercent': 25})
        self.ctx.add_buff(queen, {'name': 'Latest', 'effect': 'leech', 'lifestealPercent': 50})
        self.assertEqual(exchange(queen, rook, 1, self.config, self.ctx.data)['leech_heal'], 4)
        self.assertEqual(exchange(queen, {**rook, 'hp': 3}, 1, self.config, self.ctx.data)['leech_heal'], 1)
        self.assertEqual(exchange({**queen, 'hp': 39}, rook, 1, self.config, self.ctx.data)['leech_heal'], 1)
        counter = exchange(rook, {**queen, 'hp': 20}, 1, self.config, self.ctx.data)
        self.assertTrue(counter['countered'])
        self.assertEqual(counter['leech_heal'], 0)
        self.ctx.data['buffs'][queen['uid']]['effects'][0]['expiresAt'] = 61
        self.ctx.begin_turn('white', 57)
        self.assertEqual(exchange(queen, rook, 1, self.config, self.ctx.data)['leech_heal'], 2)

    def test_regeneration_percent_uses_maximum_hp_and_never_revives_or_heals_enemies(self):
        entry = self.ctx.catalogue['regenerate']
        for percent, expected in [(None, 11), (0, 2), (25, 4), (100, 11)]:
            with self.subTest(percent=percent):
                if percent is None:
                    entry.pop('healPercent', None)
                else:
                    entry['healPercent'] = percent
                self.put('0,0', 'bishop', maximum=11)
                self.put('1,0', 'bishop', 'black', maximum=11)
                self.put('2,0', 'bishop', hp=0, maximum=11)
                self.ctx.end_turn()
                self.assertEqual(self.ctx.board['0,0']['hp'], expected)
                self.assertEqual(self.ctx.board['1,0']['hp'], 2)
                self.assertEqual(self.ctx.board['2,0']['hp'], 0)

    def test_regeneration_uses_configured_maximum_when_a_saved_unit_omits_it(self):
        self.ctx.catalogue['regenerate']['healPercent'] = 25
        bishop = self.put('0,0', 'bishop')
        bishop.pop('max_hp')
        self.ctx.end_turn()
        self.assertEqual(self.ctx.board['0,0']['hp'], 12)

    def test_recharge_custom_floor_never_raises_cooldowns_and_refunds_before_reduction(self):
        self.ctx.data['paths']['white'] = 'tempo'
        self.ctx.data['loadouts']['white'] = ['warcry', 'sap']
        self.ctx.catalogue['warcry']['cost'] = 11
        self.ctx.catalogue['sap']['cost'] = 17
        entry = self.ctx.catalogue['recharge']
        entry.update(recharge=2, refundMultiplier=2)
        for floor in (None, 0, 2, 4):
            for first, second in [(0, 1), (1, 3), (4, 5)]:
                with self.subTest(floor=floor, cooldowns=(first, second)):
                    if floor is None:
                        entry.pop('minimumCooldown', None)
                    else:
                        entry['minimumCooldown'] = floor
                    limit = 1 if floor is None else floor
                    self.ctx.data['cooldowns']['white'] = {'warcry': first, 'sap': second}
                    self.ctx.data['uses'] = {}
                    self.ctx.data['pointDelta']['white'] = 0
                    self.ctx.cast({'type': 'cast_ability', 'id': 'recharge', 'pairId': 'sap'})
                    self.assertEqual([self.ctx.data['cooldowns']['white'][i] for i in ('warcry', 'sap')],
                        [max(limit, cd - 2) if cd > limit else cd for cd in (first, second)])
                    payout = (11 if first <= limit else 0) + (17 if second <= limit else 0)
                    self.assertEqual(self.ctx.data['pointDelta']['white'], 2 * payout)

    def test_unit_value_overrides_are_independent_and_zero_is_a_real_value(self):
        self.config['units']['pawn']['value'] = 17
        self.config['economy']['unitValues'] = {'pawn': {'bounty': 3, 'withdrawal': 5, 'wrap': 7, 'attrition': 11}}
        self.assertEqual(scoring.unit_value(self.config, 'pawn'), 17)
        for purpose, expected in [('bounty', 3), ('withdrawal', 5), ('wrap', 7), ('attrition', 11)]:
            with self.subTest(purpose=purpose):
                self.assertEqual(scoring.unit_value(self.config, 'pawn', purpose), expected)
                self.config['economy']['unitValues']['pawn'][purpose] = 0
                self.assertEqual(scoring.unit_value(self.config, 'pawn', purpose), 0)
                del self.config['economy']['unitValues']['pawn'][purpose]
                self.assertEqual(scoring.unit_value(self.config, 'pawn', purpose), 17)
        self.config['economy'].pop('unitValues')
        self.assertEqual(scoring.unit_value(self.config, 'pawn', 'bounty'), 17)

    def test_bounty_refund_and_attrition_follow_their_own_values_and_global_multipliers(self):
        self.config['economy'].update(upAtStart=0, killPayMultiplier=2,
            unitValues={'pawn': {'bounty': 3, 'withdrawal': 5, 'attrition': 7}})
        self.config['economy']['walkHomeRefund'] = {'valueMultiplier': 2, 'fee': 1,
            'missingHpMultiplier': 1, 'minimum': 0}
        self.config['scoring']['deathCostMultiplier'] = 3
        unit = {'unit_id': 'pawn', 'hp': 8, 'max_hp': 10, 'vet': 0}
        self.assertEqual(economy.withdrawal_refund(self.config, unit), 7)
        history = [{'turn': 7, 'color': 'white', 'captured': 'pawn', 'defender_eliminated': True},
                   {'turn': 8, 'color': 'black', 'unit_id': 'pawn', 'attacker_eliminated': True},
                   {'turn': 8, 'color': 'black', 'abilityDeath': {'unit_id': 'pawn', 'color': 'black'}}]
        self.assertEqual(economy.unit_points_of('white', history, self.config), 12)
        self.assertEqual(scoring.deaths_of(self.config, history, 'black'), 63)
        self.config['economy']['unitValues']['pawn'] = {'bounty': 0, 'withdrawal': 0, 'attrition': 0}
        self.assertEqual(economy.withdrawal_refund(self.config, unit), 0)
        self.assertEqual(economy.unit_points_of('white', history, self.config), 0)
        self.assertEqual(scoring.deaths_of(self.config, history, 'black'), 0)

    def test_wrap_uses_its_override_with_the_existing_gate_and_budget(self):
        self.config['setup']['white'] = {'-12,1': 'pawn'}
        self.config['units']['pawn'].update(value=17, move=6)
        self.config['economy'].update(wrapPriceMultiplier=2, unitValues={'pawn': {'wrap': 3}})
        options = panels.panel_move_targets(self.config, 11, [], {}, '-12,1', 7, 6)
        self.assertEqual(options.get('11,1'), {'cost': 1, 'price': 6})
        self.assertNotIn('11,1', panels.panel_move_targets(self.config, 11, [], {}, '-12,1', 7, 5))
        self.config['economy']['unitValues']['pawn']['wrap'] = 0
        self.assertEqual(panels.panel_move_targets(self.config, 11, [], {}, '-12,1', 7, 0)['11,1']['price'], 0)

    def test_saved_economy_overrides_do_not_inherit_later_preset_values(self):
        for values in (None, {}, {'pawn': {'bounty': 0}}, {'pawn': {'withdrawal': 0, 'wrap': 0, 'attrition': 0}}):
            with self.subTest(values=values):
                raw = copy.deepcopy(self.config)
                if values is None:
                    raw['economy'].pop('unitValues', None)
                else:
                    raw['economy']['unitValues'] = values
                with patch.dict(game_rules.DEFAULT['economy'], unitValues={'pawn': {'bounty': 99, 'wrap': 23}, 'rook': {'attrition': 10}}):
                    resolved = load_config(raw)
                    self.assertEqual(resolved['economy'], raw['economy'])
                    self.assertEqual(load_config(resolved), resolved)

    def test_optional_ability_knobs_validate_without_rewriting_saved_catalogues(self):
        for ability, field in [('queen-leech', 'lifestealPercent'), ('regenerate', 'healPercent'), ('recharge', 'minimumCooldown')]:
            for value in (None, 0, 50, 100):
                with self.subTest(ability=ability, value=value):
                    raw = copy.deepcopy(self.config)
                    if value is None:
                        raw['abilities']['catalogue'][ability].pop(field, None)
                    else:
                        raw['abilities']['catalogue'][ability][field] = value
                    resolved = load_config(raw)
                    self.assertEqual(resolved['abilities'], raw['abilities'])
                    self.assertEqual(load_config(resolved), resolved)
            for value in (-1, 1.5, True, None, 101) if field != 'minimumCooldown' else (-1, 1.5, True, None):
                with self.subTest(ability=ability, invalid=value):
                    raw = copy.deepcopy(self.config)
                    raw['abilities']['catalogue'][ability][field] = value
                    with self.assertRaises(ValueError):
                        load_config(raw)
            raw = copy.deepcopy(self.config)
            raw['abilities']['catalogue']['warcry'][field] = 50
            with self.assertRaises(ValueError):
                load_config(raw)
