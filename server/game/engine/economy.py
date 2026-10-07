"""Separate ability points and unit points (UP), derived from schedule and history."""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

from .config_loader import rule_of
from .scoring import scheduled_points, unit_value


def points_of(
    color: str,
    ply: int,
    history: Iterable[Dict[str, Any]],
    config: Dict[str, Any],
    bank: Optional[Dict[str, Any]] = None,
) -> int:
    """Regular ability points: scheduled income; online casts remain deferred."""
    return scheduled_points(bank, color, ply)


def unit_points_of(color: str, history: Iterable[Dict[str, Any]], config: Dict[str, Any]) -> int:
    """UP starts at the room's configured amount and follows committed unit transactions."""
    other = 'black' if color == 'white' else 'white'
    points = rule_of(config, 'upAtStart')
    for move in history or []:
        if not isinstance(move, dict):
            continue
        if move.get('halftimeUp'):
            points += move['halftimeUp'][color]
        # A cast into a panel records what it did to a unit, but the client
        # never paid for a kill made that way - only the turn's own action.
        if (move.get('unitCast') or {}).get('color') == color:
            points += int(move['unitCast'].get('gain') or 0) - int(move['unitCast'].get('cost') or 0)
        if move.get('panelEffect') or move.get('entered') or move.get('abilityDeath'):
            continue
        if move.get('panelMove'):
            if (move.get('unit') or {}).get('color') == color:
                points -= int(move.get('price') or 0)
            continue
        if move.get('withdrawn'):
            if move.get('refundColor', move.get('color')) == color:
                points += unit_value(config, move.get('unit_id'))
        # A blow into a panel pays nobody, whichever side dies of it.
        if move.get('intoPanel'):
            continue
        if move.get('defender_eliminated') and move.get('color') == color:
            points += unit_value(config, move.get('captured'))
        # The attacker died of the counter: its worth goes to the defender.
        if move.get('attacker_eliminated') and move.get('color') == other:
            points += unit_value(config, move.get('unit_id'))
    return points
