import { sectionOf } from './game-rules';
import type { PieceData } from './game-state.service';

/** Effective unit stats, including buffs, stay within the owner's 0–99 limit. */
export const MAX_UNIT_STAT = 99;
export const capStat = (value: number): number => Math.max(0, Math.min(MAX_UNIT_STAT, value));

/** Preserve identity/metadata while normalizing current and maximum HP. */
export function capUnit<T extends { hp?: number; max_hp?: number; vet?: number }>(unit: T): T {
  const next = { ...unit };
  if (unit.vet !== undefined) next.vet = Math.min(3, capStat(unit.vet));
  if (unit.max_hp !== undefined) next.max_hp = capStat(unit.max_hp);
  if (unit.hp !== undefined) next.hp = Math.min(capStat(unit.hp), next.max_hp ?? MAX_UNIT_STAT);
  return next;
}

/** Earned stars remain visible in panels, but their unit kit is inactive there. */
export const unitZone = (panel?: string): string => ['bl', 'tr'].includes(panel ?? '') ? 'base' : panel ? 'reserve' : 'battlefield';
export const kitActive = (unit: any, config?: any, panel = unit?.panel): boolean => sectionOf(config, 'veterancy').kitZones.includes(unitZone(panel));
export const activeVet = (unit: any, panel = unit?.panel, config?: any): number => kitActive(unit, config, panel) ? unit?.vet ?? 0 : -1;

/** First-star stats and the hard ceiling, including older configurations. */
export function unitStats(unitId: string, config: any, vet = 0): any {
  const unit = config?.units?.[unitId] ?? {};
  const bonus = unit.veterancy;
  const stats = { ...unit };
  if (vet >= sectionOf(config, 'veterancy').statUnlock && bonus) {
    for (const key of ['hp', 'move', 'defense']) {
      if (bonus[key] !== undefined) stats[key] = (unit[key] ?? 0) + bonus[key];
    }
    if (bonus.attack !== undefined) {
      stats.attack = Array.isArray(bonus.attack) ? bonus.attack
        : Array.isArray(unit.attack) ? unit.attack.map((n: number) => n + bonus.attack)
        : (unit.attack ?? 0) + bonus.attack;
    }
    for (const key of ['attackRange', 'attackMinRange', 'heal']) {
      if (bonus[key] !== undefined) stats[key] = bonus[key];
    }
  }
  for (const key of ['hp', 'move', 'defense', 'attackRange', 'attackMinRange']) {
    if (stats[key] !== undefined) stats[key] = capStat(stats[key]);
  }
  if (stats.attack !== undefined) stats.attack = Array.isArray(stats.attack)
    ? stats.attack.map(capStat) : capStat(stats.attack);
  if (stats.heal) stats.heal = stats.heal.slice(0, MAX_UNIT_STAT).map(capStat);
  return stats;
}

/** Toggle the first-star HP bonus by zone without reviving casualties. */
export function rankedUnit<T extends PieceData>(unit: T, config: any, vet: number, active = kitActive(unit, config)): T {
  const bonus = config?.units?.[unit.unit_id]?.veterancy?.hp ?? 0;
  const wasActive = unit.veterancyHpActive ?? (unit.vet ?? 0) >= sectionOf(config, 'veterancy').statUnlock;
  const enabled = active && vet >= sectionOf(config, 'veterancy').statUnlock;
  const delta = bonus * (Number(enabled) - Number(wasActive));
  return capUnit({
    ...unit, vet, hp: unit.hp > 0 ? unit.hp + Math.max(0, delta) : 0,
    max_hp: (unit.max_hp ?? config?.units?.[unit.unit_id]?.hp ?? unit.hp)
      + (!enabled && wasActive ? -Math.min(bonus, Math.max(0, (unit.max_hp ?? unit.hp) - capStat(config?.units?.[unit.unit_id]?.hp ?? 0))) : delta),
    ...(bonus && (vet >= sectionOf(config, 'veterancy').statUnlock || unit.veterancyHpActive !== undefined) ? { veterancyHpActive: enabled } : {}),
  });
}

/** Unit ids stay opaque: earned rank unlocks the configured effect. */
export function unitPassive(unitId: string, config: any, vet = 0): any {
  if (vet < sectionOf(config, 'veterancy').passiveUnlock) return undefined;
  const id = config?.units?.[unitId]?.passive;
  return typeof id === 'string' ? config?.abilities?.catalogue?.[id] : undefined;
}

export function combatStats(unitId: string, config: any, vet = 0, counter = false, kits = true): any {
  const unit = unitStats(unitId, config, vet);
  const passive = kits ? unitPassive(unitId, config, vet) : undefined;
  if (counter && passive?.effect === 'counter') {
    return { ...unit, attack: passive.counterAttack.slice(0, MAX_UNIT_STAT).map(capStat), attackMinRange: 1, attackRange: Math.min(MAX_UNIT_STAT, passive.counterAttack.length) };
  }
  if (passive?.effect === 'deflect') return { ...unit, attack: counter ? 0 : capStat(passive.atk) };
  return unit;
}

/** A modifier changes an existing attack; it never grants attack capability. */
export function hasAttack(unit: any): boolean {
  const attack = unit?.attack ?? 1;
  return !unit?.heal?.length && (Array.isArray(attack) ? attack.some(n => n > 0) : attack > 0);
}

/** Ignore boosts to unavailable stats, retaining other benefits and existing debuff semantics. */
export function unitEffect<T extends { atk?: number; hel?: number; setAtk?: number; setHel?: number }>(
  effect: T, unitId: string, config: any, vet = 0, kits = true,
): T {
  const next = { ...effect };
  if (!hasAttack(combatStats(unitId, config, vet, false, kits))) {
    if ((next.atk ?? 0) > 0) next.atk = 0;
    if ((next.setAtk ?? 0) > 0) delete next.setAtk;
  }
  if (!unitStats(unitId, config, vet).heal?.length) {
    if ((next.hel ?? 0) > 0) next.hel = 0;
    if ((next.setHel ?? 0) > 0) delete next.setHel;
  }
  return next;
}

export function canReceiveBoost(effect: any, unitId: string, config: any, vet = 0, kits = true): boolean {
  if (!(effect?.atk > 0 || effect?.hel > 0)) return true;
  const next = unitEffect(effect, unitId, config, vet, kits);
  return next.atk > 0 || next.hel > 0 || next.mov > 0 || next.def > 0 || next.heal > 0 || !!next.effect;
}
