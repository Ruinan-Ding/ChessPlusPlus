"""
The match schedule. Mirrors ``client/src/app/services/phases.ts``.

Five phases: three turns to set up, three ten-turn phases with a halftime
halfway through each, then overtime, which runs until the game ends. Each
numbered phase closes with a **postmatch turn** of its own, which its ten do
not count - see ``postmatch`` below.

The extra turn used to sit at the *start* of each phase, as that phase's
"initialization". Put there, it followed the opening's three setup turns
straight away, so a match opened on four setup turns in a row. At the end of a
phase it is a breather between two phases of play instead, and play starts the
moment the opening is over.

The turns here are *full* turns - white's hand-over and black's together. The
engine counts one per hand-over (``GameState.turn_number`` is a ply counter
that starts at 1), so everything below takes that count and converts, which
keeps the conversion at this one boundary rather than at every call site.

**This is the fourth mirror.** ``overtimeToll`` in the browser engine warned
that porting the schedule to Python "would make a fourth thing to keep in step",
beside the three halves of the config. It was ported anyway, because the server
cannot take the overtime toll without knowing where overtime starts. If the
schedule changes, it changes in both files, and ``PhaseScheduleTestCase`` pins
the numbers both sides have to agree on.

Four places where a straight transliteration would be wrong, and are not:

* ``Infinity`` is ``math.inf``, and "is it finite" is ``math.isfinite``.
* The client tells the opening and overtime apart by comparing phase OBJECTS,
  so this compares indexes instead of values.
* ``sideOfPly`` leans on JS ``%`` keeping the sign; this only answers for plies
  the engine can hold, which start at 1.
* ``turns / 2`` is float division in the client, and stays so here.
"""

from __future__ import annotations

import math
from typing import Dict, List, NamedTuple, Optional

#: Hand-overs to a full turn: white plays, then black.
PLIES_PER_TURN = 2

#: The schedule. ``turns`` is ``math.inf`` for the phase that runs out the
#: match; ``halftime`` breaks a phase evenly in two; ``postmatch`` closes a
#: phase with one postmatch turn after its play, which its ``turns`` do not
#: count.
#:
#: ``points`` is what a side banks at the start of each of its own turns - the
#: board's currency, not the match score. The phase's number, 1, 2, 3, and
#: **from its halftime**, not its first turn: a phase's first half still pays
#: the rate before it (:data:`_POINT_RATES`). A phase with no halftime pays
#: from its start: the opening the regular 1, overtime nothing. *The owner,
#: 24 Sep 2026: "regular points are multipled by x"*, *"OT stops gaining
#: points"*, and *"1x, 2x, 3x regular point accumation now happens at the
#: start of half time of each phase instead of start of a phase."*
#:
#: ``grant`` is what a side is handed as the phase begins, on top of the
#: rate - paid on its own first turn of the phase: 10, 20, 30 for Phases 1-3.
#: *The owner, 24 Sep 2026: "at the start of each phase (not start of each
#: postmatch), +10 regular points for phase 1, 20 for phase 2, 30 for phase 3."*
#:
#: ``multiplier`` is what the phase's victory points are multiplied by as it
#: scores (:func:`scoring.phase_total`): 1, 2, 3 for Phases 1-3, and 1 on the
#: two that score nothing. *The owner, 24 Sep 2026: "the total victory points
#: for each phase is multiplied by 2 on phase 2, multipled by 3 on phase 3".*
PHASES: List[Dict] = [
    {'name': 'Initialization', 'turns': 3, 'halftime': False, 'postmatch': False,
     'points': 1, 'grant': 0, 'multiplier': 1},
    {'name': 'Phase 1', 'turns': 10, 'halftime': True, 'postmatch': True,
     'points': 1, 'grant': 10, 'multiplier': 1},
    {'name': 'Phase 2', 'turns': 10, 'halftime': True, 'postmatch': True,
     'points': 2, 'grant': 20, 'multiplier': 2},
    {'name': 'Phase 3', 'turns': 10, 'halftime': True, 'postmatch': True,
     'points': 3, 'grant': 30, 'multiplier': 3},
    {'name': 'Overtime', 'turns': math.inf, 'halftime': False, 'postmatch': False,
     'points': 0, 'grant': 0, 'multiplier': 1},
]

