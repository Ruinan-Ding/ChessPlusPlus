"""Per-match capture claims, phase banks and scheduled endings.

Mirrors match-score.ts/hex-rules.ts. The saved configuration supplies geometry,
weights, attrition and resource multipliers, schedule and ending thresholds.
Each tally freezes before postmatch; consumers persist it with the handover.
"""


from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .board import HEX_DIRECTIONS, coord_key, hex_distance, parse_coord
from .config_loader import rule_of
from .game_rules import section_of
from .phases import phases_of, scoring_phases, overtime_first_ply, overtime_last_turn
from .phases import (
    hand_overs_by, is_postmatch,
    phase_index_at, phase_start_turn, PLIES_PER_TURN, turn_of, turn_points_by,
)

#: What a scoring phase finished on, keyed by its one-based index: each side's
#: score, and ``"late": True`` on a phase banked after its moment.
Bank = Dict[str, Dict[str, Any]]


def _js_round(x: float) -> int:
    """``Math.round``: a half goes up, not to the nearest even."""
    return math.floor(x + 0.5)


def capture_zones(radius, config=None):
    settings = section_of(config, 'scoring')
    layout = settings['layout']
    zones = []
    for specification in settings['zones']:
        spread = specification['radius']
        cols = max(spread + 1, _js_round(radius * layout['columnRatio']))
        pairs = max(1, _js_round(radius * layout['rowRatio'] / 2))
        anchors = {'middle': (0, 0), 'right': (cols, 0), 'left': (-cols, 0),
                   'black-home': (pairs, -2 * pairs), 'white-home': (-pairs, 2 * pairs)}
        cq, cr = specification['center'] if 'center' in specification else anchors[specification['anchor']]
        hexes = {coord_key(cq + dq, cr + dr) for dq in range(-spread, spread + 1)
                 for dr in range(max(-spread, -dq - spread), min(spread, -dq + spread) + 1)
                 if hex_distance((cq + dq, cr + dr), (0, 0)) <= radius}
        zones.append({**specification, 'center': coord_key(cq, cr), 'hexes': hexes})
    return zones


def capture_zone_values(radius, config=None):
    values = {}
    for zone in capture_zones(radius, config):
        for key in zone['hexes']:
            values[key] = max(zone['worth'], values.get(key, 0))
    return values


def capture_zone_hexes(radius, config=None):
    return set(capture_zone_values(radius, config))


def capture_eligible(piece: dict, zone: dict, config: Optional[dict] = None) -> bool:
    permissions = (config or {}).get('units', {}).get(piece['unit_id'], {}).get('captureZones')
    kind = ('home' if zone['owner'] == piece.get('color') else 'enemy') if zone['kind'] == 'base' else zone['kind']
    return permissions is None or kind in permissions


