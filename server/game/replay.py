from .engine.game_rules import rule_of
"""Server-owned clock allowance for the completed turn's automatic replay."""
import json
import math
from datetime import timedelta

from django.utils import timezone

from .engine.ability_rules import carries
from .engine.config_loader import DEFAULT_CONFIG_PATH
from .engine.panels import panel_occupancy
from .engine.phases import overtime_toll_at

TIMINGS = json.loads(DEFAULT_CONFIG_PATH.with_name('playback-timings.json').read_text())


def beat(name):
    return math.floor(TIMINGS[name] / TIMINGS['speed'] + .5)


def replay_milliseconds(records):
    """Mirror historyPlayback's beats; simultaneous recipients take one beat."""
    durations, walks, occupants = [], {}, {}
    for record in records:
        if record.get('abilityChoice'):
            if record['abilityChoice'].get('type') != 'reset_pair':
                durations.append(beat('pick'))
        elif record.get('abilityCast'):
            durations.append(beat('glowBrief'))
        elif record.get('unit_id') and record.get('from') and record.get('to') and not record.get('panelEffect'):
            origin, destination = record['from'], record['to']
            actor = record.get('uid') or (record.get('unit') or {}).get('uid') or occupants.get(origin) or origin
            landing = record.get('attackFrom') or destination
            if origin != landing and record.get('moved'):
                if walks.get(actor) != origin:
                    durations.append(beat('move'))
                walks[actor] = landing
                occupants.pop(origin, None)
                occupants[landing] = actor
            if record.get('attacked') or record.get('healedHex'):
                walks.pop(actor, None)
            if record.get('healedHex'):
                durations.append(beat('glowBrief'))
            if record.get('attacked'):
                countered = record.get('countered')
                if countered is None:
                    countered = record.get('counter_damage', 0) > 0
                strikes = 1 + bool(countered) + bool(record.get('secondStrike'))
                durations.extend([2 * beat('strike') + beat('hit')] * strikes)
            if record.get('attackFrom') and destination != landing and record.get('moved'):
                durations.append(beat('move'))
                walks[actor] = destination
                occupants.pop(landing, None)
                occupants[destination] = actor
    durations = durations or [beat('commit')]
    return sum(durations) + len(durations) * beat('gap')


def turn_clock_start(config):
    """Exclude the nonblocking turn notice, including a fresh match's first turn."""
    notice = TIMINGS['notice'] if rule_of(config, 'turnTimeLimit') > 0 else 0
    return timezone.now() + timedelta(milliseconds=notice)


def next_turn_started_at(state, history):
    """Persist replay time once at handover, never on reload or a client claim."""
    config = state.config_snapshot
    started = turn_clock_start(config)
    if rule_of(config, 'turnTimeLimit') <= 0:
        return started
    ply = state.turn_number
    records = [record for record in history if record.get('turn') == ply]
    duration = replay_milliseconds(records)
    radius = config['board']['radius']
    orientation = config['board'].get('orientation', 'edge-up')
    before = panel_occupancy(config, radius, history, orientation, ply)
    after = panel_occupancy(config, radius, history, orientation, ply + 1)
    healed = any(unit['hp'] > before.get(at, {}).get('hp', unit['hp']) for at, unit in after.items())
    color = 'white' if state.current_turn == state.player_white else 'black'
    buffs = (getattr(state, 'ability_state', None) or {}).get('buffs', {})
    toll = overtime_toll_at(ply, config=config) and any(unit.get('color') == color
        and config['units'].get(unit['unit_id'], {}).get('commander')
        and not carries(buffs.get(unit.get('uid')), 'invulnerable')
        for unit in state.board_state.values())
    if healed or toll:
        duration += beat('upkeep')
    return started + timedelta(milliseconds=duration)
