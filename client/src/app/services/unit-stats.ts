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
  if (passive?.effect === 'deflect' && !counter) return { ...unit, attack: passive.atk };
  return unit;
}
