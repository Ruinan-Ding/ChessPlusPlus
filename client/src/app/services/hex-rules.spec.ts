import {
  hexEffectBand, ZONE_WORTH, canAttack, attackTiers, captureZones, captureClaims, captureScore, captureZoneHexes, captureZoneValues,
  computeAttackZone, computeLegalMoves, computeMoveCosts, inHomeRows, strikeDamage, HOME_ROWS,
  MIN_STRIKE_DAMAGE, strikeFromStats,
} from './hex-rules';
import { DEFAULT_GAME_CONFIG } from './config.service';
import combatParity from './combat-parity.json';

describe('configured unit stats', () => {
  it('agrees with the server on attack eligibility at every ring, including zero tiers and blind spots', () => {
    for (const test of combatParity) {
      expect(canAttack(test.unit, test.distance)).withContext(JSON.stringify(test)).toBe(test.canAttack);
      if ('damage' in test) expect(strikeFromStats(test.unit, test.defender, test.distance, { rules: test.rules }))
        .withContext(JSON.stringify(test)).toBe(test.damage!);
    }
  });

  const config: any = DEFAULT_GAME_CONFIG;
  const radius = config.board.radius;
  const distance = (q: number, r: number) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
  const coords = () => {
    const result: string[] = [];
    for (let q = -radius; q <= radius; q++) {
      for (let r = -radius; r <= radius; r++) {
        if (distance(q, r) <= radius) result.push(`${q},${r}`);
      }
    }
    return result;
  };

  it('uses every unit’s configured movement budget', () => {
    for (const [unitId, unit] of Object.entries<any>(config.units)) {
      const board = { '0,0': { unit_id: unitId, color: 'white' } };
      const actual = computeMoveCosts(board, 0, 0, config, radius);
      const expected = coords().filter(key => {
        const [q, r] = key.split(',').map(Number);
        return key !== '0,0' && distance(q, r) <= unit.move;
      });

      expect([...actual.keys()].sort()).withContext(unitId).toEqual(expected.sort());
      expect(Math.max(0, ...actual.values())).withContext(unitId).toBe(Math.min(unit.move, radius));
    }
  });

  it('uses each unit’s configured attack range', () => {
    for (const [unitId, unit] of Object.entries<any>(config.units)) {
      const actual = computeAttackZone('0,0', new Set(), config, unitId, radius);
      const expected = coords().filter(key => {
        const [q, r] = key.split(',').map(Number);
        return key !== '0,0' && distance(q, r) >= (unit.attackMinRange ?? 1)
          && distance(q, r) <= unit.attackRange;
      });

      expect([...actual].sort()).withContext(unitId).toEqual(expected.sort());
    }
  });

  it('uses every configured attack and defense pair in the damage formula', () => {
    const falloff = config.rules.rangeFalloff;
    const minimum = config.rules.minStrikeDamage;
    for (const [attackerId, attacker] of Object.entries<any>(config.units)) {
      for (const [defenderId, defender] of Object.entries<any>(config.units)) {
        for (const range of [1, attacker.attackRange]) {
          const scaledAttack = range < (attacker.attackMinRange ?? 1) ? 0
            : Array.isArray(attacker.attack) ? attacker.attack[range - (attacker.attackMinRange ?? 1)]
            : attacker.attack <= 0 || range <= 1 ? Math.max(0, attacker.attack)
            : Math.max(
              1,
              Math.trunc(attacker.attack * Math.max(0, 1 - falloff * (range - 1))),
            );
          const expected = scaledAttack <= 0
            ? 0
            : Math.min(scaledAttack, Math.max(minimum, scaledAttack - defender.defense));

          expect(strikeDamage(attackerId, defenderId, range, config))
            .withContext(`${attackerId} vs ${defenderId} at range ${range}`)
            .toBe(expected);
        }
      }
    }
  });
});

/**
 * The attack zone is what the board paints red: reachable to strike, not to
 * stand on. Getting the two sets confused paints the whole preview wrong, so
 * they get a check.
 */
