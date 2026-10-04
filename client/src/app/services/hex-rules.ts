/**
 * Client-side movement rules.
 *
 * Fully config-driven: unit ids are opaque labels. Movement comes from the
 * unit's single `move` stat - a flood fill through the six hex neighbours.
 * A unit walks THROUGH its own: an ally costs a step to pass but is not
 * somewhere to stop, so it never limits the reach beyond it. An enemy blocks
 * the hex and the way past it alike.
 *
 * This MIRRORS server/game/engine/move_validator.py. Both the board's
 * legal-move preview and the offline single-player engine read it, so a
 * change to the server's movement rules has to land here too or the client
 * will disagree with the server about what a unit may do.
 */

export type BoardLike = Record<string, { unit_id: string; color: string } | undefined>;

export const HEX_DIRS: [number, number][] = [
  [+1, 0], [-1, 0], [+1, -1], [0, -1], [0, 1], [-1, 1],
];

/** Rings from the origin to (q, r) - the hex metric, in one place. */
/**
 * The two panels that are a **base** - each player's left plane, bottom-left
 * for white and top-right for black. The other pair is the reserve.
 *
 * The two are told apart for what is allowed *out* of them (the wrap leaves a
 * base, the battlefield is entered from a reserve) and for what happens *in*
 * them: **a base mends its wounded and a reserve does not.** Which is why
 * this lives here rather than in the board that draws them - the room derives
 * the mending and has to answer the same question.
 */
export const BASE_PANELS = new Set(['bl', 'tr']);

/** The pixel quadrant of a panel hex, using the signs of axialToPixel. */
export function panelOfHex(key: string, orientation = 'edge-up'): string {
  const [q, r] = String(key).split(',').map(Number);
  if (!Number.isInteger(q) || !Number.isInteger(r)) return '';
  const x = orientation === 'vertex-up' ? q : 2 * q + r;
  const y = orientation === 'vertex-up' ? q + 2 * r : r;
  return `${y < 0 ? 't' : 'b'}${x < 0 ? 'l' : 'r'}`;
}

/**
 * Whether a new game gets the **placeholder** squads instead of the setup's.
 * Mirrors `PANELS_DEALT` in `server/game/engine/panels.py`, and the two go on
 * together or the two sides of a networked game disagree about who is
 * standing where.
 *
 * A real game stands in its panels what the config's setup puts there - since
 * 25 Sep 2026 the owner's base squads, and nothing in the reserves. The
 * placeholder deal (one of each of the first five unit types, on every third
 * hex of all four panels) is what the panel specs were written against - the
 * walk, the wrap, the crossing, the blow, the walk home - so they turn this on
 * and keep their fixtures. With it on the placeholder squads stand **instead
 * of** the setup's panel entries, never beside them.
 *
 * Mutable so the specs can deal a board to test that machinery on; nothing in
 * the app writes to it. `setPanelsDealt` is the only writer.
 */
export let PANELS_DEALT = false;

/** Turn the deal on or off. For the specs - the app never calls this. */
export function setPanelsDealt(on: boolean): void {
  PANELS_DEALT = on;
}

/**
 * How deep a side's own ground runs from its own edge inwards - the "first
 * three rows". Mirrors `HOME_ROWS` in server/game/engine/panels.py.
 */
export const HOME_ROWS = 3;

/**
 * Whether row `r` is one of `color`'s own first three.
 *
 * The ground a side deploys onto, and the bound on both ends of a unit's
 * journey off the board: a crossing out of the reserve may not land beyond it,
 * and a unit may only walk home from inside it.
 *
 * White's edge is positive `r` and black's negative, so on radius 11 white
 * holds rows 9, 10 and 11 and black the mirror. Read off the radius rather
 * than off the placement, because this marks the ground a side *owns* - still
 * its ground on a config that leaves some of those hexes empty, which is also
 * why the board's `homeOf` tint reads the same answer from here.
 */
