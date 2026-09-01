import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnChanges,
  OnInit,
  OnDestroy,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  attackTiers, captureClaims, captureZoneHexes, computeAttackZone, computeLegalMoves,
  computeMoveCosts, hexDistanceKeys, isInsideBoard, strikeDamage, HEX_DIRS,
} from '../../services/hex-rules';
import {
  OVERTIME_FIRST_PLY, isInitialization, isWrapOpen, sideOfPly,
} from '../../services/phases';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PieceData {
  unit_id: string;
  color: 'white' | 'black';
  hp: number;
  max_hp: number;
  /** Identity that survives moves - see build_initial_board. */
  uid?: string;
}

type BoardState = Record<string, PieceData>;

/** What the game room's Unit panel needs about the selected hex. */
export interface SelectedUnit {
  key: string;                       // "q,r" - lets the room match a staged move
  uid: string;                       // the unit itself, wherever it stands
  unitId: string;                    // config key, for per-unit lookups
  name: string;
  color: 'white' | 'black';
  hp: number | null;
  hpMax: number | null;
  /** HP left after the trade currently being hovered, else null. */
  hpAfter: number | null;
  atk: string;                       // damage per ring, e.g. "26,19"
  def: number | null;
  mv: number | null;                 // full move budget
  points: number;                    // what the unit is worth (config `value`)
  vet: number;                       // 0-3
  panel?: string;                    // reserve panel, when outside the battlefield
  /** Whether this unit could do anything at all right now. */
  drivable: boolean;
}

/** Internal render model for a single hex. */
/** Blades where a blow landed next door, flight paths for the rest. */
interface StrikeMarks {
  swords: Array<{ x: number; y: number }>;
  lines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

/**
 * One beat of the replay a committed turn plays back. The room builds the
 * list from what it staged; the board is what knows where a hex is.
 */
export interface AnimStep {
  kind: 'move' | 'attack' | 'counter' | 'ability' | 'pick';
  /** Where the actor stands (attack, ability) or starts from (move). */
  from: string;
  /** Where it lands (move) or what it hits (attack, counter, ability). */
  to: string;
  /** For an ability beat: which slot cast it, so its button can pop too. */
  index?: number;
  /** Whose panel that slot is in. Both sides draw the same indices. */
  side?: 'mine' | 'opponent';
  /** For an ability beat: cast at an enemy rather than on your own. */
  hostile?: boolean;
  /** A recap beat: the same animation, run short. */
  brief?: boolean;
}

/** A unit that died, and the hex it died on. */
export interface FallenUnit {
  key: string;
  unit_id: string;
  color: 'white' | 'black';
}

/** The same, resolved to what the board draws for it. */
interface FallenDrawing {
  x: number;
  y: number;
  points: string;
  symbol: string;
  atk: string;
  def: number | null;
  mov: number | null;
  rangeLow: number;
  rangeHigh: number;
  dark: boolean;
}

interface HexCell {
  q: number;
  r: number;
  key: string;          // "q,r"
  cx: number;           // SVG centre X
  cy: number;           // SVG centre Y
  points: string;       // SVG polygon points for the hex
  piece: PieceData | null;
  /** Outside the radius-N battlefield - one of the four reserve panels. */
  filler: boolean;
  /** '' for battlefield, else 'bl' | 'br' | 'tr' | 'tl' - which panel. */
  panel: string;
  /** '' for battlefield, else 'hex-filler panel-xx' picking the panel colour. */
  zoneClass: string;
  /** Whose setup rows this hex is in, from this client's seat; '' between. */
  home: 'mine' | 'theirs' | '';
  /** A reserve hex units enter the board from, and which way its arrow points. */
  /**
   * An arrow on the hex: 'left'/'right' on the three gateways onto the
   * battlefield, 'up'/'down' on the two ends of the wrap.
   */
  gateway: 'left' | 'right' | 'up' | 'down' | '';
  /** Whose arrow it is, so the two sides' are not the same colour. */
  arrowSide: 'mine' | 'theirs' | '';
  /**
   * Whether the arrow sits on the far side of its hex from where it points.
   * The way-in marks do: a unit crosses from the battlefield, so the arrow
   * waits on the edge it arrives at rather than the one it is aimed at.
   */
  arrowBack: boolean;
  /** The base tip a wrap leaves from - the end the schedule can shut. */
  wrapOut: boolean;
  /** 1-based reading order over every hex, panels included. */
  num: number;
  /** Smaller hex drawn under an occupying unit. */
  innerPoints: string;
  /** Stats shown around the unit; null when the hex is empty. */
  stats: {
    hp: number | null;
    atk: string;
    def: number | null;
    rangeLow: number;
    rangeHigh: number;
  } | null;
  /** Veterancy 0-3, currently a placeholder derived from the unit's position. */
  vet: number;
}

// ---------------------------------------------------------------------------
// Hex geometry helpers
// ---------------------------------------------------------------------------

/**
 * Board orientation (from config.board.orientation, cosmetic only):
 *  - 'edge-up'   -> pointy-top cells; the board hexagon has a flat edge on top.
 *  - 'vertex-up' -> flat-top cells; the board hexagon has a corner on top.
 * The default game board is an edge-up hexagon.
 */
export type BoardOrientation = 'edge-up' | 'vertex-up';

const HEX_SIZE = 28; // radius of a single hex in SVG pixels

/** Centre to edge midpoint. Two adjacent centres are exactly twice this. */

/** Radius of the inner hex a unit sits on. Close to HEX_SIZE so only a thin
 *  ring of board shows around it - the stats sit ON the plate, not beside it. */
/* Two adjacent centres are exactly two inradii apart, so stepping one in
   from each centre lands on the edge between them - the shared one next
   door, and the near edge of each hex across a gap. */
const HEX_INRADIUS = HEX_SIZE * Math.sqrt(3) / 2;
const PLATE_SIZE = 25;
/**
 * How fast a committed turn plays back. Every beat below is written at its
 * 1x length and divided by this, so the recap keeps its shape and only its
 * pace changes - one dial rather than seven numbers to keep in step.
 * ponytail: the owner's dial - "about 50% faster".
 */
const PLAYBACK_SPEED = 1.5;
const beat = (ms: number) => Math.round(ms / PLAYBACK_SPEED);

/** How long each beat of a committed turn takes to play. */
const MOVE_MS = beat(840);
const STRIKE_MS = beat(340);
const HIT_MS = beat(520);
const GLOW_MS = beat(2000);
/** The same beat in the end-of-turn recap, where there may be several. */
const GLOW_BRIEF_MS = beat(1200);
/** A slot being taken up - shorter than using one, and board-less. */
const PICK_MS = beat(900);
/** Blank frame between beats, so each one starts its animation over. */
const BEAT_GAP_MS = beat(180);
/** The turn's last beat: the base's mending, and overtime's toll with it. */
const UPKEEP_MS = beat(760);
/** How long an end-of-turn `+1` / `-1` stays legible after its swell. */
const MARK_FADE_MS = beat(2200);

/** Padding around the outermost hex centres in the viewBox. Must match buildCells(). */
const VIEWBOX_PADDING = HEX_SIZE + 4;

/**
 * Convert axial (q, r) to pixel (x, y).
 * Reference: https://www.redblobgames.com/grids/hexagons/#hex-to-pixel
 */
function axialToPixel(q: number, r: number, orientation: BoardOrientation): { x: number; y: number } {
  if (orientation === 'vertex-up') {
    // flat-top cells
    return {
      x: HEX_SIZE * (3 / 2) * q,
      y: HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r),
    };
  }
  // edge-up board -> pointy-top cells
  return {
    x: HEX_SIZE * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r),
    y: HEX_SIZE * (3 / 2) * r,
  };
}

/**
 * Width / height of the board's rendered viewBox for a given radius - i.e. the
 * box the hexagon is drawn into.
 *
 * The game room's four corner panels are clipped to hug the hexagon's slanted
 * edges, and CSS can't work this out on its own: `clip-path` percentages
 * resolve against each panel's own box, not the board's. So the game room
 * measures its container, asks for this ratio, and publishes the resulting
 * hexagon size as CSS variables.
 */
export function boardBoxAspect(radius: number, orientation: BoardOrientation = 'edge-up'): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > radius) continue;
      const { x, y } = axialToPixel(q, r, orientation);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return 1;
  return (maxX - minX + VIEWBOX_PADDING * 2) / (maxY - minY + VIEWBOX_PADDING * 2);
}

/** Generate SVG polygon points for a hex centred at (cx, cy). */
function hexPoints(cx: number, cy: number, orientation: BoardOrientation, size = HEX_SIZE): string {
  const startDeg = orientation === 'vertex-up' ? 0 : 30; // pointy-top corners are offset 30°
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i + startDeg);
    const px = cx + size * Math.cos(angle);
    const py = cy + size * Math.sin(angle);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Stats render in two digits at most - clamp rather than overflow the hex. */
function twoDigits(v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : Math.min(99, Math.max(0, Math.trunc(v)));
}

/**
 * Placeholder veterancy 0-3. Deterministic from the coord + unit so it does not
 * flicker on every redraw - the real mechanic is not specified yet.
 */
function placeholderVet(key: string, unitId: string): number {
  let h = 0;
  const seed = key + unitId;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 4;
}

/**
 * Attack as drawn on the hex: one number per ring the unit can strike,
 * outermost last - "16" for a melee unit, "26,19" for one that reaches two.
 */
function attackText(unitId: string, config: any): string {
  return attackTiers(unitId, config).map(d => String(twoDigits(d))).join(',');
}

function attackCellText(unitId: string, config: any, bonus = 0): string {
  return String(twoDigits((attackTiers(unitId, config)[0] ?? 0) + bonus));
}

/** The far end of a unit's reach; the near end is a ring away from itself. */
function rangeHigh(unitId: string, config: any): number {
  return config?.units?.[unitId]?.attackRange ?? 1;
}

/** Nothing strikes its own hex, so the near end of every reach is 1 today. */
const RANGE_LOW = 1;

