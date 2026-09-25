"""
Unit tests for the game engine: board, config_loader, move_validator, game_logic.

These are plain Django TestCase tests that exercise the pure-Python engine
modules without needing WebSocket or async infrastructure.
"""

from django.test import TestCase
from typing import Any, Dict

from game.engine import economy, panels, phases
from game.engine.board import HexBoard, coord_key, parse_coord, hex_distance, HEX_DIRECTIONS
from game.engine.config_loader import (
    load_config,
    build_initial_board,
)
from game.engine.move_validator import (
    get_legal_moves,
    is_legal_move,
)
from game.engine.game_logic import (
    board_moves_at,
    MIN_STRIKE_DAMAGE,
    defeated_sides,
    find_defeated,
    overtime_toll,
    ranged_damage,
    resolve_combat,
    resolve_panel_attack,
    strike_damage,
    get_legal_moves_filtered,
    has_any_legal_move,
    detect_outcome,
    is_attacked,
)


# ---------------------------------------------------------------------------
# Board tests
# ---------------------------------------------------------------------------

class HexBoardTestCase(TestCase):
    """Tests for HexBoard basic operations."""

    def test_radius_1_has_7_hexes(self):
        board = HexBoard(1)
        self.assertEqual(board.total_hexes, 7)
        self.assertEqual(len(board.all_coords()), 7)

    def test_radius_5_has_91_hexes(self):
        board = HexBoard(5)
        self.assertEqual(board.total_hexes, 91)
        self.assertEqual(len(board.all_coords()), 91)

    def test_is_valid(self):
        board = HexBoard(2)
        self.assertTrue(board.is_valid(0, 0))
        self.assertTrue(board.is_valid(2, 0))
        self.assertTrue(board.is_valid(-1, 2))
        self.assertFalse(board.is_valid(3, 0))
        self.assertFalse(board.is_valid(2, 2))  # |q+r| = 4 > 2

    def test_set_get_remove(self):
        board = HexBoard(3)
        board.set(0, 0, 'king', 'white')
        piece = board.get(0, 0)
        assert piece is not None
        self.assertEqual(piece['unit_id'], 'king')
        self.assertEqual(piece['color'], 'white')

        removed = board.remove(0, 0)
        self.assertIsNotNone(removed)
        self.assertIsNone(board.get(0, 0))

    def test_move_basic(self):
        board = HexBoard(3)
        board.set(0, 0, 'rook', 'white')
        captured = board.move(0, 0, 1, 0)
        self.assertIsNone(captured)
        self.assertIsNone(board.get(0, 0))
        moved = board.get(1, 0)
        assert moved is not None
        self.assertEqual(moved['unit_id'], 'rook')

    def test_move_capture(self):
        board = HexBoard(3)
        board.set(0, 0, 'rook', 'white')
        board.set(1, 0, 'pawn', 'black')
        captured = board.move(0, 0, 1, 0)
        assert captured is not None
        self.assertEqual(captured['unit_id'], 'pawn')
        moved = board.get(1, 0)
        assert moved is not None
        self.assertEqual(moved['color'], 'white')

    def test_move_preserves_extra_cell_fields(self):
        """Moving a unit must not drop per-unit state the cell carries.

        Cells are open-ended: ability layers attach statuses, cooldowns and
        flags to them. Rebuilding the destination cell from only the four
        core fields would silently wipe all of that on every move.
        """
        board = HexBoard(3)
        board.set(0, 0, 'rook', 'white', hp=8, max_hp=10)
        cell = board.get(0, 0)
        assert cell is not None
        cell['statuses'] = [{'id': 'poison', 'remaining': 2}]
        cell['cooldowns'] = {'heal': 1}

        board.move(0, 0, 1, 0)

        moved = board.get(1, 0)
        assert moved is not None
        self.assertEqual(moved['statuses'], [{'id': 'poison', 'remaining': 2}])
        self.assertEqual(moved['cooldowns'], {'heal': 1})
        self.assertEqual(moved['hp'], 8)
        self.assertEqual(moved['max_hp'], 10)

    def test_serialisation_preserves_extra_cell_fields(self):
        board = HexBoard(3)
        board.set(0, 0, 'mage', 'black', hp=4, max_hp=6)
        cell = board.get(0, 0)
        assert cell is not None
        cell['statuses'] = [{'id': 'shielded', 'remaining': 1}]

        restored = HexBoard.from_dict(3, board.to_dict())

        r = restored.get(0, 0)
        assert r is not None
        self.assertEqual(r['statuses'], [{'id': 'shielded', 'remaining': 1}])
        self.assertEqual(r['hp'], 4)

    def test_set_cell_rejects_incomplete_cell(self):
        board = HexBoard(3)
        with self.assertRaises(ValueError):
            board.set_cell(0, 0, {'unit_id': 'rook'})
        with self.assertRaises(ValueError):
            board.set_cell(0, 0, {'color': 'white'})

    def test_set_cell_copies_input(self):
        """Stored cells must not alias the caller's dict."""
        board = HexBoard(3)
        source = {'unit_id': 'rook', 'color': 'white', 'hp': 5}
        board.set_cell(0, 0, source)
        source['hp'] = 99
        stored = board.get(0, 0)
        assert stored is not None
        self.assertEqual(stored['hp'], 5)

    def test_pieces_by_color(self):
        board = HexBoard(3)
        board.set(0, 0, 'king', 'white')
        board.set(1, 0, 'pawn', 'white')
        board.set(-1, 0, 'king', 'black')
        self.assertEqual(len(board.pieces_by_color('white')), 2)
        self.assertEqual(len(board.pieces_by_color('black')), 1)

    def test_serialisation_roundtrip(self):
        board = HexBoard(3)
        board.set(0, 0, 'king', 'white')
        board.set(1, -1, 'queen', 'black')
        data = board.to_dict()
        restored = HexBoard.from_dict(3, data)
        r1 = restored.get(0, 0)
        r2 = restored.get(1, -1)
        assert r1 is not None
        assert r2 is not None
        self.assertEqual(r1['unit_id'], 'king')
        self.assertEqual(r2['unit_id'], 'queen')

    def test_neighbours(self):
        nbrs = HexBoard.neighbours(0, 0)
        self.assertEqual(len(nbrs), 6)
        self.assertIn((1, 0), nbrs)
        self.assertIn((-1, 0), nbrs)

    def test_coord_key_parse_roundtrip(self):
        for q in range(-3, 4):
            for r in range(-3, 4):
                key = coord_key(q, r)
                pq, pr = parse_coord(key)
                self.assertEqual((pq, pr), (q, r))

    def test_parse_coord_rejects_malformed_input(self):
        for bad in (None, 5, "5", "a,b", "", "1,2,3"):
            with self.assertRaises(ValueError):
                parse_coord(bad)

    def test_hex_distance(self):
        self.assertEqual(hex_distance((0, 0), (0, 0)), 0)
        self.assertEqual(hex_distance((0, 0), (1, 0)), 1)
        self.assertEqual(hex_distance((0, 0), (2, -1)), 2)
        self.assertEqual(hex_distance((0, 0), (3, -3)), 3)


# ---------------------------------------------------------------------------
# Config loader tests
# ---------------------------------------------------------------------------

class ConfigLoaderTestCase(TestCase):
    """Tests for config loading and initial board building."""

    def test_default_config_loads(self):
        config = load_config(None)
        self.assertEqual(config['version'], '1.0')
        self.assertEqual(config['board']['radius'], 11)
        self.assertIn('king', config['units'])
        self.assertIn('pawn', config['units'])

    def test_every_default_unit_declares_an_attack_range(self):
        config = load_config(None)
        for unit_id, unit in config['units'].items():
            self.assertGreaterEqual(unit['attackRange'], 1, unit_id)

    def test_a_config_without_a_damage_floor_gets_the_current_default(self):
        """
        Absent means the current default, not the floor that was in force when
        the config was written.

        Filling in the old 0 instead would be the tempting choice - it keeps a
        room frozen before the floor existed playing the combat it started
        with - but nothing here can tell such a snapshot from a custom config
        authored today that simply did not mention the field, and that config
        would silently get the dead matchups the floor exists to remove.
        """
        import copy
        from game.engine.config_loader import DEFAULT_CONFIG
        raw = copy.deepcopy(DEFAULT_CONFIG)
        del raw['rules']['minStrikeDamage']
        loaded = load_config(raw)
        self.assertEqual(
            loaded['rules']['minStrikeDamage'],
            DEFAULT_CONFIG['rules']['minStrikeDamage'],
        )

    def test_the_counted_rules_default_when_absent_and_refuse_a_negative(self):
        """
        They were constants before they were config, so a config that predates
        them loads at the numbers every game was played under.
        """
        import copy
        from game.engine.config_loader import COUNTED_RULES, DEFAULT_CONFIG
        raw = copy.deepcopy(DEFAULT_CONFIG)
        for key in COUNTED_RULES:
            del raw['rules'][key]
        loaded = load_config(raw)
        self.assertEqual(
            {k: loaded['rules'][k] for k in COUNTED_RULES},
            {'panelMoversPerTurn': 3, 'postmatchEntries': 5,
             'homecomingsPerSetupTurn': 3, 'cpAtStart': 5, 'cpPhaseOffset': 5})
        for key in COUNTED_RULES:
            for value in (-1, 1.5, True, None):
                bad = copy.deepcopy(DEFAULT_CONFIG)
                bad['rules'][key] = value
                with self.assertRaises(ValueError, msg=f'{key}={value!r}'):
                    load_config(bad)

    def test_a_snapshot_under_the_old_postmatch_key_loads_at_the_default(self):
        """
        postmatchEntries was phaseInitEntries while the extra turn opened a
        phase instead of closing it, and nothing migrates the old key. That is
        only safe because the validator refuses no rule it does not know: a
        room frozen with the old key must still load, and read the new one at
        its default rather than at whatever the old one said.
        """
        import copy
        from game.engine.config_loader import DEFAULT_CONFIG, rule_of
        raw = copy.deepcopy(DEFAULT_CONFIG)
        del raw['rules']['postmatchEntries']
        raw['rules']['phaseInitEntries'] = 1
        loaded = load_config(raw)
        self.assertEqual(loaded['rules']['postmatchEntries'], 5)
        self.assertEqual(rule_of(loaded, 'postmatchEntries'), 5)
        # A room already playing is never loaded again: its config_snapshot is
        # read as it was stored, and that is the road a frozen room takes -
        # rule_of's fallback, not the normaliser's fill.
        self.assertNotIn('postmatchEntries', raw['rules'])
        self.assertEqual(rule_of(raw, 'postmatchEntries'), 5)

    def test_a_negative_damage_floor_is_rejected(self):
        """
        Checked because it corrupts the board rather than merely unbalancing
        it: strike_damage would return a negative number and deal_damage
        subtracts it, so a blow would heal whatever it hit.
        """
        import copy
        from game.engine.config_loader import DEFAULT_CONFIG
        bad = copy.deepcopy(DEFAULT_CONFIG)
        bad['rules']['minStrikeDamage'] = -1
        with self.assertRaises(ValueError):
            load_config(bad)

    def test_the_default_config_round_trips_and_still_deals_its_board(self):
        """The whole config goes through the real path, floor and all."""
        import copy
        from game.engine.config_loader import DEFAULT_CONFIG
        loaded = load_config(copy.deepcopy(DEFAULT_CONFIG))
        self.assertEqual(loaded['rules']['minStrikeDamage'], 1)
        board = build_initial_board(loaded)
        self.assertEqual(len(board.to_dict()), 48)

    def test_out_of_range_attack_range_is_rejected(self):
        import copy
        from game.engine.config_loader import DEFAULT_CONFIG
        bad = copy.deepcopy(DEFAULT_CONFIG)
        bad['units']['pawn']['attackRange'] = 0
        with self.assertRaises(ValueError):
            load_config(bad)

    def test_ranged_damage_falls_off_past_the_first_ring(self):
        config = load_config(None)
        # falloff 0.25: full damage adjacent, then -25% of the stat per ring,
        # floored, and a hit that lands always takes off at least 1.
        self.assertEqual(ranged_damage(8, 1, config), 8)
        self.assertEqual(ranged_damage(8, 2, config), 6)
        self.assertEqual(ranged_damage(8, 3, config), 4)
        self.assertEqual(ranged_damage(1, 5, config), 1)
        self.assertEqual(ranged_damage(0, 1, config), 0)

    def test_default_config_is_deep_copy(self):
        c1 = load_config(None)
        c2 = load_config(None)
        c1['board']['radius'] = 99
        self.assertEqual(c2['board']['radius'], 11)

    def test_build_initial_board_piece_count(self):
        config = load_config(None)
        board = build_initial_board(config)
        self.assertEqual(len(board.pieces_by_color('white')), 24)
        self.assertEqual(len(board.pieces_by_color('black')), 24)

    @staticmethod
    def _king_hex(config, color):
        """Where the setup puts a side's king.

        Looked up rather than written down: the opening line-up is the owner's
        to rearrange, and it has moved more than once. What matters is that a
        king is dealt, not which hex it lands on.
        """
        placement = config['setup'][color]
        key = next(k for k, unit in placement.items() if unit == 'king')
        q, r = (int(part) for part in key.split(','))
        return q, r

    def test_build_initial_board_has_kings(self):
        config = load_config(None)
        board = build_initial_board(config)
        # Check directly that king units exist on the board
        white_king_cell = board.get(*self._king_hex(config, 'white'))
        black_king_cell = board.get(*self._king_hex(config, 'black'))
        assert white_king_cell is not None
        assert black_king_cell is not None
        self.assertEqual(white_king_cell['unit_id'], 'king')
        self.assertEqual(white_king_cell['color'], 'white')
        self.assertEqual(black_king_cell['unit_id'], 'king')
        self.assertEqual(black_king_cell['color'], 'black')

    def test_build_initial_board_units_have_hp(self):
        config = load_config(None)
        board = build_initial_board(config)
        white_king = board.get(*self._king_hex(config, 'white'))
        assert white_king is not None
        self.assertIn('hp', white_king)
        self.assertIn('max_hp', white_king)
        self.assertGreater(white_king['hp'], 0)
        self.assertEqual(white_king['hp'], white_king['max_hp'])

    def test_invalid_config_raises(self):
        with self.assertRaises(ValueError):
            load_config({'board': {'radius': 0}})  # missing version, bad radius

    def test_custom_config_accepted(self):
        custom = {
            'version': '1.0',
            'board': {'radius': 3},
            'units': {
                'king': {'id': 'king', 'name': 'K', 'symbol': 'K',
                         'movement': [{'direction': 'E', 'range': 1}], 'value': 0,
                         'defense': 0, 'commander': True}
            },
            'abilities': {},
            'setup': {
                'white': {'0,3': 'king'},
                'black': {'0,-3': 'king'}
            },
            'rules': {'maxTurns': 0, 'turnTimeLimit': 0}
        }
        config = load_config(custom)
        board = build_initial_board(config)
        self.assertEqual(board.radius, 3)
        self.assertEqual(len(board.to_dict()), 2)

    def test_regicide_config_without_a_commander_is_rejected(self):
        """find_defeated() declares a commander-less side beaten on the first
        move, so a config that cannot satisfy its own objective must not
        load in the first place."""
        custom = {
            'version': '1.0',
            'board': {'radius': 3},
            'units': {'pawn': {'id': 'pawn', 'name': 'P', 'symbol': 'P',
                               'value': 1, 'hp': 5, 'attack': 2, 'defense': 1}},
            'abilities': {},
            'setup': {'white': {'0,3': 'pawn'}, 'black': {'0,-3': 'pawn'}},
            'rules': {'objective': 'regicide'},
        }
        with self.assertRaises(ValueError):
            load_config(custom)

        # The same board is fine when the objective does not need one.
        custom['rules'] = {'objective': 'elimination'}
        self.assertEqual(len(build_initial_board(load_config(custom)).to_dict()), 2)

    def test_a_config_written_before_these_fields_still_loads(self):
        """Rooms hold configs saved by older builds. Requiring `defense` and
        defaulting `objective` to regicide made every one of them permanently
        unloadable - the room could never start again."""
        old = {
            'version': '1.0',
            'board': {'radius': 3},
            'units': {'king': {'id': 'king', 'name': 'K', 'symbol': 'K',
                               'value': 0, 'hp': 20, 'attack': 5, 'commander': True}},
            'abilities': {},
            'setup': {'white': {'0,3': 'king'}, 'black': {'0,-3': 'king'}},
            'rules': {'maxTurns': 0, 'turnTimeLimit': 0},
        }
        config = load_config(old)
        self.assertEqual(config['units']['king']['defense'], 0)
        # It has commanders on both sides, so regicide is what it was played as.
        self.assertEqual(config['rules']['objective'], 'regicide')

        # One without a commander anywhere never meant regicide.
        old['units'] = {'pawn': {'id': 'pawn', 'name': 'P', 'symbol': 'P',
                                 'value': 1, 'hp': 5, 'attack': 2}}
        old['setup'] = {'white': {'0,3': 'pawn'}, 'black': {'0,-3': 'pawn'}}
        self.assertEqual(load_config(old)['rules']['objective'], 'elimination')

    def test_malformed_rules_is_a_config_error_not_a_crash(self):
        """`config.get('rules', {})` hands back None for an explicit null, and
        every read off it raised AttributeError straight through handlers that
        only catch ValueError - an INTERNAL_ERROR traceback for a bad paste."""
        import copy
        from game.engine.config_loader import DEFAULT_CONFIG
        bad = copy.deepcopy(DEFAULT_CONFIG)
        bad['rules'] = None
        with self.assertRaises(ValueError):
            load_config(bad)

    def test_units_carry_an_identity_that_survives_a_move(self):
        """Per-unit state hangs off `uid`; if a move dropped it, veterancy and
        boosts would silently jump to whoever stands on the hex next."""
        board = build_initial_board(load_config())
        q = r = 0
        dest = None
        for (q, r), cell in board.pieces_by_color('white').items():
            dest = next((c for c in board.valid_neighbours(q, r) if board.get(*c) is None), None)
            if dest:
                break
        self.assertIsNotNone(dest, "no white unit had anywhere to step")
        uid = board.get(q, r)['uid']
        self.assertTrue(uid)

        board.move(q, r, *dest)
        self.assertEqual(board.get(*dest)['uid'], uid)

        # ... and across the wire, both ways.
        again = HexBoard.from_dict(board.radius, board.to_dict())
        self.assertEqual(again.get(*dest)['uid'], uid)


