/**
 * Shared game configuration types for ChessPlusPlus.
 *
 * These TypeScript interfaces define the canonical config schema used by:
 *   - The Angular ConfigService (setup-config editor)
 *   - The Python game engine (config_loader.py mirrors these types)
 *   - WebSocket messages that carry config snapshots
 *
 * Coordinate system: axial coordinates (q, r) for hexagonal grids.
 *   See https://www.redblobgames.com/grids/hexagons/ for reference.
 */

// ---------------------------------------------------------------------------
// Hex coordinate
// ---------------------------------------------------------------------------

/** Axial hex coordinate. */
export interface HexCoord {
  q: number;
  r: number;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/**
 * The six cardinal hex directions plus "self" (stay in place, used for
 * abilities that target the current tile).
 *
 *   Flat-top hex neighbours (axial offsets):
 *     E  (+1,  0)   W  (-1,  0)
 *     NE (+1, -1)   SW (-1, +1)
 *     NW ( 0, -1)   SE ( 0, +1)
 */
export type HexDirection = 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';

/** A single movement/attack vector for a unit. */
export interface MovePattern {
  /** Direction of travel. */
  direction: HexDirection;
  /**
   * How many hexes the unit can travel in this direction.
   * Use 0 for "unlimited" (like a bishop/rook sliding).
   */
  range: number;
  /** If true, this pattern can capture but not move to an empty hex. */
  captureOnly?: boolean;
  /** If true, this pattern can move to an empty hex but not capture. */
  moveOnly?: boolean;
  /** If true, the unit can jump over other pieces along this line. */
  canJump?: boolean;
}

// ---------------------------------------------------------------------------
// Abilities  (placeholder - expand when designing special moves)
// ---------------------------------------------------------------------------

export interface AbilityDef {
  /** Unique ability identifier (e.g. "shield", "teleport"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Markdown description shown in the config editor tooltip. */
  description: string;
  /** Cooldown in turns (0 = no cooldown). */
  cooldown: number;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export interface UnitDef {
  /** Unique unit type identifier (e.g. "pawn", "rook", "knight"). */
  id: string;
  /** Display name. */
  name: string;
  /**
   * Single-character or short string shown on the hex tile.
   * Can also be used as the key for a sprite map.
   */
  symbol: string;
  /** Movement rules for this unit type. */
  movement: MovePattern[];
  /** Optional special abilities. */
  abilities?: AbilityDef[];
  /** Point value for scoring / evaluation. */
  value: number;
  /** Maximum hit points for this unit type. */
  hp: number;
  /** Attack damage dealt when this unit initiates combat. */
  attack: number;
}

// ---------------------------------------------------------------------------
// Board & placement
// ---------------------------------------------------------------------------

export interface BoardDef {
  /** Hex grid radius (distance from centre to edge in hexes). */
  radius: number;
}

/**
 * Maps a serialised hex coordinate string `"q,r"` to a unit type id.
 * Example: `{ "0,-3": "rook", "1,-3": "knight" }`
 */
export type PlacementMap = Record<string, string>;

export interface SetupDef {
  white: PlacementMap;
  black: PlacementMap;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RulesDef {
  /** Maximum turns before a draw is declared (0 = unlimited). */
  maxTurns: number;
  /** Per-turn time limit in seconds (0 = unlimited). */
  turnTimeLimit: number;
  /** Allow custom / future rule flags. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface GameConfig {
  /** Schema version for forward compatibility. */
  version: string;
  /** Board shape and size. */
  board: BoardDef;
  /** Unit type definitions (keyed by unit id). */
  units: Record<string, UnitDef>;
  /** Ability catalogue (keyed by ability id). */
  abilities: Record<string, AbilityDef>;
  /** Starting piece placements per side. */
  setup: SetupDef;
  /** Rule overrides / toggles. */
  rules: RulesDef;
}
