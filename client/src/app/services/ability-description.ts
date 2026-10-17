import { PREVIOUS_GAME_CONFIG, sectionOf } from './game-rules';
import DEFAULT from '../../../../shared/default-config.json';

/** Description tokens use the same values as the effect, including migrated presets. */
export function abilityDescription(entry: any, config?: any): string {
  const previous = (PREVIOUS_GAME_CONFIG.abilities.catalogue as Record<string, any>)[entry.id]?.description;
  const shipped = (DEFAULT.abilities.catalogue as Record<string, any>)[entry.id];
  const template = entry.description === previous && shipped?.effect === entry.effect
    && (shipped?.battlefieldActions === undefined || entry.battlefieldActions !== undefined)
    && (shipped?.secondCounter === undefined || entry.secondCounter !== undefined)
    && (shipped?.freeOrder === undefined || entry.freeOrder !== undefined)
    && (shipped?.refundMultiplier === undefined || entry.refundMultiplier !== undefined)
    && (shipped?.up === undefined || entry.up !== undefined)
    ? shipped?.description ?? entry.description : entry.description;
  if (!template) return (entry.name ?? '') + rechargeRefundNote(entry, config);
  const values: Record<string, any> = { ...entry, baseMov: entry.baseMov ?? 0,
    lifestealPercent: entry.lifestealPercent ?? 100, healPercent: entry.healPercent ?? 100, minimumCooldown: entry.minimumCooldown ?? 1,
    refundMultiplier: entry.refundMultiplier ?? 0, costReduction: entry.costReduction ?? 0, minimumCost: entry.minimumCost ?? 1, hel: entry.hel ?? 0, radius: entry.radius ?? (entry.effect === 'call' ? 'unlimited' : 1),
    movementOrder: entry.freeOrder ? 'Move, use the unit ability and attack in any order, splitting movement before or after either action.' : 'After attacking, move with the remaining movement budget.',
    chargeCounterRule: entry.secondCounter ? 'Also counter a Charged opponent’s second strike if still alive; no further strikes follow.' : 'This effect does not grant a second counter.',
    passiveUnlock: sectionOf(config, 'veterancy').passiveUnlock,
    homeRows: sectionOf(config, 'panels').homeRows,
    scope: entry.scope === 'field-reserve' ? 'battlefield and green reserve' : 'battlefield, green reserve and red base',
    duration: `${entry.turns ?? 1} full turn(s)`,
    counterProfile: entry.counterAttack?.map((n: number, i: number) => `${i + 1}:${n}`).join(' ') ?? '',
  };
  return template.replace(/\{(?:(sign|abs):)?(\w+)\}/g, (token: string, modifier: string, key: string) => {
    const value = values[key];
    if (value === undefined) return token;
    if (modifier === 'abs') return String(Math.abs(value));
    return modifier === 'sign' && value > 0 ? `+${value}` : String(value);
  }) + rechargeRefundNote(entry, config);
}

/** One-turn pool cooldowns cannot be refreshed; show the undiscounted payout. */
export function rechargeRefundNote(entry: any, config?: any): string {
  const abilities = config?.abilities ?? DEFAULT.abilities;
  if (!entry || !abilities?.pool?.includes(entry.id)) return '';
  const recharge = Object.values<any>(abilities.catalogue ?? {}).find(a => a.effect === 'recharge' && a.refundMultiplier > 0 && entry.cooldown <= (a.minimumCooldown ?? 1));
  if (!recharge) return '';
  const worth = (abilities.catalogue[entry.id].cost ?? 0) * recharge.refundMultiplier;
  return ` Recharge cannot refresh this ${entry.cooldown}-turn cooldown; it grants ${worth} regular points instead, using the full configured value before Sprint discounts.`;
}
