import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import SHIPPED_CONFIG from '../../../../shared/default-config.json';

/**
 * The shipped config: shared/default-config.json, the one file both engines
 * read - the server's config_loader.py loads the same file. A number changed
 * there is changed for solo and networked play alike; there used to be a copy
 * here and one on the server, kept equal by hand. What each field means is in
 * shared/game-config.schema.json.
 *
 * Exported for the one consumer that needs it before a game exists: the room
 * draws its ability panels in a room with no snapshot yet.
 */
export const DEFAULT_GAME_CONFIG = SHIPPED_CONFIG;

/**
 * The rules a config may leave out and be read at their default. Each is a
 * whole number >= 0. Mirrors COUNTED_RULES in config_loader.py.
 *
 * `postmatchEntries` was `phaseInitEntries` while a phase's extra turn opened
 * it rather than closing it. The old key is not carried over: nothing here
 * rejects a rule key it does not know, so a config that still says
 * `phaseInitEntries` loads, and reads `postmatchEntries` at its default.
 * `cpPhaseOffset` replaced `cpPerPhase` - a flat 100 every phase - the same
 * way, when CP became something a phase's play earns.
 */
export const COUNTED_RULES = [
  'panelMoversPerTurn', 'postmatchEntries', 'homecomingsPerSetupTurn', 'cpAtStart', 'cpPhaseOffset',
] as const;
export type CountedRule = typeof COUNTED_RULES[number];

/**
 * One of *config*'s counted rules, or the default's when it has none. A
 * room's config is normalised before it is played; the fallback is for the
 * callers handed no config at all. Mirrors rule_of() in config_loader.py.
 */
export function ruleOf(config: any, key: CountedRule): number {
  const value = config?.rules?.[key];
  return typeof value === 'number' ? value : DEFAULT_GAME_CONFIG.rules[key];
}

/**
 * Every field a unit type may carry. Anything else is a typo, and a typo is a
 * stat left unset. Checked here only, where a config is written: the server
 * also loads configs rooms saved under older builds, which may lack a field
 * or carry a retired one (`movement`), so it refuses only a field that is
 * there and wrong.
 */
const UNIT_FIELDS = new Set([
  'id', 'name', 'symbol', 'display', 'move', 'value', 'hp', 'attack', 'defense',
  'commander', 'attackRange', 'ability',
]);

/** The whole numbers every unit type needs besides `defense`, and the least of each. */
const UNIT_NUMBERS: ReadonlyArray<readonly [string, number]> = [
  ['hp', 1], ['attack', 0], ['move', 0], ['value', 0],
];

/** Every field a catalogue entry may carry. */
const ABILITY_FIELDS = new Set([
  'id', 'name', 'description', 'target', 'cost', 'cooldown', 'turns', 'uses',
  'mov', 'atk', 'def', 'damage', 'heal', 'points', 'testing',
]);

/** A catalogue entry's whole numbers, and the least of each - null for none. */
const ABILITY_NUMBERS: ReadonlyArray<readonly [string, number | null]> = [
  ['cost', 0], ['cooldown', 0], ['turns', 1], ['uses', 1],
  ['mov', null], ['atk', null], ['def', null], ['damage', 0], ['heal', 0], ['points', 0],
];

/**
 * What each kind of ability does nothing with - read off the room's casts:
 * a friendly cast boosts and heals, an enemy one drains and damages, a
 * universal one pays points, and a passive only ever lends its stats. A
 * number set on one of these is a number its author expects to matter and
 * nothing reads, so it is an error rather than a silent no-op: Cleave's
 * `points` paid nobody, and a universal ultimate's `atk` boosted nothing.
 */
const IGNORED_BY: Record<string, string[]> = {
  passive: ['cost', 'cooldown', 'turns', 'uses', 'damage', 'heal', 'points'],
  friendly: ['damage', 'points'],
  enemy: ['heal', 'points'],
  universal: ['mov', 'atk', 'def', 'damage', 'heal', 'turns'],
};

const KIND_NAME: Record<string, string> = {
  passive: 'a passive',
  friendly: 'a friendly ability',
  enemy: 'an enemy ability',
  universal: 'a universal ability',
};

/**
 * The numbers in the ability catalogue, and the shape the panels rely on.
 * Only the client reads abilities, so only the client checks them.
 */
