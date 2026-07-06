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
    KNIGHT_OFFSETS,
)
from game.engine.game_logic import (
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
        self.assertEqual(config['board']['radius'], 23)
        self.assertIn('king', config['units'])
        self.assertIn('pawn', config['units'])

    def test_default_config_is_deep_copy(self):
        c1 = load_config(None)
        c2 = load_config(None)
        c1['board']['radius'] = 99
        self.assertEqual(c2['board']['radius'], 23)

    def test_build_initial_board_piece_count(self):
        config = load_config(None)
        board = build_initial_board(config)
        self.assertEqual(len(board.pieces_by_color('white')), 13)
        self.assertEqual(len(board.pieces_by_color('black')), 13)

    def test_build_initial_board_has_kings(self):
        config = load_config(None)
        board = build_initial_board(config)
        # Check directly that king units exist on the board
        white_king_cell = board.get(-11, 23)
        black_king_cell = board.get(11, -23)
        assert white_king_cell is not None
        assert black_king_cell is not None
        self.assertEqual(white_king_cell['unit_id'], 'king')
        self.assertEqual(white_king_cell['color'], 'white')
        self.assertEqual(black_king_cell['unit_id'], 'king')
        self.assertEqual(black_king_cell['color'], 'black')

    def test_build_initial_board_units_have_hp(self):
        config = load_config(None)
        board = build_initial_board(config)
        white_king = board.get(-11, 23)
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
                         'movement': [{'direction': 'E', 'range': 1}], 'value': 0}
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


# ---------------------------------------------------------------------------
# Move validator tests
# ---------------------------------------------------------------------------