# ---------------------------------------------------------------------------
# Move validator tests
# ---------------------------------------------------------------------------

class MoveValidatorTestCase(TestCase):
    """
    Tests for movement: a flood fill through the six hex neighbours, bounded
    by the unit's `move` stat. Blocked entirely by any occupied hex (own or
    enemy) - units cannot pass through each other.
    """

    def _make_board(self, radius: int = 5) -> HexBoard:
        return HexBoard(radius)

    def _cfg(self, move: int = 6) -> Dict[str, Any]:
        return {'units': {'unit': {'move': move}}}

    def test_one_step_from_centre_is_six_neighbours(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(move=1), 'white')
        self.assertEqual(len(moves), 6)
        for m in moves:
            self.assertEqual(hex_distance((0, 0), m), 1)

    def test_reaches_every_hex_within_move_range(self):
        """On an open board, legal moves == every hex within hex_distance <= move."""
        board = self._make_board(radius=5)
        board.set(0, 0, 'unit', 'white')
        moves = set(get_legal_moves(board, (0, 0), self._cfg(move=6), 'white'))
        expected = {c for c in board.all_coords() if c != (0, 0)}
        self.assertEqual(moves, expected)

    def test_move_bonus_lends_extra_steps(self):
        """An ability's +MOV has to reach the validator, or the move it let the
        player stage on the client comes straight back as illegal."""
        board = self._make_board(radius=5)
        board.set(0, 0, 'unit', 'white')
        cfg = self._cfg(move=2)

        self.assertNotIn((4, 0), get_legal_moves(board, (0, 0), cfg, 'white'))
        boosted = get_legal_moves(board, (0, 0), cfg, 'white', move_bonus=2)
        self.assertIn((4, 0), boosted)
        for m in boosted:
            self.assertLessEqual(hex_distance((0, 0), m), 4)

    def test_move_range_stops_short(self):
        board = self._make_board(radius=5)
        board.set(0, 0, 'unit', 'white')
        moves = set(get_legal_moves(board, (0, 0), self._cfg(move=2), 'white'))
        for m in moves:
            self.assertLessEqual(hex_distance((0, 0), m), 2)
        self.assertIn((2, 0), moves)
        self.assertNotIn((3, 0), moves)

    def test_walks_through_its_own(self):
        """An ally costs a step to pass but is not somewhere to stop.

        It used to block both, which meant a side's own line hemmed it in -
        the owner's rule is that only the hex a unit would END on has to be
        free.
        """
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        board.set(1, 0, 'pawn', 'white')  # a friend directly in the way
        moves = get_legal_moves(board, (0, 0), self._cfg(move=2), 'white')
        self.assertNotIn((1, 0), moves)  # still no landing on it
        self.assertIn((2, 0), moves)     # but the way past it is open

        # And passing costs its step like any other: with one to spend, the
        # hex beyond the friend is out of reach.
        short = get_legal_moves(board, (0, 0), self._cfg(move=1), 'white')
        self.assertNotIn((2, 0), short)

    def test_blocked_by_enemy_piece(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        board.set(1, 0, 'pawn', 'black')
        moves = get_legal_moves(board, (0, 0), self._cfg(move=2), 'white')
        self.assertNotIn((1, 0), moves)  # movement never lands on an enemy
        self.assertNotIn((2, 0), moves)  # or passes through one

    def test_can_route_around_a_blocker_with_enough_moves(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        board.set(1, 0, 'pawn', 'black')  # blocks the direct 2-step line to (2,0)
        # Two moves isn't enough to detour around a blocker on the direct line...
        moves2 = get_legal_moves(board, (0, 0), self._cfg(move=2), 'white')
        self.assertNotIn((2, 0), moves2)
        # ...but three is, going around instead of through.
        moves3 = get_legal_moves(board, (0, 0), self._cfg(move=3), 'white')
        self.assertIn((2, 0), moves3)

    def test_stops_at_board_edge(self):
        board = self._make_board(radius=2)
        board.set(0, 0, 'unit', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(move=6), 'white')
        for m in moves:
            self.assertTrue(board.is_valid(*m))
        self.assertEqual(len(moves), board.total_hexes - 1)

    def test_zero_move_returns_no_moves(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(move=0), 'white')
        self.assertEqual(moves, [])

    def test_empty_square_returns_no_moves(self):
        board = self._make_board()
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertEqual(moves, [])

    def test_wrong_color_returns_no_moves(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'black')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertEqual(moves, [])

    def test_is_legal_move_helper(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        self.assertTrue(is_legal_move(board, (0, 0), (1, 0), self._cfg(move=1), 'white'))
        self.assertFalse(is_legal_move(board, (0, 0), (3, 0), self._cfg(move=1), 'white'))

    def test_default_config_units_declare_a_move(self):
        """Every unit in DEFAULT_CONFIG carries its own move budget.

        This used to pin every unit to 6, which was true only while the roster
        was six identical placeholders. The shieldman is deliberately slower,
        so what is worth guarding is that movement is a per-unit stat and that
        none of them is accidentally left without one.
        """
        config = load_config(None)
        for unit_id, unit_def in config['units'].items():
            move = unit_def.get('move')
            self.assertIsInstance(move, int, unit_id)
            self.assertGreater(move, 0, unit_id)
        self.assertEqual(config['units']['shieldman']['move'], 5)
        self.assertEqual(config['units']['pawn']['move'], 6)


# ---------------------------------------------------------------------------
# Game logic tests
# ---------------------------------------------------------------------------

class GameLogicTestCase(TestCase):
    """Tests for combat resolution, is_attacked, and elimination detection."""

    def _cfg(self) -> Dict[str, Any]:
        return load_config(None)

    # -- Combat resolution -------------------------------------------------

    def test_resolve_combat_move_to_empty(self):
        """Moving to an empty hex is a simple relocation."""
        board = HexBoard(5)
        board.set(0, 0, 'king', 'white', hp=10, max_hp=10)
        config = self._cfg()
        result = resolve_combat(board, (0, 0), (1, 0), config)
        self.assertTrue(result['moved'])
        self.assertFalse(result['attacked'])
        self.assertEqual(result['damage_dealt'], 0)
        self.assertIsNone(board.get(0, 0))  # vacated
        self.assertIsNotNone(board.get(1, 0))  # moved here

    def test_losing_the_commander_loses_the_game(self):
        """Default objective is regicide: no king, no game."""
        board = HexBoard(5)
        board.set(0, 0, 'king', 'white', hp=45, max_hp=45)
        board.set(1, 0, 'pawn', 'white', hp=20, max_hp=20)
        board.set(3, 0, 'king', 'black', hp=45, max_hp=45)
        config = self._cfg()
        self.assertIsNone(find_defeated(board, config))

        board.remove(0, 0)
        self.assertEqual(find_defeated(board, config), 'white')

    def test_elimination_objective_ignores_the_commander(self):
        board = HexBoard(5)
        board.set(1, 0, 'pawn', 'white', hp=20, max_hp=20)
        board.set(3, 0, 'king', 'black', hp=45, max_hp=45)
        config = self._cfg()
        config['rules']['objective'] = 'elimination'

        # White has no king but still has a unit, so it is not out yet.
        self.assertIsNone(find_defeated(board, config))
        board.remove(1, 0)
        self.assertEqual(find_defeated(board, config), 'white')

    def test_counter_attack_can_defeat_the_attacker(self):
        """The side that lost is the side whose king died, not the side that moved."""
        board = HexBoard(5)
        board.set(0, 0, 'king', 'white', hp=2, max_hp=45)
        board.set(1, 0, 'rook', 'black', hp=40, max_hp=40)
        board.set(3, 0, 'king', 'black', hp=45, max_hp=45)
        config = self._cfg()

        result = resolve_combat(board, (0, 0), (1, 0), config)

        self.assertTrue(result['attacker_eliminated'])
        self.assertEqual(find_defeated(board, config), 'white')

    def test_both_sides_can_fall_in_one_exchange(self):
        """A mutual kill is a draw, not a win for whichever side sorts first."""
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=20, max_hp=20)
        board.set(1, 0, 'pawn', 'black', hp=20, max_hp=20)
        config = self._cfg()
        config['rules']['objective'] = 'regicide'

        # Neither side has a commander, so both are beaten at once.
        self.assertEqual(defeated_sides(board, config), ['white', 'black'])
        # find_defeated still answers with one, for callers that only ask
        # whether the game is over.
        self.assertEqual(find_defeated(board, config), 'white')

    def test_resolve_combat_attack_eliminates(self):
        """A kill leaves the attacker where it stood - attacking is not a move."""
        board = HexBoard(5)
        board.set(0, 0, 'queen', 'white', hp=30, max_hp=30)
        board.set(1, 0, 'pawn', 'black', hp=5, max_hp=20)
        config = self._cfg()
        expected = config['units']['queen']['attack'] - config['units']['pawn']['defense']

        result = resolve_combat(board, (0, 0), (1, 0), config)

        self.assertTrue(result['attacked'])
        self.assertTrue(result['defender_eliminated'])
        self.assertFalse(result['moved'])
        self.assertEqual(result['damage_dealt'], expected)
        self.assertEqual(result['counter_damage'], 0)  # the dead do not swing back
        self.assertIsNone(board.get(1, 0))
        attacker = board.get(0, 0)
        assert attacker is not None
        self.assertEqual(attacker['unit_id'], 'queen')

    def test_resolve_combat_defender_survives_and_counters(self):
        """Damage is attack minus defence, and the survivor hits back the same way."""
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=20, max_hp=20)
        board.set(1, 0, 'rook', 'black', hp=40, max_hp=40)
        config = self._cfg()
        units = config['units']
        dealt = units['pawn']['attack'] - units['rook']['defense']
        countered = units['rook']['attack'] - units['pawn']['defense']

        result = resolve_combat(board, (0, 0), (1, 0), config)

        self.assertFalse(result['defender_eliminated'])
        self.assertFalse(result['moved'])
        self.assertEqual(result['damage_dealt'], dealt)
        self.assertEqual(result['defender_hp'], 40 - dealt)
        self.assertEqual(result['counter_damage'], countered)
        self.assertEqual(result['attacker_hp'], 20 - countered)
        self.assertFalse(result['attacker_eliminated'])

    def test_counter_attack_can_kill_the_attacker(self):
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=2, max_hp=20)
        board.set(1, 0, 'rook', 'black', hp=40, max_hp=40)

        result = resolve_combat(board, (0, 0), (1, 0), self._cfg())

        self.assertTrue(result['attacker_eliminated'])
        self.assertIsNone(board.get(0, 0))
        self.assertIsNotNone(board.get(1, 0))

    def test_no_counter_from_outside_the_defenders_reach(self):
        """A bishop reaches three rings; a pawn cannot answer from two."""
        board = HexBoard(5)
        board.set(0, 0, 'bishop', 'white', hp=22, max_hp=22)
        board.set(2, 0, 'pawn', 'black', hp=20, max_hp=20)
        config = self._cfg()

        result = resolve_combat(board, (0, 0), (2, 0), config)

        self.assertTrue(result['attacked'])
        self.assertEqual(result['counter_damage'], 0)
        self.assertEqual(result['attacker_hp'], 22)

    def test_armour_blunts_a_hit_but_never_turns_it_aside(self):
        """
        Defence above the attack stat floors at MIN_STRIKE_DAMAGE, not at 0.

        This used to assert 0, and the owner's report was that "some shit
        simply doesn't seem to take any hit": a pawn (14 attack) against a
        king (15 defence) came to -1 and floored to nothing, so the pair could
        trade blows all game and neither would ever move. A blow that lands
        always takes something off now.
        """
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=20, max_hp=20)
        board.set(1, 0, 'king', 'black', hp=45, max_hp=45)  # defence 15 > pawn attack 14

        result = resolve_combat(board, (0, 0), (1, 0), self._cfg())

        self.assertEqual(result['damage_dealt'], MIN_STRIKE_DAMAGE)
        self.assertEqual(result['defender_hp'], 45 - MIN_STRIKE_DAMAGE)

    def test_the_damage_floor_is_a_dial_the_config_turns(self):
        """
        `rules.minStrikeDamage` decides whether armour can absorb a hit whole.

        It lives in the config rather than in a constant on each side so the
        browser and the server cannot drift: a client flooring at 1 against a
        server flooring at 0 disagrees about who is still standing.
        """
        attacker = {'attack': 14}
        defender = {'defense': 18}
        self.assertEqual(
            strike_damage(attacker, defender, 1, {'rules': {'minStrikeDamage': 1}}), 1)
        # 0 is the old rule, and still reachable for anyone who wants it back.
        self.assertEqual(
            strike_damage(attacker, defender, 1, {'rules': {'minStrikeDamage': 0}}), 0)
        # A bigger floor is honoured too - it is a dial, not a flag.
        self.assertEqual(
            strike_damage(attacker, defender, 1, {'rules': {'minStrikeDamage': 5}}), 5)
        # But never more than the attacker could deal unblunted. The floor
        # lifts a hit armour absorbed; it is not a damage source of its own,
        # and an unclamped one would override the attack stat outright - every
        # blow dealing the floor whatever the attack, defence or falloff, which
        # makes all three dead config. 14 attack caps at 14.
        self.assertEqual(
            strike_damage(attacker, defender, 1, {'rules': {'minStrikeDamage': 9999}}), 14)

    def test_an_attack_of_nothing_stays_nothing(self):
        """
        The floor lifts a blow that was blunted, not one that was never
        thrown. Without this guard a unit with no attack at all would chip a
        point off whatever it touched.
        """
        config = {'units': {'unarmed': {'attack': 0}, 'target': {'defense': 5}}}
        self.assertEqual(
            strike_damage(config['units']['unarmed'], config['units']['target'], 1, config),
            0,
        )

    # -- is_attacked --------------------------------------------------------

    def test_is_attacked_within_move_range(self):
        board = HexBoard(5)
        board.set(0, 0, 'queen', 'white')  # move=6 in DEFAULT_CONFIG
        config = self._cfg()
        self.assertTrue(is_attacked(board, (5, 0), 'white', config))
        self.assertTrue(is_attacked(board, (1, 1), 'white', config))

    def test_not_attacked_beyond_move_range(self):
        board = HexBoard(8)
        board.set(0, 0, 'pawn', 'white')  # move=6
        config = self._cfg()
        self.assertFalse(is_attacked(board, (7, 0), 'white', config))

    # -- Legal moves (no self-check filter in tactical mode) ---------------

    def test_legal_moves_no_pin_restriction(self):
        """In tactical RPG mode, there is no pin - pieces move freely."""
        board = HexBoard(5)
        board.set(0, 0, 'king', 'white', hp=10, max_hp=10)
        board.set(1, 0, 'rook', 'white', hp=12, max_hp=12)
        board.set(4, 0, 'rook', 'black', hp=12, max_hp=12)
        config = self._cfg()

        moves = get_legal_moves_filtered(board, (1, 0), config, 'white')
        # The rook should be able to move off the E/W axis freely
        off_axis = [m for m in moves if m[1] != 0]
        self.assertGreater(len(off_axis), 0, "Rook should move freely - no pins")

    # -- Elimination detection ---------------------------------------------

    def test_elimination_when_all_removed(self):
        """If one side has 0 pieces, detect_outcome returns 'elimination'."""
        board = HexBoard(5)
        board.set(0, 0, 'king', 'white', hp=10, max_hp=10)
        # No black pieces at all
        config = self._cfg()
        outcome = detect_outcome(board, 'black', config)
        self.assertEqual(outcome, 'elimination')

    def test_no_elimination_both_sides_alive(self):
        """Game continues when both sides have pieces."""
        config = self._cfg()
        board = build_initial_board(config)
        outcome = detect_outcome(board, 'white', config)
        self.assertIsNone(outcome)

    def test_has_any_legal_move_opening(self):
        config = self._cfg()
        board = build_initial_board(config)
        self.assertTrue(has_any_legal_move(board, 'white', config))
        self.assertTrue(has_any_legal_move(board, 'black', config))


