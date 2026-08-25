import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SimpleChange } from '@angular/core';
import { GameBoardComponent } from './game-board.component';

/**
 * The reach preview and the stat glyphs are what the player reads off the
 * board, so they get a check: hovering any unit - including one you cannot
 * drive - must light up where it can go and, separately, where it can only
 * strike.
 */
describe('GameBoardComponent reach preview', () => {
  let fixture: ComponentFixture<GameBoardComponent>;
  let board: GameBoardComponent;

  const config = {
    board: { radius: 4, orientation: 'edge-up' },
    units: {
      archer: { id: 'archer', name: 'Archer', symbol: 'A', move: 1, hp: 5, attack: 4, defense: 1, attackRange: 2 },
      guard: { id: 'guard', name: 'Guard', symbol: 'G', move: 1, hp: 9, attack: 3, defense: 2, attackRange: 1 },
      scout: { id: 'scout', name: 'Scout', symbol: 'S', move: 3, hp: 6, attack: 5, defense: 1, attackRange: 1 },
    },
  };
  const boardState: Record<string, any> = {
    '0,0': { unit_id: 'archer', color: 'white', hp: 5, max_hp: 5 },
    '3,0': { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9 },
    '-3,0': { unit_id: 'scout', color: 'white', hp: 6, max_hp: 6 },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [GameBoardComponent] }).compileComponents();
    fixture = TestBed.createComponent(GameBoardComponent);
    board = fixture.componentInstance;
    board.boardState = boardState;
    board.config = config;
    board.radius = 4;
    board.ngOnChanges({
      boardState: new SimpleChange(null, boardState, true),
      config: new SimpleChange(null, config, true),
      radius: new SimpleChange(null, 4, true),
    });
    fixture.detectChanges();
  });

  const cell = (key: string) => board.cells.find(c => c.key === key)!;

  it('splits a hovered unit into where it can stand and where it can only strike', () => {
    board.onHexHover(cell('0,0'));

    // move 1: the six neighbours, minus none (all empty here).
    expect(board.previewMoves.size).toBe(6);
    expect(board.previewMoves.has('1,0')).toBeTrue();

    // attackRange 2 from any of those tiles reaches three hexes out.
    expect(board.previewAttacks.has('3,0')).toBeTrue();
    expect(board.previewAttacks.has('4,0')).toBeFalse(); // off a radius-4 board in that direction

    // The two layers never overlap - a hex is one colour or the other.
    for (const key of board.previewAttacks) {
      expect(board.previewMoves.has(key)).withContext(key).toBeFalse();
    }
  });

  it('previews the enemy unit too, with its own shorter reach', () => {
    board.onHexHover(cell('3,0'));

    expect(board.previewMoves.has('2,0')).toBeTrue();
    // Range 1 from a tile it can reach - not the archer's two.
    expect(board.previewAttacks.has('1,0')).toBeTrue();
    expect(board.previewAttacks.has('0,0')).toBeFalse();
  });

  it('falls back to the selection when the cursor leaves, and clears with it', () => {
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';
    board.onHexClick(cell('0,0'));
    board.onHexHover(cell('3,0'));
    const enemyReach = new Set(board.previewAttacks);

    board.onHexHover(null);
    expect(board.previewAttacks).not.toEqual(enemyReach);
    expect(board.previewMoves.has('1,0')).toBeTrue(); // back to the selected archer
  });

  it('shrinks the preview to the movement the unit has left', () => {
    // The scout has move 3. Walk two of them and one ring of green is left,
    // with the strike layer sitting just outside it - not out at ring 4.
    board.onHexHover(cell('-3,0'));
    expect(board.previewMoves.has('0,0')).toBeFalse(); // occupied
    expect(board.previewMoves.has('-1,0')).toBeTrue(); // three steps: in range

    board.movesLeftFor = '-3,0';
    board.movesLeft = 1;
    board.onHexHover(null);
    board.onHexHover(cell('-3,0'));

    expect(board.previewMoves.has('-2,0')).toBeTrue();
    expect(board.previewMoves.has('-1,0')).toBeFalse();
    expect(board.previewAttacks.has('-1,0')).toBeTrue();
    expect(board.previewAttacks.has('0,0')).toBeFalse();
  });

  it('will not drive a second unit once one is staged', () => {
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';
    // The scout is mid-turn with a step to spare.
    board.movesLeftFor = '-3,0';
    board.movesLeft = 1;

    board.onHexClick(cell('0,0'));  // a different friendly unit

    expect(board.selectedHex).toBe('0,0');   // still inspectable
    expect(board.legalTargets.size).toBe(0); // but not drivable
    expect(board.attackTargets.size).toBe(0);
  });

  it('keeps a reserve inside its own panel', () => {
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';

    // The bottom panels are white's; every panel is dealt a placeholder squad.
    const reserve = board.cells.find(c => c.panel.startsWith('b') && c.piece)!;
    expect(reserve).withContext('a reserve was dealt').toBeTruthy();

    board.onHexClick(reserve);

    expect(board.selectedHex).toBe(reserve.key);
    expect(board.legalTargets.size).toBeGreaterThan(0);
    for (const key of board.legalTargets) {
      expect(cell(key).panel).withContext(key).toBe(reserve.panel);
    }
    // And nothing it could strike sits outside the panel either.
    for (const key of board.previewAttacks) {
      expect(cell(key).panel).withContext(key).toBe(reserve.panel);
    }
  });

  it('spends a +MOV boost as real steps, not just a number', () => {
    // The archer has move 1, so three hexes out is nowhere near it...
    board.onHexHover(cell('0,0'));
    expect(board.previewMoves.has('0,2')).toBeFalse();

    // ... until an ability lends it two more.
    board.unitBuffs = { '0,0': { mov: 2 } };
    board.onHexHover(null);
    board.onHexHover(cell('0,0'));
    expect(board.previewMoves.has('0,2')).toBeTrue();
  });

  it('reports a board change as a refresh, not as a click', () => {
    // The game room casts an armed ability on whatever hexClicked names. If a
    // redraw counted as a click, an ability would fire itself the moment the
    // opponent moved.
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';
    board.onHexClick(cell('0,0'));

    const selected: any[] = [];
    const clicked: any[] = [];
    board.hexSelected.subscribe(u => selected.push(u));
    board.hexClicked.subscribe(u => clicked.push(u));

    const moved = { ...boardState, '2,0': boardState['3,0'] };
    delete (moved as any)['3,0'];
    board.boardState = moved;
    board.ngOnChanges({ boardState: new SimpleChange(boardState, moved, false) });

    expect(selected.length).toBe(1);   // the panel is refreshed ...
    expect(clicked.length).toBe(0);    // ... but nobody picked anything
  });

  it('draws single-digit stats without a leading zero', () => {
    expect(board.statText(4)).toBe('4');
    expect(board.statText(12)).toBe('12');
    expect(board.statText(null)).toBe('');
  });
});
