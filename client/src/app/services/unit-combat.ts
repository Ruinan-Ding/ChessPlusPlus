import { canAttack, hexDistanceKeys, strikeDamage } from './hex-rules';
import { combatStats } from './unit-stats';

export interface CombatBonuses {
  atk: number; def: number; targetAtk: number; targetDef: number;
  charge?: boolean; nullify?: boolean;
}

export function carries(buff: { effects?: Array<{ effect?: string }> } | undefined, effect: string): boolean {
  return !!buff?.effects?.some(entry => entry.effect === effect);
}

/** Forecast, staged combat and the solo engine resolve the same exchange. */
export function combatExchange(attacker: any, defender: any, distance: number, config: any,
  bonuses: CombatBonuses, counters = true, kits = true) {
  const damage = strikeDamage(attacker.unit_id, defender.unit_id, distance, config,
    bonuses.atk, bonuses.targetDef, attacker.vet, defender.vet, false, kits);
  let targetHp = Math.max(0, defender.hp - damage);
  const countered = counters && targetHp > 0 && !bonuses.nullify
    && canAttack(combatStats(defender.unit_id, config, defender.vet, true, kits), distance, bonuses.targetAtk);
  const counterDamage = countered ? strikeDamage(defender.unit_id, attacker.unit_id, distance, config,
    bonuses.targetAtk, bonuses.def, defender.vet, attacker.vet, true, kits) : 0;
  const attackerHp = Math.max(0, attacker.hp - counterDamage);
  const secondDamage = bonuses.charge && countered && attackerHp > 0
    ? strikeDamage(attacker.unit_id, defender.unit_id, distance, config,
      bonuses.atk, bonuses.targetDef, attacker.vet, defender.vet, false, kits) : 0;
  targetHp = Math.max(0, targetHp - secondDamage);
  return { damage, counterDamage, countered, secondDamage, targetHp, attackerHp };
}

/** Taunt restricts a chosen attack, without forcing a unit to attack. */
export function tauntAllows(board: Record<string, any>, from: string, target: string, config: any,
  buffs: Record<string, any>, kits = true): boolean {
  if (!kits) return true;
  const attacker = board[from];
  if (!attacker) return false;
  const eligible = Object.entries(board).filter(([key, unit]) => unit?.hp > 0
    && unit.color !== attacker.color && carries(buffs[unit.uid], 'taunt')
    && canAttack(combatStats(attacker.unit_id, config, attacker.vet), hexDistanceKeys(from, key), buffs[attacker.uid]?.atk ?? 0));
  return !eligible.length || eligible.some(([key]) => key === target);
}