# ---------------------------------------------------------------------------
# Panels
# ---------------------------------------------------------------------------

class DealtPanels:
    """
    Deal the panel squads for the duration of a test.

    A new game now opens with all four panels empty while the owner clears the
    placeholder squads out (``panels.PANELS_DEALT``). Everything that *works* a
    panel is still here and still has to be right for the day they come back -
    the walk, the wrap, the crossing, the blow into a panel, the walk home, and
    the windows and allowances that govern all of them - so these turn the deal
    back on rather than going away. Turning them off instead would leave the
    rules untested exactly while they are being changed.

    Mix in before the test case: ``class Foo(DealtPanels, TestCase)``.
    """

    def setUp(self):
        super().setUp()
        self._dealt_was = panels.PANELS_DEALT
        panels.PANELS_DEALT = True

    def tearDown(self):
        panels.PANELS_DEALT = self._dealt_was
        super().tearDown()


class PanelsTestCase(DealtPanels, TestCase):
    """
    The four off-battlefield panels, which the server has never known about.

    Every number pinned here is one the CLIENT already produces - these are not
    the server's choices, they are the contract the browser and the server have
    to agree on before a crossing can be validated rather than trusted. If the
    client's geometry or its deal changes, these fail, which is the point.
    """

    def _cfg(self):
        return load_config(None)

    def test_the_panels_join_the_board_where_the_client_says(self):
        """Gateways, base doorways and wrap tips, on the shipped radius 11."""
        radius = 11
        # Out of the reserve onto the battlefield: the three hexes nearest that
        # player's own edge, satisfying q + r == radius + 1.
        self.assertEqual(
            sorted(panels.gateway_hexes(radius)),
            sorted(['3,9', '2,10', '1,11', '-3,-9', '-2,-10', '-1,-11']),
        )
        # Off the battlefield back into the base, the other way about.
        self.assertEqual(
            sorted(panels.base_gateway_hexes(radius)),
            sorted(['-12,11', '-12,10', '-12,9', '12,-11', '12,-10', '12,-9']),
        )
        # The wrap joins a side's own base to its own reserve, far left to far
        # right of one row. Nothing hard-coded: both come off the radius.
        self.assertEqual(
            panels.wrap_tips('white', radius), {'base': '-12,1', 'reserve': '11,1'})
        self.assertEqual(
            panels.wrap_tips('black', radius), {'base': '12,-1', 'reserve': '-11,-1'})

    def test_a_base_is_bl_and_tr_and_the_others_are_reserves(self):
        """
        Which panel is a base is not cosmetic: a base mends its wounded and
        never counter-attacks, and a reserve does neither.
        """
        self.assertTrue(panels.is_base('bl'))       # white's base
        self.assertTrue(panels.is_base('tr'))       # black's base
        self.assertFalse(panels.is_base('br'))      # white's reserve
        self.assertFalse(panels.is_base('tl'))      # black's reserve
        self.assertFalse(panels.is_base(None))
        # Bottom is white's pair, top is black's.
        self.assertEqual(panels.color_of_panel('bl'), 'white')
        self.assertEqual(panels.color_of_panel('br'), 'white')
        self.assertEqual(panels.color_of_panel('tl'), 'black')
        self.assertEqual(panels.color_of_panel('tr'), 'black')

    def test_the_deal_is_five_non_commanders_in_every_panel(self):
        """
        The commander belongs on the board - losing it is how a side loses - so
        it is never dealt into a panel.
        """
        config = self._cfg()
        roster = [unit_id for unit_id, _ in panels.panel_roster(config)]
        self.assertEqual(len(roster), 5)
        self.assertNotIn('king', roster)

        dealt = panels.deal_panels(config, config['board']['radius'])
        self.assertEqual(len(dealt), 20)        # five a panel, four panels
        # The uid is deterministic - panel plus roster index - which is what
        # lets the client re-deal after a reload and get the same units back,
        # and what lets the server derive the panels with nothing persisted.
        self.assertEqual(
            sorted(u['uid'] for u in dealt.values()),
            sorted(f"r{panel}{i}" for panel in ('bl', 'br', 'tl', 'tr') for i in range(5)),
        )

    def test_the_two_sides_are_dealt_point_mirrors_of_each_other(self):
        """
        Black's panels are walked backwards so both sides get shapes with
        identical reach. White's base mirrors black's base, hex for hex.
        """
        config = self._cfg()
        dealt = panels.deal_panels(config, config['board']['radius'])
        by_uid = {u['uid']: at for at, u in dealt.items()}
        for i in range(5):
            for mine, theirs in (('bl', 'tr'), ('br', 'tl')):
                wq, wr = (int(n) for n in by_uid[f"r{mine}{i}"].split(','))
                bq, br = (int(n) for n in by_uid[f"r{theirs}{i}"].split(','))
                self.assertEqual((wq, wr), (-bq, -br))

    def test_the_deal_keeps_the_wrap_corridor_clear(self):
        """
        Each wrap tip is a cul-de-sac with one panel hex leading in, so a squad
        dealt across it would block its own crossing.
        """
        config = self._cfg()
        radius = config['board']['radius']
        dealt = panels.deal_panels(config, radius)
        for color in ('white', 'black'):
            for hex_key in panels.wrap_corridor(color, radius):
                self.assertNotIn(hex_key, dealt)

    def test_a_wounded_unit_is_dealt_wounded_and_a_dead_one_not_at_all(self):
        """Killed in a panel is killed; the deal does not bring it back."""
        config = self._cfg()
        radius = config['board']['radius']
        full = panels.deal_panels(config, radius)
        hurt = panels.deal_panels(config, radius, panel_hp={'rbl0': 3, 'rbr0': 0})

        self.assertEqual(len(hurt), len(full) - 1)
        alive = {u['uid']: u for u in hurt.values()}
        self.assertEqual(alive['rbl0']['hp'], 3)
        self.assertNotIn('rbr0', alive)

    def test_the_record_is_the_only_place_a_panel_units_hp_survives(self):
        """
        No board holds a panel unit, so a blow into one is remembered by its
        record or not at all.
        """
        history = [
            {'intoPanel': True, 'unit': {'uid': 'rbl0'}, 'defenderHp': 12, 'turn': 4},
            {'intoPanel': True, 'unit': {'uid': 'rbl0'}, 'defenderHp': 5, 'turn': 8},
            {'intoPanel': True, 'unit': {'uid': 'rbr1'}, 'defenderHp': 0, 'turn': 9},
            {'from': '0,0', 'to': '1,0'},                       # an ordinary walk
            {'intoPanel': True, 'unit': {}, 'defenderHp': 7},    # no uid, no word
        ]
        self.assertEqual(
            panels.recorded_panel_hp(history), {'rbl0': 5, 'rbr1': 0})

    def test_a_unit_that_crossed_is_not_dealt_back_into_its_panel(self):
        """
        A panel keeps its squad for the whole game, so without this a unit that
        crossed and was later killed would reappear at home, ready to cross
        again - the board it died on no longer names it.
        """
        config = self._cfg()
        radius = config['board']['radius']
        history = [{'entered': True, 'unit': {'uid': 'rbr0'}}]
        self.assertEqual(panels.departed_uids(history), frozenset({'rbr0'}))

        standing = panels.panel_occupancy(config, radius, history)
        self.assertNotIn('rbr0', {u['uid'] for u in standing.values()})
        self.assertEqual(len(standing), 19)

    def test_a_unit_that_walked_home_stands_in_its_base(self):
        """
        A withdrawal is kept by uid, not by the hex it landed on: keying by hex
        would have a second unit coming home quietly erase the first.
        """
        config = self._cfg()
        radius = config['board']['radius']
        walked = {'uid': 'w3,9', 'unit_id': 'pawn', 'color': 'white', 'hp': 9, 'max_hp': 20}
        history = [
            {'withdrawn': True, 'unit': walked, 'to': '-12,11', 'turn': 6},
            # A blow that found it at home moves its last word on.
            {'intoPanel': True, 'unit': {'uid': 'w3,9'}, 'defenderHp': 4, 'turn': 10},
        ]
        home = panels.withdrawn_units(history)
        self.assertEqual(home['w3,9']['at'], '-12,11')
        self.assertEqual(home['w3,9']['hp'], 4)
        self.assertEqual(home['w3,9']['turn'], 10)

        standing = panels.panel_occupancy(config, radius, history)
        self.assertEqual(standing['-12,11']['uid'], 'w3,9')
        self.assertEqual(standing['-12,11']['hp'], 4)
        # It landed in white's base, and the base is what mends it.
        self.assertTrue(panels.is_base(standing['-12,11']['panel']))

    def test_a_unit_killed_where_it_stood_at_home_is_not_drawn(self):
        """Killed in a panel is killed - not mended back to life."""
        walked = {'uid': 'w3,9', 'unit_id': 'pawn', 'color': 'white', 'hp': 9}
        history = [
            {'withdrawn': True, 'unit': walked, 'to': '-12,11', 'turn': 6},
            {'intoPanel': True, 'unit': {'uid': 'w3,9'}, 'defenderHp': 0, 'turn': 10},
        ]
        self.assertEqual(panels.withdrawn_units(history), {})

    # -- walking, and stepping out --------------------------------------

    def test_a_unit_walks_through_its_own_but_never_through_an_enemy(self):
        """
        An ally costs a step to pass but is not somewhere to stop, so it never
        limits the reach beyond it. An enemy blocks the hex AND the way past.
        The crossings need the distinction: a friend on a gateway is walked
        past, not walked into.
        """
        config = self._cfg()
        units = {
            '0,0': {'unit_id': 'queen', 'color': 'white'},
            '1,0': {'unit_id': 'pawn', 'color': 'white'},     # ours, passable
            '0,1': {'unit_id': 'pawn', 'color': 'black'},     # theirs, a wall
        }
        costs, passable = panels.move_costs(units, 0, 0, config, 11, 3)

        self.assertNotIn('1,0', costs)        # cannot stop on a friend
        self.assertEqual(passable['1,0'], 1)  # but may pass it
        self.assertIn('2,0', costs)           # and the reach carries on beyond
        self.assertNotIn('0,1', costs)        # the enemy hex itself
        self.assertNotIn('0,1', passable)     # and no passing through it
        # The hex behind the enemy is still reachable - six directions, so a
        # single blocker walls off a path, never a destination. What it costs
        # is the proof: three steps the long way round, where straight through
        # would have been two.
        self.assertEqual(costs['0,2'], 3)

    def test_a_crossing_is_the_walk_to_the_gap_plus_one_step_through(self):
        """
        Reaching a gateway is an ordinary walk through the panel, so stepping
        through the gap costs one on top of getting there.
        """
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()
        by_uid = {u['uid']: at for at, u in occupancy.items()}

        # The archer sits four steps from white's '3,9' gateway, so the hex
        # just inside the board costs five - but that hex is '3,8', row 8,
        # outside white's own first three, and a crossing may not stop there.
        # The one hex it can both reach and stop on is '1,9': five to step
        # through onto its own shieldman at '2,9', which it passes over rather
        # than stops on, and one more.
        targets = panels.entry_targets(
            config, radius, occupancy, board, by_uid['rbr4'])
        self.assertEqual(targets, {'1,9': 6})
        # Everything offered is on the battlefield, empty, and in its own rows.
        for key in targets:
            q, r = panels.parse_key(key)
            self.assertTrue(panels.on_battlefield(q, r, radius))
            self.assertNotIn(key, board)
            self.assertTrue(panels.in_home_rows('white', r, radius))

        # The three units further back cannot reach a gateway and step through
        # on six MOV, so they are offered nothing at all.
        for uid in ('rbr0', 'rbr1', 'rbr2'):
            self.assertEqual(
                panels.entry_targets(config, radius, occupancy, board, by_uid[uid]), {})

    def test_a_crossing_is_point_mirrored_for_the_two_sides(self):
        """
        Neither side may be offered a crossing the other is not. This is the
        check that catches a mistake in the reversed walk or the gateway
        arithmetic, since both sides then stop agreeing.
        """
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()
        by_uid = {u['uid']: at for at, u in occupancy.items()}

        for i in range(5):
            mine = panels.entry_targets(
                config, radius, occupancy, board, by_uid[f'rbr{i}'])
            theirs = panels.entry_targets(
                config, radius, occupancy, board, by_uid[f'rtl{i}'])
            mirrored = {}
            for key, cost in mine.items():
                q, r = panels.parse_key(key)
                mirrored[panels.coord_key(-q, -r)] = cost
            self.assertEqual(mirrored, theirs, f'pair {i} disagrees')

    def test_an_enemy_in_the_doorway_shuts_that_way_in(self):
        """One of your own is stepped over; an enemy is not."""
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()
        by_uid = {u['uid']: at for at, u in occupancy.items()}
        archer = by_uid['rbr4']

        open_ways = panels.entry_targets(config, radius, occupancy, board, archer)
        self.assertIn('1,9', open_ways)

        # '2,9' is the doorway the only route runs through. White's own
        # shieldman stands there and is stepped over; an enemy on the same hex
        # walls it off, and the way round costs more than the archer has.
        blocked = dict(board)
        blocked['2,9'] = {'unit_id': 'pawn', 'color': 'black'}
        shut = panels.entry_targets(config, radius, occupancy, blocked, archer)
        self.assertNotIn('1,9', shut)

    def test_a_crossing_stops_inside_its_own_first_three_rows(self):
        """
        The owner's rule: a unit coming out of a reserve lands in its own back
        three rows and goes no further. A limit on where the walk STOPS, not
        on where it goes - the flood may still route through a fourth row.
        """
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()
        by_uid = {u['uid']: at for at, u in occupancy.items()}

        for color, panel in (('white', 'br'), ('black', 'tl')):
            for i in range(5):
                uid = f"r{panel}{i}"
                for key in panels.entry_targets(
                        config, radius, occupancy, board, by_uid[uid]):
                    _q, r = panels.parse_key(key)
                    self.assertTrue(
                        panels.in_home_rows(color, r, radius),
                        f"{uid} was offered {key}, outside {color}'s own rows")

    def test_a_walk_home_starts_inside_its_own_first_three_rows(self):
        """
        The other end of the same rule. A unit that has pushed up the board
        walks back down into its own ground before it can walk off it.
        """
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()

        # Row 11 is white's own, and the doorway is one step away.
        self.assertTrue(
            panels.homecoming_targets(config, radius, occupancy, board, '-11,11'))

        # The same pawn one row further up is offered nothing, though the
        # doorway is still well inside its MOV.
        pushed = dict(board)
        del pushed['-11,11']
        pushed['-11,8'] = {'unit_id': 'pawn', 'color': 'white', 'hp': 20, 'max_hp': 20}
        self.assertFalse(panels.in_home_rows('white', 8, radius))
        self.assertEqual(
            panels.homecoming_targets(config, radius, occupancy, pushed, '-11,8'), {})

    def test_the_first_three_rows_are_each_side_s_own_and_mirror(self):
        """Mirrors `inHomeRows` in hex-rules.ts - the board tints these too."""
        self.assertEqual(panels.HOME_ROWS, 3)
        for r in (9, 10, 11):
            self.assertTrue(panels.in_home_rows('white', r, 11))
            self.assertFalse(panels.in_home_rows('black', r, 11))
        for r in range(-11, 12):
            self.assertEqual(panels.in_home_rows('white', r, 11),
                             panels.in_home_rows('black', -r, 11))
        self.assertFalse(panels.in_home_rows('white', 8, 11))
        # Clamped on a board too small for three rows a side, so the two
        # never overlap however small it is.
        self.assertTrue(panels.in_home_rows('white', 1, 2))
        self.assertFalse(panels.in_home_rows('black', 1, 2))

    def test_the_way_home_is_walked_within_mov_not_teleported(self):
        """
        Reach a board hex beside your own doorway, one more step onto it, then
        on into the base. The owner has said twice that a unit does not come
        home from anywhere on the board for free.
        """
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()

        # A pawn already standing beside the doorway pays one step for it...
        beside = panels.homecoming_targets(config, radius, occupancy, board, '-11,11')
        self.assertEqual(beside['-12,11'], 1)
        # ...and carries on into the base with the rest of its MOV.
        self.assertGreater(len(beside), 1)
        for key in beside:
            q, r = panels.parse_key(key)
            self.assertFalse(panels.on_battlefield(q, r, radius))

        # A queen five hexes out spends all six MOV getting there, and so can
        # reach the doorway and nothing past it.
        far = panels.homecoming_targets(config, radius, occupancy, board, '-6,11')
        self.assertEqual(len(far), 1)
        self.assertEqual(min(far.values()), 6)

        # A unit in the middle of the board cannot come home at all.
        stranded = dict(board)
        stranded['0,0'] = {'unit_id': 'pawn', 'color': 'white', 'hp': 20, 'max_hp': 20}
        self.assertEqual(
            panels.homecoming_targets(config, radius, occupancy, stranded, '0,0'), {})

    def test_the_way_home_leads_only_into_your_own_base(self):
        """
        The browser engine accepts any off-board hex on the mover's own side by
        a coarse sign-of-q test, which would let a unit walk into the wrong
        panel entirely - its own reserve, say.
        """
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()

        for key in panels.homecoming_targets(config, radius, occupancy, board, '-11,11'):
            q, r = panels.parse_key(key)
            self.assertEqual(panels.panel_of(*panels.axial_to_pixel(q, r)), 'bl')

    def test_an_enemy_in_your_doorway_shuts_the_way_home(self):
        """
        The doorway is a PANEL hex, so the question is asked of the panel
        occupancy. Asked of the board it can never be answered - the board
        holds no panel hex - which is the mistake this replaced.
        """
        config = self._cfg()
        radius = config['board']['radius']
        board = build_initial_board(config).to_dict()
        occupancy = panels.panel_occupancy(config, radius, [])
        self.assertIn(
            '-12,11',
            panels.homecoming_targets(config, radius, occupancy, board, '-11,11'))

        held = dict(occupancy)
        held['-12,11'] = {'unit_id': 'pawn', 'color': 'black', 'panel': 'bl'}
        self.assertNotIn(
            '-12,11',
            panels.homecoming_targets(config, radius, held, board, '-11,11'))

        # One of your own is stepped over, not stopped on.
        friend = dict(occupancy)
        friend['-12,11'] = {'unit_id': 'pawn', 'color': 'white', 'panel': 'bl'}
        through = panels.homecoming_targets(config, radius, friend, board, '-11,11')
        self.assertNotIn('-12,11', through)
        self.assertTrue(through)

    def test_the_way_home_is_point_mirrored_for_the_two_sides(self):
        config = self._cfg()
        radius = config['board']['radius']
        occupancy = panels.panel_occupancy(config, radius, [])
        board = build_initial_board(config).to_dict()
        for key in board:
            q, r = panels.parse_key(key)
            mirror = panels.coord_key(-q, -r)
            if mirror not in board:
                continue
            mine = panels.homecoming_targets(config, radius, occupancy, board, key)
            theirs = panels.homecoming_targets(config, radius, occupancy, board, mirror)
            flipped = {}
            for hex_key, cost in mine.items():
                hq, hr = panels.parse_key(hex_key)
                flipped[panels.coord_key(-hq, -hr)] = cost
            self.assertEqual(flipped, theirs, f'{key} and {mirror} disagree')


