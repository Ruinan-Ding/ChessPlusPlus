"""
The match's score, and how the schedule ends it. Mirrors
``client/src/app/services/match-score.ts`` - keep the two in step.

Three numbered phases each bank a score: the capture hexes a side holds as
the phase's play ends, less what its units were worth that died in the phase.
The three are summed, and the match ends in one of two ways the owner set
out:

* **On points, when Phase 3 banks.** A side more than the other's margin
  clear takes it outright (:data:`OVERTIME_MARGIN`). Anything closer goes to
  overtime.
* **At the end of turn 50.** Overtime is a deathmatch until a king falls, and
  *"if both survives, black wins."*

Both used to live in the room's header alone - read, never enforced - because
the score lived in the browser: a client that was not watching when a phase
ended banked nothing, and the server had no score to end a match on. The bank
is kept here now, on the state row, and the header shows the server's.

The capture zones are the client's ``captureZoneHexes`` / ``captureClaims`` /
``captureScore`` in ``hex-rules.ts``, ported onto this engine's own geometry
(``board.py``). Two places where a straight transliteration would be wrong,
and is not:

* ``Math.round`` rounds a half up; Python's ``round`` rounds it to even.
  :func:`_js_round` is the JS one. (No shipped radius lands on a half, so the
  two agree today - this keeps them agreeing on any radius.)
* A bank that went through JSON has string keys: ``{"1": ...}``. Every key
  here is ``str(phase)`` for that reason.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .board import HEX_DIRECTIONS, coord_key, hex_distance, parse_coord
from .phases import OVERTIME_LAST_TURN, SCORING_PHASES, is_postmatch, phase_index_at, turn_of

#: How far behind a side may finish the third phase and still force overtime.
#: Black is allowed the wider gap because white moves first: white has to be
#: more than 5 clear to take it outright, black only more than 3.
OVERTIME_MARGIN = {'white': 3, 'black': 5}

#: How far out the outer four capture zones sit, as a share of the radius.
ZONE_COLS = 7 / 11
ZONE_ROWS = 6 / 11
#: Rings of hexes around each zone's centre: 2 makes a 19-hex patch.
ZONE_SPREAD = 2

#: What a scoring phase finished on, keyed ``"1"``-``"3"``: each side's
#: score, and ``"late": True`` on a phase banked after its moment.
Bank = Dict[str, Dict[str, Any]]


def _js_round(x: float) -> int:
    """``Math.round``: a half goes up, not to the nearest even."""
    return math.floor(x + 0.5)


_zone_cache: Dict[int, frozenset] = {}


def capture_zone_hexes(radius: int) -> frozenset:
    """
    The five capture zones as one set of ``"q,r"`` keys: a patch in the middle
    and four around it, the same size and the same distance out. Depends on
    nothing but the radius, so it is worked out once per radius.
    """
    cached = _zone_cache.get(radius)
    if cached is not None:
        return cached
    cols = max(ZONE_SPREAD + 1, _js_round(radius * ZONE_COLS))
    pairs = max(1, _js_round((radius * ZONE_ROWS) / 2))
    centres = [
        (0, 0),
        (cols, 0), (-cols, 0),
        (pairs, -2 * pairs), (-pairs, 2 * pairs),
    ]
    hexes = set()
    for cq, cr in centres:
        for dq in range(-ZONE_SPREAD, ZONE_SPREAD + 1):
            lo = max(-ZONE_SPREAD, -dq - ZONE_SPREAD)
            hi = min(ZONE_SPREAD, -dq + ZONE_SPREAD)
            for dr in range(lo, hi + 1):
                q, r = cq + dq, cr + dr
                if hex_distance((q, r), (0, 0)) <= radius:
                    hexes.add(coord_key(q, r))
    out = frozenset(hexes)
    _zone_cache[radius] = out
    return out


def capture_claims(board_state: Dict[str, Any], radius: int) -> Dict[str, str]:
    """
    Who holds each capture hex. A unit standing in a zone takes the hex under
    it and the zone hexes beside it; a hex both sides reach is held by neither.
    Only decided hexes are returned.
    """
    zone = capture_zone_hexes(radius)
    claimed: Dict[str, str] = {}

    def claim(key: str, color: str) -> None:
        held = claimed.get(key)
        if held is None:
            claimed[key] = color
        elif held != color:
            claimed[key] = 'contested'

    for key, piece in (board_state or {}).items():
        if not piece or key not in zone:
            continue
        color = 'black' if piece.get('color') == 'black' else 'white'
        claim(key, color)
        q, r = parse_coord(key)
        for dq, dr in HEX_DIRECTIONS.values():
            neighbour = coord_key(q + dq, r + dr)
            if neighbour in zone:
                claim(neighbour, color)
    return {key: color for key, color in claimed.items() if color != 'contested'}


def capture_score(claims: Dict[str, str], color: str) -> int:
    """A point a hex a side holds."""
    return sum(1 for owner in claims.values() if owner == color)


def cap_of(board_state: Dict[str, Any], radius: int, color: str) -> int:
    """What *color* is holding on *board_state*, right now."""
    return capture_score(capture_claims(board_state, radius), color)


def deaths_of(config: Dict[str, Any], history: Iterable[Dict[str, Any]],
              color: str, phase: Optional[int] = None) -> int:
    """
    What *color*'s losses have cost it: the ``value`` of every unit of its that
    died, in *phase* alone when one is named. A loss counts against the phase
    it happened in and no other, so summing the three never charges one twice.
    The defender belongs to whoever was not moving; a counter-attack kills the
    mover's own unit.
    """
    units = (config or {}).get('units', {}) or {}

    def value(unit_id: Any) -> int:
        if not unit_id:
            return 0
        return (units.get(unit_id) or {}).get('value') or 0

    total = 0
    for move in history or []:
        if phase is not None:
            # A record with no ply is in no scoring phase - the client's
            # phaseIndexAt(undefined) lands past the schedule, on overtime.
            turn = move.get('turn')
            if not isinstance(turn, int) or phase_index_at(turn) != phase:
                continue
        if move.get('defender_eliminated') and move.get('color') != color:
            total += value(move.get('captured'))
        if move.get('attacker_eliminated') and move.get('color') == color:
            total += value(move.get('unit_id'))
    return total


def phase_over(phase: int, ply: int) -> bool:
    """
    Whether a scoring phase is over by *ply*: once its postmatch begins, not
    once the next phase does. The postmatch still counts as the phase's own
    (``phase_index_at``), which is why this asks about it as well as the index.
    """
    now = phase_index_at(ply)
    return phase < now or (phase == now and is_postmatch(ply))


def bank_ended_phases(bank: Optional[Dict[str, Any]], config: Dict[str, Any],
                      board_state: Dict[str, Any], history: List[Dict[str, Any]],
                      ply: int) -> Bank:
    """
    *bank* with every scoring phase that is over by *ply* banked, the rest left
    alone. Called on each hand-over with the ply it hands to and the board it
    leaves: the hand-over into a phase's postmatch is the one moment the board
    still shows how the phase's play finished, before the postmatch's
    crossings and walks home reshape it. A phase already banked is never read
    again.

    **A phase banked after that moment is marked** ``"late": True``. It still
    banks - the header shows it - but off a board that no longer shows how the
    phase finished: a room that was mid-game when the bank moved to the
    engines, or a position built by hand. :func:`decided_on_points` refuses to
    decide a match on a bank with a late phase in it.
    """
    out: Bank = {str(k): dict(v) for k, v in (bank or {}).items()}
    radius = ((config or {}).get('board') or {}).get('radius', 11)
    claims: Optional[Dict[str, str]] = None
    for phase in SCORING_PHASES:
        if str(phase) in out or not phase_over(phase, ply):
            continue
        if claims is None:
            claims = capture_claims(board_state, radius)
        entry: Dict[str, Any] = {
            color: capture_score(claims, color) - deaths_of(config, history, color, phase)
            for color in ('white', 'black')
        }
        # Already over before this hand-over: its moment has passed.
        if phase_over(phase, ply - 1):
            entry['late'] = True
        out[str(phase)] = entry
    return out


def decided_on_points(bank: Optional[Dict[str, Any]]) -> Optional[str]:
    """
    The side the three phases hand the match to outright, or ``None`` - while
    any is unbanked, while the two are close enough for overtime, or while any
    phase was banked late (see :func:`bank_ended_phases`): a score read off
    the wrong board decides nothing.
    """
    entries = [(bank or {}).get(str(phase)) for phase in SCORING_PHASES]
    if not all(entries) or any(entry.get('late') for entry in entries):
        return None
    lead = sum(e['white'] for e in entries) - sum(e['black'] for e in entries)
    if lead > OVERTIME_MARGIN['black']:
        return 'white'
    if -lead > OVERTIME_MARGIN['white']:
        return 'black'
    return None


def schedule_ending(bank: Optional[Dict[str, Any]], ply: int) -> Optional[Tuple[str, str]]:
    """
    ``(winning colour, end reason)`` if the schedule ends the match at *ply* -
    the hand-over just made - or ``None``.

    Asked after the hand-over has banked what it closed, and only when nothing
    on the board ended the match first: a king killed on the turn Phase 3
    banks, or on turn 50, has already decided it.

    * ``'points'``: all three phases are in, none of them late, and one side is
      past the other's margin. That is first true on the hand-over into
      Phase 3's postmatch, which is where a match ends on it.
    * ``'overtime'``: turn 50 has been played out - the hand-over is into
      turn 51 - with both kings standing. Black's.
    """
    points = decided_on_points(bank)
    if points:
        return points, 'points'
    if turn_of(ply) > OVERTIME_LAST_TURN:
        return 'black', 'overtime'
    return None
