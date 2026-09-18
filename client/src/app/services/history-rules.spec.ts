import {
  PANEL_MOVERS_PER_TURN, lockedPanelUnits, openingMovedHexes,
  panelMoverAllowed, panelMoversAt,
} from './history-rules';

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
      expect(PANEL_MOVERS_PER_TURN).toBe(3);
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
  });
});
