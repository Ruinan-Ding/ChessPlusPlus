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
      id: 'king', name: 'King', symbol: 'K', value: 0, hp: 10, attack: 3,
      display: { white: '♔', black: '♚' },
      move: 6
    },
    queen: {
      id: 'queen', name: 'Queen', symbol: 'Q', value: 9, hp: 8, attack: 6,
      display: { white: '♕', black: '♛' },
      move: 6
    },
    rook: {
      id: 'rook', name: 'Rook', symbol: 'R', value: 5, hp: 12, attack: 4,
      display: { white: '♖', black: '♜' },
      move: 6
    },
    bishop: {
      id: 'bishop', name: 'Bishop', symbol: 'B', value: 3, hp: 6, attack: 5,
      display: { white: '♗', black: '♝' },
      move: 6
    },
    knight: {
      id: 'knight', name: 'Knight', symbol: 'N', value: 3, hp: 8, attack: 4,
      display: { white: '♘', black: '♞' },
      move: 6
    },
    pawn: {
      id: 'pawn', name: 'Pawn', symbol: 'P', value: 1, hp: 4, attack: 2,
      display: { white: '♙', black: '♟' },
      move: 6
    }
  },
  abilities: {},
  setup: {
    // Placeholder placement on the south/north edge rows of the radius-11
    // board. White's edge row is r=+11 (q from -11 to 0, 12 cells); black is
    // the point-mirror (q,r) -> (-q,-r). The 8 back-rank pieces sit
    // contiguously (the row is too short to space them out).
    white: {
      '-5,11':  'king',
      '-6,11':  'queen',
      '-4,11':  'bishop',
      '-7,11':  'bishop',
      '-3,11':  'knight',
      '-8,11':  'knight',
      '-2,11':  'rook',
      '-9,11':  'rook',
      '-3,10':  'pawn',
      '-4,10':  'pawn',
      '-5,10':  'pawn',
      '-6,10':  'pawn',
      '-7,10':  'pawn'
    },
    black: {
      '5,-11':  'king',
      '6,-11':  'queen',
      '4,-11':  'bishop',
      '7,-11':  'bishop',
      '3,-11':  'knight',
      '8,-11':  'knight',
      '2,-11':  'rook',
      '9,-11':  'rook',
      '3,-10':  'pawn',
      '4,-10':  'pawn',
      '5,-10':  'pawn',
      '6,-10':  'pawn',
      '7,-10':  'pawn'
    }
  },
  rules: {
    maxTurns: 0,
    turnTimeLimit: 0,
    // Placeholder: win condition. Only 'elimination' is implemented.
    objective: 'elimination'
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
   * Validate the structural rules of a GameConfig object.
   * Checks for required top-level keys, board radius bounds,
   * unit definitions, and placement references.
   */
  validateGameRules(config: any): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!config.version) {
      errors.push('Missing "version"');
    }

    // Board
    if (!config.board || typeof config.board.radius !== 'number') {
      errors.push('Missing or invalid "board.radius"');
    } else if (config.board.radius < 1 || config.board.radius > 50) {
      errors.push('board.radius must be between 1 and 50');
    }

    // Units
    if (!config.units || typeof config.units !== 'object') {
      errors.push('Missing or invalid "units"');
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
    if (!config.rules) {
      errors.push('Missing "rules"');
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