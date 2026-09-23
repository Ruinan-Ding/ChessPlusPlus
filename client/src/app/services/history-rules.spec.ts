import {
  boardMovesAt, homecomingsAt, lockedPanelUnits,
  openingMovedHexes, panelMoverAllowed, panelMoversAt,
} from './history-rules';
import { ruleOf } from './config.service';

/**
 * These read the opening's lock and the panels' allowance off the record, and
 * three places lean on the answers: the room after a reload, the offline
 * engine, and the board when it checks itself. Each mirrors a server function,
 * so the cases below are the ones where the two could drift apart.
 *
 * Plies 1-6 are the opening - three full turns - so 7 is the first outside it.
 */
describe('history-rules', () => {
  /** A battlefield move, as the record holds one. */
  const moved = (color: string, to: string, turn: number) => ({
    from: '0,0', to, color, turn, moved: true,
  });

  /** A panel walk or a crossing, which carry the unit and its uid. */
  const panelStep = (uid: string, color: string, turn: number, over: any = {}) => ({
    from: 'bl-1', to: 'bl-2', turn, panelMove: true,
    unit: { uid, color, unit_id: 'pawn' }, panel: 'bl', ...over,
  });

  describe('openingMovedHexes', () => {
    it("lists where a side's moved units now stand, this side only", () => {
      const history = [moved('white', '-5,8', 1), moved('black', '5,8', 2)];
      expect([...openingMovedHexes(history, 'white')]).toEqual(['-5,8']);
      expect([...openingMovedHexes(history, 'black')]).toEqual(['5,8']);
    });

    it('counts nothing outside the opening', () => {
      expect(openingMovedHexes([moved('white', '-5,8', 7)], 'white').size).toBe(0);
    });

    it('leaves out everything that is not a battlefield move', () => {
      // A crossing is the reserve's move, a walk home takes the unit off the
      // board, a panel walk never touches it, and a cast is nobody's move.
      const history = [
        { ...moved('white', '-5,8', 1), entered: true },
        { ...moved('white', '-6,8', 1), withdrawn: true },
        { ...moved('white', '-7,8', 1), panelMove: true },
        { ...moved('white', '-8,8', 1), panelEffect: true },
      ];
      expect(openingMovedHexes(history, 'white').size).toBe(0);
    });

    it('keys a hex the same however the message spelled it', () => {
      // A record keeps whatever form the message used; a stray space would
      // otherwise hide a unit that has already moved.
      expect([...openingMovedHexes([moved('white', ' -5, 8 ', 1)], 'white')])
        .toEqual(['-5,8']);
    });
  });

  describe('lockedPanelUnits', () => {
    it('locks a unit that walked on an earlier turn of the opening', () => {
      expect(lockedPanelUnits([panelStep('r1', 'white', 1)], 3).has('r1')).toBeTrue();
    });

    it("does not lock a unit for its own turn's walks", () => {
      // A panel unit is walked a few steps at a time and each step is a
      // record; locking on those would stop it after one step.
      expect(lockedPanelUnits([panelStep('r1', 'white', 3)], 3).has('r1')).toBeFalse();
    });

    it('locks nobody once the opening is over', () => {
      expect(lockedPanelUnits([panelStep('r1', 'white', 1)], 7).size).toBe(0);
    });

    it('locks a unit that crossed, a crossing being a move too', () => {
      const crossing = panelStep('r1', 'white', 1, { panelMove: false, entered: true });
      expect(lockedPanelUnits([crossing], 3).has('r1')).toBeTrue();
    });
  });

  describe('panelMoversAt', () => {
    it('spends a base mover on a base walk and a reserve one on a crossing', () => {
      const history = [
        panelStep('b1', 'white', 1),                                   // panel 'bl'
        panelStep('r1', 'white', 1, { panel: 'br' }),                  // a reserve
        panelStep('c1', 'white', 1, { panelMove: false, entered: true }),
      ];
      const movers = panelMoversAt(history, 1, 'white');
      expect([...movers.base]).toEqual(['b1']);
      expect([...movers.reserve].sort()).toEqual(['c1', 'r1']);
    });

    it('counts only this ply, and only this side', () => {
      const history = [panelStep('r1', 'white', 1), panelStep('r2', 'black', 2)];
      expect(panelMoversAt(history, 2, 'white').base.size).toBe(0);
      expect(panelMoversAt(history, 1, 'black').base.size).toBe(0);
    });
  });

  describe('panelMoverAllowed', () => {
    const three = [0, 1, 2].map(i => panelStep(`b${i}`, 'white', 1));

    it('turns a fourth unit of the same panel away', () => {
      expect(ruleOf(undefined, 'panelMoversPerTurn')).toBe(3);
      expect(panelMoverAllowed(three, 1, 'white', 'b9', 'bl')).toBeFalse();
    });

    it('lets one of the three keep walking', () => {
      // The cap is on how many units are started, not on how far they go.
      expect(panelMoverAllowed(three, 1, 'white', 'b1', 'bl')).toBeTrue();
    });

    it("keeps each panel's allowance to itself", () => {
      // Three out of the base does not spend the reserve's three.
      expect(panelMoverAllowed(three, 1, 'white', 'r9', 'br')).toBeTrue();
    });

    it('lets five out of a reserve in a phase initialization', () => {
      // The owner's number, and it stands INSTEAD of the three rather than
      // beside it. Ply 7 is turn 4 - Phase 1's own initialization turn.
      // `panelStep` walks inside the BASE by default; these are the reserve's.
      const five = [0, 1, 2, 3, 4].map(
        i => panelStep(`r${i}`, 'white', 7, { panel: 'br' }));
      expect(ruleOf(undefined, 'phaseInitEntries')).toBe(5);
      expect(panelMoverAllowed(five.slice(0, 4), 7, 'white', 'r9', 'br')).toBeTrue();
      expect(panelMoverAllowed(five, 7, 'white', 'r9', 'br')).toBeFalse();
      // One of the five may still walk on.
      expect(panelMoverAllowed(five, 7, 'white', 'r2', 'br')).toBeTrue();
    });

    it('leaves the base at three on that turn, and both at three off it', () => {
      // Nothing in the rule was about the base, and the wrap is shut on an
      // initialization turn anyway.
      const four = [0, 1, 2, 3].map(i => panelStep(`b${i}`, 'white', 7));
      expect(panelMoverAllowed(four.slice(0, 3), 7, 'white', 'b9', 'bl')).toBeFalse();
      // Ply 9 is turn 5, Phase 1's play: the reserve is back to three.
      const fourReserve = [0, 1, 2, 3].map(
        i => panelStep(`r${i}`, 'white', 9, { panel: 'br' }));
      expect(panelMoverAllowed(fourReserve.slice(0, 3), 9, 'white', 'r9', 'br')).toBeFalse();
    });

    it("reads both allowances off the game's config", () => {
      // Tuning them is a config edit: a room that says two stops the third.
      const config = { rules: { panelMoversPerTurn: 2, phaseInitEntries: 1 } };
      const two = [0, 1].map(i => panelStep(`b${i}`, 'white', 1));
      expect(panelMoverAllowed(two, 1, 'white', 'b9', 'bl')).toBeTrue();
      expect(panelMoverAllowed(two, 1, 'white', 'b9', 'bl', config)).toBeFalse();
      const one = [panelStep('r0', 'white', 7, { panel: 'br' })];
      expect(panelMoverAllowed(one, 7, 'white', 'r9', 'br')).toBeTrue();
      expect(panelMoverAllowed(one, 7, 'white', 'r9', 'br', config)).toBeFalse();
    });
  });

  describe('homecomingsAt', () => {
    /** A walk home, as `move` records one: the unit rides in the record. */
    const walkHome = (uid: string, color: string, turn: number) => ({
      from: '-11,11', to: '-12,11', turn, withdrawn: true, moved: true,
      unit: { unit_id: 'pawn', color, hp: 20, max_hp: 20, uid },
    });

    it('counts this ply\'s walks home, by uid', () => {
      const history = [walkHome('w1', 'white', 7), walkHome('w2', 'white', 7)];
      expect([...homecomingsAt(history, 7, 'white')].sort()).toEqual(['w1', 'w2']);
    });

    it('counts only this ply, and only this side', () => {
      const history = [
        walkHome('w1', 'white', 7),      // an earlier ply
        walkHome('w2', 'white', 9),
        walkHome('b1', 'black', 9),      // the other side's
      ];
      expect([...homecomingsAt(history, 9, 'white')]).toEqual(['w2']);
      expect([...homecomingsAt(history, 9, 'black')]).toEqual(['b1']);
    });

    it('ignores every record that is not a walk home', () => {
      // A crossing and a panel walk both carry a unit; neither leaves the
      // board for a base, so neither spends one of the turn's three.
      const history = [
        panelStep('r1', 'white', 7),
        { from: '-5,9', to: '-5,8', turn: 7, moved: true, color: 'white' },
        walkHome('w1', 'white', 7),
      ];
      expect([...homecomingsAt(history, 7, 'white')]).toEqual(['w1']);
    });

    it('survives a record with no unit on it', () => {
      const history = [{ turn: 7, withdrawn: true }, walkHome('w1', 'white', 7)];
      expect([...homecomingsAt(history, 7, 'white')]).toEqual(['w1']);
      expect(homecomingsAt(undefined, 7, 'white').size).toBe(0);
    });
  });
});

