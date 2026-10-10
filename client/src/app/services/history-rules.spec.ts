import {
  boardMovesAt, homecomingsAt, lockedPanelUnits,
  openingMovedHexes, panelMoverAllowed, panelMoversAt, unitVeterancy, promotionHeals,
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
      expect([...openingMovedHexes(history, 'white')]).toEqual(['-5,8']);
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

  describe('panelMoverAllowed' , () => {
    it('uses independent stage limits for base and reserve on both sides', () => {
      for (const [whitePly, cap] of [[1, 1], [3, 2], [5, 3], [7, 1], [27, 3], [49, 3], [71, 3], [73, 1], [89, 2], [99, 3]]) {
        for (const [color, ply, base, reserve] of [['white', whitePly, 'bl', 'br'], ['black', whitePly + 1, 'tr', 'tl']] as const) {
          const history = Array.from({ length: cap }, (_, i) => panelStep(`b${i}`, color, ply, { panel: base }));
          expect(panelMoverAllowed(history, ply, color, 'fresh', base)).withContext(`${color} ${ply}`).toBeFalse();
          expect(panelMoverAllowed(history, ply, color, `b${cap - 1}`, base)).toBeTrue();
          expect(panelMoverAllowed(history, ply, color, 'fresh', reserve)).toBeTrue();
        }
      }
    });

    it('keeps Cast’s immediate reserve action separate from the ordinary reserve allowance', () => {
      const control = { turn: 55, control: { unit_id: 'pawn', color: 'white', uid: 'controlled', controlTurn: 55, controlledUntil: 57, hp: 12, max_hp: 12 } };
      expect(panelMoverAllowed([control, panelStep('ordinary', 'white', 55, { panel: 'br' })], 55, 'white', 'controlled', 'tl')).toBeTrue();
      expect(panelMoverAllowed([control, panelStep('controlled', 'white', 55, { panel: 'tl' })], 55, 'white', 'ordinary', 'br')).toBeTrue();
    });

    it('ends the prior walk after switching units, and Undo restores it', () => {
      const history = [panelStep('a', 'white', 27), panelStep('b', 'white', 27)];
      expect(panelMoverAllowed(history, 27, 'white', 'a', 'bl')).toBeFalse();
      expect(panelMoverAllowed(history, 27, 'white', 'b', 'bl')).toBeTrue();
      expect(panelMoverAllowed(history.slice(0, 1), 27, 'white', 'a', 'bl')).toBeTrue();
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
    // Ply 27 is turn 14, Phase 1’s postmatch.
    const setup = [move({ withdrawn: true, turn: 27 })] as any[];
    expect(boardMovesAt(setup, 27, 'white')).toBe(1);
  });
});


describe('phase awards and Strengthen veterancy', () => {
  const rank = (at: string, ply: number, history: any[] = [], orientation = 'edge-up') =>
    unitVeterancy('v', at, history, ply, 11, orientation);
  const step = (turn: number, from: string, to: string, flags: any = {}) => ({
    turn, from, to, unit: { uid: 'v' }, panelMove: true, ...flags,
  });

  it('retains Strengthen stars across reload and future awards without awarding a second star for the same boundary', () => {
    const history: any[] = [{ turn: 9, promotion: { uid: 'v', vet: 2 } }];
    expect(rank('0,0', 8, history)).toBe(1);
    expect(rank('0,0', 9, history)).toBe(2);
    expect(rank('0,0', 27, JSON.parse(JSON.stringify(history)))).toBe(3);
    expect(rank('0,0', 71, history)).toBe(3);
    expect(rank('-12,1', 71, history)).toBe(2);
  });

  it('awards both sides only at Phase 1 and postmatch starts, capped at three', () => {
    for (const at of ['0,0', '11,1', '-11,-1']) {
      for (const [ply, vet] of [[1, 0], [6, 0], [7, 1], [8, 1], [17, 1], [26, 1],
        [27, 2], [28, 2], [29, 2], [48, 2], [49, 3], [50, 3], [51, 3], [71, 3], [73, 3], [99, 3]]) {
        expect(rank(at, ply)).withContext(`${at} at ${ply}`).toBe(vet);
      }
    }
    for (const at of ['-12,1', '12,-1']) expect(rank(at, 99)).toBe(0);
  });

  it('counts location at the award, not current location or the source panel label', () => {
    const history = [step(8, '-12,1', '11,1', { panel: 'bl' }),
      step(27, '11,1', '3,8', { panelMove: false, entered: true })];
    expect(rank('3,8', 27, history)).toBe(1);
    expect(rank('3,8', 28, history)).toBe(1); // black's half grants nothing extra
    expect(rank('0,0', 49, history)).toBe(2); // ordinary board walks keep stars
    expect(rank('0,0', 71, JSON.parse(JSON.stringify(history)))).toBe(3);
  });

  it('awards before deployments made during the boundary ply', () => {
    const history = [step(7, '-12,1', '11,1')];
    expect(rank('11,1', 7, history)).toBe(0);
    expect(rank('11,1', 8, history)).toBe(0);
    expect(rank('11,1', 27, history)).toBe(1);
  });

  it('keeps earned stars in a base, earns none there, and resumes in reserve', () => {
    const history = [step(28, '3,8', '-12,9', { panelMove: false, withdrawn: true }),
      step(50, '-12,9', '11,1')];
    expect(rank('-12,9', 49, history.slice(0, 1))).toBe(2);
    expect(rank('11,1', 50, history)).toBe(2);
    expect(rank('11,1', 71, history)).toBe(3);
  });

  it('ignores combat and other units, and respects either board orientation', () => {
    const history = [{ turn: 6, attacked: true, damage_dealt: 99, captured: 'pawn' },
      step(6, '11,1', '-12,1', { unit: { uid: 'other' } })];
    expect(rank('0,0', 6, history)).toBe(0);
    expect(rank('0,0', 27, history)).toBe(2);
    expect(rank('-6,12', 7, [], 'edge-up')).toBe(1);
    expect(rank('-6,12', 7, [], 'vertex-up')).toBe(0);
  });
});


describe('Phase 3 promotion healing', () => {
  const config = { board: { radius: 11, orientation: 'edge-up' }, units: { pawn: { hp: 12 } } };
  const unit = (uid: string, color = 'white', hp = 1) => ({ uid, color, unit_id: 'pawn', hp, max_hp: 12 });
  const wound = (uid: string, at: string, panel: string, hp = 1) => ({
    turn: 60, from: '', to: '', intoPanel: true, panelEffect: true,
    unit: unit(uid), attackedHex: at, panel, defenderHp: hp,
  });

  it('fully heals only living field and reserve units already at vet 3 before the award', () => {
    const board: any = { '0,0': unit('early'), '1,0': unit('black', 'black'),
      '2,0': unit('late'), '3,0': unit('dead', 'white', 0) };
    const history: any[] = [{ turn: 8, from: '-12,1', to: '2,0', entered: true, unit: unit('late') },
      wound('reserve', '11,1', 'br'), wound('base', '-12,1', 'bl'),
      wound('lost', '11,2', 'br', 0),
      { turn: 8, from: '-12,2', to: '12,1', panelMove: true, unit: unit('newReserve') },
      wound('newReserve', '12,1', 'br')];
    expect(promotionHeals(config, board, history, 70)).toEqual([]);
    expect(board['0,0'].hp).toBe(1);
    const effects = promotionHeals(config, board, history, 71);
    expect(board['0,0'].hp).toBe(12);
    expect(board['1,0'].hp).toBe(12);
    expect(board['2,0'].hp).toBe(1);
    expect(board['3,0'].hp).toBe(0);
    expect(effects.map(e => e.unit.uid)).toEqual(['reserve']);
    expect(effects[0].defenderHp).toBe(12);
    expect(effects[0].promotionHeal).toBeTrue();
    expect(promotionHeals(config, board, [...history, ...effects], 72)).toEqual([]);
  });
});
