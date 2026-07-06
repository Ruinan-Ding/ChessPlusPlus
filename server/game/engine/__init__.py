"""
Game engine package for ChessPlusPlus.

Provides board management, config loading, move validation, and
game logic (combat resolution, elimination detection) for a
Fire-Emblem-style hex-grid tactical game using axial coordinates (q, r).
"""

from .board import HexBoard
from .config_loader import load_config, build_initial_board, DEFAULT_CONFIG
from .move_validator import get_legal_moves, is_legal_move
from .game_logic import (
    resolve_combat,
    is_attacked,
    get_legal_moves_filtered,
    has_any_legal_move,
    detect_outcome,
)

__all__ = [
    'HexBoard',
    'load_config',
    'build_initial_board',
    'DEFAULT_CONFIG',
    'get_legal_moves',
    'is_legal_move',
    'resolve_combat',
    'is_attacked',
    'get_legal_moves_filtered',
    'has_any_legal_move',
    'detect_outcome',
]