class PanelMendingTestCase(TestCase):
    """
    A base closes an HP a turn on its wounded; a reserve closes nothing.

    The client draws mended HP, so the server has to strike from it too. It
    used to be left for a later stage, and flipping panels on for networked play
    without it would have had the preview promise one number and the server
    land another.
    """

    def test_hand_overs_follow_ply_parity(self):
        """White plays the odd plies, black the even ones."""
        self.assertEqual(
            [panels.hand_overs_by('white', p) for p in range(0, 6)], [0, 1, 1, 2, 2, 3])
        self.assertEqual(
            [panels.hand_overs_by('black', p) for p in range(0, 6)], [0, 0, 1, 1, 2, 2])

    def test_a_unit_mends_once_a_turn_not_once_a_ply(self):
        """
        Standing through a white ply and a black ply is one turn of the side's
        own, so one HP - not the two a ply count would give.
        """
        # Wounded during white's ply 5; ply 8 is about to be played, so plies 6
        # (black) and 7 (white) have finished - one white hand-over.
        self.assertEqual(panels.mended_since('white', 5, 8), 1)
        # Nothing has finished yet.
        self.assertEqual(panels.mended_since('white', 5, 6), 0)
        self.assertEqual(panels.mended_since('white', None, 50), 0)

    def test_a_base_mends_its_wounded_and_a_reserve_does_not(self):
        history = [
            # Black's base rook and black's reserve queen, both struck on ply 10.
            {'intoPanel': True, 'panel': 'tr', 'turn': 10, 'defenderHp': 30,
             'unit': {'uid': 'rtr1', 'color': 'black', 'max_hp': 40}},
            {'intoPanel': True, 'panel': 'tl', 'turn': 10, 'defenderHp': 12,
             'unit': {'uid': 'rtl0', 'color': 'black', 'max_hp': 30}},
        ]
        hp = panels.panel_hp(history, 21)
        # Black handed over plies 12..20 since - five turns, five HP.
        self.assertEqual(hp['rtr1'], 35)
        self.assertEqual(hp['rtl0'], 12)

    def test_mending_stops_at_full_and_never_raises_the_dead(self):
        history = [
            {'intoPanel': True, 'panel': 'tr', 'turn': 2, 'defenderHp': 39,
             'unit': {'uid': 'rtr1', 'color': 'black', 'max_hp': 40}},
            {'intoPanel': True, 'panel': 'tr', 'turn': 2, 'defenderHp': 0,
             'unit': {'uid': 'rtr2', 'color': 'black', 'max_hp': 22}},
        ]
        hp = panels.panel_hp(history, 60)
        self.assertEqual(hp['rtr1'], 40)
        self.assertEqual(hp['rtr2'], 0)

    def test_a_unit_that_walked_home_mends_there(self):
        walked = {'uid': 'w3,9', 'unit_id': 'pawn', 'color': 'white', 'hp': 9, 'max_hp': 20}
        history = [{'withdrawn': True, 'unit': walked, 'to': '-12,11', 'turn': 5}]
        # Unmended without a ply, as before.
        self.assertEqual(panels.withdrawn_units(history)['w3,9']['hp'], 9)
        # Plies 6..11 finished by ply 12: three white hand-overs.
        self.assertEqual(panels.withdrawn_units(history, 12)['w3,9']['hp'], 12)


