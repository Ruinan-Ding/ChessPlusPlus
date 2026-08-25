import { attackTiers, computeAttackZone, computeLegalMoves, computeMoveCosts, strikeDamage } from './hex-rules';

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

  it('floors at zero - armour absorbs, it never heals', () => {
    expect(strikeDamage('guard', 'wall', 1, config)).toBe(0);
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
    // A wall of allies down the q=1 column forces a detour to reach 2,0.
    const board: Record<string, any> = {
      '0,0': { unit_id: 'runner', color: 'white' },
      '1,0': { unit_id: 'runner', color: 'white' },
      '1,-1': { unit_id: 'runner', color: 'white' },
      '0,1': { unit_id: 'runner', color: 'white' },
    };
    const costs = computeMoveCosts(board, 0, 0, roomy, 5);

    // Straight-line distance to 2,0 is 2; every route round the wall is longer.
    expect(costs.get('2,0')).toBeGreaterThan(2);
    expect(costs.get('-1,0')).toBe(1);
  });

  it('agrees with computeLegalMoves about which hexes are reachable', () => {
    const board = { '0,0': { unit_id: 'runner', color: 'white' } };
    const costs = computeMoveCosts(board, 0, 0, config, 5);
    const set = computeLegalMoves(board, 0, 0, config, 5);
    expect(new Set(costs.keys())).toEqual(set);
    expect(Math.max(...costs.values())).toBe(4);
  });
});
