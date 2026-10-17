import { TestBed } from '@angular/core/testing';
import { ConfigService, DEFAULT_GAME_CONFIG } from './config.service';
import { migrateConfig } from './game-rules';
import { stackEffect, advanceBuffs } from './ability-rules';
import { combatExchange, combatStatuses } from './unit-combat';
import { regenerationHeals } from './history-rules';
import { deathsOf, unitPoints, unitValue, withdrawalRefund } from './match-score';

describe('Per-match balance tuning', () => {
  const fresh = (): any => structuredClone(DEFAULT_GAME_CONFIG);

  it('uses the saved Leech percentage, actual damage and integer rounding', () => {
    const config = fresh();
    Object.assign(config.units.pawn, { attack: 10, attackRange: 1, defense: 0 });
    const attacker = { unit_id: 'pawn', uid: 'a', color: 'white', hp: 3, max_hp: 12, vet: 0 };
    const defender = { ...attacker, uid: 'b', color: 'black', hp: 7 };
    for (const [percent, expected] of [[0, 0], [25, 1], [100, 7]]) {
      const buff = stackEffect(undefined, { name: 'Leech', effect: 'leech', mov: 0, atk: 0, def: 0,
        lifestealPercent: percent } as any, 'white');
      const saved = JSON.parse(JSON.stringify(buff));
      const result = combatExchange(attacker, defender, 1, config,
        { atk: 0, def: 0, targetAtk: 0, targetDef: 0, ...combatStatuses(saved) }, false);
      expect(result.leechHeal).withContext(`${percent}%`).toBe(expected);
    }
  });

  it('retains full legacy Leech when the saved effect omits the new field', () => {
    const config = fresh();
    Object.assign(config.units.pawn, { attack: 10, attackRange: 1, defense: 0 });
    const unit = { unit_id: 'pawn', hp: 2, max_hp: 12, vet: 0 };
    const result = combatExchange(unit, { ...unit, hp: 3 }, 1, config,
      { atk: 0, def: 0, targetAtk: 0, targetDef: 0, ...combatStatuses({ effects: [{ effect: 'leech' }] }) }, false);
    expect(result.leechHeal).toBe(3);
  });

  it('regenerates the configured percentage without reviving dead units', () => {
    for (const [percent, expected] of [[0, 2], [25, 6], [100, 19]]) {
      const config = fresh();
      config.units.pawn.passive = 'regenerate';
      config.abilities.catalogue.regenerate.healPercent = percent;
      const board: any = { '0,0': { unit_id: 'pawn', uid: 'a', color: 'white', hp: 2, max_hp: 19, vet: 3 },
        '1,0': { unit_id: 'pawn', uid: 'b', color: 'white', hp: 0, max_hp: 19, vet: 3 } };
      regenerationHeals(config, board, [], 9, 'white');
      expect(board['0,0'].hp).withContext(`${percent}%`).toBe(expected);
      expect(board['1,0'].hp).toBe(0);
    }
  });

  it('regenerates legacy records from effective configured max HP when max_hp is absent', () => {
    const config = fresh();
    Object.assign(config.units.pawn, { hp: 40, passive: 'regenerate', veterancy: { hp: 4 } });
    config.abilities.catalogue.regenerate.healPercent = 25;
    const board: any = { '0,0': { unit_id: 'pawn', uid: 'legacy', color: 'white', hp: 2, vet: 3 } };
    regenerationHeals(config, board, [], 9, 'white');
    expect(board['0,0'].hp).toBe(13);
  });

  it('prices each economic purpose independently, including zero overrides', () => {
    const config = fresh();
    config.units.pawn.value = 12;
    config.economy.unitValues = { pawn: { bounty: 2, withdrawal: 8, wrap: 0, attrition: 5 } };
    config.economy.walkHomeRefund = { valueMultiplier: 1, fee: 0, missingHpMultiplier: 0, minimum: 0 };
    config.economy.killPayMultiplier = 1;
    config.scoring.deathCostMultiplier = 1;
    expect(unitValue(config, 'pawn')).toBe(12);
    expect((unitValue as any)(config, 'pawn', 'wrap')).toBe(0);
    expect(withdrawalRefund(config, { unit_id: 'pawn', hp: 12, max_hp: 12, vet: 0 })).toBe(8);
    const history = [{ turn: 9, color: 'white', defender_eliminated: true, captured: 'pawn' }];
    expect(unitPoints(config, history, 'white')).toBe(config.economy.upAtStart + 2);
    expect(deathsOf(config, history, 'black')).toBe(5);
  });

  it('preserves sparse saved economic overrides when later shipped defaults change', () => {
    const source = fresh();
    const previous = (DEFAULT_GAME_CONFIG as any).economy.unitValues;
    try {
      (DEFAULT_GAME_CONFIG as any).economy.unitValues = { pawn: { bounty: 99, wrap: 23 }, rook: { attrition: 10 } };
      for (const overrides of [undefined, {}, { pawn: { bounty: 0 } }, { pawn: { withdrawal: 7 } }]) {
        const saved = structuredClone(source);
        if (overrides === undefined) delete saved.economy.unitValues;
        else saved.economy.unitValues = structuredClone(overrides);
        expect(migrateConfig(migrateConfig(saved)).economy.unitValues).toEqual(overrides);
      }
    } finally {
      (DEFAULT_GAME_CONFIG as any).economy.unitValues = previous;
    }
  });

  it('uses the latest active saved Leech percentage and returns to the earlier one after expiry', () => {
    let buff = stackEffect(undefined, { name: 'Earlier', effect: 'leech', mov: 0, atk: 0, def: 0,
      turns: 3, lifestealPercent: 25 } as any, 'white');
    buff = stackEffect(buff, { name: 'Latest', effect: 'leech', mov: 0, atk: 0, def: 0,
      turns: 1, lifestealPercent: 75 } as any, 'white');
    expect(combatStatuses(JSON.parse(JSON.stringify(buff))).lifestealPercent).toBe(75);
    expect(combatStatuses(advanceBuffs({ a: buff }, 'white')['a']).lifestealPercent).toBe(25);
  });

  it('validates supported tuning fields and rejects unknown units and invalid percentages', () => {
    const service = TestBed.inject(ConfigService);
    const config = fresh();
    config.abilities.catalogue['queen-leech'].lifestealPercent = 25;
    config.abilities.catalogue.regenerate.healPercent = 0;
    config.abilities.catalogue.recharge.minimumCooldown = 0;
    config.economy.unitValues = { pawn: { bounty: 0, withdrawal: 3, wrap: 4, attrition: 5 } };
    expect(service.validateGameRules(config).valid).toBeTrue();
    for (const field of ['lifestealPercent', 'healPercent']) {
      const id = field === 'healPercent' ? 'regenerate' : 'queen-leech';
      for (const bad of [-1, 101, 0.5, null, true]) {
        const invalid = structuredClone(config); invalid.abilities.catalogue[id][field] = bad;
        expect(service.validateGameRules(invalid).valid).withContext(`${field}: ${bad}`).toBeFalse();
      }
    }
    config.economy.unitValues.unknown = { bounty: 1 };
    expect(service.validateGameRules(config).valid).toBeFalse();
  });
});