# How many units a side may bring out of its reserve in a postmatch, and walk
# home in a setup turn, are config: rules.postmatchEntries and
# rules.homecomingsPerSetupTurn.


def phase_span(phase: Dict) -> float:
    """
    How many turns of the clock a phase occupies: its own ``turns``, plus the
    postmatch turn if it closes with one.

    Every "where am I on the schedule" answer counts in spans; everything that
    asks how long a phase *plays* for - the halftime split, the score it banks -
    counts in ``turns``. Keeping the two apart is the whole point of the flag.
    The postmatch is part of the phase it closes, so turn 14 is still Phase 1.
    """
    if math.isfinite(phase['turns']) and phase.get('postmatch'):
        return phase['turns'] + 1
    return phase['turns']

#: The phases that bank a score, by their place in the schedule.
SCORING_PHASES = [1, 2, 3]

#: Overtime's three stretches, and what each takes off a commander at the end
#: of that side's turn. Real damage, and a commander on that much HP dies of
#: it. The toll climbs so that a match neither side can win on the board still
#: ends: 1 a turn, then 3, then 5 on the last turn. *The owner, 24 Sep 2026:
#: "the 3 and 5 is DAMAGE TAKEN TO KING"*.
#:
#: The stretches are named and the phase they sit in is not: ``phase_at`` still
#: answers ``Overtime`` for all fourteen turns, while ``stage_at`` answers
#: ``Overtime 1``, ``Overtime 2``, ``Overtime 3``.
#:
#: ``turns`` are full turns, counted forward from overtime's first - turns
#: 37-44, 45-49 and 50 on the shipped schedule. Counted forward rather than
#: written down, because a written-down turn number is what went wrong last
#: time: the client's ``OVERTIME_LAST_TURN`` was the literal 50, the extra turn
#: each numbered phase gained (an initialization at its start then, a postmatch
#: at its end now - either way one more turn a phase) moved overtime from turn
#: 34 to turn 37, and the literal stayed put and quietly shortened overtime by
#: three turns.
#: ``moves`` is how many units a side may move on the MAIN BOARD in one of its
#: turns, in place of :data:`BOARD_MOVES_PER_TURN`. Each is a whole board action
#: - a walk and, if it ends in reach, a swing - so a stretch that allows three
#: allows three blows. Panel deployments are not counted: a crossing, a walk
#: inside a panel and a setup turn's walk home have allowances of their own.
OVERTIME_STAGES: List[Dict] = [
    {'name': 'Overtime 1', 'turns': 8, 'toll': 1, 'moves': 1},
    {'name': 'Overtime 2', 'turns': 5, 'toll': 3, 'moves': 2},
    {'name': 'Overtime 3', 'turns': 1, 'toll': 5, 'moves': 3},
]

#: How many units a side may move on the main board in one of its turns,
#: everywhere the schedule is still running: **one**, which is what "the turn's
#: board action" has always meant. Overtime 2 and 3 raise it to two and three.
BOARD_MOVES_PER_TURN = 1


def turn_of(ply: int) -> int:
    """The full turn a hand-over belongs to. White opens turn 1."""
    return math.ceil(ply / PLIES_PER_TURN)


def phase_index_at(ply: int) -> int:
    """
    Where in the schedule a hand-over falls. The last phase runs out the
    match, so any turn past the schedule belongs to it.
    """
    turn = turn_of(ply)
    end = 0
    for i, phase in enumerate(PHASES):
        if not math.isfinite(phase['turns']):
            return i
        end += phase_span(phase)
        if turn <= end:
            return i
    return len(PHASES) - 1


def phase_at(ply: int) -> Dict:
    """Which phase a hand-over falls in."""
    return PHASES[phase_index_at(ply)]


