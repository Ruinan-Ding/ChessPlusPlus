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
    // Past the initialization, where nobody attacks: these are the strike
    // previews, and turn 0 would suppress every one of them.
    board.turnNumber = 20;
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
    await new Promise(resolve => setTimeout(resolve, 120));  // mid-lunge

    board.playback = [];
    board.ngOnChanges({ playback: new SimpleChange(attack, [], false) });
    // Past the second lunge and into where the hit flash would have been.
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(board.hitHex).toBe('');
    expect(board.mover).toBeNull();
  });

  it('flies a copy of the unit while a committed move plays', async () => {
    const steps = [{ kind: 'move' as const, from: '0,0', to: '3,0' }];
    board.playback = steps;
    board.ngOnChanges({ playback: new SimpleChange([], steps, false) });

    // Mid-flight: the copy is up and the hex it lands on is holding its place.
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(board.mover).not.toBeNull();
    expect(board.isMoving('3,0')).toBeTrue();

    // And it puts itself away when the beat ends.
    await new Promise(resolve => setTimeout(resolve, 1100));
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

    // A cast runs two full seconds now - long enough to follow, so long
    // enough that a spec has to wait it out.
    await new Promise(resolve => setTimeout(resolve, 2400));
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

  it('tints the three rows nearest each edge as home ground', () => {
    // Radius 4, so the setup rows are |r| >= 2 - three of them a side, the
    // same count the shipped radius-11 board gives r = 9, 10, 11.
    expect(cell('0,2').home).toBe('mine');
    expect(cell('0,4').home).toBe('mine');
    expect(cell('0,-2').home).toBe('theirs');
    // The rows between the two are nobody's.
    expect(cell('0,1').home).toBe('');
    expect(cell('0,0').home).toBe('');
  });

  /**
   * The base is the red pair - each player's left plane. Its units walk and
   * nothing else: no attack, their own MOV a turn, and only three of them
   * moved per turn.
   */
  describe('base panel', () => {
    const anyBoard = () => board as any;
    const BASE = new Set(['bl', 'tr']);
    /** X of the arrow's tip - its first point is the head. */
    const arrowTipX = (hex: any) => Number(board.arrowPoints(hex).split(' ')[0].split(',')[0]);
    /** A base hex with a reserve on it, and the cell for it. */
    const baseCell = () => board.cells.find(
      c => c.panel === 'bl' && !!c.piece)!;

    beforeEach(() => {
      board.interactive = true;
      board.controlAllSides = true;
      board.turnColor = 'white';
    });

    it('offers a base unit no attack, however close the target', () => {
      const cell = baseCell();
      // Drop an enemy on the nearest free hex of the same panel, so the only
      // thing that could be stopping the swing is the base rule.
      const zone: Set<string> = anyBoard().panelZones.get('bl');
      const [q, r] = cell.key.split(',').map(Number);
      const spot = [[1, 0], [-1, 0], [1, -1], [0, -1], [0, 1], [-1, 1]]
        .map(([dq, dr]) => `${q + dq},${r + dr}`)
        .find(k => zone.has(k) && !anyBoard().reserves[k]);
      expect(spot).toBeDefined();
      anyBoard().reserves[spot!] = {
        unit_id: 'guard', color: 'black', hp: 9, max_hp: 9, uid: 'intruder',
      };
      anyBoard().buildCells();

      board.onHexClick(anyBoard().cellsByKey.get(cell.key));
      expect(board.attackTargets.size).toBe(0);
    });

    it('spends a base unit MOV over the turn, and no more', () => {
      const cell = baseCell();
      const uid = cell.piece!.uid!;
      const move = (config.units as any)[cell.piece!.unit_id].move;
      board.onHexClick(cell);

      const to = [...board.legalTargets][0];
      const cost: number = anyBoard().moveCosts.get(to);
      board.onHexClick(anyBoard().cellsByKey.get(to));

      // What it walked is gone from its allowance for the rest of the turn.
      expect(anyBoard().panelMoved.get(uid)).toBe(cost);
      expect(anyBoard().budgetFor(anyBoard().cellsByKey.get(to))).toBe(move - cost);
    });

    it('greys a base unit exactly when it has no move left', () => {
      const cell = baseCell();
      expect(board.isPanelSpent(cell)).toBeFalse();

      // Its own MOV gone: spent, and greyed.
      anyBoard().panelMoved.set(cell.piece!.uid, config.units.scout.move + 99);
      expect(board.isPanelSpent(cell)).toBeTrue();

      // And a unit that never moved greys too once the turn's three are used.
      anyBoard().panelMoved.clear();
      ['a', 'b', 'c'].forEach(uid => anyBoard().baseMovers.add(uid));
      expect(board.isPanelSpent(cell)).toBeTrue();

      // The opponent's base is not the player's to move, so it says nothing.
      const theirs = board.cells.find(c => c.panel === 'tr' && !!c.piece)!;
      expect(board.isPanelSpent(theirs)).toBeFalse();
    });

    it('marks the three gateway hexes with an arrow pointing at the board', () => {
      board.radius = 11;
      board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });

      // Hexes 490, 513 and 536 on white's side, and the point mirror of those
      // for black. Numbering is reading order over every hex, panels included.
      const numbered = (n: number) => board.cells[n - 1];
      expect(['3,9', '2,10', '1,11']).toEqual([490, 513, 536].map(n => numbered(n).key));
      [490, 513, 536].forEach(n => {
        expect(numbered(n).panel).toBe('br');
        expect(numbered(n).gateway).toBe('left');
      });
      ['-3,-9', '-2,-10', '-1,-11'].forEach(key => {
        const hex = board.cells.find(c => c.key === key)!;
        expect(hex.panel).toBe('tl');
        expect(hex.gateway).toBe('right');
      });

      // Six in all, and never on the battlefield or in either base.
      const marked = board.cells.filter(c => c.gateway === 'left' || c.gateway === 'right');
      expect(marked.length).toBe(6);
      expect(marked.every(c => c.filler && !BASE.has(c.panel))).toBeTrue();

      // The head sits on the side it points at, so it clears a unit's plate.
      const left = numbered(490);
      expect(arrowTipX(left)).toBeLessThan(left.cx);
      const right = board.cells.find(c => c.key === '-3,-9')!;
      expect(arrowTipX(right)).toBeGreaterThan(right.cx);
    });

    it('gives a reserve unit its own MOV too, not an endless walk', () => {
      // Placed rather than taken from the deal: a radius-4 panel is small
      // enough that which unit lands where is not worth depending on, and the
      // scout is the one with a MOV of 3 to take steps out of.
      const spot = [...anyBoard().panelZones.get('br')][0];
      anyBoard().reserves = { [spot]: {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();
      const cell = anyBoard().cellsByKey.get(spot);
      const move = config.units.scout.move;
      expect(anyBoard().budgetFor(cell)).toBe(move);

      // Steps taken come off it, and a MOV spent leaves nothing.
      anyBoard().panelMoved.set('walker', 2);
      expect(anyBoard().budgetFor(cell)).toBe(move - 2);
      anyBoard().panelMoved.set('walker', move);
      expect(anyBoard().budgetFor(cell)).toBe(0);
      expect(board.isPanelSpent(cell)).toBeTrue();

      // The three-mover cap is the base's alone: a reserve unit is not held
      // back by base units having used the turn's allowance.
      anyBoard().panelMoved.clear();
      ['a', 'b', 'c'].forEach(uid => anyBoard().baseMovers.add(uid));
      expect(board.isPanelSpent(cell)).toBeFalse();
    });

    it('wraps from the base tip to the reserve tip for one step', () => {
      // Radius 4, so the tips are (-5,1) in the base and (4,1) in the reserve
      // - the same pair hexes 283 and 306 name on the shipped board.
      const tips = anyBoard().wrapTips('white');
      expect(tips).toEqual({ base: '-5,1', reserve: '4,1' });

      // Stand a base unit on its tip with a full MOV to spend.
      anyBoard().reserves = { '-5,1': {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));

      // The crossing itself is one step, and the rest of the MOV carries on
      // into the reserve on the far side.
      expect(anyBoard().moveCosts.get('4,1')).toBe(1);
      expect(board.legalTargets.has('4,1')).toBeTrue();
      expect([...board.legalTargets].some(k => anyBoard().cellsByKey.get(k).panel === 'br'))
        .toBeTrue();
    });

    it('will not wrap on a MOV that cannot pay for the crossing', () => {
      anyBoard().reserves = { '-5,1': {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();
      // Its whole MOV already spent this turn: no step left to cross with.
      anyBoard().panelMoved.set('walker', config.units.scout.move);
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.legalTargets.has('4,1')).toBeFalse();
    });

    it('colours the two sides arrows apart', () => {
      const side = (key: string) => anyBoard().cellsByKey.get(key).arrowSide;
      // The seat defaults to white, so white's are the player's own.
      expect(side('-5,1')).toBe('mine');
      expect(side('4,1')).toBe('mine');
      expect(side('5,-1')).toBe('theirs');
      expect(side('-4,-1')).toBe('theirs');

      // And the gateways with them - three a side.
      const mine = board.cells.filter(c => c.gateway && c.arrowSide === 'mine');
      const theirs = board.cells.filter(c => c.gateway && c.arrowSide === 'theirs');
      expect(mine.length).toBe(5);
      expect(theirs.length).toBe(5);

      // Taking the other seat swaps which is which.
      board.myColor = 'black';
      board.ngOnChanges({ myColor: new SimpleChange('', 'black', false) });
      expect(side('-5,1')).toBe('theirs');
      expect(side('5,-1')).toBe('mine');
    });

    it('points the wrap out of each base and into each reserve', () => {
      const at = (key: string) => anyBoard().cellsByKey.get(key).gateway;
      // Radius 4: white's pair is (-5,1) and (4,1), black's the point mirror.
      expect(at('-5,1')).toBe('up');
      expect(at('4,1')).toBe('down');
      // Reversed for the other side, and drawn in board space - so a game
      // played as black turns the board and each player still reads their
      // own base tip as the one pointing away.
      expect(at('5,-1')).toBe('down');
      expect(at('-4,-1')).toBe('up');

      // An up arrow runs above the hex centre and a down one below it.
      const y = (key: string) => Number(
        board.arrowPoints(anyBoard().cellsByKey.get(key)).split(' ')[0].split(',')[1]);
      expect(y('-5,1')).toBeLessThan(anyBoard().cellsByKey.get('-5,1').cy);
      expect(y('4,1')).toBeGreaterThan(anyBoard().cellsByKey.get('4,1').cy);
    });

    it('charges the crossing the unit own worth, and marks what it buys', () => {
      // The scout is worth 7, so the crossing costs 7 points.
      (config.units as any).scout.value = 7;
      anyBoard().reserves = { '-5,1': {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();

      // Nothing to pay with: the far side is not offered at all, so there is
      // no hex to click and nothing to explain.
      board.movePoints = 6;
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.legalTargets.has('4,1')).toBeFalse();
      expect(board.wrapTargets.size).toBe(0);

      // Exactly enough, and it is. Every hex the crossing buys carries the
      // same price - it is for making the crossing, not for the hex.
      board.selectedHex = null;
      board.movePoints = 7;
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.legalTargets.has('4,1')).toBeTrue();
      expect(board.wrapTargets.get('4,1')).toBe(7);
      expect([...board.wrapTargets.values()].every(v => v === 7)).toBeTrue();
      // And only the far side is priced; the base it is standing in is not.
      expect([...board.wrapTargets.keys()].every(
        k => anyBoard().cellsByKey.get(k).panel === 'br')).toBeTrue();

      // Making it announces the price for the room to take off.
      const paid: number[] = [];
      board.wrapCrossed.subscribe((n: number) => paid.push(n));
      board.onHexClick(anyBoard().cellsByKey.get('4,1'));
      expect(paid).toEqual([7]);
      delete (config.units as any).scout.value;
    });

    it('marks a unit that has walked, and takes the walk back on undo', () => {
      // A scout, so a single step leaves MOV to spare - the point of the
      // mark is a unit that has walked but is not finished.
      const from = [...anyBoard().panelZones.get('bl')][0];
      anyBoard().reserves = { [from]: {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();
      const start = anyBoard().cellsByKey.get(from);
      const uid = 'walker';
      expect(board.hasWalked(start)).toBeFalse();

      board.onHexClick(start);
      const to = [...board.legalTargets].find(
        k => !board.wrapTargets.has(k) && anyBoard().moveCosts.get(k) === 1)!;
      const cost: number = anyBoard().moveCosts.get(to);
      board.onHexClick(anyBoard().cellsByKey.get(to));

      // Walked, and still with MOV to spend - so it is marked, not greyed.
      const moved = anyBoard().cellsByKey.get(to);
      expect(board.hasWalked(moved)).toBeTrue();
      expect(board.isPanelSpent(moved)).toBeFalse();
      expect(anyBoard().panelMoved.get(uid)).toBe(cost);
      expect(board.lastPanelMove).toBeGreaterThan(0);

      // Undo puts the unit, its MOV and its place among the movers back.
      expect(board.undoPanelMove()).toBe(0);
      expect(anyBoard().reserves[from]).toBeTruthy();
      expect(anyBoard().reserves[to]).toBeUndefined();
      expect(anyBoard().panelMoved.has(uid)).toBeFalse();
      expect(anyBoard().baseMovers.has(uid)).toBeFalse();
      expect(board.lastPanelMove).toBe(0);
      expect(board.hasWalked(anyBoard().cellsByKey.get(from))).toBeFalse();
    });

    it('hands back what a crossing cost when it is undone', () => {
      (config.units as any).scout.value = 7;
      anyBoard().reserves = { '-5,1': {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();
      board.movePoints = 7;
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      board.onHexClick(anyBoard().cellsByKey.get('4,1'));

      // What it paid comes back with the walk.
      expect(board.undoPanelMove()).toBe(7);
      expect(anyBoard().reserves['-5,1']).toBeTruthy();
      delete (config.units as any).scout.value;
    });

    it('does not charge an ordinary shuffle inside a panel', () => {
      const cell = baseCell();
      const paid: number[] = [];
      board.wrapCrossed.subscribe((n: number) => paid.push(n));
      board.onHexClick(cell);
      const to = [...board.legalTargets].find(k => !board.wrapTargets.has(k))!;
      board.onHexClick(anyBoard().cellsByKey.get(to));
      expect(paid).toEqual([]);
    });

    it('lets three move a turn, then no more until the next', () => {
      const cell = baseCell();
      // Three others have already been walked this turn, and this is a fourth.
      ['a', 'b', 'c'].forEach(uid => anyBoard().baseMovers.add(uid));
      board.onHexClick(cell);
      expect(board.legalTargets.size).toBe(0);

      // A new ply hands the allowance back.
      board.selectedHex = null;
      board.turnNumber = 21;
      board.ngOnChanges({ turnNumber: new SimpleChange(20, 21, false) });
      board.onHexClick(cell);
      expect(board.legalTargets.size).toBeGreaterThan(0);
    });
  });

  /**
   * The opening three turns run on their own rules: nobody strikes, both
   * panels are capped, and a unit gets one move for the whole phase rather
   * than one a turn.
   */
  describe('the initialization', () => {
    const anyBoard = () => board as any;
    const baseCell = () => board.cells.find(c => c.panel === 'bl' && !!c.piece)!;
    const reserveCell = () => board.cells.find(c => c.panel === 'br' && !!c.piece)!;
    const enterTurn = (from: number, to: number) => {
      board.selectedHex = null;
      board.turnNumber = to;
      board.ngOnChanges({ turnNumber: new SimpleChange(from, to, false) });
    };

    beforeEach(() => {
      board.interactive = true;
      board.controlAllSides = true;
      board.turnColor = 'white';
      // A black unit within the archer's range, so there is a strike to offer
      // in the first place.
      anyBoard().boardState = {
        ...boardState, '1,0': { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9 },
      };
      anyBoard().buildCells();
      enterTurn(20, 1);
    });

    it('offers nobody a strike, and draws no strike layer', () => {
      board.onHexClick(cell('0,0'));
      expect(board.attackTargets.size).toBe(0);
      board.onHexHover(cell('0,0'));
      expect(board.previewAttacks.size).toBe(0);

      // Both come back the moment the opening is over.
      enterTurn(1, 20);
      board.onHexClick(cell('0,0'));
      expect(board.attackTargets.has('1,0')).toBeTrue();
      board.onHexHover(cell('0,0'));
      expect(board.previewAttacks.size).toBeGreaterThan(0);
    });

    it('caps the reserve at three movers a turn, the way the base is', () => {
      const res = reserveCell();
      ['a', 'b', 'c'].forEach(uid => anyBoard().reserveMovers.add(uid));
      board.onHexClick(res);
      expect(board.legalTargets.size).toBe(0);

      // Outside the opening the reserve shuffles freely, as it always has.
      enterTurn(1, 20);
      ['a', 'b', 'c'].forEach(uid => anyBoard().reserveMovers.add(uid));
      board.onHexClick(res);
      expect(board.legalTargets.size).toBeGreaterThan(0);
    });

    it('gives a unit one move for the whole phase, not one a turn', () => {
      const start = baseCell();
      board.onHexClick(start);
      const to = [...board.legalTargets][0];
      board.onHexClick(anyBoard().cellsByKey.get(to));

      // Next turn of the opening: it has had its move, and says so.
      enterTurn(1, 3);
      const moved = anyBoard().cellsByKey.get(to);
      expect(board.isPanelSpent(moved)).toBeTrue();
      board.onHexClick(moved);
      expect(board.legalTargets.size).toBe(0);

      // The lock lifts with the phase, not with the turn.
      enterTurn(3, 4);
      expect(board.isPanelSpent(anyBoard().cellsByKey.get(to))).toBeFalse();
    });

    it('spends one battlefield unit for the whole opening', () => {
      expect(board.isPanelSpent(cell('0,0'))).toBeFalse();

      board.boardMoveSpent = true;
      board.selectedHex = null;
      board.onHexClick(cell('0,0'));
      expect(board.legalTargets.size).toBe(0);
      expect(board.isPanelSpent(cell('0,0'))).toBeTrue();
      // The opponent's units are not this player's to move either way.
      expect(board.isPanelSpent(cell('1,0'))).toBeFalse();

      // Outside the opening a board unit moves every turn as before.
      enterTurn(1, 20);
      board.onHexClick(cell('0,0'));
      expect(board.legalTargets.size).toBeGreaterThan(0);
      expect(board.isPanelSpent(cell('0,0'))).toBeFalse();
    });
  });

  it('swaps the two when the seat is the other colour', () => {
    board.myColor = 'black';
    board.ngOnChanges({ myColor: new SimpleChange('', 'black', false) });
    // Black's own rows are the -r edge, so they become the near ones.
    expect(cell('0,-2').home).toBe('mine');
    expect(cell('0,2').home).toBe('theirs');
  });
});