/** Stat as drawn on the hex: plain digits, two at most (see twoDigits). */
function statText(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * "q,r" -> hex number, in the same reading order the board draws: 1 at the
 * top-left of the block, rightwards along each row, then down. Exported so the
 * game room can label move history with the numbers shown on the board.
 */
export function hexNumberMap(
  radius: number,
  orientation: BoardOrientation = 'edge-up',
): Record<string, number> {
  const coords = gridCoords(radius, orientation);
  const out: Record<string, number> = {};
  coords.forEach((c, i) => { out[`${c.q},${c.r}`] = i + 1; });
  return out;
}

/**
 * Which corner panel a filler hex sits in. Panel colours follow each player's
 * OWN left/right - see the stylesheet - so the bottom pair is white's and the
 * top pair is black's.
 */
function panelOf(x: number, y: number): string {
  return `${y < 0 ? 't' : 'b'}${x < 0 ? 'l' : 'r'}`;
}

/**
 * The base is each player's left plane - the red pair, bottom-left for white
 * and top-right for black. The green pair opposite is the reserve. The two
 * are told apart for what is allowed *out* of them - the wrap leaves a base,
 * the battlefield is entered from a reserve - not for the mover cap, which
 * both now carry.
 */
const BASE_PANELS = new Set(['bl', 'tr']);

/**
 * How many units of one panel may be started in a turn. An allowance each:
 * three out of the base and three out of the reserve, all match. The reserve
 * used to be capped only through the opening and shuffle freely after.
 * ponytail: the owner's placeholder - "3 of these (for now)". A constant
 * because that is all it is; it moves to config when the real number lands.
 */
const PANEL_MOVERS_PER_TURN = 3;

/**
 * The three reserve hexes a side may step onto the battlefield from, each
 * mapped to the way its arrow points: hexes 490 `(3,9)`, 513 `(2,10)` and 536
 * `(1,11)` on white's side of the shipped board, and the point mirror of
 * those for black. They are the board-adjacent reserve hexes nearest that
 * player's own edge - the run of them satisfies `q + r = radius + 1`.
 *
 * The arrow points at the battlefield, which sits to the left of white's
 * reserve and to the right of black's. It is drawn in board space, so a solo
 * game as black rotates it with everything else and it still points inward.
 */
function gatewayHexes(radius: number): Map<string, { dir: 'left' | 'right'; color: 'white' | 'black' }> {
  const out = new Map<string, { dir: 'left' | 'right'; color: 'white' | 'black' }>();
  for (const step of [2, 1, 0]) {
    out.set(`${step + 1},${radius - step}`, { dir: 'left', color: 'white' });
    out.set(`${-step - 1},${step - radius}`, { dir: 'right', color: 'black' });
  }
  return out;
}

/**
 * The three base hexes marked as a way onto the battlefield: hexes **19**
 * `(12,-11)`, **43** `(12,-10)` and **67** `(12,-9)` on black's side of the
 * shipped board, and the point mirror of those - **523**, **499** and **475**
 * - on white's. The run down each base's outer edge, from that player's own
 * far corner inwards.
 *
 * The arrow points **into the base** - the way a unit travels through it -
 * so it runs away from the battlefield: rightward into black's base, leftward
 * into white's. Drawn in board space, so a solo game as black turns them with
 * everything else and each player reads their own as pointing left, into
 * their own back line.
 *
 * It sits on the far edge from the way it points (`back`), which is the edge
 * facing the battlefield: a unit comes in from there, so the mark waits where
 * it arrives rather than where it is headed.
 */
function baseGatewayHexes(
  radius: number,
): Map<string, { dir: 'left' | 'right'; color: 'white' | 'black'; back: boolean }> {
  const out = new Map<
    string, { dir: 'left' | 'right'; color: 'white' | 'black'; back: boolean }
  >();
  for (const step of [0, 1, 2]) {
    out.set(`${radius + 1},${step - radius}`, { dir: 'right', color: 'black', back: true });
    out.set(`${-radius - 1},${radius - step}`, { dir: 'left', color: 'white', back: true });
  }
  return out;
}

/** Every hex in the squared-off block, already in reading order. */
function gridCoords(radius: number, orientation: BoardOrientation) {
  let limitX = 0, limitY = 0;
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > radius) continue;
      const { x, y } = axialToPixel(q, r, orientation);
      limitX = Math.max(limitX, Math.abs(x));
      limitY = Math.max(limitY, Math.abs(y));
    }
  }
  limitX += Math.abs(axialToPixel(1, 0, orientation).x - axialToPixel(0, 0, orientation).x) / 2;

  const EPS = 0.001;
  const scan = 2 * radius + 3;
  const cells: { q: number; r: number; x: number; y: number; onBattlefield: boolean }[] = [];
  for (let q = -scan; q <= scan; q++) {
    for (let r = -scan; r <= scan; r++) {
      const { x, y } = axialToPixel(q, r, orientation);
      const onBattlefield = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius;
      if (!onBattlefield && (Math.abs(x) > limitX + EPS || Math.abs(y) > limitY + EPS)) continue;
      cells.push({ q, r, x, y, onBattlefield });
    }
  }
  cells.sort((a, b) => a.y - b.y || a.x - b.x);
  return cells;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
  selector: 'app-game-board',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="board-container">
      <svg
        [attr.viewBox]="viewBox"
        class="hex-board"
        [class.board-flipped]="rotateBoard"
        preserveAspectRatio="xMidYMid meet"
        (mouseleave)="onHexHover(null)"
      >
        <defs>
          <marker id="movement-arrowhead" markerWidth="8" markerHeight="8"
                  refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 Z" class="movement-arrowhead" />
          </marker>
          <marker id="opponent-movement-arrowhead" markerWidth="8" markerHeight="8"
                  refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 Z" class="opponent-movement-arrowhead" />
          </marker>
        </defs>
        <ng-template #fallenUnit let-fallen let-marker="marker">
            <g class="fallen">
              <polygon [attr.points]="fallen.points" class="unit-plate"
                       [class.plate-white]="!fallen.dark"
                       [class.plate-black]="fallen.dark" />
              <text [attr.x]="fallen.x" [attr.y]="fallen.y + 1"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="piece-symbol"
                    [class.piece-white]="!fallen.dark"
                    [class.piece-black]="fallen.dark"
              >{{ fallen.symbol }}</text>
              <text [attr.x]="fallen.x" [attr.y]="fallen.y - 19"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="stat stat-hp" [class.on-dark]="fallen.dark">0</text>
              <text *ngIf="fallen.def !== null"
                    [attr.x]="fallen.x - 17" [attr.y]="fallen.y + 15"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="stat stat-def" [class.on-dark]="fallen.dark"
              >{{ fallen.def }}</text>
              <text [attr.x]="fallen.x + 17" [attr.y]="fallen.y + 15"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="stat stat-atk" [class.on-dark]="fallen.dark"
              >{{ fallen.atk }}</text>
              <text *ngIf="fallen.mov !== null"
                    [attr.x]="fallen.x - 17" [attr.y]="fallen.y - 15"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="stat stat-mov" [class.on-dark]="fallen.dark"
              >{{ fallen.mov }}</text>
              <text [attr.x]="fallen.x + 17" [attr.y]="fallen.y - 15"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="stat stat-range" [class.on-dark]="fallen.dark"
              >{{ fallen.rangeHigh }}</text>
              <text [attr.x]="fallen.x + 19" [attr.y]="fallen.y"
                    [attr.transform]="textTransform(fallen.x, fallen.y)"
                    class="stat stat-range" [class.on-dark]="fallen.dark"
              >{{ fallen.rangeLow }}</text>
            </g>
            <text [attr.x]="fallen.x" [attr.y]="fallen.y"
                  [attr.transform]="textTransform(fallen.x, fallen.y)"
                  [attr.class]="marker">&#9760;</text>
        </ng-template>

        <!-- Hex cells -->
        <g *ngFor="let hex of cells; trackBy: trackByKey">
          <polygon
            [attr.points]="hex.points"
            [class.hex-cell]="true"
            [ngClass]="hex.zoneClass"
            [class.home-mine]="hex.home === 'mine'"
            [class.home-theirs]="hex.home === 'theirs'"
            [class.hex-selected]="hex.key === selectedHex"
            [class.hex-legal]="!hex.panel && showingSelection && legalTargets.has(hex.key)"
            [class.hex-entry]="!hex.panel && isEntry(hex)"
            [class.hex-move-preview]="!hex.panel && previewMoves.has(hex.key) && (!showingSelection || !legalTargets.has(hex.key))"
            [class.hex-attack-preview]="!hex.panel && previewAttacks.has(hex.key)"
            [class.hex-attack-target]="!hex.panel && showingSelection && attackTargets.has(hex.key)"
            [class.preview-dim]="previewDim"
            [class.reach-up]="movWave === 'up' && (legalTargets.has(hex.key) || previewMoves.has(hex.key))"
            [class.reach-down]="movWave === 'down' && (legalTargets.has(hex.key) || previewMoves.has(hex.key))"
            [class.hex-damaged]="hex.key === lastDamagedHex"
            [class.hex-struck]="hex.key === hitHex"
            [class.hex-charged]="hex.key === glowHex"
            [class.ability-friendly-target]="isAbilityTarget(hex, 'friendly')"
            [class.ability-enemy-target]="isAbilityTarget(hex, 'enemy')"
            (click)="onHexClick(hex)"
            (mouseenter)="onHexHover(hex)"
          />
          <!-- Reach on a PANEL, the same way: a wash over the panel's own
               colour rather than a fill instead of it, so the two fuse into
               a third colour and the panel is still readable underneath.
               Every reach fill carries !important, which is why they are
               suppressed on panel hexes above rather than layered. -->
          <polygon
            *ngIf="panelWash(hex) as wash"
            [attr.points]="hex.points"
            class="panel-wash"
            [ngClass]="wash"
          />
          <!-- The zone as a wash laid over the hex rather than a fill under
               it: every reach colour carries !important, so a zone hex lit
               green or red used to lose its blue entirely. Not clickable -
               the hex beneath it still takes the pointer.
               The one thing it yields to is a crossing onto the board: that
               colour answers "where can this reserve land", and a wash over
               the top buried it under the zone's blue, or under the violet
               of whoever holds it. -->
          <polygon
            *ngIf="hex.zoneClass === 'zone' && !isEntry(hex)"
            [attr.points]="hex.points"
            class="zone-wash"
            [class.held-white]="captureClaim.get(hex.key) === 'white'"
            [class.held-black]="captureClaim.get(hex.key) === 'black'"
          />
          <!-- The way onto the battlefield on the three reserve hexes it can
               be taken from, and the two ends of the wrap. Under the unit
               group below, so a unit standing on the hex covers its middle
               but not the head. -->
          <polygon
            *ngIf="hex.gateway"
            [attr.points]="arrowPoints(hex)"
            class="gateway-arrow"
            [class.arrow-theirs]="hex.arrowSide === 'theirs'"
          />
          <!-- A wrap the schedule has shut, over the arrow it has shut. -->
          <path
            *ngIf="hex.wrapOut && !wrapOpen"
            [attr.d]="arrowCross(hex)"
            class="gateway-shut"
          />
          <!-- What a crossing costs, on every hex it buys. The dot gives way
               to it: they would sit on the same spot, and the price is the
               thing worth reading. -->
          <text
            *ngIf="wrapCostAt(hex) as cost"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy + 5"
            class="wrap-cost"
            [attr.transform]="textTransform(hex.cx, hex.cy)"
            (click)="onHexClick(hex)"
          >-{{ wrapCostAt(hex) }}</text>
          <!-- A crossing this side cannot pay for. The price still shows,
               on the tip it would land on, so the gap says what it wants
               rather than simply not opening. Not a target, so not clickable
               and no dot. -->
          <text
            *ngIf="wrapDeniedAt(hex) as denied"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy + 5"
            class="wrap-cost wrap-denied"
            [attr.transform]="textTransform(hex.cx, hex.cy)"
          >-{{ wrapDeniedAt(hex) }}</text>
          <!-- What coming home pays back, on every hex it can be done from. -->
          <text
            *ngIf="refundAt(hex) as refund"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy + 5"
            class="wrap-cost wrap-refund"
            [attr.transform]="textTransform(hex.cx, hex.cy)"
            (click)="onHexClick(hex)"
          >+{{ refundAt(hex) }}</text>
          <!-- What the last turn did to this unit: +1 for a turn of mending
               in the base, -1 for overtime's toll on a king. -->
          <text
            *ngIf="markOf(hex) as mark"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy - 18"
            class="heal-mark"
            [class.toll-mark]="mark.charAt(0) === '-'"
            [class.mark-theirs]="hex.piece?.color !== (myColor || 'white')"
            [attr.transform]="textTransform(hex.cx, hex.cy)"
          >{{ mark }}</text>
          <!-- Already walked this turn, and maybe with MOV still to spend:
               not greyed, but not untouched either. -->
          <circle
            *ngIf="hasWalked(hex)"
            [attr.cx]="hex.cx - 13"
            [attr.cy]="hex.cy - 13"
            [attr.r]="4.5"
            class="walked-mark"
          />
          <!-- Legal-move dot -->
          <circle
            *ngIf="showingSelection && legalTargets.has(hex.key) && !hex.piece
                   && !wrapCostAt(hex) && !refundAt(hex)"
            [attr.cx]="hex.cx"
            [attr.cy]="hex.cy"
            [attr.r]="6"
            class="legal-dot"
            (click)="onHexClick(hex)"
          />
          <!-- Unit: inner hex plate, icon in the opposite colour, and the
               stats ringed around it (HP top, attack right, move left). -->
          <ng-container *ngIf="hex.piece as pc">
            <!-- Plate, ring and face together, so an ability that swells the
                 unit swells all of it. On the group rather than the plate:
                 the plate's own animation belongs to the buff and debuff
                 glows, and a cast that lands a buff would lose the race. -->
            <g class="unit-pop" [attr.data-pop]="hex.key"
               [class.panel-walked]="hasWalked(hex)"
               [class.panel-spent]="isPanelSpent(hex)">
              <polygon
                *ngIf="!isMoving(hex.key)"
                [attr.points]="hex.innerPoints"
                class="unit-plate"
                [class.plate-white]="pc.color === 'white'"
                [class.plate-black]="pc.color === 'black'"
                [class.plate-selected]="hex.key === selectedHex"
                [class.plate-hovered]="hex.key === hoveredHex"
                [class.unit-buffed]="hasLift(pc.uid)"
                [class.unit-debuffed]="hasDrag(pc.uid)"
                [class.unit-both-effects]="hasLift(pc.uid) && hasDrag(pc.uid)"
                [class.ability-friendly-target]="isAbilityTarget(hex, 'friendly')"
                [class.ability-enemy-target]="isAbilityTarget(hex, 'enemy')"
                [class.doomed]="wouldDie(hex.key)"
                (click)="onHexClick(hex)"
                (mouseenter)="onHexHover(hex)"
              />
              <!-- The unit in hand. Its own element rather than a class on the
                   plate: the plate's filter already belongs to the buff and
                   debuff animations, and this must show through those. -->
              <polygon
                *ngIf="hex.key === selectedHex || hex.key === movesLeftFor"
                [attr.points]="hex.innerPoints"
                class="acting-ring"
              />
              <!-- Numbering mode replaces the unit's face with its hex number. -->
              <ng-container *ngIf="!showNumbers && !isMoving(hex.key)">
                <text
                  [attr.x]="hex.cx"
                  [attr.y]="hex.cy + 1"
                  [attr.transform]="textTransform(hex.cx, hex.cy)"
                  class="piece-symbol"
                  [class.piece-white]="pc.color === 'white'"
                  [class.piece-black]="pc.color === 'black'"
                  [class.piece-selected]="hex.key === selectedHex"
                  [class.doomed]="wouldDie(hex.key)"
                  [class.wave-acted-light]="hasActed(hex) && pc.color === 'white'"
                  [class.wave-acted-dark]="hasActed(hex) && pc.color === 'black'"
                  (click)="onHexClick(hex)"
                >{{ getPieceSymbol(pc) }}</text>
              </ng-container>
            </g>
          </ng-container>
        </g>
        <ng-container *ngFor="let arrow of movementArrowSegments">
          <line [attr.x1]="arrow.x1" [attr.y1]="arrow.y1"
                [attr.x2]="arrow.x2" [attr.y2]="arrow.y2"
                class="movement-arrow"
                marker-end="url(#movement-arrowhead)" />
        </ng-container>
        <ng-container *ngFor="let arrow of opponentMovementArrowSegments">
          <line [attr.x1]="arrow.x1" [attr.y1]="arrow.y1"
                [attr.x2]="arrow.x2" [attr.y2]="arrow.y2"
                class="opponent-movement-arrow"
                marker-end="url(#opponent-movement-arrowhead)" />
        </ng-container>
        <!-- A blow that was struck. In arm's reach that is crossed blades
             on the edge the two hexes share; from further out the shot's
             path runs under them, edge to edge across the gap. -->
        <ng-container *ngFor="let shot of attackStrikes.lines">
          <line [attr.x1]="shot.x1" [attr.y1]="shot.y1"
                [attr.x2]="shot.x2" [attr.y2]="shot.y2"
                class="attack-line" />
        </ng-container>
        <ng-container *ngFor="let sword of attackStrikes.swords">
          <text [attr.x]="sword.x" [attr.y]="sword.y"
                [attr.transform]="textTransform(sword.x, sword.y)"
                class="attack-sword">&#9876;</text>
        </ng-container>
        <!-- What used to stand here: the unit exactly as it was drawn, faded
             out and down to 0 HP, under its own skull. Nothing can be done
             with it, and anything that steps onto the hex takes it off. -->
        <ng-container *ngFor="let fallen of killMarkerPositions">
          <ng-container *ngTemplateOutlet="fallenUnit; context: { $implicit: fallen, marker: 'kill-marker' }"></ng-container>
        </ng-container>
        <!-- The opponent's last turn, drawn beside our own overlays. Inside
             the per-hex group these were painted once per occupied unit, each
             copy at that hex's z-order. -->
        <ng-container *ngFor="let shot of opponentAttackStrikes.lines">
          <line [attr.x1]="shot.x1" [attr.y1]="shot.y1"
                [attr.x2]="shot.x2" [attr.y2]="shot.y2"
                class="opponent-attack-line" />
        </ng-container>
        <ng-container *ngFor="let sword of opponentAttackStrikes.swords">
          <text [attr.x]="sword.x" [attr.y]="sword.y"
                [attr.transform]="textTransform(sword.x, sword.y)"
                class="opponent-attack-sword">&#9876;</text>
        </ng-container>
        <ng-container *ngFor="let fallen of opponentKillMarkerPositions">
          <ng-container *ngTemplateOutlet="fallenUnit; context: { $implicit: fallen, marker: 'opponent-kill-marker' }"></ng-container>
        </ng-container>

        <!-- The unit in flight, over the board and under the labels. -->
        <g *ngIf="mover" [attr.transform]="'translate(' + mover.x + ',' + mover.y + ')'">
          <polygon [attr.points]="mover.points" class="unit-plate"
                   [class.plate-white]="!mover.dark" [class.plate-black]="mover.dark" />
          <text [attr.x]="moverAnchor.x" [attr.y]="moverAnchor.y + 1"
                [attr.transform]="textTransform(moverAnchor.x, moverAnchor.y)"
                class="piece-symbol"
                [class.piece-white]="!mover.dark" [class.piece-black]="mover.dark"
          >{{ mover.symbol }}</text>
        </g>

        <!-- Labels last. An arrow or a pair of crossed blades running across
             the board has to pass UNDER the numbers and pips it crosses, or
             the hex it points at is the one that cannot be read. -->
        <g *ngFor="let hex of cells; trackBy: trackByKey">
          <ng-container *ngIf="hex.piece as pc">
            <ng-container *ngIf="!showNumbers">
              <!-- Hovering a reachable enemy answers the only question that
                   matters before swinging: what does this cost both of us. -->
              <text *ngIf="hex.stats?.hp != null"
                    [attr.x]="hex.cx" [attr.y]="hex.cy - 19"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="stat stat-hp"
                    [class.wave-hurt]="isWounded(hex)"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ statText(hex.stats?.hp) }}</text>
              <text *ngIf="hex.stats?.def != null"
                    [attr.x]="hex.cx - 17" [attr.y]="hex.cy + 15"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="stat stat-def" [ngClass]="statWave(hex, 'def')"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ statText(hex.stats?.def) }}</text>
              <text *ngIf="hex.stats?.atk != null"
                    [attr.x]="hex.cx + 17" [attr.y]="hex.cy + 15"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="stat stat-atk" [ngClass]="statWave(hex, 'atk')"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ hex.stats?.atk }}</text>
              <!-- Top corners: what it has left to walk on the left, how far
                   it can strike on the right. The far end of the reach sits up
                   there; the near end is on the side below it - a melee unit
                   reads 1 and 1. -->
              <text [attr.x]="hex.cx - 17" [attr.y]="hex.cy - 15"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="stat stat-mov" [ngClass]="statWave(hex, 'mov')"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ movText(hex) }}</text>
              <text [attr.x]="hex.cx + 17" [attr.y]="hex.cy - 15"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="stat stat-range"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ hex.stats?.rangeHigh }}</text>
              <text [attr.x]="hex.cx + 19" [attr.y]="hex.cy"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="stat stat-range"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ hex.stats?.rangeLow }}</text>
              <!-- Whoever the hovered trade would kill wears it on the face,
                   and fades out under it (see .doomed on the plate). -->
              <text *ngIf="wouldDie(hex.key)"
                    [attr.x]="hex.cx" [attr.y]="hex.cy + 1"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="kill-forecast">&#9760;</text>
              <!-- What the trade costs, over the face paying it: red for the
                   blow we land, purple for the counter that comes back. Drawn
                   after the skull so the number stays readable over it. -->
              <text *ngIf="forecastDamage(hex.key) as damage"
                    [attr.x]="hex.cx" [attr.y]="hex.cy + 1"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="damage-forecast"
                    [class.counter]="takesCounter(hex.key)"
              >{{ damage }}</text>
              <!-- Left side: which way this unit has been meddled with. Both
                   arrows show when it is carrying a boost and a drag at once,
                   and a dash when it is carrying neither. -->
              <text *ngFor="let arrow of effectArrows(hex)"
                    [attr.x]="arrow.x" [attr.y]="hex.cy"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="effect-arrow" [ngClass]="arrow.kind"
                    [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ arrow.glyph }}</text>
              <!-- Veterancy pips, all in the hex's bottom taper: a dash, one,
                   a pair, then a triangle - see vetPips. -->
              <text *ngFor="let pip of vetPips(hex)"
                    [attr.x]="pip.x" [attr.y]="pip.y"
                    [attr.transform]="textTransform(hex.cx, hex.cy)"
                    class="vet-star" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ pip.glyph }}</text>
            </ng-container>
          </ng-container>
          <!-- Numbering mode replaces every face with its hex number. -->
          <text
            *ngIf="showNumbers"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy"
            [attr.transform]="textTransform(hex.cx, hex.cy)"
            class="hex-number"
            [class.on-panel]="hex.filler"
            [class.on-plate]="!!hex.piece"
          >{{ hex.num }}</text>
        </g>
      </svg>

    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .board-container {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      flex: 1;
      width: 100%;
      min-height: 0;
    }

    .hex-board {
      /* Fill the whole container rather than sharing the column with the
         status bar: the game room sizes its corner panels from this exact box,
         so anything that shrinks it would leave them hugging thin air.
         preserveAspectRatio letterboxes the hexagon inside whatever box it gets. */
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
    }

    .hex-board.board-flipped {
      transform: rotate(180deg);
    }

    .hex-cell {
      fill: #f0d9b5;
      stroke: #b58863;
      stroke-width: 1;
      cursor: pointer;
      transition: fill 0.1s;
    }

    /* Each side's home ground - the three rows up to and including its pawn
       wall. Yours green and theirs red, the same language the turn indicator
       uses, and both pale enough that a piece still reads on top of them.
       Declared above .zone so a capture zone wins where the two overlap: the
       zone is the one that scores, and it is the one that carries a wash. */
    .home-mine { fill: #d7ecd9; }
    .home-theirs { fill: #f0d7d7; }

    /* The five zones, one colour: they are one thing in five places. The
       fill is the resting colour; the wash above it is what survives a hex
       being lit for reach, since every one of those carries !important. */
    .zone { fill: #b9d4f2; }

    .zone-wash {
      fill: #4a90d9;
      fill-opacity: 0.3;
      pointer-events: none;
    }

    /* Reach over a panel. Translucent on purpose: the panel's own colour
       shows through and the two fuse, so a lit reserve hex still reads as a
       reserve hex. Opacities are tuned per layer, not shared - a target has
       to shout where a preview only has to be visible. */
    .panel-wash {
      pointer-events: none;
    }

    .panel-wash.wash-legal { fill: #7ee08a; fill-opacity: 0.5; }
    .panel-wash.wash-move { fill: #7ee08a; fill-opacity: 0.34; }
    .panel-wash.wash-attack { fill: #ff6b63; fill-opacity: 0.38; }
    .panel-wash.wash-attack-target { fill: #ff2d24; fill-opacity: 0.62; }

    /* Held: the zone's own blue gives way to the side holding it. Amber and
       violet rather than the sides' own white and black - a white wash is
       invisible on a light board and a black one hides the hex under it. A
       hex both sides reach keeps the plain blue: it is worth nothing to
       either of them, which is the same as nobody standing there. */
    .zone-wash.held-white { fill: #ff8c1a; fill-opacity: 0.68; }
    .zone-wash.held-black { fill: #7b4fbf; fill-opacity: 0.58; }

    .hex-cell:not(.hex-filler):hover {
      fill: #e8cf9f;
    }

    /* The four panels squaring off the board: same grid, outside the radius-N
       battlefield. Colour-coded per corner; no meaning or interaction yet. */
    .hex-filler {
      stroke: rgba(255, 255, 255, 0.10);
      cursor: pointer;
    }
    .hex-filler:hover {
      stroke: rgba(255, 255, 255, 0.55);
      stroke-width: 2;
    }
    /* Panel colours follow each player's OWN left/right, not the screen's. The
       board never flips - white is always at the bottom, black at the top -
       so black faces the other way and his left is screen-right. Hence the
       diagonal pairing: white gets the bright pair, black the dark one.
         bottom-left  = white's left   -> red
         bottom-right = white's right  -> light green
         top-right    = black's left   -> dark red
         top-left     = black's right  -> dark green */
    .panel-bl { fill: #9e3b3b; }
    .panel-br { fill: #4e9c72; }
    .panel-tr { fill: #4f2020; }
    .panel-tl { fill: #1c4632; }

    .hex-selected {
      fill: #ffff66 !important;
      stroke: #cc9900;
      stroke-width: 2;
    }

    /* A unit's reach: where it could stand ... */
    .hex-move-preview {
      fill: #cfe6cf !important;
    }

    /* ... and where it could not stand but could still strike. */
    .hex-attack-preview {
      fill: #e9a7a2 !important;
    }

    /* The reach of a unit you cannot act with - an enemy, or one of yours
       once the turn is spent on another. Washed-out greys of the real thing:
       it is information, not somewhere anything can be sent this turn.
       Declared BEFORE the live classes so that where both land on one hex the
       actionable colour is the one that survives. */
    .hex-move-preview.preview-dim {
      fill: #ccd8cb !important;
    }

    .hex-attack-preview.preview-dim {
      fill: #d6bcb9 !important;
    }

    .hex-legal {
      fill: #c6e2c6 !important;
      cursor: pointer;
    }

    /* Where a reserve lands and how far it carries on once it is through the
       gap. Its own colour, and after .hex-legal so it wins: crossing onto the
       board is not the same move as shuffling about a panel, and the two read
       as one thing while they shared the green. */
    .hex-entry {
      fill: #8fd0e8 !important;
      cursor: pointer;
    }

    .hex-legal:hover {
      fill: #a0d4a0 !important;
    }

    /* An enemy the selected unit can hit right now - click to attack. */
    .hex-attack-target {
      fill: #d9534f !important;
      cursor: crosshair;
    }

    /* A blow landing, and an ability charging. Both are moments, not states:
       the runner clears them as the beat ends. */
    .hex-struck {
      fill: #ff8a80 !important;
      stroke: #c0392b;
      stroke-width: 3;
    }

    .hex-charged {
      fill: #ffe9a8 !important;
      stroke: #f1c40f;
      stroke-width: 3;
      filter: drop-shadow(0 0 6px #f1c40f);
    }

    .hex-damaged {
      fill: #ffb3b3 !important;
      stroke: #cc5555;
      stroke-width: 2;
    }

    .ability-friendly-target {
      fill: #f4d03f !important;
      stroke: #9a7600 !important;
      stroke-width: 3 !important;
      animation: ability-friendly-wave 0.9s ease-in-out infinite;
    }

    .ability-enemy-target {
      fill: #e74c3c !important;
      stroke: #8f1d14 !important;
      stroke-width: 3 !important;
      animation: ability-enemy-wave 0.9s ease-in-out infinite;
    }

    @keyframes ability-friendly-wave {
      0%, 100% { filter: brightness(0.95); }
      50% { filter: brightness(1.12); }
    }

    @keyframes ability-enemy-wave {
      0%, 100% { filter: brightness(0.95); }
      50% { filter: brightness(1.12); }
    }

    /* The price of a crossing, on each hex it would buy. Red, and outlined
       so it stays readable over a lit hex as well as a plain one. */
    .wrap-cost {
      fill: #b91c1c;
      font-size: 13px;
      font-weight: 800;
      text-anchor: middle;
      paint-order: stroke;
      stroke: rgba(255, 255, 255, 0.9);
      stroke-width: 3;
      stroke-linejoin: round;
      cursor: pointer;
    }

    /* What the last turn did to a unit, over the unit it did it to. Four
       colours, not two: which side wears the mark matters as much as what it
       says, and a green +1 over a unit that is not yours reads at a glance
       as your own until you have found the plate under it. Ordered
       mine-mended, theirs-mended, mine-struck, theirs-struck, so the more
       particular selector is always the later one. */
    .heal-mark {
      fill: #15803d;
      font-size: 13px;
      font-weight: 800;
      text-anchor: middle;
      paint-order: stroke;
      stroke: rgba(255, 255, 255, 0.9);
      stroke-width: 3;
      stroke-linejoin: round;
      pointer-events: none;
    }

    /* Mended, but not one of yours. */
    .heal-mark.mark-theirs {
      fill: #0369a1;
    }

    /* Taken away rather than given: overtime's toll on a king. */
    .heal-mark.toll-mark {
      fill: #b91c1c;
    }

    /* Their king paying it. */
    .heal-mark.toll-mark.mark-theirs {
      fill: #7e22ce;
    }

    /* A panel unit that has already been walked this turn. Sits off the
       plate's corner so it reads next to the unit rather than on it. */
    .walked-mark {
      fill: #f6c343;
      stroke: #3a2f0b;
      stroke-width: 1.2;
      pointer-events: none;
    }

    /* Coming home pays, so it is green where the wrap's price is red. */
    .wrap-cost.wrap-refund {
      fill: #15803d;
    }

    /* A price the side cannot meet: greyed and struck through, so it reads
       as "this is what it would cost" rather than as an offer. */
    .wrap-cost.wrap-denied {
      fill: #6b7280;
      text-decoration: line-through;
      cursor: not-allowed;
    }

    .legal-dot {
      fill: rgba(0, 128, 0, 0.4);
      pointer-events: none;
    }

    /* Sits high in the cell so it stays readable over a piece glyph. Two
       fills, because one colour cannot carry both the pale battlefield and
       the dark panels. */
    .hex-number {
      /* 3 digits at this size span ~39 of the hex's 48.5 flat width. */
      font-size: 22px;
      font-weight: 600;
      text-anchor: middle;
      dominant-baseline: central;
      fill: #6b4a2a;
      pointer-events: none;
      user-select: none;
    }
    .hex-number.on-panel {
      fill: rgba(255, 255, 255, 0.92);
    }
    /* Sitting on a unit plate instead of the bare board. */
    .hex-number.on-plate {
      fill: #ffd34d;
      stroke: rgba(0, 0, 0, 0.9);
      stroke-width: 3.5;
      paint-order: stroke;
    }

    .movement-arrow {
      stroke: #ffffff;
      stroke-width: 3;
      stroke-linecap: round;
      opacity: 0.9;
      pointer-events: none;
    }

    .movement-arrowhead {
      fill: #ffffff;
    }

    .opponent-movement-arrow {
      stroke: #f1c40f;
      stroke-width: 3;
      stroke-linecap: round;
      opacity: 0.9;
      pointer-events: none;
    }

    .opponent-movement-arrowhead {
      fill: #f1c40f;
    }

    /* Struck this turn (red) and struck last turn by the other side (purple).
       Same glyph, so a clash reads as a clash whoever swung. */
    .attack-sword,
    .opponent-attack-sword {
      font-size: 20px;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 3px;
    }

    .attack-sword { fill: #d63031; }

    /* The shot, in the same colour as the blades it stands in for. */
    .attack-line,
    .opponent-attack-line {
      stroke-width: 3;
      stroke-linecap: round;
      opacity: 0.9;
      filter: drop-shadow(0 0 2px #fff);
      pointer-events: none;
    }

    .attack-line { stroke: #d63031; }

    .opponent-attack-line { stroke: #8e44ad; }

    .opponent-attack-sword { fill: #8e44ad; }

    .kill-marker {
      fill: #d63031;
      font-size: 22px;
      font-weight: 900;
      font-family: Arial, sans-serif;
      text-anchor: middle;
      dominant-baseline: central;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 2px;
      pointer-events: none;
    }

    .opponent-kill-marker {
      fill: #6c3483;
      font-size: 20px;
      font-weight: 900;
      font-family: Arial, sans-serif;
      text-anchor: middle;
      dominant-baseline: central;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 2px;
      pointer-events: none;
    }

    /* The plate carries the side's colour; the icon takes the opposite one.
       Outlined in the board's own fill so it reads as a thin ring. */
    /* A unit that is done - its MOV spent, the turn's three movers used up
       without it, or its one move of the initialization already taken.
       Dimmed on the group, so the plate and the glyph fade together.

       Each side greys to its own grey rather than to the same fade. Opacity
       alone is not a colour: it made a spent white plate wash out into a pale
       panel while a spent black one only went mid-grey, so the same state
       read as two different things depending on whose unit it was. A light
       grey and a dark one keep a spent unit legible as the side it belongs
       to, and the group still fades so that spent still reads as spent. */
    /* Touched and moved this turn. Each panel gets three movers, so which
       ones have been started is worth reading off the plate rather than off
       the dot in its corner alone. Gold, the colour that dot already uses.
       The fill, not the stroke: the stroke belongs to selection and hover,
       and a mover that lit up the same way would read as selected. Before
       the spent rules below, so a mover with nothing left still greys. */
    .unit-pop.panel-walked .unit-plate.plate-white { fill: #f7dd93; }
    .unit-pop.panel-walked .unit-plate.plate-black { fill: #6b5518; }

    .unit-pop.panel-spent { opacity: 0.62; }
    .unit-pop.panel-spent .unit-plate.plate-white { fill: #b9bec4; }
    .unit-pop.panel-spent .unit-plate.plate-black { fill: #55595f; }

    /* The way onto the battlefield. Pale with a dark outline rather than one
       flat colour: the two reserve panels are light green and dark green, and
       a single fill legible on one disappears into the other. Not clickable -
       the hex under it still takes the pointer. */
    .gateway-arrow {
      fill: #f7f3e8;
      fill-opacity: 0.92;
      stroke: #16331f;
      stroke-width: 1.2;
      stroke-linejoin: round;
      pointer-events: none;
    }

    /* The opponent's, in the purple the board already uses for what the other
       side does. Yours stay the pale cream, so a glance at a panel says whose
       way in it is without reading which corner it sits in. */
    .gateway-arrow.arrow-theirs {
      fill: #b07cd6;
      stroke: #3d1f57;
    }

    /* The cross on a shut wrap. Red, and outlined in white the way the prices
       are, so it holds against both a panel and a unit's plate under it. */
    .gateway-shut {
      stroke: #b91c1c;
      stroke-width: 2.8;
      stroke-linecap: round;
      paint-order: stroke;
      pointer-events: none;
    }

    .unit-plate {
      stroke: #f0d9b5;
      stroke-width: 1;
      cursor: pointer;
    }

    .unit-plate.unit-buffed {
      animation: unit-buff-glow 1.2s ease-in-out infinite alternate;
    }

    .unit-plate.unit-debuffed {
      animation: unit-debuff-glow 1.2s ease-in-out infinite alternate;
    }

    .unit-plate.unit-both-effects {
      animation: unit-both-glow 1.2s ease-in-out infinite;
    }

    /* An ability landing on the unit swells it - or shrinks it, for something
       taken away - around its own centre rather than the SVG's. The swell
       itself is run from popUnit(); this is only where it turns. */
    .unit-pop {
      transform-box: fill-box;
      transform-origin: center;
    }


    @keyframes unit-buff-glow {
      from { filter: drop-shadow(0 0 2px #27ae60); }
      to { filter: drop-shadow(0 0 10px #2ecc71); }
    }

    @keyframes unit-debuff-glow {
      from { filter: drop-shadow(0 0 2px #c0392b); }
      to { filter: drop-shadow(0 0 10px #e74c3c); }
    }

    @keyframes unit-both-glow {
      0%, 49% { filter: drop-shadow(0 0 9px #2ecc71); }
      50%, 100% { filter: drop-shadow(0 0 9px #e74c3c); }
    }
    .plate-white { fill: #ffffff; }
    .plate-black { fill: #141414; }
    /* Selection greys the plate, whichever side it belongs to. */
    .plate-selected { fill: #9aa0a6 !important; }
    /* Whichever unit you are commanding: selected, or - once the turn is
       spent on it - the one that acted, which keeps the ring after you click
       another unit to read it. */
    .acting-ring {
      fill: none;
      pointer-events: none;
      stroke: #ffcc00;
      stroke-width: 3;
      animation: acting-glow 1.1s ease-in-out infinite alternate;
    }

    @keyframes acting-glow {
      from { stroke: #ffe680; filter: drop-shadow(0 0 2px #ffcc00); }
      to   { stroke: #ffae00; filter: drop-shadow(0 0 8px #ffc400); }
    }

    /* Hover just shadows it, so it reads as a preview and not a selection. */
    .plate-hovered {
      stroke: rgba(0, 0, 0, 0.55);
      stroke-width: 3;
      filter: brightness(0.86);
    }

    .piece-symbol {
      /* Fills what the labels leave: they sit on the corners and the flat
         sides, which leaves a box about 22 across and 26 tall in the middle.
         The plate is 25, so the face runs right up to the numbers. */
      font-size: 31px;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
    }

    .piece-white { fill: #141414; }
    .piece-black { fill: #ffffff; }
    /* Grey plate reads as light, so the glyph goes dark either way. */
    .piece-selected { fill: #141414 !important; }

    /* Stats sit ON the plate now that it fills most of the cell, so each one
       needs a light and a dark variant - a single colour cannot carry both a
       white and a near-black background. Halo flips with it. Readability of
       these numbers outranks everything else in the cell. */
    .stat {
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
      paint-order: stroke;
      stroke: rgba(255, 255, 255, 0.95);
      stroke-width: 2.5;
    }
    .stat.on-dark {
      stroke: rgba(0, 0, 0, 0.95);
    }

    /* What the trade would cost this unit, written over its face. Red for
       waving, so it never reads as the HP the unit actually has. */
    .damage-forecast {
      font-size: 17px;
      font-weight: 900;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
      paint-order: stroke;
      stroke: rgba(255, 255, 255, 0.95);
      stroke-width: 3;
      fill: #d63031;
      animation: stat-wave 1s ease-in-out infinite;
    }

    /* The blow coming back at us, in the same purple the board uses for
       everything the other side does. */
    .damage-forecast.counter {
      fill: #8e44ad;
    }

    /* A number that is off its printed value pulses out of its own ink and
       back. A lighter cast of that ink when the stat was lifted, not a march
       to white: the hex under it is pale, and white on pale is nothing at
       all - so saturation comes down first, because brightness alone hardly
       moves a colour whose strong channel is already at the top. Darker when
       the number is down, whether that is a stat dragged down or a wound;
       they say the same thing at different speeds. The single 50% stop is
       what keeps the starting colour the number's own. */
    .stat.wave-up { animation: wave-up 1.1s ease-in-out infinite; }
    @keyframes wave-up { 50% { filter: saturate(0.5) brightness(2.2); } }

    .stat.wave-down { animation: wave-dim 1.1s ease-in-out infinite; }
    .stat.wave-hurt { animation: wave-dim 1.4s ease-in-out infinite; }
    @keyframes wave-dim { 50% { filter: brightness(0.45); } }

    /* A unit that has spent an ability wears it on its face, pulsing to its
       own side's colour - white for white, black for black - and back to the
       ink the face is drawn in. */
    .piece-symbol.wave-acted-light { animation: wave-acted-light 1.2s ease-in-out infinite; }
    @keyframes wave-acted-light { 50% { fill: #ffffff; } }

    .piece-symbol.wave-acted-dark { animation: wave-acted-dark 1.2s ease-in-out infinite; }
    @keyframes wave-acted-dark { 50% { fill: #000000; } }

    /* Reach belonging to a unit whose MOV has been meddled with: the hexes
       themselves pulse, brighter for a boost and darker for a drag. Done with
       brightness rather than fill because the reach colours are !important,
       which a keyframe setting fill would lose to. */
    .hex-cell.reach-up { animation: reach-up 1.2s ease-in-out infinite; }
    @keyframes reach-up { 50% { filter: brightness(1.35); } }

    .hex-cell.reach-down { animation: reach-down 1.2s ease-in-out infinite; }
    @keyframes reach-down { 50% { filter: brightness(0.6); } }

    /* Whoever this trade kills shows through, the way a fallen unit does. */
    .doomed {
      opacity: 0.4;
    }
    @keyframes stat-wave {
      50% { opacity: 0.35; }
    }

    /* The unit that fell here, in its own colours and faded through. Not a
       piece: it takes no clicks, and the moment anything steps onto the hex
       the ghost is dropped rather than drawn beneath it. */
    .fallen {
      opacity: 0.4;
      pointer-events: none;
    }

    /* Over the face, because that is the unit this is about to happen to. */
    .kill-forecast {
      font-size: 26px;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
      paint-order: stroke;
      stroke: rgba(0, 0, 0, 0.9);
      stroke-width: 3.5;
      fill: #ff5555;
    }

    .vet-star {
      font-size: 12px;
      text-anchor: middle;
      dominant-baseline: central;
      fill: #ffd34d;
      stroke: rgba(0, 0, 0, 0.65);
      stroke-width: 2;
      paint-order: stroke;
      pointer-events: none;
    }
    // A dark halo vanishes into a black plate; go bright and ring it in white.
    .vet-star.on-dark {
      fill: #ffe066;
      stroke: rgba(255, 255, 255, 0.9);
    }

    .stat-hp { font-size: 16px; fill: #15803d; }
    .stat-atk { font-size: 15px; fill: #b91c1c; }
    .stat-def { font-size: 15px; fill: #1d4ed8; }

    /* Reach is a fact about the unit, not a number that moves - grey, and
       quiet. Move is yellow, and waves with whatever was done to it. */
    .stat-range { font-size: 15px; fill: #6b7280; }

    /* Which way the unit has been meddled with: green up, red down, and a
       dash in the numbers' own ink when it is neither. */
    .effect-arrow {
      font-size: 14px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
      paint-order: stroke;
      stroke: rgba(255, 255, 255, 0.95);
      stroke-width: 2.5;
      fill: #1f2937;
    }

    .effect-arrow.on-dark {
      stroke: rgba(0, 0, 0, 0.95);
      fill: #f1f5f9;
    }

    .effect-arrow.up, .effect-arrow.up.on-dark { fill: #22c55e; }
    .effect-arrow.down, .effect-arrow.down.on-dark { fill: #ef4444; }
    .stat-mov { font-size: 15px; fill: #e0a800; }

    .stat-hp.on-dark { fill: #4ade80; }
    .stat-atk.on-dark { fill: #f87171; }
    .stat-def.on-dark { fill: #7dd3fc; }
    .stat-range.on-dark { fill: #cbd5e1; }
    .stat-mov.on-dark { fill: #fcd34d; }

    .status-bar {
      /* Overlaid on the board rather than stacked below it - see .hex-board. */
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2;
      font-size: 14px;
      padding: 6px 12px;
      background: rgba(42, 42, 42, 0.9);
      border-radius: 6px;
      color: #e0e0e0;
      white-space: nowrap;
    }

    .my-turn {
      color: #66bb6a;
    }

    .timer-badge {
      margin-left: 8px;
      padding: 2px 8px;
      background: #444;
      border-radius: 4px;
      font-size: 13px;
    }
    .timer-low {
      background: #c62828;
      color: #fff;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

  `],
})
export class GameBoardComponent implements OnChanges, OnInit, OnDestroy {
  // -- Inputs ---------------------------------------------------------

  /** Current board state from server. */
  @Input() boardState: BoardState = {};
  /** Board radius from config. */
  @Input() radius = 11;
  /** Username of the current turn player. */
  @Input() currentTurn = '';
  /** Current turn number. */
  @Input() turnNumber = 0;
  /** This client's username. */
  @Input() username = '';
  /** This client's color ('white' | 'black'). */
  @Input() myColor: 'white' | 'black' | '' = '';
  /** End reason (or ''). */
  @Input() endReason = '';
  /** Whether input is enabled (it's my turn and game is active). */
  @Input() interactive = true;
  /** False once a move is staged: units can still be inspected, not driven. */
  @Input() canMove = true;
  /**
   * Whether the side to move has already spent its one battlefield move of
   * the initialization. Derived by the room from the move history, so it
   * survives a reload and reads the same for both players.
   */
  @Input() boardMoveSpent = false;

  /**
   * Battlefield hexes holding a unit that has already had its one move of
   * the initialization. The turn's allowance is fresh every turn; these are
   * not - a unit moves once for the whole opening.
   */
  @Input() initMoved: string[] = [];
  /**
   * Points the side to move has to spend. The wrap out of the base is bought
   * as well as walked, and a side that cannot pay is never shown the option.
   */
  @Input() movePoints = 0;

  /**
   * What the OTHER side has to spend. Only a preview reads it: looking at
   * one of their units prices its crossing against their purse, so the
   * struck-through price says what it would cost *them*.
   */
  @Input() theirPoints = 0;

  /**
   * Whether stepping out of the reserve is offered at all.
   *
   * The panels are the client's own - no engine has a reserve to take a unit
   * out of - so the only engine that can honour an entry is the one in this
   * browser. Offering it in a server game would stage a walk the server
   * rejects as "no piece at source coordinate".
   * ponytail: one predicate, to lift the day reserves live in the engine.
   */
  @Input() entryBind = false;

  /**
   * The board as the engine has it, without this turn's staged move.
   *
   * A crossing is sent before the turn's move - it has to be, because the
   * move is what ends the turn - so it is applied to a board where that move
   * has not happened yet. Plotting one onto a hex that the staged move only
   * appears to have cleared would hand the engine an entry it rejects, and
   * the unit would be lost between the two pictures. So a crossing treats
   * anything standing on either board as in the way.
   */
  @Input() committedBoard: Record<string, PieceData> = {};

  /**
   * Units that walked off the battlefield into a base, keyed by the hex they
   * stopped on. Derived by the room from the record of each withdrawal, so a
   * base rebuilds itself after a reload the way the battlefield does.
   */
  @Input() withdrawn: Array<{ at: string; unit: Record<string, any> }> = [];

  /**
   * Reserves that have crossed onto the battlefield, by uid. They are struck
   * out of the panel for good: a panel holds its dealt squad all game, so a
   * unit that crossed and was later killed would otherwise be drawn back in
   * its old hex, whole and ready to cross again.
   */
  @Input() departedUids: string[] = [];

  /**
   * What a reserve unit has left, by uid, for the ones that have been in a
   * fight. The panel is dealt from the roster on every rebuild, so a wound
   * taken there would heal itself; the room derives this from the record so
   * it reads the same after a reload.
   */
  @Input() panelHp: Record<string, number> = {};

  /** Steps the staged unit has left this turn, and which unit that is. */
  @Input() movesLeft: number | null = null;
  @Input() movesLeftFor: string | null = null;
  /**
   * One-turn stat boosts by hex. Only `mov` matters here - it widens the
   * flood fill for a unit that has not taken its first step yet, after which
   * `movesLeft` carries the same bonus.
   */
  @Input() unitBuffs: Record<string, {
    mov: number; atk?: number; def?: number; up?: boolean; down?: boolean;
  }> = {};
  /** Units that have spent an ability this turn, keyed by uid. */
  @Input() unitActed: Record<string, boolean> = {};
  /**
   * A committed turn, one beat at a time. A new list interrupts whatever is
   * still playing: the board is already showing the finished position, so
   * catching up is just dropping the beats nobody waited to see.
   */
  @Input() playback: AnimStep[] = [];
  /** Each beat as it starts, so the room can sound it and light its slot. */
  @Output() playbackStep = new EventEmitter<AnimStep>();
  /** Nothing left to play - the room starts its clock again. */
  @Output() playbackDone = new EventEmitter<void>();

  /** The unit in flight: a copy drawn over the board while its hex is empty. */
  mover: { points: string; symbol: string; dark: boolean; x: number; y: number } | null = null;
  /** Whose piece is hidden while the copy above stands in for it. */
  private moverHex = '';
  /** Hexes flashing a hit, and one glowing from an ability. */
  hitHex = '';
  glowHex = '';
  /** The glowing unit is being sapped rather than boosted. */
  glowHostile = false;
  /** This glow belongs to the end-of-turn recap, so it runs short. */
  private playing: Array<() => void> = [];
  private frame = 0;
  @Input() movementArrows: Array<{ from: string; to: string }> = [];
  @Input() attackMarkers: Array<{ from: string; to: string }> = [];
  @Input() opponentMovementArrows: Array<{ from: string; to: string }> = [];
  @Input() opponentAttackMarkers: Array<{ from: string; to: string }> = [];
  @Input() opponentKillMarkers: FallenUnit[] = [];
  /** Game config (for legal-move preview). */
  @Input() config: any = null;
  /** Overlay each battlefield hex with its reading-order number. */
  @Input() showNumbers = false;
  /** Solo play: this client drives both sides, not just its own colour. */
  @Input() controlAllSides = false;
  /** Rotate the rendered board for a solo player choosing Black. */
  @Input() rotateBoard = false;
  /** Colour of whoever's turn it is - what controlAllSides selects with. */
  @Input() turnColor: 'white' | 'black' | '' = '';
  /** Targeting mode for the selected scaffold ability. */
  @Input() abilityMode: 'friendly' | 'enemy' | null = null;
  /** Colour of the unit whose ability is being aimed. */
  @Input() abilityCasterColor: 'white' | 'black' | '' = '';

  // -- Outputs --------------------------------------------------------

  /** Emitted when the player makes a move: {from: "q,r", to: "q,r"}. */
  @Output() moveMade = new EventEmitter<{
    from: string; to: string; cost: number;
    /** What walking home into the base paid back, if it did. */
    refund?: number;
  }>();
  /** Emitted with the selected unit's details, or null when nothing is on it. */
  @Output() hexSelected = new EventEmitter<SelectedUnit | null>();
  /**
   * The same payload, but only when the player actually picked the unit.
   * `hexSelected` also fires when the board changes underneath a standing
   * selection, which must not read as a click - an ability waiting for a
   * target would fire itself on the opponent's move.
   */
  @Output() hexClicked = new EventEmitter<SelectedUnit | null>();
  /** Attack from `to` (where the unit stands) against the enemy on `attack`. */
  @Output() attackMade = new EventEmitter<{
    from: string; to: string; attack: string;
    /** Set when the blow lands in a panel - the unit no engine holds. */
    targetUnit?: PieceData;
    /** Whether that unit strikes back: a reserve does, a base does not. */
    counters?: boolean;
  }>();

  /** A unit crossed the wrap: what it cost, for the room to take off. */
  @Output() wrapCrossed = new EventEmitter<number>();
  /** Same payload for the hex under the cursor - a preview, not a selection. */
  @Output() hexHovered = new EventEmitter<SelectedUnit | null>();

  /**
   * A stat that is not what the unit was built with pulses: lifted in light
   * red, dragged down in dark red. Each number answers for itself, so a unit
   * with a boosted attack and a sapped defence shows both at once.
   */
  statWave(hex: HexCell, stat: 'atk' | 'def' | 'mov'): string {
    const moved = this.unitBuffs[this.uidOf(hex)]?.[stat] ?? 0;
    return moved > 0 ? 'wave-up' : moved < 0 ? 'wave-down' : '';
  }

  /**
   * Whether the reach on screen was lent or taken away: the hexes pulse with
   * it, so a boosted or sapped MOV is visible on the board itself and not
   * only in the unit panel.
   */
  get movWave(): string {
    const key = this.hoveredHex ?? this.selectedHex;
    const cell = key ? this.cellsByKey.get(key) : null;
    const mov = cell ? (this.unitBuffs[this.uidOf(cell)]?.mov ?? 0) : 0;
    return mov > 0 ? 'up' : mov < 0 ? 'down' : '';
  }

  /**
   * Up for a boost, down for a drag, and both stacked when the unit is under
   * the two at once - the plate's glow says something is on it, this says
   * which way.
   */
  effectArrows(hex: HexCell): Array<{ x: number; glyph: string; kind: string }> {
    const uid = this.uidOf(hex);
    const up = { glyph: '↑', kind: 'up' };
    const down = { glyph: '↓', kind: 'down' };
    const boosted = this.hasLift(uid);
    const dragged = this.hasDrag(uid);
    // Both stand side by side on the one line, up first. A unit with nothing
    // on it keeps the slot with a dash, so the row never looks half-drawn.
    if (boosted && dragged) return [{ x: hex.cx - 23, ...up }, { x: hex.cx - 15, ...down }];
    if (boosted) return [{ x: hex.cx - 19, ...up }];
    if (dragged) return [{ x: hex.cx - 19, ...down }];
    return [{ x: hex.cx - 19, glyph: '-', kind: 'none' }];
  }

  /**
   * Where a unit's veterancy pips go: all along the bottom, where nothing
   * else is drawn. One sits on the centre line, two straddle it, and three
   * make a triangle that narrows the way the hex does.
   */
  vetPips(hex: HexCell): Array<{ x: number; y: number; glyph: string }> {
    const { cx, cy } = hex;
    const star = '★';
    // Nothing earned yet still holds the slot, so the row reads as a rank of
    // zero rather than as a unit whose pips failed to draw.
    if (hex.vet <= 0) return [{ x: cx, y: cy + 19, glyph: '-' }];
    if (hex.vet === 1) return [{ x: cx, y: cy + 19, glyph: star }];
    if (hex.vet === 2) {
      return [{ x: cx - 7, y: cy + 19, glyph: star }, { x: cx + 7, y: cy + 19, glyph: star }];
    }
    return [
      { x: cx - 7, y: cy + 16, glyph: star },
      { x: cx + 7, y: cy + 16, glyph: star },
      { x: cx, y: cy + 25, glyph: star },
    ];
  }

  /**
   * The walk this unit has left. For the one being moved that is what the
   * staged step left it - the number counts down as it goes - and for
   * everything else its full budget, boost included.
   */
  movText(hex: HexCell): string {
    const pc = hex.piece;
    if (!pc) return '';
    if (hex.key === this.movesLeftFor && this.movesLeft != null) {
      return statText(twoDigits(this.movesLeft));
    }
    const base = this.config?.units?.[pc.unit_id]?.move ?? 0;
    const bonus = this.unitBuffs[this.uidOf(hex)]?.mov ?? 0;
    return statText(twoDigits(Math.max(0, base + bonus)));
  }

  /** Has spent an ability this turn - its face pulses to its own colour. */
  hasActed(hex: HexCell): boolean {
    return !!this.unitActed[this.uidOf(hex)];
  }

  /** Carrying damage it has not healed - its HP pulses until it does. */
  isWounded(hex: HexCell): boolean {
    const pc = hex.piece;
    return !!pc && !!pc.max_hp && pc.hp < pc.max_hp;
  }

  hasPositiveEffect(uid?: string): boolean {
    const effect = uid ? this.unitBuffs[uid] : undefined;
    return !!effect && [effect.mov, effect.atk, effect.def].some(value => (value ?? 0) > 0);
  }

  textTransform(cx: number, cy: number): string | null {
    return this.rotateBoard ? `rotate(180 ${cx} ${cy})` : null;
  }

  hasNegativeEffect(uid?: string): boolean {
    const effect = uid ? this.unitBuffs[uid] : undefined;
    return !!effect && [effect.mov, effect.atk, effect.def].some(value => (value ?? 0) < 0);
  }

  /**
   * Which way a unit has been pushed. The mark on the entry is what counts,
   * not the sign of the numbers: a boost and a drag that cancel out still
   * leave both marks, and a purely damaging cast leaves a drag with no
   * numbers at all.
   */
  hasLift(uid?: string): boolean {
    const effect = uid ? this.unitBuffs[uid] : undefined;
    return !!effect?.up || this.hasPositiveEffect(uid);
  }

  hasDrag(uid?: string): boolean {
    const effect = uid ? this.unitBuffs[uid] : undefined;
    return !!effect?.down || this.hasNegativeEffect(uid);
  }

  get movementArrowSegments(): Array<{ x1: number; y1: number; x2: number; y2: number }> {
    return this.movementArrows.flatMap(arrow => {
      const from = this.cellsByKey.get(arrow.from);
      const to = this.cellsByKey.get(arrow.to);
      return from && to && from.key !== to.key
        ? [{ x1: from.cx, y1: from.cy, x2: to.cx, y2: to.cy }]
        : [];
    });
  }

  get attackStrikes(): StrikeMarks {
    return this.strikeMarks(this.attackMarkers);
  }

  get opponentAttackStrikes(): StrikeMarks {
    return this.strikeMarks(this.opponentAttackMarkers);
  }

  /**
   * How a blow is drawn: crossed blades halfway between the two hexes - on
   * the shared edge when they touch - and, for anything struck from further
   * out, the shot's own path under them, edge to edge so neither face is
   * covered.
   */
  private strikeMarks(markers: Array<{ from: string; to: string }>): StrikeMarks {
    const marks: StrikeMarks = { swords: [], lines: [] };
    for (const marker of markers) {
      const from = this.cellsByKey.get(marker.from);
      const to = this.cellsByKey.get(marker.to);
      if (!from || !to) continue;
      marks.swords.push({ x: (from.cx + to.cx) / 2, y: (from.cy + to.cy) / 2 });
      if (hexDistanceKeys(marker.from, marker.to) <= 1) continue;
      const dx = to.cx - from.cx, dy = to.cy - from.cy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = (dx / len) * HEX_INRADIUS, uy = (dy / len) * HEX_INRADIUS;
      marks.lines.push({
        x1: from.cx + ux, y1: from.cy + uy,
        x2: to.cx - ux, y2: to.cy - uy,
      });
    }
    return marks;
  }

  @Input() killMarkers: FallenUnit[] = [];

  get killMarkerPositions(): FallenDrawing[] {
    return this.fallenDrawings(this.killMarkers);
  }

  /**
   * A unit that died where it stood, drawn as it was and faded out, for as
   * long as the hex stays empty. Anything that walks onto the hex is the
   * board's truth, so the ghost goes rather than being drawn under it.
   */
  private fallenDrawings(fallen: FallenUnit[]): FallenDrawing[] {
    return fallen.flatMap(unit => {
      const cell = this.cellsByKey.get(unit.key);
      if (!cell || cell.piece) return [];
      return [{
        x: cell.cx,
        y: cell.cy,
        points: cell.innerPoints,
        symbol: this.getPieceSymbol({ unit_id: unit.unit_id, color: unit.color } as PieceData),
        // Its own numbers, unbuffed - whatever it was carrying died with it.
        atk: attackCellText(unit.unit_id, this.config),
        def: twoDigits(this.config?.units?.[unit.unit_id]?.defense),
        mov: twoDigits(this.config?.units?.[unit.unit_id]?.move),
        rangeLow: RANGE_LOW,
        rangeHigh: rangeHigh(unit.unit_id, this.config),
        dark: unit.color === 'black',
      }];
    });
  }

  get opponentMovementArrowSegments(): Array<{ x1: number; y1: number; x2: number; y2: number }> {
    return this.lineSegments(this.opponentMovementArrows);
  }

  get opponentKillMarkerPositions(): FallenDrawing[] {
    return this.fallenDrawings(this.opponentKillMarkers);
  }

  private lineSegments(lines: Array<{ from: string; to: string }>): Array<{ x1: number; y1: number; x2: number; y2: number }> {
    return lines.flatMap(line => {
      const from = this.cellsByKey.get(line.from);
      const to = this.cellsByKey.get(line.to);
      return from && to ? [{ x1: from.cx, y1: from.cy, x2: to.cx, y2: to.cy }] : [];
    });
  }

  // -- Internal state -------------------------------------------------

  cells: HexCell[] = [];
  /**
   * Same cells, by key. Every overlay resolves hexes by key, several times
   * per entry, and the game room's clock drives change detection four times
   * a second - a linear scan of ~800 cells per lookup adds up fast.
   */
  private cellsByKey = new Map<string, HexCell>();
  viewBox = '0 0 100 100';

  selectedHex: string | null = null;
  legalTargets = new Set<string>();
  /** Enemies the selected unit can hit from where it stands. */
  attackTargets = new Set<string>();
  /** Step cost of each legal destination, for charging the move budget. */
  private moveCosts = new Map<string, number>();
  /** Which hexes make up each corner panel, keyed 'bl' | 'br' | 'tr' | 'tl'. */
  private panelZones = new Map<string, Set<string>>();
  /**
   * Units waiting in the corner panels: red and light green are white's, dark
   * red and dark green are black's. Client-side only - the server's board is
   * the radius-N battlefield and rejects anything outside it, and how a
   * reserve enters play is still to be designed. Until then they are confined
   * to their own panel: they shuffle inside it and can neither move nor
   * strike out of it, and nothing on the board can strike into it.
   * ponytail: not persisted and not sent anywhere; a reload re-deals them.
   */
  private reserves: Record<string, PieceData> = {};
  private reservesKey = '';
  /** Board plus reserves - what the flood fill treats as occupied. */
  private occupancy: BoardState = {};
  /**
   * What bounds the strike overlay, per side: every hex the board draws,
   * less that side's OWN panels. Reach is limited by the grid on screen
   * rather than by the hexagon inside it - but painting a side's range over
   * its own base and reserve says nothing, because nothing of theirs will
   * ever be standing in it.
   */
  private strikeBounds: Record<'white' | 'black', Set<string>> = {
    white: new Set(), black: new Set(),
  };
  /** Reach of whatever unit is being shown - hover first, else the selection. */
  previewMoves = new Set<string>();
  previewAttacks = new Set<string>();
  /**
   * The crossings for whatever is being looked at rather than driven: the
   * wrap out of a base, the way home, the way onto the board, and a wrap
   * nobody can pay for. Same four things `refreshTargets` works out for the
   * unit you may move - these are for the one you may only look at, which
   * includes every one of theirs.
   */
  previewWrap = new Map<string, number>();
  previewDenied = new Map<string, number>();
  previewRefund = new Map<string, number>();
  previewEntry = new Set<string>();
  private previewKey: string | null = null;
  lastDamagedHex = '';  // hex that was attacked but unit survived

  constructor(private cdr: ChangeDetectorRef, private host: ElementRef<HTMLElement>) {}

  get isMyTurn(): boolean {
    return this.currentTurn === this.username;
  }

  /** Which side this client may pick up right now. */
  get activeColor(): 'white' | 'black' | '' {
    return this.controlAllSides ? this.turnColor : this.myColor;
  }

  // -- Lifecycle ------------------------------------------------------

  ngOnInit(): void {
    // Nothing to start: the clock lives in the game room's header.
  }

  ngOnDestroy(): void {
    this.stopPlayback();
    clearTimeout(this.markTimer);
  }

  /** Drop everything mid-flight and leave the board on the real position. */
  private stopPlayback(): void {
    // Bumped here rather than in runPlayback: cancelling a promise resolves
    // it, it does not unwind the chain waiting on it, so an interrupted
    // attack would go on to lunge again over the top of whatever replaced it.
    // The token is what the chain checks between beats.
    this.playbackToken++;
    for (const cancel of this.playing) cancel();
    this.playing = [];
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.mover = null;
    this.moverHex = '';
    this.hitHex = '';
    this.glowHex = '';
  }

  /** The hex a flying copy stands in for: its own piece is not drawn. */
  isMoving(key: string): boolean {
    return !!this.mover && this.moverHex === key;
  }

  private async runPlayback(steps: AnimStep[]): Promise<void> {
    this.stopPlayback();
    const token = this.playbackToken;
    for (const step of steps) {
      if (token !== this.playbackToken) return;   // a newer turn took over
      this.playbackStep.emit(step);
      await this.playStep(step);
      // A beat ends by clearing the class its animation hangs on, and the next
      // sets it again in the same task - so the browser never saw it off and
      // never restarted the animation. Three casts on one unit read as a
      // single long swell. This gap is the frame in between.
      if (token !== this.playbackToken) return;
      await this.wait(BEAT_GAP_MS);
    }
    if (token !== this.playbackToken) return;
    // Last of all, after every beat the turn itself had.
    await this.settleUpkeep();
    if (token !== this.playbackToken) return;
    this.stopPlayback();
    this.cdr.markForCheck();
    this.playbackDone.emit();
  }

  private playbackToken = 0;

  private async playStep(step: AnimStep): Promise<void> {
    const token = this.playbackToken;
    const from = this.cellsByKey.get(step.from);
    const to = this.cellsByKey.get(step.to);

    // An ability is a shine and a noise: on the unit, on the slot that cast
    // it, or on both. A universal one names no hex and shines in the panel
    // alone, so it still has to take its beat rather than be skipped.
    // Taking an ability up is its own moment: nothing on the board, a flash
    // on the slot it landed in.
    if (step.kind === 'pick') return this.wait(PICK_MS);
    if (step.kind === 'ability') {
      const ms = step.brief ? GLOW_BRIEF_MS : GLOW_MS;
      // Driven on the element rather than through a CSS class: a class only
      // restarts an animation if the browser renders a frame with it off, and
      // between two beats there is no such frame to rely on - three casts on
      // one unit read as a single long swell. animate() always starts over.
      this.popUnit(step.to, !!step.hostile, ms);
      if (!to) return this.wait(ms);
      this.glowHostile = !!step.hostile;
      return this.flash('glowHex', step.to, ms);
    }
    if (!from || !to) return Promise.resolve();

    switch (step.kind) {
      case 'move':
        return this.slide(to, from, to, MOVE_MS);
      case 'attack':
      case 'counter': {
        // A lunge, not a walk: part way in and back, then the hex it landed on
        // flashes. The counter is the same beat with the two ends swapped.
        const lunge = { cx: from.cx + (to.cx - from.cx) * 0.45, cy: from.cy + (to.cy - from.cy) * 0.45 };
        await this.slide(from, from, lunge, STRIKE_MS);
        if (token !== this.playbackToken) return;
        await this.slide(from, lunge, from, STRIKE_MS);
        if (token !== this.playbackToken) return;
        await this.flash('hitHex', step.to, HIT_MS);
      }
    }
  }

  /**
   * Swell the unit on `key` - or shrink it, for something being taken away.
   * Silent when the hex holds nobody: a universal ability names no hex, and
   * its beat is the panel's alone.
   */
  private popUnit(key: string, hostile: boolean, ms: number, tint?: string): void {
    const el = key
      ? this.host.nativeElement.querySelector<SVGGElement>(`[data-pop="${key}"]`)
      : null;
    if (!el?.animate) return;
    const peak = hostile ? 0.55 : 1.55;
    const glow = tint ?? (hostile ? '#b07cd6' : '#ffe066');
    el.animate([
      { transform: 'scale(1)', filter: 'drop-shadow(0 0 0 transparent)' },
      { transform: `scale(${peak})`, filter: `drop-shadow(0 0 10px ${glow})`, offset: 0.45 },
      { transform: 'scale(1)', filter: 'drop-shadow(0 0 0 transparent)' },
    ], { duration: ms, easing: 'ease-in-out' });
  }

  /** Hold the sequence for a beat that has nothing on the board to show. */
  private wait(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms);
      this.playing.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  /** Walk a copy of the unit on `cell` from one point to another. */
  private slide(
    cell: HexCell,
    start: { cx: number; cy: number },
    end: { cx: number; cy: number },
    ms: number,
  ): Promise<void> {
    const piece = cell.piece;
    if (!piece) return Promise.resolve();
    this.moverHex = cell.key;
    return new Promise<void>(resolve => {
      const began = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - began) / ms);
        this.mover = {
          points: cell.innerPoints,
          symbol: this.getPieceSymbol(piece),
          dark: piece.color === 'black',
          // The copy is drawn at the hex's own coordinates and pushed by a
          // translate, so one set of points serves the whole flight.
          x: start.cx + (end.cx - start.cx) * t - cell.cx,
          y: start.cy + (end.cy - start.cy) * t - cell.cy,
        };
        this.cdr.markForCheck();
        if (t < 1) { this.frame = requestAnimationFrame(tick); return; }
        this.mover = null;
        this.moverHex = '';
        this.cdr.markForCheck();
        resolve();
      };
      this.playing.push(() => resolve());
      this.frame = requestAnimationFrame(tick);
    });
  }

  private flash(field: 'hitHex' | 'glowHex', key: string, ms: number): Promise<void> {
    this[field] = key;
    this.cdr.markForCheck();
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this[field] = '';
        this.cdr.markForCheck();
        resolve();
      }, ms);
      this.playing.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Recalculate cells whenever board, radius, or config (orientation) changes
    // myColor with them: it decides which set of home rows is drawn as ours.
    if (changes['boardState'] || changes['radius'] || changes['config']
        || changes['unitBuffs'] || changes['myColor']
        || changes['withdrawn'] || changes['departedUids'] || changes['committedBoard']
        || changes['panelHp']) {
      this.buildCells();
    }
    // A move ends the ability to move again, but the selection itself sticks
    // until another unit is clicked - the Unit panel stays pinned to it.
    if (changes['turnNumber'] && !changes['turnNumber'].firstChange) {
      this.clearTargets();
      // Each side's allowance is its own, and turnNumber counts plies - so a
      // new ply hands whoever is up next their panels' full MOV and three
      // fresh movers each. Only the active colour is ever offered a panel
      // move, so clearing both sides at once cannot lend anyone a turn.
      //
      // Through the initialization a unit gets one move for the whole phase,
      // so what walked this ply is locked before the allowances reset. The
      // moment the phase is over the locks go with it.
      if (this.initializing) {
        for (const uid of this.panelMoved.keys()) this.lockedUnits.add(uid);
      } else {
        this.lockedUnits.clear();
      }
      this.panelMoved.clear();
      this.baseMovers.clear();
      this.reserveMovers.clear();
      // A turn's walks are only takeable back inside that turn, and its
      // crossings have reached the engine by now - the board they arrive on
      // is the one that draws them from here.
      this.panelHistory = [];
      this.entered = {};
      // The rebuild above ran while these still hid their panel hexes, so the
      // cells describe a board that is now one update out of date.
      this.buildCells();
      this.markOvertimeToll(
        changes['turnNumber'].previousValue, changes['turnNumber'].currentValue);
    }
    // The board just changed underneath the selection: re-read the stats from
    // the new cell so a piece that moved keeps its panel, and drop a selection
    // whose unit is gone.
    if (changes['boardState'] && this.selectedHex) {
      const cell = this.cellsByKey.get(this.selectedHex);
      if (!cell?.piece) this.selectedHex = null;
      this.hexSelected.emit(cell?.piece ? this.describe(cell) : null);
    }
    // A boost landing mid-turn widens the reach of a unit already selected.
    if (changes['boardState'] || changes['config'] || changes['radius'] || changes['unitBuffs']) {
      this.invalidatePreview();
      // A staged step moved the unit: its remaining reach moved with it.
      this.refreshTargets();
    }
    // Last, and deliberately: a staged step arrives as a new board and a new
    // step list in the same pass, and the flying copy is read out of the
    // rebuilt cells. Playing before the rebuild found the unit still on the
    // hex it had left, and animated nothing.
    if (changes['playback']) {
      const steps = this.playback;
      // Started *after* this change-detection pass, not inside it. The runner
      // announces each beat as it begins and the room answers by lighting the
      // slot that cast it - but the room's own view was checked before this
      // child's, so that flag went up and came down again inside one task and
      // never rendered. A staged cast is exactly one beat, which is why it
      // only ever showed on the multi-beat end-of-turn recap.
      // setTimeout, not queueMicrotask: zone.js does not patch the latter, so
      // the whole run - every beat, every timer inside it - escaped Angular's
      // zone and nothing triggered change detection. The classes the
      // animations hang on then only changed when some other event happened
      // to run a pass, which merged consecutive beats into one long swell.
      // Cancelled here rather than inside runPlayback: the new run starts on
      // a timer, and until it does, a chain still waiting between beats holds
      // a live token. It would finish in that gap and announce a completion
      // for a sequence that had already been replaced - which the room reads
      // as the recap being over, unlocking the board as the recap begins.
      this.stopPlayback();
      if (steps.length) setTimeout(() => { if (this.playback === steps) this.runPlayback(steps); });
    }
    // A turn that had nothing to replay still settles up - a passed turn
    // mends the base, and overtime takes its toll either way. `playback` is
    // only ever set to a non-empty list, so no new recap arriving is exactly
    // the case where nothing else is going to pay this.
    if (this.pendingUpkeep.size && !changes['playback']) {
      setTimeout(() => this.settleUpkeep());
    }
  }

  // -- Click handler --------------------------------------------------

  onHexClick(hex: HexCell): void {
    this.handleClick(hex);
    // Any branch above may have moved the selection, and the preview follows it.
    this.invalidatePreview();
  }

  private handleClick(hex: HexCell): void {
    if (!this.interactive || this.endReason) {
      return;
    }
    // An armed offensive ability takes the next unit click as its target,
    // rather than allowing the regular attack-selection path to intercept it.
    if (this.abilityMode === 'enemy' && hex.piece) {
      this.emitSelected(hex);
      return;
    }
    // Clicking a unit always inspects it. Driving one additionally needs the
    // turn (unless we hold both sides) and a move still to spend.
    // Driving both sides means "my turn" is irrelevant - the active colour is.
    const canDrive = this.canMove && (this.controlAllSides || this.isMyTurn);

    // If clicking a legal target -> emit the move
    // An enemy inside reach: swing at it. That spends the unit's turn, so it
    // goes out immediately instead of staging like a move does.
    if (this.selectedHex && this.attackTargets.has(hex.key)) {
      // A blow landing in a panel carries the unit it lands on: no engine
      // holds a panel, so that is the only way to name it. Whether it answers
      // is the panel's rule and travels with it - a reserve strikes back, a
      // base does not.
      this.attackMade.emit({
        from: this.selectedHex, to: this.selectedHex, attack: hex.key,
        ...(hex.panel && hex.piece
          ? { targetUnit: hex.piece, counters: !BASE_PANELS.has(hex.panel) }
          : {}),
      });
      this.clearTargets();
      return;
    }

    if (this.selectedHex && this.legalTargets.has(hex.key)) {
      if (this.reserves[this.selectedHex]) {
        // Onto the battlefield is a board move and goes to the engine.
        // Anywhere else is a shuffle inside the panel, which does not: it
        // never reaches a server that has no panel to move it in.
        if (hex.filler) this.moveReserve(this.selectedHex, hex.key);
        else this.enterBoard(this.selectedHex, hex.key);
        return;
      }
      const refund = this.refundTargets.get(hex.key);
      this.moveMade.emit({
        from: this.selectedHex,
        to: hex.key,
        // What the walk actually costs, detours included.
        cost: this.moveCosts.get(hex.key) ?? 1,
        ...(refund ? { refund } : {}),
      });
      // The selection rides along to the destination so its stats stay pinned.
      this.selectedHex = hex.key;
      this.clearTargets();
      return;
    }

    // Any unit can be selected: it highlights and pins to the Unit panel. Only
    // one we're allowed to drive gets a legal-move preview - an enemy, or any
    // unit once the turn's move is spent, is inspect-only.
    if (hex.piece) {
      this.selectedHex = hex.key;
      this.emitSelected(hex);
      this.refreshTargets(canDrive);
      return;
    }

    // If clicking elsewhere while selected and it's not a legal target, deselect
    if (this.selectedHex) {
      if (hex.key !== this.selectedHex) {
        // If we have legal targets computed, only move to legal targets (already handled above).
        // If no legal targets were computed (no config), submit anyway (server validates).
        if (canDrive && !hex.filler && this.legalTargets.size === 0 && !this.config) {
          this.moveMade.emit({ from: this.selectedHex, to: hex.key, cost: 1 });
        }
        this.selectedHex = null;
        this.clearTargets();
        this.hexSelected.emit(null);
        return;
      }
      // Clicking same hex deselects
      this.selectedHex = null;
      this.clearTargets();
      this.hexSelected.emit(null);
    }
  }

  // -- Cell building --------------------------------------------------

  /**
   * The five capture zones, and who is holding what inside them. The shapes
   * and the claims both come from hex-rules, because the room scores exactly
   * what is drawn here - two answers to that would be one answer too many.
   *
   * ponytail: client-side, like points and abilities. The server does not
   * know a zone from any other hex yet.
   */
  private assignZones(): void {
    const zone = captureZoneHexes(this.radius);
    for (const cell of this.cells) {
      if (!cell.filler && zone.has(cell.key)) cell.zoneClass = 'zone';
    }
    this.captureClaim = captureClaims(this.boardState, this.radius);
  }

  /** Which side holds each capture hex; missing means nobody, or cancelled. */
  captureClaim = new Map<string, 'white' | 'black'>();

  /**
   * The arrow on a hex: a triangle pushed out to the edge it points at, so it
   * still shows around the plate of a unit standing there rather than hiding
   * underneath it.
   *
   * Pointy-top hexes are flat on the left and right, and that flat sits at
   * HEX_INRADIUS, so 17 out with a half-width of 7 leaves a sideways head
   * inside the cell. Up and down run at the corners instead, where the hex
   * narrows to a point, so they sit closer in.
   */
  arrowPoints(hex: HexCell): string {
    if (hex.gateway === 'up' || hex.gateway === 'down') {
      const dir = hex.gateway === 'up' ? -1 : 1;
      const y = hex.cy + dir * 14;
      return `${hex.cx},${y + dir * 7} ${hex.cx - 8},${y - dir * 6} ${hex.cx + 8},${y - dir * 6}`;
    }
    const dir = hex.gateway === 'left' ? -1 : 1;
    // Which edge it waits on, which is not always the one it points at.
    const x = hex.cx + (hex.arrowBack ? -dir : dir) * 17;
    return `${x + dir * 7},${hex.cy} ${x - dir * 7},${hex.cy - 8} ${x - dir * 7},${hex.cy + 8}`;
  }

  /**
   * The two ends of each side's wrap, and the way each is marked: out of the
   * base points up, into the reserve points down.
   *
   * Assigned by colour and drawn in board space, so the pair is mirrored for
   * the other side - and a solo game as black turns the whole board, which
   * turns these with it. Whoever is sitting there reads their own base tip as
   * the one pointing up and away, and the opponent's as the reverse.
   */
  private wrapMarks(): Map<string, {
    dir: 'up' | 'down'; color: 'white' | 'black'; out?: boolean;
  }> {
    const marks = new Map<string, {
      dir: 'up' | 'down'; color: 'white' | 'black'; out?: boolean;
    }>();
    for (const color of ['white', 'black'] as const) {
      const tips = this.wrapTips(color);
      // `out` is the end the crossing leaves from, which is the only one the
      // schedule can shut - the far tip is where it arrives.
      marks.set(tips.base, { dir: color === 'white' ? 'up' : 'down', color, out: true });
      marks.set(tips.reserve, { dir: color === 'white' ? 'down' : 'up', color });
    }
    return marks;
  }

  /**
   * Whether the wrap is open this turn. Both sides' at once: it is a point on
   * the schedule, not something either player holds.
   */
  get wrapOpen(): boolean {
    return isWrapOpen(this.turnNumber);
  }

  /**
   * The cross over a shut wrap's arrow, centred on the arrowhead. Struck out
   * rather than taken away: an arrow that vanished for five turns and came
   * back would read as the board losing a feature, not as a closed window.
   */
  arrowCross(hex: HexCell): string {
    const dir = hex.gateway === 'down' ? 1 : -1;
    const y = hex.cy + dir * 14;
    const s = 9;
    return `M${hex.cx - s},${y - s} L${hex.cx + s},${y + s}`
         + ` M${hex.cx + s},${y - s} L${hex.cx - s},${y + s}`;
  }

  /** Whose an arrow is, from this client's seat. */
  private arrowSideOf(color: 'white' | 'black'): 'mine' | 'theirs' {
    return color === (this.myColor || 'white') ? 'mine' : 'theirs';
  }

  /**
   * Whose setup rows a row belongs to: the three nearest each edge, which on
   * the shipped board is up to and including the pawn wall (white fills
   * r = 11, 10, 9 and black the mirror - see `setup` in config.service.ts).
   *
   * Read off the radius rather than off the placement, because the tint marks
   * the ground a side deploys onto: that is still its ground on a config that
   * leaves some of those hexes empty. The seat decides which of the two is
   * the player's own, defaulting to white for a client without one.
   */
  private homeOf(r: number): 'mine' | 'theirs' | '' {
    const edge = Math.max(1, this.radius - 2);
    if (Math.abs(r) < edge) return '';
    return (r >= edge ? 'white' : 'black') === (this.myColor || 'white') ? 'mine' : 'theirs';
  }

  /** Board orientation from config (cosmetic); the default board is edge-up. */
  get orientation(): BoardOrientation {
    return this.config?.board?.orientation === 'vertex-up' ? 'vertex-up' : 'edge-up';
  }

  private buildCells(): void {
    const r = this.radius;
    const orientation = this.orientation;
    // Shared with hexNumberMap(), so the numbers drawn here are the same ones
    // the game room quotes in move history.
    const coords = gridCoords(r, orientation);
    // Every arrow in one map - three out of each reserve, three on each base,
    // and the two ends of each side's wrap. They never share a hex.
    const arrows = new Map<string, {
      dir: 'left' | 'right' | 'up' | 'down'; color: 'white' | 'black';
      back?: boolean; out?: boolean;
    }>([...gatewayHexes(r), ...baseGatewayHexes(r), ...this.wrapMarks()]);

    // Panels first: the reserves that live in them decide what the cells hold.
    this.panelZones = new Map();
    for (const c of coords) {
      if (c.onBattlefield) continue;
      const panel = panelOf(c.x, c.y);
      let zone = this.panelZones.get(panel);
      if (!zone) this.panelZones.set(panel, zone = new Set<string>());
      zone.add(`${c.q},${c.r}`);
    }
    this.buildReserves();
    this.woundReserves();
    this.absorbWithdrawn();
    // A reserve that has stepped onto the battlefield is no longer in its
    // panel: `departedUids` says so from the record of the crossing, and a
    // crossing still staged says so from the overlay it is drawn in. Reading
    // it off the live board instead would put a unit back the moment it died.
    const gone = new Set<string>(this.departedUids);
    for (const piece of Object.values(this.entered)) {
      if (piece?.uid) gone.add(piece.uid);
    }
    const inPanels: Record<string, PieceData> = {};
    for (const [at, piece] of Object.entries(this.reserves)) {
      if (!gone.has(piece.uid ?? '')) inPanels[at] = piece;
    }
    // A withdrawal still being staged is on the board it was staged onto,
    // under a panel key - it only joins the base proper once it commits and
    // the room re-derives it (see absorbWithdrawn).
    for (const [at, piece] of Object.entries(this.boardState)) {
      const [bq, br] = at.split(',').map(Number);
      if (piece && !isInsideBoard(bq, br, this.radius)) inPanels[at] = piece;
    }
    this.occupancy = { ...this.boardState, ...this.entered, ...inPanels };

    this.cells = coords.map((c, i) => {
      const key = `${c.q},${c.r}`;
      const piece = (c.onBattlefield
        ? this.entered[key] ?? this.boardState[key]
        : inPanels[key]) || null;
      const def = piece ? this.config?.units?.[piece.unit_id] : null;
      return {
        q: c.q,
        r: c.r,
        key,
        cx: c.x,
        cy: c.y,
        points: hexPoints(c.x, c.y, orientation),
        innerPoints: hexPoints(c.x, c.y, orientation, PLATE_SIZE),
        piece,
        stats: piece
          ? {
              hp: twoDigits(piece.hp),
              atk: attackCellText(piece.unit_id, this.config, this.unitBuffs[piece.uid ?? '']?.atk ?? 0),
              def: twoDigits(def?.defense),
              rangeLow: RANGE_LOW,
              rangeHigh: rangeHigh(piece.unit_id, this.config),
            }
          : null,
        // Keyed on the unit, not the hex: veterancy that changed every time
        // a unit walked would flicker the ability slots it gates.
        vet: piece ? placeholderVet(piece.uid ?? key, piece.unit_id) : 0,
        filler: !c.onBattlefield,
        panel: c.onBattlefield ? '' : panelOf(c.x, c.y),
        // Four panels around the hexagon, one per corner.
        zoneClass: c.onBattlefield ? '' : `hex-filler panel-${panelOf(c.x, c.y)}`,
        home: c.onBattlefield ? this.homeOf(c.r) : '',
        gateway: c.onBattlefield ? '' : arrows.get(key)?.dir ?? '',
        arrowSide: c.onBattlefield || !arrows.has(key)
          ? '' : this.arrowSideOf(arrows.get(key)!.color),
        arrowBack: !c.onBattlefield && !!arrows.get(key)?.back,
        wrapOut: !c.onBattlefield && !!arrows.get(key)?.out,
        num: i + 1,
      };
    });

    this.cellsByKey = new Map(this.cells.map(c => [c.key, c]));
    this.strikeBounds = { white: new Set(), black: new Set() };
    for (const cell of this.cells) {
      // A panel belongs to the side whose corner it is - the same reading
      // buildReserves deals by.
      const owner = cell.panel ? (cell.panel[0] === 'b' ? 'white' : 'black') : '';
      if (owner !== 'white') this.strikeBounds.white.add(cell.key);
      if (owner !== 'black') this.strikeBounds.black.add(cell.key);
    }
    this.assignZones();

    if (this.cells.length > 0) {
      const xs = this.cells.map(c => c.cx);
      const ys = this.cells.map(c => c.cy);
      const pad = VIEWBOX_PADDING;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      const w = Math.max(...xs) + pad - minX;
      const h = Math.max(...ys) + pad - minY;
      this.viewBox = `${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
    }
  }

  /**
   * Deal each panel a placeholder squad, once. Re-dealt only if the roster or
   * the board geometry changes, so a reserve that has been shuffled around
   * its panel stays where it was put.
   */
  private buildReserves(): void {
    const roster = Object.entries(this.config?.units ?? {})
      // The commander belongs on the board; losing it is how a side loses.
      .filter(([, d]: [string, any]) => !d?.commander)
      .slice(0, 5);
    const stamp = `${this.radius}|${this.orientation}|${roster.map(([id]) => id).join(',')}`;
    if (stamp === this.reservesKey) return;
    this.reservesKey = stamp;
    this.reserves = {};
    if (!roster.length) return;

    for (const [panel, hexes] of this.panelZones) {
      const color: 'white' | 'black' = panel[0] === 'b' ? 'white' : 'black';
      // Every third hex, spread out with room to shuffle - but black's panels
      // are walked backwards. Reading order runs top to bottom, so taking the
      // first spots from it deals the two sides different shapes: white's
      // squad lands on its own wrap tip while black's lands at the far end of
      // its base, ten hexes from anything. Black's panels are the point
      // mirror of white's, so reversing deals the mirror image and both sides
      // open with the same reach.
      // The wrap's corridor is never dealt on. Each tip is a cul-de-sac with
      // exactly one hex of its own panel leading in - every other neighbour
      // is battlefield, which a panel unit may not cross - so a unit on
      // either the tip or its doorway shuts the crossing for the whole
      // panel: nothing reaches the base tip, or nothing lands past the
      // reserve one. A reload re-deals that blockage as fast as it is
      // shuffled away, which is why it is kept clear here rather than left
      // to the player.
      const corridor = this.wrapCorridor(color);
      const order = (color === 'black' ? [...hexes].reverse() : [...hexes])
        .filter(hex => !corridor.has(hex));
      const spots = order.filter((_, i) => i % 3 === 0);
      roster.forEach(([id, def]: [string, any], i) => {
        const at = spots[i];
        if (!at) return;
        const hp = def?.hp ?? 1;
        const uid = `r${panel}${i}`;
        // A wound taken in the reserve outlives the deal it was dealt in, and
        // nothing at 0 is dealt at all - that is what killed in a panel means.
        const left = this.panelHp[uid] ?? hp;
        if (left <= 0) return;
        this.reserves[at] = { unit_id: id, color, hp: left, max_hp: hp, uid };
      });
    }
  }

  /**
   * What the panels have taken, over whoever is standing in them.
   *
   * The deal applies this too - but the deal happens *once*. It is skipped
   * whenever the roster and the geometry are unchanged, which is what lets a
   * reserve shuffled around its panel stay where it was put, and that skip
   * used to take the wounds with it: a blow into a panel was recorded,
   * derived, handed to the board as `panelHp` - and then never drawn. A
   * reserve looked untouched however often it was hit, until a reload dealt
   * the panel again and the wound appeared out of nowhere.
   *
   * So it is applied here as well, on every rebuild, where the skip cannot
   * reach it. Base units are dealt with after this by `absorbWithdrawn()`,
   * which is the authority on them: their HP has mending on top of the wound.
   */
  private woundReserves(): void {
    for (const [at, piece] of Object.entries(this.reserves)) {
      const left = piece.uid ? this.panelHp[piece.uid] : undefined;
      if (left === undefined || left === piece.hp) continue;
      // Nothing on 0 is left standing: killed in a panel is killed.
      if (left <= 0) delete this.reserves[at];
      else this.reserves[at] = { ...piece, hp: left };
    }
  }

  /**
   * Units that have come home join the base as ordinary panel units - they
   * shuffle, spend MOV and grey out like anything else in a panel.
   *
   * Merged by uid, not by hex: the room re-derives this from the history
   * every turn, which is how mending survives a reload, so a unit already
   * standing here is updated where it stands rather than dealt a second time
   * on the hex it first landed on.
   */
  private absorbWithdrawn(): void {
    const standing = new Map<string, string>();
    for (const [at, piece] of Object.entries(this.reserves)) {
      if (piece.uid) standing.set(piece.uid, at);
    }
    for (const { at: landing, unit } of this.withdrawn) {
      const here = unit['uid'] ? standing.get(unit['uid']) : undefined;
      if (here) {
        // What it has mended since the last look is the +1 it is owed -
        // paid at the end of the turn's animation, not here.
        if (unit['hp'] > (this.reserves[here].hp ?? 0)) this.oweMark(unit['uid'], '+1');
        this.reserves[here] = { ...this.reserves[here], hp: unit['hp'] };
        continue;
      }
      // Its landing hex, or - if something has since been shuffled onto it -
      // the first free hex of the same panel, so a unit is never dropped for
      // want of somewhere to stand.
      const spot = this.reserves[landing] ? this.freePanelHex(landing) : landing;
      if (spot) this.reserves[spot] = { ...unit } as PieceData;
    }
  }

  /** A free hex in the same panel as `near`, or nothing if the panel is full. */
  private freePanelHex(near: string): string | null {
    const panel = this.cellsByKey.get(near)?.panel;
    const zone = panel ? this.panelZones.get(panel) : undefined;
    for (const hex of zone ?? []) if (!this.reserves[hex]) return hex;
    return null;
  }

  /**
   * What the last turn did to a unit, against the unit it did it to: `+1` for
   * an HP mended in the base, `-1` for overtime's toll on a king. One map
   * rather than one per kind - they are the same mark in two colours, and
   * they fade on the same timer.
   *
   * Held by uid rather than hex so a unit shuffled afterwards keeps it.
   */
  private turnMarks = new Map<string, string>();
  private markTimer: any = null;

  /**
   * What the end of the turn owes each unit, by uid, held until the turn's
   * animation has finished: `+1` for an HP mended in the base, `-1` for
   * overtime's toll on a king.
   *
   * The owner's rule is that these are **the last thing that happens in a
   * turn**, so they are queued where they are noticed - the base's mending
   * as the new board is absorbed, the toll as the ply turns over - and paid
   * together in one beat of their own once the recap has played out. Marking
   * them where they are noticed put them on screen underneath the recap, in
   * the moment the turn's blows were still being struck.
   */
  private pendingUpkeep = new Map<string, string>();

  private oweMark(uid: string, text: string): void {
    this.pendingUpkeep.set(uid, text);
  }

  /**
   * The turn's last beat: every base unit that mended swells and shows its
   * `+1`, and the king that paid overtime's toll is struck and shows its
   * `-1`. All at once - they are one moment, the turn settling up - and
   * after everything else the turn did.
   *
   * Nothing owed is no beat at all, so an ordinary turn ends where it always
   * did rather than holding for three quarters of a second of nothing.
   */
  private async settleUpkeep(): Promise<void> {
    if (!this.pendingUpkeep.size) return;
    const owed = [...this.pendingUpkeep];
    this.pendingUpkeep.clear();
    // Where each of them is standing *now*: a unit that walked during the
    // turn is marked where it ended up, not where the mending noticed it.
    const at = new Map<string, string>();
    for (const cell of this.cells) {
      if (cell.piece?.uid) at.set(cell.piece.uid, cell.key);
    }
    for (const [uid, text] of owed) {
      this.turnMarks.set(uid, text);
      const key = at.get(uid);
      if (!key) continue;
      // Taken away rather than given, so the toll shrinks where a mend
      // swells - the same shape a blow landing already has.
      const struck = text.charAt(0) === '-';
      const mine = this.cellsByKey.get(key)?.piece?.color === (this.myColor || 'white');
      // The swell wears the mark's own colour, a shade brighter so it carries
      // as a glow: green for your mending, blue for theirs, red for your king
      // paying overtime and purple for theirs.
      this.popUnit(key, struck, UPKEEP_MS, struck
        ? (mine ? '#ef4444' : '#a855f7')
        : (mine ? '#22c55e' : '#38bdf8'));
    }
    // One timer for the lot, set after them all rather than per unit.
    clearTimeout(this.markTimer);
    this.markTimer = setTimeout(() => {
      this.turnMarks.clear();
      this.markTimer = null;
      this.cdr.markForCheck();
    }, MARK_FADE_MS);
    this.cdr.markForCheck();
    await this.wait(UPKEEP_MS);
  }

  /** The mark to draw over this unit, or '' for none. */
  markOf(hex: HexCell): string {
    return hex.piece ? this.turnMarks.get(this.uidOf(hex)) ?? '' : '';
  }

  /**
   * Overtime bleeds a point off a side at the end of each of its hand-overs.
   * The header already counts it; this is the same toll on the board, taken
   * by that side's king, so there is something to watch rather than a number
   * quietly dropping out of the score.
   *
   * Derived from the turn that just ended rather than announced by the room:
   * white plays the odd hand-overs, so which side paid is arithmetic.
   *
   * The HP behind it is real - `overtimeToll()` takes it, and a commander on
   * 1 HP dies of it - so this is the mark over damage that has already
   * landed, not a shake standing in for it.
   *
   * ponytail: **the browser engine's alone**, like the toll it draws. A
   * networked server takes no HP off anybody, so marking a king there would
   * be a red -1 over a unit whose HP never moves - the same line `entryBind`
   * draws for every other client-only rule.
   */
  private markOvertimeToll(previous: number, now: number): void {
    const ended = now - 1;
    if (!this.entryBind || now <= previous || ended < OVERTIME_FIRST_PLY) return;
    // Only the side that just paid wears one: the hand-over before this was
    // the other side's, and that toll has had its turn on screen. Dropped
    // before the king is looked for, so a side without one still clears it.
    for (const [uid, mark] of this.turnMarks) if (mark === '-1') this.turnMarks.delete(uid);
    const color = sideOfPly(ended);
    const king = this.cells.find(cell => cell.piece?.color === color
      && this.config?.units?.[cell.piece.unit_id]?.commander);
    // No king to mark means it has just died of the toll, which the engine
    // has already turned into the end of the game.
    if (!king?.piece) return;
    this.oweMark(this.uidOf(king), '-1');
  }

  /**
   * The hexes a side's wrap needs kept clear to be usable at all: both tips,
   * and every hex beside them. Only the one panel neighbour of each tip
   * really matters - the rest are battlefield or off the grid, and naming
   * them costs nothing - so this is the ring rather than a hand-picked pair.
   */
  private wrapCorridor(color: 'white' | 'black'): Set<string> {
    const tips = this.wrapTips(color);
    const clear = new Set<string>();
    for (const tip of [tips.base, tips.reserve]) {
      clear.add(tip);
      const [tq, tr] = tip.split(',').map(Number);
      for (const [dq, dr] of HEX_DIRS) clear.add(`${tq + dq},${tr + dr}`);
    }
    return clear;
  }

  /**
   * The two outer tips a wrap joins for one side: its base's tip and the
   * reserve tip facing it across the board. On the shipped radius-11 board
   * white's pair is hex 283 `(-12,1)` and hex 306 `(11,1)` - the far left and
   * far right of the same row - and black's is the point mirror of those,
   * `(12,-1)` and `(-11,-1)`, which lands in black's own base and reserve.
   */
  private wrapTips(color: string): { base: string; reserve: string } {
    const flip = color === 'black' ? -1 : 1;
    return {
      base: `${-flip * (this.radius + 1)},${flip}`,
      reserve: `${flip * this.radius},${flip}`,
    };
  }

  /**
   * Hexes that can only be reached by crossing the wrap, each against what
   * the crossing costs in points. What the board draws a `-x` on, and what
   * tells a move it is a crossing and has to be paid for.
   */
  /**
   * What the walk cost to reach a hex it could only pass THROUGH - one of
   * your own standing in the way. Kept beside `moveCosts` rather than in it,
   * because these are not places to stop; the crossings need them so a friend
   * on a gateway or a wrap tip is walked past instead of shutting the way.
   */
  private passableCosts = new Map<string, number>();

  /** What it cost to be standing on `hex` - landed on, or merely passed. */
  private costAt(hex: string, from: string): number | undefined {
    if (hex === from) return 0;
    return this.moveCosts.get(hex) ?? this.passableCosts.get(hex);
  }

  /**
   * Board hexes a reserve can only be on by crossing in - everything beyond
   * the gap. Drawn apart from the rest of the reach: stepping onto the board
   * is a different thing from shuffling about the panel, and the two used to
   * be the same green.
   */
  entryTargets = new Set<string>();

  wrapTargets = new Map<string, number>();

  /**
   * The far tip of a crossing the side has not got the points for, against
   * what it would cost. Drawn but never offered: without it the flood simply
   * stops at the base tip and nothing on screen says why.
   */
  wrapDenied = new Map<string, number>();

  /**
   * What a unit is worth, from config. The wrap out of the base charges it and
   * the walk back into the base refunds it, so a unit sent out and brought
   * home again leaves the points where it found them.
   * ponytail: the owner left the refund open ("x can be whatever you want").
   * The unit's own worth is the one number already in play for this.
   */
  /** Whose purse pays for this - theirs when it is one of theirs. */
  private pointsOf(color: string | undefined): number {
    return color && color !== this.activeColor ? this.theirPoints : this.movePoints;
  }

  private wrapCost(cell: HexCell): number {
    return this.config?.units?.[cell.piece?.unit_id ?? '']?.value ?? 0;
  }

  /**
   * Hexes reached by walking off the battlefield into the base, against what
   * coming home pays back. What the board draws a green `+x` on, and what
   * tells a move it is a withdrawal rather than an ordinary step.
   */
  refundTargets = new Map<string, number>();

  /**
   * The way home: a unit on the battlefield may step through one of its own
   * base's three marks and carry on inside with whatever MOV is left. Getting
   * to a hex beside the mark is an ordinary walk, so stepping through costs
   * one on top of it - the wrap's rule, in reverse.
   *
   * Coming home **pays**: the unit's own worth goes back to the side that
   * brought it in, which is the same number the wrap charged to send one out.
   *
   * ponytail: the owner has said certain turns and phases will close this.
   * Until they are named it is open whenever a unit can reach it - the gate
   * belongs here, one condition alongside `entryBind`.
   */
  private addBaseEntry(cell: HexCell, key: string, budget: number | undefined): void {
    if (!this.entryBind) return;
    const color = cell.piece?.color ?? 'white';
    const refund = this.wrapCost(cell);
    const mov = budget ?? this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0;
    for (const [gate, arrow] of baseGatewayHexes(this.radius)) {
      if (arrow.color !== color) continue;
      // An enemy in the doorway shuts it; one of your own is stepped over.
      const inDoor = this.occupancy[gate];
      if (inDoor && inDoor.color !== color) continue;
      const [gq, gr] = gate.split(',').map(Number);
      // The cheapest board hex beside the mark, or nothing if none is reached.
      let toEdge = Infinity;
      for (const [dq, dr] of HEX_DIRS) {
        const [nq, nr] = [gq + dq, gr + dr];
        if (!isInsideBoard(nq, nr, this.radius)) continue;
        const at = `${nq},${nr}`;
        const cost = this.costAt(at, key);
        if (cost !== undefined) toEdge = Math.min(toEdge, cost);
      }
      // A unit walks home within its MOV like it walks anywhere else - it
      // does not teleport in from across the board. The owner has said so
      // twice; a free ride from anywhere was wrong.
      const spent = toEdge + 1;
      const left = mov - spent;
      if (!Number.isFinite(spent) || left < 0) continue;
      // A mark derived from coordinates alone need not be a hex the board
      // draws - another orientation puts it outside the block - and without a
      // panel to confine it the walk beyond would flood the battlefield.
      const landing = this.cellsByKey.get(gate);
      const zone = landing?.panel ? this.panelZones.get(landing.panel) : undefined;
      if (!zone) continue;
      // (6) Never overwrite a cheaper way in that an earlier mark already found.
      if (!inDoor) {
        if (spent < (this.moveCosts.get(gate) ?? Infinity)) this.moveCosts.set(gate, spent);
        this.refundTargets.set(gate, refund);
      }
      if (left === 0) continue;

      // On into the base with what is left, confined to that panel like any
      // walk inside one. The unit is put on the mark for that pass: the rules
      // read the mover off the board they are given.
      const onward = { ...this.occupancy, [gate]: cell.piece! };
      delete onward[key];
      for (const [hex, cost] of computeMoveCosts(
        onward, gq, gr, this.config, this.radius, left, zone,
      )) {
        const total = spent + cost;
        if (total >= (this.moveCosts.get(hex) ?? Infinity)) continue;
        this.moveCosts.set(hex, total);
        // The refund is for coming home, not for the hex: every one of these
        // is reached by doing it, so they all carry the same number.
        this.refundTargets.set(hex, refund);
      }
    }
  }

  /**
   * The wrap, and the only way out of a base: a unit that reaches its base's
   * outer tip may step across to the reserve tip for 1, and carry on into the
   * reserve with whatever MOV is left. Reaching the tip is an ordinary walk,
   * so the cost of the crossing is one step on top of getting there.
   *
   * It is bought as well as walked: crossing costs the unit's own worth in
   * points. A side that cannot pay is not offered the crossing - nothing
   * beyond the tip enters the flood - but the price is still drawn on the
   * far tip, struck through, because a gap that simply fails to open reads
   * as broken rather than as expensive. What it can afford carries the
   * price as an offer instead.
   *
   * Added to the flood rather than replacing it - a base unit can still walk
   * about inside its own panel without going anywhere near the tip.
   */
  private addWrap(cell: HexCell, key: string, budget: number | undefined): void {
    // Shut by the schedule: no target and no price either, because the price
    // is an offer. What says so on screen is the cross over the arrow.
    if (!this.wrapOpen) return;
    const tips = this.wrapTips(cell.piece?.color ?? 'white');
    // Passed through counts as reached: one of your own on the base tip is
    // walked over, not walked into. It used to shut the crossing outright.
    const toTip = this.costAt(tips.base, key);
    const onFarTip = this.occupancy[tips.reserve];
    // An enemy on the far tip does shut it - no landing and no way past. One
    // of your own only means you cannot stop there.
    if (toTip === undefined
        || (onFarTip && onFarTip.color !== cell.piece?.color)) return;
    // Out of MOV before out of money: the struck-through price says "save up
    // for this", and saying it to someone who could not have crossed with the
    // money in hand points at the wrong thing.
    const spent = toTip + 1;
    const left = (budget ?? this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0) - spent;
    if (left < 0) return;
    const price = this.wrapCost(cell);
    if (price > this.pointsOf(cell.piece?.color)) {
      this.wrapDenied.set(tips.reserve, price);
      return;
    }
    if (!onFarTip) {
      this.moveCosts.set(tips.reserve, spent);
      this.wrapTargets.set(tips.reserve, price);
    }
    if (left === 0) return;

    // On into the reserve, flooding from the tip with what is left. The unit
    // is put on the far tip for that pass: computeMoveCosts reads the mover
    // off the board it is given, and it has not actually crossed yet.
    const landing = this.cellsByKey.get(tips.reserve);
    // The tips are arithmetic, so the far one need not be a hex this board
    // draws - another orientation puts it outside the block. No panel to
    // confine the onward walk means no walk: handing `undefined` to
    // computeMoveCosts falls back to the battlefield, which would offer a
    // base unit a paid teleport onto the board. `addBaseEntry` guards the
    // same case the same way.
    const zone = landing?.panel ? this.panelZones.get(landing.panel) : undefined;
    if (!zone) return;
    const onward = { ...this.occupancy, [tips.reserve]: cell.piece! };
    delete onward[key];
    const [wq, wr] = tips.reserve.split(',').map(Number);
    const beyond = computeMoveCosts(
      onward, wq, wr, this.config, this.radius, left, zone,
    );
    for (const [hex, cost] of beyond) {
      const total = spent + cost;
      if (total >= (this.moveCosts.get(hex) ?? Infinity)) continue;
      this.moveCosts.set(hex, total);
      // The price is for the crossing, not for the hex: every one of these
      // is reached by making it, so they all carry the same number.
      this.wrapTargets.set(hex, price);
    }
  }

  /**
   * The way out of the reserve: the three gateway hexes, and the battlefield
   * beside them. A unit that reaches a gateway steps onto the board for one
   * more and carries on with whatever MOV is left.
   *
   * Added to the panel flood rather than replacing it - a reserve still
   * shuffles about its own panel without going near the gap.
   *
   * ponytail: one flood per entry hex, up to six on a click. Fold them into a
   * single multi-source flood if it ever shows.
   */
  private addGateway(cell: HexCell, key: string, budget: number | undefined): void {
    if (!this.entryBind) return;

    const color = cell.piece?.color ?? 'white';
    const mov = budget ?? this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0;
    // Both pictures at once - see committedBoard. A hex the turn's move has
    // vacated stays shut to a crossing until that move has actually landed.
    const blocked = { ...this.occupancy, ...this.committedBoard };
    for (const [gate, arrow] of gatewayHexes(this.radius)) {
      if (arrow.color !== color) continue;
      // Reaching the gap is an ordinary walk through the panel, so stepping
      // through costs one on top of getting there.
      const toGate = this.costAt(gate, key);
      if (toGate === undefined) continue;
      const spent = toGate + 1;
      const left = mov - spent;
      if (left < 0) continue;
      const [gq, gr] = gate.split(',').map(Number);
      for (const [dq, dr] of HEX_DIRS) {
        const [eq, er] = [gq + dq, gr + dr];
        const entry = `${eq},${er}`;
        if (!isInsideBoard(eq, er, this.radius)) continue;
        // An enemy on the landing hex shuts that way in; one of your own is
        // stepped over - you simply cannot stop on it.
        const standing = blocked[entry];
        if (standing && standing.color !== cell.piece?.color) continue;
        if (!standing) {
          if (spent < (this.moveCosts.get(entry) ?? Infinity)) {
            this.moveCosts.set(entry, spent);
          }
          this.entryTargets.add(entry);
        }
        if (left === 0) continue;

        // On across the board with what is left. The unit is put on the entry
        // hex for that pass: computeMoveCosts reads the mover off the board it
        // is given, and it has not actually stepped in yet.
        const onward = { ...blocked, [entry]: cell.piece! };
        delete onward[key];
        for (const [hex, cost] of computeMoveCosts(
          onward, eq, er, this.config, this.radius, left,
        )) {
          const total = spent + cost;
          if (total < (this.moveCosts.get(hex) ?? Infinity)) this.moveCosts.set(hex, total);
          this.entryTargets.add(hex);
        }
      }
    }
  }

  /**
   * Step a reserve onto the battlefield through the gap. Unlike a shuffle
   * this is the turn's board move, so it goes to the engine - carrying the
   * unit with it, because no engine has a panel to look it up in.
   *
   * The unit is not taken out of `reserves` here. A panel hex draws empty
   * while its unit stands on the board, so Undo dropping the staged board
   * puts it back with no second stack to unwind.
   */
  private enterBoard(from: string, to: string): void {
    const piece = this.reserves[from];
    if (!piece) return;
    const uid = this.uidOf(this.cellsByKey.get(from) ?? ({ piece, key: from } as HexCell));
    const cost = this.moveCosts.get(to) ?? 1;
    // A crossing is a reserve's move, not the turn's one board action - so it
    // is charged to that unit's MOV and to the reserve's movers, exactly as a
    // shuffle is, and several units may come through in a turn.
    this.entered[to] = piece;
    this.panelMoved.set(uid, (this.panelMoved.get(uid) ?? 0) + cost);
    this.reserveMovers.add(uid);
    this.panelHistory.push({ from, to, uid, cost, price: 0, at: Date.now(), entry: true });
    this.selectedHex = null;
    this.clearTargets();
    this.buildCells();
    this.hexSelected.emit(null);
  }

  /**
   * Units that have crossed this turn and are not on the engine's board yet.
   * They draw on the battlefield from here until End Turn sends them, which
   * is also what makes a crossing as cheap to take back as a shuffle.
   */
  private entered: Record<string, PieceData> = {};

  /** The crossings this turn, for End Turn to hand to the engine. */
  get pendingEntries(): Array<{ from: string; to: string; unit: PieceData }> {
    return this.panelHistory
      .filter(step => step.entry && !!this.entered[step.to])
      .map(step => ({ from: step.from, to: step.to, unit: this.entered[step.to] }));
  }

  /**
   * What each panel unit has spent this turn, keyed by uid so it follows the
   * unit rather than the hex it is standing on. Base and reserve alike -
   * neither gets an endless walk, each gets its own MOV and no more. A panel
   * unit is not the turn's one board action, so it carries its budget here
   * rather than on the board's move stack.
   */
  private panelMoved = new Map<string, number>();

  /**
   * Which units of each panel have been walked this turn. One set each, and
   * separate from the ledger above on purpose: the three-mover cap is a
   * per-panel allowance, and counting one panel's walks against the other
   * would spend an allowance on units it was never about.
   */
  private baseMovers = new Set<string>();
  private reserveMovers = new Set<string>();

  /**
   * Units this side has already moved earlier in the initialization. Unlike
   * the movers above this does *not* reset on a new turn - through the
   * opening a unit gets one move for the whole phase, so the ones that have
   * had theirs stay out for the rest of it. Emptied when the phase ends.
   */
  private lockedUnits = new Set<string>();

  /** The opening phase, where the rules above apply. */
  private get initializing(): boolean {
    return isInitialization(this.turnNumber);
  }

  /**
   * Whether this panel unit may still be walked this turn: one already among
   * the turn's movers may carry on spending what is left of its MOV, but a
   * fresh one cannot start once the allowance is used up - and through the
   * initialization one that moved on an earlier turn cannot start at all.
   *
   * Both panels carry the cap, all match, and each carries its own: three
   * out of the base and three out of the reserve, never three between them.
   */
  private panelCanMove(cell: HexCell): boolean {
    const uid = this.uidOf(cell);
    if (this.lockedUnits.has(uid)) return false;
    const movers = BASE_PANELS.has(cell.panel) ? this.baseMovers : this.reserveMovers;
    return movers.has(uid) || movers.size < PANEL_MOVERS_PER_TURN;
  }

  /**
   * A panel unit with nothing left to do this turn: its own MOV spent, or
   * that panel's three movers used up and this one not among them.
   *
   * Deliberately the same conditions the movement rules read, so the grey can
   * never promise a move the board would then refuse - or withhold one it
   * would allow. Only the side whose turn it is greys out; the opponent's
   * panels are not the player's to move either way.
   */
  isPanelSpent(hex: HexCell): boolean {
    if (!hex.piece) return false;
    // A battlefield unit greys only through the initialization, where the
    // side's one move for the phase can already be gone.
    if (!hex.panel) {
      if (hex.piece.color !== this.activeColor) return false;
      // Either this turn's board move is gone, or this particular unit has
      // had the one move the opening gives it.
      return this.initializing
        && (this.boardMoveSpent || this.initMoved.includes(hex.key));
    }
    if (hex.piece.color !== this.activeColor) return false;
    // A unit that has just walked home is done: it stands in a panel on the
    // staged board, which is exactly where refreshTargets refuses it. Without
    // this it sits there ungreyed and takes no clicks - the walk home reads
    // as never having counted.
    if (this.boardState[hex.key]) return true;
    if (!this.panelCanMove(hex)) return true;
    return this.budgetFor(hex) === 0;
  }

  /**
   * Panel walks taken this turn, newest last. A panel walk never reaches an
   * engine - it is the board's own - so the board keeps the stack that Undo
   * pops rather than putting it on the room's staged one.
   */
  private panelHistory: Array<{
    from: string; to: string; uid: string; cost: number; price: number; at: number;
    /** Whether the walk crossed onto the battlefield rather than inside a panel. */
    entry?: boolean;
  }> = [];

  /** When the last panel walk was taken, or 0 if none this turn. */
  get lastPanelMove(): number {
    return this.panelHistory[this.panelHistory.length - 1]?.at ?? 0;
  }

  /**
   * Take the last panel walk back: the unit to where it stood, the steps to
   * its MOV, and - if it had bought a crossing - the price, which is returned
   * for the room to hand back. A unit left with nothing walked is no longer
   * one of the turn's movers either, so the allowance comes back with it.
   */
  undoPanelMove(): number {
    const last = this.panelHistory.pop();
    if (!last) return 0;
    if (last.entry) {
      // The unit was never taken out of its panel - it only stopped being
      // drawn there - so dropping the crossing is all it takes to put it back.
      delete this.entered[last.to];
    } else {
      this.reserves[last.from] = this.reserves[last.to];
      delete this.reserves[last.to];
    }
    const walked = (this.panelMoved.get(last.uid) ?? 0) - last.cost;
    if (walked > 0) {
      this.panelMoved.set(last.uid, walked);
    } else {
      this.panelMoved.delete(last.uid);
      this.baseMovers.delete(last.uid);
      this.reserveMovers.delete(last.uid);
    }
    this.selectedHex = null;
    this.clearTargets();
    this.buildCells();
    this.hexSelected.emit(null);
    return last.price;
  }

  /**
   * A panel unit that has already walked this turn. It may still have MOV
   * left, so it is not greyed - but it is not untouched either, and the mark
   * says so. Undo takes the walk back and the mark with it.
   */
  hasWalked(hex: HexCell): boolean {
    return !!hex.piece && (this.panelMoved.get(this.uidOf(hex)) ?? 0) > 0;
  }

  /** Walk a reserve to another hex of its own panel - local, and free. */
  private moveReserve(from: string, to: string): void {
    // Either panel's walk comes out of that unit's own MOV for the turn, and
    // a base one additionally spends one of the turn's three movers.
    const moving = this.cellsByKey.get(from);
    // Crossing the wrap is bought: the room takes the points off. Only a hex
    // on the far side carries a price, so an ordinary shuffle pays nothing.
    const price = this.wrapTargets.get(to) ?? 0;
    if (price) this.wrapCrossed.emit(price);
    if (moving?.panel) {
      const uid = this.uidOf(moving);
      const cost = this.moveCosts.get(to) ?? 1;
      this.panelMoved.set(uid, (this.panelMoved.get(uid) ?? 0) + cost);
      (BASE_PANELS.has(moving.panel) ? this.baseMovers : this.reserveMovers).add(uid);
      this.panelHistory.push({ from, to, uid, cost, price, at: Date.now() });
    }
    this.reserves[to] = this.reserves[from];
    delete this.reserves[from];
    this.selectedHex = to;
    this.buildCells();
    const cell = this.cellsByKey.get(to);
    if (cell) this.emitSelected(cell);
    this.refreshTargets();
  }

  // -- Helpers --------------------------------------------------------

  /** Where the flying copy's own glyph sits - the hex it came from. */
  get moverAnchor(): { x: number; y: number } {
    const cell = this.cellsByKey.get(this.moverHex);
    return { x: cell?.cx ?? 0, y: cell?.cy ?? 0 };
  }

  /** Two-character stat, exposed for the template. */
  statText = statText;

  /** Hex currently under the cursor, for the hover shadow. */
  hoveredHex: string | null = null;

  /**
   * The selection's own layers - legal moves, attackable enemies, the dots -
   * belong to it alone, so they come off the board while the cursor is
   * reading someone else. Two units' ranges on screen at once is unreadable.
   */
  get showingSelection(): boolean {
    return !this.hoveredHex || this.hoveredHex === this.selectedHex;
  }

  /**
   * Whether the reach on screen belongs to a unit that can still be given an
   * order - the only kind that earns the live colours.
   *
   * Once something is staged the turn is spent on that unit (refreshTargets
   * enforces the same lock), so it is the last one left in colour; clicking
   * another of your own to read it must not look like you can send it
   * somewhere. Undo puts the turn back and every unit of yours with it.
   */
  get previewDim(): boolean {
    const key = this.hoveredHex ?? this.selectedHex;
    if (!key) return false;
    if (this.movesLeftFor) return key !== this.movesLeftFor;
    const piece = this.cellsByKey.get(key)?.piece;
    return !piece || piece.color !== this.activeColor || !this.canDriveNow();
  }

  /** Hovering previews a unit in the Unit panel without selecting it. */
  onHexHover(hex: HexCell | null): void {
    this.hoveredHex = hex && hex.piece ? hex.key : null;
    this.refreshForecast();
    this.hexHovered.emit(hex && hex.piece ? this.describe(hex) : null);
    this.refreshPreview();
    this.cdr.markForCheck();
  }

  /**
   * Show the reach of the unit under the cursor, or of the selection when the
   * cursor is elsewhere - either side's, since knowing what an enemy threatens
   * is the point. Movement is where it can stand; the attack layer is what it
   * could hit from there but not step onto.
   */
  private clearTargets(): void {
    this.legalTargets.clear();
    this.attackTargets.clear();
    this.moveCosts.clear();
    this.passableCosts.clear();
    this.entryTargets.clear();
    this.wrapTargets.clear();
    this.wrapDenied.clear();
    this.refundTargets.clear();
  }

  /**
   * What the selected unit may do from where it now stands: hexes still
   * inside its remaining move budget, and enemies inside its attack range.
   * Recomputed after every staged step, because both change as it walks.
   */
  private refreshTargets(canDrive = this.canDriveNow()): void {
    this.clearTargets();
    const key = this.selectedHex;
    if (!key || !this.config) return;
    const cell = this.cellsByKey.get(key);
    if (!cell?.piece || cell.piece.color !== this.activeColor) return;
    // A crossing is plotted in one go - the whole reach through the gap is
    // offered before it is taken - so a unit that has come through is done.
    // ponytail: whatever MOV it did not spend on the way in is forfeit. Give
    // it the panel's step-at-a-time treatment if that ever grates.
    if (this.entered[key]) return;
    // And so is one that has walked home: it stands in a panel on the staged
    // board, where the click handler would take any further step for a board
    // move - skipping the wrap's price and every panel allowance with it.
    if (cell.panel && this.boardState[key]) return;

    // A reserve is confined to its own panel, and shuffling it is not the
    // turn's action - so neither the staging lock nor canDrive applies to it.
    // Testing canDrive above this froze the panels the moment the turn's unit
    // swung, which is exactly what the branch below exists to prevent.
    const zone = cell.panel ? this.panelZones.get(cell.panel) : undefined;
    if (zone) {
      if (!this.controlAllSides && !this.isMyTurn) return;
      // Only so many of a panel's units move in a turn. A fourth one on a
      // turn that has already moved three has nothing to show; one that has
      // spent its MOV falls out below, where a budget of 0 floods nowhere.
      if (!this.panelCanMove(cell)) return;
    } else {
      if (!canDrive) return;
      // One battlefield move a turn through the opening, and a unit that has
      // taken one is done for the phase - so a fresh turn offers the rest of
      // the board, not the same unit again.
      if (this.initializing
          && (this.boardMoveSpent || this.initMoved.includes(key))) return;
      // One unit acts per turn: once something is staged, nothing else may be
      // driven, or the staged origin and the unit on screen part ways.
      if (this.movesLeftFor && key !== this.movesLeftFor) return;
    }

    const [sq, sr] = key.split(',').map(Number);
    const budget = this.budgetFor(cell);
    this.passableCosts = new Map();
    this.moveCosts = computeMoveCosts(
      this.occupancy, sq, sr, this.config, this.radius, budget, zone,
      this.passableCosts,
    );
    if (BASE_PANELS.has(cell.panel)) this.addWrap(cell, key, budget);
    else if (cell.panel) this.addGateway(cell, key, budget);
    else this.addBaseEntry(cell, key, budget);
    this.legalTargets = new Set(this.moveCosts.keys());

    // **Only the battlefield starts a fight.** Neither panel ever does - a
    // reserve answers when it is struck and nothing more, a base does not
    // even answer - so neither is ever offered a target. What the battlefield
    // reaches, though, includes them both: a unit at the edge shows its range
    // running on into the panel beside it.
    // Through the initialization nobody attacks at all.
    if (!cell.panel && !this.initializing) {
      const range: number = this.config?.units?.[cell.piece.unit_id]?.attackRange ?? 1;
      for (const other of this.cells) {
        if (!other.piece || other.piece.color === cell.piece.color) continue;
        // No panel is in a fight at all unless an engine holds one. Only the
        // browser engine does, so a server game draws the panels and leaves
        // them out of it - the same line `entryBind` draws for crossings.
        // Offering the blow there would send a message the server has no
        // answer for, and stall the turn on it.
        if (other.panel && !this.entryBind) continue;
        if (hexDistanceKeys(key, other.key) <= range) this.attackTargets.add(other.key);
      }
    }
    this.refreshForecast();
  }

  /**
   * Steps the unit at `key` may spend: what is left of a staged turn, or its
   * own move stat plus any boost. `undefined` lets the rules read the stat.
   */
  private budgetFor(cell: HexCell): number | undefined {
    if (cell.key === this.movesLeftFor) return this.movesLeft ?? undefined;
    const bonus = this.unitBuffs[this.uidOf(cell)]?.mov ?? 0;
    // A panel unit - base or reserve - gets its MOV for the turn and no more,
    // spent a few steps at a time, so what is left of it is the budget rather
    // than the whole stat. What it has already walked counts wherever it now
    // stands: a unit that crossed onto the board keeps spending the same MOV.
    const walked = this.panelMoved.get(this.uidOf(cell)) ?? 0;
    if (cell.panel || walked) {
      const base = this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0;
      return Math.max(0, base + bonus - walked);
    }
    if (!bonus) return undefined;
    const base = this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0;
    return Math.max(0, base + bonus);
  }

  /** A unit's identity, falling back to its hex for boards without one. */
  private uidOf(cell: HexCell): string {
    return cell.piece?.uid ?? cell.key;
  }

  /** The seat rules half of "may I drive this?" - see onHexClick. */
  private canDriveNow(): boolean {
    return this.canMove && (this.controlAllSides || this.isMyTurn);
  }

  private refreshPreview(): void {
    const key = this.hoveredHex ?? this.selectedHex;
    const cell = key ? this.cellsByKey.get(key) : null;
    // A unit that has walked has less left to show, so the budget is part of
    // the preview's identity - not just which unit it belongs to.
    const budget = cell?.piece ? this.budgetFor(cell) : undefined;
    const memo = `${key}:${budget}`;
    if (memo === this.previewKey) return;
    this.previewKey = memo;
    this.previewMoves = new Set<string>();
    this.previewAttacks = new Set<string>();
    this.previewWrap = new Map();
    this.previewDenied = new Map();
    this.previewRefund = new Map();
    this.previewEntry = new Set();
    if (!key || !this.config || !cell?.piece) return;
    const [q, r] = key.split(',').map(Number);
    const zone = cell.panel ? this.panelZones.get(cell.panel) : undefined;
    // Costs rather than a plain set, because the three crossing helpers walk
    // outward from what the flood already reached.
    const passable = new Map<string, number>();
    const costs = computeMoveCosts(
      this.occupancy, q, r, this.config, this.radius, budget, zone, passable,
    );

    // The crossings, worked out by the very helpers that do it for a unit you
    // may drive. They write to the live target maps, so those are lent to
    // them and the results lifted off afterwards - one implementation of the
    // rules rather than a second copy that can drift from it.
    // ponytail: a lend-and-restore rather than five more parameters through
    // three methods. Parameterise them if a third caller ever turns up.
    const held = {
      costs: this.moveCosts, wrap: this.wrapTargets, denied: this.wrapDenied,
      refund: this.refundTargets, entry: this.entryTargets,
      passable: this.passableCosts,
    };
    this.moveCosts = costs;
    this.passableCosts = passable;
    this.wrapTargets = new Map();
    this.wrapDenied = new Map();
    this.refundTargets = new Map();
    this.entryTargets = new Set();
    if (BASE_PANELS.has(cell.panel)) this.addWrap(cell, key, budget);
    else if (cell.panel) this.addGateway(cell, key, budget);
    else this.addBaseEntry(cell, key, budget);
    this.previewWrap = this.wrapTargets;
    this.previewDenied = this.wrapDenied;
    this.previewRefund = this.refundTargets;
    this.previewEntry = this.entryTargets;
    this.previewMoves = new Set(this.moveCosts.keys());
    this.moveCosts = held.costs;
    this.passableCosts = held.passable;
    this.wrapTargets = held.wrap;
    this.wrapDenied = held.denied;
    this.refundTargets = held.refund;
    this.entryTargets = held.entry;
    // The strike layer sits just outside whatever movement is left - and is
    // not drawn at all for a unit that cannot strike: a panel unit, or
    // anybody at all through the initialization.
    if (cell.panel || this.initializing) return;
    // Bounded by what the board DRAWS, not by the battlefield: a unit at the
    // edge reaches into the panel beside it, and the overlay has to say so.
    // Left to its own bound the zone stops dead at the hexagon's rim, which
    // reads as the range ending there when it does not.
    this.previewAttacks = computeAttackZone(
      key, this.previewMoves, this.config, cell.piece.unit_id, this.radius,
      this.strikeBounds[cell.piece.color],
    );
  }

  /**
   * What the hovered trade would do. Both halves of it: our strike on them,
   * and their counter on us if we are inside their range and they survive.
   * Recomputed on hover rather than read per change-detection pass.
   */
  private forecast: { target: string; targetHp: number; attacker: string; attackerHp: number } | null = null;

  /** A one-turn boost on the unit standing on `key`, or 0. */
  private buffOf(key: string, stat: 'atk' | 'def'): number {
    const cell = this.cellsByKey.get(key);
    return (cell ? this.unitBuffs[this.uidOf(cell)]?.[stat] : undefined) ?? 0;
  }

  private refreshForecast(): void {
    this.forecast = null;
    const from = this.selectedHex;
    const to = this.hoveredHex;
    if (!from || !to || !this.config || !this.attackTargets.has(to)) return;
    const me = this.cellsByKey.get(from)?.piece;
    const them = this.cellsByKey.get(to)?.piece;
    if (!me || !them) return;

    const distance = hexDistanceKeys(from, to);
    // Boosts are part of the trade, so the forecast has to price them in or
    // it promises a number the strike will not deliver.
    const dealt = strikeDamage(me.unit_id, them.unit_id, distance, this.config,
                               this.buffOf(from, 'atk'), this.buffOf(to, 'def'));
    const targetHp = Math.max(0, (them.hp ?? 0) - dealt);
    // A unit at 0 never counters, and a counter only comes back if we are
    // standing inside its own range - see Combat in AGENTS.md.
    const theirRange: number = this.config?.units?.[them.unit_id]?.attackRange ?? 1;
    const counter = targetHp > 0 && distance <= theirRange
      ? strikeDamage(them.unit_id, me.unit_id, distance, this.config,
                     this.buffOf(to, 'atk'), this.buffOf(from, 'def'))
      : 0;
    this.forecast = {
      target: to,
      targetHp,
      attacker: from,
      attackerHp: Math.max(0, (me.hp ?? 0) - counter),
    };
  }

  /** "-6" for either unit in the hovered trade, else null. */
  forecastDamage(key: string): string | null {
    const f = this.forecast;
    if (!f) return null;
    // The cell draws twoDigits(hp), so the delta has to be against the same
    // number the player is looking at.
    const hp = this.cellsByKey.get(key)?.stats?.hp ?? 0;
    const after = key === f.target ? f.targetHp : key === f.attacker ? f.attackerHp : null;
    if (after === null) return null;
    const dealt = hp - twoDigits(after)!;
    // A strike armour absorbed entirely still shows the unit's real HP: a
    // pulsing green "-0" reads as a bug, not as "nothing happens".
    return dealt > 0 ? `-${dealt}` : null;
  }

  /** True for our own unit in the hovered trade - the one taking the counter. */
  takesCounter(key: string): boolean {
    return !!this.forecast && key === this.forecast.attacker;
  }

  /** True while the hovered trade would leave this unit dead. */
  wouldDie(key: string): boolean {
    const f = this.forecast;
    if (!f) return false;
    return (key === f.target && f.targetHp <= 0) || (key === f.attacker && f.attackerHp <= 0);
  }

  /** HP this unit would be left with, for the Unit panel. */
  private forecastHpAfter(key: string): number | null {
    const f = this.forecast;
    if (!f) return null;
    if (key === f.target) return f.targetHp;
    if (key === f.attacker) return f.attackerHp;
    return null;
  }

  /** The board or the selection moved under the preview - recompute it. */
  private invalidatePreview(): void {
    this.previewKey = null;
    this.refreshPreview();
  }

  private describe(hex: HexCell): SelectedUnit {
    const pc = hex.piece!;
    const def = this.config?.units?.[pc.unit_id];
    return {
      key: hex.key,
      uid: this.uidOf(hex),
      unitId: pc.unit_id,
      name: def?.name ?? pc.unit_id,
      color: pc.color,
      hp: twoDigits(pc.hp),
      hpMax: twoDigits(pc.max_hp ?? def?.hp),
      hpAfter: this.forecastHpAfter(hex.key),
      atk: attackText(pc.unit_id, this.config),
      def: hex.stats?.def ?? null,
      mv: twoDigits(def?.move),
      points: def?.value ?? 0,
      vet: hex.vet,
      panel: hex.panel || undefined,
      drivable: this.drivable(hex),
    };
  }

  /**
   * Whether this unit could do anything at all right now: the same run of
   * gates `refreshTargets` walks before it offers a single hex, in the same
   * order. Answered here rather than in the room because these are the
   * board's own rules - the turn's one unit, the opening's allowances, a
   * panel's movers - and two answers to that would be one too many.
   *
   * Reaching nothing is not the same as being unable to act: a unit hemmed in
   * by its own side is drivable, it simply has nowhere to go.
   */
  drivable(hex: HexCell): boolean {
    if (!hex.piece || hex.piece.color !== this.activeColor) return false;
    if (!this.canDriveNow()) return false;
    if (this.entered[hex.key]) return false;
    if (hex.panel && this.boardState[hex.key]) return false;
    if (hex.panel) return this.panelCanMove(hex) && this.budgetFor(hex) !== 0;
    if (this.initializing
        && (this.boardMoveSpent || this.initMoved.includes(hex.key))) return false;
    if (this.movesLeftFor && hex.key !== this.movesLeftFor) return false;
    return true;
  }

  /** Hand the game room what its Unit panel shows for the hex just clicked. */
  private emitSelected(hex: HexCell): void {
    const unit = hex.piece ? this.describe(hex) : null;
    this.hexSelected.emit(unit);
    this.hexClicked.emit(unit);
  }

  /** Glyph comes from the unit's config entry - nothing is hardcoded per unit. */
  getPieceSymbol(piece: PieceData): string {
    const unitDef = this.config?.units?.[piece.unit_id];
    return unitDef?.display?.[piece.color]
        ?? unitDef?.symbol
        ?? piece.unit_id[0].toUpperCase();
  }

  /**
   * The reach colour to wash a panel hex with, or '' for none.
   *
   * Ordered the way the fills below it are: a target beats a preview, and a
   * place it can stand beats a place it can only reach. Panels only - a
   * battlefield hex takes the plain fill, which has nothing underneath it
   * worth keeping.
   */
  panelWash(hex: HexCell): string {
    if (!hex.panel) return '';
    if (this.showingSelection && this.attackTargets.has(hex.key)) return 'wash-attack-target';
    if (this.showingSelection && this.legalTargets.has(hex.key)) return 'wash-legal';
    if (this.previewAttacks.has(hex.key)) return 'wash-attack';
    if (this.previewMoves.has(hex.key)) return 'wash-move';
    return '';
  }

  /**
   * The crossing labels, from whichever layer is on screen: the unit you are
   * driving if there is one, else the one you are only looking at. Asked here
   * rather than in the template so the two layers are chosen once.
   */
  wrapCostAt(hex: HexCell): number | undefined {
    return this.showingSelection && this.wrapTargets.has(hex.key)
      ? this.wrapTargets.get(hex.key) : this.previewWrap.get(hex.key);
  }

  wrapDeniedAt(hex: HexCell): number | undefined {
    return this.showingSelection && this.wrapDenied.has(hex.key)
      ? this.wrapDenied.get(hex.key) : this.previewDenied.get(hex.key);
  }

  refundAt(hex: HexCell): number | undefined {
    return this.showingSelection && this.refundTargets.has(hex.key)
      ? this.refundTargets.get(hex.key) : this.previewRefund.get(hex.key);
  }

  /** Reached by crossing onto the board - drawn apart from the rest. */
  isEntry(hex: HexCell): boolean {
    return this.showingSelection && this.entryTargets.size
      ? this.entryTargets.has(hex.key) : this.previewEntry.has(hex.key);
  }

  trackByKey(_index: number, hex: HexCell): string {
    return hex.key;
  }

  isAbilityTarget(hex: HexCell, target: 'friendly' | 'enemy'): boolean {
    if (!this.abilityMode || !this.abilityCasterColor || !hex.piece || hex.panel) return false;
    const isFriendly = hex.piece.color === this.abilityCasterColor;
    return target === 'friendly' ? this.abilityMode === 'friendly' && isFriendly
      : this.abilityMode === 'enemy' && !isFriendly;
  }

}
