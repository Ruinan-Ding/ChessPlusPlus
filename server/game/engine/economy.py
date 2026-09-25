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
a side's turn begins    its rate, and a phase's grant on its first turn
                        of the phase (``beginTurnFor``)
overtime begins         its banked victory points, once
a kill on the board     +the dead unit's ``value`` to the side that made
                        it; a counter-attack that kills the attacker pays
                        the defender's side
a kill in a panel       nothing, base or reserve, whoever dies
walking home            +the unit's ``value`` (the homecoming refund)
the wrap                -the unit's ``value`` (the crossing's price)
=====================  ==============================================

*The owner, 24 Sep 2026: "anytime a unit is killed, i get the amount of
regular points which the one i killed is worth"* - and a panel's kills pay
nobody: *"killing things in base (red panel) should not ...
award points for the killer. in green panel it doesnt award points if the
unit in there kills or gets killed for any player."* A cast that kills still
pays nothing: casts are not on the record.

A round trip - wrap out, walk home - is points-neutral, which is the point of
the refund.

Pool abilities are bought with points too, but abilities are still the client's
alone; nothing a networked game records spends a point on one yet. When they
move to the server, their casts belong in this sum.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

from .scoring import scheduled_points, unit_value


def points_of(
    color: str,
    ply: int,
    history: Iterable[Dict[str, Any]],
    config: Dict[str, Any],
    bank: Optional[Dict[str, Any]] = None,
) -> int:
    """
    What *color* has to spend at *ply*, the hand-over about to be played.

    A turn "begun" counts from its first ply, so white has one to spend on the
    very first move of the match and black has none until its own turn starts -
    the same moment `beginTurnFor` handed the point out.

    **What the schedule pays is its own business**, not a literal here: the
    turn's rate, a phase's grant and the victory points at overtime all come
    from :func:`scoring.scheduled_points`, and the client's `beginTurnFor` -
    which hands the same out live, before this sum resets the tally - reads
    the same sum through `scheduledPoints`.
    """
    other = 'black' if color == 'white' else 'white'
    # *bank* is the state row's phase_bank: from its first overtime turn a
    # side is paid what it banked.
    points = scheduled_points(bank, color, ply)
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
                points += unit_value(config, move.get('unit_id'))
            continue
        # A blow into a panel pays nobody, whichever side dies of it.
        if move.get('intoPanel'):
            continue
        if move.get('defender_eliminated') and move.get('color') == color:
            points += unit_value(config, move.get('captured'))
        # The attacker died of the counter: its worth goes to the defender.
        if move.get('attacker_eliminated') and move.get('color') == other:
            points += unit_value(config, move.get('unit_id'))
    return points
