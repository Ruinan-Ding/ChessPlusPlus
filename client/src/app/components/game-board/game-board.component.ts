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
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { attackTiers, computeAttackZone, computeLegalMoves, computeMoveCosts, hexDistanceKeys } from '../../services/hex-rules';

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
  name: string;
  color: 'white' | 'black';
  hp: number | null;
  hpMax: number | null;
  atk: string;                       // damage per ring, e.g. "26,19"
  def: number | null;
  mv: number | null;                 // full move budget
  vet: number;                       // 0-3
}

/** Internal render model for a single hex. */
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
  /** 1-based reading order over every hex, panels included. */
  num: number;
  /** Smaller hex drawn under an occupying unit. */
  innerPoints: string;
  /** Stats shown around the unit; null when the hex is empty. */
  stats: { hp: number | null; atk: string; def: number | null } | null;
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

/** Radius of the inner hex a unit sits on. Close to HEX_SIZE so only a thin
 *  ring of board shows around it - the stats sit ON the plate, not beside it. */
const PLATE_SIZE = 23;

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
        preserveAspectRatio="xMidYMid meet"
        (mouseleave)="onHexHover(null)"
      >
        <!-- Hex cells -->
        <g *ngFor="let hex of cells; trackBy: trackByKey">
          <polygon
            [attr.points]="hex.points"
            [class.hex-cell]="true"
            [ngClass]="hex.zoneClass"
            [class.hex-selected]="hex.key === selectedHex"
            [class.hex-legal]="legalTargets.has(hex.key)"
            [class.hex-move-preview]="previewMoves.has(hex.key) && !legalTargets.has(hex.key)"
            [class.hex-attack-preview]="previewAttacks.has(hex.key)"
            [class.hex-attack-target]="attackTargets.has(hex.key)"
            [class.hex-last-from]="hex.key === lastMoveFrom"
            [class.hex-last-to]="hex.key === lastMoveTo"
            [class.hex-damaged]="hex.key === lastDamagedHex"
            (click)="onHexClick(hex)"
            (mouseenter)="onHexHover(hex)"
          />
          <!-- Legal-move dot -->
          <circle
            *ngIf="legalTargets.has(hex.key) && !hex.piece"
            [attr.cx]="hex.cx"
            [attr.cy]="hex.cy"
            [attr.r]="6"
            class="legal-dot"
            (click)="onHexClick(hex)"
          />
          <!-- Unit: inner hex plate, icon in the opposite colour, and the
               stats ringed around it (HP top, attack right, move left). -->
          <ng-container *ngIf="hex.piece as pc">
            <polygon
              [attr.points]="hex.innerPoints"
              class="unit-plate"
              [class.plate-white]="pc.color === 'white'"
              [class.plate-black]="pc.color === 'black'"
              [class.plate-selected]="hex.key === selectedHex"
              [class.plate-hovered]="hex.key === hoveredHex"
              (click)="onHexClick(hex)"
              (mouseenter)="onHexHover(hex)"
            />
            <!-- Numbering mode replaces the unit's face with its hex number. -->
            <ng-container *ngIf="!showNumbers">
              <text
                [attr.x]="hex.cx"
                [attr.y]="hex.cy + 1"
                class="piece-symbol"
                [class.piece-white]="pc.color === 'white'"
                [class.piece-black]="pc.color === 'black'"
                [class.piece-selected]="hex.key === selectedHex"
                (click)="onHexClick(hex)"
              >{{ getPieceSymbol(pc) }}</text>
              <text *ngIf="hex.stats?.hp != null"
                    [attr.x]="hex.cx" [attr.y]="hex.cy - 14"
                    class="stat stat-hp" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ statText(hex.stats?.hp) }}</text>
              <text *ngIf="hex.stats?.def != null"
                    [attr.x]="hex.cx - 13" [attr.y]="hex.cy + 14"
                    class="stat stat-def" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ statText(hex.stats?.def) }}</text>
              <text *ngIf="hex.stats?.atk != null"
                    [attr.x]="hex.cx + 13" [attr.y]="hex.cy + 14"
                    class="stat stat-atk" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex"
              >{{ hex.stats?.atk }}</text>
              <!-- Veterancy pips: 1 -> top-left, 2 -> +top-right, 3 -> +bottom -->
              <text *ngIf="hex.vet >= 1" [attr.x]="hex.cx - 14" [attr.y]="hex.cy - 12"
                    class="vet-star" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex">&#9733;</text>
              <text *ngIf="hex.vet >= 2" [attr.x]="hex.cx + 14" [attr.y]="hex.cy - 12"
                    class="vet-star" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex">&#9733;</text>
              <text *ngIf="hex.vet >= 3" [attr.x]="hex.cx" [attr.y]="hex.cy + 16"
                    class="vet-star" [class.on-dark]="pc.color === 'black' && hex.key !== selectedHex">&#9733;</text>
            </ng-container>
          </ng-container>

          <!-- Painted last so it sits ON TOP of the unit plate - on a black
               plate as much as a white one. -->
          <text
            *ngIf="showNumbers"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy"
            class="hex-number"
            [class.on-panel]="hex.filler"
            [class.on-plate]="!!hex.piece"
          >{{ hex.num }}</text>
        </g>
      </svg>

      <!-- Turn / status bar -->
      <!-- Whose turn it is now lives in the History header; the clock is all
           that still needs space on the board. The result is the game room's
           to show: it swaps the board out for its banner when a game ends. -->
      <div class="status-bar" *ngIf="turnTimeLimit > 0 && !endReason">
        <span class="timer-badge" [class.timer-low]="timerSeconds <= 10">
          &#9201; {{ timerSeconds }}s
        </span>
      </div>
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

    .hex-cell {
      fill: #f0d9b5;
      stroke: #b58863;
      stroke-width: 1;
      cursor: pointer;
      transition: fill 0.1s;
    }

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

    /* Preview of another unit's reach: where it could stand ... */
    .hex-move-preview {
      fill: #cfe6cf !important;
    }

    /* ... and where it could not stand but could still strike. */
    .hex-attack-preview {
      fill: #e9a7a2 !important;
    }

    .hex-last-from {
      fill: #cdd26a;
    }

    .hex-last-to {
      fill: #aab23a;
    }

    .hex-damaged {
      fill: #ffb3b3 !important;
      stroke: #cc5555;
      stroke-width: 2;
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

    /* The plate carries the side's colour; the icon takes the opposite one.
       Outlined in the board's own fill so it reads as a thin ring. */
    .unit-plate {
      stroke: #f0d9b5;
      stroke-width: 1;
      cursor: pointer;
    }
    .plate-white { fill: #ffffff; }
    .plate-black { fill: #141414; }
    /* Selection greys the plate, whichever side it belongs to. */
    .plate-selected { fill: #9aa0a6 !important; }
    /* Hover just shadows it, so it reads as a preview and not a selection. */
    .plate-hovered {
      stroke: rgba(0, 0, 0, 0.55);
      stroke-width: 3;
      filter: brightness(0.86);
    }

    .piece-symbol {
      /* As large as fits between the HP number above and the ATK/DEF pair
         below - the plate is 23 and the stats sit at +/-14. */
      font-size: 23px;
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

    .vet-star {
      font-size: 13px;
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

    .stat-hp.on-dark { fill: #4ade80; }
    .stat-atk.on-dark { fill: #f87171; }
    .stat-def.on-dark { fill: #7dd3fc; }

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
  /** Steps the staged unit has left this turn, and which unit that is. */
  @Input() movesLeft: number | null = null;
  @Input() movesLeftFor: string | null = null;
  /**
   * One-turn stat boosts by hex. Only `mov` matters here - it widens the
   * flood fill for a unit that has not taken its first step yet, after which
   * `movesLeft` carries the same bonus.
   */
  @Input() unitBuffs: Record<string, { mov: number }> = {};
  /** Seconds allowed per turn (0 = unlimited). */
  @Input() turnTimeLimit = 0;
  /** ISO timestamp when the current turn started. */
  @Input() turnStartedAt = '';
  /** Game config (for legal-move preview). */
  @Input() config: any = null;
  /** Overlay each battlefield hex with its reading-order number. */
  @Input() showNumbers = false;
  /** Solo play: this client drives both sides, not just its own colour. */
  @Input() controlAllSides = false;
  /** Colour of whoever's turn it is - what controlAllSides selects with. */
  @Input() turnColor: 'white' | 'black' | '' = '';

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
  /** Same payload for the hex under the cursor - a preview, not a selection. */
  @Output() hexHovered = new EventEmitter<SelectedUnit | null>();

  // -- Internal state -------------------------------------------------

  cells: HexCell[] = [];
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
  lastMoveFrom = '';
  lastMoveTo = '';
  lastDamagedHex = '';  // hex that was attacked but unit survived
  timerSeconds = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  get isMyTurn(): boolean {
    return this.currentTurn === this.username;
  }

  /** Which side this client may pick up right now. */
  get activeColor(): 'white' | 'black' | '' {
    return this.controlAllSides ? this.turnColor : this.myColor;
  }

  // -- Lifecycle ------------------------------------------------------

  ngOnInit(): void {
    this.startTimer();
  }

  ngOnDestroy(): void {
    this.stopTimer();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Recalculate cells whenever board, radius, or config (orientation) changes
    if (changes['boardState'] || changes['radius'] || changes['config']) {
      this.buildCells();
    }
    // A move ends the ability to move again, but the selection itself sticks
    // until another unit is clicked - the Unit panel stays pinned to it.
    if (changes['turnNumber'] && !changes['turnNumber'].firstChange) {
      this.clearTargets();
    }
    // The board just changed underneath the selection: re-read the stats from
    // the new cell so a piece that moved keeps its panel, and drop a selection
    // whose unit is gone.
    if (changes['boardState'] && this.selectedHex) {
      const cell = this.cells.find(c => c.key === this.selectedHex);
      if (!cell?.piece) this.selectedHex = null;
      this.hexSelected.emit(cell?.piece ? this.describe(cell) : null);
    }
    // A boost landing mid-turn widens the reach of a unit already selected.
    if (changes['boardState'] || changes['config'] || changes['radius'] || changes['unitBuffs']) {
      this.invalidatePreview();
      // A staged step moved the unit: its remaining reach moved with it.
      this.refreshTargets();
    }
    // Restart timer when turn changes
    if (changes['turnStartedAt'] || changes['turnTimeLimit']) {
      this.startTimer();
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
      this.lastMoveFrom = this.selectedHex;
      this.lastMoveTo = hex.key;
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
          this.lastMoveFrom = this.selectedHex;
          this.lastMoveTo = hex.key;
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
              atk: attackText(piece.unit_id, this.config),
              def: twoDigits(def?.defense),
            }
          : null,
        // Keyed on the unit, not the hex: veterancy that changed every time
        // a unit walked would flicker the ability slots it gates.
        vet: piece ? placeholderVet(piece.uid ?? key, piece.unit_id) : 0,
        filler: !c.onBattlefield,
        panel: c.onBattlefield ? '' : panelOf(c.x, c.y),
        // Four panels around the hexagon, one per corner.
        zoneClass: c.onBattlefield ? '' : `hex-filler panel-${panelOf(c.x, c.y)}`,
        num: i + 1,
      };
    });

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

  /** Walk a reserve to another hex of its own panel - local, and free. */
  private moveReserve(from: string, to: string): void {
    this.reserves[to] = this.reserves[from];
    delete this.reserves[from];
    this.selectedHex = to;
    this.buildCells();
    const cell = this.cells.find(c => c.key === to);
    if (cell) this.emitSelected(cell);
    this.refreshTargets();
  }

  // -- Helpers --------------------------------------------------------

  /** Two-character stat, exposed for the template. */
  statText = statText;

  /** Hex currently under the cursor, for the hover shadow. */
  hoveredHex: string | null = null;

  /** Hovering previews a unit in the Unit panel without selecting it. */
  onHexHover(hex: HexCell | null): void {
    this.hoveredHex = hex && hex.piece ? hex.key : null;
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
  }

  /**
   * What the selected unit may do from where it now stands: hexes still
   * inside its remaining move budget, and enemies inside its attack range.
   * Recomputed after every staged step, because both change as it walks.
   */
  private refreshTargets(canDrive = this.canDriveNow()): void {
    this.clearTargets();
    const key = this.selectedHex;
    if (!key || !this.config || !canDrive) return;
    const cell = this.cells.find(c => c.key === key);
    if (!cell?.piece || cell.piece.color !== this.activeColor) return;

    // A reserve is confined to its own panel, and shuffling it is not the
    // turn's action - so the staging lock below does not apply to it.
    const zone = cell.panel ? this.panelZones.get(cell.panel) : undefined;
    if (zone) {
      if (!this.controlAllSides && !this.isMyTurn) return;
    } else {
      if (!canDrive) return;
      // One unit acts per turn: once something is staged, nothing else may be
      // driven, or the staged origin and the unit on screen part ways.
      if (this.movesLeftFor && key !== this.movesLeftFor) return;
    }

    const [sq, sr] = key.split(',').map(Number);
    const budget = this.budgetFor(cell);
    this.moveCosts = computeMoveCosts(
      this.occupancy, sq, sr, this.config, this.radius, budget, zone,
    );
    this.legalTargets = new Set(this.moveCosts.keys());

    const range: number = this.config?.units?.[cell.piece.unit_id]?.attackRange ?? 1;
    for (const other of this.cells) {
      if (!other.piece || other.piece.color === cell.piece.color) continue;
      // Nothing reaches across the panel wall, in either direction.
      if (other.panel !== cell.panel) continue;
      if (hexDistanceKeys(key, other.key) <= range) this.attackTargets.add(other.key);
    }
  }

  /**
   * Steps the unit at `key` may spend: what is left of a staged turn, or its
   * own move stat plus any boost. `undefined` lets the rules read the stat.
   */
  private budgetFor(cell: HexCell): number | undefined {
    if (cell.key === this.movesLeftFor) return this.movesLeft ?? undefined;
    const bonus = this.unitBuffs[this.uidOf(cell)]?.mov ?? 0;
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
    const cell = key ? this.cells.find(c => c.key === key) : null;
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
    // The strike layer sits just outside whatever movement is left.
    this.previewAttacks = computeAttackZone(
      key, this.previewMoves, this.config, cell.piece.unit_id, this.radius, zone,
    );
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
      name: def?.name ?? pc.unit_id,
      color: pc.color,
      hp: twoDigits(pc.hp),
      hpMax: twoDigits(pc.max_hp ?? def?.hp),
      atk: hex.stats?.atk ?? '',
      def: hex.stats?.def ?? null,
      mv: twoDigits(def?.move),
      vet: hex.vet,
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

  // -- Timer ----------------------------------------------------------

  private startTimer(): void {
    this.stopTimer();
    if (!this.turnTimeLimit || this.turnTimeLimit <= 0 || !this.turnStartedAt || this.endReason) {
      this.timerSeconds = 0;
      return;
    }
    this.updateTimerTick();
    this.timerInterval = setInterval(() => {
      this.updateTimerTick();
      this.cdr.markForCheck();
    }, 500);
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private updateTimerTick(): void {
    const elapsed = (Date.now() - new Date(this.turnStartedAt).getTime()) / 1000;
    this.timerSeconds = Math.max(0, Math.round(this.turnTimeLimit - elapsed));
  }
}
