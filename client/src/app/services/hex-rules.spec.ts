import {
  attackTiers, captureClaims, captureScore, captureZoneHexes, computeAttackZone,
  computeLegalMoves, computeMoveCosts, strikeDamage,
} from './hex-rules';

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

  it('adds a boost to the scaled ring, which is where the hex shows it', () => {
    // The hex draws the second ring as 19; +2 makes that ring 21, not
    // 28 * 0.75. Same ordering as attackCellText on the board.
    expect(strikeDamage('archer', 'guard', 2, config, 2)).toBe(11);
    // A defence boost comes off after the scaling, like the panel's "12/10".
    expect(strikeDamage('archer', 'guard', 1, config, 0, 4)).toBe(12);
    // Armour still cannot heal.
    expect(strikeDamage('guard', 'wall', 1, config, 0, 5)).toBe(0);
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

  it('pays seven for the middle of a patch and less on its rim', () => {
    const middle = captureClaims({ '0,0': { unit_id: 'u', color: 'white' } }, R);
    expect(captureScore(middle, 'white')).toBe(7);
    expect(captureScore(middle, 'black')).toBe(0);

    // On the rim three of the six neighbours are outside the patch, and
    // adjacency stops at its edge - the open board is worth nothing.
    const rim = captureClaims({ '2,0': { unit_id: 'u', color: 'white' } }, R);
    expect(captureScore(rim, 'white')).toBe(4);
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
    // What each still holds on its own side of the seam - six of seven each.
    expect(claims.get('-1,0')).toBe('white');
    expect(claims.get('1,0')).toBe('black');
    expect(captureScore(claims, 'white')).toBe(6);
    expect(captureScore(claims, 'black')).toBe(6);
  });

  it('leaves a gap of one alone: claims that do not touch do not cancel', () => {
    const claims = captureClaims({
      '-1,0': { unit_id: 'u', color: 'white' },
      '2,0': { unit_id: 'u', color: 'black' },
    }, R);
    // Three apart, so nothing overlaps - white keeps all seven, and black
    // keeps the four of its own that are still inside the patch.
    expect(captureScore(claims, 'white')).toBe(7);
    expect(captureScore(claims, 'black')).toBe(4);
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
    // either side of the pair.
    expect(captureScore(claims, 'white')).toBe(10);
  });
});