class PanelAttackTestCase(DealtPanels, TestCase):
    """
    A board unit striking a unit that stands in a panel.

    The numbers are the ones PUNCHLIST 4.1 records as watched in a running solo
    game - a pawn into black's base rook for 1 with nothing back, and into
    black's reserve queen for 2, taking 16 in return. The server reaching the
    same numbers by DERIVING the defender, its panel and whether it answers is
    the point: the browser engine is handed all three by the client.
    """

    #: Two empty board hexes, each beside a black panel unit.
    BESIDE_RESERVE = '-8,-3'   # next to rtl0, the queen in black's reserve
    RESERVE_QUEEN = '-9,-3'
    BESIDE_BASE = '11,-3'      # next to rtr1, the rook in black's base
    BASE_ROOK = '12,-4'

    def _cfg(self):
        return load_config(None)

    def _board_with_pawn(self, config, at, color='white'):
        board = build_initial_board(config)
        q, r = panels.parse_key(at)
        board.set_cell(q, r, {
            'unit_id': 'pawn', 'color': color, 'hp': 20, 'max_hp': 20, 'uid': 'wtest',
        })
        return board

    def test_a_reserve_answers_the_blow(self):
        config = self._cfg()
        board = self._board_with_pawn(config, self.BESIDE_RESERVE)
        out = resolve_panel_attack(
            board, config, [], self.BESIDE_RESERVE, self.BESIDE_RESERVE,
            self.RESERVE_QUEEN, 'white', 21)

        record = out['record']
        self.assertTrue(out['counters'])
        self.assertEqual(record['panel'], 'tl')
        self.assertEqual(record['damage_dealt'], 2)       # 14 attack into 12 defence
        self.assertEqual(record['defenderHp'], 28)
        self.assertEqual(record['counter_damage'], 16)    # 26 attack into 10 defence
        q, r = panels.parse_key(self.BESIDE_RESERVE)
        self.assertEqual(board.get(q, r)['hp'], 4)

    def test_a_base_never_answers(self):
        """
        The rule the browser engine does not implement: there it is a
        `counters` flag the client sets, so a client could switch the counter
        off against its own blows. Here nothing on the wire can reach it.
        """
        config = self._cfg()
        board = self._board_with_pawn(config, self.BESIDE_BASE)
        out = resolve_panel_attack(
            board, config, [], self.BESIDE_BASE, self.BESIDE_BASE,
            self.BASE_ROOK, 'white', 21)

        record = out['record']
        self.assertFalse(out['counters'])
        self.assertEqual(record['panel'], 'tr')
        self.assertEqual(record['damage_dealt'], 1)       # 14 into 13, the floor
        self.assertEqual(record['defenderHp'], 39)
        self.assertEqual(record['counter_damage'], 0)
        q, r = panels.parse_key(self.BESIDE_BASE)
        self.assertEqual(board.get(q, r)['hp'], 20)       # untouched

    def test_the_record_carries_what_the_client_derives_panels_from(self):
        """
        No board holds a panel unit, so its HP lives in this record or nowhere.
        Drop a field and the panel re-deals the unit whole on the next rebuild.
        """
        config = self._cfg()
        board = self._board_with_pawn(config, self.BESIDE_RESERVE)
        record = resolve_panel_attack(
            board, config, [], self.BESIDE_RESERVE, self.BESIDE_RESERVE,
            self.RESERVE_QUEEN, 'white', 21)['record']

        self.assertTrue(record['intoPanel'])
        self.assertTrue(record['panelAttack'])
        self.assertEqual(record['attackedHex'], self.RESERVE_QUEEN)
        self.assertEqual(record['unit']['uid'], 'rtl0')
        self.assertEqual(record['unit']['max_hp'], 30)
        self.assertEqual(record['turn'], 21)
        # And it is exactly what the derivation reads back.
        self.assertEqual(panels.recorded_panel_hp([record]), {'rtl0': 28})

    def test_a_panel_unit_already_wounded_is_struck_from_its_wounds(self):
        """
        The defender's HP comes out of the history, so a second blow lands on
        what the first one left - not on a freshly re-dealt unit.
        """
        config = self._cfg()
        # A whole record, as either engine writes one. The HP derivation reads
        # max_hp as the ceiling a base mends up to, so a record without it
        # caps the unit at nothing - in the client as much as here.
        history = [{
            'intoPanel': True, 'panel': 'tl', 'turn': 20, 'defenderHp': 2,
            'unit': {'uid': 'rtl0', 'color': 'black', 'max_hp': 30},
        }]
        board = self._board_with_pawn(config, self.BESIDE_RESERVE)
        record = resolve_panel_attack(
            board, config, history, self.BESIDE_RESERVE, self.BESIDE_RESERVE,
            self.RESERVE_QUEEN, 'white', 23)['record']

        self.assertEqual(record['defenderHp'], 0)
        self.assertTrue(record['defender_eliminated'])
        self.assertEqual(record['captured'], 'queen')
        # A dead unit never swings back.
        self.assertEqual(record['counter_damage'], 0)
        q, r = panels.parse_key(self.BESIDE_RESERVE)
        self.assertEqual(board.get(q, r)['hp'], 20)

    def test_a_refused_blow_leaves_the_board_as_it_was(self):
        config = self._cfg()
        cases = [
            # White's own reserve queen, from the board hex beside it.
            ('white', '8,3', '9,3', 'Nothing to attack there'),
            # An empty hex in black's reserve.
            ('white', self.BESIDE_RESERVE, '-10,-2', 'Nothing to attack there'),
            # A black panel unit, but three hexes out of the pawn's reach of one.
            ('white', self.BESIDE_RESERVE, '-9,-5', 'out of attack range'),
            # Striking with a unit that is not yours.
            ('black', self.BESIDE_RESERVE, self.RESERVE_QUEEN, 'Nothing of yours'),
        ]
        for color, frm, target, message in cases:
            board = self._board_with_pawn(config, frm)
            before = board.to_dict()
            out = resolve_panel_attack(board, config, [], frm, frm, target, color, 21)
            self.assertIn(message, out.get('error', ''), (color, target))
            self.assertEqual(board.to_dict(), before, (color, target))

    def test_a_blow_into_a_mending_base_is_struck_from_what_the_client_draws(self):
        """
        The rook was knocked to 30 on ply 10 and its base has mended it to 35
        by ply 21. The client draws 35 and previews 35 -> 34. Struck from the
        recorded 30 instead, the server would write 29 and the unit would drop
        five further than the player was shown.
        """
        config = self._cfg()
        history = [
            {'intoPanel': True, 'panel': 'tr', 'turn': 10, 'defenderHp': 30,
             'unit': {'uid': 'rtr1', 'color': 'black', 'max_hp': 40}},
        ]
        board = self._board_with_pawn(config, self.BESIDE_BASE)
        record = resolve_panel_attack(
            board, config, history, self.BESIDE_BASE, self.BESIDE_BASE,
            self.BASE_ROOK, 'white', 21)['record']
        self.assertEqual(record['unit']['hp'], 35)
        self.assertEqual(record['defenderHp'], 34)

    def test_an_illegal_walk_is_refused_before_anything_moves(self):
        """The walk is validated before it is applied, so a refusal is clean."""
        config = self._cfg()
        board = self._board_with_pawn(config, self.BESIDE_RESERVE)
        before = board.to_dict()
        out = resolve_panel_attack(
            board, config, [], self.BESIDE_RESERVE, '0,0',
            self.RESERVE_QUEEN, 'white', 21)
        self.assertEqual(out['error'], 'Illegal move for this piece')
        self.assertEqual(board.to_dict(), before)


class PhaseScheduleTestCase(TestCase):
    """
    The match schedule, ported from phases.ts.

    This is the fourth mirror the browser engine warned about, so every number
    here is one the client already documents: change the schedule on one side
    and these are what fail.
    """

    def test_overtime_starts_where_the_client_says(self):
        # 3 + 11 + 11 + 11 turns, two plies each, then the next one. Eleven,
        # not ten: each numbered phase closes with a postmatch turn that its
        # ten do not count.
        self.assertEqual(phases.OVERTIME_FIRST_PLY, 73)
        self.assertFalse(phases.is_overtime(72))
        self.assertTrue(phases.is_overtime(73))
        self.assertTrue(phases.is_overtime(10_000))

    def test_the_opening_is_three_full_turns(self):
        self.assertEqual([p for p in range(1, 12) if phases.is_initialization(p)],
                         [1, 2, 3, 4, 5, 6])

    def test_each_numbered_phase_closes_with_one_postmatch_turn(self):
        """Turns 14, 25 and 36 - and none of them eats a turn of play."""
        postmatch_turns = [t for t in range(1, 40) if phases.is_postmatch(2 * t - 1)]
        self.assertEqual(postmatch_turns, [14, 25, 36])
        # Both plies of it, so each side gets one hand-over to set out on -
        # and no other ply anywhere, overtime included.
        self.assertEqual([p for p in range(1, 111) if phases.is_postmatch(p)],
                         [27, 28, 49, 50, 71, 72])
        # It belongs to the phase it closes: turn 14 is still Phase 1, and
        # Phase 2 starts on turn 15.
        self.assertEqual([phases.phase_index_at(p) for p in (7, 25, 27, 28, 29)],
                         [1, 1, 1, 1, 2])
        # A setup turn is the opening's three plus these; the opening is not
        # widened to include them.
        self.assertEqual([t for t in range(1, 40) if phases.is_setup_turn(2 * t - 1)],
                         [1, 2, 3, 14, 25, 36])
        self.assertFalse(phases.is_initialization(27))

    def test_play_starts_the_moment_the_opening_ends(self):
        """
        The owner's reason for moving the extra turn to the end of the phase:
        at the front, it followed the opening's three setup turns straight
        away, and a match opened on four in a row. Turn 4 is Phase 1's first
        turn of play now.
        """
        self.assertFalse(phases.is_setup_turn(7))
        self.assertFalse(phases.is_setup_turn(8))
        self.assertEqual(phases.stage_at(7), 'Phase 1')
        self.assertTrue(phases.is_wrap_open(7))

    def test_the_wrap_is_open_before_each_halftime(self):
        """
        The played first half of a numbered phase and nothing else: turns 4-8,
        15-19 and 26-30. Not the opening, not a postmatch, and not overtime -
        `before_halftime` alone used to say yes to the opening and overtime.
        """
        open_turns = [t for t in range(1, 40) if phases.is_wrap_open(2 * t - 1)]
        self.assertEqual(
            open_turns,
            list(range(4, 9)) + list(range(15, 20)) + list(range(26, 31)))

    def test_the_reserve_and_the_base_doorways_keep_their_own_windows(self):
        """
        Three arrows, three schedules. Crossings run on the setup turns and
        each phase's second half; walks home run on the setup turns and all of
        overtime; the wrap runs on the first halves. No turn opens all three.
        """
        entry = [t for t in range(1, 40) if phases.is_entry_open(2 * t - 1)]
        self.assertEqual(entry, [1, 2, 3] + list(range(9, 15))
                         + list(range(20, 26)) + list(range(31, 37)))
        home = [t for t in range(1, 40) if phases.is_homecoming_open(2 * t - 1)]
        # Phase 3's postmatch (36) runs straight on into overtime (37 on).
        self.assertEqual(home, [1, 2, 3, 14, 25, 36] + list(range(37, 40)))
        for turn in range(1, 40):
            ply = 2 * turn - 1
            self.assertFalse(
                phases.is_wrap_open(ply) and phases.is_entry_open(ply),
                f'turn {turn} opens both the wrap and the way in')

    def test_the_stages_have_the_names_the_header_counts_down_to(self):
        named = {t: phases.stage_at(2 * t - 1)
                 for t in (1, 3, 4, 8, 9, 13, 14, 15, 19, 20, 24, 25,
                           26, 30, 31, 35, 36, 37)}
        self.assertEqual(named, {
            1: 'Initialization', 3: 'Initialization',
            4: 'Phase 1', 8: 'Phase 1',
            9: 'Phase 1 Halftime', 13: 'Phase 1 Halftime',
            14: 'Phase 1 Postmatch',
            15: 'Phase 2', 19: 'Phase 2',
            20: 'Phase 2 Halftime', 24: 'Phase 2 Halftime',
            25: 'Phase 2 Postmatch',
            26: 'Phase 3', 30: 'Phase 3',
            31: 'Phase 3 Halftime', 35: 'Phase 3 Halftime',
            36: 'Phase 3 Postmatch', 37: 'Overtime 1',
        })
        # Both hand-overs of a postmatch name it, black's as well as white's.
        self.assertEqual(phases.stage_at(28), 'Phase 1 Postmatch')
        # Overtime is three stages, not one: the toll climbs through them.
        self.assertEqual(
            [phases.stage_at(2 * t - 1) for t in (44, 45, 49, 50)],
            ['Overtime 1', 'Overtime 2', 'Overtime 2', 'Overtime 3'])

    def test_overtime_runs_three_stretches_read_off_the_schedule(self):
        """
        Turns 37-44, 45-49 and 50, with the toll climbing 1, 2, 3 - so that a
        match neither side can win on points or on the board still ends.

        Counted forward from overtime's first turn rather than written down.
        The client's ``OVERTIME_LAST_TURN`` used to be the literal 50, and when
        the extra turn each numbered phase gained (an initialization at its
        start then, a postmatch at its end now) pushed overtime from turn 34 to
        turn 37, the literal stayed put and quietly cost overtime three of its
        turns.
        """
        self.assertEqual(phases.OVERTIME_FIRST_TURN, 37)
        self.assertEqual(phases.OVERTIME_LAST_TURN, 50)
        self.assertEqual(
            phases.OVERTIME_LAST_TURN - phases.OVERTIME_FIRST_TURN + 1,
            sum(stage['turns'] for stage in phases.OVERTIME_STAGES))
        tolls = [phases.overtime_toll_at(2 * t - 1) for t in range(37, 51)]
        self.assertEqual(tolls, [1] * 8 + [3] * 5 + [5])

    def test_the_toll_is_nothing_before_overtime_and_never_stops_after(self):
        """
        ``0`` is the engines' gate as well as the amount: neither keeps a
        ``ply < OVERTIME_FIRST_PLY`` of its own beside this, so there is one
        question with one answer rather than two that can disagree.

        Past the last turn it is still the heaviest toll. Both engines end the
        match as turn 50 is played out, so no game gets there by playing; a
        position built past it still has to keep paying - ``None`` there would
        be a king who bleeds for fourteen turns and then becomes immortal.
        """
        self.assertEqual([phases.overtime_toll_at(p) for p in (1, 7, 71, 72)],
                         [0, 0, 0, 0])
        self.assertEqual(phases.overtime_toll_at(73), 1)
        # Both hand-overs of a turn share its stretch: they change at a turn
        # boundary, so the two sides of turn 45 pay the same.
        self.assertEqual(phases.overtime_toll_at(2 * 45 - 1), 3)
        self.assertEqual(phases.overtime_toll_at(2 * 45), 3)
        self.assertEqual(phases.overtime_toll_at(1000), 5)

    def test_overtime_widens_the_turn_to_two_moves_then_three(self):
        """
        The owner's rule: two units on the main board in Overtime 2, three in
        Overtime 3. One everywhere else, which is what "the turn's board
        action" has always meant.
        """
        self.assertEqual([phases.board_moves_per_turn(2 * t - 1)
                          for t in (1, 4, 20, 36, 37, 44, 45, 49, 50, 500)],
                         [1, 1, 1, 1, 1, 1, 2, 2, 3, 3])

    def test_board_moves_at_counts_what_the_client_counts(self):
        """
        Mirrors ``boardMovesAt`` in history-rules.ts. The count decides whether
        the next message hands the turn over, so the exclusions are
        load-bearing rather than tidy.
        """
        def move(**extra):
            base = {'turn': 89, 'color': 'white', 'from': '0,0', 'to': '0,1'}
            base.update(extra)
            return base

        history = [move(), move(**{'from': '5,5'}), move(color='black'),
                   move(turn=90), move(turn=87)]
        self.assertEqual(board_moves_at(history, 89, 'white'), 2)
        self.assertEqual(board_moves_at(history, 89, 'black'), 1)
        self.assertEqual(board_moves_at([], 89, 'white'), 0)

        # A panel's own moves spend a panel's allowance, never the board's.
        panelled = [move(entered=True), move(panelMove=True), move(panelEffect=True)]
        self.assertEqual(board_moves_at(panelled, 89, 'white'), 0)

        # A walk home is the turn's board action in overtime and a deployment
        # while setting out - ply 27 being turn 14, Phase 1's postmatch.
        self.assertEqual(board_moves_at([move(withdrawn=True)], 89, 'white'), 1)
        self.assertEqual(
            board_moves_at([move(withdrawn=True, turn=27)], 27, 'white'), 0)

    def test_a_setup_turn_says_which_one_it_is_when_it_refuses_a_blow(self):
        self.assertEqual(phases.no_attack_message(1), 'Nobody attacks in the opening')
        self.assertEqual(phases.no_attack_message(27),
                         'Nobody attacks in the postmatch')
        self.assertEqual(phases.no_attack_message(72),
                         'Nobody attacks in the postmatch')
        # And nothing at all on a turn that refuses no blow. Asked the other
        # way round it answered for the phase's extra turn on every playable
        # turn of every phase, which is what a caller reading it as a general
        # "why was this refused?" would have been handed. Ply 7 is turn 4,
        # which refused a blow while it was Phase 1's initialization and is
        # Phase 1's first turn of play now.
        self.assertEqual([phases.no_attack_message(p) for p in (7, 9, 40, 80)],
                         ['', '', '', ''])

    def test_white_plays_the_odd_plies(self):
        self.assertEqual([phases.side_of_ply(p) for p in (1, 2, 3, 4)],
                         ['white', 'black', 'white', 'black'])

    def test_the_panels_count_turns_with_the_schedule_not_a_copy_of_it(self):
        """There was a private copy in panels.py until the schedule was ported."""
        self.assertIs(panels.hand_overs_by, phases.hand_overs_by)


