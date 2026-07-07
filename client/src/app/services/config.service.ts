import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Default hex-grid game configuration.
 *
 * Mirrors DEFAULT_CONFIG in server/game/engine/config_loader.py.
 *
 * The only fixed game fact is the board: a hexagon with 24 cells per edge
 * (axial radius 23), drawn with an edge pointing up. Every unit below is a
 * PLACEHOLDER — the engine reads all behaviour from this data and knows
 * nothing about specific unit ids.
 *
 * Movement patterns are authored from WHITE's perspective and mirrored for
 * black by the engine. Two pattern types:
 *   { direction, range, canJump?, moveOnly?, captureOnly? }  — step/slide
 *     (range 0 = unlimited; directions: E W NE NW SE SW plus the six
 *      diagonals DN DS DNE DSW DSE DNW)
 *   { offsets: [[dq, dr], ...], moveOnly?, captureOnly? }    — fixed jumps
 */

/** The 12 hex 'L-shape' jump offsets used by the placeholder knight. */
const KNIGHT_JUMP_OFFSETS: number[][] = [
  [-3, 1], [-3, 2], [-2, -1], [-2, 3], [-1, -2], [-1, 3],
  [1, -3], [1, 2], [2, -3], [2, 1], [3, -2], [3, -1],
];

const DEFAULT_GAME_CONFIG = {
  version: '1.0',
  board: {
    radius: 23,              // 24 cells per hexagon edge
    orientation: 'edge-up'   // cosmetic: how the client draws the hexagon
  },
  units: {
    king: {
      id: 'king', name: 'King', symbol: 'K', value: 0, hp: 10, attack: 3,
      display: { white: '♔', black: '♚' },
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
      display: { white: '♕', black: '♛' },
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
      display: { white: '♖', black: '♜' },
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
      display: { white: '♗', black: '♝' },
      movement: [
        { direction: 'DN',  range: 0 },
        { direction: 'DS',  range: 0 },
        { direction: 'DNE', range: 0 },
        { direction: 'DSW', range: 0 },
        { direction: 'DSE', range: 0 },
        { direction: 'DNW', range: 0 }
      ]
    },
    knight: {
      id: 'knight', name: 'Knight', symbol: 'N', value: 3, hp: 8, attack: 4,
      display: { white: '♘', black: '♞' },
      movement: [
        { offsets: KNIGHT_JUMP_OFFSETS }
      ]
    },
    pawn: {
      id: 'pawn', name: 'Pawn', symbol: 'P', value: 1, hp: 4, attack: 2,
      display: { white: '♙', black: '♟' },
      movement: [
        { direction: 'NW', range: 1, moveOnly: true },
        { direction: 'NE', range: 1, captureOnly: true },
        { direction: 'W',  range: 1, captureOnly: true }
      ]
    }
  },
  abilities: {},
  setup: {
    // Placeholder placement on the south/north edge rows of the radius-23
    // board. White's edge row is r=+23 (q from -23 to 0); black is the
    // point-mirror (q,r) → (-q,-r).
    white: {
      '-11,23': 'king',
      '-13,23': 'queen',
      '-9,23':  'bishop',
      '-15,23': 'bishop',
      '-7,23':  'knight',
      '-17,23': 'knight',
      '-5,23':  'rook',
      '-19,23': 'rook',
      '-8,22':  'pawn',
      '-10,22': 'pawn',
      '-12,22': 'pawn',
      '-14,22': 'pawn',
      '-16,22': 'pawn'
    },
    black: {
      '11,-23': 'king',
      '13,-23': 'queen',
      '9,-23':  'bishop',
      '15,-23': 'bishop',
      '7,-23':  'knight',
      '17,-23': 'knight',
      '5,-23':  'rook',
      '19,-23': 'rook',
      '8,-22':  'pawn',
      '10,-22': 'pawn',
      '12,-22': 'pawn',
      '14,-22': 'pawn',
      '16,-22': 'pawn'
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
            errors.push(`Unknown unit "${unitId}" at ${coord} in setup.${side}`);
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