#: The first hand-over of overtime: everything on the schedule has been played.
#: Derived rather than written down, so moving a phase moves this with it.
OVERTIME_FIRST_PLY = int(sum(
    phase_span(phase) for phase in PHASES if math.isfinite(phase['turns'])
)) * PLIES_PER_TURN + 1

#: Overtime's first full turn, and its last. Both read off the schedule.
OVERTIME_FIRST_TURN = turn_of(OVERTIME_FIRST_PLY)
OVERTIME_LAST_TURN = (
    OVERTIME_FIRST_TURN + sum(stage['turns'] for stage in OVERTIME_STAGES) - 1
)


def overtime_stage_at(ply: int) -> Optional[Dict]:
    """
    Which stretch of overtime a hand-over falls in, or ``None`` before
    overtime begins.

    Past the last turn it is the last stretch rather than ``None``. Both
    engines end the match as turn 50 is played out
    (:func:`scoring.schedule_ending`), so no game reaches it by playing; a
    position built past it still pays the heaviest toll rather than quietly
    none at all.
    """
    if not is_overtime(ply):
        return None
    turn = turn_of(ply)
    end = OVERTIME_FIRST_TURN - 1
    for stage in OVERTIME_STAGES:
        end += stage['turns']
        if turn <= end:
            return stage
    return OVERTIME_STAGES[-1]


def overtime_toll_at(ply: int) -> int:
    """
    What overtime takes off the commander of the side playing *ply*, at the
    end of that hand-over. ``0`` outside overtime, which is what "no toll"
    means to every caller: both engines take it off unconditionally.
    """
    stage = overtime_stage_at(ply)
    return stage['toll'] if stage else 0


def board_moves_per_turn(ply: int) -> int:
    """How many board moves the side playing *ply* may make."""
    stage = overtime_stage_at(ply)
    return stage['moves'] if stage else BOARD_MOVES_PER_TURN




def turn_points_by(color: str, ply: int) -> int:
    """
    What *color*'s own turns have paid it in points by *ply* - the hand-over
    about to be played, which counts, since a turn pays at its start: each
    turn's rate, and each phase's ``grant`` once the side has begun a turn in
    it.

    The rate changes at each halftime (:data:`_POINT_RATES`), so this walks the
    rates and counts how many of that side's hand-overs fall under each, as a
    difference of two ``hand_overs_by`` at its ends. Overtime pays nothing,
    however long a position built past it runs.
    """
    played = max(0, int(ply))
    begun = hand_overs_by(color, played)
    rates = _POINT_RATES
    points = 0
    for i, r in enumerate(rates):
        if r.grant and begun > hand_overs_by(color, r.start - 1):
            points += r.grant
        if played < r.rate_from:
            continue
        to = min(played, rates[i + 1].rate_from - 1) if i + 1 < len(rates) else played
        points += (hand_overs_by(color, to) - hand_overs_by(color, r.rate_from - 1)) * r.rate
    return points


def is_initialization(ply: int) -> bool:
    """
    The opening turns, where nobody attacks and both sides set out.

    **The opening only** - not a numbered phase's postmatch, which is one turn
    with its own allowances (:func:`is_postmatch`). Widening this to mean "any
    setup turn" would hand the opening's one-move-per-phase lock to a single
    turn that was never about it; :func:`is_setup_turn` is the predicate for
    what the two genuinely share.
    """
    return phase_index_at(ply) == 0


def is_scoring_phase(ply: int) -> bool:
    """
    The phases that bank a score, as a question about a hand-over. The opening
    and overtime are the two that do not.
    """
    return phase_index_at(ply) in SCORING_PHASES