class OvertimeTollTestCase(TestCase):
    """
    Overtime takes a point off the side that just played, at the end of its turn.

    The browser engine has always done this in solo play. The server did not,
    so a networked match ran overtime with no pressure on anyone - and a king
    on his last HP simply lived.
    """

    def _board(self, king_hp):
        board = HexBoard(5)
        board.set(0, 3, 'king', 'white', hp=king_hp, max_hp=45)
        board.set(0, -3, 'king', 'black', hp=45, max_hp=45)
        board.set(1, 2, 'pawn', 'white', hp=20, max_hp=20)
        return board

    def _cfg(self):
        return load_config(None)

    def test_nothing_is_taken_before_overtime(self):
        board = self._board(10)
        self.assertIsNone(overtime_toll(board, self._cfg(), 'white', 72))
        self.assertEqual(board.get(0, 3)['hp'], 10)

    def test_the_side_that_played_pays_and_the_other_does_not(self):
        board = self._board(10)
        self.assertIsNone(overtime_toll(board, self._cfg(), 'white', 73))
        self.assertEqual(board.get(0, 3)['hp'], 9)
        self.assertEqual(board.get(0, -3)['hp'], 45)
        # Only the commander - the rest of the army is untouched.
        self.assertEqual(board.get(1, 2)['hp'], 20)

    def test_it_is_real_damage_that_defence_does_not_blunt(self):
        """The king's 15 defence would floor a blow; it does nothing to this."""
        board = self._board(2)
        overtime_toll(board, self._cfg(), 'white', 73)
        self.assertEqual(board.get(0, 3)['hp'], 1)

    def test_a_king_on_his_last_point_dies_of_it(self):
        board = self._board(1)
        self.assertEqual(overtime_toll(board, self._cfg(), 'white', 73), 'white')
        self.assertIsNone(board.get(0, 3))
        # Which is a regicide.
        self.assertEqual(defeated_sides(board, self._cfg()), ['white'])

    def test_the_toll_climbs_through_overtime_s_three_stretches(self):
        """
        1 in the first stretch, 3 in the second, 5 on the last turn - the same
        table the client reads, taken here through the board itself. *The
        owner, 24 Sep 2026: "the 3 and 5 is DAMAGE TAKEN TO KING"* - it was 1,
        2 and 3.

        A constant would have shipped a deathmatch that never ends: the whole
        point of the escalation is that a king who reaches turn 50 on five or
        less does not come out of it.
        """
        for ply, expected in ((73, 1), (2 * 44 - 1, 1), (2 * 45 - 1, 3),
                              (2 * 49 - 1, 3), (2 * 50 - 1, 5)):
            board = self._board(10)
            overtime_toll(board, self._cfg(), 'white', ply)
            self.assertEqual(board.get(0, 3)['hp'], 10 - expected,
                             f'ply {ply} should have taken {expected}')

    def test_the_last_turn_kills_a_king_the_stretches_before_it_would_not(self):
        board = self._board(5)
        # Turn 37 leaves him standing on 4, and a turn of Overtime 2 on 2 ...
        self.assertIsNone(overtime_toll(board, self._cfg(), 'white', 73))
        self.assertEqual(board.get(0, 3)['hp'], 4)
        board = self._board(5)
        self.assertIsNone(overtime_toll(board, self._cfg(), 'white', 2 * 45 - 1))
        self.assertEqual(board.get(0, 3)['hp'], 2)
        # ... but turn 50 takes five, and five is all he had.
        board = self._board(5)
        self.assertEqual(
            overtime_toll(board, self._cfg(), 'white', 2 * 50 - 1), 'white')
        self.assertIsNone(board.get(0, 3))
        self.assertEqual(defeated_sides(board, self._cfg()), ['white'])

    def test_no_king_on_the_board_is_no_toll(self):
        """
        Under elimination a side plays on after its king falls, and the toll
        has nobody left to take from - it must not fall on anyone else.
        """
        board = self._board(1)
        board.remove(0, 3)
        self.assertIsNone(overtime_toll(board, self._cfg(), 'white', 73))
        self.assertEqual(board.get(1, 2)['hp'], 20)

    def test_the_king_is_never_offered_a_way_home(self):
        """
        The owner's rule. Walked home he was off the board, and under regicide
        a side with no commander on it has lost - so the walk lost the match.
        """
        config = self._cfg()
        radius = config['board']['radius']
        board = {
            '-11,11': {'unit_id': 'king', 'color': 'white', 'hp': 45, 'max_hp': 45, 'uid': 'wk'},
        }
        self.assertEqual(panels.homecoming_targets(config, radius, {}, board, '-11,11'), {})
        # A pawn on the same hex is offered the doorway beside it.
        board['-11,11'] = {'unit_id': 'pawn', 'color': 'white', 'hp': 20, 'max_hp': 20, 'uid': 'wp'}
        self.assertIn('-12,11', panels.homecoming_targets(config, radius, {}, board, '-11,11'))


def _panel_step(uid, unit_id, color, frm, to, turn, panel, cost=1, price=0):
    """A walk inside a panel, recorded the way the server records one."""
    return {
        'panelMove': True, 'from': frm, 'to': to, 'turn': turn,
        'unit_id': unit_id, 'color': color, 'panel': panel,
        'cost': cost, 'price': price,
        'unit': {'uid': uid, 'unit_id': unit_id, 'color': color},
    }


