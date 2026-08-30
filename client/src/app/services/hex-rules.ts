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

/** Rings from the origin to (q, r) - the hex metric, in one place. */
export function hexDistance(q: number, r: number): number {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
}

export function isInsideBoard(q: number, r: number, radius: number): boolean {
  return hexDistance(q, r) <= radius;
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

/**
 * How far out the outer four capture zones sit, as a share of the board's
 * radius: 7 columns to the sides and 6 rows up and down on the shipped
 * radius-11 board. Rows are the tighter pair - two hexes closer than the
 * geometry would put them, which is how the plus is meant to sit.
 */
const ZONE_COLS = 7 / 11;
const ZONE_ROWS = 6 / 11;
/** Rings of hexes around each zone's centre: 2 makes a 19-hex patch. */
const ZONE_SPREAD = 2;

/**
 * The five capture zones as one set of hexes: a patch in the middle and four
 * around it - top, bottom, left, right - the same size and the same distance
 * out, so they read as one set rather than five decisions.
 *
 * One flat set rather than five because nothing asks which zone a hex is in.
 * On the shipped radius-11 board the patches stand well clear of each other;
 * on a small enough board the centres come close enough that they overlap and
 * the Set merges them into one larger zone. That is degenerate but not wrong
 * - claims are clipped to the set either way - and the schema allows a radius
 * as low as 1, where every hex on the board is a capture hex.
 * ponytail: no minimum radius is enforced, because what a tiny board should
 * do with five zones is the owner's call, not a default worth inventing.
 *
 * Memoised: the answer depends on nothing but the radius, and this is on the
 * path that rebuilds the board's cells - every staged step, every buff.
 */
const zoneCache = new Map<number, Set<string>>();

export function captureZoneHexes(radius: number): Set<string> {
  const cached = zoneCache.get(radius);
  if (cached) return cached;
  // One step left or right is one column. Up and down goes in pairs of rows -
  // (1,-2) is straight up - which is what keeps those two zones in the
  // board's own centre column instead of half a column off it.
  const cols = Math.max(ZONE_SPREAD + 1, Math.round(radius * ZONE_COLS));
  const pairs = Math.max(1, Math.round((radius * ZONE_ROWS) / 2));
  const centres: Array<[number, number]> = [
    [0, 0],
    [cols, 0], [-cols, 0],
    [pairs, -2 * pairs], [-pairs, 2 * pairs],
  ];
  const hexes = new Set<string>();
  for (const [cq, cr] of centres) {
    // The rows a radius-N patch spans, and the span of each - the same bounds
    // computeAttackZone walks, rather than a square with the corners thrown
    // away.
    for (let dq = -ZONE_SPREAD; dq <= ZONE_SPREAD; dq++) {
      const lo = Math.max(-ZONE_SPREAD, -dq - ZONE_SPREAD);
      const hi = Math.min(ZONE_SPREAD, -dq + ZONE_SPREAD);
      for (let dr = lo; dr <= hi; dr++) {
        const q = cq + dq, r = cr + dr;
        if (isInsideBoard(q, r, radius)) hexes.add(`${q},${r}`);
      }
    }
  }
  zoneCache.set(radius, hexes);
  return hexes;
}

/**
 * Who holds each capture hex. A unit standing in a zone takes the hex under
 * it and the zone hexes beside it - so the middle of a patch is worth seven,
 * and a hex on its rim rather less. Adjacency stops at the zone's edge: the
 * ordinary board around a zone is not worth anything.
 *
 * A hex both sides reach is held by neither, which is what cancels two lines
 * of units that meet in a zone: their claims overlap along the seam where
 * they touch, and every hex in the overlap goes neutral. Only decided hexes
 * are returned, so a cancelled one reads the same as an empty one - to the
 * score and to the board.
 */
export function captureClaims(
  boardState: BoardLike, radius: number,
): Map<string, 'white' | 'black'> {
  const zone = captureZoneHexes(radius);
  const claimed = new Map<string, 'white' | 'black' | 'contested'>();
  const claim = (key: string, color: 'white' | 'black') => {
    const held = claimed.get(key);
    if (held === undefined) claimed.set(key, color);
    else if (held !== color) claimed.set(key, 'contested');
  };
  for (const [key, piece] of Object.entries(boardState)) {
    if (!piece || !zone.has(key)) continue;
    const color = piece.color === 'black' ? 'black' : 'white';
    claim(key, color);
    const [q, r] = key.split(',').map(Number);
    for (const [dq, dr] of HEX_DIRS) {
      const next = `${q + dq},${r + dr}`;
      if (zone.has(next)) claim(next, color);
    }
  }
  const held = new Map<string, 'white' | 'black'>();
  for (const [key, color] of claimed) if (color !== 'contested') held.set(key, color);
  return held;
}

/** What a side's holdings are worth: a point a hex, every turn it keeps them. */
export function captureScore(
  claims: Map<string, 'white' | 'black'>, color: 'white' | 'black',
): number {
  let held = 0;
  for (const owner of claims.values()) if (owner === color) held++;
  return held;
}

/** Hex distance between two "q,r" keys. */
export function hexDistanceKeys(a: string, b: string): number {
  const [aq, ar] = a.split(',').map(Number);
  const [bq, br] = b.split(',').map(Number);
  return hexDistance(aq - bq, ar - br);
}

/**
 * Damage one unit lands on another: ring-scaled attack less the defender's
 * defence, floored at 0. Mirrors strike_damage() in game_logic.py.
 *
 * A one-turn ability boost rides on top of the scaled numbers rather than the
 * raw stat, because that is where the hex and the unit panel show it: a +2 on
 * a unit whose second ring reads 19 makes that ring 21, not 21 less falloff.
 */
export function strikeDamage(
  attackerId: string, defenderId: string, distance: number, config: any,
  atkBonus = 0, defBonus = 0,
): number {
  const attacker = config?.units?.[attackerId] ?? {};
  const defender = config?.units?.[defenderId] ?? {};
  const attack = rangedDamage(attacker.attack ?? 1, distance, config) + atkBonus;
  return Math.max(0, attack - ((defender.defense ?? 0) + defBonus));
}
