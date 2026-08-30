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

  it('swells the unit once per cast, however many land on it', () => {
    // A CSS class only restarts an animation if a frame is rendered with it
    // off, and between two beats there is no such frame to rely on - three
    // casts on one unit read as a single long swell. Run on the element, each
    // beat starts over on its own.
    const group = () => fixture.nativeElement.querySelector('[data-pop="0,0"]') as SVGGElement;
    expect(group()).not.toBeNull();
    expect(group().getAnimations().length).toBe(0);

    const pop = (hostile: boolean) => (board as any).popUnit('0,0', hostile, 400);
    pop(false);
    pop(false);
    pop(true);
    // Three casts, three animations - not one that swallowed the others.
    expect(group().getAnimations().length).toBe(3);

    // A boost swells and something taken away shrinks.
    const frames = group().getAnimations()
      .map(a => ((a as any).effect.getKeyframes()[1].transform as string));
    expect(frames.filter(f => f.includes('1.55')).length).toBe(2);
    expect(frames.filter(f => f.includes('0.55')).length).toBe(1);
  });

  it('has nothing to swell for an ability that names no hex', () => {
    // A universal ability shines in the panel alone.
    expect(() => (board as any).popUnit('', false, 400)).not.toThrow();
    expect(fixture.nativeElement.querySelectorAll('[data-pop] ').length).toBeGreaterThan(0);
  });

  it('drops the rest of an attack when a new turn interrupts it', async () => {
    // Cancelling resolves the promise the chain is waiting on; it does not
    // unwind the chain. Without a token check between beats the abandoned
    // attack lunges again and flashes a hex belonging to whatever replaced it.
    const attack = [{ kind: 'attack' as const, from: '0,0', to: '3,0' }];
    board.playback = attack;
    board.ngOnChanges({ playback: new SimpleChange([], attack, false) });
    await new Promise(resolve => setTimeout(resolve, 60));   // mid-lunge

    board.playback = [];
    board.ngOnChanges({ playback: new SimpleChange(attack, [], false) });
    // Past the second lunge and into where the hit flash would have been.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(board.hitHex).toBe('');
    expect(board.mover).toBeNull();
  });

  it('flies a copy of the unit while a committed move plays', async () => {
    const steps = [{ kind: 'move' as const, from: '0,0', to: '3,0' }];
    board.playback = steps;
    board.ngOnChanges({ playback: new SimpleChange([], steps, false) });

    // Mid-flight: the copy is up and the hex it lands on is holding its place.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(board.mover).not.toBeNull();
    expect(board.isMoving('3,0')).toBeTrue();

    // And it puts itself away when the beat ends.
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(board.mover).toBeNull();
    expect(board.isMoving('3,0')).toBeFalse();
  });

  it('shines the hex an ability lands on, then stops', async () => {
    const steps = [{ kind: 'ability' as const, from: '0,0', to: '3,0' }];
    board.playback = steps;
    board.ngOnChanges({ playback: new SimpleChange([], steps, false) });

    // Nothing starts inside ngOnChanges. The runner announces each beat as it
    // begins, and the room lights the slot that cast it - but the room's view
    // is checked before this child's, so a flag raised mid-pass went up and
    // came down inside one task and never rendered. A staged cast is one beat,
    // which is why it only ever showed on the multi-beat recap.
    expect(board.glowHex).toBe('');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(board.glowHex).toBe('3,0');

    // A cast runs a full second now - long enough to follow, so long enough
    // that a spec has to wait it out.
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(board.glowHex).toBe('');
  });

  it('keeps a zone readable under a hex lit for reach', () => {
    const zoned = board.cells.filter(c => c.zoneClass === 'zone');
    expect(zoned.length).toBeGreaterThan(0);

    const washes = fixture.nativeElement.querySelectorAll('.zone-wash');
    // A wash over the hex, not a fill under it: every reach colour carries
    // !important, so as a fill the blue vanished the moment the hex lit up.
    expect(washes.length).toBe(zoned.length);
    // And it never eats a click meant for the hex beneath it.
    expect(getComputedStyle(washes[0]).pointerEvents).toBe('none');
  });

  it('paints five separate zones of the same size on a full-size board', () => {
    // The shipped radius: on the tiny board these tests otherwise use, five
    // patches two rings across have nowhere to go.
    board.radius = 11;
    board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });

    const zoned = board.cells.filter(hex => hex.zoneClass === 'zone');
    expect(zoned.every(hex => !hex.filler)).toBeTrue();  // never on the panels
    // Five patches of nineteen (a hex plus two rings). A hex can only carry
    // the class once, so the full count is also the proof they do not overlap
    // and that none of them ran off the board.
    expect(zoned.length).toBe(5 * 19);
  });

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

  it('forecasts both halves of a trade before it is made', () => {
    // Adjacent: the archer (4 atk) hits the guard (2 def) for 2, and the
    // guard (3 atk) counters the archer (1 def) for 2.
    const trade: Record<string, any> = {
      '0,0': { unit_id: 'archer', color: 'white', hp: 5, max_hp: 5 },
      '1,0': { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9 },
    };
    board.boardState = trade;
    board.ngOnChanges({ boardState: new SimpleChange(boardState, trade, false) });
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';
    board.onHexClick(cell('0,0'));

    expect(board.forecastDamage('1,0')).toBeNull();  // nothing hovered yet

    board.onHexHover(cell('1,0'));
    expect(board.forecastDamage('1,0')).toBe('-2');  // dealt by our strike
    expect(board.forecastDamage('0,0')).toBe('-2');  // taken from the counter
    expect(board.wouldDie('1,0')).toBeFalse();
  });

  it('forecasts a ranged strike that draws no counter', () => {
    // The archer reaches two rings; the guard reaches one, so nothing comes
    // back and the flight path spans the gap between the two hexes.
    const trade: Record<string, any> = {
      '0,0': { unit_id: 'archer', color: 'white', hp: 5, max_hp: 5 },
      '2,0': { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9 },
    };
    board.boardState = trade;
    board.ngOnChanges({ boardState: new SimpleChange(boardState, trade, false) });
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';
    board.onHexClick(cell('0,0'));

    board.onHexHover(cell('2,0'));
    expect(board.forecastDamage('2,0')).not.toBeNull();
    expect(board.forecastDamage('0,0')).toBeNull();  // out of the guard's reach
  });

  it('marks a kill with a skull, on whichever side would die', () => {
    const trade: Record<string, any> = {
      '0,0': { unit_id: 'archer', color: 'white', hp: 1, max_hp: 5 },
      '1,0': { unit_id: 'guard', color: 'black', hp: 2, max_hp: 9 },
    };
    board.boardState = trade;
    board.ngOnChanges({ boardState: new SimpleChange(boardState, trade, false) });
    board.interactive = true;
    board.controlAllSides = true;
    board.turnColor = 'white';
    board.onHexClick(cell('0,0'));
    board.onHexHover(cell('1,0'));

    // 2 damage on 2 HP kills it - and a dead unit never counters, so we live.
    expect(board.wouldDie('1,0')).toBeTrue();
    expect(board.forecastDamage('1,0')).toBe('-2');
    expect(board.wouldDie('0,0')).toBeFalse();
    expect(board.forecastDamage('0,0')).toBeNull();
  });

  it('draws single-digit stats without a leading zero', () => {
    expect(board.statText(4)).toBe('4');
    expect(board.statText(12)).toBe('12');
    expect(board.statText(null)).toBe('');
  });
});
