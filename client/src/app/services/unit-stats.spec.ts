import { DEFAULT_GAME_CONFIG } from './config.service';
import { computeLegalMoves, computeMoveCosts, positionalBonus, canAttack, attackTiers, healingAmount, strikeDamage } from './hex-rules';
import { capStat, capUnit, canReceiveBoost, combatStats, unitEffect, unitPassive, rankedUnit, unitStats } from './unit-stats';

describe('first-star unit stats', () => {
  it('caps base and first-star stats, keeps prices intact, and leaves config unchanged', () => {
    const config: any = { units: { renamed: { hp: 98, move: 98, defense: 98, attack: [98, 150],
      heal: [150, 98], attackRange: 150, attackMinRange: 1, value: 250,
      veterancy: { hp: 4, move: 4, defense: 4, attack: 4 } } } };
    const before = JSON.stringify(config), stats = unitStats('renamed', config, 1);
    expect([stats.hp, stats.move, stats.defense, stats.attackRange]).toEqual([99, 99, 99, 99]);
    expect(stats.attack).toEqual([99, 99]); expect(stats.heal).toEqual([99, 98]);
    expect(stats.value).toBe(250); expect(JSON.stringify(config)).toBe(before);
    const unit = { unit_id: 'renamed', color: 'white' as const, uid: 'same', hp: 95, max_hp: 98, vet: 0 };
    const ranked = rankedUnit(unit, config, 1);
    expect([ranked.hp, ranked.max_hp, ranked.uid]).toEqual([99, 99, 'same']);
    expect(rankedUnit(ranked, config, 2)).toEqual({ ...ranked, vet: 2 });
    expect(rankedUnit({ ...unit, hp: 0 }, config, 1).hp).toBe(0);
    expect(capUnit({ ...unit, hp: 150, max_hp: 200 })).toEqual({ ...unit, hp: 99, max_hp: 99 });
    expect([capStat(-4), capStat(99), capStat(100)]).toEqual([0, 99, 99]);
  });

  it('disables the first-star HP bonus in panels and adds current/max HP once on leaving', () => {
    const unit = { unit_id: 'pawn', color: 'white' as const, hp: 5, max_hp: 14, vet: 2 };
    const panel = rankedUnit(unit, DEFAULT_GAME_CONFIG, 2, false);
    expect([panel.hp, panel.max_hp, panel.vet]).toEqual([5, 12, 2]);
    expect(rankedUnit(panel, DEFAULT_GAME_CONFIG, 3, false).hp).toBe(5);
    const field = rankedUnit(JSON.parse(JSON.stringify(panel)), DEFAULT_GAME_CONFIG, 2);
    expect([field.hp, field.max_hp]).toEqual([7, 14]);
    expect(rankedUnit(field, DEFAULT_GAME_CONFIG, 2)).toEqual(field);
    expect(rankedUnit({ ...panel, hp: 0 }, DEFAULT_GAME_CONFIG, 2).hp).toBe(0);
  });

  it('applies Checkmate in enemy home rows by configured effect, with MOV fixed at the walk origin', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.renamed = { ...config.units.pawn };
    for (const [color, r] of [['white', -9], ['black', 9]] as const) {
      const unit = { unit_id: 'renamed', color, vet: 2 };
      expect(positionalBonus(unit, `0,${r}`, 'atk', config)).toBe(6);
      expect(positionalBonus(unit, `0,${r}`, 'def', config)).toBe(6);
      expect(positionalBonus(unit, `0,${r}`, 'mov', config)).toBe(2);
      expect(positionalBonus({ ...unit, vet: 1 }, `0,${r}`, 'atk', config)).toBe(0);
      expect(positionalBonus({ ...unit, panel: 'br' }, `0,${r}`, 'atk', config)).toBe(0);
      expect(positionalBonus(unit, '0,0', 'def', config)).toBe(0);
      const from = { [`0,${r}`]: unit };
      expect(computeMoveCosts(from, 0, r, config, 11).has(`0,${r > 0 ? 1 : -1}`)).toBeTrue();
      expect(computeMoveCosts(from, 0, r, config, 11).has('0,0')).toBeFalse();
      // An explicit remainder cannot be enlarged when the unit has just entered.
      expect(computeMoveCosts(from, 0, r, config, 11, 1).has(`0,${r > 0 ? 7 : -7}`)).toBeFalse();
    }
  });

  it('caps boosted healing and movement even for accepted older large-stat configs', () => {
    const config = { units: { renamed: { hp: 200, move: 150, defense: 180, heal: [98] } } };
    const board = { '0,0': { unit_id: 'renamed', color: 'white' } };
    const corridor = new Set(Array.from({ length: 102 }, (_, i) => `${i},0`));
    const moves = computeMoveCosts(board, 0, 0, config, 102, 150, corridor);
    expect(moves.get('99,0')).toBe(99); expect(moves.has('100,0')).toBeFalse();
    expect(healingAmount('renamed', { unit_id: 'renamed', hp: 1, max_hp: 200 }, 1, config, 0, 20)).toBe(98);
  });

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
    expect(attackTiers('king', DEFAULT_GAME_CONFIG, 1)).toEqual([14, 20]);
    const target = { unit_id: 'pawn', hp: 1, max_hp: 14 };
    expect(healingAmount('bishop', target, 2, DEFAULT_GAME_CONFIG, 0)).toBe(6);
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
    config.units.renamed = { ...config.units.shieldman };
    config.units.target = { attack: 1, defense: 0 };
    expect(unitPassive('renamed', config, 1)).toBeUndefined();
    expect(strikeDamage('renamed', 'target', 1, config, 0, 0, 1, 0, true)).toBe(0);
    expect(strikeDamage('renamed', 'target', 1, config, 0, 0, 2, 0, true)).toBe(4);
    expect(strikeDamage('renamed', 'target', 2, config, 0, 0, 2, 0, true)).toBe(0);
    expect(strikeDamage('renamed', 'target', 3, config, 0, 0, 2, 0, true)).toBe(0);
    expect(strikeDamage('renamed', 'target', 1, config, 8, 0, 2, 0, true)).toBe(12);
    expect(canAttack(combatStats('renamed', config, 2, true), 1, -8)).toBeFalse();
    expect(canAttack(combatStats('renamed', config, 2, true), 2, -1)).toBeFalse();
    expect(strikeDamage('renamed', 'target', 1, config, 0, 0, 2, 0, true, false)).toBe(0);
    expect(strikeDamage('shieldman', 'target', 1, config, 0, 0, 2)).toBe(0);
    expect(strikeDamage('shieldman', 'target', 1, config, 0, 0, 2, 0, true)).toBe(4);
    expect(strikeDamage('shieldman', 'target', 1, config, 8, 0, 2, 0, true)).toBe(12);
  });

  it('filters unavailable attack/heal modifiers by the recipient’s configured capabilities and earned rank', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.renamed = { ...config.units.shieldman };
    const effect = { name: 'Army boost', atk: 8, hel: 4, mov: 2, def: 3, heal: 1, setAtk: 8, setHel: 4 };
    const before = structuredClone(effect);
    for (const id of ['bishop', 'renamed']) {
      const filtered = unitEffect(effect, id, config, 1);
      expect(filtered.atk).toBe(0);
      expect(filtered.setAtk).toBeUndefined();
      expect([filtered.mov, filtered.def, filtered.heal]).toEqual([2, 3, 1]);
      expect(canReceiveBoost({ atk: 8 }, id, config, 1)).toBeFalse();
    }
    expect(unitEffect(effect, 'bishop', config, 1).hel).toBe(4);
    expect(unitEffect(effect, 'pawn', config, 1).hel).toBe(0);
    expect(unitEffect(effect, 'pawn', config, 1).setHel).toBeUndefined();
    expect(canReceiveBoost({ hel: 4 }, 'pawn', config, 1)).toBeFalse();
    expect(canReceiveBoost({ atk: 8, def: 2 }, 'bishop', config, 1)).toBeTrue();
    expect(unitEffect(effect, 'renamed', config, 2).atk).toBe(0);
    expect(canReceiveBoost({ atk: 8 }, 'renamed', config, 2)).toBeFalse();
    expect(strikeDamage('renamed', 'pawn', 1, config, 100, 0, 1)).toBe(0);
    expect(strikeDamage('renamed', 'pawn', 1, config, 0, 0, 2, 0, true)).toBe(1);
    const drain = { atk: -8, hel: -4, setAtk: 0, setHel: 0 };
    expect(unitEffect(drain, 'renamed', config, 1)).toEqual(drain);
    expect(effect).toEqual(before);
  });

  it('keeps numeric zero recoverable on existing stats without creating healing or extending its range', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.pawn.defense = 0;
    expect(canAttack(combatStats('pawn', config), 1, -8)).toBeFalse();
    expect(strikeDamage('pawn', 'pawn', 1, config, -8 + 8)).toBe(6);
    const target = { unit_id: 'pawn', hp: 1, max_hp: 12 };
    expect(healingAmount('bishop', target, 1, config, 0, -8)).toBe(0);
    expect(healingAmount('bishop', target, 1, config, 0, -8 + 4)).toBe(4);
    expect(healingAmount('pawn', target, 1, config, 0, 100, 100)).toBe(0);
    expect(healingAmount('bishop', target, 3, config, 0, 100, 100)).toBe(0);
    expect(attackTiers('bishop', config, 3)).toEqual([]);
    expect(attackTiers('shieldman', config, 1)).toEqual([]);
    expect(attackTiers('shieldman', config, 2)).toEqual([]);
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
