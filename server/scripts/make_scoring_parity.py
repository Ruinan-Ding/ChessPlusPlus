"""Write the scoring parity fixtures both engines are tested against.

    venv/Scripts/python.exe scripts/make_scoring_parity.py     # from server/

The match's arithmetic - the capture zones and what their hexes are worth,
the phase bank, deaths, the schedule's endings, the CP award, the points the
schedule pays and the overtime conversion - is written twice, in ``game/engine/scoring.py`` and
``phases.py`` and in the client's ``match-score.ts``, ``hex-rules.ts`` and
``phases.ts``. Each side's own tests pin their own numbers, so a rule changed
on one side alone passes both. This file is the check that the two agree:
fixed cases from a fixed seed, with this engine's answers, written to
``client/src/app/services/scoring-parity.json`` - where the client's spec can
import it - and asserted by both suites (``test_scoring_parity.py`` and
``scoring-parity.spec.ts``).

**Run it only when the rules changed on purpose, in both engines.** It writes
this engine's answers as the truth; the client suite then fails until the
client says the same. Regenerating to quiet a failing server test is the one
way to use it wrongly.
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)

from game.engine import economy, phases, scoring  # noqa: E402
from game.engine.config_loader import DEFAULT_CONFIG  # noqa: E402

OUT = os.path.join(os.path.dirname(SERVER), 'client', 'src', 'app', 'services', 'scoring-parity.json')
SEED = 20260925
CASES = 40
UNITS = {'pawn': {'value': 5}, 'rook': {'value': 12}, 'king': {'value': 30}}
PLIES = [26, 27, 48, 49, 70, 71, 72, 73, 74, 99, 100, 101, 102]


def make_cases(rng):
    cases = []
    for _ in range(CASES):
        radius = rng.choice([5, 8, 11, 11, 11])
        board = {}
        for _ in range(rng.randint(0, 16)):
            q, r = rng.randint(-radius, radius), rng.randint(-radius, radius)
            if max(abs(q), abs(r), abs(q + r)) <= radius:
                board[f'{q},{r}'] = {'unit_id': rng.choice(sorted(UNITS)),
                                     'color': rng.choice(['white', 'black'])}
        history = []
        for _ in range(rng.randint(0, 8)):
            move = {
                'color': rng.choice(['white', 'black']),
                'unit_id': rng.choice(['pawn', 'king', 'rook', None]),
                'captured': rng.choice(['pawn', 'rook', None]),
                'defender_eliminated': rng.random() < 0.4,
                'attacker_eliminated': rng.random() < 0.2,
                'turn': rng.randint(1, 110),
            }
            if rng.random() < 0.3:
                move.update({'intoPanel': True, 'panelAttack': True,
                             'panel': rng.choice(['bl', 'tr', 'br', 'tl'])})
            history.append(move)
        bank = {}
        for p in (1, 2, 3):
            if rng.random() < 0.5:
                bank[str(p)] = {'white': rng.randint(0, 25), 'black': rng.randint(0, 25)}
                if rng.random() < 0.1:
                    bank[str(p)]['late'] = True
        cases.append({
            'config': {'board': {'radius': radius}, 'units': UNITS},
            'board': board, 'history': history, 'bank': bank,
            'ply': rng.choice(PLIES + [rng.randint(1, 120)]),
        })
    for color in ('white', 'black'):
        opponent = 'black' if color == 'white' else 'white'
        for unit_id in DEFAULT_CONFIG['units']:
            for zone in scoring.capture_zones(11):
                q, r = map(int, zone['center'].split(','))
                for enemy in (None, 'pawn', 'rook', 'queen'):
                    board = {zone['center']: {'unit_id': unit_id, 'color': color}}
                    if enemy:
                        board[f'{q + 2},{r}'] = {'unit_id': enemy, 'color': opponent}
                    cases.append({'config': {'board': {'radius': 11}, 'units': {uid: {'value': u['value'], 'captureZones': u['captureZones']}
                                               for uid, u in DEFAULT_CONFIG['units'].items()}}, 'board': board, 'history': [],
                                  'bank': {}, 'ply': 27})
    for phase, ply in ((1, 17), (2, 39), (3, 61)):
        config = {'board': {'radius': 11}, 'units': UNITS, 'rules': {'upAtStart': 10}}
        board = {'-3,6': {'unit_id': 'pawn', 'color': 'white'},
                 '7,0': {'unit_id': 'rook', 'color': 'black'}}
        history = [{'turn': ply - 1, 'color': 'white', 'unit_id': 'pawn',
                    'attacker_eliminated': True},
                   {'turn': ply - 1, 'color': 'black', 'unit_id': 'rook',
                    'captured': 'pawn', 'defender_eliminated': True},
                   {'panelMove': True, 'price': 5, 'unit': {'color': 'white'}},
                   {'withdrawn': True, 'unit_id': 'rook', 'color': 'black'}]
        for at in (ply - 1, ply, ply + 1):
            cases.append({'config': config, 'board': board, 'history': history, 'bank': {}, 'ply': at})
        awards = scoring.halftime_up_awards(config, board, history, ply)
        cases.append({'config': config, 'board': {}, 'history': history + awards, 'bank': {}, 'ply': ply})
    for color in ('white', 'black'):
        other = 'black' if color == 'white' else 'white'
        history = [{'turn': 55, 'unitCast': {'color': color, 'cost': 3, 'gain': 8}},
                   {'turn': 55, 'abilityDeath': {'unit_id': 'pawn', 'color': color}},
                   {'turn': 56, 'abilityDeath': {'unit_id': 'king', 'color': color}},
                   {'turn': 57, 'withdrawn': True, 'unit_id': 'pawn', 'color': color, 'refundColor': other},
                   {'turn': 58, 'withdrawn': True, 'unit_id': 'pawn', 'color': color,
                    'defender_eliminated': True, 'captured': 'rook', 'refundColor': color}]
        cases.append({'config': {'board': {'radius': 11}, 'units': UNITS},
                      'board': {}, 'history': history, 'bank': {}, 'ply': 58})
    for phase, first, loss in ((1, 27, 'white'), (2, 49, 'black')):
        for ply in (first, first + 1, first + 2):
            cases.append({'config': {'board': {'radius': 11}, 'units': UNITS}, 'board': {}, 'history': [],
                          'bank': {str(phase): {'white': 0, 'black': 0, 'pendingLoss': loss}}, 'ply': ply})
        cases.append({'config': {'board': {'radius': 11}, 'units': UNITS}, 'board': {}, 'history': [],
                      'bank': {str(phase): {'white': 0, 'black': 0, 'pendingLoss': loss, 'late': True}}, 'ply': first + 2})
    return cases


def answers(case):
    config, board, history, bank, ply = (
        case['config'], case['board'], case['history'], case['bank'], case['ply'])
    radius = config['board']['radius']
    ending = scoring.schedule_ending(bank, ply)
    return {
        'up': [economy.unit_points_of(side, history, config) for side in ('white', 'black')],
        'halftimeUp': scoring.halftime_up_awards(config, board, history, ply),
        'claims': dict(sorted(scoring.capture_claims(board, radius, config).items())),
        'cap': [scoring.cap_of(board, radius, side, config) for side in ('white', 'black')],
        'bank': scoring.bank_ended_phases(bank, config, board, history, ply),
        'deaths': [[scoring.deaths_of(config, history, side, p) for p in (1, 2, 3, None)]
                   for side in ('white', 'black')],
        'decided': scoring.decided_on_points(bank),
        'ending': list(ending) if ending else None,
        'cp': [scoring.cp_awarded(bank, side, 5) for side in ('white', 'black')],
        'vp': [[p] + [scoring.vp_as_points(bank, side, p) for side in ('white', 'black')]
               for p in (72, 73, 74, ply)],
        'scheduled': [scoring.scheduled_points(bank, side, ply) for side in ('white', 'black')],
    }


def main():
    rng = random.Random(SEED)
    cases = make_cases(rng)
    for case in cases:
        case['expect'] = answers(case)
    fixtures = {
        'zones': {str(r): dict(sorted(scoring.capture_zone_values(r).items())) for r in (5, 8, 11)},
        'plies': [[p, phases.turn_points_by('white', p), phases.turn_points_by('black', p),
                   phases.overtime_toll_at(p)] for p in range(0, 111)],
        'totals': [[m, cap, d, scoring.phase_total(cap, d, m)]
                   for m in (1, 2, 3) for cap in range(0, 9) for d in range(0, 13, 3)],
        'cases': cases,
    }
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(fixtures, f, sort_keys=True, separators=(',', ':'))
        f.write('\n')
    print(f'wrote {len(cases)} cases to {os.path.relpath(OUT, os.path.dirname(SERVER))}')


if __name__ == '__main__':
    main()
