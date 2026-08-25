/**
 * Client-side movement rules.
 *
 * Fully config-driven: unit ids are opaque labels. Movement comes from the
 * unit's single `move` stat - a flood fill through the six hex neighbours,
 * through empty hexes only. A unit can never move through or onto an
 * occupied hex (ally or enemy).
 *
 * This MIRRORS server/game/engine/move_validator.py. Both the board's
 * legal-move preview and the offline single-player engine read it, so a
 * change to the server's movement rules has to land here too or the client
 * will disagree with the server about what a unit may do.
 */

export type BoardLike = Record<string, { unit_id: string; color: string } | undefined>;

const HEX_DIRS: [number, number][] = [
  [+1, 0], [-1, 0], [+1, -1], [0, -1], [0, 1], [-1, 1],
];

export function isInsideBoard(q: number, r: number, radius: number): boolean {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius;
}

/**
 * Legal destinations mapped to what they cost in steps.
 *
 * The cost is the length of the walk, not the straight-line distance: going
 * round a wall of units costs what the detour costs. The server validates a
 * turn with one flood fill from where the unit started, so charging anything
 * cheaper here lets the client stage a move the server then rejects.
 */
export function computeMoveCosts(
  boardState: BoardLike,
  sq: number, sr: number,
  config: any,
  radius: number,
  movesLeft?: number,
  /** Hexes the unit may use, when it is confined to something other than the
   *  battlefield - a reserve panel. Omitted means the radius-N board. */
  zone?: Set<string>,
): Map<string, number> {
  const costs = new Map<string, number>();
  const piece = boardState[`${sq},${sr}`];
  if (!piece) return costs;
  const unitDef = config?.units?.[piece.unit_id];
  const moveRange: number = movesLeft ?? unitDef?.move ?? 0;
  if (moveRange <= 0) return costs;

  const visited = new Set<string>([`${sq},${sr}`]);
  let frontier: [number, number][] = [[sq, sr]];

  for (let step = 1; step <= moveRange; step++) {
    const nextFrontier: [number, number][] = [];
    for (const [cq, cr] of frontier) {
      for (const [dq, dr] of HEX_DIRS) {
        const nq = cq + dq, nr = cr + dr;
        const key = `${nq},${nr}`;
        const allowed = zone ? zone.has(key) : isInsideBoard(nq, nr, radius);
        if (visited.has(key) || !allowed) continue;
        visited.add(key);
        if (boardState[key]) continue; // occupied - blocks entry and passage
        costs.set(key, step);
        nextFrontier.push([nq, nr]);
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }
  return costs;
}

/** Compute legal destinations for the piece at (sq,sr). */
export function computeLegalMoves(
  boardState: BoardLike,
  sq: number, sr: number,
  config: any,
  radius: number,
  /** Steps still available this turn; defaults to the unit's full move stat. */
  movesLeft?: number,
  zone?: Set<string>,
): Set<string> {
  return new Set(computeMoveCosts(boardState, sq, sr, config, radius, movesLeft, zone).keys());
}

/**
 * Hexes a unit could strike but not stand on: everything within its
 * `attackRange` rings of any tile it can reach (including where it stands),
 * minus the tiles it can actually move to. Attack range is straight hex
 * distance - obstacles do not block it, unlike movement.
 */
export function computeAttackZone(
  origin: string,
  moves: Set<string>,
  config: any,
  unitId: string,
  radius: number,
  /** Confinement, as in computeMoveCosts(). */
  area?: Set<string>,
): Set<string> {
  const range: number = config?.units?.[unitId]?.attackRange ?? 1;
  const zone = new Set<string>();
  if (range < 1) return zone;

  const offsets: [number, number][] = [];
  for (let dq = -range; dq <= range; dq++) {
    const lo = Math.max(-range, -dq - range);
    const hi = Math.min(range, -dq + range);
    for (let dr = lo; dr <= hi; dr++) {
      if (dq === 0 && dr === 0) continue;
      offsets.push([dq, dr]);
    }
  }

  for (const tile of [origin, ...moves]) {
    const [tq, tr] = tile.split(',').map(Number);
    for (const [dq, dr] of offsets) {
      const q = tq + dq, r = tr + dr;
      const key = `${q},${r}`;
      const allowed = area ? area.has(key) : isInsideBoard(q, r, radius);
      if (!allowed || moves.has(key) || key === origin) continue;
      zone.add(key);
    }
  }
  return zone;
}

/**
 * Damage an attack of `attack` deals at `distance` rings. Mirrors
 * ranged_damage() in server/game/engine/game_logic.py - keep the two in step.
 */
export function rangedDamage(attack: number, distance: number, config: any): number {
  if (attack <= 0 || distance <= 1) return Math.max(0, attack);
  const falloff: number = config?.rules?.rangeFalloff ?? 0;
  const scale = Math.max(0, 1 - falloff * (distance - 1));
  return Math.max(1, Math.trunc(attack * scale));
}

/**
 * Damage per ring for a unit, outermost ring last: [16] for a melee unit,
 * [26, 19] for one that reaches two rings. Drawn on the hex as "26,19".
 */
export function attackTiers(unitId: string, config: any): number[] {
  const unit = config?.units?.[unitId];
  if (!unit) return [];
  const attack: number = unit.attack ?? 0;
  const range: number = Math.max(1, unit.attackRange ?? 1);
  const tiers: number[] = [];
  for (let ring = 1; ring <= range; ring++) tiers.push(rangedDamage(attack, ring, config));
  return tiers;
}

/** Hex distance between two "q,r" keys. */
export function hexDistanceKeys(a: string, b: string): number {
  const [aq, ar] = a.split(',').map(Number);
  const [bq, br] = b.split(',').map(Number);
  const dq = aq - bq, dr = ar - br;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/**
 * Damage one unit lands on another: ring-scaled attack less the defender's
 * defence, floored at 0. Mirrors strike_damage() in game_logic.py.
 */
export function strikeDamage(
  attackerId: string, defenderId: string, distance: number, config: any,
): number {
  const attacker = config?.units?.[attackerId] ?? {};
  const defender = config?.units?.[defenderId] ?? {};
  const attack = rangedDamage(attacker.attack ?? 1, distance, config);
  return Math.max(0, attack - (defender.defense ?? 0));
}
