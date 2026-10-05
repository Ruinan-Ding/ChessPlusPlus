// Effect updates leave inputs unchanged so Undo snapshots remain valid.

/** Board totals plus individual effects for display and expiry. */
export interface UnitBuff {
  mov: number;
  atk: number;
  def: number;
  /** Legacy saves kept the caster here; current effects each carry their own. */
  caster: string;
  label: string;
  /** Both markers survive when boosts and drains cancel numerically. */
  up?: boolean;
  down?: boolean;
  effects: UnitEffect[];
}

interface UnitEffect {
  name: string;
  mov: number;
  atk: number;
  def: number;
  /** Remaining caster turns; ticks at turn start and expires at zero. */
  turns: number;
  /** Older saves fall back to UnitBuff.caster. */
  caster?: string;
  /** Marks a hostile cast even when it changes no stats. */
  hostile?: boolean;
}

export interface UnitCooldown {
  turns: number;
  color: string;
}

function effectsOf(buff: UnitBuff | undefined): UnitEffect[] {
  return (buff?.effects ?? []).map(e => ({ ...e, caster: e.caster ?? buff!.caster }));
}

function summed(effects: UnitEffect[]): UnitBuff {
  const sum = (stat: 'mov' | 'atk' | 'def') => effects.reduce((n, e) => n + e[stat], 0);
  return {
    mov: sum('mov'), atk: sum('atk'), def: sum('def'),
    caster: effects[0]?.caster ?? '',
    label: effects[effects.length - 1]?.name ?? '',
    up: effects.some(e => e.mov > 0 || e.atk > 0 || e.def > 0),
    down: effects.some(e => e.hostile || e.mov < 0 || e.atk < 0 || e.def < 0),
    effects,
  };
}

export function stackEffect(
  held: UnitBuff | undefined,
  effect: { name: string; mov: number; atk: number; def: number; turns?: number },
  caster: string,
  hostile = false,
): UnitBuff {
  return summed([
    ...effectsOf(held),
    {
      name: effect.name, mov: effect.mov, atk: effect.atk, def: effect.def,
      turns: Math.max(1, effect.turns ?? 1), caster, hostile,
    },
  ]);
}

/** Count down only the effects cast by the side whose turn starts; remove each at zero. */
export function advanceBuffs(buffs: Record<string, UnitBuff>, color: string): Record<string, UnitBuff> {
  let changed = false;
  const next: Record<string, UnitBuff> = {};
  for (const [uid, buff] of Object.entries(buffs)) {
    const effects = effectsOf(buff);
    if (!effects.some(e => e.caster === color)) {
      next[uid] = buff;
      continue;
    }
    changed = true;
    const left = effects
      .map(e => (e.caster === color ? { ...e, turns: e.turns - 1 } : e))
      .filter(e => e.turns > 0);
    if (left.length) next[uid] = summed(left);
  }
  return changed ? next : buffs;
}

export function cooldownAfterTurn(turns: number): number {
  return Math.max(0, turns - 1);
}

/** Per-unit cooldowns tick on their unit's side, leaving the other side's alone. */
export function advanceUnitCooldowns(
  cooldowns: Record<string, UnitCooldown>, color: string,
): Record<string, UnitCooldown> {
  const cooling = Object.entries(cooldowns);
  if (!cooling.some(([, cd]) => cd.color === color)) return cooldowns;
  return Object.fromEntries(cooling
    .map(([uid, cd]): [string, UnitCooldown] =>
      [uid, cd.color === color ? { ...cd, turns: cooldownAfterTurn(cd.turns) } : cd])
    .filter(([, cd]) => cd.turns > 0));
}
