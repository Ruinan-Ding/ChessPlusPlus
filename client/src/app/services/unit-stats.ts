import type { PieceData } from './game-state.service';

/** Permanent first-star stats. Older configs without veterancy keep their original stats. */
export function unitStats(unitId: string, config: any, vet = 0): any {
  const unit = config?.units?.[unitId] ?? {};
  const bonus = unit.veterancy;
  if (vet < 1 || !bonus) return unit;
  const stats = { ...unit };
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
  return stats;
}

/** Apply the HP increase once when the unit earns its first star; never revive a casualty. */
export function rankedUnit<T extends PieceData>(unit: T, config: any, vet: number): T {
  const hp = vet >= 1 && (unit.vet ?? 0) < 1 && unit.hp > 0
    ? config?.units?.[unit.unit_id]?.veterancy?.hp ?? 0 : 0;
  return {
    ...unit, vet, hp: unit.hp + hp,
    max_hp: (unit.max_hp ?? config?.units?.[unit.unit_id]?.hp ?? unit.hp) + hp,
  };
}

/** Unit ids stay opaque: earned rank unlocks the configured effect. */
export function unitPassive(unitId: string, config: any, vet = 0): any {
  if (vet < 2) return undefined;
  const id = config?.units?.[unitId]?.passive;
  return typeof id === 'string' ? config?.abilities?.catalogue?.[id] : undefined;
}

export function combatStats(unitId: string, config: any, vet = 0, counter = false, kits = true): any {
  const unit = unitStats(unitId, config, vet);
  const passive = kits ? unitPassive(unitId, config, vet) : undefined;
  if (counter && passive?.effect === 'counter') {
    return { ...unit, attack: passive.counterAttack, attackMinRange: 1, attackRange: passive.counterAttack.length };
  }
  if (passive?.effect === 'deflect') return { ...unit, attack: counter ? 0 : passive.atk };
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