describe('computeAttackZone', () => {
  const config = (move: number, attackRange: number) => ({
    units: { turret: { id: 'turret', move, attackRange } },
  });
  const board = { '0,0': { unit_id: 'turret', color: 'white' } };

  it('is the ring of neighbours for a unit that cannot move', () => {
    const moves = computeLegalMoves(board, 0, 0, config(0, 1), 5);
    const zone = computeAttackZone('0,0', moves, config(0, 1), 'turret', 5);

    expect(moves.size).toBe(0);
    expect([...zone].sort()).toEqual(['-1,0', '-1,1', '0,-1', '0,1', '1,-1', '1,0'].sort());
  });

  it('covers both rings at range 2, and never the hex it stands on', () => {
    const zone = computeAttackZone('0,0', new Set(), config(0, 2), 'turret', 5);

    // A hex disc of radius 2 is 19 hexes; the centre is the unit itself.
    expect(zone.size).toBe(18);
    expect(zone.has('0,0')).toBeFalse();
    expect(zone.has('2,0')).toBeTrue();
    expect(zone.has('3,0')).toBeFalse();
  });

  it('excludes hexes it can move to and anything off the board', () => {
    const moves = computeLegalMoves(board, 0, 0, config(1, 1), 1);
    const zone = computeAttackZone('0,0', moves, config(1, 1), 'turret', 1);

    // Radius 1 board: every neighbour is a legal move, so nothing is left to
    // paint red, and the ring beyond it does not exist.
    expect(moves.size).toBe(6);
    expect(zone.size).toBe(0);
  });

  it('reaches out from every tile the unit could move to', () => {
    const moves = computeLegalMoves(board, 0, 0, config(2, 1), 6);
    const zone = computeAttackZone('0,0', moves, config(2, 1), 'turret', 6);

    // Two steps of movement plus one of reach: the third ring is threatened
    // but cannot be stood on.
    expect(moves.has('3,0')).toBeFalse();
    expect(zone.has('3,0')).toBeTrue();
    expect(zone.has('4,0')).toBeFalse();
  });
});

/**
 * These two mirror strike_damage() / ranged_damage() in game_logic.py. If the
 * server changes its sums, these fail - which is the point.
 */
describe('strikeDamage', () => {
  const config = {
    rules: { rangeFalloff: 0.25 },
    units: {
      archer: { id: 'archer', attack: 26, defense: 12, attackRange: 2 },
      guard: { id: 'guard', attack: 14, defense: 10, attackRange: 1 },
      wall: { id: 'wall', attack: 4, defense: 30, attackRange: 1 },
    },
  };

  it('is attack minus defence next to the target', () => {
    expect(strikeDamage('archer', 'guard', 1, config)).toBe(16);
  });

  it('scales the attack down a ring out, then subtracts defence', () => {
    // 26 * 0.75 = 19 (floored), minus 10 defence.
    expect(strikeDamage('archer', 'guard', 2, config)).toBe(9);
  });

  it('floors at MIN_STRIKE_DAMAGE - armour blunts, it never turns aside', () => {
    // 14 attack into 30 defence is -16, and it used to floor at 0: the pair
    // could trade blows all game and neither would ever move. A blow that
    // lands takes something off.
    expect(strikeDamage('guard', 'wall', 1, config)).toBe(MIN_STRIKE_DAMAGE);
  });

  it('takes the floor from the config, so it cannot drift from the server', () => {
    // The dial lives in `rules.minStrikeDamage` rather than in a constant on
    // each side: a client flooring at 1 against a server flooring at 0
    // disagrees about who is still standing. Same config object that already
    // carries rangeFalloff.
    const withFloor = (min: number) => ({ ...config, rules: { ...config.rules, minStrikeDamage: min } });
    // 14 attack into 30 defence.
    expect(strikeDamage('guard', 'wall', 1, withFloor(1))).toBe(1);
    // 0 is the old rule - armour absorbs the hit whole - and still reachable.
    expect(strikeDamage('guard', 'wall', 1, withFloor(0))).toBe(0);
    // A dial, not a flag.
    expect(strikeDamage('guard', 'wall', 1, withFloor(5))).toBe(5);
    // But never more than the attacker could deal unblunted: the floor lifts a
    // hit armour absorbed, it is not a damage source of its own. Unclamped, a
    // big floor would override attack, defence and falloff all at once. The
    // guard's attack is 14, so 14 is the cap.
    expect(strikeDamage('guard', 'wall', 1, withFloor(9999))).toBe(14);
    // A config that names no floor falls back to the shipped default.
    expect(strikeDamage('guard', 'wall', 1, config)).toBe(MIN_STRIKE_DAMAGE);
  });

  it('leaves an attack of nothing at nothing', () => {
    // The floor lifts a blow that was blunted, not one that was never thrown.
    const unarmed = {
      ...config,
      units: { ...config.units, guard: { ...config.units.guard, attack: 0 } },
    };
    expect(strikeDamage('guard', 'wall', 1, unarmed)).toBe(0);
    expect(strikeDamage('guard', 'wall', 1, unarmed, 100)).toBe(0);
    expect(canAttack(unarmed.units.guard, 1, 100)).toBeFalse();
    expect(attackTiers('guard', unarmed)).toEqual([]);
  });

  it('adds a boost to the scaled ring, which is where the hex shows it', () => {
    // The hex draws the second ring as 19; +2 makes that ring 21, not
    // 28 * 0.75. Same ordering as attackCellText on the board.
    expect(strikeDamage('archer', 'guard', 2, config, 2)).toBe(11);
    // A defence boost comes off after the scaling, like the panel's "12/10".
    expect(strikeDamage('archer', 'guard', 1, config, 0, 4)).toBe(12);
    // Armour still cannot heal, and a boost cannot push it past the floor.
    expect(strikeDamage('guard', 'wall', 1, config, 0, 5)).toBe(MIN_STRIKE_DAMAGE);
  });

  it('lists one damage figure per ring for the hex glyph', () => {
    expect(attackTiers('archer', config)).toEqual([26, 19]);
    expect(attackTiers('guard', config)).toEqual([14]);
  });
});

