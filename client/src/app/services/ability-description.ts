import { PREVIOUS_GAME_CONFIG, sectionOf } from './game-rules';
import DEFAULT from '../../../../shared/default-config.json';

/** Description tokens use the same values as the effect, including migrated presets. */
export function abilityDescription(entry: any, config?: any): string {
  const previous = (PREVIOUS_GAME_CONFIG.abilities.catalogue as Record<string, any>)[entry.id]?.description;
  const shipped = (DEFAULT.abilities.catalogue as Record<string, any>)[entry.id];
  const template = entry.description === previous && shipped?.effect === entry.effect
    ? shipped?.description ?? entry.description : entry.description;
  if (!template) return entry.name ?? '';
  const values: Record<string, any> = { ...entry, radius: entry.radius ?? (entry.effect === 'call' ? 'unlimited' : 1),
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
  });
}
