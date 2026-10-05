import { DEFAULT_GAME_CONFIG } from './config.service';
import { computeLegalMoves, computeMoveCosts, canAttack, attackTiers, healingAmount, strikeDamage } from './hex-rules';
import { combatStats, unitPassive, rankedUnit, unitStats } from './unit-stats';

describe('first-star unit stats', () => {
  it('drives movement, attacks and healing from arbitrary configured unit ids without mutating config', () => {
    const config = { units: { renamed: { move: 1, hp: 12, attack: [8, 6], attackRange: 2, defense: 8,
      veterancy: { move: 2, hp: 2, attack: 2, defense: 2 } }, target: { hp: 20, attack: 1, defense: 4 } } };
    const before = JSON.stringify(config);
    const board = { '0,0': { unit_id: 'renamed', color: 'white', vet: 1 } };
    expect(computeLegalMoves(board, 0, 0, config, 5).has('3,0')).toBeTrue();
    expect(computeLegalMoves(board, 0, 0, config, 5).has('4,0')).toBeFalse();
    expect(attackTiers('renamed', config, 1)).toEqual([10, 8]);
    expect(strikeDamage('renamed', 'target', 2, config, 3, 1, 1)).toBe(6);
    expect(strikeDamage('target', 'renamed', 1, config, 20, 0, 0, 1)).toBe(11);
    expect(unitStats('renamed', config, 3).defense).toBe(10);
    expect(JSON.stringify(config)).toBe(before);
    expect(attackTiers('king', DEFAULT_GAME_CONFIG, 1)).toEqual([24, 20]);
    const target = { unit_id: 'pawn', hp: 1, max_hp: 14 };
    expect(healingAmount('bishop', target, 2, DEFAULT_GAME_CONFIG, 0)).toBe(0);
    expect(healingAmount('bishop', target, 2, DEFAULT_GAME_CONFIG, 1)).toBe(6);
    expect(healingAmount('bishop', target, 1, DEFAULT_GAME_CONFIG, 1)).toBe(8);
  });

  it('adds current and maximum HP exactly once, retains it through higher ranks, and never revives', () => {
    const pawn = { unit_id: 'pawn', color: 'white' as const, hp: 5, max_hp: 12, vet: 0 };
    const first = rankedUnit(pawn, DEFAULT_GAME_CONFIG, 1);
    expect([first.hp, first.max_hp, first.vet]).toEqual([7, 14, 1]);
    expect(pawn.hp).toBe(5);
    expect(rankedUnit(first, DEFAULT_GAME_CONFIG, 1)).toEqual(first);
    expect(rankedUnit(first, DEFAULT_GAME_CONFIG, 3).hp).toBe(7);
    expect(rankedUnit({ ...pawn, hp: 0 }, DEFAULT_GAME_CONFIG, 1).hp).toBe(0);
    const legacy = { units: { pawn: { hp: 12, attack: 8, move: 6, defense: 8 } } };
    expect(rankedUnit(pawn, legacy, 1).hp).toBe(5);
    expect(unitStats('pawn', legacy, 3)).toEqual(legacy.units.pawn);
  });

  it('unlocks configured counters at Vet 2, applies ATK modifiers, and preserves solo-only behavior', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.renamed = { ...config.units.archer };
    config.units.target = { attack: 1, defense: 0 };
    expect(unitPassive('renamed', config, 1)).toBeUndefined();
    expect(strikeDamage('renamed', 'target', 1, config, 0, 0, 1, 0, true)).toBe(0);
    expect(strikeDamage('renamed', 'target', 1, config, 0, 0, 2, 0, true)).toBe(2);
    expect(strikeDamage('renamed', 'target', 2, config, 0, 0, 2, 0, true)).toBe(1);
    expect(strikeDamage('renamed', 'target', 3, config, 0, 0, 2, 0, true)).toBe(0);
    expect(strikeDamage('renamed', 'target', 1, config, 8, 0, 2, 0, true)).toBe(10);
    expect(canAttack(combatStats('renamed', config, 2, true), 1, -8)).toBeFalse();
    expect(canAttack(combatStats('renamed', config, 2, true), 2, -1)).toBeFalse();
    expect(strikeDamage('renamed', 'target', 1, config, 0, 0, 2, 0, true, false)).toBe(0);
    expect(strikeDamage('shieldman', 'target', 1, config, 0, 0, 2)).toBe(4);
    expect(strikeDamage('shieldman', 'target', 1, config, 0, 0, 2, 0, true)).toBe(0);
    expect(strikeDamage('shieldman', 'target', 1, config, 8, 0, 2, 0, true)).toBe(8);
  });

  it('hops through consecutive occupied hexes with exact MOV costs and an empty landing', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.renamed = { ...config.units.knight };
    const board = {
      '0,0': { unit_id: 'renamed', color: 'white', vet: 2 },
      '1,0': { unit_id: 'pawn', color: 'black' },
      '2,0': { unit_id: 'pawn', color: 'black' },
    };
    const corridor = new Set(['0,0', '1,0', '2,0', '3,0', '4,0']);
    const through = new Map<string, number>();
    const costs = computeMoveCosts(board, 0, 0, config, 5, 3, corridor, through);
    expect([...through]).toEqual([['1,0', 1], ['2,0', 2]]);
    expect([...costs]).toEqual([['3,0', 3]]);
    expect(computeMoveCosts(board, 0, 0, config, 5, 2, corridor).size).toBe(0);
    expect(computeMoveCosts(board, 0, 0, config, 5, 3, corridor, undefined, false).size).toBe(0);
    board['0,0'].vet = 1;
    expect(computeMoveCosts(board, 0, 0, config, 5, 3, corridor).size).toBe(0);
  });
});
