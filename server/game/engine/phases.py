"""Per-match schedule and stage permissions. Mirrors phases.ts."""
import math
from .game_rules import section_of

PLIES_PER_TURN = 2


def phases_of(config=None):
    match = section_of(config, 'match')
    opening = match['opening']
    return [dict(opening, points=opening['pointsPerTurn'], multiplier=1, halftime=False, postmatch=False, postmatchTurns=0),
            *[dict(p, points=p['pointsPerTurn'], multiplier=p['vpMultiplier'], halftime=p['halftimeAfter'] > 0,
                   postmatch=p['postmatchTurns'] > 0) for p in match['phases']],
            dict(match['overtime'], turns=math.inf, points=match['overtime']['pointsPerTurn'], grant=0,
                 multiplier=1, halftime=False, postmatch=False, postmatchTurns=0)]


def scoring_phases(config=None):
    return range(1, len(section_of(config, 'match')['phases']) + 1)


def overtime_stages(config=None):
    return [dict(s, toll=s['kingToll'], moves=s['moves']['battlefield'], categoryMoves=s['moves'])
            for s in section_of(config, 'match')['overtime']['stages']]


def phase_span(phase):
    return phase['turns'] + phase.get('postmatchTurns', int(bool(phase.get('postmatch'))))


def turn_of(ply):
    return math.ceil(ply / PLIES_PER_TURN)


def side_of_ply(ply):
    return 'white' if ply % 2 else 'black'


def hand_overs_by(color, ply):
    played = max(0, ply)
    return math.ceil(played / 2) if color == 'white' else math.floor(played / 2)


def phase_index_at(ply, config=None):
    turn, end = turn_of(ply), 0
    phases = phases_of(config)
    for index, phase in enumerate(phases[:-1]):
        end += phase_span(phase)
        if turn <= end:
            return index
    return len(phases) - 1


def phase_at(ply, config=None):
    return phases_of(config)[phase_index_at(ply, config)]


def phase_start_turn(index, config=None):
    return 1 + sum(phase_span(p) for p in phases_of(config)[:index])


def overtime_first_ply(config=None):
    return (phase_start_turn(len(phases_of(config)) - 1, config) - 1) * PLIES_PER_TURN + 1


def overtime_last_turn(config=None):
    return turn_of(overtime_first_ply(config)) + sum(s['turns'] for s in overtime_stages(config)) - 1


def is_initialization(ply, config=None):
    return phase_index_at(ply, config) == 0


def is_scoring_phase(ply, config=None):
    return phase_index_at(ply, config) in scoring_phases(config)


def is_overtime(ply, config=None):
    return phase_index_at(ply, config) == len(phases_of(config)) - 1


def is_postmatch(ply, config=None):
    index = phase_index_at(ply, config)
    phase = phases_of(config)[index]
    return bool(phase['postmatch']) and turn_of(ply) >= phase_start_turn(index, config) + phase['turns']


def is_setup_turn(ply, config=None):
    return is_initialization(ply, config) or is_postmatch(ply, config)


def before_halftime(ply, config=None):
    index = phase_index_at(ply, config)
    phase = phases_of(config)[index]
    return not phase['halftime'] or turn_of(ply) < phase_start_turn(index, config) + phase['halftimeAfter']


def stage_key(ply, config=None):
    if is_initialization(ply, config):
        return 'opening'
    if is_postmatch(ply, config):
        return 'postmatch'
    if is_overtime(ply, config):
        return 'overtime'
    return 'firstHalf' if before_halftime(ply, config) else 'secondHalf'


def stage_rules(ply, config=None):
    return section_of(config, 'stageRules')[stage_key(ply, config)]


def is_wrap_open(ply, config=None):
    return stage_rules(ply, config)['wrap']


def is_entry_open(ply, config=None):
    return stage_rules(ply, config)['reserveEntry']


def is_homecoming_open(ply, config=None):
    return stage_rules(ply, config)['homecoming']


def attacks_allowed(ply, config=None):
    return stage_rules(ply, config)['attack']


def no_attack_message(ply, config=None):
    if attacks_allowed(ply, config):
        return ''
    if is_postmatch(ply, config):
        return 'Nobody attacks in the postmatch'
    if is_initialization(ply, config):
        return 'Nobody attacks in the opening'
    return 'Attacks are disabled in this stage'


def overtime_stage_at(ply, config=None):
    if not is_overtime(ply, config):
        return None
    end = turn_of(overtime_first_ply(config)) - 1
    stages = overtime_stages(config)
    for stage in stages:
        end += stage['turns']
        if turn_of(ply) <= end:
            return stage
    return stages[-1]


def moves_per_turn(ply, zone='battlefield', config=None):
    if is_overtime(ply, config):
        return overtime_stage_at(ply, config)['categoryMoves'][zone]
    moves = stage_rules(ply, config)['moves'][zone]
    return moves[max(0, turn_of(ply) - 1)] if isinstance(moves, list) else moves


def board_moves_per_turn(ply, config=None):
    return moves_per_turn(ply, 'battlefield', config)


def overtime_toll_at(ply, config=None):
    stage = overtime_stage_at(ply, config)
    return stage['toll'] if stage else 0


def turn_points_by(color, ply, config=None):
    played, phases = max(0, ply), phases_of(config)
    rates, points = [], 0
    for index, phase in enumerate(phases):
        first = phase_start_turn(index, config)
        start = (first - 1) * PLIES_PER_TURN + 1
        if hand_overs_by(color, played) > hand_overs_by(color, start - 1):
            points += phase['grant']
        rates.append((start, phase['pointsBeforeHalftime'] if phase['halftime'] else phase['points']))
        if phase['halftime']:
            rates.append(((first + phase['halftimeAfter'] - 1) * PLIES_PER_TURN + 1, phase['points']))
        if phase['postmatch']:
            rates.append(((first + phase['turns'] - 1) * PLIES_PER_TURN + 1, phase['postmatchPointsPerTurn']))
    for index, (start, rate) in enumerate(rates):
        if played < start: break
        end = min(played, rates[index + 1][0] - 1) if index + 1 < len(rates) else played
        points += (hand_overs_by(color, end) - hand_overs_by(color, start - 1)) * rate
    return points


def stage_at(ply, config=None):
    phase = phase_at(ply, config)
    if is_postmatch(ply, config):
        return phase['name'] + ' Postmatch'
    if is_overtime(ply, config):
        return overtime_stage_at(ply, config)['name']
    if phase['halftime'] and not before_halftime(ply, config):
        return phase['name'] + ' Halftime'
    return phase['name']


# Default views for external callers inspecting the shipped schedule.
PHASES = phases_of()
SCORING_PHASES = list(scoring_phases())
OVERTIME_STAGES = overtime_stages()
OVERTIME_FIRST_PLY = overtime_first_ply()
OVERTIME_FIRST_TURN = turn_of(OVERTIME_FIRST_PLY)
OVERTIME_LAST_TURN = overtime_last_turn()
BOARD_MOVES_PER_TURN = board_moves_per_turn((section_of(None, 'match')['opening']['turns']) * 2 + 1)