def capture_claims(board_state: Dict[str, Any], radius: int, config: Optional[dict] = None) -> Dict[str, str]:
    """Outer units score their hex; inner units also score neighbours.

    Every eligible unit disrupts adjacent opposing claims. An unopposed
    centre holds the whole zone.

    Any eligible enemy inside that zone removes the centre bonus. Ineligible
    units cannot capture, neutralize or block it. Opposing adjacent claims cancel.
    """
    zones = capture_zones(radius, config)

    disruption = {'white': set(), 'black': set()}
    claimed: Dict[str, str] = {}

    def claim(key: str, color: str) -> None:
        held = claimed.get(key)
        if held is None:
            claimed[key] = color
        elif held != color:
            claimed[key] = 'contested'

    for key, piece in (board_state or {}).items():
        if not piece:
            continue
        allowed = set().union(*(zone['hexes'] for zone in zones if capture_eligible(piece, zone, config)))
        if key not in allowed:
            continue
        color = 'black' if piece.get('color') == 'black' else 'white'
        claim(key, color)
        disruption[color].add(key)
        expanded = any(capture_eligible(piece, zone, config) and hex_distance(parse_coord(key), parse_coord(zone['center'])) < zone['radius']
                       for zone in zones)
        q, r = parse_coord(key)
        settings = section_of(config, 'scoring')
        reach = settings['innerClaimReach'] if expanded else settings['outerClaimReach']
        for dq in range(-max(reach, settings['neutralizeReach']), max(reach, settings['neutralizeReach']) + 1):
            for dr in range(-max(reach, settings['neutralizeReach']), max(reach, settings['neutralizeReach']) + 1):
                distance = hex_distance((0, 0), (dq, dr))
                neighbour = coord_key(q + dq, r + dr)
                if neighbour not in allowed:
                    continue
                if distance <= settings['neutralizeReach']:
                    disruption[color].add(neighbour)
                if distance <= reach:
                    claim(neighbour, color)
    for zone in zones:
        center = (board_state or {}).get(zone['center'])
        if not section_of(config, 'scoring')['centerControl'] or not center or not capture_eligible(center, zone, config):
            continue
        enemy_present = any(
            piece and piece.get('color') != center.get('color') and key in zone['hexes'] and capture_eligible(piece, zone, config)
            for key, piece in (board_state or {}).items())
        if not enemy_present:
            for key in zone['hexes']:
                claim(key, 'black' if center.get('color') == 'black' else 'white')
    held = {key: color for key, color in claimed.items()
            if color != 'contested' and key not in disruption['black' if color == 'white' else 'white']}
    overrides = {}
    catalogue = (config or {}).get('abilities', {}).get('catalogue', {})
    for zone in zones:
        occupants = {key: piece for key, piece in (board_state or {}).items()
                     if piece and key in zone['hexes'] and capture_eligible(piece, zone, config)}
        colors = {piece['color'] for piece in occupants.values() if 'battlefield' in section_of(config, 'veterancy')['kitZones'] and piece.get('vet', 0) >= section_of(config, 'veterancy')['passiveUnlock']
                  and catalogue.get((config or {}).get('units', {}).get(piece['unit_id'], {}).get('passive'), {}).get('effect') == 'capture'}
        if len(colors) != 1:
            continue
        color = next(iter(colors))
        for key in zone['hexes']:
            owner = occupants.get(key, {}).get('color', color)
            overrides[key] = owner if key not in overrides or overrides[key] == owner else 'contested'
    for key, color in overrides.items():
        if color == 'contested':
            held.pop(key, None)
        else:
            held[key] = color
    return held


def capture_score(claims: Dict[str, str], color: str, radius: int, config=None) -> int:
    """What the hexes a side holds are worth: each its zone's worth from its configuration."""
    worth = capture_zone_values(radius, config=config)
    return sum(worth.get(key, 0) for key, owner in claims.items() if owner == color)


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


def phase_total(cap: int, deaths: int, multiplier: int, config=None) -> int:
    """
    What a scoring phase scores: what the capture hexes held are worth
    (*cap*, :func:`capture_score`), less what its losses cost, **never below
    0**, and **times the phase's ``multiplier``** - x1 in Phase 1, x2 in
    Phase 2, x3 in Phase 3 (``PHASES``).

    *The owner, 24 Sep 2026: "the total points racked shouldnt go negative by
    death. max is 0"* and *"the total victory points for each phase is
    multiplied by 2 on phase 2, multipled by 3 on phase 3"*. The floor comes
    first: 4 - 18 in Phase 3 is 0, not -42. Everything downstream - the
    match total, the margins, the CP award - reads the multiplied figure.
    """
    raw = cap - deaths
    return (max(0, raw) if section_of(config, 'scoring')['floorAtZero'] else raw) * multiplier


def cap_of(board_state: Dict[str, Any], radius: int, color: str, config: Optional[dict] = None) -> int:
    """What *color* is holding on *board_state*, right now."""
    return capture_score(capture_claims(board_state, radius, config), color, radius, config=config)


def casualty_zone(move):
    if not move.get('intoPanel'):
        return 'battlefield'
    return 'base' if move.get('panel') in ('bl', 'tr') else 'reserve'


def deaths_of(config: Dict[str, Any], history: Iterable[Dict[str, Any]],
              color: str, phase: Optional[int] = None) -> int:
    """
    What *color*'s losses have cost it: the ``value`` of every unit of its that
    died, in *phase* alone when one is named. A loss counts against the phase
    it happened in and no other, so summing the phases never charges one twice.
    The defender belongs to whoever was not moving; a counter-attack kills the
    mover's own unit.

    Battlefield, reserve and base deaths all count attrition VP. Panel kills
    grant no UP bounty.
    """
    total = 0
    settings = section_of(config, 'scoring')
    for move in history or []:
        if phase is not None:
            # A record with no ply is in no scoring phase - the client's
            # phaseIndexAt(undefined) lands past the schedule, on overtime.
            turn = move.get('turn')
            if not isinstance(turn, int) or phase_index_at(turn, config=config) != phase:
                continue
        if casualty_zone(move) in settings['deathZones'] and (move.get('abilityDeath') or {}).get('color') == color:
            total += unit_value(config, move['abilityDeath'].get('unit_id'))
        if casualty_zone(move) in settings['deathZones'] and move.get('defender_eliminated') and move.get('color') != color:
            total += unit_value(config, move.get('captured'))
        if 'battlefield' in settings['deathZones'] and move.get('attacker_eliminated') and move.get('color') == color:
            total += unit_value(config, move.get('unit_id'))
    return total * settings['deathCostMultiplier']