class PanelMoveTestCase(DealtPanels, TestCase):
    """
    Walking a unit inside its panel, and the wrap out of its base.

    Neither reached any engine until now: the board moved the unit in its own
    memory and sent nothing, so the server's idea of where a panel unit stood
    was wrong the moment anybody shuffled one - and a crossing from the new hex
    was refused. These are the rules the server holds them to.
    """

    def _cfg(self):
        return load_config(None)

    def _setup(self):
        config = self._cfg()
        radius = config['board']['radius']
        board = build_initial_board(config).to_dict()
        occupancy = panels.panel_occupancy(config, radius, [], ply=1)
        at = {u['uid']: k for k, u in occupancy.items()}
        return config, radius, board, at

    def test_a_walk_never_leaves_the_units_own_panel(self):
        config, radius, board, at = self._setup()
        zone = set(panels.panel_zones(radius)['br'])
        targets = panels.panel_move_targets(config, radius, [], board, at['rbr4'], 1, points=0)
        self.assertTrue(targets)
        self.assertTrue(set(targets) <= zone)
        self.assertTrue(all(v['price'] == 0 for v in targets.values()))

    def test_mov_is_spent_a_few_steps_at_a_time_across_the_turn(self):
        # Ply 7, turn 4: Phase 1's first turn of play - past the opening, whose
        # once-a-phase lock is a different rule with its own test below.
        config, radius, board, at = self._setup()
        unit = panels.panel_occupancy(config, radius, [], ply=7)[at['rbr4']]
        self.assertEqual(panels.panel_allowance(config, [], unit, 7), 6)
        history = [_panel_step('rbr4', 'archer', 'white', at['rbr4'], '7,6', 7, 'br', cost=4)]
        moved = panels.panel_occupancy(config, radius, history, ply=7)['7,6']
        self.assertEqual(panels.panel_allowance(config, history, moved, 7), 2)
        # A new turn is a new allowance.
        self.assertEqual(panels.panel_allowance(config, history, moved, 9), 6)

    def test_three_movers_a_panel_a_turn_and_the_two_panels_count_apart(self):
        config, radius, board, at = self._setup()
        history = [
            _panel_step(uid, 'x', 'white', at[uid], at[uid], 1, 'br')
            for uid in ('rbr0', 'rbr1', 'rbr2')
        ]
        occupancy = panels.panel_occupancy(config, radius, history, ply=1)
        by_uid = {u['uid']: u for u in occupancy.values()}
        # A fourth reserve unit may not start.
        self.assertIsNone(panels.panel_allowance(config, history, by_uid['rbr3'], 1))
        # One of the three may keep going on what it has left.
        self.assertIsNotNone(panels.panel_allowance(config, history, by_uid['rbr0'], 1))
        # And the base has three of its own - never three between them.
        self.assertIsNotNone(panels.panel_allowance(config, history, by_uid['rbl0'], 1))
        # A crossing is a reserve's move, and counts against the reserve.
        crossed = history + [{'entered': True, 'turn': 1,
                              'unit': {'uid': 'rbr4', 'color': 'white'}}]
        self.assertEqual(len(panels.panel_movers(crossed, 1, 'white')['reserve']), 4)

    def test_the_movers_allowance_is_read_off_the_config(self):
        # rules.panelMoversPerTurn, and rules.postmatchEntries for the reserve
        # in a postmatch: tuning either is a config edit. Ply 27 is turn 14,
        # Phase 1's postmatch.
        config, radius, board, at = self._setup()
        config = {**config, 'rules': {**config['rules'],
                                      'panelMoversPerTurn': 2, 'postmatchEntries': 1}}
        two = [_panel_step(uid, 'x', 'white', at[uid], at[uid], 1, 'br')
               for uid in ('rbr0', 'rbr1')]
        by_uid = {u['uid']: u for u in
                  panels.panel_occupancy(config, radius, two, ply=1).values()}
        self.assertIsNone(panels.panel_allowance(config, two, by_uid['rbr3'], 1))
        one = [_panel_step('rbr0', 'x', 'white', at['rbr0'], at['rbr0'], 27, 'br')]
        by_uid = {u['uid']: u for u in
                  panels.panel_occupancy(config, radius, one, ply=27).values()}
        self.assertIsNone(panels.panel_allowance(config, one, by_uid['rbr3'], 27))
        self.assertIsNotNone(panels.panel_allowance(config, one, by_uid['rbr0'], 27))

    def test_through_the_opening_a_unit_moves_once_for_the_whole_phase(self):
        config, radius, board, at = self._setup()
        history = [_panel_step('rbr4', 'archer', 'white', at['rbr4'], '7,6', 1, 'br')]
        moved = panels.panel_occupancy(config, radius, history, ply=3)['7,6']
        # Ply 3 is still the opening: locked.
        self.assertIsNone(panels.panel_allowance(config, history, moved, 3))
        # But on the SAME ply it is simply one of the turn's movers.
        self.assertIsNotNone(panels.panel_allowance(config, history, moved, 1))
        # Ply 7 is turn 4, Phase 1's first turn of play: past the opening, so
        # the opening's lock is gone with the phase that owned it.
        self.assertEqual(panels.panel_allowance(config, history, moved, 7), 6)

    def test_a_postmatch_starts_five_out_of_a_reserve(self):
        """
        The owner's number, and it stands INSTEAD of the per-panel three
        rather than beside it. Ply 27 is turn 14 - Phase 1's postmatch.
        """
        config, radius, board, at = self._setup()
        occupancy = panels.panel_occupancy(config, radius, [])
        reserve = [u for u in occupancy.values()
                   if u['color'] == 'white' and not panels.is_base(u['panel'])]
        self.assertGreaterEqual(len(reserve), 5)

        def walked(units, ply):
            return [{'panelMove': True, 'turn': ply, 'cost': 0,
                     'from': '9,3', 'to': '9,4', 'panel': 'br',
                     'unit': dict(u)} for u in units]

        sixth = dict(reserve[0])
        sixth['uid'] = 'not-one-of-them'
        # Four started, and a fifth still may.
        self.assertIsNotNone(
            panels.panel_allowance(config, walked(reserve[:4], 27), sixth, 27))
        # Five started, and a sixth may not.
        self.assertIsNone(
            panels.panel_allowance(config, walked(reserve[:5], 27), sixth, 27))
        # One of the five walks on regardless: the cap is on how many are
        # started, not on how far they go.
        self.assertIsNotNone(
            panels.panel_allowance(config, walked(reserve[:5], 27), dict(reserve[0]), 27))

        # Off a postmatch the reserve is back to three, on either side of it.
        # Ply 25 is turn 13, the last turn of Phase 1's halftime; ply 29 is
        # turn 15, Phase 2's first turn of play.
        for ply in (25, 29):
            self.assertIsNone(
                panels.panel_allowance(config, walked(reserve[:3], ply), sixth, ply),
                f'ply {ply}')

    def test_homecomings_are_counted_by_uid_for_the_ply_and_the_side(self):
        """Mirrors `homecomingsAt` in history-rules.ts."""
        def walk_home(uid, color, turn):
            return {'from': '-11,11', 'to': '-12,11', 'turn': turn,
                    'withdrawn': True, 'moved': True,
                    'unit': {'unit_id': 'pawn', 'color': color, 'uid': uid}}

        history = [
            walk_home('w1', 'white', 7),      # an earlier ply
            walk_home('w2', 'white', 9),
            walk_home('b1', 'black', 9),      # the other side's
            {'panelMove': True, 'turn': 9,    # not a walk home at all
             'unit': {'uid': 'r1', 'color': 'white'}},
            {'turn': 9, 'withdrawn': True},   # no unit on the record
        ]
        self.assertEqual(panels.homecomings_at(history, 9, 'white'), frozenset({'w2'}))
        self.assertEqual(panels.homecomings_at(history, 9, 'black'), frozenset({'b1'}))
        self.assertEqual(panels.homecomings_at(history, 7, 'white'), frozenset({'w1'}))
        self.assertEqual(panels.homecomings_at([], 9, 'white'), frozenset())

    def test_the_wrap_is_priced_at_the_units_value(self):
        config, radius, board, at = self._setup()
        tip = panels.wrap_tips('white', radius)['reserve']
        # Ply 15 is turn 8: Phase 1's played first half, so the wrap is open.
        rich = panels.panel_move_targets(config, radius, [], board, at['rbl3'], 15, points=100)
        self.assertEqual(rich[tip], {'cost': 6, 'price': 12})     # a knight is worth 12
        # Every hex reached by making it carries the same price.
        self.assertTrue(all(v['price'] == 12 for k, v in rich.items()
                            if panels.panel_of(*panels.axial_to_pixel(*panels.parse_key(k))) == 'br'))

    def test_no_wrap_without_the_points_or_while_it_is_shut(self):
        config, radius, board, at = self._setup()
        tip = panels.wrap_tips('white', radius)['reserve']
        poor = panels.panel_move_targets(config, radius, [], board, at['rbl3'], 15, points=11)
        self.assertNotIn(tip, poor)
        # Ply 19 is turn 10, Phase 1's halftime: shut however rich.
        shut = panels.panel_move_targets(config, radius, [], board, at['rbl3'], 19, points=100)
        self.assertNotIn(tip, shut)
        # Out of MOV before out of money: the archer cannot reach the tip at all.
        far = panels.panel_move_targets(config, radius, [], board, at['rbl4'], 15, points=100)
        self.assertFalse(any(v['price'] for v in far.values()))

    def test_the_two_sides_walk_and_wrap_as_mirrors(self):
        config, radius, board, at = self._setup()
        for i in range(5):
            for mine, theirs in ((f'rbl{i}', f'rtr{i}'), (f'rbr{i}', f'rtl{i}')):
                w = panels.panel_move_targets(config, radius, [], board, at[mine], 15, points=100)
                b = panels.panel_move_targets(config, radius, [], board, at[theirs], 16, points=100)
                flipped = {panels.coord_key(-q, -r): v
                           for (q, r), v in ((panels.parse_key(k), v) for k, v in w.items())}
                self.assertEqual(flipped, b, f'{mine} / {theirs}')

    def test_a_recorded_walk_is_where_the_unit_stands(self):
        """The whole of the bug: the server did not know a shuffle had happened."""
        config, radius, board, at = self._setup()
        history = [_panel_step('rbr4', 'archer', 'white', at['rbr4'], '7,6', 1, 'br')]
        occupancy = panels.panel_occupancy(config, radius, history, ply=1)
        self.assertNotIn(at['rbr4'], occupancy)
        self.assertEqual(occupancy['7,6']['uid'], 'rbr4')
        # So a crossing from where it now stands is judged from there.
        self.assertTrue(panels.entry_targets(config, radius, occupancy, board, '7,6'))

    def test_a_wrapped_unit_is_a_reserve_unit_from_then_on(self):
        """It answers blows and stops mending as one - read off where it stands."""
        config, radius, board, at = self._setup()
        tip = panels.wrap_tips('white', radius)['reserve']
        history = [_panel_step('rbl3', 'knight', 'white', at['rbl3'], tip, 15, 'bl',
                               cost=6, price=12)]
        wrapped = panels.panel_occupancy(config, radius, history, ply=15)[tip]
        self.assertEqual(wrapped['uid'], 'rbl3')
        self.assertEqual(wrapped['panel'], 'br')
        self.assertFalse(panels.is_base(wrapped['panel']))

    def test_the_replay_follows_a_unit_out_and_back_and_out_again(self):
        """
        Cross, walk home, wrap back to the reserve, cross again. A set of "units
        that ever crossed" cannot say where that unit is; replaying in order can.
        """
        config, radius, board, at = self._setup()
        tip = panels.wrap_tips('white', radius)['reserve']
        archer = {'uid': 'rbr4', 'unit_id': 'archer', 'color': 'white', 'hp': 16, 'max_hp': 16}
        history = [
            {'entered': True, 'turn': 15, 'from': at['rbr4'], 'to': '3,8', 'unit': archer},
            {'withdrawn': True, 'turn': 17, 'to': '-12,11', 'color': 'white',
             'unit_id': 'archer', 'unit': archer},
        ]
        home = panels.panel_occupancy(config, radius, history, ply=19)
        self.assertEqual(home['-12,11']['uid'], 'rbr4')

        history.append(_panel_step('rbr4', 'archer', 'white', '-12,11', tip, 25, 'bl',
                                   cost=6, price=8))
        wrapped = panels.panel_occupancy(config, radius, history, ply=25)
        self.assertEqual(wrapped[tip]['uid'], 'rbr4')
        self.assertNotIn('-12,11', wrapped)

        history.append({'entered': True, 'turn': 27, 'from': tip, 'to': '3,8', 'unit': archer})
        gone = panels.panel_occupancy(config, radius, history, ply=29)
        self.assertNotIn('rbr4', {u['uid'] for u in gone.values()})


class PointsTestCase(TestCase):
    """
    Points, added up from the history rather than tallied in each browser.

    Every source and sink of a point is on a record, so the server can price the
    wrap against the same number both players are shown - and a reload no longer
    loses them.
    """

    def _cfg(self):
        return load_config(None)

    def test_a_point_for_every_turn_begun(self):
        """White's first turn begins at ply 1, black's at ply 2."""
        config = self._cfg()
        self.assertEqual([economy.points_of('white', p, [], config) for p in (1, 2, 3, 4)],
                         [1, 1, 2, 2])
        self.assertEqual([economy.points_of('black', p, [], config) for p in (1, 2, 3, 4)],
                         [0, 1, 1, 2])

    def test_each_phase_pays_its_number_a_turn_from_its_halftime(self):
        """
        1 a turn to Phase 2's halftime, 2 from it, 3 from Phase 3's, and
        nothing in overtime - and each phase's grant as it begins: 10, 20, 30.
        *The owner, 24 Sep 2026: "1x, 2x, 3x regular point accumation now
        happens at the start of half time of each phase instead of start of a
        phase"*, *"OT stops gaining points"*, and *"at the start of each phase
        (not start of each postmatch), +10 regular points for phase 1, 20 for
        phase 2, 30 for phase 3."*

        The sums straddle each halftime and each phase's start, which is where
        a rate or a grant read off the wrong turn would show.
        """
        config = self._cfg()
        white = [economy.points_of('white', 2 * t - 1, [], config)
                 for t in (3, 4, 8, 9, 14, 15, 19, 20, 26, 30, 31, 36, 37, 50)]
        # The rates: 19 at one apiece, 11 x 2 (to 41), 6 x 3 (to 59). The
        # grants: 10 on turn 4, 20 on turn 15, 30 on turn 26. Then nothing.
        self.assertEqual(white, [3, 14, 18, 19, 24, 45, 49, 51, 93, 101, 104, 119, 119, 119])
        # Black is paid at the start of its OWN turn, one hand-over behind -
        # grant and all.
        self.assertEqual(economy.points_of('black', 2 * 4 - 1, [], config), 3)
        self.assertEqual(economy.points_of('black', 2 * 4, [], config), 14)
        self.assertEqual(economy.points_of('black', 2 * 20 - 1, [], config), 49)
        self.assertEqual(economy.points_of('black', 2 * 20, [], config), 51)
        # And what one of white's turns pays: the sum at its ply less the sum
        # before it - the rate, and on a phase's first turn its grant too.
        def pay(turn):
            return (phases.turn_points_by('white', 2 * turn - 1)
                    - phases.turn_points_by('white', 2 * turn - 2))
        self.assertEqual([pay(t) for t in (1, 8, 9, 16, 19, 20, 30, 31, 36, 37, 50, 500)],
                         [1, 1, 1, 1, 1, 2, 2, 3, 3, 0, 0, 0])
        self.assertEqual([pay(t) for t in (4, 15, 26)], [1 + 10, 1 + 20, 2 + 30])

    def test_the_victory_points_turn_into_points_as_overtime_begins(self):
        """
        *The owner, 24 Sep 2026: "at the start of the overtime, all your
        accumlated victory points turn into regular points."* Paid like a
        turn's own point - as the side's first overtime turn begins, white on
        hand-over 73 and black on 74 - and once.
        """
        config = self._cfg()
        # 14 against 4: ten clear, not more, so it goes to overtime.
        bank = {'1': {'white': 5, 'black': 1}, '2': {'white': 9, 'black': 0},
                '3': {'white': 0, 'black': 3}}
        before = economy.points_of('white', 72, [], config, bank)
        self.assertEqual(before, 119)
        self.assertEqual(economy.points_of('white', 73, [], config, bank), 119 + 14)
        self.assertEqual(economy.points_of('white', 99, [], config, bank), 119 + 14)
        # Black's first overtime turn is the hand-over after white's.
        self.assertEqual(economy.points_of('black', 73, [], config, bank), 119)
        self.assertEqual(economy.points_of('black', 74, [], config, bank), 119 + 4)
        # No bank, nothing to convert.
        self.assertEqual(economy.points_of('white', 73, [], config), 119)
        # And a match won on points ends ON hand-over 73, never reaching
        # overtime: its finished position converts nothing.
        won = {'1': {'white': 30, 'black': 0}, '2': {'white': 0, 'black': 0},
               '3': {'white': 0, 'black': 0}}
        self.assertEqual(economy.points_of('white', 73, [], config, won), 119)

    def test_a_kill_pays_the_dead_unit_s_worth_and_a_counter_kill_pays_the_defender(self):
        """
        *The owner, 24 Sep 2026: "anytime a unit is killed, i get the amount of
        regular points which the one i killed is worth"* - it was 1 a kill.
        """
        config = self._cfg()
        history = [
            {'color': 'white', 'unit_id': 'pawn', 'captured': 'queen', 'defender_eliminated': True},
            {'color': 'black', 'unit_id': 'knight', 'attacker_eliminated': True},
        ]
        # Ply 1's point, the queen white took (30), and the knight black lost
        # attacking into white's counter (12).
        self.assertEqual(economy.points_of('white', 1, history, config), 1 + 30 + 12)
        self.assertEqual(economy.points_of('black', 1, history, config), 0)

    def test_a_kill_in_a_panel_pays_nobody(self):
        """
        *The owner: killing in a base "should not ... award points for the
        killer. in green panel it doesnt award points if the unit in there
        kills or gets killed for any player."* What it does to the victory
        points is ScoringTestCase's.
        """
        config = self._cfg()
        into = {'intoPanel': True, 'panelAttack': True, 'color': 'white'}
        history = [
            # Into black's base: its queen dies.
            {**into, 'panel': 'tr', 'unit_id': 'pawn', 'captured': 'queen',
             'defender_eliminated': True},
            # Into black's reserve: its pawn dies ...
            {**into, 'panel': 'tl', 'unit_id': 'knight', 'captured': 'pawn',
             'defender_eliminated': True},
            # ... and a reserve unit's counter kills white's knight.
            {**into, 'panel': 'tl', 'unit_id': 'knight', 'attacker_eliminated': True},
        ]
        self.assertEqual(economy.points_of('white', 1, history, config), 1)
        self.assertEqual(economy.points_of('black', 1, history, config), 0)

    def test_a_cast_that_kills_pays_nothing(self):
        """Only the turn's own action ever paid for a kill in the client."""
        config = self._cfg()
        history = [{'panelEffect': True, 'color': 'white', 'defender_eliminated': True}]
        self.assertEqual(economy.points_of('white', 1, history, config), 1)

    def test_a_round_trip_out_over_the_wrap_and_home_again_costs_nothing(self):
        config = self._cfg()
        wrap = _panel_step('rbl3', 'knight', 'white', '-12,6', '11,1', 15, 'bl',
                           cost=6, price=12)
        home = {'withdrawn': True, 'color': 'white', 'unit_id': 'knight',
                'unit': {'uid': 'rbl3', 'color': 'white'}}
        base = economy.points_of('white', 21, [], config)
        self.assertEqual(economy.points_of('white', 21, [wrap], config), base - 12)
        self.assertEqual(economy.points_of('white', 21, [wrap, home], config), base)
        # And none of it is black's business.
        self.assertEqual(economy.points_of('black', 21, [wrap, home], config),
                         economy.points_of('black', 21, [], config))