function abilityNumberErrors(abilities: any): string[] {
  const errors: string[] = [];
  const catalogue = abilities?.catalogue && typeof abilities.catalogue === 'object'
    ? abilities.catalogue : {};
  const paths: any[] = Array.isArray(abilities?.paths) ? abilities.paths : [];
  const pool: unknown[] = Array.isArray(abilities?.pool) ? abilities.pool : [];
  const passives = new Set(paths.map(path => path?.passive));
  // Picked two at a time (`partnerOf`), so an odd pool left its last ability
  // paired with the first path's passive, and an odd slot count a slot
  // nothing could fill.
  if (pool.length % 2) {
    errors.push('"abilities.pool" must hold an even number of abilities - they are picked in pairs');
  }
  const slots = abilities?.slots;
  if (slots !== undefined && (!Number.isInteger(slots) || slots < 0 || slots % 2)) {
    errors.push('"abilities.slots" must be an even whole number - picks come in pairs');
  }
  // One slot each: the room finds an ability by the first slot naming it.
  const named = [...pool, ...paths.flatMap(path => [path?.passive, path?.skill, path?.ultimate])];
  for (const id of new Set(named.filter((id, i) => named.indexOf(id) !== i))) {
    errors.push(`"abilities" names "${id}" in more than one slot`);
  }
  for (const [id, a] of Object.entries<any>(catalogue)) {
    if (!a || typeof a !== 'object') continue;
    const at = `abilities.catalogue.${id}`;
    for (const key of Object.keys(a)) {
      if (!ABILITY_FIELDS.has(key)) errors.push(`${at} has unknown field "${key}"`);
    }
    if (!['friendly', 'enemy', 'universal'].includes(a.target)) {
      errors.push(`${at}.target must be friendly, enemy or universal`);
    }
    for (const [field, least] of ABILITY_NUMBERS) {
      const v = a[field];
      if (v !== undefined && (!Number.isInteger(v) || (least !== null && v < least))) {
        errors.push(`${at}.${field} must be an integer${least === null ? '' : ` >= ${least}`}`);
      }
    }
    const kind = passives.has(id) ? 'passive' : a.target;
    for (const field of IGNORED_BY[kind] ?? []) {
      if (a[field] !== undefined && a[field] !== 0) {
        errors.push(`${at}.${field} does nothing on ${KIND_NAME[kind]}`);
      }
    }
    if (a.turns !== undefined && (kind === 'friendly' || kind === 'enemy')
        && !(a.mov || a.atk || a.def)) {
      errors.push(`${at}.turns does nothing on an ability that changes no stat`);
    }
  }
  return errors;
}

/**
 * What is wrong with a unit type's own ability (`units.<id>.ability`), cast
 * from the Unit panel onto the unit itself. Mirrors _unit_ability_errors in
 * config_loader.py.
 */
function unitAbilityErrors(unitId: string, ability: unknown, abilities: any): string[] {
  if (ability === undefined) return [];
  const at = `units.${unitId}.ability`;
  if (typeof ability !== 'string') return [`${at} must be a catalogue id`];
  const catalogue = abilities?.catalogue;
  // A config with no catalogue plays the shipped one, which is checked on its own.
  if (!catalogue || typeof catalogue !== 'object') return [];
  const entry = catalogue[ability];
  if (!entry) return [`${at} names unknown ability "${ability}"`];
  const passive = Array.isArray(abilities.paths)
    && abilities.paths.some((path: any) => path?.passive === ability);
  if (passive || entry.target !== 'friendly') {
    return [`${at} must be a friendly ability - it is cast on the unit itself`];
  }
  return [];
}