def phase_over(phase: int, ply: int, config=None) -> bool:
    """
    Whether a scoring phase is over by *ply*: once its postmatch begins, not
    once the next phase does. The postmatch still counts as the phase's own
    (``phase_index_at``), which is why this asks about it as well as the index.
    """
    now = phase_index_at(ply, config=config)
    return phase < now or (phase == now and is_postmatch(ply, config=config))


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
    for phase in scoring_phases(config):
        if str(phase) in out or not phase_over(phase, ply, config=config):
            continue
        if claims is None:
            claims = capture_claims(board_state, radius, config)
        entry: Dict[str, Any] = {
            color: phase_total(capture_score(claims, color, radius, config=config),
                               deaths_of(config, history, color, phase),
                               phases_of(config)[phase]['multiplier'], config=config)
            for color in ('white', 'black')
        }
        # Already over before this hand-over: its moment has passed.
        if phase_over(phase, ply - 1, config=config):
            entry['late'] = True
        if not entry.get('late'):
            for rule in section_of(config, 'match')['winConditions']['earlyPhaseLosses']:
                if rule['phase'] != phase:
                    continue
                occupied = sum(1 for key, piece in board_state.items()
                               if piece and piece.get('color') == rule['side'] and piece.get('hp', 1) > 0
                               and any(key in zone['hexes'] and capture_eligible(piece, zone, config) for zone in capture_zones(radius, config)))
                value = occupied if rule['condition'] == 'no-eligible-capture-occupant' else entry[rule['side']]
                if value <= rule['threshold']:
                    entry['pendingLoss'] = rule['side']
                    break
        out[str(phase)] = entry
    return out


def halftime_up_awards(config: Dict[str, Any], board_state: Dict[str, Any],
                       history: List[Dict[str, Any]], ply: int) -> List[Dict[str, Any]]:
    """Persist each side's current phase VP once as halftime begins."""
    phase = next((index for index in scoring_phases(config)
                  if ply == (phase_start_turn(index, config) + phases_of(config)[index]['halftimeAfter'] - 1)
                  * PLIES_PER_TURN + 1), None)
    if phase is None or not phases_of(config)[phase]['halftime'] or any(move.get('halftimeUp', {}).get('phase') == phase for move in history):
        return []
    radius = config.get('board', {}).get('radius', 11)
    claims = capture_claims(board_state, radius, config)
    award = {color: phase_total(capture_score(claims, color, radius, config=config),
                               deaths_of(config, history, color, phase), phases_of(config)[phase]['multiplier'], config=config)
             for color in ('white', 'black')}
    return [{'turn': ply, 'halftimeUp': {'phase': phase, **{side: amount * section_of(config, 'economy')['halftimeUpMultiplier'] for side, amount in award.items()}}}]


def cp_awarded(bank: Optional[Dict[str, Any]], color: str, offset: int, config=None) -> int:
    """
    The CP *color* has been awarded so far: one award per phase banked,
    landing as the phase's postmatch begins - which is when a phase banks, so
    the bank is all this needs. CP comes from nothing else.

    Each phase pays its configured fixed award plus weighted own/opponent
    scores and deficit. The offset argument is retained for callers without
    a match config; the room's starting CP is separate.
    A late bank still awards, and only that phase's scores are compared.
    """
    other = 'black' if color == 'white' else 'white'
    total = 0
    for phase in scoring_phases(config):
        entry = (bank or {}).get(str(phase))
        if not entry:
            continue
        mine, theirs = entry[color], entry[other]
        settings = section_of(config, 'economy')
        fixed = phases_of(config)[phase]['cpAward'] if config is not None else phase * offset
        total += fixed + mine * settings['cpOwnScoreMultiplier'] + theirs * settings['cpOpponentScoreMultiplier'] + max(0, theirs - mine) * settings['cpBehindGapMultiplier']
    return total