class ScoringTestCase(TestCase):
    """
    The phase bank and the schedule's two endings (engine/scoring.py). The
    client's match-score.spec.ts pins the same numbers on the same positions,
    so the two mirrors have one set of answers to agree on.
    """

    PAWN = {'units': {'pawn': {'value': 5}}, 'board': {'radius': 11}}

    def test_the_five_zones_are_nineteen_hexes_each_on_the_shipped_board(self):
        from game.engine import scoring
        zone = scoring.capture_zone_hexes(11)
        self.assertEqual(len(zone), 95)
        for centre in ('0,0', '7,0', '-7,0', '3,-6', '-3,6'):
            self.assertIn(centre, zone)

    def test_a_unit_claims_its_hex_and_the_zone_hexes_beside_it(self):
        from game.engine import scoring
        # In the middle of a zone: its own hex and all six around it.
        alone = {'0,0': {'unit_id': 'pawn', 'color': 'white'}}
        self.assertEqual(scoring.cap_of(alone, 11, 'white'), 7)
        # On a zone's rim: only the zone hexes beside it count.
        rim = {'-5,0': {'unit_id': 'pawn', 'color': 'white'}}
        self.assertEqual(scoring.cap_of(rim, 11, 'white'), 4)
        # Two sides touching cancel the hexes both reach: the two they stand
        # on and the two beside both, which leaves three apiece.
        touching = {**alone, '1,0': {'unit_id': 'pawn', 'color': 'black'}}
        self.assertEqual(scoring.cap_of(touching, 11, 'white'), 3)
        self.assertEqual(scoring.cap_of(touching, 11, 'black'), 3)

    def test_a_loss_is_charged_to_the_phase_it_happened_in(self):
        from game.engine import scoring
        history = [
            # Ply 8, Phase 1: black killed a white pawn.
            {'color': 'black', 'unit_id': 'pawn', 'captured': 'pawn',
             'defender_eliminated': True, 'turn': 8},
            # Ply 31, Phase 2: white's attacker died to the counter.
            {'color': 'white', 'unit_id': 'pawn', 'attacker_eliminated': True, 'turn': 31},
        ]
        self.assertEqual(scoring.deaths_of(self.PAWN, history, 'white', 1), 5)
        self.assertEqual(scoring.deaths_of(self.PAWN, history, 'white', 2), 5)
        self.assertEqual(scoring.deaths_of(self.PAWN, history, 'white'), 10)
        self.assertEqual(scoring.deaths_of(self.PAWN, history, 'black'), 0)

    def test_a_phase_banks_as_its_postmatch_begins_and_once(self):
        from game.engine import scoring
        board = {'0,0': {'unit_id': 'pawn', 'color': 'white'}}
        history = [{'color': 'black', 'unit_id': 'pawn', 'captured': 'pawn',
                    'defender_eliminated': True, 'turn': 8}]
        # Handed to ply 26 or before, Phase 1 is still being played.
        self.assertEqual(scoring.bank_ended_phases({}, self.PAWN, board, history, 26), {})
        # Handed to ply 27 - its postmatch - it is over: 7 held, 5 lost.
        bank = scoring.bank_ended_phases({}, self.PAWN, board, history, 27)
        self.assertEqual(bank, {'1': {'white': 2, 'black': 0}})
        # The postmatch reshuffles the board; the bank is the play's and stays.
        later = scoring.bank_ended_phases(bank, self.PAWN, {}, history, 29)
        self.assertEqual(later, {'1': {'white': 2, 'black': 0}})
        # Phase 2 waits for its own postmatch.
        self.assertNotIn('2', scoring.bank_ended_phases(bank, self.PAWN, board, history, 48))
        self.assertIn('2', scoring.bank_ended_phases(bank, self.PAWN, board, history, 49))

    def test_a_phase_never_banks_below_nothing(self):
        # The owner, 24 Sep 2026: "the total points racked shouldnt go
        # negative by death. max is 0". Deaths can take a phase down to 0 and
        # no further; cap still counts in full against what is left.
        from game.engine import scoring
        self.assertEqual(scoring.phase_total(7, 5, 1), 2)
        self.assertEqual(scoring.phase_total(7, 7, 1), 0)
        self.assertEqual(scoring.phase_total(4, 18, 1), 0)
        self.assertEqual(scoring.phase_total(0, 0, 1), 0)
        # The floor comes before the phase's multiplier: 0 in Phase 3, not -42.
        self.assertEqual(scoring.phase_total(4, 18, 3), 0)
        # A white pawn lost in Phase 1 with nothing held: 0, not -5.
        history = [{'color': 'black', 'unit_id': 'pawn', 'captured': 'pawn',
                    'defender_eliminated': True, 'turn': 8}]
        bank = scoring.bank_ended_phases({}, self.PAWN, {}, history, 27)
        self.assertEqual(bank, {'1': {'white': 0, 'black': 0}})

    def test_cp_is_awarded_off_each_banked_phase_with_the_gap_to_the_side_behind(self):
        # The owner, 24 Sep 2026: the side with the higher total gets
        # phase_x + (mine + theirs), the lower that plus abs(mine - theirs),
        # with phase_x 10, 20, 30. Nothing before a phase banks.
        from game.engine import scoring
        self.assertEqual(scoring.cp_awarded({}, 'white', 10), 0)
        one = {'1': {'white': 12, 'black': 4}}
        self.assertEqual(scoring.cp_awarded(one, 'white', 10), 26)   # 10 + 16
        self.assertEqual(scoring.cp_awarded(one, 'black', 10), 34)   # 10 + 16 + 8
        # Level scores award the two the same: Phase 2 adds 20 + 6 to each.
        two = {**one, '2': {'white': 3, 'black': 3}}
        self.assertEqual(scoring.cp_awarded(two, 'white', 10), 52)
        self.assertEqual(scoring.cp_awarded(two, 'black', 10), 60)
        # Phase 3, nothing scored: its offset alone, 30.
        three = {**two, '3': {'white': 0, 'black': 0}}
        self.assertEqual(scoring.cp_awarded(three, 'white', 10), 82)
        # Only the phase's own scores are compared: black leads the match
        # here, and white, behind in Phase 2, is paid its gap.
        behind = {'1': {'white': 0, 'black': 20}, '2': {'white': 2, 'black': 6}}
        self.assertEqual(scoring.cp_awarded(behind, 'white', 10), (10 + 20 + 20) + (20 + 8 + 4))
        self.assertEqual(scoring.cp_awarded(behind, 'black', 10), (10 + 20) + (20 + 8))
        # The offset is the config's; a late phase still awards.
        self.assertEqual(scoring.cp_awarded(one, 'white', 5), 21)
        late = {'1': {'white': 2, 'black': 2, 'late': True}}
        self.assertEqual(scoring.cp_awarded(late, 'black', 10), 14)

    def test_a_phase_s_score_is_multiplied_by_its_number(self):
        # The owner, 24 Sep 2026: "the total victory points for each phase is
        # multiplied by 2 on phase 2, multipled by 3 on phase 3".
        from game.engine import scoring
        self.assertEqual([scoring.phase_total(7, 5, p) for p in (1, 2, 3)], [2, 4, 6])
        # Banked that way: one pawn in the middle holds 7, every phase.
        board = {'0,0': {'unit_id': 'pawn', 'color': 'white'}}
        bank = scoring.bank_ended_phases({}, self.PAWN, board, [], 27)
        bank = scoring.bank_ended_phases(bank, self.PAWN, board, [], 49)
        bank = scoring.bank_ended_phases(bank, self.PAWN, board, [], 71)
        self.assertEqual([bank[p]['white'] for p in ('1', '2', '3')], [7, 14, 21])

    def test_a_unit_killed_in_a_base_costs_nothing_and_in_a_reserve_counts(self):
        # The owner, 24 Sep 2026: "killing things in base (red panel) should
        # not count towards victory points ... in green panel it ... counts
        # towards victory points".
        from game.engine import scoring
        blow = {'intoPanel': True, 'panelAttack': True, 'color': 'white', 'unit_id': 'pawn',
                'captured': 'pawn', 'defender_eliminated': True, 'turn': 8}
        self.assertEqual(scoring.deaths_of(self.PAWN, [{**blow, 'panel': 'tr'}], 'black', 1), 0)
        self.assertEqual(scoring.deaths_of(self.PAWN, [{**blow, 'panel': 'tl'}], 'black', 1), 5)
        # A reserve's counter that kills the attacker counts against the
        # attacker's side.
        counter = {'intoPanel': True, 'panel': 'tl', 'color': 'white', 'unit_id': 'pawn',
                   'attacker_eliminated': True, 'turn': 8}
        self.assertEqual(scoring.deaths_of(self.PAWN, [counter], 'white', 1), 5)

    def test_the_margins_decide_on_points_or_send_it_to_overtime(self):
        from game.engine import scoring

        def settle(white, black):
            return scoring.decided_on_points({
                '1': {'white': white, 'black': black},
                '2': {'white': 0, 'black': 0}, '3': {'white': 0, 'black': 0}})

        # White has to be more than 10 clear; black only more than 5.
        self.assertEqual(settle(11, 0), 'white')
        self.assertIsNone(settle(10, 0))
        self.assertEqual(settle(0, 6), 'black')
        self.assertIsNone(settle(0, 5))
        # Nothing is decided on two phases of three.
        self.assertIsNone(scoring.decided_on_points({'1': {'white': 99, 'black': 0}}))

    def test_points_end_it_as_phase_three_banks_and_turn_fifty_ends_it_for_black(self):
        from game.engine import scoring
        clear = {'1': {'white': 12, 'black': 0}, '2': {'white': 0, 'black': 0},
                 '3': {'white': 0, 'black': 0}}
        level = {**clear, '1': {'white': 0, 'black': 0}}
        # All three in and white past the margin: known from the hand-over
        # into Phase 3's postmatch (ply 71), but the postmatch is played, and
        # the match ends on the hand-over out of it, into turn 37 (ply 73).
        self.assertIsNone(scoring.schedule_ending(clear, 71))
        self.assertIsNone(scoring.schedule_ending(clear, 72))
        self.assertEqual(scoring.schedule_ending(clear, 73), ('white', 'points'))
        self.assertIsNone(scoring.schedule_ending(level, 73))
        # Turn 50 is played out first: its hand-overs are 99 and 100, and a
        # level match ends on the hand-over into turn 51, black's.
        self.assertIsNone(scoring.schedule_ending(level, 100))
        self.assertEqual(scoring.schedule_ending(level, 101), ('black', 'overtime'))

    def test_a_phase_banked_after_its_moment_is_late_and_decides_nothing(self):
        from game.engine import scoring
        board = {'0,0': {'unit_id': 'pawn', 'color': 'white'}}
        # Banked on the hand-over into its postmatch: on time.
        self.assertNotIn('late', scoring.bank_ended_phases({}, self.PAWN, board, [], 27)['1'])
        # Banked a hand-over later - a room that was mid-game when the bank
        # moved to the engines - it is marked, and so is every phase banked
        # with it.
        late = scoring.bank_ended_phases({}, self.PAWN, board, [], 72)
        self.assertEqual({k: v.get('late') for k, v in late.items()},
                         {'1': True, '2': True, '3': True})
        # A bank with a late phase in it decides nothing on points, however
        # clear it reads - and a late Phase 1 spoils an on-time Phase 3.
        clear_but_late = {'1': {'white': 12, 'black': 0, 'late': True},
                          '2': {'white': 0, 'black': 0}, '3': {'white': 0, 'black': 0}}
        self.assertIsNone(scoring.decided_on_points(clear_but_late))
        self.assertIsNone(scoring.schedule_ending(clear_but_late, 73))
        # Turn 50 still ends it: that rule needs no score.
        self.assertEqual(scoring.schedule_ending(clear_but_late, 101), ('black', 'overtime'))
