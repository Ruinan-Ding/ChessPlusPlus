import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Default hex-grid game configuration.
 *
 * Mirrors DEFAULT_CONFIG in server/game/engine/config_loader.py.
 *
 * The only fixed game fact is the board: a hexagon with 12 cells per edge
 * (axial radius 11), drawn with an edge pointing up. Every unit below is a
 * PLACEHOLDER - the engine reads all behaviour from this data and knows
 * nothing about specific unit ids.
 *
 * Movement is a single `move` stat per unit: the number of adjacent-hex
 * steps it can take per turn. Movement floods outward through the six hex
 * neighbours, through empty hexes only - a unit can never move through or
 * onto an occupied hex (ally or enemy).
 */

/**
 * The shipped config. Exported for the one consumer that needs it before a
 * game exists: the room draws its ability panels in a room with no snapshot
 * yet, and falling back to this keeps the catalogue in ONE place rather than
 * leaving a second copy hard-coded on the component.
 */
export const DEFAULT_GAME_CONFIG = {
  version: '1.0',
  board: {
    radius: 11,              // 12 cells per hexagon edge
    orientation: 'edge-up'   // cosmetic: how the client draws the hexagon
  },
  units: {
    king: {
      id: 'king', name: 'King', symbol: 'K', value: 40, hp: 45, attack: 16, defense: 15, attackRange: 1, commander: true,
      display: { white: '♔', black: '♚' },
      move: 6
    },
    queen: {
      id: 'queen', name: 'Queen', symbol: 'Q', value: 30, hp: 30, attack: 26, defense: 12, attackRange: 2,
      display: { white: '♕', black: '♛' },
      move: 6
    },
    rook: {
      id: 'rook', name: 'Rook', symbol: 'R', value: 18, hp: 40, attack: 20, defense: 13, attackRange: 2,
      display: { white: '♖', black: '♜' },
      move: 6
    },
    bishop: {
      id: 'bishop', name: 'Bishop', symbol: 'B', value: 14, hp: 22, attack: 22, defense: 10, attackRange: 3,
      display: { white: '♗', black: '♝' },
      move: 6
    },
    knight: {
      id: 'knight', name: 'Knight', symbol: 'N', value: 12, hp: 28, attack: 18, defense: 11, attackRange: 1,
      display: { white: '♘', black: '♞' },
      move: 6
    },
    // Two more of the footsoldier's kind, either side of the pawn: one that
    // outranges everything but the bishop and folds when reached, one that
    // reaches nothing and does not fold. Placeholder numbers on the same
    // scale as the rest - the owner said to make them up.
    archer: {
      id: 'archer', name: 'Archer', symbol: 'A', value: 8, hp: 16, attack: 15, defense: 7, attackRange: 3,
      display: { white: '🏹︎', black: '🏹︎' },
      move: 6
    },
    shieldman: {
      id: 'shieldman', name: 'Shieldman', symbol: 'S', value: 9, hp: 30, attack: 8, defense: 18, attackRange: 1,
      display: { white: '🛡︎', black: '🛡︎' },
      move: 5
    },
    pawn: {
      id: 'pawn', name: 'Pawn', symbol: 'P', value: 5, hp: 20, attack: 14, defense: 10, attackRange: 1,
      display: { white: '♙', black: '♟' },
      move: 6
    }
  },
  /**
   * The ability catalogue, and how a side gets at it. Mirrors
   * `DEFAULT_CONFIG['abilities']` in config_loader.py, byte for byte.
   *
   * Keyed by a **stable id** throughout - never by position - because a
   * side's saved loadout, path and cooldowns are written by id, and a
   * reordered list would re-point every one of them. `cost` is in whichever
   * purse the ability draws on: points for a pool ability, CP for a path's.
   *
   * A path shares its id with its own passive on purpose: the path IS its
   * passive. Different namespaces - `paths` is a list, `catalogue` a map.
   */
  abilities: {
    slots: 4,
    pool: ['dash', 'focus', 'bulwark', 'sap', 'arc-bolt', 'mire', 'mend', 'rally'],
    paths: [
      {
        id: 'bastion',
        name: 'Bastion',
        cost: 6,
        passive: 'bastion',
        skill: 'anchor',
        ultimate: 'fortress'
      },
      {
        id: 'onslaught',
        name: 'Onslaught',
        cost: 7,
        passive: 'onslaught',
        skill: 'cleave',
        ultimate: 'ruin'
      },
      {
        id: 'tempo',
        name: 'Tempo',
        cost: 5,
        passive: 'tempo',
        skill: 'surge',
        ultimate: 'blitz'
      }
    ],
    catalogue: {
      dash: {
        id: 'dash',
        name: 'Dash',
        target: 'friendly',
        cost: 3,
        mov: 2
      },
      focus: {
        id: 'focus',
        name: 'Focus',
        target: 'friendly',
        cost: 5,
        atk: 2
      },
      bulwark: {
        id: 'bulwark',
        name: 'Bulwark',
        target: 'friendly',
        cost: 1,
        def: 3
      },
      sap: {
        id: 'sap',
        name: 'Sap',
        target: 'enemy',
        cost: 4,
        mov: -2,
        atk: -2,
        def: -2,
        damage: 6
      },
      'arc-bolt': {
        id: 'arc-bolt',
        name: 'Arc Bolt',
        target: 'enemy',
        cost: 3,
        damage: 8
      },
      mire: {
        id: 'mire',
        name: 'Mire',
        target: 'enemy',
        cost: 2,
        mov: -3
      },
      mend: {
        id: 'mend',
        name: 'Mend',
        target: 'friendly',
        cost: 0,
        heal: 20,
        testing: true
      },
      rally: {
        id: 'rally',
        name: 'Rally',
        target: 'universal',
        cost: 0,
        points: 300,
        testing: true
      },
      bastion: {
        id: 'bastion',
        name: 'Bastion',
        target: 'friendly',
        cost: 0,
        def: 1
      },
      anchor: {
        id: 'anchor',
        name: 'Anchor',
        target: 'friendly',
        cost: 4,
        def: 4
      },
      fortress: {
        id: 'fortress',
        name: 'Fortress',
        target: 'universal',
        cost: 8,
        points: 4
      },
      onslaught: {
        id: 'onslaught',
        name: 'Onslaught',
        target: 'friendly',
        cost: 0,
        atk: 1
      },
      cleave: {
        id: 'cleave',
        name: 'Cleave',
        target: 'enemy',
        cost: 5,
        damage: 10
      },
      ruin: {
        id: 'ruin',
        name: 'Ruin',
        target: 'universal',
        cost: 8,
        points: 5
      },
      tempo: {
        id: 'tempo',
        name: 'Tempo',
        target: 'friendly',
        cost: 0,
        mov: 1
      },
      surge: {
        id: 'surge',
        name: 'Surge',
        target: 'friendly',
        cost: 3,
        mov: 3
      },
      blitz: {
        id: 'blitz',
        name: 'Blitz',
        target: 'universal',
        cost: 8,
        points: 3
      }
    }
  },
  setup: {
    // Three rows on each side of the radius-11 board, spaced so nothing
    // sits shoulder to shoulder. White's edge row is r=+11; black is the point
    // mirror (q,r) -> (-q,-r).
    //   row 1 (r=11): pawn archer shieldman | queen king | shieldman archer pawn
    //                 - the pair in the middle behind a shield each, an archer
    //                 outside that, and a pawn on each wing tip
    //   row 2 (r=10): pawn | rook knight bishop | bishop knight rook | pawn,
    //                 every other hex with a pawn on each wing tip
    //   row 3 (r=9) : four pawns, two archers and two shieldmen, every other
    //                 hex but the middle pair, which straddles the centre line
    //                 - eight spaced units are one hex wider than the row.
    // Odd separations are what stay centred here: the row holds an even number
    // of hexes, so an even gap would put the pair off the middle.
    white: {
      '-11,11':  'pawn',
      '-10,11':  'archer',
      '-8,11':   'shieldman',
      '-6,11':   'queen',
      '-5,11':   'king',
      '-3,11':   'shieldman',
      '-1,11':   'archer',
      '0,11':    'pawn',
      '-11,10':  'pawn',
      '-10,10':  'rook',
      '-8,10':   'knight',
      '-6,10':   'bishop',
      '-4,10':   'bishop',
      '-2,10':   'knight',
      '0,10':    'rook',
      '1,10':    'pawn',
      '-11,9':   'shieldman',
      '-9,9':    'pawn',
      '-7,9':    'archer',
      '-5,9':    'pawn',
      '-4,9':    'pawn',
      '-2,9':    'archer',
      '0,9':     'pawn',
      '2,9':     'shieldman'
    },
    black: {
      '11,-11':  'pawn',
      '10,-11':  'archer',
      '8,-11':   'shieldman',
      '6,-11':   'queen',
      '5,-11':   'king',
      '3,-11':   'shieldman',
      '1,-11':   'archer',
      '0,-11':   'pawn',
      '11,-10':  'pawn',
      '10,-10':  'rook',
      '8,-10':   'knight',
      '6,-10':   'bishop',
      '4,-10':   'bishop',
      '2,-10':   'knight',
      '0,-10':   'rook',
      '-1,-10':  'pawn',
      '11,-9':   'shieldman',
      '9,-9':    'pawn',
      '7,-9':    'archer',
      '5,-9':    'pawn',
      '4,-9':    'pawn',
      '2,-9':    'archer',
      '0,-9':    'pawn',
      '-2,-9':   'shieldman'
    }
  },
  rules: {
    maxTurns: 0,
    turnTimeLimit: 0,
    // Fraction of damage lost per ring beyond the first.
    rangeFalloff: 0.25,
    // The least a blow that lands may deal, once defence is off it. Must match
    // DEFAULT_CONFIG in config_loader.py byte for byte.
    minStrikeDamage: 1,
    // A side loses when its commander dies; 'elimination' (no units left) is
    // the other supported objective.
    objective: 'regicide'
  }
};

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
      }
    }

    // Setup - validate coordinate format and unit references
    if (!config.setup) {
      errors.push('Missing "setup"');
    } else {
      const coordPattern = /^-?\d+,-?\d+$/;
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