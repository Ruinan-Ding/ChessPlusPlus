"""
The match schedule. Mirrors ``client/src/app/services/phases.ts``.

Five phases: three turns to set up, three ten-turn phases with a halftime
halfway through each, then overtime, which runs until the game ends.

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
from typing import Dict, List

#: Hand-overs to a full turn: white plays, then black.
PLIES_PER_TURN = 2

#: The schedule. ``turns`` is ``math.inf`` for the phase that runs out the
#: match; ``halftime`` breaks a phase evenly in two.
PHASES: List[Dict] = [
    {'name': 'Initialization', 'turns': 3, 'halftime': False},
    {'name': 'Phase 1', 'turns': 10, 'halftime': True},
    {'name': 'Phase 2', 'turns': 10, 'halftime': True},
    {'name': 'Phase 3', 'turns': 10, 'halftime': True},
    {'name': 'Overtime', 'turns': math.inf, 'halftime': False},
]

#: The phases that bank a score, by their place in the schedule.
SCORING_PHASES = [1, 2, 3]

#: What overtime takes off a commander at the end of each of its side's turns.
#: Real damage, and a commander on this much HP dies of it.
OVERTIME_TOLL = 1


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
        end += phase['turns']
        if turn <= end:
            return i
    return len(PHASES) - 1


def phase_at(ply: int) -> Dict:
    """Which phase a hand-over falls in."""
    return PHASES[phase_index_at(ply)]


#: The first hand-over of overtime: everything on the schedule has been played.
#: Derived rather than written down, so moving a phase moves this with it.
OVERTIME_FIRST_PLY = int(sum(
    phase['turns'] for phase in PHASES if math.isfinite(phase['turns'])
)) * PLIES_PER_TURN + 1


def is_initialization(ply: int) -> bool:
    """The opening turns, where nobody attacks and both sides set out."""
    return phase_index_at(ply) == 0


def is_overtime(ply: int) -> bool:
    """The schedule is spent: a deathmatch until a king falls."""
    return phase_index_at(ply) == len(PHASES) - 1


def phase_start_turn(index: int) -> int:
    """The first full turn of a phase."""
    turn = 1
    for i in range(index):
        turn += PHASES[i]['turns']
    return turn


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
    return turn_of(ply) < phase_start_turn(index) + phase['turns'] / 2


def is_wrap_open(ply: int) -> bool:
    """
    Whether the wrap is open - the crossing out of a side's base, over its
    outer tip and onto the reserve tip across the board.

    Open through the opening, the first half of each numbered phase, and
    overtime; shut from a phase's halftime to its end. On the shipped schedule
    that is turns 1-8, 14-18, 24-28 and 34 on.
    """
    return before_halftime(ply)


def stage_at(ply: int) -> str:
    """Where the match is, as a name: `Phase 1`, `Phase 1 Halftime`, ..."""
    phase = phase_at(ply)
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
