"""
Unit tests for the game engine: board, config_loader, move_validator, game_logic.

These are plain Django TestCase tests that exercise the pure-Python engine
modules without needing WebSocket or async infrastructure.
"""

from django.test import TestCase
from typing import Any, Dict

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
    find_defeated,
    ranged_damage,
    resolve_combat,
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
        self.assertEqual(len(board.pieces_by_color('white')), 13)
        self.assertEqual(len(board.pieces_by_color('black')), 13)

    def test_build_initial_board_has_kings(self):
        config = load_config(None)
        board = build_initial_board(config)
        # Check directly that king units exist on the board
        white_king_cell = board.get(-5, 11)
        black_king_cell = board.get(5, -11)
        assert white_king_cell is not None
        assert black_king_cell is not None
        self.assertEqual(white_king_cell['unit_id'], 'king')
        self.assertEqual(white_king_cell['color'], 'white')
        self.assertEqual(black_king_cell['unit_id'], 'king')
        self.assertEqual(black_king_cell['color'], 'black')

    def test_build_initial_board_units_have_hp(self):
        config = load_config(None)
        board = build_initial_board(config)
        white_king = board.get(-5, 11)
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

    def test_blocked_by_own_piece(self):
        board = self._make_board()
        board.set(0, 0, 'unit', 'white')
        board.set(1, 0, 'pawn', 'white')  # occupies a neighbour
        # move=2: not enough budget to detour around the blocker to (2,0).
        moves = get_legal_moves(board, (0, 0), self._cfg(move=2), 'white')
        self.assertNotIn((1, 0), moves)  # can't land on it
        self.assertNotIn((2, 0), moves)  # can't pass through it either

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

    def test_default_config_units_all_move_six(self):
        """Placeholder rule: every unit in DEFAULT_CONFIG currently gets move=6."""
        config = load_config(None)
        for unit_id, unit_def in config['units'].items():
            self.assertEqual(unit_def.get('move'), 6, unit_id)


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

    def test_armour_can_absorb_a_hit_entirely(self):
        """Defence above the attack stat means no damage - never healing."""
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=20, max_hp=20)
        board.set(1, 0, 'king', 'black', hp=45, max_hp=45)  # defence 15 > pawn attack 14

        result = resolve_combat(board, (0, 0), (1, 0), self._cfg())

        self.assertEqual(result['damage_dealt'], 0)
        self.assertEqual(result['defender_hp'], 45)

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
