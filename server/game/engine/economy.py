"""
Points: what a side has to spend on the wrap, and what it is paid back.

**Derived, not tallied**, like the panels. The client used to keep points as a
running count in each browser - saved to localStorage, restored only in a solo
room, and so lost on a reload in a networked one, and free to disagree between
the two players' screens. Every source and every sink of a point is written into
the move history, so this adds them up from it instead, and there is nothing to
fall out of step.

What earns a point, and what spends one - mirroring every `awardPoints` in
game-room.component.ts:

=====================  ==============================================
a side's turn begins    +1 (``beginTurnFor``)
a kill                  +1 to the side that made it; a counter-attack
                        that kills the attacker pays the defender's side
walking home            +the unit's ``value`` (the homecoming refund)
the wrap                -the unit's ``value`` (the crossing's price)
=====================  ==============================================

A round trip - wrap out, walk home - is points-neutral, which is the point of
the refund.

Pool abilities are bought with points too, but abilities are still the client's
alone; nothing a networked game records spends a point on one yet. When they
move to the server, their casts belong in this sum.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable

from .phases import hand_overs_by


def points_of(
    color: str,
    ply: int,
    history: Iterable[Dict[str, Any]],
    config: Dict[str, Any],
) -> int:
    """
    What *color* has to spend at *ply*, the hand-over about to be played.

    A turn "begun" counts from its first ply, so white has one to spend on the
    very first move of the match and black has none until its own turn starts -
    the same moment `beginTurnFor` handed the point out.
    """
    units = (config or {}).get('units') or {}
    other = 'black' if color == 'white' else 'white'
    points = hand_overs_by(color, ply)
    for move in history or []:
        if not isinstance(move, dict):
            continue
        # A cast into a panel records what it did to a unit, but the client
        # never paid for a kill made that way - only the turn's own action.
        if move.get('panelEffect') or move.get('entered'):
            continue
        if move.get('panelMove'):
            if (move.get('unit') or {}).get('color') == color:
                points -= int(move.get('price') or 0)
            continue
        if move.get('withdrawn'):
            if move.get('color') == color:
                points += int((units.get(move.get('unit_id')) or {}).get('value', 0) or 0)
            continue
        if move.get('defender_eliminated') and move.get('color') == color:
            points += 1
        # The attacker died of the counter: the point goes to the defender.
        if move.get('attacker_eliminated') and move.get('color') == other:
            points += 1
    return points