/**
 * How many board moves a side has already made in a hand-over.
 *
 * "Has this side moved yet" was a yes/no while a turn held one board move.
 * Overtime 2 and 3 allow two and three, so it became a count - and the count
 * decides whether the next message hands the turn over, which makes getting
 * the exclusions right load-bearing rather than tidy.
 *
 * Mirrors `board_moves_at` in server/game/engine/game_logic.py.
 */
describe('boardMovesAt', () => {
  const move = (extra: Record<string, unknown> = {}) =>
    ({ turn: 89, color: 'white', from: '0,0', to: '0,1', ...extra });

  it('counts a side’s own board moves in the hand-over asked about', () => {
    const history: any[] = [
      move(), move({ from: '5,5', to: '5,6' }),
      move({ color: 'black' }),          // the other side
      move({ turn: 90 }),                // a later hand-over
      move({ turn: 87 }),                // an earlier one
    ];
    expect(boardMovesAt(history, 89, 'white')).toBe(2);
    expect(boardMovesAt(history, 89, 'black')).toBe(1);
    expect(boardMovesAt(history, 90, 'white')).toBe(1);
    expect(boardMovesAt(undefined, 89, 'white')).toBe(0);
  });

  it('spends nothing on a panel’s own moves', () => {
    // A crossing, a walk inside a panel and a cast’s damage each have an
    // allowance of their own. Counted here they would spend the board’s, and
    // a side that deployed three units out of its reserve would find it had
    // no move left on the board at all.
    const history: any[] = [
      move({ entered: true }),
      move({ panelMove: true }),
      move({ panelEffect: true }),
    ];
    expect(boardMovesAt(history, 89, 'white')).toBe(0);
  });

  it('counts a walk home in overtime but not while setting out', () => {
    // The owner’s exception. In overtime a walk home IS the turn’s board
    // action - that is what the window there is for - so it spends a move. On
    // a setup turn three go as deployments and none of them is that action.
    const home = [move({ withdrawn: true, turn: 89 })] as any[];
    expect(boardMovesAt(home, 89, 'white')).toBe(1);
    // Ply 7 is turn 4, Phase 1’s initialization turn.
    const setup = [move({ withdrawn: true, turn: 7 })] as any[];
    expect(boardMovesAt(setup, 7, 'white')).toBe(0);
  });
});
