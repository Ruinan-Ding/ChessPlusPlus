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
  computeMoveCosts, hexDistanceKeys, strikeDamage,
} from '../../services/hex-rules';
import { isInitialization } from '../../services/phases';

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
/** How long each beat of a committed turn takes to play. */
const MOVE_MS = 840;
const STRIKE_MS = 340;
const HIT_MS = 520;
const GLOW_MS = 2000;
/** The same beat in the end-of-turn recap, where there may be several. */
const GLOW_BRIEF_MS = 1200;
/** A slot being taken up - shorter than using one, and board-less. */
const PICK_MS = 900;
/** Blank frame between beats, so each one starts its animation over. */
const BEAT_GAP_MS = 180;

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
 * and top-right for black. The green pair opposite is the reserve, and it
 * still shuffles freely; only the base carries the rules below.
 */
const BASE_PANELS = new Set(['bl', 'tr']);

/**
 * How many units of one panel may be started in a turn. The base carries this
 * all match; the reserve only through the initialization, where the opening
 * rules cap it too and it shuffles freely after.
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
            [class.hex-legal]="showingSelection && legalTargets.has(hex.key)"
            [class.hex-move-preview]="previewMoves.has(hex.key) && (!showingSelection || !legalTargets.has(hex.key))"
            [class.hex-attack-preview]="previewAttacks.has(hex.key)"
            [class.hex-attack-target]="showingSelection && attackTargets.has(hex.key)"
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
          <!-- The zone as a wash laid over the hex rather than a fill under
               it: every reach colour carries !important, so a zone hex lit
               green or red used to lose its blue entirely. Not clickable -
               the hex beneath it still takes the pointer. -->
          <polygon
            *ngIf="hex.zoneClass === 'zone'"
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
          <!-- What a crossing costs, on every hex it buys. The dot gives way
               to it: they would sit on the same spot, and the price is the
               thing worth reading. -->
          <text
            *ngIf="showingSelection && wrapTargets.has(hex.key) && !hex.piece"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy + 5"
            class="wrap-cost"
            (click)="onHexClick(hex)"
          >-{{ wrapTargets.get(hex.key) }}</text>
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
                   && !wrapTargets.has(hex.key)"
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

    /* A panel unit that has already been walked this turn. Sits off the
       plate's corner so it reads next to the unit rather than on it. */
    .walked-mark {
      fill: #f6c343;
      stroke: #3a2f0b;
      stroke-width: 1.2;
      pointer-events: none;
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
   * Points the side to move has to spend. The wrap out of the base is bought
   * as well as walked, and a side that cannot pay is never shown the option.
   */
  @Input() movePoints = 0;
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
  @Output() moveMade = new EventEmitter<{ from: string; to: string; cost: number }>();
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
  @Output() attackMade = new EventEmitter<{ from: string; to: string; attack: string }>();

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
  /** Reach of whatever unit is being shown - hover first, else the selection. */
  previewMoves = new Set<string>();
  previewAttacks = new Set<string>();
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
  private popUnit(key: string, hostile: boolean, ms: number): void {
    const el = key
      ? this.host.nativeElement.querySelector<SVGGElement>(`[data-pop="${key}"]`)
      : null;
    if (!el?.animate) return;
    const peak = hostile ? 0.55 : 1.55;
    const glow = hostile ? '#b07cd6' : '#ffe066';
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
        || changes['unitBuffs'] || changes['myColor']) {
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
      // A turn's walks are only takeable back inside that turn.
      this.panelHistory = [];
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
      this.attackMade.emit({ from: this.selectedHex, to: this.selectedHex, attack: hex.key });
      this.clearTargets();
      return;
    }

    if (this.selectedHex && this.legalTargets.has(hex.key)) {
      // A reserve never reaches the server: it is shuffling inside its panel.
      if (this.reserves[this.selectedHex]) {
        this.moveReserve(this.selectedHex, hex.key);
        return;
      }
      this.moveMade.emit({
        from: this.selectedHex,
        to: hex.key,
        // What the walk actually costs, detours included.
        cost: this.moveCosts.get(hex.key) ?? 1,
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
    const x = hex.cx + dir * 17;
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
  private wrapMarks(): Map<string, { dir: 'up' | 'down'; color: 'white' | 'black' }> {
    const marks = new Map<string, { dir: 'up' | 'down'; color: 'white' | 'black' }>();
    for (const color of ['white', 'black'] as const) {
      const tips = this.wrapTips(color);
      marks.set(tips.base, { dir: color === 'white' ? 'up' : 'down', color });
      marks.set(tips.reserve, { dir: color === 'white' ? 'down' : 'up', color });
    }
    return marks;
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
    // Both kinds of arrow in one map - three onto the battlefield per side,
    // and the two ends of each side's wrap. They never share a hex.
    const arrows = new Map<string, {
      dir: 'left' | 'right' | 'up' | 'down'; color: 'white' | 'black';
    }>([...gatewayHexes(r), ...this.wrapMarks()]);

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
    this.occupancy = { ...this.boardState, ...this.reserves };

    this.cells = coords.map((c, i) => {
      const key = `${c.q},${c.r}`;
      const piece = (c.onBattlefield ? this.boardState[key] : this.reserves[key]) || null;
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
        num: i + 1,
      };
    });

    this.cellsByKey = new Map(this.cells.map(c => [c.key, c]));
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
      // Every third hex in reading order: spread out, with room to shuffle.
      const spots = [...hexes].filter((_, i) => i % 3 === 0);
      roster.forEach(([id, def]: [string, any], i) => {
        const at = spots[i];
        if (!at) return;
        const hp = def?.hp ?? 1;
        this.reserves[at] = { unit_id: id, color, hp, max_hp: hp, uid: `r${panel}${i}` };
      });
    }
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
  wrapTargets = new Map<string, number>();

  /** What a crossing costs: the unit's own worth, from config. */
  private wrapCost(cell: HexCell): number {
    return this.config?.units?.[cell.piece?.unit_id ?? '']?.value ?? 0;
  }

  /**
   * The wrap, and the only way out of a base: a unit that reaches its base's
   * outer tip may step across to the reserve tip for 1, and carry on into the
   * reserve with whatever MOV is left. Reaching the tip is an ordinary walk,
   * so the cost of the crossing is one step on top of getting there.
   *
   * It is bought as well as walked: crossing costs the unit's own worth in
   * points. A side that cannot pay is not offered the crossing at all -
   * nothing beyond the tip enters the flood, so there is no hex to click and
   * nothing to explain. What it can afford is marked with the price.
   *
   * Added to the flood rather than replacing it - a base unit can still walk
   * about inside its own panel without going anywhere near the tip.
   */
  private addWrap(cell: HexCell, key: string, budget: number | undefined): void {
    const tips = this.wrapTips(cell.piece?.color ?? 'white');
    const toTip = key === tips.base ? 0 : this.moveCosts.get(tips.base);
    if (toTip === undefined || this.occupancy[tips.reserve]) return;
    const price = this.wrapCost(cell);
    if (price > this.movePoints) return;
    const spent = toTip + 1;
    const left = (budget ?? this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0) - spent;
    if (left < 0) return;
    this.moveCosts.set(tips.reserve, spent);
    this.wrapTargets.set(tips.reserve, price);
    if (left === 0) return;

    // On into the reserve, flooding from the tip with what is left. The unit
    // is put on the far tip for that pass: computeMoveCosts reads the mover
    // off the board it is given, and it has not actually crossed yet.
    const landing = this.cellsByKey.get(tips.reserve);
    const onward = { ...this.occupancy, [tips.reserve]: cell.piece! };
    delete onward[key];
    const [wq, wr] = tips.reserve.split(',').map(Number);
    const beyond = computeMoveCosts(
      onward, wq, wr, this.config, this.radius, left,
      landing?.panel ? this.panelZones.get(landing.panel) : undefined,
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
   * The base carries the cap all match. The reserve only carries it through
   * the opening; after that it shuffles freely, as it always has.
   */
  private panelCanMove(cell: HexCell): boolean {
    const uid = this.uidOf(cell);
    if (this.lockedUnits.has(uid)) return false;
    const base = BASE_PANELS.has(cell.panel);
    if (!base && !this.initializing) return true;
    const movers = base ? this.baseMovers : this.reserveMovers;
    return movers.has(uid) || movers.size < PANEL_MOVERS_PER_TURN;
  }

  /**
   * A panel unit with nothing left to do this turn: its own MOV spent, or -
   * in the base - the turn's three movers used up and this one not among
   * them.
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
      return this.initializing && this.boardMoveSpent
        && hex.piece.color === this.activeColor;
    }
    if (hex.piece.color !== this.activeColor) return false;
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
    this.reserves[last.from] = this.reserves[last.to];
    delete this.reserves[last.to];
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
    return !!hex.piece && !!hex.panel && (this.panelMoved.get(this.uidOf(hex)) ?? 0) > 0;
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
    this.wrapTargets.clear();
    this.moveCosts.clear();
    this.wrapTargets.clear();
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
      // One battlefield unit for the whole of the initialization, not one a
      // turn: once this side has spent it, nothing on the board is offered a
      // step for the rest of the phase.
      if (this.initializing && this.boardMoveSpent) return;
      // One unit acts per turn: once something is staged, nothing else may be
      // driven, or the staged origin and the unit on screen part ways.
      if (this.movesLeftFor && key !== this.movesLeftFor) return;
    }

    const [sq, sr] = key.split(',').map(Number);
    const budget = this.budgetFor(cell);
    this.moveCosts = computeMoveCosts(
      this.occupancy, sq, sr, this.config, this.radius, budget, zone,
    );
    if (BASE_PANELS.has(cell.panel)) this.addWrap(cell, key, budget);
    this.legalTargets = new Set(this.moveCosts.keys());

    // Nobody off the battlefield attacks - base and reserve alike walk and
    // nothing else - and through the initialization nobody attacks at all.
    // Neither is given targets to be offered in the first place. A reserve
    // unit still strikes back when it is hit; that is the engine's to
    // resolve, and it has no reserve to resolve it for yet.
    if (!cell.panel && !this.initializing) {
      const range: number = this.config?.units?.[cell.piece.unit_id]?.attackRange ?? 1;
      for (const other of this.cells) {
        if (!other.piece || other.piece.color === cell.piece.color) continue;
        // Nothing reaches into a panel from the battlefield.
        if (other.panel) continue;
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
    // than the whole stat.
    if (cell.panel) {
      const base = this.config?.units?.[cell.piece?.unit_id ?? '']?.move ?? 0;
      return Math.max(0, base + bonus - (this.panelMoved.get(this.uidOf(cell)) ?? 0));
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
    if (!key || !this.config || !cell?.piece) return;
    const [q, r] = key.split(',').map(Number);
    const zone = cell.panel ? this.panelZones.get(cell.panel) : undefined;
    this.previewMoves = computeLegalMoves(
      this.occupancy, q, r, this.config, this.radius, budget, zone,
    );
    // The strike layer sits just outside whatever movement is left - and is
    // not drawn at all for a unit that cannot strike: a panel unit, or
    // anybody at all through the initialization.
    if (cell.panel || this.initializing) return;
    this.previewAttacks = computeAttackZone(
      key, this.previewMoves, this.config, cell.piece.unit_id, this.radius, zone,
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
    };
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