describe('explicit attack rings', () => {
  it('uses the archer’s four exact attacks, before armor and boosts', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.pawn.defense = 0;
    // A percentage change must leave explicitly configured ring attacks alone.
    config.rules.rangeFalloff = 1;
    expect(attackTiers('archer', config)).toEqual([4, 3, 2, 1]);
    for (const [i, attack] of [4, 3, 2, 1].entries()) {
      expect(strikeDamage('archer', 'pawn', i + 3, config)).toBe(attack);
      expect(strikeDamage('archer', 'pawn', i + 3, config, 2, 3)).toBe(Math.max(1, attack - 1));
    }
    const zone = computeAttackZone('0,0', new Set(), config, 'archer', 11);
    expect(zone.has('2,0')).toBeFalse();
    expect(zone.has('3,0')).toBeTrue();
    expect(zone.has('6,0')).toBeTrue();
    expect(zone.has('7,0')).toBeFalse();
    expect(strikeDamage('archer', 'pawn', 2, config, 30)).toBe(0);
    expect(strikeDamage('shieldman', 'pawn', 1, config, 30)).toBe(0);
    config.units.archer.attack[1] = 0;
    expect(strikeDamage('archer', 'pawn', 4, config, 30)).toBe(30);
  });
});

describe('computeMoveCosts', () => {
  const config = { units: { runner: { id: 'runner', move: 4 } } };
  const roomy = { units: { runner: { id: 'runner', move: 6 } } };

  it('charges the walk, not the straight line, when the way is blocked', () => {
    // A wall of ENEMIES down the q=1 column forces a detour to reach 2,0.
    const board: Record<string, any> = {
      '0,0': { unit_id: 'runner', color: 'white' },
      '1,0': { unit_id: 'runner', color: 'black' },
      '1,-1': { unit_id: 'runner', color: 'black' },
      '0,1': { unit_id: 'runner', color: 'black' },
    };
    const costs = computeMoveCosts(board, 0, 0, roomy, 5);

    // Straight-line distance to 2,0 is 2; every route round the wall is longer.
    expect(costs.get('2,0')).toBeGreaterThan(2);
    expect(costs.get('-1,0')).toBe(1);
  });

  it('walks through its own, and stops only on empty ground', () => {
    // The same wall in your own colour is no wall at all: an ally costs a
    // step to pass but is not somewhere to stop, so it never limits the
    // reach beyond it.
    const board: Record<string, any> = {
      '0,0': { unit_id: 'runner', color: 'white' },
      '1,0': { unit_id: 'runner', color: 'white' },
      '1,-1': { unit_id: 'runner', color: 'white' },
      '0,1': { unit_id: 'runner', color: 'white' },
    };
    const costs = computeMoveCosts(board, 0, 0, roomy, 5);

    // Straight through, at the straight-line cost.
    expect(costs.get('2,0')).toBe(2);
    // But never onto one of them.
    expect(costs.has('1,0')).toBeFalse();
    expect(costs.has('0,1')).toBeFalse();
    // And the step it costs to pass is still spent: with one to give, the
    // hex beyond a friend is out of reach.
    const tight = computeMoveCosts(board, 0, 0, roomy, 5, 1);
    expect(tight.has('2,0')).toBeFalse();
  });

  it('agrees with computeLegalMoves about which hexes are reachable', () => {
    const board = { '0,0': { unit_id: 'runner', color: 'white' } };
    const costs = computeMoveCosts(board, 0, 0, config, 5);
    const set = computeLegalMoves(board, 0, 0, config, 5);
    expect(new Set(costs.keys())).toEqual(set);
    expect(Math.max(...costs.values())).toBe(4);
  });
});

