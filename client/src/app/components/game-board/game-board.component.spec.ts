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

  // `config` is shared by every spec in this file, so anything a spec adds
  // to it has to come back off - including when that spec fails partway.
  afterEach(() => { delete (config.units as any).archer.commander; });

  const cell = (key: string) => board.cells.find(c => c.key === key)!;

  it('takes overtime out of the king, on the king', async () => {
    // Overtime bleeds a point off a side at the end of each of its
    // hand-overs. The header counts it; the board shows it as the king of
    // whoever just paid taking one, so there is something to watch.
    (config.units as any).archer.commander = true;
    // The toll is the browser engine's alone, and so is the mark over it.
    board.entryBind = true;
    const king = () => cell('0,0');   // the white archer, now a commander

    // Nothing to take before overtime starts.
    board.turnNumber = 20;
    board.ngOnChanges({ turnNumber: new SimpleChange(19, 20, false) });
    expect(board.markOf(king())).toBe('');

    // Hand-over 67 is overtime's first and white plays the odd ones, so it
    // is white's king that wears the toll for it. Owed as the ply turns over,
    // paid at the end of the turn's animation - so it is not on the king yet.
    board.turnNumber = 68;
    board.ngOnChanges({ turnNumber: new SimpleChange(67, 68, false) });
    expect(board.markOf(king())).toBe('');
    await (board as any).settleUpkeep();
    expect(board.markOf(king())).toBe('-1');
    (board as any).cdr.detectChanges();
    const mark = fixture.nativeElement.querySelector('text.toll-mark');
    expect(mark.textContent).toBe('-1');

    // Black's hand-over is black's to pay, and white's king is left alone.
    board.turnNumber = 69;
    board.ngOnChanges({ turnNumber: new SimpleChange(68, 69, false) });
    await (board as any).settleUpkeep();
    expect(board.markOf(king())).toBe('');

    // No engine but this browser's takes the toll, so a server game marks
    // nobody: a red -1 over a king whose HP never moves is a lie.
    board.entryBind = false;
    board.turnNumber = 70;
    board.ngOnChanges({ turnNumber: new SimpleChange(69, 70, false) });
    await (board as any).settleUpkeep();
    expect(board.markOf(cell('3,0'))).toBe('');
  });

  it('pays the turn’s upkeep as the last beat, after the recap', async () => {
    // The owner's rule: the base's mending and overtime's toll are the last
    // thing that happens in a turn. Owed as the ply turns over, and paid only
    // once every beat the turn itself had has played out.
    (config.units as any).archer.commander = true;
    board.entryBind = true;
    const king = () => cell('0,0');
    board.turnNumber = 68;
    board.ngOnChanges({ turnNumber: new SimpleChange(67, 68, false) });
    expect(board.markOf(king())).toBe('');

    let markWhenDone = 'never fired';
    const done = new Promise<void>(resolve => {
      board.playbackDone.subscribe(() => {
        markWhenDone = board.markOf(king());
        resolve();
      });
    });
    // A beat with nothing on the board to draw, so the run is short.
    const steps = [{ kind: 'pick', from: '', to: '', index: 0 }] as any;
    board.playback = steps;
    board.ngOnChanges({ playback: new SimpleChange([], steps, false) });
    // Still unpaid while the recap runs.
    expect(board.markOf(king())).toBe('');
    await done;
    expect(markWhenDone).toBe('-1');
  });

  it('pays it on its own when the turn had nothing to replay', async () => {
    // A passed turn plays no recap at all, and still mends and still pays.
    (config.units as any).archer.commander = true;
    board.entryBind = true;
    board.turnNumber = 68;
    board.ngOnChanges({ turnNumber: new SimpleChange(67, 68, false) });
    expect(board.markOf(cell('0,0'))).toBe('');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(board.markOf(cell('0,0'))).toBe('-1');
  });

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
      // Panels are the browser engine's alone, so everything about them -
      // crossing, walking home, and being in a fight - is solo-only.
      board.entryBind = true;
      // The wrap runs on a window, and the file's default ply 20 is turn 10,
      // which is past Phase 1's halftime and so shut. Ply 15 is turn 8 - the
      // last open turn of that phase, and still well past the opening.
      board.turnNumber = 15;
    });

    // `config` is shared by every spec in the file. The pricing spec below
    // gives the scout a worth, and a spec that fails partway through would
    // otherwise leave it there to break the next one.
    afterEach(() => { delete (config.units as any).scout.value; });

    it('lets the battlefield strike into a panel, but never a panel into one', () => {
      // The owner's rule, in three answers: a battlefield unit reaches
      // anybody in range including a panel; a reserve reaches out only;
      // a base reaches nobody at all.
      const DIRS = [[1, 0], [-1, 0], [1, -1], [0, -1], [0, 1], [-1, 1]];
      const zone: Set<string> = anyBoard().panelZones.get('bl');
      // A base hex with a battlefield hex beside it, to stand a striker on.
      let inBase = '', onBoard = '';
      for (const key of zone) {
        const [q, r] = key.split(',').map(Number);
        for (const [dq, dr] of DIRS) {
          const at = `${q + dq},${r + dr}`;
          const cell = anyBoard().cellsByKey.get(at);
          if (cell && !cell.panel && !cell.piece) { inBase = key; onBoard = at; break; }
        }
        if (inBase) break;
      }
      expect(inBase).toBeTruthy();

      // A white unit at home, a black one on the board beside it.
      anyBoard().reserves = { [inBase]: {
        unit_id: 'guard', color: 'white', hp: 9, max_hp: 9, uid: 'athome',
      } };
      const withEnemy: Record<string, any> = {
        ...boardState, [onBoard]: { unit_id: 'scout', color: 'black', hp: 6, max_hp: 6 },
      };
      anyBoard().boardState = withEnemy;
      anyBoard().buildCells();
      board.turnColor = 'black';

      // From the battlefield: the base unit is a target like any other.
      board.selectedHex = null;
      board.onHexClick(anyBoard().cellsByKey.get(onBoard));
      expect(board.attackTargets.has(inBase)).toBeTrue();

      // From the base: nothing at all, however close the enemy stands.
      board.turnColor = 'white';
      board.selectedHex = null;
      board.onHexClick(anyBoard().cellsByKey.get(inBase));
      expect(board.attackTargets.size).toBe(0);

      // And no panel is in a fight at all in a server game: no engine but
      // this browser's holds one, so the blow would go out to a server with
      // no answer for it and stall the turn.
      board.entryBind = false;
      board.turnColor = 'black';
      board.selectedHex = null;
      board.onHexClick(anyBoard().cellsByKey.get(onBoard));
      expect(board.attackTargets.has(inBase)).toBeFalse();

      anyBoard().boardState = boardState;
    });

    it('washes the strike overlay into THEIR panel, and never into yours', () => {
      // The red range is about REACH, so it carries on into a panel rather
      // than stopping at the hexagon's rim. But only into the enemy's: a
      // side's own base and reserve never hold anything for it to hit, so
      // painting its range over them says nothing.
      const DIRS = [[1, 0], [-1, 0], [1, -1], [0, -1], [0, 1], [-1, 1]];
      // A battlefield hex beside a hex of `panel`, to stand a unit on.
      const edgeBy = (panel: string) => {
        for (const key of anyBoard().panelZones.get(panel) as Set<string>) {
          const [q, r] = key.split(',').map(Number);
          for (const [dq, dr] of DIRS) {
            const at = `${q + dq},${r + dr}`;
            const cell = anyBoard().cellsByKey.get(at);
            if (cell && !cell.panel && !cell.piece) return at;
          }
        }
        return '';
      };
      const lit = (at: string, color: 'white' | 'black') => {
        const next: Record<string, any> = {
          ...boardState, [at]: { unit_id: 'archer', color, hp: 5, max_hp: 5 },
        };
        anyBoard().boardState = next;
        anyBoard().buildCells();
        board.selectedHex = null;
        board.onHexHover(anyBoard().cellsByKey.get(at));
        const panels = [...board.previewAttacks]
          .filter(k => anyBoard().cellsByKey.get(k)?.panel);
        board.onHexHover(null);
        return panels;
      };

      // Whose panel a hex belongs to - the corner it is in, the same
      // reading buildReserves deals by.
      const ownerOf = (key: string) => {
        const panel = anyBoard().cellsByKey.get(key)?.panel;
        return panel ? (panel[0] === 'b' ? 'white' : 'black') : '';
      };

      // White beside black's reserve: the range runs on into theirs.
      const byTheirs = edgeBy('tl');
      expect(byTheirs).toBeTruthy();
      expect(lit(byTheirs, 'white').some(k => ownerOf(k) === 'black')).toBeTrue();
      // And never into its own, wherever it happens to be standing.
      expect(lit(byTheirs, 'white').some(k => ownerOf(k) === 'white')).toBeFalse();
      const byMine = edgeBy('bl');
      expect(byMine).toBeTruthy();
      expect(lit(byMine, 'white').some(k => ownerOf(k) === 'white')).toBeFalse();
      // The mirror holds: black gets nothing painted in black's own panels.
      expect(lit(byTheirs, 'black').some(k => ownerOf(k) === 'black')).toBeFalse();

      // Whatever is lit stays inside what the board draws.
      expect([...board.previewAttacks].every(k => anyBoard().cellsByKey.has(k))).toBeTrue();
      anyBoard().boardState = boardState;
    });

    it('marks the reach that crossed onto the board apart from the panel walk', () => {
      // Stepping through the gap is a different move from shuffling about a
      // panel, and the two read as one thing while they shared the green.
      const gate = [...anyBoard().cellsByKey.values()]
        .find((c: any) => c.panel === 'br' && c.gateway)!;
      anyBoard().reserves = { [gate.key]: {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'crosser',
      } };
      anyBoard().buildCells();
      board.onHexClick(anyBoard().cellsByKey.get(gate.key));

      // Everything it crossed to is on the battlefield, and none of the
      // panel hexes it can merely shuffle to are in there with them.
      expect(board.entryTargets.size).toBeGreaterThan(0);
      expect([...board.entryTargets].every(
        k => !anyBoard().cellsByKey.get(k)?.panel)).toBeTrue();
      expect([...board.entryTargets].every(k => board.legalTargets.has(k))).toBeTrue();
      const panelReach = [...board.legalTargets]
        .filter(k => anyBoard().cellsByKey.get(k)?.panel);
      expect(panelReach.some(k => board.entryTargets.has(k))).toBeFalse();

      // And it is dropped with the rest of the reach.
      board.selectedHex = null;
      (board as any).clearTargets();
      expect(board.entryTargets.size).toBe(0);
    });

    it('previews THEIR crossings too, priced against their own purse', () => {
      // Looking at a unit you cannot drive still shows what it could do: the
      // wrap out of its base, the walk home, the way onto the board - and the
      // price struck through when that side cannot pay for it.
      (config.units as any).scout.value = 7;
      board.turnColor = 'white';            // so black is the one you may only look at
      anyBoard().reserves = { '5,-1': {
        unit_id: 'scout', color: 'black', hp: 6, max_hp: 6, uid: 'theirs',
      } };
      anyBoard().buildCells();
      const theirTip = anyBoard().cellsByKey.get('5,-1');

      // Their purse covers it: the crossing is previewed with its price.
      board.movePoints = 0;                 // ours is empty, and irrelevant
      board.theirPoints = 7;
      board.onHexHover(theirTip);
      expect(board.previewWrap.get('-4,-1')).toBe(7);
      expect(board.previewDenied.size).toBe(0);

      // A purse a point short: the same hex, struck through instead.
      board.onHexHover(null);
      board.theirPoints = 6;
      board.onHexHover(theirTip);
      expect(board.previewWrap.size).toBe(0);
      expect(board.previewDenied.get('-4,-1')).toBe(7);

      // And the labels the board draws come from whichever layer is up.
      expect(board.wrapDeniedAt(anyBoard().cellsByKey.get('-4,-1'))).toBe(7);
      board.onHexHover(null);
    });

    it('fuses reach into a panel rather than painting over it', () => {
      // A reach colour on a panel is a wash laid over the panel's own colour,
      // not a fill instead of it - the two fuse and the panel is still
      // readable. The fills carry !important, so they are suppressed on panel
      // hexes and this stands in for them.
      const zone: Set<string> = anyBoard().panelZones.get('br');
      const spot = [...zone][0];
      anyBoard().reserves = { [spot]: {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();
      board.onHexClick(anyBoard().cellsByKey.get(spot));
      const target = [...board.legalTargets]
        .find(k => anyBoard().cellsByKey.get(k)?.panel)!;
      expect(target).toBeTruthy();
      expect(board.panelWash(anyBoard().cellsByKey.get(target))).toBe('wash-legal');
      // A battlefield hex has nothing underneath worth keeping, so it takes
      // the plain fill and no wash.
      expect(board.panelWash(anyBoard().cellsByKey.get('0,0'))).toBe('');
    });

    it('offers neither panel an attack - only the battlefield starts one', () => {
      // A reserve answers when it is struck and nothing more; a base does not
      // even answer. Neither is ever offered a target, however close an
      // enemy stands.
      const enemy = { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9 };
      const near = (panel: string) => {
        const zone: Set<string> = anyBoard().panelZones.get(panel);
        for (const key of zone) {
          const [q, r] = key.split(',').map(Number);
          for (const [dq, dr] of [[1, 0], [-1, 0], [1, -1], [0, -1], [0, 1], [-1, 1]]) {
            const at = `${q + dq},${r + dr}`;
            const cell = anyBoard().cellsByKey.get(at);
            if (cell && !cell.panel && !cell.piece) return { from: key, at };
          }
        }
        return null;
      };

      for (const panel of ['br', 'bl'] as const) {
        const spot = near(panel)!;
        expect(spot).toBeTruthy();
        anyBoard().boardState = { ...boardState, [spot.at]: enemy };
        anyBoard().reserves = { [spot.from]: {
          unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'swinger',
        } };
        anyBoard().buildCells();
        board.selectedHex = null;
        board.onHexClick(anyBoard().cellsByKey.get(spot.from));
        expect(board.attackTargets.size).toBe(0);
      }
      anyBoard().boardState = boardState;
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

      // Three a side out of the reserves, and never on the battlefield.
      const marked = board.cells.filter(
        c => (c.gateway === 'left' || c.gateway === 'right') && !BASE.has(c.panel));
      expect(marked.length).toBe(6);
      expect(marked.every(c => c.filler)).toBeTrue();

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

    it('draws a wound a panel takes, without waiting to be re-dealt', () => {
      // The deal happens once - it is skipped while the roster and geometry
      // hold still, so a shuffled reserve stays where it was put. The wound
      // used to be applied only inside that deal, so a blow into a panel was
      // recorded and derived and then never drawn: the unit looked untouched
      // until a reload dealt the panel again.
      const res = board.cells.find(c => c.panel === 'br' && !!c.piece)!;
      const uid = res.piece!.uid!;
      const full = res.piece!.hp;

      expect(full).toBeGreaterThan(2);
      board.panelHp = { [uid]: full - 1 };
      board.ngOnChanges({ panelHp: new SimpleChange({}, board.panelHp, false) });
      const hit = board.cells.find(c => c.piece?.uid === uid)!;
      expect(hit.piece!.hp).toBe(full - 1);
      // Its full HP is still what it was dealt with, so the bar reads 5/6.
      expect(hit.piece!.max_hp).toBe(full);

      // A second blow lands on the same unit, in the same deal.
      board.panelHp = { [uid]: 1 };
      board.ngOnChanges({ panelHp: new SimpleChange({}, board.panelHp, false) });
      expect(board.cells.find(c => c.piece?.uid === uid)!.piece!.hp).toBe(1);

      // And nothing on 0 is left standing.
      board.panelHp = { [uid]: 0 };
      board.ngOnChanges({ panelHp: new SimpleChange({}, board.panelHp, false) });
      expect(board.cells.find(c => c.piece?.uid === uid)).toBeUndefined();
    });

    it('shuts the wrap outside its window, and crosses out the arrow', () => {
      anyBoard().reserves = { '-5,1': {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker',
      } };
      anyBoard().buildCells();

      // Ply 21 is turn 11 - past Phase 1's halftime, so the crossing is off.
      // Through setInput, not by assignment: the cross is a template read, and
      // this view is OnPush, so a bare write would leave the DOM as it was.
      fixture.componentRef.setInput('turnNumber', 21);
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.wrapOpen).toBeFalse();
      expect(board.legalTargets.has('4,1')).toBeFalse();
      // No price either: a price is an offer, and there is nothing on offer.
      expect(anyBoard().wrapDenied.has('4,1')).toBeFalse();
      // The cross goes on the tip it leaves from, not the one it lands on.
      expect(anyBoard().cellsByKey.get('-5,1').wrapOut).toBeTrue();
      expect(anyBoard().cellsByKey.get('4,1').wrapOut).toBeFalse();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.gateway-shut').length).toBe(2);

      // Back inside the window and it opens again, cross and all.
      fixture.componentRef.setInput('turnNumber', 15);
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.legalTargets.has('4,1')).toBeTrue();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('.gateway-shut').length).toBe(0);
    });

    it('wraps the same way for black - hexes 259 and 236 on the real board', () => {
      // The point mirror of white's pair: black's base tip and the reserve
      // tip facing it. The opponent's wrap is the same crossing, so anything
      // that works for white and not for black is a bug in the mirroring.
      const tips = anyBoard().wrapTips('black');
      expect(tips).toEqual({ base: '5,-1', reserve: '-4,-1' });

      board.turnColor = 'black';
      anyBoard().reserves = { '5,-1': {
        unit_id: 'scout', color: 'black', hp: 6, max_hp: 6, uid: 'raven',
      } };
      anyBoard().buildCells();
      board.onHexClick(anyBoard().cellsByKey.get('5,-1'));

      expect(anyBoard().moveCosts.get('-4,-1')).toBe(1);
      expect(board.legalTargets.has('-4,-1')).toBeTrue();
      expect([...board.legalTargets].some(k => anyBoard().cellsByKey.get(k).panel === 'tl'))
        .toBeTrue();
    });

    it('walks its own out of the way at every crossing', () => {
      // The three crossings each did their own occupancy check, and none of
      // them learned that a unit walks through its own. A single friend on a
      // tip or a doorway shut the whole way.
      const tips = anyBoard().wrapTips('white');

      // --- base -> reserve, with a friend sitting ON the base tip ---------
      anyBoard().reserves = {
        [tips.base]: { unit_id: 'guard', color: 'white', hp: 9, max_hp: 9, uid: 'sitter' },
        '-5,2': { unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker' },
      };
      anyBoard().buildCells();
      board.movePoints = 99;
      board.selectedHex = null;
      board.onHexClick(anyBoard().cellsByKey.get('-5,2'));
      // The tip is walked over, so the far side is still on offer - and the
      // tip itself is not, because somebody is standing on it.
      expect(board.legalTargets.has(tips.reserve)).toBeTrue();
      expect(board.legalTargets.has(tips.base)).toBeFalse();

      // An ENEMY on the far tip is a different matter: no landing, no way past.
      anyBoard().reserves = {
        '-5,2': { unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'walker' },
        [tips.reserve]: { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9, uid: 'foe' },
      };
      anyBoard().buildCells();
      board.selectedHex = null;
      board.onHexClick(anyBoard().cellsByKey.get('-5,2'));
      expect(board.legalTargets.has(tips.reserve)).toBeFalse();
      expect(board.wrapTargets.size).toBe(0);
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

      // And every other arrow with them: three out of the reserve, three on
      // the base, and the two ends of the wrap - eight a side.
      const mine = board.cells.filter(c => c.gateway && c.arrowSide === 'mine');
      const theirs = board.cells.filter(c => c.gateway && c.arrowSide === 'theirs');
      expect(mine.length).toBe(8);
      expect(theirs.length).toBe(8);

      // Taking the other seat swaps which is which.
      board.myColor = 'black';
      board.ngOnChanges({ myColor: new SimpleChange('', 'black', false) });
      expect(side('-5,1')).toBe('theirs');
      expect(side('5,-1')).toBe('mine');
    });

    it('marks three base hexes as a way onto the board as well', () => {
      board.radius = 11;
      board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });
      const numbered = (n: number) => board.cells[n - 1];

      // Hexes 19, 43 and 67 on black's side, and the point mirror of those on
      // white's. Each points the way a unit travels through it - into the
      // base, away from the battlefield - so black's run right and white's
      // left. Drawn in board space, so each player reads their own as left.
      expect([19, 43, 67].map(n => numbered(n).key)).toEqual(['12,-11', '12,-10', '12,-9']);
      [19, 43, 67].forEach(n => {
        expect(numbered(n).panel).toBe('tr');
        expect(numbered(n).gateway).toBe('right');
      });
      expect([523, 499, 475].map(n => numbered(n).key)).toEqual(['-12,11', '-12,10', '-12,9']);
      [523, 499, 475].forEach(n => {
        expect(numbered(n).panel).toBe('bl');
        expect(numbered(n).gateway).toBe('left');
      });

      // Three a side, and only in the bases.
      const marked = board.cells.filter(
        c => (c.gateway === 'left' || c.gateway === 'right') && BASE.has(c.panel));
      expect(marked.length).toBe(6);
      expect(marked.every(c => c.filler)).toBeTrue();
    });

    it('still lets nothing walk out of the base it marks', () => {
      board.radius = 11;
      board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });
      board.interactive = true;
      board.controlAllSides = true;
      board.turnColor = 'white';
      board.entryBind = true;

      // A base unit standing on the mark is offered its own panel and the
      // priced wrap, and nothing on the battlefield: the arrow is drawn, and
      // that is all it is.
      anyBoard().reserves['-12,11'] = {
        unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'basemark',
      };
      anyBoard().buildCells();
      board.onHexClick(anyBoard().cellsByKey.get('-12,11'));

      const onBoard = [...board.legalTargets]
        .filter(k => !anyBoard().cellsByKey.get(k)?.filler);
      expect(onBoard.length).toBe(0);
    });

    describe('the walk home', () => {
      /** A white scout on the board hex beside white's own mark. */
      const beside = '-11,11';
      const setUp = () => {
        board.radius = 11;
        board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });
        board.interactive = true;
        board.controlAllSides = true;
        board.turnColor = 'white';
        board.entryBind = true;
        (config.units as any).scout.value = 7;
        const next: Record<string, any> = {
          ...boardState,
          [beside]: { unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'homer' },
        };
        board.boardState = next;
        board.ngOnChanges({ boardState: new SimpleChange(null, next, false) });
      };

      afterEach(() => {
        delete (config.units as any).scout.value;
        board.boardState = boardState;
      });

      it('walks a unit off the board into its own base, and pays for it', () => {
        setUp();
        board.onHexClick(anyBoard().cellsByKey.get(beside));

        // The mark is one step off the board, and the walk carries on inside.
        expect(board.legalTargets.has('-12,11')).toBeTrue();
        expect(anyBoard().moveCosts.get('-12,11')).toBe(1);

        const paid = [...board.refundTargets.keys()];
        expect(paid.length).toBeGreaterThan(0);
        // Only ever into its own base - never the enemy's, and never a reserve.
        expect(paid.every(k => anyBoard().cellsByKey.get(k).panel === 'bl')).toBeTrue();
        // Coming home pays the unit's own worth, which is what the wrap
        // charged to send one out.
        expect([...board.refundTargets.values()].every(v => v === 7)).toBeTrue();
      });

      it('walks home within its MOV - it does not teleport in', () => {
        setUp();
        // The far side of the board, further than any MOV in the config.
        // Coming home is a walk like any other: out of range is out of range.
        const far = '10,-2';
        const next: Record<string, any> = {
          ...boardState,
          [far]: { unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: 'distant' },
        };
        board.boardState = next;
        board.ngOnChanges({ boardState: new SimpleChange(null, next, false) });

        board.onHexClick(anyBoard().cellsByKey.get(far));
        expect(board.legalTargets.has('-12,11')).toBeFalse();
        expect(board.refundTargets.size).toBe(0);
      });

      it('sends the refund out with the move', () => {
        setUp();
        const moves: any[] = [];
        board.moveMade.subscribe(m => moves.push(m));

        board.onHexClick(anyBoard().cellsByKey.get(beside));
        board.onHexClick(anyBoard().cellsByKey.get('-12,11'));

        expect(moves.length).toBe(1);
        expect(moves[0].to).toBe('-12,11');
        expect(moves[0].refund).toBe(7);
      });

      it('turns its labels back upright on a flipped board', () => {
        setUp();
        // A mended unit for the +1, and a selection for the +x it can walk to.
        const hurt = (hp: number) => ([
          { at: '-12,10', unit: { unit_id: 'scout', color: 'white', hp, max_hp: 6, uid: 'athome' } },
        ]);
        board.withdrawn = hurt(3) as any;
        anyBoard().buildCells();
        board.withdrawn = hurt(4) as any;
        anyBoard().buildCells();
        board.onHexClick(anyBoard().cellsByKey.get(beside));

        board.rotateBoard = true;
        // OnPush, and everything above was driven imperatively - only the
        // component's own detector refreshes what is on screen.
        anyBoard().cdr.detectChanges();
        const marks: Element[] = [
          ...fixture.nativeElement.querySelectorAll('text.wrap-cost, text.heal-mark'),
        ];
        // Both kinds are on screen, and neither is upside down: a flipped
        // board turns its labels back the way every other one is turned.
        expect(marks.length).toBeGreaterThan(1);
        expect(marks.every(t => (t.getAttribute('transform') ?? '')
          .startsWith('rotate(180'))).toBeTrue();
      });

      it('gives a unit that has walked home nothing more this turn', () => {
        setUp();
        board.onHexClick(anyBoard().cellsByKey.get(beside));
        const unit = anyBoard().cellsByKey.get(beside).piece;
        // What the room stages: the unit stands in the base, under a panel
        // key, on the board the component is handed.
        const staged: Record<string, any> = { ...boardState, '-12,11': unit };
        board.boardState = staged;
        board.ngOnChanges({ boardState: new SimpleChange(null, staged, false) });

        board.onHexClick(anyBoard().cellsByKey.get('-12,11'));
        // Nothing further, or the next click would go out as a board move -
        // free of the wrap's price and of every panel allowance.
        expect(board.legalTargets.size).toBe(0);
        expect(board.wrapTargets.size).toBe(0);
        // And it says so: an ungreyed unit that takes no clicks reads as a
        // walk home that never counted.
        expect(board.isPanelSpent(anyBoard().cellsByKey.get('-12,11'))).toBeTrue();
      });

      it('offers no way home in a server game', () => {
        setUp();
        board.entryBind = false;
        board.onHexClick(anyBoard().cellsByKey.get(beside));

        // No engine but this browser's has a base to put a unit in, so a
        // server game draws the marks and walks nobody through them.
        expect(board.refundTargets.size).toBe(0);
        expect(board.legalTargets.has('-12,11')).toBeFalse();
      });

      it('draws a unit that has come home, and mends it in place', async () => {
        setUp();
        // What the engine keeps of a withdrawal is the record; the room hands
        // back what it rebuilt from it, and the base draws that.
        board.withdrawn = [
          { at: '-12,10', unit: { unit_id: 'scout', color: 'white', hp: 3, max_hp: 6, uid: 'athome' } },
        ] as any;
        anyBoard().buildCells();
        expect(anyBoard().cellsByKey.get('-12,10').piece.uid).toBe('athome');
        expect(anyBoard().cellsByKey.get('-12,10').piece.hp).toBe(3);
        expect(board.markOf(anyBoard().cellsByKey.get('-12,10'))).toBe('');

        // The room re-derives it a turn later with an HP more. It is already
        // standing here, so it mends where it stands rather than arriving a
        // second time - and carries the +1 that says so.
        board.withdrawn = [
          { at: '-12,10', unit: { unit_id: 'scout', color: 'white', hp: 4, max_hp: 6, uid: 'athome' } },
        ] as any;
        anyBoard().buildCells();
        const standing = board.cells.filter(c => c.piece?.uid === 'athome');
        expect(standing.length).toBe(1);
        expect(standing[0].piece!.hp).toBe(4);
        // Owed while the turn's animation is still running, and paid at the
        // end of it - the owner's rule is that mending is the last thing
        // that happens in a turn.
        expect(board.markOf(standing[0])).toBe('');
        await anyBoard().settleUpkeep();
        expect(board.markOf(standing[0])).toBe('+1');
      });

      it('colours the end-of-turn marks by whose unit wears them', async () => {
        setUp();
        board.myColor = 'white';
        // One of each: a white unit mending in white's base, and black's king
        // paying overtime's toll out on the board.
        board.withdrawn = [
          { at: '-12,10', unit: { unit_id: 'scout', color: 'white', hp: 3, max_hp: 6, uid: 'athome' } },
        ] as any;
        anyBoard().buildCells();
        board.withdrawn = [
          { at: '-12,10', unit: { unit_id: 'scout', color: 'white', hp: 4, max_hp: 6, uid: 'athome' } },
        ] as any;
        anyBoard().buildCells();
        board.entryBind = true;
        const king = board.cells.find(c => c.piece?.color === 'black')!;
        anyBoard().oweMark(king.piece!.uid, '-1');
        await anyBoard().settleUpkeep();
        anyBoard().cdr.detectChanges();

        const marks = [...fixture.nativeElement.querySelectorAll('text.heal-mark')]
          .map((t: Element) => [t.textContent, t.getAttribute('class')]);
        // Mine mending is the plain green class; theirs being struck carries
        // both modifiers, which is what makes it purple rather than red.
        const toll = marks.find(m => m[0] === '-1')!;
        expect(toll[1]).toContain('toll-mark');
        expect(toll[1]).toContain('mark-theirs');
        const mend = marks.find(m => m[0] === '+1')!;
        expect(mend[1]).not.toContain('mark-theirs');
        expect(mend[1]).not.toContain('toll-mark');
      });
    });

    it('waits on the edge a unit crosses, not the one it points at', () => {
      board.radius = 11;
      board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });
      const at = (key: string) => anyBoard().cellsByKey.get(key);
      const xs = (key: string) => board.arrowPoints(at(key))
        .split(' ').map(p => Number(p.split(',')[0]));

      // White's base mark points left, into the base, but sits on the right -
      // the side facing the battlefield, which is where a unit comes from.
      expect(Math.min(...xs('-12,11'))).toBeGreaterThan(at('-12,11').cx);
      // Black's mirror points right and waits on its own left edge.
      expect(Math.max(...xs('12,-11'))).toBeLessThan(at('12,-11').cx);
      // The reserve's gap is the other way about: it points at the
      // battlefield and sits on the edge it leaves through.
      expect(Math.max(...xs('3,9'))).toBeLessThan(at('3,9').cx);
    });

    it('deals the two sides the same opening, mirrored', () => {
      board.radius = 11;
      board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });
      const squad = (panel: string) => board.cells
        .filter(c => c.panel === panel && c.piece)
        .map(c => c.key);
      const mirror = (key: string) => key.split(',').map(n => -Number(n)).join(',');

      // Black's panels are the point mirror of white's, so its squad must be
      // too. Reading order alone is not: it deals white a unit standing on
      // its own wrap tip and black one ten hexes from anything.
      expect(squad('tr').map(mirror).sort()).toEqual(squad('bl').sort());
      expect(squad('tl').map(mirror).sort()).toEqual(squad('br').sort());
      // And neither wrap's corridor is dealt on, or the crossing is shut from
      // the first turn: each tip is a cul-de-sac with one panel hex leading
      // in, so a unit on the tip or its doorway locks the whole panel out.
      for (const color of ['white', 'black'] as const) {
        for (const hex of anyBoard().wrapCorridor(color)) {
          expect(anyBoard().reserves[hex]).toBeUndefined();
        }
      }
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

      // Nothing to pay with: the far side is not offered - but the price is
      // still drawn on it, struck through, or a gap that simply fails to
      // open reads as broken rather than as expensive.
      board.movePoints = 6;
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.legalTargets.has('4,1')).toBeFalse();
      expect(board.wrapTargets.size).toBe(0);
      expect(board.wrapDenied.get('4,1')).toBe(7);
      anyBoard().cdr.detectChanges();
      expect(fixture.nativeElement.querySelector('text.wrap-denied').textContent)
        .toBe('-7');

      // Exactly enough, and it is. Every hex the crossing buys carries the
      // same price - it is for making the crossing, not for the hex.
      board.selectedHex = null;
      board.movePoints = 7;
      board.onHexClick(anyBoard().cellsByKey.get('-5,1'));
      expect(board.legalTargets.has('4,1')).toBeTrue();
      expect(board.wrapTargets.get('4,1')).toBe(7);
      expect(board.wrapDenied.size).toBe(0);
      expect([...board.wrapTargets.values()].every(v => v === 7)).toBeTrue();
      // And only the far side is priced; the base it is standing in is not.
      expect([...board.wrapTargets.keys()].every(
        k => anyBoard().cellsByKey.get(k).panel === 'br')).toBeTrue();

      // Making it announces the price for the room to take off.
      const paid: number[] = [];
      board.wrapCrossed.subscribe((n: number) => paid.push(n));
      board.onHexClick(anyBoard().cellsByKey.get('4,1'));
      expect(paid).toEqual([7]);
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
  describe('the way out of the reserve', () => {
    const anyBoard = () => board as any;

    /** Reserves of ours standing on the first `n` gateway hexes. */
    const onGates = (n: number): string[] => {
      board.radius = 11;
      board.ngOnChanges({ radius: new SimpleChange(4, 11, false) });
      const gates = board.cells
        .filter(c => c.gateway === 'left' && c.panel === 'br')
        .slice(0, n).map(c => c.key);
      gates.forEach((key, i) => {
        anyBoard().reserves[key] = {
          unit_id: 'scout', color: 'white', hp: 6, max_hp: 6, uid: `runner${i}`,
        };
      });
      anyBoard().buildCells();
      return gates;
    };
    const onGate = () => onGates(1)[0];

    /** Walk the reserve on `gate` through onto the board, and say where. */
    const cross = (gate: string): string => {
      board.onHexClick(anyBoard().cellsByKey.get(gate));
      const to = boardTargets()[0].key;
      board.onHexClick(anyBoard().cellsByKey.get(to));
      return to;
    };

    /** The battlefield hexes on offer, as against the panel's own. */
    const boardTargets = () => [...board.legalTargets]
      .map(key => anyBoard().cellsByKey.get(key))
      .filter((c: any) => c && !c.filler);

    beforeEach(() => {
      board.interactive = true;
      board.controlAllSides = true;
      board.turnColor = 'white';
      board.entryBind = true;
    });

    it('opens the gap onto the battlefield beside it', () => {
      const gate = onGate();
      board.onHexClick(anyBoard().cellsByKey.get(gate));

      const stepped = boardTargets();
      expect(stepped.length).toBeGreaterThan(0);
      // Standing in the gap, the step through it is one - and the rest of the
      // reach carries on from there with what is left.
      expect(Math.min(...stepped.map((c: any) => anyBoard().moveCosts.get(c.key)))).toBe(1);
      // The panel is still its own to walk about.
      expect([...board.legalTargets].some(k => anyBoard().cellsByKey.get(k)?.filler)).toBeTrue();
    });

    it('leaves the gap shut in a server game', () => {
      board.entryBind = false;
      const gate = onGate();
      board.onHexClick(anyBoard().cellsByKey.get(gate));
      // Nothing on the board is offered: no engine but this browser's has a
      // panel to take the unit out of, so a server would reject the walk.
      expect(boardTargets().length).toBe(0);
    });

    it('lets more than one unit through in a turn', () => {
      const gates = onGates(2);
      const landed = gates.map(cross);

      // A crossing is a reserve's move, not the turn's one board action, so
      // the second is offered exactly as the first was.
      expect(board.pendingEntries.length).toBe(2);
      expect(board.pendingEntries.map(e => e.from)).toEqual(gates);
      expect(board.pendingEntries.map(e => e.unit.uid!)).toEqual(['runner0', 'runner1']);
      landed.forEach((to, i) => {
        // Each stands on the board, and no panel hex draws it any more.
        expect(anyBoard().cellsByKey.get(to).piece.uid).toBe(`runner${i}`);
        expect(anyBoard().cellsByKey.get(gates[i]).piece).toBeNull();
      });
    });

    it('takes a crossing back, newest first', () => {
      const gates = onGates(2);
      const landed = gates.map(cross);

      expect(board.undoPanelMove()).toBe(0);
      expect(board.pendingEntries.length).toBe(1);
      // The unit was never taken out of its panel, only stopped being drawn
      // there - so dropping the crossing is all it takes to put it back.
      expect(anyBoard().cellsByKey.get(landed[1]).piece).toBeNull();
      expect(anyBoard().cellsByKey.get(gates[1]).piece.uid).toBe('runner1');
      expect(anyBoard().panelMoved.get('runner1')).toBeUndefined();
    });

    it('shuts a hex the turn move has only staged clear', () => {
      const gate = onGate();
      board.onHexClick(anyBoard().cellsByKey.get(gate));
      const to = boardTargets()[0].key;
      anyBoard().selectedHex = null;

      // A crossing reaches the engine before the move that ends the turn, so
      // a hex the staged move only appears to have cleared is still occupied
      // when the crossing lands - and the unit would be lost between the two
      // pictures. Standing on it on the committed board is enough to shut it.
      board.committedBoard = {
        [to]: { unit_id: 'guard', color: 'black', hp: 9, max_hp: 9 },
      } as any;
      board.onHexClick(anyBoard().cellsByKey.get(gate));

      expect(boardTargets().map((c: any) => c.key)).not.toContain(to);
      // Only that hex shut; the rest of the way in is still open.
      expect(boardTargets().length).toBeGreaterThan(0);
    });

    it('keeps a reserve that crossed out of its panel for good', () => {
      const gate = onGate();
      const to = cross(gate);
      const unit = anyBoard().reserves[gate];

      // Committed: the crossing is in the record, and the panel hex it left
      // is empty whether or not the unit is still standing on the board.
      board.departedUids = [unit.uid];
      const entered: Record<string, any> = { ...boardState, [to]: unit };
      board.boardState = entered;
      // The turn ends as a commit does, which drops the staged overlay: from
      // here the record is the only thing saying the unit ever left.
      board.turnNumber = 21;
      board.ngOnChanges({
        boardState: new SimpleChange(null, entered, false),
        departedUids: new SimpleChange([], board.departedUids, false),
        turnNumber: new SimpleChange(20, 21, false),
      });
      expect(anyBoard().cellsByKey.get(gate).piece).toBeNull();
      expect(anyBoard().cellsByKey.get(to).piece.uid).toBe(unit.uid);

      // And when it dies, the board stops naming it - which must not put it
      // back in the panel, whole and ready to cross a second time.
      board.boardState = boardState;
      board.ngOnChanges({ boardState: new SimpleChange(null, boardState, false) });
      expect(anyBoard().cellsByKey.get(gate).piece).toBeNull();
      expect(board.cells.some(c => c.piece?.uid === unit.uid)).toBeFalse();
    });

    it('gives a unit that has crossed nothing more this turn', () => {
      const to = cross(onGate());
      board.onHexClick(anyBoard().cellsByKey.get(to));
      // The whole reach was offered before the crossing was taken, so there
      // is nothing left to plot - and nothing to swing at on the way in.
      expect(board.legalTargets.size).toBe(0);
      expect(board.attackTargets.size).toBe(0);
    });
  });

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

      // And outside the opening too. The reserve used to shuffle freely once
      // the opening was over; it carries the allowance all match now.
      enterTurn(1, 20);
      ['a', 'b', 'c'].forEach(uid => anyBoard().reserveMovers.add(uid));
      board.onHexClick(res);
      expect(board.legalTargets.size).toBe(0);

      // The two panels' allowances are separate: a base full of movers does
      // not spend the reserve's, and a fourth in the reserve is still refused.
      enterTurn(20, 21);
      ['d', 'e', 'f'].forEach(uid => anyBoard().baseMovers.add(uid));
      board.onHexClick(res);
      expect(board.legalTargets.size).toBeGreaterThan(0);
    });

    it('marks a panel unit that has been started this turn', () => {
      const res = reserveCell();
      enterTurn(1, 20);
      expect(board.hasWalked(res)).toBeFalse();

      board.onHexClick(res);
      const to = [...board.legalTargets][0];
      board.onHexClick(anyBoard().cellsByKey.get(to));

      // The mark follows the unit, not the hex it set off from.
      const moved = anyBoard().cellsByKey.get(to);
      expect(board.hasWalked(moved)).toBeTrue();
      // The board is OnPush. A real click marks its view dirty on the way in;
      // calling the handler here does not, so the mark has to be made by hand
      // - and through the component's own ref, which is the one its internals
      // use. The fixture's is a different ref and leaves the DOM stale.
      anyBoard().cdr.markForCheck();
      fixture.detectChanges();
      const plate = fixture.nativeElement.querySelector(
        `[data-pop="${to}"]`) as HTMLElement;
      expect(plate.classList).toContain('panel-walked');
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

      // The lock lifts with the phase, not with the turn. The opening is
      // three full turns, so it is hand-over 7 that leaves it - a full turn
      // being white's hand-over and black's.
      enterTurn(3, 7);
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
