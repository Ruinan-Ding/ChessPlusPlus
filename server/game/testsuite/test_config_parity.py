"""
The server's config validation against the cases the client is tested on too.

``client/src/app/services/config-parity.json`` holds edits to the shipped
config and the answer both validators owe them: ``load_config`` here, and
``validateGameRules`` in the client's ``config.service.spec.ts``. The setup
screen validates a config before it is sent, so anything it accepts that this
refuses is a room that will not start after a screen that said it would.

The cases were hand-written from what the two validators actually disagreed
on - an explicit null each side read differently, and two units on one hex.
"""
import copy
import json
import os

from django.test import SimpleTestCase

from game.engine.config_loader import DEFAULT_CONFIG, build_initial_board, load_config

FIXTURES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', '..',
    'client', 'src', 'app', 'services', 'config-parity.json')


def _edited(path, value=None, delete=False):
    """The shipped config with one key set - or, with *delete*, removed."""
    config = copy.deepcopy(DEFAULT_CONFIG)
    node = config
    for key in path[:-1]:
        node = node[key]
    if delete:
        node.pop(path[-1], None)
    else:
        node[path[-1]] = value
    return config


class ConfigParityTestCase(SimpleTestCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with open(FIXTURES, encoding='utf-8') as f:
            cls.fixtures = json.load(f)

    def test_non_object_configs_raise_value_error(self):
        for raw in ([], [1], True, False, 0, 1, '', 'text'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                load_config(raw)

    def test_boolean_radius_is_not_an_integer_even_with_a_valid_small_setup(self):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['setup'] = {'white': {'0,1': 'king'}, 'black': {'0,-1': 'king'}}
        config['board']['radius'] = 1
        build_initial_board(load_config(config))
        for radius in (True, False):
            config['board']['radius'] = radius
            with self.subTest(radius=radius), self.assertRaisesRegex(ValueError, 'board.radius'):
                load_config(config)

    def test_default_fallback_returns_an_independent_config(self):
        for raw in (None, {}):
            with self.subTest(raw=raw):
                config = load_config(raw)
                self.assertEqual(config, DEFAULT_CONFIG)
                config['units']['pawn']['hp'] += 1
                self.assertNotEqual(config['units']['pawn']['hp'], DEFAULT_CONFIG['units']['pawn']['hp'])

    def test_malformed_units_are_refused_when_objective_is_absent(self):
        for value in (None, [], True, 1, 'text'):
            config = _edited(['units', 'pawn'], value)
            del config['rules']['objective']
            with self.subTest(value=value), self.assertRaises(ValueError):
                load_config(config)

    def test_zero_pair_delay_and_older_radial_skills_remain_valid(self):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['abilities']['pairPickDelay'] = 0
        for ability in ('anchor', 'cleave', 'surge'):
            for field in ('area', 'splashRange', 'outerRange', 'outerAtk', 'outerHel', 'outerMov'):
                config['abilities']['catalogue'][ability].pop(field, None)
        config['abilities']['catalogue']['cleave'].pop('heal', None)
        build_initial_board(load_config(config))
        del config['abilities']['pairPickDelay']
        build_initial_board(load_config(config))

    def test_every_refused_edit_is_refused(self):
        for case in self.fixtures['refused']:
            with self.subTest(path=case['path'], value=case['value']):
                with self.assertRaises(ValueError):
                    load_config(_edited(case['path'], case['value']))

    def test_every_absent_field_takes_its_default(self):
        for path in self.fixtures['absent']:
            with self.subTest(path=path):
                build_initial_board(load_config(_edited(path, delete=True)))

    def test_two_kings_on_one_hex_are_refused_not_merged(self):
        # The review's case. Construction places black over white, so this
        # built a board holding black's king alone - white beaten before the
        # first move.
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['setup'] = {'white': {'0,0': 'king'}, 'black': {'0,0': 'king'}}
        with self.assertRaisesRegex(ValueError, 'one unit a hex'):
            load_config(config)

    def test_every_placement_of_the_shipped_setup_stands_on_the_board(self):
        config = load_config(copy.deepcopy(DEFAULT_CONFIG))
        board = build_initial_board(config).to_dict()
        on_board = [
            (color, key) for color in ('white', 'black')
            for key in config['setup'][color] if key in board]
        self.assertEqual(len(board), len(on_board))

    def test_integer_valued_json_floats_are_accepted_and_normalized_before_engine_use(self):
        for edit in self.fixtures['accepted']:
            with self.subTest(edit=edit):
                raw = _edited(edit['path'], edit['value'])
                config = load_config(raw)
                build_initial_board(config)
                node, original = config, raw
                for key in edit['path']:
                    node, original = node[key], original[key]
                self.assertEqual(node, edit['value'])
                self.assertIs(type(node), int)
                self.assertIs(type(original), float)
