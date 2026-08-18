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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PieceData {
  unit_id: string;
  color: 'white' | 'black';
  hp: number;
  max_hp: number;
}

type BoardState = Record<string, PieceData>;

/** Internal render model for a single hex. */
interface HexCell {
  q: number;
  r: number;
  key: string;          // "q,r"
  cx: number;           // SVG centre X
  cy: number;           // SVG centre Y
  points: string;       // SVG polygon points for the hex
  piece: PieceData | null;
  /** Outside the radius-N battlefield - drawn to square off the board, inert. */
  filler: boolean;
  /** '' for battlefield, else 'hex-filler panel-xx' picking the panel colour. */
  zoneClass: string;
  /** 1-based reading order across the battlefield; 0 for filler hexes. */
  num: number;
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
function hexPoints(cx: number, cy: number, orientation: BoardOrientation): string {
  const startDeg = orientation === 'vertex-up' ? 0 : 30; // pointy-top corners are offset 30°
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i + startDeg);
    const px = cx + HEX_SIZE * Math.cos(angle);
    const py = cy + HEX_SIZE * Math.sin(angle);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return pts.join(' ');
}

// ---------------------------------------------------------------------------
// Legal-move computation helpers (client-side preview)
//
// Fully config-driven: unit ids are opaque labels. Movement comes from the
// unit's single `move` stat - a flood fill through the six hex neighbours,
// through empty hexes only. A unit can never move through or onto an
// occupied hex (ally or enemy). Mirrors the server engine in
// server/game/engine/move_validator.py.
// ---------------------------------------------------------------------------

const HEX_DIRS: [number, number][] = [
  [+1, 0], [-1, 0], [+1, -1], [0, -1], [0, 1], [-1, 1],
];

function isInsideBoard(q: number, r: number, radius: number): boolean {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius;
}