describe('capture zones', () => {
  /** The shipped board: five 19-hex patches, one of them on the origin. */
  const R = 11;

  it('lays out five patches of nineteen, one of them in the middle', () => {
    const zone = captureZoneHexes(R);
    expect(zone.size).toBe(5 * 19);
    expect(zone.has('0,0')).toBeTrue();
    // Two rings out is in; three is not.
    expect(zone.has('2,0')).toBeTrue();
    expect(zone.has('3,0')).toBeFalse();
  });

  it('holds the whole patch from an unopposed centre and fewer from its rim', () => {
    // The middle zone, 2 a hex.
    const middle = captureClaims({ '0,0': { unit_id: 'u', color: 'white' } }, R);
    expect(middle.size).toBe(19);
    expect(captureScore(middle, 'white', R)).toBe(38);
    expect(captureScore(middle, 'black', R)).toBe(0);

    // Outer-ring units score only their occupied hex.
    const rim = captureClaims({ '2,0': { unit_id: 'u', color: 'white' } }, R);
    expect(rim.size).toBe(1);
    expect(captureScore(rim, 'white', R)).toBe(2);
  });

  it("makes the zone in each side's half worth 3 a hex, the middle 2 and the sides 1", () => {
    // The owner, 26 Sep 2026: "make the hex capture zone near my base 3x. the
    // middle hex worth 2x. side hex worth 1x" - hexes 412 and 130, 271, and
    // 264 and 278 on the shipped board.
    expect(ZONE_WORTH).toEqual({ base: 3, middle: 2, side: 1 });
    const worth = captureZoneValues(R);
    expect(['-3,6', '3,-6', '0,0', '7,0', '-7,0'].map(k => worth.get(k))).toEqual([3, 3, 2, 1, 1]);
    // A whole patch is worth what its centre is.
    const count = (w: number) => [...worth.values()].filter(v => v === w).length;
    expect([count(3), count(2), count(1)]).toEqual([38, 19, 38]);
    // Worth the same to either side.
    for (const color of ['white', 'black'] as const) {
      const near = captureClaims({ '-3,6': { unit_id: 'u', color } }, R);
      expect(captureScore(near, color, R)).withContext(color).toBe(57);
    }
  });

  it('is worth nothing at all outside a zone', () => {
    // Between the middle patch and the one to its right, in neither.
    const claims = captureClaims({ '4,0': { unit_id: 'u', color: 'white' } }, R);
    expect(claims.size).toBe(0);
  });

  it('cancels the hexes two sides both reach, and keeps the rest', () => {
    // Two apart down one row, so the claims touch on the hex between them.
    const claims = captureClaims({
      '-1,0': { unit_id: 'u', color: 'white' },
      '1,0': { unit_id: 'u', color: 'black' },
    }, R);
    // 0,0 is next to white's hex and next to black's, so neither holds it.
    expect(claims.get('0,0')).toBeUndefined();
    // What each still holds on its own side of the seam - six of seven each,
    // 2 apiece in the middle zone.
    expect(claims.get('-1,0')).toBe('white');
    expect(claims.get('1,0')).toBe('black');
    expect(captureScore(claims, 'white', R)).toBe(12);
    expect(captureScore(claims, 'black', R)).toBe(12);
  });

  it('leaves a gap of one alone: claims that do not touch do not cancel', () => {
    const claims = captureClaims({
      '-1,0': { unit_id: 'u', color: 'white' },
      '2,0': { unit_id: 'u', color: 'black' },
    }, R);
    // Three apart, so nothing overlaps - white keeps all seven, and black
    // keeps only its occupied outer-ring hex, 2 apiece.
    expect(captureScore(claims, 'white', R)).toBe(14);
    expect(captureScore(claims, 'black', R)).toBe(2);
  });

  it('cancels both units outright when they stand next to each other', () => {
    const claims = captureClaims({
      '0,0': { unit_id: 'u', color: 'white' },
      '1,0': { unit_id: 'u', color: 'black' },
    }, R);
    // Each stands on a hex the other is adjacent to, so both go neutral.
    expect(claims.get('0,0')).toBeUndefined();
    expect(claims.get('1,0')).toBeUndefined();
  });

  it('does not double-count friendly claims within a centre-controlled zone', () => {
    const claims = captureClaims({
      '0,0': { unit_id: 'u', color: 'white' },
      '1,0': { unit_id: 'u', color: 'white' },
    }, R);
    // The centre holds nineteen; its adjacent friend adds no duplicate score.
    expect(claims.size).toBe(19);
    expect(captureScore(claims, 'white', R)).toBe(38);
  });
});

