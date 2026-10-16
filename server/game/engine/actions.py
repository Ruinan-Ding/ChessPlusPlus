"""Deterministic battlefield transitions; no sockets, ORM writes or turn clocks.

The supplied state is the caller's private working state. Combat may append
resolved passive effects to it; persistence and revision checks belong to callers.
"""
from dataclasses import dataclass

from . import economy, panels
from .config_loader import DEFAULT_CONFIG
from .game_rules import section_of
from .ability_rules import AbilityContext, actions_used, battlefield_action_bonus, bonus, carries, passive
from .board import HexBoard, parse_coord, hex_distance
from .game_logic import finished_unit_uids, board_move_uids, board_move_landings, board_moves_at, can_attack, get_legal_moves_filtered, opening_moved_hexes, resolve_combat, resolve_heal
from .phases import attacks_allowed, board_moves_per_turn, is_homecoming_open, is_initialization, is_setup_turn, no_attack_message, stage_rules
from .unit_combat import attack_allowed, after_exchange, taunt_allows
from .unit_stats import active_vet, cap_stat, unit_stats


class ActionRefused(ValueError):
    """A legal-input command that the current position does not permit."""


@dataclass(frozen=True)
class ResolvedMove:
    board: HexBoard
    record: dict
    holding: bool


def claim_board_move(state, color, from_key, data) -> bool:
    """Claim a battlefield slot, allowing only the current unit to continue.

    `more` holds the seat for independent panel actions, even when the
    battlefield allowance is full; an explicit pass finishes an atomic batch.
    """
    history = list(state.move_history)
    piece = state.board_state.get(from_key, {})
    uid = piece.get('uid')
    if uid in finished_unit_uids(history, state.turn_number, color, state.config_snapshot, 'battlefield'):
        raise ActionRefused('That unit has already moved this turn')
    if uid and any(move.get('entered') and move.get('turn') == state.turn_number
                   and move.get('color') == color and (move.get('unit') or {}).get('uid') == uid
                   for move in history if isinstance(move, dict)):
        raise ActionRefused('That unit has crossed onto the board this turn')
    if state.ability_state:
        progress = state.ability_state.get('unitProgress', {}).get(uid, {})
        destination = panels.coord_key(*parse_coord(data.get('to', from_key)))
        occupant = state.board_state.get(destination)
        walking = destination != from_key and not (occupant and occupant.get('color') != color and not data.get('attack'))
        if state.ability_state.get('usedUnits', {}).get(uid) == state.turn_number and walking and not (
                passive(piece, state.config_snapshot).get('effect') == 'rapid-movement' and (progress.get('attacked') or passive(piece, state.config_snapshot).get('freeOrder'))):
            raise ActionRefused('Movement ends after using a unit ability')
        if state.ability_state.get('endedUnits', {}).get(uid) == state.turn_number or progress.get('ended'):
            raise ActionRefused('That unit has already moved this turn')
        if progress:
            rapid = passive(piece, state.config_snapshot).get('effect') == 'rapid-movement'
            if (state.ability_state.get('activeUnit') != uid) or progress.get('healed') or (
                    progress.get('attacked') and (not rapid or data.get('attack') or data.get('heal'))):
                raise ActionRefused('That unit has already moved this turn')
            return bool(data.get('more'))
        if state.ability_state.get('extraUnits', {}).get(uid) == state.turn_number:
            return bool(data.get('more'))
    if uid in board_move_uids(history, state.turn_number, color, state.config_snapshot):
        return bool(data.get('more'))
    moves_allowed = board_moves_per_turn(state.turn_number, config=state.config_snapshot) + battlefield_action_bonus(history, state.turn_number, color)
    moves_used = board_moves_at(history, state.turn_number, color, state.config_snapshot)
    if state.ability_state:
        moves_used = actions_used(state, color)
    if moves_used >= moves_allowed:
        raise ActionRefused(f'That side has had all {moves_allowed} of its moves this turn')
    if from_key in board_move_landings(history, state.turn_number, color, config=state.config_snapshot):
        raise ActionRefused('That unit has already moved this turn')
    return bool(data.get('more'))


