"""
The match schedule. Mirrors ``client/src/app/services/phases.ts``.

Five phases: three turns to set up, three ten-turn phases with a halftime
halfway through each, then overtime, which runs until the game ends. Each
numbered phase opens with an **initialization turn** of its own, which its ten
do not count - see ``init`` below.

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
from typing import Dict, List, Optional

#: Hand-overs to a full turn: white plays, then black.
PLIES_PER_TURN = 2

#: The schedule. ``turns`` is ``math.inf`` for the phase that runs out the
#: match; ``halftime`` breaks a phase evenly in two; ``init`` gives a phase one
#: initialization turn at its start that its ``turns`` do not count.
PHASES: List[Dict] = [
    {'name': 'Initialization', 'turns': 3, 'halftime': False, 'init': False},
    {'name': 'Phase 1', 'turns': 10, 'halftime': True, 'init': True},
    {'name': 'Phase 2', 'turns': 10, 'halftime': True, 'init': True},
    {'name': 'Phase 3', 'turns': 10, 'halftime': True, 'init': True},
    {'name': 'Overtime', 'turns': math.inf, 'halftime': False, 'init': False},
]

# How many units a side may bring out of its reserve in a phase
# initialization, and walk home in a setup turn, are config:
# rules.phaseInitEntries and rules.homecomingsPerSetupTurn.


def phase_span(phase: Dict) -> float:
    """
    How many turns of the clock a phase occupies: its own ``turns``, plus the
    initialization turn if it opens with one.

    Every "where am I on the schedule" answer counts in spans; everything that
    asks how long a phase *plays* for - the halftime split, the score it banks -
    counts in ``turns``. Keeping the two apart is the whole point of the flag.
    """
    if math.isfinite(phase['turns']) and phase.get('init'):
        return phase['turns'] + 1
    return phase['turns']

#: The phases that bank a score, by their place in the schedule.
SCORING_PHASES = [1, 2, 3]

#: Overtime's three stretches, and what each takes off a commander at the end
#: of that side's turn. Real damage, and a commander on that much HP dies of
#: it. The toll climbs so that a match neither side can win on the board still
#: ends: the last turn takes three.
#:
#: The stretches are named and the phase they sit in is not: ``phase_at`` still
#: answers ``Overtime`` for all fourteen turns, while ``stage_at`` answers
#: ``Overtime 1``, ``Overtime 2``, ``Overtime 3``.
#:
#: ``turns`` are full turns, counted forward from overtime's first - turns
#: 37-44, 45-49 and 50 on the shipped schedule. Counted forward rather than
#: written down, because a written-down turn number is what went wrong last
#: time: the client's ``OVERTIME_LAST_TURN`` was the literal 50, the
#: initialization turns moved overtime from turn 34 to turn 37, and the
#: literal stayed put and quietly shortened overtime by three turns.
#: ``points`` is what a side banks at the START of each of its turns in the
#: stretch, in place of :data:`POINTS_PER_TURN`. The toll takes and this gives,
#: and they climb together: the pressure to finish comes with the means to.
#: Points are the board's currency - the pool abilities, the wrap crossing -
#: not the match score, which overtime still does not touch.
#: ``moves`` is how many units a side may move on the MAIN BOARD in one of its
#: turns, in place of :data:`BOARD_MOVES_PER_TURN`. Each is a whole board action
#: - a walk and, if it ends in reach, a swing - so a stretch that allows three
#: allows three blows. Panel deployments are not counted: a crossing, a walk
#: inside a panel and a setup turn's walk home have allowances of their own.
OVERTIME_STAGES: List[Dict] = [
    {'name': 'Overtime 1', 'turns': 8, 'toll': 1, 'points': 1, 'moves': 1},
    {'name': 'Overtime 2', 'turns': 5, 'toll': 2, 'points': 3, 'moves': 2},
    {'name': 'Overtime 3', 'turns': 1, 'toll': 3, 'points': 5, 'moves': 3},
]

#: What a side banks at the start of one of its own turns, everywhere the
#: schedule is still running.
POINTS_PER_TURN = 1

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

    Past the last turn it is the last stretch rather than ``None``: the match
    is black's by then, but that verdict is read and not enforced, so a game
    played on past turn 50 keeps paying the heaviest toll instead of quietly
    ceasing to pay one at all.
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


def points_per_turn_at(ply: int) -> int:
    """What the turn at *ply* pays the side playing it."""
    stage = overtime_stage_at(ply)
    return stage['points'] if stage else POINTS_PER_TURN


def turn_points_by(color: str, ply: int) -> int:
    """
    What *color*'s own turns have paid it in points by *ply* - the hand-over
    about to be played, which counts, since a turn pays at its start.

    **Not ``hand_overs_by(color, ply) * POINTS_PER_TURN`` any more.** The rate
    climbs through overtime, so this walks the stretches and counts how many of
    that side's hand-overs fall in each, as a difference of two
    ``hand_overs_by`` at the stretch's ends.

    Past the last stretch it keeps paying at the last rate, for the reason the
    toll keeps taking at it: the verdict there is read and not enforced, and a
    game played on must not quietly stop settling up.
    """
    played = max(0, int(ply))
    start = OVERTIME_FIRST_PLY - 1
    points = hand_overs_by(color, min(played, start)) * POINTS_PER_TURN
    for stage in OVERTIME_STAGES:
        if played <= start:
            return points
        end = start + stage['turns'] * PLIES_PER_TURN
        points += (hand_overs_by(color, min(played, end))
                   - hand_overs_by(color, start)) * stage['points']
        start = end
    if played <= start:
        return points
    return points + ((hand_overs_by(color, played) - hand_overs_by(color, start))
                     * OVERTIME_STAGES[-1]['points'])


def is_initialization(ply: int) -> bool:
    """
    The opening turns, where nobody attacks and both sides set out.

    **The opening only** - not a numbered phase's initialization turn, which is
    one turn with its own allowances (:func:`is_phase_initialization`). Widening
    this to mean "any setup turn" would hand the opening's one-move-per-phase
    lock to a single turn that was never about it; :func:`is_setup_turn` is the
    predicate for what the two genuinely share.
    """
    return phase_index_at(ply) == 0


def is_scoring_phase(ply: int) -> bool:
    """
    The phases that bank a score, as a question about a hand-over. The opening
    and overtime are the two that do not.
    """
    return phase_index_at(ply) in SCORING_PHASES


def is_phase_initialization(ply: int) -> bool:
    """
    A numbered phase's own initialization turn: the first turn of its span,
    which its ten turns of play do not count.

    One full turn - white's hand-over and black's. Both sides get one, because
    a turn either side could set out on and the other could not would hand the
    second mover a free look at the first's deployment.
    """
    index = phase_index_at(ply)
    return bool(PHASES[index].get('init')) and turn_of(ply) == phase_start_turn(index)


def is_setup_turn(ply: int) -> bool:
    """
    A turn given to setting out rather than playing: the opening's three, and
    each numbered phase's initialization turn.

    What the two share, and *all* they share: **nobody attacks and no ability
    fires**. Their movement allowances differ - the opening gives a battlefield
    unit one move for the whole phase, a phase initialization gives five
    crossings and three walks home for the one turn - so anything about how
    much may move asks the narrower predicate.
    """
    return is_initialization(ply) or is_phase_initialization(ply)


def no_attack_message(ply: int) -> str:
    """
    What to tell someone who tried to strike on a turn given to setting out.

    Two turns refuse a blow for two different reasons, and saying "the opening"
    on turn 15 would send the player looking at a phase that ended ten turns
    ago. Lives here rather than at the two call sites so the browser engine's
    copy has one thing to mirror.

    Total, not partial: a ply that refuses no blow gets ``''``. Asked the other
    way round - "not the opening, so a phase initialization" - it answered
    ``Nobody attacks in a phase initialization`` for every playable turn of
    every phase, which is the reading a caller without a guard would take.
    """
    if is_phase_initialization(ply):
        return 'Nobody attacks in a phase initialization'
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
    The first full turn of a phase - its initialization turn, where it has one.
    Counted in spans, so an earlier phase's init turn pushes this along too.
    """
    turn = 1
    for i in range(index):
        turn += phase_span(PHASES[i])
    return int(turn)


