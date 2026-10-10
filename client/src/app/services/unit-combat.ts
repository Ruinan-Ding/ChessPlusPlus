import { sectionOf } from './game-rules';
import { canAttack, hexDistanceKeys, strikeFromStats } from './hex-rules';
import { activeVet, capStat, capUnit, combatStats, hasAttack, unitStats } from './unit-stats';
import { statSetting, EffectView } from './ability-rules';

export interface CombatBonuses {
  atk: number; def: number; targetAtk: number; targetDef: number;
  charge?: boolean; nullify?: boolean;
  atkSet?: number; defSet?: number; targetAtkSet?: number; targetDefSet?: number;
  immune?: boolean; targetImmune?: boolean;
  hel?: number; helSet?: number;
}

export function carries(buff: { effects?: Array<{ effect?: string }> } | undefined, effect: string): boolean {
  return !!buff?.effects?.some(entry => entry.effect === effect);
}

export function attackStats(unitId: string, config: any, vet = 0, counter = false, kits = true, setting?: number): any {
  const stats = combatStats(unitId, config, vet, counter, kits);
  return setting === undefined || !hasAttack(stats) ? stats : { ...stats,
    attack: Array.from({ length: (stats.attackRange ?? 1) - (stats.attackMinRange ?? 1) + 1 }, () => capStat(setting)) };
}

export function combatStatuses(attacker?: EffectView, defender?: EffectView): Partial<CombatBonuses> {
  const values = { atkSet: statSetting(attacker, 'atk'), defSet: statSetting(attacker, 'def'),
    targetAtkSet: statSetting(defender, 'atk'), targetDefSet: statSetting(defender, 'def'),
    ...(carries(attacker, 'invulnerable') ? { immune: true } : {}),
    ...(carries(defender, 'invulnerable') ? { targetImmune: true } : {}),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** Forecast, staged combat and the solo engine resolve the same exchange. */
export function combatExchange(attacker: any, defender: any, distance: number, config: any,
  bonuses: CombatBonuses, counters = true, kits = true) {
  attacker = capUnit(attacker); defender = capUnit(defender);
  const hit = (source: any, target: any, counter: boolean, atk: number, def: number,
    atkSet?: number, defSet?: number, immune = false): number => immune ? 0 : strikeFromStats(
      attackStats(source.unit_id, config, activeVet(source, undefined, config), counter, kits, atkSet),
      defSet === undefined ? unitStats(target.unit_id, config, activeVet(target, undefined, config)) : { defense: defSet },
      distance, config, atkSet === undefined ? atk : 0, defSet === undefined ? def : 0);
  const damage = hit(attacker, defender, false, bonuses.atk, bonuses.targetDef,
    bonuses.atkSet, bonuses.targetDefSet, bonuses.targetImmune);
  let targetHp = Math.max(0, defender.hp - damage);
  const countered = counters && (!defender.panel || sectionOf(config, 'combat')[['bl', 'tr'].includes(defender.panel) ? 'baseCounters' : 'reserveCounters']) && sectionOf(config, 'combat').counterattacks && targetHp > 0 && !bonuses.nullify
    && canAttack(attackStats(defender.unit_id, config, activeVet(defender, undefined, config), true, kits, bonuses.targetAtkSet), distance, bonuses.targetAtkSet === undefined ? bonuses.targetAtk : 0);
  const counterDamage = countered ? hit(defender, attacker, true, bonuses.targetAtk, bonuses.def,
    bonuses.targetAtkSet, bonuses.defSet, bonuses.immune) : 0;
  const attackerHp = Math.max(0, attacker.hp - counterDamage);
  const secondStrike = !!bonuses.charge && countered && attackerHp > 0;
  const secondDamage = secondStrike
    ? hit(attacker, defender, false, bonuses.atk, bonuses.targetDef,
      bonuses.atkSet, bonuses.targetDefSet, bonuses.targetImmune) : 0;
  targetHp = Math.max(0, targetHp - secondDamage);
  return { damage, counterDamage, countered, secondStrike, secondDamage, targetHp, attackerHp };
}

/** Taunt restricts a chosen attack, without forcing a unit to attack. */
export function tauntAllows(board: Record<string, any>, from: string, target: string, config: any,
  buffs: Record<string, any>, kits = true, atkBonus?: number): boolean {
  if (!kits) return true;
  const attacker = board[from];
  if (!attacker) return false;
  const eligible = Object.entries(board).filter(([key, unit]) => unit?.hp > 0
    && unit.color !== attacker.color && carries(buffs[unit.uid], 'taunt')
    && canAttack(attackStats(attacker.unit_id, config, activeVet(attacker, attacker.panel, config), false, kits, statSetting(buffs[attacker.uid], 'atk')), hexDistanceKeys(from, key), statSetting(buffs[attacker.uid], 'atk') === undefined ? atkBonus ?? buffs[attacker.uid]?.atk ?? 0 : 0));
  return !eligible.length || eligible.some(([key]) => key === target);
}
