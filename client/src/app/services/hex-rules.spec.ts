import {
  ZONE_WORTH, attackTiers, captureClaims, captureScore, captureZoneHexes, captureZoneValues,
  computeAttackZone, computeLegalMoves, computeMoveCosts, inHomeRows, strikeDamage, HOME_ROWS,
  MIN_STRIKE_DAMAGE,
} from './hex-rules';
import { DEFAULT_GAME_CONFIG } from './config.service';

describe('configured unit stats', () => {
  const config = DEFAULT_GAME_CONFIG;
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
    for (const [unitId, unit] of Object.entries(config.units)) {
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
    for (const [unitId, unit] of Object.entries(config.units)) {
      const actual = computeAttackZone('0,0', new Set(), config, unitId, radius);
      const expected = coords().filter(key => {
        const [q, r] = key.split(',').map(Number);
        return key !== '0,0' && distance(q, r) <= unit.attackRange;
      });

      expect([...actual].sort()).withContext(unitId).toEqual(expected.sort());
    }
  });

  it('uses every configured attack and defense pair in the damage formula', () => {
    const falloff = config.rules.rangeFalloff;
    const minimum = config.rules.minStrikeDamage;
    for (const [attackerId, attacker] of Object.entries(config.units)) {
      for (const [defenderId, defender] of Object.entries(config.units)) {
        for (const range of [1, attacker.attackRange]) {
          const scaledAttack = attacker.attack <= 0 || range <= 1
            ? Math.max(0, attacker.attack)
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

  it('holds seven hexes from the middle of a patch and fewer from its rim', () => {
    // The middle zone, 2 a hex.
    const middle = captureClaims({ '0,0': { unit_id: 'u', color: 'white' } }, R);
    expect(middle.size).toBe(7);
    expect(captureScore(middle, 'white', R)).toBe(14);
    expect(captureScore(middle, 'black', R)).toBe(0);

    // On the rim three of the six neighbours are outside the patch, and
    // adjacency stops at its edge - the open board is worth nothing.
    const rim = captureClaims({ '2,0': { unit_id: 'u', color: 'white' } }, R);
    expect(rim.size).toBe(4);
    expect(captureScore(rim, 'white', R)).toBe(8);
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
      expect(captureScore(near, color, R)).withContext(color).toBe(21);
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
    // keeps the four of its own that are still inside the patch, 2 apiece.
    expect(captureScore(claims, 'white', R)).toBe(14);
    expect(captureScore(claims, 'black', R)).toBe(8);
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

  it('does not double-count a hex two of one side\u2019s units both reach', () => {
    const claims = captureClaims({
      '0,0': { unit_id: 'u', color: 'white' },
      '1,0': { unit_id: 'u', color: 'white' },
    }, R);
    // Seven each, less the four hexes they share: their own two and the two
    // either side of the pair - ten hexes, 2 apiece.
    expect(claims.size).toBe(10);
    expect(captureScore(claims, 'white', R)).toBe(20);
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