class MoveValidatorTestCase(TestCase):
    """Tests for per-piece move generation."""

    def _make_board(self, radius: int = 5) -> HexBoard:
        return HexBoard(radius)

    def _cfg(self) -> Dict[str, Any]:
        return load_config(None)

    # -- King --

    def test_king_moves_centre(self):
        board = self._make_board()
        board.set(0, 0, 'king', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        # King at centre should have exactly 6 moves
        self.assertEqual(len(moves), 6)
        for m in moves:
            self.assertEqual(hex_distance((0, 0), m), 1)

    def test_king_blocked_by_own_pieces(self):
        board = self._make_board()
        board.set(0, 0, 'king', 'white')
        # Surround with own pawns
        for dq, dr in HEX_DIRECTIONS.values():
            board.set(dq, dr, 'pawn', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertEqual(len(moves), 0)

    def test_king_can_capture_enemy(self):
        board = self._make_board()
        board.set(0, 0, 'king', 'white')
        board.set(1, 0, 'pawn', 'black')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertIn((1, 0), moves)

    # -- Queen --

    def test_queen_slides_all_directions(self):
        board = self._make_board()
        board.set(0, 0, 'queen', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        # From centre of radius-5, queen can reach many hexes
        self.assertGreater(len(moves), 20)
        # Check specific far hexes
        self.assertIn((5, 0), moves)    # E edge
        self.assertIn((-5, 0), moves)   # W edge
        self.assertIn((0, -5), moves)   # NW edge
        self.assertIn((0, 5), moves)    # SE edge

    def test_queen_blocked_by_own_piece(self):
        board = self._make_board()
        board.set(0, 0, 'queen', 'white')
        board.set(2, 0, 'pawn', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertIn((1, 0), moves)    # can reach 1 step E
        self.assertNotIn((2, 0), moves)  # blocked by own pawn
        self.assertNotIn((3, 0), moves)  # behind own pawn

    def test_queen_can_capture_then_stop(self):
        board = self._make_board()
        board.set(0, 0, 'queen', 'white')
        board.set(2, 0, 'pawn', 'black')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertIn((1, 0), moves)
        self.assertIn((2, 0), moves)    # capture
        self.assertNotIn((3, 0), moves)  # can't go past

    # -- Rook --

    def test_rook_slides(self):
        board = self._make_board()
        board.set(0, 0, 'rook', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        # Rook config uses same 6 directions with range 0 (unlimited)
        self.assertIn((5, 0), moves)
        self.assertIn((-5, 0), moves)

    # -- Bishop (hex diagonal) --

    def test_bishop_slides_diagonals(self):
        board = self._make_board()
        board.set(0, 0, 'bishop', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        # Bishop should only reach diagonal hexes
        self.assertGreater(len(moves), 0)
        # One diagonal axis: (+1,+1), (+2,+2) etc.
        self.assertIn((1, 1), moves)
        self.assertIn((2, 2), moves)
        # Another axis: (+2,-1), (+4,-2)
        self.assertIn((2, -1), moves)
        self.assertIn((4, -2), moves)
        # Cardinal directions should NOT be reachable
        self.assertNotIn((1, 0), moves)
        self.assertNotIn((0, 1), moves)

    def test_bishop_blocked(self):
        board = self._make_board()
        board.set(0, 0, 'bishop', 'white')
        board.set(1, 1, 'pawn', 'white')  # blocks (+1,+1) diagonal
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertNotIn((1, 1), moves)
        self.assertNotIn((2, 2), moves)

    # -- Knight --

    def test_knight_has_12_offsets(self):
        self.assertEqual(len(KNIGHT_OFFSETS), 12)

    def test_knight_moves_centre(self):
        board = self._make_board()
        board.set(0, 0, 'knight', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        # All 12 offsets should be valid from centre of radius-5
        self.assertEqual(len(moves), 12)
        for m in moves:
            d = hex_distance((0, 0), m)
            self.assertIn(d, [2, 3])  # knight offsets are distance 2 or 3

    def test_knight_can_jump_over_pieces(self):
        board = self._make_board()
        board.set(0, 0, 'knight', 'white')
        # Surround with own pieces
        for dq, dr in HEX_DIRECTIONS.values():
            board.set(dq, dr, 'pawn', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        # Knight can jump, so it should still have moves
        self.assertGreater(len(moves), 0)

    def test_knight_cannot_land_on_own(self):
        board = self._make_board()
        board.set(0, 0, 'knight', 'white')
        # Place own piece on one knight target
        target = KNIGHT_OFFSETS[0]
        board.set(*target, 'pawn', 'white')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertNotIn(target, moves)

    # -- Pawn (white) --

    def test_white_pawn_moves_forward(self):
        board = self._make_board()
        board.set(0, 4, 'pawn', 'white')
        moves = get_legal_moves(board, (0, 4), self._cfg(), 'white')
        # White pawn moveOnly direction is NW (0,-1) → target (0,3)
        self.assertIn((0, 3), moves)

    def test_white_pawn_cannot_move_to_occupied(self):
        board = self._make_board()
        board.set(0, 4, 'pawn', 'white')
        board.set(0, 3, 'pawn', 'black')  # block forward
        moves = get_legal_moves(board, (0, 4), self._cfg(), 'white')
        self.assertNotIn((0, 3), moves)

    def test_white_pawn_captures_diagonally(self):
        board = self._make_board()
        board.set(0, 4, 'pawn', 'white')
        # Capture-only directions for white: NE(+1,-1) and NW(0,-1)
        # But NW is also move-only... let's check what's in the config
        # Config pawn: moveOnly NW, captureOnly NE, captureOnly NW
        # So NE capture target from (0,4) is (1,3)
        board.set(1, 3, 'pawn', 'black')
        moves = get_legal_moves(board, (0, 4), self._cfg(), 'white')
        self.assertIn((1, 3), moves)

    # -- Pawn (black) --

    def test_black_pawn_moves_opposite(self):
        board = self._make_board()
        board.set(0, -4, 'pawn', 'black')
        moves = get_legal_moves(board, (0, -4), self._cfg(), 'black')
        # Black flips NW→SE, so forward is SE (0,+1) → target (0,-3)
        self.assertIn((0, -3), moves)

    # -- Edge cases --

    def test_empty_square_returns_no_moves(self):
        board = self._make_board()
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertEqual(moves, [])

    def test_wrong_color_returns_no_moves(self):
        board = self._make_board()
        board.set(0, 0, 'king', 'black')
        moves = get_legal_moves(board, (0, 0), self._cfg(), 'white')
        self.assertEqual(moves, [])

    def test_is_legal_move_helper(self):
        board = self._make_board()
        board.set(0, 0, 'king', 'white')
        self.assertTrue(is_legal_move(board, (0, 0), (1, 0), self._cfg(), 'white'))
        self.assertFalse(is_legal_move(board, (0, 0), (3, 0), self._cfg(), 'white'))


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

    def test_resolve_combat_attack_eliminates(self):
        """Attacker kills defender (damage >= HP) and moves in."""
        board = HexBoard(5)
        board.set(0, 0, 'queen', 'white', hp=8, max_hp=8)  # attack=6
        board.set(1, 0, 'pawn', 'black', hp=4, max_hp=4)   # 4 HP < 6 atk
        config = self._cfg()
        result = resolve_combat(board, (0, 0), (1, 0), config)
        self.assertTrue(result['attacked'])
        self.assertTrue(result['defender_eliminated'])
        self.assertTrue(result['moved'])
        self.assertEqual(result['damage_dealt'], 6)
        self.assertIsNone(board.get(0, 0))  # vacated
        piece = board.get(1, 0)
        assert piece is not None
        self.assertEqual(piece['unit_id'], 'queen')  # attacker moved in

    def test_resolve_combat_attack_defender_survives(self):
        """Defender survives; attacker stays put."""
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=4, max_hp=4)  # attack=2
        board.set(1, 0, 'rook', 'black', hp=12, max_hp=12)  # 12 HP > 2 atk
        config = self._cfg()
        result = resolve_combat(board, (0, 0), (1, 0), config)
        self.assertTrue(result['attacked'])
        self.assertFalse(result['defender_eliminated'])
        self.assertFalse(result['moved'])  # attacker stays
        self.assertEqual(result['damage_dealt'], 2)
        self.assertEqual(result['defender_hp'], 10)  # 12 - 2
        # Both pieces still on the board
        self.assertIsNotNone(board.get(0, 0))
        self.assertIsNotNone(board.get(1, 0))

    def test_resolve_combat_exact_lethal(self):
        """Damage exactly equals HP → elimination."""
        board = HexBoard(5)
        board.set(0, 0, 'pawn', 'white', hp=4, max_hp=4)  # attack=2
        board.set(1, 0, 'pawn', 'black', hp=2, max_hp=4)  # 2 HP == 2 atk
        config = self._cfg()
        result = resolve_combat(board, (0, 0), (1, 0), config)
        self.assertTrue(result['defender_eliminated'])
        self.assertTrue(result['moved'])

    # -- is_attacked (kept, it still works) --------------------------------

    def test_is_attacked_by_queen(self):
        board = HexBoard(5)
        board.set(0, 0, 'queen', 'white')
        config = self._cfg()
        self.assertTrue(is_attacked(board, (5, 0), 'white', config))
        # (1,1) is a diagonal — queen slides cardinals only
        self.assertFalse(is_attacked(board, (1, 1), 'white', config))

    def test_bishop_attacks_diagonal(self):
        board = HexBoard(5)
        board.set(0, 0, 'bishop', 'white')
        config = self._cfg()
        self.assertTrue(is_attacked(board, (2, -1), 'white', config))
        self.assertFalse(is_attacked(board, (1, 0), 'white', config))

    # -- Legal moves (no self-check filter in tactical mode) ---------------

    def test_legal_moves_no_pin_restriction(self):
        """In tactical RPG mode, there is no pin — pieces move freely."""
        board = HexBoard(5)
        board.set(0, 0, 'king', 'white', hp=10, max_hp=10)
        board.set(1, 0, 'rook', 'white', hp=12, max_hp=12)
        board.set(4, 0, 'rook', 'black', hp=12, max_hp=12)
        config = self._cfg()

        moves = get_legal_moves_filtered(board, (1, 0), config, 'white')
        # The rook should be able to move off the E/W axis freely
        off_axis = [m for m in moves if m[1] != 0]
        self.assertGreater(len(off_axis), 0, "Rook should move freely — no pins")

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
