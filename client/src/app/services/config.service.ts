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

const DEFAULT_GAME_CONFIG = {
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
    pawn: {
      id: 'pawn', name: 'Pawn', symbol: 'P', value: 5, hp: 20, attack: 14, defense: 10, attackRange: 1,
      display: { white: '♙', black: '♟' },
      move: 6
    }
  },
  abilities: {},
  setup: {
    // Three rows on each side of the radius-11 board, spaced so nothing
    // sits shoulder to shoulder. White's edge row is r=+11; black is the point
    // mirror (q,r) -> (-q,-r).
    //   row 1 (r=11): queen and king, five columns apart
    //   row 2 (r=10): rook knight bishop | bishop knight rook, every other hex
    //   row 3 (r=9) : eight pawns, every other hex but the middle pair, which
    //                 straddles the centre line - eight spaced pawns are one
    //                 hex wider than the row.
    // Odd separations are what stay centred here: the row holds an even number
    // of hexes, so an even gap would put the pair off the middle.
    white: {
      '-8,11':   'queen',
      '-3,11':   'king',
      '-10,10':  'rook',
      '-8,10':   'knight',
      '-6,10':   'bishop',
      '-4,10':   'bishop',
      '-2,10':   'knight',
      '0,10':    'rook',
      '-11,9':   'pawn',
      '-9,9':    'pawn',
      '-7,9':    'pawn',
      '-5,9':    'pawn',
      '-4,9':    'pawn',
      '-2,9':    'pawn',
      '0,9':     'pawn',
      '2,9':     'pawn'
    },
    black: {
      '8,-11':   'queen',
      '3,-11':   'king',
      '10,-10':  'rook',
      '8,-10':   'knight',
      '6,-10':   'bishop',
      '4,-10':   'bishop',
      '2,-10':   'knight',
      '0,-10':   'rook',
      '11,-9':   'pawn',
      '9,-9':    'pawn',
      '7,-9':    'pawn',
      '5,-9':    'pawn',
      '4,-9':    'pawn',
      '2,-9':    'pawn',
      '0,-9':    'pawn',
      '-2,-9':   'pawn'
    }
  },
  rules: {
    maxTurns: 0,
    turnTimeLimit: 0,
    // Fraction of damage lost per ring beyond the first.
    rangeFalloff: 0.25,
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

    // Abilities (optional - just needs to be an object if present)
    if (config.abilities !== undefined && typeof config.abilities !== 'object') {
      errors.push('"abilities" must be an object');
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