/** Compute legal destinations for the piece at (sq,sr). */
function computeLegalMoves(
  boardState: BoardState,
  sq: number, sr: number,
  config: any,
  radius: number,
): Set<string> {
  const targets = new Set<string>();
  const piece = boardState[`${sq},${sr}`];
  if (!piece) return targets;
  const unitDef = config?.units?.[piece.unit_id];
  const moveRange: number = unitDef?.move ?? 0;
  if (moveRange <= 0) return targets;

  const visited = new Set<string>([`${sq},${sr}`]);
  let frontier: [number, number][] = [[sq, sr]];

  for (let step = 0; step < moveRange; step++) {
    const nextFrontier: [number, number][] = [];
    for (const [cq, cr] of frontier) {
      for (const [dq, dr] of HEX_DIRS) {
        const nq = cq + dq, nr = cr + dr;
        const key = `${nq},${nr}`;
        if (visited.has(key) || !isInsideBoard(nq, nr, radius)) continue;
        visited.add(key);
        if (boardState[key]) continue; // occupied - blocks entry and passage
        targets.add(key);
        nextFrontier.push([nq, nr]);
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }
  return targets;
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
      >
        <!-- Hex cells -->
        <g *ngFor="let hex of cells; trackBy: trackByKey">
          <polygon
            [attr.points]="hex.points"
            [class.hex-cell]="true"
            [ngClass]="hex.zoneClass"
            [class.hex-selected]="hex.key === selectedHex"
            [class.hex-legal]="legalTargets.has(hex.key)"
            [class.hex-last-from]="hex.key === lastMoveFrom"
            [class.hex-last-to]="hex.key === lastMoveTo"
            [class.hex-damaged]="hex.key === lastDamagedHex"
            (click)="onHexClick(hex)"
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
          <!-- Hex number (toggled from the game room) -->
          <text
            *ngIf="showNumbers"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy - 10"
            class="hex-number"
            [class.on-panel]="hex.filler"
          >{{ hex.num }}</text>
          <!-- Piece symbol -->
          <text
            *ngIf="hex.piece"
            [attr.x]="hex.cx"
            [attr.y]="hex.cy + 5"
            class="piece-symbol"
            [class.piece-white]="hex.piece.color === 'white'"
            [class.piece-black]="hex.piece.color === 'black'"
            (click)="onHexClick(hex)"
          >{{ getPieceSymbol(hex.piece) }}</text>
        </g>
      </svg>

      <!-- Turn / status bar -->
      <div class="status-bar" *ngIf="currentTurn || endReason">
        <span *ngIf="!endReason">
          Turn {{ turnNumber }} -
          <strong [class.my-turn]="isMyTurn">{{ isMyTurn ? 'Your move' : currentTurn + "'s move" }}</strong>
          <span *ngIf="turnTimeLimit > 0" class="timer-badge" [class.timer-low]="timerSeconds <= 10">
            ⏱ {{ timerSeconds }}s
          </span>
        </span>
        <span *ngIf="endReason" class="game-over-label">
          {{ endReasonLabel }}
        </span>
      </div>

      <!-- Post-game overlay -->
      <div class="post-game-overlay" *ngIf="endReason">
        <div class="overlay-card">
          <h2>{{ winner ? (winner === username ? 'You won!' : 'You lost!') : 'Draw' }}</h2>
          <p>{{ endReasonLabel }}</p>
        </div>
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
      cursor: default;
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

    .piece-symbol {
      font-size: 22px;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      user-select: none;
    }

    .piece-white {
      fill: #ffffff;
      stroke: #333333;
      stroke-width: 0.5;
    }

    .piece-black {
      fill: #222222;
      stroke: #666666;
      stroke-width: 0.5;
    }

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

    .game-over-label {
      font-weight: bold;
      color: #ffa726;
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

    .post-game-overlay {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      background: rgba(0,0,0,0.55);
      border-radius: 6px;
      z-index: 10;
    }
    .overlay-card {
      background: #1e1e2e;
      border: 2px solid #ffa726;
      border-radius: 12px;
      padding: 24px 40px;
      text-align: center;
      color: #e0e0e0;
    }
    .overlay-card h2 {
      margin: 0 0 8px;
      font-size: 28px;
      color: #ffa726;
    }
    .overlay-card p {
      margin: 0;
      font-size: 15px;
      color: #bbb;
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
  /** Winner username (or ''). */
  @Input() winner = '';
  /** End reason (or ''). */
  @Input() endReason = '';
  /** Whether input is enabled (it's my turn and game is active). */
  @Input() interactive = true;
  /** Seconds allowed per turn (0 = unlimited). */
  @Input() turnTimeLimit = 0;
  /** ISO timestamp when the current turn started. */
  @Input() turnStartedAt = '';
  /** Game config (for legal-move preview). */
  @Input() config: any = null;
  /** Overlay each battlefield hex with its reading-order number. */
  @Input() showNumbers = false;

  // -- Outputs --------------------------------------------------------

  /** Emitted when the player makes a move: {from: "q,r", to: "q,r"}. */
  @Output() moveMade = new EventEmitter<{ from: string; to: string }>();

  // -- Internal state -------------------------------------------------

  cells: HexCell[] = [];
  viewBox = '0 0 100 100';

  selectedHex: string | null = null;
  legalTargets = new Set<string>();
  lastMoveFrom = '';
  lastMoveTo = '';
  lastDamagedHex = '';  // hex that was attacked but unit survived
  timerSeconds = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  get isMyTurn(): boolean {
    return this.currentTurn === this.username;
  }

  get endReasonLabel(): string {
    const isWinner = this.winner === this.username;
    switch (this.endReason) {
      case 'elimination': return isWinner ? 'You won - all enemies eliminated!' : 'You lost - all units eliminated';
      case 'resign':      return isWinner ? 'You won by resignation' : 'You lost by resignation';
      case 'timeout':     return isWinner ? 'You won - opponent timed out' : 'You lost - time out';
      case 'disconnect':  return isWinner ? 'You won - opponent disconnected' : 'You lost - disconnected';
      case 'draw_agreed': return 'Draw by agreement';
      case 'draw_max_turns': return 'Draw - max turns reached';
      default:            return 'Game over';
    }
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
    // If a move was just made (turnNumber changed), clear selection
    if (changes['turnNumber'] && !changes['turnNumber'].firstChange) {
      this.selectedHex = null;
      this.legalTargets.clear();
    }
    // Restart timer when turn changes
    if (changes['turnStartedAt'] || changes['turnTimeLimit']) {
      this.startTimer();
    }
  }

  // -- Click handler --------------------------------------------------

  onHexClick(hex: HexCell): void {
    // Filler hexes are off the battlefield - nothing to select.
    if (hex.filler) {
      return;
    }
    if (!this.interactive || !this.isMyTurn || this.endReason) {
      return;
    }

    // If clicking a legal target -> emit the move
    if (this.selectedHex && this.legalTargets.has(hex.key)) {
      this.lastMoveFrom = this.selectedHex;
      this.lastMoveTo = hex.key;
      this.moveMade.emit({ from: this.selectedHex, to: hex.key });
      this.selectedHex = null;
      this.legalTargets.clear();
      return;
    }

    // If clicking own piece -> select it and compute legal moves
    if (hex.piece && hex.piece.color === this.myColor) {
      this.selectedHex = hex.key;
      // Compute client-side legal-move preview
      if (this.config) {
        const [sq, sr] = hex.key.split(',').map(Number);
        this.legalTargets = computeLegalMoves(
          this.boardState, sq, sr, this.config, this.radius
        );
      } else {
        this.legalTargets.clear();
      }
      return;
    }

    // If clicking elsewhere while selected and it's not a legal target, deselect
    if (this.selectedHex) {
      if (hex.key !== this.selectedHex) {
        // If we have legal targets computed, only move to legal targets (already handled above).
        // If no legal targets were computed (no config), submit anyway (server validates).
        if (this.legalTargets.size === 0 && !this.config) {
          this.lastMoveFrom = this.selectedHex;
          this.lastMoveTo = hex.key;
          this.moveMade.emit({ from: this.selectedHex, to: hex.key });
        }
        this.selectedHex = null;
        this.legalTargets.clear();
        return;
      }
      // Clicking same hex deselects
      this.selectedHex = null;
      this.legalTargets.clear();
    }
  }

  // -- Cell building --------------------------------------------------

  /** Board orientation from config (cosmetic); the default board is edge-up. */
  get orientation(): BoardOrientation {
    return this.config?.board?.orientation === 'vertex-up' ? 'vertex-up' : 'edge-up';
  }

  private buildCells(): void {
    const cells: HexCell[] = [];
    const r = this.radius;
    const orientation = this.orientation;

    // Square off the board: fill every hex whose centre falls inside the
    // battlefield's own centre-bounds, symmetric about both axes. Fill by row
    // *count* instead and the half-cell stagger on odd rows shifts the whole
    // block sideways, leaving one flank a column short.
    let limitX = 0, limitY = 0;
    for (let q = -r; q <= r; q++) {
      for (let ri = -r; ri <= r; ri++) {
        if (Math.max(Math.abs(q), Math.abs(ri), Math.abs(q + ri)) > r) continue;
        const { x, y } = axialToPixel(q, ri, orientation);
        limitX = Math.max(limitX, Math.abs(x));
        limitY = Math.max(limitY, Math.abs(y));
      }
    }
    // ...then out by HALF a column on each flank. Odd rows are staggered half a
    // cell, so half a step reaches them and not the even rows: every row ends
    // up flush at the same outer edge, instead of even rows jutting out past
    // odd ones. A full step would add a cell to every row and put that
    // alternating overhang back.
    limitX += Math.abs(axialToPixel(1, 0, orientation).x - axialToPixel(0, 0, orientation).x) / 2;

    const EPS = 0.001; // float slack - these are products of sqrt(3)
    const scan = 2 * r + 3;
    for (let q = -scan; q <= scan; q++) {
      for (let ri = -scan; ri <= scan; ri++) {
        const { x, y } = axialToPixel(q, ri, orientation);
        const onBattlefield = Math.max(Math.abs(q), Math.abs(ri), Math.abs(q + ri)) <= r;
        // The bounds trim filler ONLY. Guarding on !onBattlefield means no
        // amount of tuning limitX/limitY can start shaving hexes off the board
        // itself - which is otherwise exactly what narrowing them does.
        if (!onBattlefield && (Math.abs(x) > limitX + EPS || Math.abs(y) > limitY + EPS)) continue;

        const key = `${q},${ri}`;
        cells.push({
          q,
          r: ri,
          key,
          cx: x,
          cy: y,
          points: hexPoints(x, y, orientation),
          // Filler hexes are never occupied - nothing is played on them yet.
          piece: onBattlefield ? (this.boardState[key] || null) : null,
          filler: !onBattlefield,
          // Four panels around the hexagon, one per corner.
          zoneClass: onBattlefield
            ? ''
            : `hex-filler panel-${y < 0 ? 't' : 'b'}${x < 0 ? 'l' : 'r'}`,
          num: 0,
        });
      }
    }

    // Reading order over EVERY hex, panels included: 1 at the very top-left of
    // the top-left panel, rightwards along each row, then down, ending at the
    // bottom-right of the bottom-right panel. Rows share a cy exactly, so a
    // (cy, cx) sort is the row-by-row order.
    [...cells]
      .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
      .forEach((cell, i) => { cell.num = i + 1; });

    this.cells = cells;

    // Compute SVG viewBox to fit all hexes
    if (cells.length > 0) {
      const xs = cells.map(c => c.cx);
      const ys = cells.map(c => c.cy);
      const pad = VIEWBOX_PADDING;
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      const maxX = Math.max(...xs) + pad;
      const maxY = Math.max(...ys) + pad;
      const w = maxX - minX;
      const h = maxY - minY;
      this.viewBox = `${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
    }
  }

  // -- Helpers --------------------------------------------------------

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