def resolve_move(state, data) -> ResolvedMove:
    # Healing replaces the strike, never supplements it or a walk home.
    if data.get('heal') and (data.get('attack') or data.get('withdraw')):
        raise ActionRefused('Heal, attack or walk home: choose one')

    from_coord = data['from']
    to_coord = data['to']

    config = state.config_snapshot
    radius = config.get('board', {}).get('radius', DEFAULT_CONFIG['board']['radius'])
    board = HexBoard.from_dict(radius, state.board_state)

    # Coordinates come straight off the wire - reject malformed input
    # as a client error, not an INTERNAL_ERROR with a traceback.
    try:
        fq, fr = parse_coord(from_coord)
        tq, tr = parse_coord(to_coord)
        from_coord = panels.coord_key(fq, fr)
        to_coord = panels.coord_key(tq, tr)
    except ValueError:
        raise ActionRefused('Malformed move coordinates')

    piece = board.get(fq, fr)
    if not piece:
        raise ActionRefused('No piece at source coordinate')

    my_color = 'white' if state.current_turn == state.player_white else 'black'
    if piece['color'] != my_color:
        raise ActionRefused('That piece is not yours')
    if state.ability_state and (carries(state.ability_state.get('buffs', {}).get(piece.get('uid')), 'action-lock')
            or state.ability_state.get('endedUnits', {}).get(piece.get('uid')) == state.turn_number):
        raise ActionRefused('That unit cannot take another action')

    # Stage attack/heal gates and the once-per-opening lock are independent.
    # Apply both before considering a withdrawal.
    if not attacks_allowed(state.turn_number, config=config):
        if data.get('attack'):
            raise ActionRefused(no_attack_message(state.turn_number, config=config))
        # Moving onto an enemy is an attack too, by another road.
        landing = board.get(tq, tr)
        if landing and landing.get('color') != my_color:
            raise ActionRefused(no_attack_message(state.turn_number, config=config))
    if data.get('heal') and not stage_rules(state.turn_number, config)['normalHeal']:
        raise ActionRefused('Healing is disabled in this stage')
    if is_initialization(state.turn_number, config=config) and not state.ability_state.get('unitProgress', {}).get(piece.get('uid')):
        if panels.coord_key(fq, fr) in opening_moved_hexes(
                list(state.move_history), my_color, config=config):
            raise ActionRefused('That unit has had its move for the opening')

    # Checked here for every board move, the walk home included.
    holding = claim_board_move(
        state, my_color, panels.coord_key(fq, fr), data)
    # Withdrawal validates real doorways, occupied panels and the remaining walk budget.
    if data.get('withdraw'):
        if data.get('attack'):
            raise ActionRefused('A unit cannot strike and walk home in one turn')
        # Explain commander and home-row refusals before the generic doorway failure.
        if config.get('units', {}).get(piece['unit_id'], {}).get('commander'):
            raise ActionRefused('The king never walks home')
        if not is_homecoming_open(state.turn_number, config=config):
            raise ActionRefused('The way home is shut')
        if not panels.in_home_rows(my_color, fr, radius, config=config):
            raise ActionRefused('Only your own first three rows walk home')
        from_key = panels.coord_key(fq, fr)
        to_key = panels.coord_key(tq, tr)
        orientation = config.get('board', {}).get('orientation', 'edge-up')
        occupancy = panels.panel_occupancy(
            config, radius, list(state.move_history), orientation, ply=state.turn_number, ability_state=state.ability_state or None)
        home = panels.homecoming_targets(
            config, radius, occupancy, board.to_dict(), from_key, orientation,
            moves_left=max(0, cap_stat(unit_stats(piece['unit_id'], config, active_vet(piece, config)).get('move', 0)
                                    + bonus(piece, config, state.ability_state, 'mov', key=from_key))
                              - state.ability_state.get('unitProgress', {}).get(piece.get('uid'), {}).get('spent', 0)) if state.ability_state else None,
            hop=bool(state.ability_state and passive(piece, config).get('effect') == 'hop'))
        if to_key not in home:
            raise ActionRefused('That unit cannot walk home there')

        leaving = board.remove(fq, fr)
        move_record = {
            'from': from_key,
            'to': to_key,
            'unit_id': leaving['unit_id'],
            'color': leaving['color'],
            'turn': state.turn_number,
            'captured': None,
            'attacked': False,
            'damage_dealt': 0,
            'defender_eliminated': False,
            'moved': True,
            # The unit as it stood when it left, HP and uid and all:
            # once it is off the board this record is the only place it
            # survives, and what the base is rebuilt from on a reload.
            'withdrawn': True,
            'unit': economy.withdrawn_unit(config, leaving, panels.panel_of(*panels.axial_to_pixel(
                *parse_coord(to_key), config.get('board', {}).get('orientation', 'edge-up')))),
            **({'veterancyReset': True} if section_of(config, 'economy')['walkHomeRefund'].get('resetVeterancy') else {}),
            'refund': economy.withdrawal_refund(config, leaving),
            'refundColor': leaving.get('owner', leaving['color']),
        }
        return ResolvedMove(board, move_record, is_setup_turn(state.turn_number, config=config) or holding)

    walk_cost = 0
    # A turn is "walk, then optionally swing": `to` is where the unit
    # ends up (possibly where it already stands) and `attack` names a
    # hex it strikes from there.
    attack_coord = data.get('attack')
    heal_coord = data.get('heal')
    # A message may also carry moveBonus/bonuses - one-turn ability
    # boosts. Ignore those outcomes; only persisted server ability
    # state can change a networked unit's stats.
    if (tq, tr) != (fq, fr):
        spent = state.ability_state.get('unitProgress', {}).get(piece.get('uid'), {}).get('spent', 0)
        legal_dests = get_legal_moves_filtered(
            board, (fq, fr), config, my_color, -spent, ability_state=state.ability_state or None)
        if (tq, tr) not in legal_dests:
            raise ActionRefused('Illegal move for this piece')
        if state.ability_state:
            limit = max(0, cap_stat(unit_stats(piece['unit_id'], config, active_vet(piece, config)).get('move', 0) + bonus(piece, config, state.ability_state, 'mov', key=from_coord)) - spent)
            costs, _ = panels.move_costs(board.to_dict(), fq, fr, config, radius, limit,
                hop=passive(piece, config).get('effect') == 'hop')
            walk_cost = costs.get(to_coord, 0)
    elif not attack_coord and not heal_coord:
        raise ActionRefused('A move must change hexes')

    if heal_coord:
        try:
            hq, hr = parse_coord(heal_coord)
            if (tq, tr) != (fq, fr):
                board.move(fq, fr, tq, tr)
            combat = resolve_heal(board, (tq, tr), (hq, hr), config, state.ability_state or None)
            combat['moved'] = (tq, tr) != (fq, fr)
        except ValueError as e:
            raise ActionRefused(str(e))
    elif attack_coord:
        if config.get('units', {}).get(piece['unit_id'], {}).get('heal'):
            raise ActionRefused('This unit heals instead of attacking')
        try:
            aq, ar = parse_coord(attack_coord)
            attack_coord = panels.coord_key(aq, ar)
        except ValueError:
            raise ActionRefused('Malformed attack coordinate')
        target = board.get(aq, ar)
        if not target or target['color'] == my_color:
            raise ActionRefused('No enemy unit on the attacked hex')
        unit_def = unit_stats(piece['unit_id'], config, active_vet(piece, config))
        if not (attack_allowed(piece, hex_distance((tq, tr), (aq, ar)), config, state.ability_state, key=to_coord) if state.ability_state else can_attack(unit_def, hex_distance((tq, tr), (aq, ar)))):
            raise ActionRefused('That hex is out of attack range')
        if state.ability_state:
            occupied = AbilityContext(state).recipients()
            occupied[to_coord] = piece
            if not taunt_allows(occupied, to_coord, attack_coord, config, state.ability_state):
                raise ActionRefused('Attack a reachable taunting unit')
        if (tq, tr) != (fq, fr):
            board.move(fq, fr, tq, tr)
        combat = resolve_combat(board, (tq, tr), (aq, ar), config, state.ability_state or None)
        combat['moved'] = (tq, tr) != (fq, fr)
    else:
        combat = resolve_combat(board, (fq, fr), (tq, tr), config, state.ability_state or None)

    move_record: dict = {
        'from': from_coord,
        'to': to_coord,
        'unit_id': piece['unit_id'], 'uid': piece.get('uid'), 'steps': walk_cost,
        'color': my_color,
        'turn': state.turn_number,
        'captured': combat['captured_unit']['unit_id'] if combat['captured_unit'] else None,
        'attacked': combat['attacked'],
        'damage_dealt': combat['damage_dealt'],
        'defender_eliminated': combat['defender_eliminated'],
        'moved': combat['moved'],
    }
    if attack_coord:
        move_record['attackedHex'] = attack_coord
        move_record['counter_damage'] = combat.get('counter_damage', 0)
        if combat.get('leech_heal'):
            move_record['leech_heal'] = combat['leech_heal']
        move_record['countered'] = combat.get('countered', combat.get('counter_damage', 0) > 0)
        target = combat.get('defender_before')
        if target:
            move_record['counterActor'] = {key: target.get(key) for key in ('unit_id', 'color', 'uid')}
        move_record['attacker_eliminated'] = combat.get('attacker_eliminated', False)
    if heal_coord:
        for key in ('healedHex', 'healed_amount', 'healed_hp', 'healed_unit'):
            move_record[key] = combat[key]
    if combat['defender_hp'] is not None:
        move_record['defender_hp'] = combat['defender_hp']

    if state.ability_state and combat.get('attacker_before'):
        ctx = AbilityContext(state, board.to_dict(), list(state.move_history))
        after_exchange(ctx, to_coord, attack_coord or to_coord, combat['attacker_before'], combat['defender_before'],
                       {'target_hp': combat.get('defender_hp') or 0, 'attacker_hp': combat.get('attacker_hp') or 0})
        state.move_history = ctx.history
        board = HexBoard.from_dict(radius, ctx.board)
        if combat.get('second_strike'):
            move_record['secondStrike'] = True
        if combat.get('second_counter'):
            move_record['secondCounter'] = True
            move_record['second_counter_damage'] = combat['second_counter_damage']
        move_record['uid'] = piece.get('uid')


    return ResolvedMove(board, move_record, holding)

def record_unit_progress(state, record):
    if not state.ability_state or record.get('panelMove') or record.get('entered'):
        return
    uid = record.get('uid') or (record.get('unit') or {}).get('uid')
    if not uid:
        return
    existing = uid in state.ability_state.get('unitProgress', {})
    if existing:
        record['continuedAction'] = True
    progress = state.ability_state.setdefault('unitProgress', {}).setdefault(uid, {'spent': 0, 'origin': record.get('from')})
    progress['spent'] += record.get('steps', record.get('cost', 0))
    progress['attacked'] = progress.get('attacked', False) or record.get('attacked', False)
    progress['healed'] = progress.get('healed', False) or bool(record.get('healedHex'))
    progress['ended'] = bool(record.get('withdrawn') or record.get('entered'))
    state.ability_state['activeUnit'] = uid
