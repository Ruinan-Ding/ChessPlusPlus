import { advanceBuffs, advanceUnitCooldowns, cooldownAfterTurn, stackEffect } from './ability-rules';
import type { UnitBuff } from './ability-rules';

const dash = { name: 'Dash', mov: 2, atk: 3, def: 4, turns: 2 };
const sap = { name: 'Sap', mov: -2, atk: -3, def: -4, turns: 1 };

describe('ability rules', () => {
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
});