/**
 * Each side's own first three rows. They bound both ends of a unit's journey
 * off the board - a crossing may not stop beyond them, and a walk home may not
 * start outside them - and they are the rows the board tints as a side's own,
 * so the tint and the rule have to agree.
 */
describe('inHomeRows', () => {
  it('gives each side the three rows nearest its own edge', () => {
    expect(HOME_ROWS).toBe(3);
    expect([9, 10, 11].every(r => inHomeRows('white', r, 11))).toBeTrue();
    expect([-9, -10, -11].every(r => inHomeRows('black', r, 11))).toBeTrue();
  });

  it('stops one row short of the fourth', () => {
    expect(inHomeRows('white', 8, 11)).toBeFalse();
    expect(inHomeRows('black', -8, 11)).toBeFalse();
    // And the middle of the board belongs to nobody.
    expect(inHomeRows('white', 0, 11)).toBeFalse();
    expect(inHomeRows('black', 0, 11)).toBeFalse();
  });

  it('never gives a side the other\'s ground', () => {
    expect(inHomeRows('white', -11, 11)).toBeFalse();
    expect(inHomeRows('black', 11, 11)).toBeFalse();
  });

  it('is a point mirror of itself', () => {
    for (let r = -11; r <= 11; r++) {
      expect(inHomeRows('white', r, 11)).toBe(inHomeRows('black', -r, 11));
    }
  });

  it('holds on a board too small to have three rows a side', () => {
    // Radius 2 would put the edge at row 0, which is both sides' at once.
    // Clamped to 1, so the two never overlap however small the board.
    expect(inHomeRows('white', 1, 2)).toBeTrue();
    expect(inHomeRows('black', 1, 2)).toBeFalse();
    expect(inHomeRows('white', 0, 2)).toBeFalse();
  });
});