def is_postmatch(ply: int) -> bool:
    """
    A numbered phase's own postmatch turn: the last turn of its span, straight
    after its ten turns of play, which do not count it. Turns 14, 25 and 36 on
    the shipped schedule.

    One full turn - white's hand-over and black's. Both sides get one, because
    a turn either side could set out on and the other could not would hand the
    second mover a free look at the first's deployment.

    It belongs to the phase it closes, not the one after: the phase's index
    still answers for it, so turn 14 is Phase 1's. It is also where CP
    arrives: each postmatch pays the award for the phase just banked
    (:func:`scoring.cp_awarded`, off the bank). What it does not do is
    *score*. Both
    engines bank a phase on the hand-over into its postmatch
    (:func:`scoring.bank_ended_phases`), because the postmatch rearranges
    units - crossings, walks home - and those must not count towards the
    phase it closes.
    """
    index = phase_index_at(ply)
    phase = PHASES[index]
    return (bool(phase.get('postmatch'))
            and turn_of(ply) == phase_start_turn(index) + phase['turns'])


def is_setup_turn(ply: int) -> bool:
    """
    A turn given to setting out rather than playing: the opening's three, and
    each numbered phase's postmatch.

    What the two share, and *all* they share: **nobody attacks and no ability
    fires**. Their movement allowances differ - the opening gives a battlefield
    unit one move for the whole phase, a postmatch gives five crossings and
    three walks home for the one turn - so anything about how much may move
    asks the narrower predicate.
    """
    return is_initialization(ply) or is_postmatch(ply)


def no_attack_message(ply: int) -> str:
    """
    What to tell someone who tried to strike on a turn given to setting out.

    Two turns refuse a blow for two different reasons, and saying "the opening"
    on turn 14 would send the player looking at a phase that ended a whole
    phase ago. Lives here rather than at the two call sites so the browser engine's
    copy has one thing to mirror.

    Total, not partial: a ply that refuses no blow gets ``''``. Asked the other
    way round - "not the opening, so a postmatch" - it would answer ``Nobody
    attacks in the postmatch`` for every playable turn of every phase, which is
    the reading a caller without a guard would take. (It did exactly that when
    the extra turn was a phase's initialization.)
    """
    if is_postmatch(ply):
        return 'Nobody attacks in the postmatch'
    if is_initialization(ply):
        return 'Nobody attacks in the opening'
    return ''


def is_overtime(ply: int) -> bool:
    """
    The schedule is spent: a deathmatch until a king falls or
    ``OVERTIME_LAST_TURN`` runs out.
    """
    return phase_index_at(ply) == len(PHASES) - 1


def phase_start_turn(index: int) -> int:
    """
    The first full turn of a phase. For a numbered phase that is its first
    turn of play - its postmatch sits at the far end of its span, never the
    front. (The opening's first turn is a setup turn like the rest of it.)
    Counted in spans, so an earlier phase's postmatch pushes this along too.
    """
    turn = 1
    for i in range(index):
        turn += phase_span(PHASES[i])
    return int(turn)


#: What each phase pays, as first hand-overs: ``from`` is where its points rate
#: starts - the opening from its first turn, each numbered phase from its
#: **halftime**, overtime from its first turn - and ``start`` is its first
#: turn, where its ``grant`` is paid. 1 from turn 1, 1 from turn 9, 2 from turn
#: 20, 3 from turn 31, nothing from turn 37 on the shipped schedule. The first
#: turn not before the halftime is taken by :func:`before_halftime`'s own test
#: (``turn < first + turns / 2``, float division), so an odd phase breaks where
#: it does. Fixed at import, like :data:`OVERTIME_FIRST_PLY`, and immutable, so
#: no caller can change it under the next. Mirrors ``POINT_RATES`` in the
#: client.
class _PointRate(NamedTuple):
    rate_from: int
    rate: int
    start: int
    grant: int


def _point_rate(index: int, phase: Dict) -> _PointRate:
    first = phase_start_turn(index)
    turn = math.ceil(first + phase['turns'] / 2) if phase['halftime'] else first
    return _PointRate(rate_from=(turn - 1) * PLIES_PER_TURN + 1, rate=phase['points'],
                      start=(first - 1) * PLIES_PER_TURN + 1, grant=phase['grant'])


_POINT_RATES = tuple(_point_rate(i, p) for i, p in enumerate(PHASES))


