import { capStat } from './unit-stats';

// Effect updates leave inputs unchanged so Undo snapshots remain valid.

/** Board totals plus individual effects for display and expiry. */
export interface UnitBuff {
  mov: number;
  atk: number;
  def: number;
  hel?: number;
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
  hel?: number;
  /** Remaining caster turns; ticks at turn start and expires at zero. */
  turns: number;
  /** Older saves fall back to UnitBuff.caster. */
  caster?: string;
  /** Marks a hostile cast even when it changes no stats. */
  hostile?: boolean;
  expiresAt?: number;
  effect?: string;
  setAtk?: number;
  setDef?: number;
  setHel?: number;
}

export interface UnitCooldown {
  turns: number;
  color: string;
}

function effectsOf(buff: UnitBuff | undefined): UnitEffect[] {
  return (buff?.effects ?? []).map(e => ({ ...e, caster: e.caster ?? buff!.caster }));
}

function summed(effects: UnitEffect[]): UnitBuff {
  const sum = (stat: 'mov' | 'atk' | 'def' | 'hel') => effects.reduce((n, e) => n + (e[stat] ?? 0), 0);
  return {
    mov: sum('mov'), atk: sum('atk'), def: sum('def'),
    ...(effects.some(e => e.hel !== undefined) ? { hel: sum('hel') } : {}),
    caster: effects[0]?.caster ?? '',
    label: effects[effects.length - 1]?.name ?? '',
    up: effects.some(e => e.mov > 0 || e.atk > 0 || e.def > 0 || (e.hel ?? 0) > 0),
    down: effects.some(e => e.hostile || e.mov < 0 || e.atk < 0 || e.def < 0 || (e.hel ?? 0) < 0),
    effects,
  };
}

export function stackEffect(
  held: UnitBuff | undefined,
  effect: { name: string; mov: number; atk: number; def: number; hel?: number; turns?: number; effect?: string; setAtk?: number; setDef?: number; setHel?: number },
  caster: string,
  hostile = false,
  expiresAt?: number,
): UnitBuff {
  return summed([
    ...effectsOf(held),
    {
      name: effect.name, mov: effect.mov, atk: effect.atk, def: effect.def,
      turns: Math.max(1, effect.turns ?? 1), caster, hostile,
      ...(effect.effect ? { effect: effect.effect } : {}),
      ...(effect.setAtk !== undefined ? { setAtk: effect.setAtk } : {}),
      ...(effect.setDef !== undefined ? { setDef: effect.setDef } : {}),
      ...(effect.setHel !== undefined ? { setHel: effect.setHel } : {}),
      ...(effect.hel !== undefined ? { hel: effect.hel } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  ]);
}

/** Count down only the effects cast by the side whose turn starts; remove each at zero. */
export function advanceBuffs(buffs: Record<string, UnitBuff>, color: string, ply?: number): Record<string, UnitBuff> {
  let changed = false;
  const next: Record<string, UnitBuff> = {};
  for (const [uid, buff] of Object.entries(buffs)) {
    const effects = effectsOf(buff);
    if (!effects.some(e => e.expiresAt !== undefined ? ply !== undefined && ply >= e.expiresAt : e.caster === color)) {
      next[uid] = buff;
      continue;
    }
    changed = true;
    const left = effects
      .map(e => (e.expiresAt === undefined && e.caster === color ? { ...e, turns: e.turns - 1 } : e))
      .filter(e => e.expiresAt !== undefined ? ply === undefined || ply < e.expiresAt : e.turns > 0);
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

export interface PathPassive {
  mov?: number; atk?: number; def?: number; effect?: string;
  minVet?: number; scope?: 'field-reserve' | 'all';
}

export function passiveStat(passive: PathPassive | null | undefined, stat: 'mov' | 'atk' | 'def',
  vet: number, inBase: boolean, defending = false): number {
  if (!passive || vet < (passive.minVet ?? 1) || (inBase && passive.scope === 'field-reserve')) return 0;
  if (stat === 'def' && passive.effect === 'defensive-armor' && !defending) return 0;
  return passive[stat] ?? 0;
}

export interface EffectView { effects?: Array<{ effect?: string; setAtk?: number; setDef?: number; setHel?: number; atk?: number; hel?: number }> }

export function statSetting(buff: EffectView | undefined | null, stat: 'atk' | 'def' | 'hel'): number | undefined {
  const field = stat === 'atk' ? 'setAtk' : stat === 'hel' ? 'setHel' : 'setDef';
  const effects = buff?.effects ?? [];
  for (let i = effects.length - 1; i >= 0; i--) {
    const setting = effects[i][field];
    if (setting === undefined) continue;
    if (stat === 'def') return capStat(setting);
    return capStat(setting + effects.slice(i + 1).reduce((sum, effect) => sum + (effect[stat] ?? 0), 0));
  }
  return undefined;
}

/** Trap removes boosts, including non-stat protection/combat buffs, without curing debuffs. */
export function stripPositiveEffects(buff: UnitBuff | undefined): UnitBuff | undefined {
  const effects = effectsOf(buff).map(e => ({ ...e,
    mov: Math.min(0, e.mov), atk: Math.min(0, e.atk), def: Math.min(0, e.def),
    ...(e.hel !== undefined ? { hel: Math.min(0, e.hel) } : {}),
    effect: ['charge', 'cleave', 'nullify', 'taunt', 'invulnerable'].includes(e.effect ?? '') ? undefined : e.effect,
  })).filter(e => e.mov < 0 || e.atk < 0 || e.def < 0 || (e.hel ?? 0) < 0 || e.effect
    || e.setAtk !== undefined || e.setDef !== undefined || e.setHel !== undefined);
  return effects.length ? summed(effects) : undefined;
}
