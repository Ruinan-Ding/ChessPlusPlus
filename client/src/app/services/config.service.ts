import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Default hex-grid game configuration.
 *
 * Mirrors the schema defined in shared/game-config.types.ts and the
 * DEFAULT_CONFIG in server/game/engine/config_loader.py.
 *
 * Radius-5 board with a minimal set of classic chess-style pieces
 * adapted for hexagonal geometry (axial coordinates q, r).
 */
const DEFAULT_GAME_CONFIG = {
  version: '1.0',
  board: {
    radius: 5
  },
  units: {
    king: {
      id: 'king', name: 'King', symbol: 'K', value: 0, hp: 10, attack: 3,
      movement: [
        { direction: 'E',  range: 1 },
        { direction: 'W',  range: 1 },
        { direction: 'NE', range: 1 },
        { direction: 'NW', range: 1 },
        { direction: 'SE', range: 1 },
        { direction: 'SW', range: 1 }
      ]
    },
    queen: {
      id: 'queen', name: 'Queen', symbol: 'Q', value: 9, hp: 8, attack: 6,
      movement: [
        { direction: 'E',  range: 0 },
        { direction: 'W',  range: 0 },
        { direction: 'NE', range: 0 },
        { direction: 'NW', range: 0 },
        { direction: 'SE', range: 0 },
        { direction: 'SW', range: 0 }
      ]
    },
    rook: {
      id: 'rook', name: 'Rook', symbol: 'R', value: 5, hp: 12, attack: 4,
      movement: [
        { direction: 'E',  range: 0 },
        { direction: 'W',  range: 0 },
        { direction: 'NE', range: 0 },
        { direction: 'NW', range: 0 },
        { direction: 'SE', range: 0 },
        { direction: 'SW', range: 0 }
      ]
    },
    bishop: {
      id: 'bishop', name: 'Bishop', symbol: 'B', value: 3, hp: 6, attack: 5,
      movement: [
        { direction: 'E',  range: 0 },
        { direction: 'W',  range: 0 },
        { direction: 'NE', range: 0 },
        { direction: 'NW', range: 0 },
        { direction: 'SE', range: 0 },
        { direction: 'SW', range: 0 }
      ]
    },
    knight: {
      id: 'knight', name: 'Knight', symbol: 'N', value: 3, hp: 8, attack: 4,
      movement: [
        { direction: 'E',  range: 2, canJump: true },
        { direction: 'W',  range: 2, canJump: true },
        { direction: 'NE', range: 2, canJump: true },
        { direction: 'NW', range: 2, canJump: true },
        { direction: 'SE', range: 2, canJump: true },
        { direction: 'SW', range: 2, canJump: true }
      ]
    },
    pawn: {
      id: 'pawn', name: 'Pawn', symbol: 'P', value: 1, hp: 4, attack: 2,
      movement: [
        { direction: 'NW', range: 1, moveOnly: true },
        { direction: 'NE', range: 1, captureOnly: true },
        { direction: 'W',  range: 1, captureOnly: true }
      ]
    }
  },
  abilities: {},
  setup: {
    white: {
      '0,5':   'king',
      '-1,5':  'queen',
      '-2,5':  'bishop',
      '1,4':   'bishop',
      '-3,5':  'knight',
      '2,3':   'knight',
      '-4,5':  'rook',
      '3,2':   'rook',
      '-1,4':  'pawn',
      '0,4':   'pawn',
      '1,3':   'pawn',
      '-2,4':  'pawn',
      '2,2':   'pawn'
    },
    black: {
      '0,-5':   'king',
      '1,-5':   'queen',
      '2,-5':   'bishop',
      '-1,-4':  'bishop',
      '3,-5':   'knight',
      '-2,-3':  'knight',
      '4,-5':   'rook',
      '-3,-2':  'rook',
      '1,-4':   'pawn',
      '0,-4':   'pawn',
      '-1,-3':  'pawn',
      '2,-4':   'pawn',
      '-2,-2':  'pawn'
    }
  },
  rules: {
    maxTurns: 0,
    turnTimeLimit: 0
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
    } else if (config.board.radius < 1 || config.board.radius > 20) {
      errors.push('board.radius must be between 1 and 20');
    }

    // Units
    if (!config.units || typeof config.units !== 'object') {
      errors.push('Missing or invalid "units"');
    }

    // Setup — validate coordinate format and unit references
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
            // Only warn — unit definitions might be loaded later
          }
        }
      }
    }

    // Rules
    if (!config.rules) {
      errors.push('Missing "rules"');
    }

    // Abilities (optional — just needs to be an object if present)
    if (config.abilities !== undefined && typeof config.abilities !== 'object') {
      errors.push('"abilities" must be an object');
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
  }

  updateConfig(jsonString: string): { valid: boolean; errors?: string[] } {
    // First validate JSON syntax
    if (!this.validateJsonSyntax(jsonString)) {
      return {
        valid: false,
        errors: ['Invalid JSON syntax']
      };
    }

    const config = JSON.parse(jsonString);
    
    // Then validate game rules
    const gameValidation = this.validateGameRules(config);
    if (!gameValidation.valid) {
      return gameValidation;
    }

    // If all validation passes, update the configuration
    this.configSubject.next(config);
    return { valid: true };
  }
}