def vp_as_points(bank: Optional[Dict[str, Any]], color: str, ply: int, config=None) -> int:
    """
    What *color*'s victory points are worth as points by *ply*: its whole
    banked total, paid into its purse as its first overtime turn begins, and
    nothing before. *The owner, 24 Sep 2026: "at the start of the overtime,
    all your accumlated victory points turn into regular points."*

    Paid the way a turn's own point is - white on hand-over 73, black on 74 -
    so it asks whether the side has begun an overtime turn. The bank is not
    emptied: it is the record of how the configured phases finished. Mirrors
    ``vpAsPoints`` in the client.
    """
    begun = hand_overs_by(color, ply) - hand_overs_by(color, overtime_first_ply(config) - 1)
    # A match decided on points ends ON the hand-over into overtime's first
    # ply, which is the one moment the arithmetic above would read as begun.
    if begun <= 0 or decided_on_points(bank, config=config):
        return 0
    return sum(((bank or {}).get(str(phase)) or {}).get(color, 0) for phase in scoring_phases(config)) * section_of(config, 'economy')['overtimeVpToPointsMultiplier']


def scheduled_points(bank: Optional[Dict[str, Any]], color: str, ply: int, config: Optional[Dict[str, Any]] = None) -> int:
    """
    What the schedule has paid *color* in points by *ply*: every turn begun
    at its rate, each phase's grant (:func:`phases.turn_points_by`), and the
    banked victory points once its first overtime turn begins
    (:func:`vp_as_points`). The purse is this plus what the record adds and
    takes away (:func:`economy.unit_points_of`). Mirrors ``scheduledPoints`` in
    match-score.ts.
    """
    return rule_of(config, 'pointsAtStart') + turn_points_by(color, ply, config=config) + vp_as_points(bank, color, ply, config=config)


def decided_on_points(bank: Optional[Dict[str, Any]], config=None) -> Optional[str]:
    """
    The side the configured phases hand the match to outright, or ``None`` - while
    any is unbanked, while the two are close enough for overtime, or while any
    phase was banked late (see :func:`bank_ended_phases`): a score read off
    the wrong board decides nothing.
    """
    entries = [(bank or {}).get(str(phase)) for phase in scoring_phases(config)]
    if not all(entries) or any(entry.get('late') for entry in entries):
        return None
    lead = sum(e['white'] for e in entries) - sum(e['black'] for e in entries)
    settings = section_of(config, 'match')['winConditions']['points']
    if not settings['enabled']:
        return None
    if lead > settings['leadToWin']['white']:
        return 'white'
    if -lead > settings['leadToWin']['black']:
        return 'black'
    return None


def schedule_ending(bank: Optional[Dict[str, Any]], ply: int, config=None) -> Optional[Tuple[str, str]]:
    """
    ``(winning colour, end reason)`` if the schedule ends the match at *ply* -
    the hand-over just made - or ``None``.

    Asked after the hand-over has banked what it closed, and only when nothing
    on the board ended the match first: a king killed on the turn Phase 3
    banks, or on turn 50, has already decided it.

    * ``'phase_result'``: a frozen Phase 1/2 loss, after both postmatch halves.
    * ``'points'``: all three phases are in, none of them late, and one side is
      past the other's margin - **once Phase 3's postmatch has been played**,
      on the hand-over into turn 37 (``OVERTIME_FIRST_PLY``). The result is
      known as the postmatch begins, but the postmatch is still played: *the
      owner, 24 Sep 2026: "phase 3 post match still happens even if overtime
      isnt triggered."*
    * ``'overtime'``: turn 50 has been played out - the hand-over is into
      turn 51 - with both kings standing. Black's.
    """
    for phase in scoring_phases(config):
        entry = (bank or {}).get(str(phase), {})
        if entry.get('pendingLoss') and not entry.get('late') and ply >= (phase_start_turn(phase + 1, config=config) - 1) * PLIES_PER_TURN + 1:
            return ('black' if entry['pendingLoss'] == 'white' else 'white'), 'phase_result'
    points = decided_on_points(bank, config=config) if ply >= overtime_first_ply(config) else None
    if points:
        return points, 'points'
    if turn_of(ply) > overtime_last_turn(config):
        winner = section_of(config, 'match')['winConditions']['overtimeWinner']
        return ('', 'draw_overtime') if winner == 'draw' else (winner, 'overtime')
    return None