def before_halftime(ply: int) -> bool:
    """
    Whether a turn falls before its phase's break - or in a phase that has no
    break to fall either side of. The opening and overtime are the two of
    those, so they are always "before".

    Play starts on the phase's first turn, so the break is simply half its
    ``turns`` past that. The postmatch comes after all ten, so it reads as
    *not* before the halftime. That alone keeps the wrap shut on it
    (:func:`is_wrap_open` names it anyway, for clarity), and it is why
    :func:`stage_at` has to ask about it before it asks this - asked after, it
    would read as one more turn of the halftime.
    """
    index = phase_index_at(ply)
    phase = PHASES[index]
    if not phase['halftime']:
        return True
    return turn_of(ply) < phase_start_turn(index) + phase['turns'] / 2


def is_wrap_open(ply: int) -> bool:
    """
    Whether the wrap is open - the crossing out of a side's base, over its
    outer tip and onto the reserve tip across the board.

    **Only the played first half of a numbered phase.** Not the opening, not a
    phase's postmatch, and not overtime: the owner's rule is that the wrap
    belongs to the half before the halftime and to nothing else. On the
    shipped schedule that is turns 4-8, 15-19 and 26-30, and no others.

    :func:`before_halftime` alone used to be the whole answer, and it said yes
    for every phase that has no break to fall either side of - which quietly
    included the opening and the whole of overtime. The postmatch clause is
    redundant today (a postmatch is never before the halftime) and is kept so
    the rule reads the way the owner said it.
    """
    return (
        is_scoring_phase(ply)
        and not is_postmatch(ply)
        and before_halftime(ply)
    )


def is_entry_open(ply: int) -> bool:
    """
    Whether units may come out of the reserve onto the board - the three arrows
    on each side's reserve, pointing in.

    Open on any setup turn and through a phase's halftime half; shut through
    the played first half and through overtime. On the shipped schedule that is
    turns 1-3, 9-14, 20-25 and 31-36: each halftime half runs straight on into
    the phase's postmatch.

    The complement of the wrap, near enough: a side spends the first half of a
    phase sending units home around the outside and the second half bringing
    them back in. Overtime is the one stretch where neither runs.
    """
    return is_setup_turn(ply) or (is_scoring_phase(ply) and not before_halftime(ply))


def is_homecoming_open(ply: int) -> bool:
    """
    Whether units may walk home to their own base for the refund - the three
    arrows on each side's base, pointing in.

    Open on any setup turn and through **all** of overtime; shut through both
    halves of a numbered phase's play. On the shipped schedule that is turns
    1-3, 14, 25 and 36 on - Phase 3's postmatch runs straight on into overtime.

    Overtime is the owner's exception and is not a setup turn: the toll is
    running and units are still attacking, so a walk home there is an ordinary
    move that happens to end off the board. What does not change with the
    window is *who* may go - a unit standing in its own first three rows that
    can reach a doorway within its MOV - which :func:`panels.homecoming_targets`
    answers off the board, not off the clock.
    """
    return is_setup_turn(ply) or is_overtime(ply)


def stage_at(ply: int) -> str:
    """
    Where the match is: `Phase 1 Halftime`, `Phase 1 Postmatch`, `Overtime 2`,
    ...

    The postmatch is asked about first: it falls after the halftime, so asked
    last it would read as one more turn of `Phase 1 Halftime`.
    """
    phase = phase_at(ply)
    if is_postmatch(ply):
        return f"{phase['name']} Postmatch"
    overtime = overtime_stage_at(ply)
    if overtime:
        return overtime['name']
    if phase['halftime'] and not before_halftime(ply):
        return f"{phase['name']} Halftime"
    return phase['name']


def side_of_ply(ply: int) -> str:
    """Whose hand-over a ply is. White opens, so white plays the odd ones."""
    return 'white' if ply % 2 else 'black'


def hand_overs_by(color: str, ply: int) -> int:
    """
    How many of a side's own hand-overs have been played by the end of *ply*.

    What anything paid or given "each turn" counts: a base mends once a turn,
    not once a hand-over, so counting plies would hand out two.
    """
    played = max(0, int(ply))
    return (played + 1) // 2 if color == 'white' else played // 2