describe('King Capture passive', () => {
  const unit = (unit_id: string, color: string, vet: number): any => ({ unit_id, color, vet });

  it('unlocks at Vet 2 anywhere in each zone and leaves eligible enemy hexes to their owner', () => {
    for (const zone of captureZones(11)) {
      const [q, r] = zone.center.split(',').map(Number);
      const at = `${q + 2},${r}`, enemyAt = `${q - 1},${r}`;
      for (const color of ['white', 'black']) {
        const enemy = color === 'white' ? 'black' : 'white';
        for (const vet of [0, 1, 2, 3]) {
          const claims = captureClaims({ [at]: unit('king', color, vet), [enemyAt]: unit('queen', enemy, 0) }, 11, DEFAULT_GAME_CONFIG);
          if (vet < 2) expect([...claims.values()].filter(c => c === color).length).toBe(1);
          else {
            expect([...zone.hexes].filter(k => claims.get(k) === color).length).toBe(zone.hexes.size - 1);
            expect(claims.get(enemyAt)).toBe(enemy as 'white' | 'black');
          }
        }
      }
    }
  });

  it('restores ordinary claims for opposing active Capture at Vet 2 or 3, without rank priority', () => {
    for (const white of [0, 1, 2, 3]) for (const black of [0, 1, 2, 3]) {
      const board = { '2,0': unit('king', 'white', white), '-2,0': unit('king', 'black', black) };
      const claims = captureClaims(board, 11, DEFAULT_GAME_CONFIG);
      if ((white >= 2) === (black >= 2)) {
        const legacy = structuredClone(DEFAULT_GAME_CONFIG); legacy.units.king.passive = 'persuade';
        expect(claims).toEqual(captureClaims(board, 11, legacy));
      } else {
        const active = white >= 2 ? 'white' : 'black';
        expect(captureScore(claims, active, 11)).toBe(36);
        expect(captureScore(claims, active === 'white' ? 'black' : 'white', 11)).toBe(2);
      }
    }
  });

  it('ignores ineligible enemies, supports renamed kits and falls back as soon as Capture leaves', () => {
    const custom: any = structuredClone(DEFAULT_GAME_CONFIG);
    custom.units.flagbearer = { ...custom.units.king, passive: 'custom-capture', captureZones: ['middle'] };
    custom.abilities.catalogue['custom-capture'] = { ...custom.abilities.catalogue.capture, id: 'custom-capture' };
    const board = { '2,0': unit('flagbearer', 'white', 2), '0,0': unit('pawn', 'black', 3) };
    expect(captureScore(captureClaims(board, 11, custom), 'white', 11)).toBe(38);
    expect(captureClaims({ '2,0': unit('flagbearer', 'white', 2) }, 11, custom).size).toBe(19);
    expect(captureClaims({ '9,0': unit('flagbearer', 'white', 2) }, 11, custom).size).toBe(0);
    expect(captureClaims({ '0,0': board['0,0'] }, 11, custom).size).toBe(0);
  });
});


describe('capture permissions and centre control', () => {
  const centers = ['-3,6', '0,0', '7,0', '-7,0', '3,-6'];
  const piece = (unit_id: string, color: 'white' | 'black') => ({ unit_id, color });

  it('uses the cumulative roster permissions for both sides in all five zones', () => {
    for (const color of ['white', 'black'] as const) {
      const locations = color === 'white' ? centers : centers.map(key => key.split(',').map(n => -Number(n)).join(','));
      for (const [id, expected] of [
        ['pawn', [57, 0, 0, 0, 0]], ['archer', [57, 0, 0, 0, 0]], ['shieldman', [57, 0, 0, 0, 0]],
        ['bishop', [57, 38, 19, 19, 0]], ['rook', [57, 38, 19, 19, 0]], ['knight', [57, 38, 19, 19, 0]],
        ['king', [57, 38, 19, 19, 57]], ['queen', [57, 38, 19, 19, 57]],
      ] as const) {
        const actual = locations.map(at => captureScore(captureClaims({ [at]: piece(id, color) }, 11, DEFAULT_GAME_CONFIG), color, 11));
        expect(actual).withContext(`${id} ${color}`).toEqual([...expected]);
      }
    }
  });

  it('loses the bonus to any eligible enemy in the zone and restores it when that enemy leaves', () => {
    const center = { '0,0': piece('bishop', 'white') };
    const scored = (board: any) => captureScore(captureClaims(board, 11, DEFAULT_GAME_CONFIG), 'white', 11);
    expect(scored(center)).toBe(38);
    // A pawn cannot neutralize the middle, so it cannot block the bonus.
    expect(scored({ ...center, '2,0': piece('pawn', 'black') })).toBe(38);
    const contested = { ...center, '2,0': piece('rook', 'black') };
    const claims = captureClaims(contested, 11, DEFAULT_GAME_CONFIG);
    expect(captureScore(claims, 'white', 11)).toBe(12);
    expect(captureScore(claims, 'black', 11)).toBe(2);
    expect(claims.has('1,0')).toBeFalse();
    expect(scored({ ...center, '3,0': piece('rook', 'black') })).toBe(38);
    // The enemy's own pawn is eligible in its home zone and blocks an invading queen.
    const invaded = captureClaims({ '3,-6': piece('queen', 'white'), '5,-6': piece('pawn', 'black') }, 11, DEFAULT_GAME_CONFIG);
    expect(captureScore(invaded, 'white', 11)).toBe(18);
    expect(captureScore(invaded, 'black', 11)).toBe(3);
  });

  it('scores only an outer unit’s hex while it still disrupts adjacent enemy claims', () => {
    const alone = { '2,0': piece('bishop', 'white') };
    expect(captureScore(captureClaims(alone, 11, DEFAULT_GAME_CONFIG), 'white', 11)).toBe(2);
    const claims = captureClaims({ ...alone, '0,1': piece('rook', 'black') }, 11, DEFAULT_GAME_CONFIG);
    expect(captureScore(claims, 'white', 11)).toBe(2);
    expect(captureScore(claims, 'black', 11)).toBe(10);
    expect(claims.has('1,0')).toBeFalse();
    expect(claims.has('1,1')).toBeFalse();
    expect(claims.get('0,1')).toBe('black');
    expect(captureScore(captureClaims({ '1,0': piece('bishop', 'white') }, 11, DEFAULT_GAME_CONFIG), 'white', 11)).toBe(14);
  });

  it('reads permissions from opaque config ids and allows an explicit empty list', () => {
    const config = { units: { custom: { captureZones: ['middle'] }, none: { captureZones: [] } } };
    expect(captureScore(captureClaims({ '0,0': piece('custom', 'black') }, 11, config), 'black', 11)).toBe(38);
    expect(captureClaims({ '0,0': piece('none', 'white') }, 11, config).size).toBe(0);
  });
});