export function inHomeRows(color: string, r: number, radius: number): boolean {
  const edge = Math.max(1, radius - (HOME_ROWS - 1));
  return color === 'white' ? r >= edge : r <= -edge;
}

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
  /** Filled, if given, with the hexes the walk passes THROUGH but cannot stop
   *  on - a unit's own. The crossings need these: a friend standing on a
   *  gateway or a wrap tip is walked past, not walked into. */
  passable?: Map<string, number>,
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
        // A unit walks THROUGH its own: an ally costs a step to pass but is
        // not somewhere to stop, so it never limits the reach beyond it. An
        // enemy still blocks both the hex and the way past it.
        const blocker = boardState[key];
        if (blocker && blocker.color !== piece.color) continue;
        if (blocker) passable?.set(key, step);
        else costs.set(key, step);
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
  /** A healer uses this same ring geometry, bounded to the battlefield. */
  range: number = config?.units?.[unitId]?.attackRange ?? 1,
  minimum: number = config?.units?.[unitId]?.attackMinRange ?? 1,
): Set<string> {
  const zone = new Set<string>();
  if (range < 1) return zone;

  const offsets: [number, number][] = [];
  for (let dq = -range; dq <= range; dq++) {
    const lo = Math.max(-range, -dq - range);
    const hi = Math.min(range, -dq + range);
    for (let dr = lo; dr <= hi; dr++) {
      if (hexDistance(dq, dr) < minimum) continue;
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

/** Whether a unit has an attack at this distance, counters included. */
export function canAttack(unit: any, distance: number): boolean {
  const attack = unit?.attack ?? 1;
  const armed = Array.isArray(attack) ? attack.some(value => value > 0) : attack > 0;
  return armed && !unit?.heal?.length
    && distance >= (unit?.attackMinRange ?? 1) && distance <= (unit?.attackRange ?? 1);
}

/** Exact list attack from its first supported ring, or scalar percentage falloff. */
export function rangedDamage(attack: number | number[], distance: number, config: any, minimum = 1): number {
  // Lists name exact attacks per ring; only a scalar takes percentage falloff.
  if (Array.isArray(attack)) return attack[distance - minimum] ?? 0;
  if (attack <= 0 || distance <= 1) return Math.max(0, attack);
  const falloff: number = config?.rules?.rangeFalloff ?? 0;
  const scale = Math.max(0, 1 - falloff * (distance - 1));
  return Math.max(1, Math.trunc(attack * scale));
}

/** Exact healing at this ring, capped to missing HP; mirrors resolve_heal. */
export function healingAmount(unitId: string, target: { unit_id: string; hp: number; max_hp?: number },
                              distance: number, config: any): number {
  const amount = config?.units?.[unitId]?.heal?.[distance - 1] ?? 0;
  const max = target.max_hp ?? config?.units?.[target.unit_id]?.hp ?? 0;
  return Math.max(0, Math.min(amount, max - target.hp));
}

/**
 * Damage per ring for a unit, outermost ring last: [16] for a melee unit,
 * [26, 19] for one that reaches two rings. Drawn on the hex as "26,19".
 */
export function attackTiers(unitId: string, config: any): number[] {
  const unit = config?.units?.[unitId];
  if (!unit) return [];
  const attack: number | number[] = unit.attack ?? 0;
  const range: number = Math.max(1, unit.attackRange ?? 1);
  const tiers: number[] = [];
  const minimum: number = unit.attackMinRange ?? 1;
  for (let ring = minimum; ring <= range; ring++) tiers.push(rangedDamage(attack, ring, config, minimum));
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
 * What one hex of each zone is worth to the side holding it. The owner, 26 Sep
 * 2026: "make the hex capture zone near my base 3x. the middle hex worth 2x.
 * side hex worth 1x" - the zone in each side's own half 3 a hex (412 and 130 on
 * the shipped board), the middle one 2 (271), the two at the sides 1 (264 and
 * 278). Black's is the mirror of white's, and a zone is worth the same to
 * whichever side holds it.
 */
export const ZONE_WORTH = { base: 3, middle: 2, side: 1 } as const;

/**
 * The five capture zones, as what each of their hexes is worth: a patch in the
 * middle and four around it - top, bottom, left, right - the same size and
 * the same distance out, so they read as one set rather than five decisions.
 *
 * On the shipped radius-11 board the patches stand well clear of each other;
 * on a small enough board the centres come close enough that they overlap,
 * and a hex in two is worth the higher. That is degenerate but not wrong -
 * claims are clipped to the zones either way - and the schema allows a radius
 * as low as 1, where every hex on the board is a capture hex.
 * ponytail: no minimum radius is enforced, because what a tiny board should
 * do with five zones is the owner's call, not a default worth inventing.
 *
 * Memoised: the answer depends on nothing but the radius, and this is on the
 * path that rebuilds the board's cells - every staged step, every buff.
 */
export interface CaptureZone {
  center: string;
  kind: 'base' | 'middle' | 'side';
  owner: 'white' | 'black' | '';
  worth: number;
  hexes: Set<string>;
}
const zonesCache = new Map<number, CaptureZone[]>();

export function captureZones(radius: number): CaptureZone[] {
  const cached = zonesCache.get(radius);
  if (cached) return cached;
  const cols = Math.max(ZONE_SPREAD + 1, Math.round(radius * ZONE_COLS));
  const pairs = Math.max(1, Math.round((radius * ZONE_ROWS) / 2));
  const centres: Array<[number, number, CaptureZone['kind'], CaptureZone['owner']]> = [
    [0, 0, 'middle', ''], [cols, 0, 'side', ''], [-cols, 0, 'side', ''],
    [pairs, -2 * pairs, 'base', 'black'], [-pairs, 2 * pairs, 'base', 'white'],
  ];
  const zones = centres.map(([cq, cr, kind, owner]) => {
    const hexes = new Set<string>();
    for (let dq = -ZONE_SPREAD; dq <= ZONE_SPREAD; dq++) {
      const lo = Math.max(-ZONE_SPREAD, -dq - ZONE_SPREAD);
      const hi = Math.min(ZONE_SPREAD, -dq + ZONE_SPREAD);
      for (let dr = lo; dr <= hi; dr++) {
        const q = cq + dq, r = cr + dr;
        if (isInsideBoard(q, r, radius)) hexes.add(`${q},${r}`);
      }
    }
    return { center: `${cq},${cr}`, kind, owner, worth: ZONE_WORTH[kind], hexes };
  });
  zonesCache.set(radius, zones);
  return zones;
}

const zoneCache = new Map<number, Map<string, number>>();
export function captureZoneValues(radius: number): Map<string, number> {
  const cached = zoneCache.get(radius);
  if (cached) return cached;
  const worths = new Map<string, number>();
  for (const zone of captureZones(radius)) {
    for (const key of zone.hexes) worths.set(key, Math.max(zone.worth, worths.get(key) ?? 0));
  }
  zoneCache.set(radius, worths);
  return worths;
}

/** Every capture hex, as one set. */
const zoneHexCache = new Map<number, Set<string>>();

export function captureZoneHexes(radius: number): Set<string> {
  let hexes = zoneHexCache.get(radius);
  if (!hexes) zoneHexCache.set(radius, hexes = new Set(captureZoneValues(radius).keys()));
  return hexes;
}

/**
 * Outer-ring units score their own hex; inner-ring units also score neighbours.
 * Every eligible unit neutralizes opposing claims on its own and adjacent hexes.
 * Permissions are relative to the unit's side and come from config, never from its id.
 * A centre unit holds its entire zone while no eligible enemy stands in it.
 * With an eligible enemy anywhere in the zone, normal adjacent claims apply.
 * A hex reached by both sides is neutral; an ineligible unit makes no claim.
 */
export function captureClaims(
  boardState: BoardLike, radius: number, config?: any,
): Map<string, 'white' | 'black'> {
  const zones = captureZones(radius);
  const eligible = (piece: any, zone: CaptureZone) => {
    const permissions = config?.units?.[piece.unit_id]?.captureZones;
    const kind = zone.kind === 'base' ? (zone.owner === piece.color ? 'home' : 'enemy') : zone.kind;
    return permissions === undefined || permissions.includes(kind);
  };
  const disruption = { white: new Set<string>(), black: new Set<string>() };
  const claimed = new Map<string, 'white' | 'black' | 'contested'>();
  const claim = (key: string, color: 'white' | 'black') => {
    const held = claimed.get(key);
    if (held === undefined) claimed.set(key, color);
    else if (held !== color) claimed.set(key, 'contested');
  };
  for (const [key, piece] of Object.entries(boardState)) {
    if (!piece) continue;
    const allowed = new Set(zones.filter(zone => eligible(piece, zone)).flatMap(zone => [...zone.hexes]));
    if (!allowed.has(key)) continue;
    const color = piece.color === 'black' ? 'black' : 'white';
    claim(key, color);
    disruption[color].add(key);
    const expanded = zones.some(zone => eligible(piece, zone) && hexDistanceKeys(key, zone.center) < ZONE_SPREAD);
    const [q, r] = key.split(',').map(Number);
    for (const [dq, dr] of HEX_DIRS) {
      const next = `${q + dq},${r + dr}`;
      if (!allowed.has(next)) continue;
      disruption[color].add(next);
      if (expanded) claim(next, color);
    }
  }
  for (const zone of zones) {
    const center = boardState[zone.center];
    if (!center || !eligible(center, zone)) continue;
    const enemyPresent = Object.entries(boardState).some(([key, piece]) =>
      piece && piece.color !== center.color && zone.hexes.has(key) && eligible(piece, zone));
    if (!enemyPresent) for (const key of zone.hexes) claim(key, center.color === 'black' ? 'black' : 'white');
  }
  const held = new Map<string, 'white' | 'black'>();
  for (const [key, color] of claimed) {
    if (color !== 'contested' && !disruption[color === 'white' ? 'black' : 'white'].has(key)) held.set(key, color);
  }
  return held;
}

/** What the hexes a side holds are worth: each its zone's worth (ZONE_WORTH). */
export function captureScore(
  claims: Map<string, 'white' | 'black'>, color: 'white' | 'black', radius: number,
): number {
  const worths = captureZoneValues(radius);
  let held = 0;
  for (const [key, owner] of claims) if (owner === color) held += worths.get(key) ?? 0;
  return held;
}

/** Hex distance between two "q,r" keys. */
export function hexDistanceKeys(a: string, b: string): number {
  const [aq, ar] = a.split(',').map(Number);
  const [bq, br] = b.split(',').map(Number);
  return hexDistance(aq - bq, ar - br);
}

/**
 * Fallback for a config that names no floor at all. `normaliseConfig` fills
 * `rules.minStrikeDamage` in from `DEFAULT_GAME_CONFIG`, so this is only
 * reached by a caller that hand-built a config object without going through
 * the config service - several specs do exactly that.
 */
export const MIN_STRIKE_DAMAGE = 1;

/**
 * Damage one unit lands on another: ring-scaled attack less the defender's
 * defence, floored at `rules.minStrikeDamage`. Mirrors strike_damage() in
 * game_logic.py.
 *
 * At the default of 1 a blow that lands always takes something off. It used
 * to floor at 0, and the owner's report was *"some shit simply doesn't seem
 * to take any hit"* - which was the formula working exactly as written: a
 * pawn (14 attack) against a shieldman (18 defence) came to -4 and floored to
 * nothing, so the pair could trade blows all game and neither would ever
 * move. Set the dial to 0 to have that back.
 *
 * A one-turn ability boost rides on top of the scaled numbers rather than the
 * raw stat, because that is where the hex and the unit panel show it: a +2 on
 * a unit whose second ring reads 19 makes that ring 21, not 21 less falloff.
 *
 * An attack of nothing is still nothing: the floor lifts a blow that was
 * blunted, not one that was never thrown. Without that guard a unit with no
 * attack stat at all would chip away a point a turn.
 *
 * Read off the config rather than a constant so the browser and the server
 * cannot drift - this is the same config object `rangedDamage` takes
 * `rangeFalloff` from, and `strike_damage()` reads the same field.
 */
export function strikeDamage(
  attackerId: string, defenderId: string, distance: number, config: any,
  atkBonus = 0, defBonus = 0,
): number {
  const attacker = config?.units?.[attackerId] ?? {};
  if (!canAttack(attacker, distance)) return 0;
  const defender = config?.units?.[defenderId] ?? {};
  const base = rangedDamage(attacker.attack ?? 1, distance, config, attacker.attackMinRange ?? 1);
  if (base <= 0) return 0;
  const attack = base + atkBonus;
  if (attack <= 0) return 0;
  // Never more than the attacker could deal unblunted. The floor lifts a hit
  // that armour absorbed; it is not a damage source of its own, and without
  // this clamp a large `minStrikeDamage` would override the attack stat
  // outright - every blow dealing the floor regardless of attack, defence or
  // ring falloff, which makes all three dead config.
  const floor = config?.rules?.minStrikeDamage ?? MIN_STRIKE_DAMAGE;
  return Math.min(attack, Math.max(floor, attack - ((defender.defense ?? 0) + defBonus)));
}