@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  private readonly defaultConfig = DEFAULT_GAME_CONFIG;

  private configSubject = new BehaviorSubject<any>(this.defaultConfig);
  public config$ = this.configSubject.asObservable();

  constructor() {}

  /** The config in force right now - what a local game is built from. */
  getConfig(): any {
    return this.configSubject.value;
  }

  getDefaultConfig(): string {
    return JSON.stringify(this.defaultConfig, null, 2);
  }

  validateJsonSyntax(jsonString: string): boolean {
    try {
      JSON.parse(jsonString);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Fill in what an older config predates, in place, before it is checked.
   * Mirrors _normalise_config() in config_loader.py: a config saved before
   * `defense` and `rules.objective` existed is otherwise rejected outright -
   * every unit missing armour, and under a `regicide` default it never chose,
   * a setup with no commander. Both get the value they were played with.
   */
  private normaliseConfig(config: any): void {
    if (config?.units && typeof config.units === 'object') {
      for (const unit of Object.values<any>(config.units)) {
        if (unit && typeof unit === 'object' && unit.defense === undefined) unit.defense = 0;
      }
    }
    if (config && config.rules === undefined) config.rules = {};
    const rules = config?.rules;
    // Absent means the current default, not whatever floor happened to be in
    // force when the config was written - _normalise_config says the same, and
    // for the same reason: nothing here can tell a snapshot frozen before the
    // floor existed from a custom config authored today that simply did not
    // mention it, and filling in the old 0 would hand every new custom config
    // the dead matchups the floor exists to remove.
    if (rules && typeof rules === 'object' && rules.minStrikeDamage === undefined) {
      rules.minStrikeDamage = DEFAULT_GAME_CONFIG.rules['minStrikeDamage'];
    }
    if (rules && typeof rules === 'object' && rules.objective === undefined) {
      const setup = config.setup;
      const commanded = ['white', 'black'].every(side => {
        const placement = setup?.[side];
        return placement && typeof placement === 'object'
          && Object.values<any>(placement).some(u => config.units?.[u]?.commander);
      });
      rules.objective = commanded ? 'regicide' : 'elimination';
    }
    // These were constants before they were config, so absent means the
    // number every game was played under.
    if (rules && typeof rules === 'object') {
      for (const key of COUNTED_RULES) {
        if (rules[key] === undefined) rules[key] = DEFAULT_GAME_CONFIG.rules[key];
      }
    }
  }

  /**
   * Validate the structural rules of a GameConfig object.
   * Checks for required top-level keys, board radius bounds,
   * unit definitions, and placement references.
   */
  validateGameRules(config: any): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    this.normaliseConfig(config);

    if (!config.version) {
      errors.push('Missing "version"');
    }

    // Board
    // An integer, as the server insists: a radius of 11.5 passed here and was
    // rejected by load_config with an error the setup screen never showed.
    if (!config.board || !Number.isInteger(config.board.radius)) {
      errors.push('Missing or invalid "board.radius"');
    } else if (config.board.radius < 1 || config.board.radius > 50) {
      errors.push('board.radius must be between 1 and 50');
    }

    // Units
    if (!config.units || typeof config.units !== 'object') {
      errors.push('Missing or invalid "units"');
    } else {
      // Bounded like board.radius: a silly range would have the hover preview
      // expanding rings across the whole board.
      for (const [unitId, unit] of Object.entries<any>(config.units)) {
        const range = unit?.attackRange ?? 1;
        if (!Number.isInteger(range) || range < 1 || range > 50) {
          errors.push(`units.${unitId}.attackRange must be an integer 1-50`);
        }
        // The schema requires defence and combat reads it. A unit without one
        // loads as armour 0 and fights with silently wrong numbers.
        if (!Number.isInteger(unit?.defense) || unit.defense < 0) {
          errors.push(`units.${unitId}.defense must be an integer >= 0`);
        }
        // The same for the rest the engines read. A missing attack drew as 0
        // on the hex and struck for 1; a move of "5" was a TypeError on the
        // server.
        for (const [field, least] of UNIT_NUMBERS) {
          if (!Number.isInteger(unit?.[field]) || unit[field] < least) {
            errors.push(`units.${unitId}.${field} must be an integer >= ${least}`);
          }
        }
        // A misspelt field is not an extra - it is a stat left unset:
        // `"atack": 20` loaded, and the unit fought with no attack at all.
        for (const key of Object.keys(unit ?? {})) {
          if (!UNIT_FIELDS.has(key)) errors.push(`units.${unitId} has unknown field "${key}"`);
        }
        errors.push(...unitAbilityErrors(unitId, unit?.ability, config.abilities));
      }
    }

    // Setup - validate coordinate format and unit references
    if (!config.setup) {
      errors.push('Missing "setup"');
    } else {
      const coordPattern = /^-?\d+,-?\d+$/;
      const radius = config.board?.radius;
      const vertexUp = config.board?.orientation === 'vertex-up';
      for (const side of ['white', 'black'] as const) {
        const placement = config.setup[side];
        if (!placement || typeof placement !== 'object') {
          errors.push(`Missing or invalid "setup.${side}"`);
          continue;
        }
        for (const [coord, unitId] of Object.entries(placement)) {
          if (!coordPattern.test(coord)) {
            errors.push(`Invalid coordinate "${coord}" in setup.${side}`);
          }
          if (config.units && !(unitId as string in config.units)) {
            errors.push(`Unknown unit "${unitId}" at ${coord} in setup.${side}`);
          }
          // Off the battlefield is a panel, and a side's panels are its own
          // two: a unit dealt into the other side's would be counted as theirs
          // by every panel rule. And a commander starts on the battlefield -
          // under regicide one in a panel is a side that has lost before it
          // moves. Mirrors _validate_config.
          const [q, r] = coord.split(',').map(Number);
          if (!coordPattern.test(coord) || !Number.isInteger(radius)
              || Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius) {
            continue;
          }
          // The sign of the hex's pixel y (`axialToPixel`), which is what
          // `panelOf` reads a panel's side off: below the middle is white's.
          const owner = (vertexUp ? q + 2 * r : r) < 0 ? 'black' : 'white';
          if (owner !== side) {
            errors.push(`setup.${side} puts a unit at ${coord}, in ${owner}'s panels`);
          } else if (config.units?.[unitId as string]?.commander) {
            errors.push(
              `setup.${side} puts its commander at ${coord}, in a panel - ` +
              `a commander starts on the battlefield`);
          }
        }
      }
    }

    // Rules
    // normaliseConfig supplies an absent one, so anything left that is not a
    // plain object is malformed - _validate_config says the same.
    if (!config.rules || typeof config.rules !== 'object' || Array.isArray(config.rules)) {
      errors.push('"rules" must be an object');
    } else {
      const falloff = config.rules.rangeFalloff ?? 0;
      if (typeof falloff !== 'number' || falloff < 0 || falloff > 1) {
        errors.push('rules.rangeFalloff must be a number between 0 and 1');
      }

      // Checked because a negative floor corrupts the board rather than merely
      // unbalancing it: strikeDamage would return a negative number and the
      // engine subtracts it, so a blow would heal whatever it hit.
      // _validate_config says the same, so the setup screen and the server
      // reject the same configs.
      // The raw value, with no `?? 0` in front of it. Coalescing here let an
      // explicit `null` through as 0 while the server - whose normaliser also
      // only fills an ABSENT key - kept the None and refused it, so a config
      // the setup screen called valid failed to start the room with an error
      // the screen had said would not happen. normaliseConfig has already
      // supplied a missing one, so anything left that is not a whole number
      // was written that way on purpose.
      const floor = config.rules.minStrikeDamage;
      if (!Number.isInteger(floor) || floor < 0) {
        errors.push('rules.minStrikeDamage must be an integer >= 0');
      }

      for (const key of COUNTED_RULES) {
        const count = config.rules[key];
        if (!Number.isInteger(count) || count < 0) {
          errors.push(`rules.${key} must be an integer >= 0`);
        }
      }

      // The objective decides how a game is lost, so a config that cannot
      // satisfy it is unplayable rather than merely odd: under regicide a
      // side with no commander has already lost before the first move.
      const objective = config.rules.objective ?? 'regicide';
      if (objective !== 'regicide' && objective !== 'elimination') {
        errors.push(`rules.objective must be 'regicide' or 'elimination'`);
      } else if (objective === 'regicide' && config.setup) {
        for (const side of ['white', 'black'] as const) {
          const placement = config.setup[side];
          if (!placement || typeof placement !== 'object') continue;
          const hasCommander = Object.values<any>(placement)
            .some(unitId => config.units?.[unitId]?.commander);
          if (!hasCommander) {
            errors.push(
              `setup.${side} has no commander unit, but rules.objective is ` +
              `'regicide' - that side is beaten before it moves`);
          }
        }
      }
    }

    // Abilities. Optional, but if present the ids have to join up: the pool
    // and every path name abilities out of the catalogue, and a name with
    // nothing behind it reaches the room as a blank slot rather than an
    // error. **Only the client reads abilities**, so this is the only place
    // that can catch it - the server's `_validate_config` deliberately does
    // not, the engine never touching them (see the `config-sync` skill).
    if (config.abilities !== undefined) {
      if (typeof config.abilities !== 'object' || config.abilities === null) {
        errors.push('"abilities" must be an object');
      } else {
        const abilities = config.abilities;
        const catalogue = abilities.catalogue ?? {};
        const known = (id: unknown) => typeof id === 'string' && !!catalogue[id];
        if (abilities.pool !== undefined && !Array.isArray(abilities.pool)) {
          errors.push('"abilities.pool" must be an array of catalogue ids');
        } else {
          for (const id of abilities.pool ?? []) {
            if (!known(id)) errors.push(`"abilities.pool" names unknown ability "${id}"`);
          }
        }
        if (abilities.paths !== undefined && !Array.isArray(abilities.paths)) {
          errors.push('"abilities.paths" must be an array');
        } else {
          for (const path of abilities.paths ?? []) {
            for (const slot of ['passive', 'skill', 'ultimate'] as const) {
              if (!known(path?.[slot])) {
                errors.push(
                  `"abilities.paths" entry "${path?.id}" names unknown ${slot} "${path?.[slot]}"`);
              }
            }
          }
        }
        for (const [id, ability] of Object.entries<any>(catalogue)) {
          if (ability?.id !== id) {
            errors.push(`"abilities.catalogue.${id}" must carry its own id`);
          }
        }
        errors.push(...abilityNumberErrors(abilities));
      }
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  updateConfig(jsonString: string): { valid: boolean; errors?: string[] } {
    if (!this.validateJsonSyntax(jsonString)) {
      return {
        valid: false,
        errors: ['Invalid JSON syntax']
      };
    }

    const config = JSON.parse(jsonString);
    
    const gameValidation = this.validateGameRules(config);
    if (!gameValidation.valid) {
      return gameValidation;
    }

    this.configSubject.next(config);
    return { valid: true };
  }
}