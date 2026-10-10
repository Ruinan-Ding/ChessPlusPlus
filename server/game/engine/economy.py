"""Separate ability points and unit points (UP), derived from schedule and history."""

from __future__ import annotations
from .game_rules import section_of
from .scoring import casualty_zone

from typing import Any, Dict, Iterable, Optional

from .config_loader import rule_of
from .scoring import scheduled_points, unit_value
from .unit_stats import active_vet, cap_stat, unit_stats


def points_of(
    color: str,
    ply: int,
    history: Iterable[Dict[str, Any]],
    config: Dict[str, Any],
    bank: Optional[Dict[str, Any]] = None,
) -> int:
    """Scheduled ability income; the authoritative ability state records cast spending."""
    return scheduled_points(bank, color, ply, config)


def withdrawal_refund(config: Dict[str, Any], unit: Dict[str, Any]) -> int:
    """Use withdrawal HP; later healing or wounds do not reprice the refund."""
    maximum = cap_stat(unit.get('max_hp', unit_stats(unit['unit_id'], config, active_vet(unit, config)).get('hp', unit.get('hp', 0))))
    missing = max(0, maximum - cap_stat(unit.get('hp', maximum)))
    settings = section_of(config, 'economy')['walkHomeRefund']
    return max(settings['minimum'], unit_value(config, unit['unit_id']) * settings['valueMultiplier'] - settings['fee'] - missing * settings['missingHpMultiplier'])


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
                points += move.get('refund', withdrawal_refund(config, {'unit_id': move.get('unit_id'), **(move.get('unit') or {})}))
        # A blow into a panel pays nobody, whichever side dies of it.
        if casualty_zone(move) not in section_of(config, 'economy')['killPayZones']:
            continue
        if move.get('defender_eliminated') and move.get('color') == color:
            points += unit_value(config, move.get('captured')) * section_of(config, 'economy')['killPayMultiplier']
        # The attacker died of the counter: its worth goes to the defender.
        if move.get('attacker_eliminated') and move.get('color') == other:
            points += unit_value(config, move.get('unit_id')) * section_of(config, 'economy')['killPayMultiplier']
    return points