describe('CP hex areas', () => {
  it('separates Sap centre, inner drain and outer boost without reaching ring 3', () => {
    const effect = DEFAULT_GAME_CONFIG.abilities.catalogue.anchor;
    expect(hexEffectBand('0,0', '0,0', effect)).toBe('centre');
    expect(hexEffectBand('0,0', '1,-1', effect)).toBe('splash');
    expect(hexEffectBand('0,0', '-2,2', effect)).toBe('outer');
    expect(hexEffectBand('0,0', '3,-3', effect)).toBeNull();
    expect(hexEffectBand('0,0', '2,0', {})).toBeNull();
  });

  it('extends Cleave along horizontal rows with two near cells on each side', () => {
    const effect = { ...DEFAULT_GAME_CONFIG.abilities.catalogue.cleave, area: 'horizontal' as const };
    for (const direction of [-1, 1]) {
      expect(hexEffectBand('2,1', `${2 + direction},1`, effect)).toBe('splash');
      expect(hexEffectBand('2,1', `${2 + 2 * direction},1`, effect)).toBe('splash');
      expect(hexEffectBand('2,1', `${2 + 8 * direction},1`, effect)).toBe('outer');
    }
    expect(hexEffectBand('0,9', '-12,9', effect)).toBe('outer');
    expect(hexEffectBand('2,1', '2,2', effect)).toBeNull();
    expect(hexEffectBand('0,0', '4,-2', effect, 'vertex-up')).toBe('splash');
    expect(hexEffectBand('0,0', '-6,3', effect, 'vertex-up')).toBe('outer');
    expect(hexEffectBand('0,0', '1,0', effect, 'vertex-up')).toBeNull();
  });

  it('extends Trap over four diagonal rays and leaves other directions untouched', () => {
    const effect = { ...DEFAULT_GAME_CONFIG.abilities.catalogue.surge, area: 'cross' as const };
    for (const [dq, dr] of [[0,-1], [1,-1], [0,1], [-1,1]]) {
      expect(hexEffectBand('0,0', `${dq},${dr}`, effect)).toBe('splash');
      expect(hexEffectBand('0,0', `${dq * 2},${dr * 2}`, effect)).toBe('splash');
      expect(hexEffectBand('0,0', `${dq * 8},${dr * 8}`, effect)).toBe('outer');
    }
    expect(hexEffectBand('0,0', '1,0', effect)).toBeNull();
    expect(hexEffectBand('0,0', '-1,0', effect)).toBeNull();
    expect(hexEffectBand('0,0', '1,0', effect, 'vertex-up')).toBe('splash');
    expect(hexEffectBand('0,0', '0,1', effect, 'vertex-up')).toBeNull();
  });
});
