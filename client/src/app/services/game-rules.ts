import Ajv from 'ajv';
import DEFAULT from '../../../../shared/default-config.json';
import LEGACY from '../../../../shared/legacy-rules-v1.json';
import PREVIOUS from '../../../../shared/legacy-config-v1.json';
import SCHEMA from '../../../../shared/game-config.schema.json';

export const PREVIOUS_GAME_CONFIG = PREVIOUS;
export const RULE_SECTIONS = Object.keys(LEGACY);
const rulePaths: Record<string, [string, string]> = {
  rangeFalloff: ['combat', 'rangeFalloff'], minStrikeDamage: ['combat', 'minStrikeDamage'],
  objective: ['match', 'objective'], maxTurns: ['match', 'maxTurns'], turnTimeLimit: ['match', 'turnTimeLimit'],
  cpAtStart: ['match', 'cpAtStart'], pointsAtStart: ['economy', 'pointsAtStart'], upAtStart: ['economy', 'upAtStart'],
};
const schema: any = SCHEMA;
const validate = new Ajv({ allErrors: true, strict: false, strictNumbers: true }).compile({
  type: 'object', properties: Object.fromEntries([...RULE_SECTIONS, 'ruleset', 'version'].map(k => [k, schema.properties[k]])),
  required: [...RULE_SECTIONS, 'ruleset', 'version'], definitions: schema.definitions,
});

function fillMissing(value: any, defaults: any): void {
  if (value && typeof value === 'object' && !Array.isArray(value) && defaults && typeof defaults === 'object') {
    for (const [key, fallback] of Object.entries(defaults)) {
      if (!Object.hasOwn(value, key)) value[key] = structuredClone(fallback);
      else if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) fillMissing(value[key], fallback);
    }
  }
}

export function sectionOf(config: any, key: string): any {
  if (!config) return (DEFAULT as any)[key];
  if (config.version === '2.0') return Object.hasOwn(config, key) ? config[key] : (DEFAULT as any)[key];
  let result = (LEGACY as any)[key];
  const rules = config.rules || {};
  if (['match', 'combat', 'economy'].includes(key) && rules && typeof rules === 'object') {
    for (const [name, [section, field]] of Object.entries(rulePaths)) {
      if (section === key && Object.hasOwn(rules, name) && rules[name] !== result[field]) result = { ...result, [field]: rules[name] };
    }
    if (key === 'match' && Object.hasOwn(rules, 'cpPhaseOffset') && result.phases.some((p: any, i: number) => p.cpAward !== (i + 1) * rules.cpPhaseOffset)) {
      result = { ...result, phases: result.phases.map((phase: any, i: number) => ({ ...phase, cpAward: (i + 1) * rules.cpPhaseOffset })) };
    }
    if (key === 'combat' && !Object.hasOwn(rules, 'rangeFalloff')) result = { ...result, rangeFalloff: 0 };

  }
  return result;
}

export function legacyRules(config: any): any {
  if (config.version !== '2.0') return config.rules;
  return { ...Object.fromEntries(Object.entries(rulePaths).map(([key, [section, field]]) => [key, sectionOf(config, section)[field]])),
    cpPhaseOffset: sectionOf(config, 'match').phases[0].cpAward };
}

export function ruleValue(config: any, key: string): number | string {
  if (key === 'cpPhaseOffset') return sectionOf(config, 'match').phases[0].cpAward;
  const [section, field] = rulePaths[key];
  return sectionOf(config, section)[field];
}

export function migrateConfig(raw: any): any {
  const config = structuredClone(raw);
  if (!['1.0', '2.0'].includes(config.version)) {
    throw Error(`Unsupported configuration format ${String(config.version)}; supported formats: 1.0, 2.0`);
  }
  if (config.version === '1.0') {
    if (!Object.hasOwn(config, 'abilities')) config.abilities = structuredClone(PREVIOUS_GAME_CONFIG.abilities);
    if (config.rules !== undefined && (!config.rules || typeof config.rules !== 'object' || Array.isArray(config.rules))) throw Error('rules must be an object');
    for (const key of RULE_SECTIONS) config[key] = structuredClone(sectionOf(config, key));
    config.ruleset = { id: 'imported', revision: null };
    delete config.rules;
    config.version = '2.0';
    for (const key of Object.keys(config)) {
      if (![...RULE_SECTIONS, 'version', 'ruleset', 'board', 'units', 'abilities', 'setup'].includes(key)) delete config[key];
    }
  } else {
    if (!Object.hasOwn(config, 'abilities')) config.abilities = structuredClone(DEFAULT.abilities);
    if (Object.hasOwn(config, 'rules')) throw Error('rules is a format 1.0 field; use the format 2.0 sections');
    for (const key of [...RULE_SECTIONS, 'ruleset']) {
      if (!Object.hasOwn(config, key)) config[key] = structuredClone((DEFAULT as any)[key]);
      else fillMissing(config[key], (DEFAULT as any)[key]);
    }
  }
  return config;
}

export function domainErrors(config: any): string[] {
  if (!validate(config as unknown)) return (validate.errors ?? []).map(e => `${e.instancePath.slice(1).replaceAll('/', '.') || 'config'}: ${e.message}`);
  const errors: string[] = Object.keys(config).filter(key => ![...RULE_SECTIONS, 'version', 'ruleset', 'board', 'units', 'abilities', 'setup'].includes(key)).map(key => `Unknown configuration field: ${key}`);
  const match = config.match, count = match.phases.length;
  match.phases.forEach((phase: any, index: number) => {
    if (phase.halftimeAfter > phase.turns) errors.push(`match.phases.${index}.halftimeAfter exceeds turns`);
  });
  for (const [key, values] of Object.entries<number[]>(config.stageRules.opening.moves)) {
    if (values.length !== match.opening.turns) errors.push(`stageRules.opening.moves.${key} must have one entry per opening turn`);
  }
  match.winConditions.earlyPhaseLosses.forEach((rule: any, index: number) => {
    if (rule.phase > count) errors.push(`match.winConditions.earlyPhaseLosses.${index}.phase does not exist`);
  });
  if (Number.isInteger(config.veterancy.fullHealPhase) && config.veterancy.fullHealPhase > count) errors.push('veterancy.fullHealPhase does not exist');
  const radius = config.board?.radius ?? 11;
  config.scoring.zones.forEach((zone: any, index: number) => {
    if (zone.center && Math.max(Math.abs(zone.center[0]), Math.abs(zone.center[1]), Math.abs(zone.center[0] + zone.center[1])) > radius) errors.push(`scoring.zones.${index}.center must be on the battlefield`);
    if ((zone.kind === 'base') !== !!zone.owner) errors.push(`scoring.zones.${index}.owner must identify base zones only`);
  });
  return errors;
}