def play_start_turn(index: int) -> int:
    """
    The first turn a phase actually *plays*: one past its start where it opens
    with an initialization turn, its start where it does not. What the halftime
    splits, since the init turn is not one of the ten it halves.
    """
    return phase_start_turn(index) + (1 if PHASES[index].get('init') else 0)


def before_halftime(ply: int) -> bool:
    """
    Whether a turn falls before its phase's break - or in a phase that has no
    break to fall either side of. The opening and overtime are the two of
    those, so they are always "before".
    """
    index = phase_index_at(ply)
    phase = PHASES[index]
    if not phase['halftime']:
        return True
    return turn_of(ply) < play_start_turn(index) + phase['turns'] / 2


def is_wrap_open(ply: int) -> bool:
    """
    Whether the wrap is open - the crossing out of a side's base, over its
    outer tip and onto the reserve tip across the board.

    **Only the played first half of a numbered phase.** Not the opening, not a
    phase's initialization turn, and not overtime: the owner's rule is that the
    wrap belongs to the half before the halftime and to nothing else. On the
    shipped schedule that is turns 5-9, 16-20 and 27-31, and no others.

    :func:`before_halftime` alone used to be the whole answer, and it said yes
    for every phase that has no break to fall either side of - which quietly
    included the opening and the whole of overtime.
    """
    return (
        is_scoring_phase(ply)
        and not is_phase_initialization(ply)
        and before_halftime(ply)
    )


def is_entry_open(ply: int) -> bool:
    """
    Whether units may come out of the reserve onto the board - the three arrows
    on each side's reserve, pointing in.

    Open on any setup turn and through a phase's halftime half; shut through
    the played first half and through overtime. On the shipped schedule that is
    turns 1-4, 10-15, 21-26 and 32-36.

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
    1-4, 15, 26 and 37 on.

    Overtime is the owner's exception and is not a setup turn: the toll is
    running and units are still attacking, so a walk home there is an ordinary
    move that happens to end off the board. What does not change with the
    window is *who* may go - a unit standing in its own first three rows that
    can reach a doorway within its MOV - which :func:`panels.homecoming_targets`
    answers off the board, not off the clock.
    """
    return is_setup_turn(ply) or is_overtime(ply)


def stage_at(ply: int) -> str:
    """Where the match is: `Phase 1 Initialization`, `Overtime 2`, ..."""
    phase = phase_at(ply)
    if is_phase_initialization(ply):
        return f"{phase['name']} Initialization"
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
