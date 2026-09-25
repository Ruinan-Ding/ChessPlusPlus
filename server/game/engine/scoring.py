"""
The match's score, and how the schedule ends it. Mirrors
``client/src/app/services/match-score.ts`` - keep the two in step.

Three numbered phases each bank a score: the capture hexes a side holds as
the phase's play ends, less what its units were worth that died in the phase -
never less than 0, and times the phase's number (:func:`phase_total`). The
three are summed, and the match ends in one of two ways the owner set out:

* **On points, once Phase 3's postmatch is played.** Phase 3 banks as its
  postmatch begins; a side more than the other's margin clear then takes it
  outright (:data:`OVERTIME_MARGIN`) as the postmatch ends. Anything closer
  goes to overtime.
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
from .panels import BASE_PANELS
from .phases import (
    OVERTIME_FIRST_PLY, OVERTIME_LAST_TURN, PHASES, SCORING_PHASES, hand_overs_by, is_postmatch,
    phase_index_at, turn_of, turn_points_by,
)

#: How far behind a side may finish the third phase and still force overtime,
#: keyed by the side behind. Black is allowed the wider gap because white
#: moves first: **white has to be more than 10 clear to take it outright,
#: black only more than 5**. *The owner, 24 Sep 2026: "10 ahead for white and
#: 5 ahead for black to trigger overtime"*.
OVERTIME_MARGIN = {'white': 5, 'black': 10}

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


def unit_value(config: Optional[Dict[str, Any]], unit_id: Any) -> int:
    """
    What a unit is worth, by its config ``value``; 0 for no unit, or one the
    config has no value for. The one reading of it - a kill's pay, a death's
    cost and a walk home's refund all go through here. Mirrors ``unitValue``
    in match-score.ts.
    """
    if not unit_id:
        return 0
    units = (config or {}).get('units') or {}
    return int((units.get(unit_id) or {}).get('value') or 0)


def phase_total(cap: int, deaths: int, multiplier: int) -> int:
    """
    What a scoring phase scores: the capture hexes held, less what its losses
    cost, **never below 0**, and **times the phase's ``multiplier``** - x1 in
    Phase 1, x2 in Phase 2, x3 in Phase 3 (``PHASES``).

    *The owner, 24 Sep 2026: "the total points racked shouldnt go negative by
    death. max is 0"* and *"the total victory points for each phase is
    multiplied by 2 on phase 2, multipled by 3 on phase 3"*. The floor comes
    first: 4 - 18 in Phase 3 is 0, not -42. Everything downstream - the
    match total, the margins, the CP award - reads the multiplied figure.
    """
    return max(0, cap - deaths) * multiplier


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

    **A unit killed in a base (the red panels, ``BASE_PANELS``) costs
    nothing.** *The owner, 24 Sep 2026: "killing things in base (red panel)
    should not count towards victory points"* - while one killed in a reserve
    (green) still does. Neither pays the killer any points
    (:func:`economy.points_of`).
    """
    total = 0
    for move in history or []:
        if phase is not None:
            # A record with no ply is in no scoring phase - the client's
            # phaseIndexAt(undefined) lands past the schedule, on overtime.
            turn = move.get('turn')
            if not isinstance(turn, int) or phase_index_at(turn) != phase:
                continue
        if move.get('intoPanel') and move.get('panel') in BASE_PANELS:
            continue
        if move.get('defender_eliminated') and move.get('color') != color:
            total += unit_value(config, move.get('captured'))
        if move.get('attacker_eliminated') and move.get('color') == color:
            total += unit_value(config, move.get('unit_id'))
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
            color: phase_total(capture_score(claims, color),
                               deaths_of(config, history, color, phase),
                               PHASES[phase]['multiplier'])
            for color in ('white', 'black')
        }
        # Already over before this hand-over: its moment has passed.
        if phase_over(phase, ply - 1):
            entry['late'] = True
        out[str(phase)] = entry
    return out


def cp_awarded(bank: Optional[Dict[str, Any]], color: str, offset: int) -> int:
    """
    The CP *color* has been awarded so far: one award per phase banked,
    landing as the phase's postmatch begins - which is when a phase banks, so
    the bank is all this needs. CP comes from nothing else.

    Phase N's award is ``N x offset`` (``rules.cpPhaseOffset``: 5, 10, 15),
    plus both sides' scores for the phase, plus - for the side that scored
    less - the gap between them. *The owner, 24 Sep 2026:* the side with the
    higher total gets ``phase_x + (mine + theirs)``, the lower
    ``phase_x + (mine + theirs) + abs(mine - theirs)``. Phase 2 banking white
    12, black 4 awards white 10 + 16 = 26 and black 26 + 8 = 34. The 5 each
    side starts with (``rules.cpAtStart``) is not an award and is not here.

    Only the phase's own scores are compared, not the match's. A late phase
    still awards. Nothing on the server spends CP yet - abilities are solo
    (PUNCHLIST 6.15) - so this is the mirror the client's ``cpAwarded`` keeps
    in step with, ready for when they are not.
    """
    other = 'black' if color == 'white' else 'white'
    total = 0
    for phase in SCORING_PHASES:
        entry = (bank or {}).get(str(phase))
        if not entry:
            continue
        mine, theirs = entry[color], entry[other]
        total += phase * offset + mine + theirs + max(0, theirs - mine)
    return total


def vp_as_points(bank: Optional[Dict[str, Any]], color: str, ply: int) -> int:
    """
    What *color*'s victory points are worth as points by *ply*: its whole
    banked total, paid into its purse as its first overtime turn begins, and
    nothing before. *The owner, 24 Sep 2026: "at the start of the overtime,
    all your accumlated victory points turn into regular points."*

    Paid the way a turn's own point is - white on hand-over 73, black on 74 -
    so it asks whether the side has begun an overtime turn. The bank is not
    emptied: it is the record of how the three phases finished. Mirrors
    ``vpAsPoints`` in the client.
    """
    begun = hand_overs_by(color, ply) - hand_overs_by(color, OVERTIME_FIRST_PLY - 1)
    # A match decided on points ends ON the hand-over into overtime's first
    # ply, which is the one moment the arithmetic above would read as begun.
    if begun <= 0 or decided_on_points(bank):
        return 0
    return sum(((bank or {}).get(str(phase)) or {}).get(color, 0) for phase in SCORING_PHASES)


def scheduled_points(bank: Optional[Dict[str, Any]], color: str, ply: int) -> int:
    """
    What the schedule has paid *color* in points by *ply*: every turn begun
    at its rate, each phase's grant (:func:`phases.turn_points_by`), and the
    banked victory points once its first overtime turn begins
    (:func:`vp_as_points`). The purse is this plus what the record adds and
    takes away (:func:`economy.points_of`). Mirrors ``scheduledPoints`` in
    match-score.ts.
    """
    return turn_points_by(color, ply) + vp_as_points(bank, color, ply)


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
      past the other's margin - **once Phase 3's postmatch has been played**,
      on the hand-over into turn 37 (``OVERTIME_FIRST_PLY``). The result is
      known as the postmatch begins, but the postmatch is still played: *the
      owner, 24 Sep 2026: "phase 3 post match still happens even if overtime
      isnt triggered."*
    * ``'overtime'``: turn 50 has been played out - the hand-over is into
      turn 51 - with both kings standing. Black's.
    """
    points = decided_on_points(bank) if ply >= OVERTIME_FIRST_PLY else None
    if points:
        return points, 'points'
    if turn_of(ply) > OVERTIME_LAST_TURN:
        return 'black', 'overtime'
    return None
