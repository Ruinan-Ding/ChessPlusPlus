import { advanceBuffs, advanceUnitCooldowns, cooldownAfterTurn, stackEffect, statSetting, stripPositiveEffects } from './ability-rules';
import type { UnitBuff } from './ability-rules';

const dash = { name: 'Dash', mov: 2, atk: 3, def: 4, turns: 2 };
const sap = { name: 'Sap', mov: -2, atk: -3, def: -4, turns: 1 };

describe('ability rules', () => {
  it('allows later ATK/HEL buffs to restore a zero-setting debuff without reapplying earlier boosts', () => {
    let held = stackEffect(undefined, { name: 'Earlier boost', mov: 0, atk: 8, def: 2, hel: 4 }, 'white');
    held = stackEffect(held, { name: 'Sap', mov: 0, atk: 0, def: 0, setAtk: 0, setHel: 0, setDef: 0 }, 'black', true);
    expect([statSetting(held, 'atk'), statSetting(held, 'hel')]).toEqual([0, 0]);
    const before = structuredClone(held);
    held = stackEffect(held, { name: 'Later boost', mov: 0, atk: 8, def: 2, hel: 4 }, 'white');
    expect([statSetting(held, 'atk'), statSetting(held, 'hel')]).toEqual([8, 4]);
    expect(statSetting(held, 'def')).toBe(0);
    const restored = JSON.parse(JSON.stringify(held));
    expect([statSetting(restored, 'atk'), statSetting(restored, 'hel')]).toEqual([8, 4]);
    const drained = stackEffect(held, { name: 'Drain', mov: 0, atk: -20, def: 0, hel: -20 }, 'black', true);
    expect([statSetting(drained, 'atk'), statSetting(drained, 'hel')]).toEqual([0, 0]);
    expect([statSetting(before, 'atk'), statSetting(before, 'hel')]).toEqual([0, 0]);
  });

  it('strips positive parts of mixed buffs and protection while retaining debuffs and control without mutating Undo', () => {
    let held = stackEffect(undefined, { name: 'Mixed', mov: 4, atk: 8, def: -2, hel: 4 }, 'white');
    held = stackEffect(held, { name: 'Sap', mov: 0, atk: -3, def: 0, setHel: 0 }, 'black', true);
    held = stackEffect(held, { name: 'Cast', mov: 0, atk: 0, def: 0, effect: 'control' }, 'white');
    held = stackEffect(held, { name: 'Fortress', mov: 0, atk: 0, def: 0, effect: 'invulnerable' }, 'white');
    const before = structuredClone(held), stripped = stripPositiveEffects(held)!;
    expect([stripped.mov, stripped.atk, stripped.def, stripped.hel]).toEqual([0, -3, -2, 0]);
    expect(stripped.effects.some(e => e.effect === 'control')).toBeTrue();
    expect(stripped.effects.some(e => e.effect === 'invulnerable')).toBeFalse();
    expect(stripped.effects.some(e => e.setHel === 0)).toBeTrue();
    expect(held).toEqual(before);
  });

  it('stacks opposing effects without changing the snapshot held for Undo', () => {
    const held = stackEffect(undefined, dash, 'white');
    Object.freeze(held.effects[0]);
    Object.freeze(held.effects);
    Object.freeze(held);
    const next = stackEffect(held, sap, 'black', true);
    expect([next.mov, next.atk, next.def]).toEqual([0, 0, 0]);
    expect([next.up, next.down, next.label]).toEqual([true, true, 'Sap']);
    expect(next.effects.map(e => [e.name, e.caster, e.turns]))
      .toEqual([['Dash', 'white', 2], ['Sap', 'black', 1]]);
    expect([held.mov, held.atk, held.def, held.effects.length]).toEqual([2, 3, 4, 1]);
    const hit = stackEffect(undefined, { name: 'Bolt', mov: 0, atk: 0, def: 0 }, 'black', true);
    expect([hit.up, hit.down, hit.effects[0].turns]).toEqual([false, true, 1]);
  });

  it('expires each effect on its caster turns and removes the last effect at zero', () => {
    const mixed = stackEffect(stackEffect(undefined, dash, 'white'), sap, 'black', true);
    const other = stackEffect(undefined, dash, 'black');
    const before = { mixed, other };
    const unchanged = structuredClone(before);
    const white = advanceBuffs(before, 'white');
    expect(white['mixed'].effects.map(e => e.turns)).toEqual([1, 1]);
    expect(white['other']).toBe(other);
    const black = advanceBuffs(white, 'black');
    expect([black['mixed'].mov, black['mixed'].atk, black['mixed'].def, black['mixed'].down])
      .toEqual([2, 3, 4, false]);
    const end = advanceBuffs(black, 'white');
    expect(end['mixed']).toBeUndefined();
    expect(end['other'].effects[0].turns).toBe(1);
    expect(before).toEqual(unchanged);
    const onlyBlack = { other };
    expect(advanceBuffs(onlyBlack, 'white')).toBe(onlyBlack);
  });

  it('keeps the caster fallback when stacking or ticking an older saved effect', () => {
    const legacy: UnitBuff = {
      mov: 2, atk: 3, def: 4, caster: 'white', label: 'Dash',
      effects: [{ ...dash }],
    };
    const restored = JSON.parse(JSON.stringify({ unit: legacy }));
    const stacked = stackEffect(restored.unit, sap, 'black', true);
    expect(stacked.effects.map(e => e.caster)).toEqual(['white', 'black']);
    const once = advanceBuffs(restored, 'white');
    expect(once['unit'].effects[0].turns).toBe(1);
    expect(advanceBuffs(once, 'white')['unit']).toBeUndefined();
    expect(restored.unit).toEqual(legacy);
  });

  it('ticks only the owning units and keeps cooldowns at zero when they are ready', () => {
    const cooldowns = {
      white: { color: 'white', turns: 2 },
      ready: { color: 'white', turns: 1 },
      black: { color: 'black', turns: 3 },
    };
    Object.values(cooldowns).forEach(Object.freeze);
    Object.freeze(cooldowns);
    const next = advanceUnitCooldowns(cooldowns, 'white');
    expect(next).toEqual({ white: { color: 'white', turns: 1 }, black: cooldowns.black });
    expect(advanceUnitCooldowns(next, 'white')).toEqual({ black: cooldowns.black });
    expect(cooldowns.white.turns).toBe(2);
    expect(cooldowns.ready.turns).toBe(1);
    expect(next['black']).toBe(cooldowns.black);
    const onlyBlack = { black: cooldowns.black };
    expect(advanceUnitCooldowns(onlyBlack, 'white')).toBe(onlyBlack);
    expect([0, 1, 3].map(cooldownAfterTurn)).toEqual([0, 0, 2]);
  });

  it('keeps uncapped Bog stacks for their triggering full turn through serialized restore', () => {
    const bog = { name: 'Bog', mov: 0, atk: -1, def: -1, turns: 1 };
    let held = stackEffect(undefined, bog, 'white', true, 33);
    for (let i = 0; i < 3; i++) held = stackEffect(held, bog, 'white', true, 34);
    expect([held.atk, held.def, held.effects.length]).toEqual([-4, -4, 4]);
    const restored = JSON.parse(JSON.stringify({ unit: held }));
    expect(advanceBuffs(restored, 'white', 32)['unit'].atk).toBe(-4);
    expect(advanceBuffs(restored, 'white', 33)['unit'].atk).toBe(-3);
    expect(advanceBuffs(restored, 'black', 34)['unit']).toBeUndefined();
    expect(restored.unit.atk).toBe(-4);
  });
});
