import { BehaviorSubject, Subject, of } from 'rxjs';
import { GameRoomComponent } from './game-room.component';
import { NavigationStateService } from '../../services/navigation-state.service';

/**
 * The ability panel decides everything below on its own fields, so it is built
 * by hand rather than stood up in a room: TestBed here would exercise the DI
 * container and the router, neither of which has an opinion about picking.
 */
describe('GameRoomComponent ability panel', () => {
  /** Bulwark - carried from the pool, aimed at one of your own units. */
  const TARGETED = 2;
  /** Sap, the ability Bulwark brings with it: the pool is picked in pairs. */
  const TARGETED_PAIR = 3;
  /** Rally - carried from the pool, no target at all. */
  const UNIVERSAL = 7;
  /** Temper, Rally's partner. */
  const UNIVERSAL_PAIR = 6;

  /**
   * Abilities are bought with CP, which is derived from the phase rather than
   * held in a field - two awards of 100 by Phase 1 - so a test that wants a
   * side on a particular balance sets what it has already spent.
   */
  const giveCp = (c: any, cp: number) => {
    // Turn 5, Phase 1's first played turn. Not turn 4: that is the phase's own
    // initialization, and nothing is cast on a turn given to setting out.
    c.gameState.snapshot.turnNumber = 10;
    c.myCpSpent = 200 - cp;
  };

  const room = (): any => {
    const cdr = { markForCheck: () => {}, detectChanges: () => {} } as any;
    const gameState = { snapshot: { currentTurn: 'me' }, myColor: () => 'white' } as any;
    // Picking flashes and sounds, and ending a turn talks to the socket.
    const audio = { playTone: () => {} } as any;
    const ws = { sendMessage: () => {} } as any;
    const c: any = new GameRoomComponent(
      ws, {} as any, {} as any, {} as any, {} as any,
      cdr, gameState, {} as any, audio,
    );
    c.username = 'me';
    c.gameStarted = true;
    c.isSinglePlayer = true;
    c.myPoints = 10;
    return c;
  };

  it('picks without using: the ability is opened again to arm it', () => {
    const c = room();
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    c.pickAbility('mine', TARGETED);
    expect(c.isPicked('mine', TARGETED)).toBeTrue();
    // Back to the list, nothing armed and nothing spent.
    expect(c.pendingAbility).toBeNull();
    expect(c.isAbilityFocused('mine', TARGETED)).toBeFalse();
    expect(c.myCpSpent).toBe(0);

    // Opening it a second time is what arms it.
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.pendingAbility).toEqual(
      jasmine.objectContaining({ side: 'mine', index: TARGETED }));
  });

  it('keeps a unit that crossed and later walked home at home, not departed', () => {
    // `departedUids` was every unit that had EVER crossed, and the board hides
    // any panel unit named in it - so a reserve unit that crossed and walked
    // home was put back in its base and filtered straight out again.
    const c = room();
    c.gameState.snapshot.moveHistory = [
      { entered: true, to: '3,8', unit: { uid: 'rbr4' } },
      { withdrawn: true, to: '-12,11', unit: { uid: 'rbr4' } },
    ];
    expect(c.departedUids).toEqual([]);
    expect(c.panelPositions).toEqual({ rbr4: '-12,11' });

    // A walk inside the base moves it on; a second crossing departs it again.
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { panelMove: true, to: '-12,10', unit: { uid: 'rbr4' } },
    ];
    expect(c.panelPositions).toEqual({ rbr4: '-12,10' });
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { entered: true, to: '3,8', unit: { uid: 'rbr4' } },
    ];
    expect(c.departedUids).toEqual(['rbr4']);
    expect(c.panelPositions).toEqual({});
  });

  it('pays overtime’s turns at the stretch’s rate, both ways round', () => {
    // Two places hand out the turn point and they must agree: `beginTurnFor`
    // pays it live as a side starts, and `pointsFromHistory` re-derives the
    // whole purse from the record on every commit. A flat 1 in either one is
    // invisible until overtime, where the rates part company - and then the
    // purse jumps every time a commit overwrites the live tally.
    const c = room();
    c.gameState.snapshot.config = { units: {} };
    c.gameState.snapshot.moveHistory = [];

    // Turn 44 is the last of Overtime 1: 44 turns at one apiece.
    c.gameState.snapshot.turnNumber = 2 * 44 - 1;
    expect(c.pointsFromHistory('white')).toBe(44);
    // Turn 45 is Overtime 2, which pays three.
    c.gameState.snapshot.turnNumber = 2 * 45 - 1;
    expect(c.pointsFromHistory('white')).toBe(47);
    // The last turn pays five: 44 + 5x3 + 5.
    c.gameState.snapshot.turnNumber = 2 * 50 - 1;
    expect(c.pointsFromHistory('white')).toBe(64);

    // And the live award reads the same table. The snapshot has already moved
    // on to the hand-over the side is about to play, which is the one paid for.
    const paid = (ply: number) => {
      c.gameState.snapshot.turnNumber = ply;
      c.myPoints = 0;
      c.beginTurnFor('white');
      return c.myPoints;
    };
    expect(paid(1)).toBe(1);
    expect(paid(2 * 44 - 1)).toBe(1);
    expect(paid(2 * 45 - 1)).toBe(3);
    expect(paid(2 * 50 - 1)).toBe(5);
  });

  it('adds up points from the history exactly the way the server does', () => {
    // The server prices the wrap against this sum (engine/economy.py), so a
    // purse that disagrees offers a crossing the server then refuses.
    const c = room();
    c.gameState.snapshot.config = { units: { knight: { value: 12 } } };
    c.gameState.snapshot.turnNumber = 21;
    c.gameState.snapshot.moveHistory = [];
    // A point for each of white's eleven turns begun by ply 21.
    expect(c.pointsFromHistory('white')).toBe(11);
    expect(c.pointsFromHistory('black')).toBe(10);

    const wrap = { panelMove: true, price: 12, unit: { color: 'white' } };
    const home = { withdrawn: true, color: 'white', unit_id: 'knight', unit: {} };
    c.gameState.snapshot.moveHistory = [wrap];
    expect(c.pointsFromHistory('white')).toBe(-1);
    // A round trip costs nothing.
    c.gameState.snapshot.moveHistory = [wrap, home];
    expect(c.pointsFromHistory('white')).toBe(11);

    // A kill pays its maker; the attacker dying to a counter pays the defender;
    // a cast that kills pays nobody.
    c.gameState.snapshot.moveHistory = [
      { color: 'white', defender_eliminated: true },
      { color: 'black', attacker_eliminated: true },
      { panelEffect: true, color: 'white', defender_eliminated: true },
    ];
    expect(c.pointsFromHistory('white')).toBe(13);
    expect(c.pointsFromHistory('black')).toBe(10);
  });

  it('resets both purses from the history in a networked room, and leaves solo alone', () => {
    const networked = room();
    networked.isSinglePlayer = false;
    networked.gameState.snapshot.config = { units: {} };
    networked.gameState.snapshot.turnNumber = 3;
    networked.gameState.snapshot.moveHistory = [];
    networked.myPoints = 99;          // a stale tally, as after a reload
    networked.reconcilePoints();
    expect(networked.myPoints).toBe(2);
    expect(networked.opponentPoints).toBe(1);

    // Solo buys abilities with points, and abilities are not recorded:
    // resetting to the record would hand back every point spent on one.
    const solo = room();
    solo.gameState.snapshot.config = { units: {} };
    solo.gameState.snapshot.turnNumber = 3;
    solo.gameState.snapshot.moveHistory = [];
    solo.myPoints = 99;
    solo.reconcilePoints();
    expect(solo.myPoints).toBe(99);
  });

  it('puts the panels and the toll in play in every room, and keeps abilities solo', () => {
    // These were one gate, `isSinglePlayer`, because no server knew what a
    // panel was or took a toll. The panels went live first, which is why the
    // toll was split off onto a gate of its own; the server takes the toll now
    // too. Abilities are the one thing still the client's alone, so a
    // networked room must still not act on a boost.
    const solo = room();
    expect(solo.entryBind).toBeTrue();
    expect(solo.tollBind).toBeTrue();
    expect(solo.buffsBind).toBeTrue();

    const networked = room();
    networked.isSinglePlayer = false;
    expect(networked.entryBind).toBeTrue();
    expect(networked.tollBind).toBeTrue();
    expect(networked.buffsBind).toBeFalse();
  });

  it('takes a pick back for nothing in the turn it was made', () => {
    // Changing your mind is not swapping. The four-slot cap made the order of
    // picking matter - a pair only fits if it is picked second - and charging
    // three turns of cooldown to undo a pick nobody had used yet turned that
    // into a trap rather than a choice.
    const c = room();
    c.pickAbility('mine', UNIVERSAL);
    expect(c.isPicked('mine', UNIVERSAL)).toBeTrue();

    c.swapArmed = 'mine';
    c.resetAbility('mine', UNIVERSAL);
    expect(c.isPicked('mine', UNIVERSAL)).toBeFalse();
    expect(c.swapDebt.mine).toBe(0);

    // So the next pick arrives cold, the way a first pick does.
    c.pickAbility('mine', TARGETED);
    expect(c.myCooldowns[TARGETED]).toBeFalsy();
    expect(c.myCooldowns[TARGETED_PAIR]).toBeFalsy();
  });

  it('charges for a pair handed back through the cold half of a used pick', () => {
    // The hole the free take-back opened. `canReset` only looks at the index
    // that was clicked, and a click gives the WHOLE pair back - so casting
    // Mend and then handing the pair back through its untouched partner would
    // have cost nothing, freeing a fresh pair to arrive cold and be cast in
    // the same turn. Cast once, re-armed for free, every turn.
    const c = room();
    c.pickAbility('mine', UNIVERSAL);
    expect(c.myLoadout).toEqual([UNIVERSAL_PAIR, UNIVERSAL]);

    // One half has been cast; the other is untouched and still this turn's.
    // A cast writes both the cooldown and the glow - and the glow is what the
    // rule reads, because the cooldown row also holds pairs that merely
    // arrived cold-started off a swapDebt slot and were never used at all.
    c.myCooldowns[UNIVERSAL] = 3;
    c.abilityGlow = { ...c.abilityGlow, mine: [UNIVERSAL] };

    c.swapArmed = 'mine';
    c.resetAbility('mine', UNIVERSAL_PAIR);      // the cold half
    expect(c.myLoadout).toEqual([]);
    expect(c.swapDebt.mine).toBe(2);

    // So the replacement comes in on cooldown, like any other swap.
    c.pickAbility('mine', TARGETED);
    expect(c.myCooldowns[TARGETED]).toBe(3);
  });

  it('still charges for a swap made after the turn it was picked in', () => {
    // The rule that debt was protecting: swapping is not a way to hand
    // yourself a ready ability mid-match.
    const c = room();
    c.pickAbility('mine', UNIVERSAL);
    // A turn has passed - beginTurnFor clears this, and it is the whole test.
    c.pickedThisTurn = [];

    c.swapArmed = 'mine';
    c.resetAbility('mine', UNIVERSAL);
    expect(c.swapDebt.mine).toBe(2);

    c.pickAbility('mine', TARGETED);
    expect(c.myCooldowns[TARGETED]).toBe(3);
  });

  it('draws a cast on a unit that walked home before the turn commits', () => {
    // The base is fed by two derivations and only one of them was staged.
    // A Mend on a withdrawn unit read back its COMMITTED HP, so the unit was
    // drawn unhealed - and a second cast in the same turn worked from that
    // stale number and wiped out the first. Two mends were worth one.
    const c = room();
    c.gameState.snapshot.turnNumber = 8;
    c.gameState.snapshot.moveHistory = [
      {
        to: 'b1', turn: 6, withdrawn: true,
        unit: { uid: 'u1', color: 'white', hp: 9, max_hp: 16 },
      },
    ];

    // Derived alone: what it walked home on, plus whatever it has mended.
    const settled = c.withdrawnUnits[0].unit.hp;
    expect(settled).toBeLessThan(16);

    // A Mend staged this turn, the way hpChange stages one onto a panel unit.
    c.stagedActions = [{ panelUnit: { uid: 'u1' }, panelUnitHp: 16 }];
    expect(c.withdrawnUnits[0].unit.hp).toBe(16);

    // And a staged kill takes it off the base, the same way the record does.
    c.stagedActions = [{ panelUnit: { uid: 'u1' }, panelUnitHp: 0 }];
    expect(c.withdrawnUnits.length).toBe(0);

    // Undo puts the action back and the unit stands again at its own HP.
    c.stagedActions = [];
    expect(c.withdrawnUnits[0].unit.hp).toBe(settled);
  });

  it('names the reason it cannot be used, rather than listing all of them', () => {
    const c = room();
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('Not carried');

    c.pickAbility('mine', TARGETED);
    // A pool ability is bought with points; only the three paths use CP.
    c.myPoints = 0;
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('costs 1 point, you have 0');

    c.myPoints = 10;
    c.myCooldowns[TARGETED] = 2;
    c.clearAbilityFocus();
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('2 more turns');
  });

  it('tells a networked player abilities are solo-only, not that it is not their turn', () => {
    // Abilities stay client-side until the real catalogue settles (PUNCHLIST
    // 6.15). The panels still open, so the reason is what a player reads - and
    // it used to be "not your turn", on their own turn.
    const c = room();
    c.isSinglePlayer = false;
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('single-player only');
    expect(c.focusedAbilityBlocker).not.toContain('not your turn');
    expect(c.pathBlocker('mine', 0)).toContain('single-player only');
    expect(c.abilityBlockedNote).toContain('single-player only');
  });

  it('still says whose turn it is in a solo room', () => {
    const c = room();
    c.gameState.snapshot.currentTurn = 'someone else';
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('not your turn');
    expect(c.pathBlocker('mine', 0)).toContain('not your turn');
  });

  it('names the opening, not the turn, when a carried ability cannot be cast in it', () => {
    // Picking is open through the initialization; casting is not. The cast
    // refusal said "not your turn" there too.
    const c = room();
    c.gameState.snapshot.turnNumber = 1;
    c.pickAbility('mine', TARGETED);
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('initialization');
  });

  it('never lets the clock end a solo turn, so a doomed king plays it out', () => {
    const c = room();
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.playEndTurnSound = () => {};
    c.playTone = () => {};
    c.gameStarted = true;
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = 67;
    c.gameState.snapshot.turnTimeLimit = 60;
    // A turn that ran out a minute ago.
    c.gameState.snapshot.turnStartedAt = new Date(Date.now() - 120_000).toISOString();
    c.lastTimerBeep = 5;

    // Solo: the clock counts to nothing and stops there. Ending the turn is
    // where overtime takes its toll, so a clock that ended it for you killed
    // a king on its last HP while you were still deciding how to save it.
    c.isSinglePlayer = true;
    (c as any).updateTurnClock();
    expect(c.turnSecondsRemaining).toBe(0);
    expect(sent.length).toBe(0);

    // A networked game is unchanged: the server passes for us, and staged
    // work gets one attempt at committing before that lands.
    c.isSinglePlayer = false;
    c.lastTimerBeep = 5;
    c.gameState.snapshot.currentTurn = 'me';
    c.username = 'me';
    c.stagedActions = [{ at: 1, board: {}, from: '0,0', to: '0,1', used: 1, attack: null }];
    (c as any).updateTurnClock();
    expect(sent.length).toBe(1);
  });

  it('folds a unit’s several steps into one board move, and keeps units apart', () => {
    const c = room();
    const step = (from: string, to: string, used: number, attack: string | null = null) =>
      ({ at: 1, board: {}, from, to, used, attack });
    // One unit walking twice pushes two entries, each carrying the hex it set
    // out from - so the later supersedes the earlier rather than adding to it.
    // Then it swings, which pushes a third entry on the same origin.
    c.stagedActions = [
      step('0,0', '0,1', 1),
      step('0,0', '0,2', 2),
      step('0,0', '0,2', 2, '0,3'),
      // A different unit: its own origin, its own board move.
      step('5,5', '5,6', 1),
    ];
    const moves = c.boardMoves;
    expect(moves.length).toBe(2);
    expect(moves[0].from).toBe('0,0');
    expect(moves[0].to).toBe('0,2');
    expect(moves[0].attack).toBe('0,3');
    expect(moves[1].from).toBe('5,5');

    // A cast and a setup turn's walk home are not board moves at all.
    c.stagedActions = [
      { at: 1, board: {}, from: '', to: '', used: 0, attack: null, spend: 3 },
      step('1,1', '1,2', 1),
      { ...step('2,2', '2,3', 1), homecoming: true },
    ];
    expect(c.boardMoves.length).toBe(1);
    expect(c.boardMoves[0].from).toBe('1,1');
  });

  it('writes a blow onto the unit that struck it, not whoever moved last', () => {
    // The bug this test exists for: `prev` was the last board action whoever
    // it belonged to. Once a turn can hold two, a side that walks A and then
    // swings with B wrote B’s blow onto A’s origin - sending A’s hex to B’s
    // target and losing A’s move altogether.
    const c = room();
    c.gameState.snapshot.turnNumber = 2 * 45 - 1;   // Overtime 2: two moves
    c.gameState.snapshot.config = { units: { pawn: { attackRange: 1, atk: 5, def: 0 } } };
    c.gameState.snapshot.boardState = {
      '0,0': { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 9, uid: 'a' },
      '5,5': { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 9, uid: 'b' },
      '5,6': { unit_id: 'pawn', color: 'black', hp: 9, max_hp: 9, uid: 'x' },
    };
    // A walks.
    c.onPlayerMove({ from: '0,0', to: '0,1', cost: 1 });
    // B strikes from where it stands, having not moved.
    c.onPlayerAttack({ from: '5,5', to: '5,5', attack: '5,6' });

    const moves = c.boardMoves;
    expect(moves.length).toBe(2);
    expect(moves[0].from).toBe('0,0');
    expect(moves[0].to).toBe('0,1');
    expect(moves[0].attack).toBeNull();
    expect(moves[1].from).toBe('5,5');
    expect(moves[1].attack).toBe('5,6');
  });

  it('gives each of the turn’s moves its own blow, and no unit two', () => {
    const c = room();
    c.gameState.snapshot.config = { units: { pawn: { attackRange: 1, atk: 5, def: 0 } } };
    c.gameState.snapshot.boardState = {
      '5,5': { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 9, uid: 'b' },
      '5,6': { unit_id: 'pawn', color: 'black', hp: 99, max_hp: 99, uid: 'x' },
      '0,0': { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 9, uid: 'a' },
      '0,1': { unit_id: 'pawn', color: 'black', hp: 99, max_hp: 99, uid: 'y' },
    };
    // Overtime 1 allows one board move, so one blow and no more - which is
    // every turn of the schedule proper too.
    c.gameState.snapshot.turnNumber = 2 * 40 - 1;
    c.onPlayerAttack({ from: '5,5', to: '5,5', attack: '5,6' });
    expect(c.boardMoves.length).toBe(1);
    c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '0,1' });
    expect(c.boardMoves.length).toBe(1);

    // Overtime 2 allows the second unit its own blow.
    c.stagedActions = [];
    c.gameState.snapshot.turnNumber = 2 * 45 - 1;
    c.onPlayerAttack({ from: '5,5', to: '5,5', attack: '5,6' });
    c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '0,1' });
    expect(c.boardMoves.length).toBe(2);
    // But never twice with the same unit: the swing ends that unit’s move.
    c.onPlayerAttack({ from: '5,5', to: '5,5', attack: '5,6' });
    expect(c.boardMoves.length).toBe(2);
    expect(c.boardMoves.filter((m: any) => m.attack).length).toBe(2);
  });

  it('counts units, not moves: one unit never takes two', () => {
    const c = room();
    c.gameState.snapshot.turnNumber = 2 * 50 - 1;          // Overtime 3
    c.gameState.snapshot.config = { units: { pawn: { move: 3, value: 4 } } };
    c.gameState.snapshot.boardState = {
      '0,0': { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 9, uid: 'a' },
      '5,5': { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 9, uid: 'b' },
    };
    c.onPlayerMove({ from: '0,0', to: '0,1', cost: 1 });
    c.onPlayerMove({ from: '5,5', to: '5,6', cost: 1 });
    // A is finished the moment B moves, so its hex is in `movedUnitHexes` -
    // the unit still mid-move (B) never is.
    expect(c.movedUnitHexes).toEqual(['0,1']);

    // A coming back for a second go is refused, though the stretch has a
    // third move to give.
    c.onPlayerMove({ from: '0,1', to: '0,2', cost: 1 });
    expect(c.boardMoves.length).toBe(2);
    expect(c.boardMoves.map((m: any) => m.from + '->' + m.to))
      .toEqual(['0,0->0,1', '5,5->5,6']);

    // B, still mid-move, may finish its own walk - and that folds into B's
    // one move rather than spending another.
    c.onPlayerMove({ from: '5,6', to: '5,7', cost: 1 });
    expect(c.boardMoves.length).toBe(2);
    expect(c.boardMoves[1].from).toBe('5,5');
    expect(c.boardMoves[1].to).toBe('5,7');
  });

  it('sends every board move of a turn, and only the last hands it over', () => {
    const c = room();
    const sent: any[] = [];
    c.wsService.sendMessage = (m: any) => sent.push(m);
    // Ply 89 is turn 45 - Overtime 2, two board moves to a side.
    c.gameState.snapshot.turnNumber = 2 * 45 - 1;
    c.stagedActions = [
      { at: 1, board: {}, from: '0,0', to: '0,1', used: 1, attack: null },
      { at: 2, board: {}, from: '5,5', to: '5,6', used: 1, attack: '5,7' },
    ];

    c.endTurn();
    const moves = sent.filter(m => m.type === 'make_move');
    expect(moves.length).toBe(2);
    // The first holds the seat; the second ends the turn. Both engines answer
    // a held move as a deployment - same seat, same ply, toll untaken.
    expect(moves[0].more).toBeTrue();
    expect(moves[0].from).toBe('0,0');
    expect(moves[1].more).toBeUndefined();
    expect(moves[1].from).toBe('5,5');
    // Each carries its own swing: the owner’s rule is that every one of the
    // turn’s moves may strike, so a single attack folded onto the last
    // message would drop the others.
    expect(moves[1].attack).toBe('5,7');
  });

  it('still sends exactly one move where the schedule allows one', () => {
    // Every turn of the schedule proper. The multi-move path has to collapse
    // to precisely what it always sent, or 44 turns of every match change.
    const c = room();
    const sent: any[] = [];
    c.wsService.sendMessage = (m: any) => sent.push(m);
    c.gameState.snapshot.turnNumber = 9;
    c.stagedActions = [
      { at: 1, board: {}, from: '0,0', to: '0,1', used: 1, attack: null },
      { at: 2, board: {}, from: '0,0', to: '0,2', used: 2, attack: null },
    ];

    c.endTurn();
    const moves = sent.filter(m => m.type === 'make_move');
    expect(moves.length).toBe(1);
    expect(moves[0].more).toBeUndefined();
    expect(moves[0].from).toBe('0,0');
    expect(moves[0].to).toBe('0,2');
  });

  it('reads its whole catalogue off the config, so tuning one is a config edit', () => {
    const c = room();
    // The shipped default is what an empty room draws from - one catalogue,
    // not a second copy hard-coded on the component.
    expect(c.abilityIds.length).toBe(17);
    expect(c.abilityIds.slice(0, 3)).toEqual(['dash', 'focus', 'bulwark']);
    expect(c.abilityEffects[0].name).toBe('Dash');
    expect(c.abilityEffects[0].mov).toBe(2);
    // The zeros a config leaves out are filled in: every reader wants a
    // number, and `undefined` reached a stat line as NaN.
    expect(c.abilityEffects[0].atk).toBe(0);
    expect(c.abilityEffects[0].def).toBe(0);

    // A game's own config wins over the default, which is the whole point.
    c.gameState.snapshot.config = {
      abilities: {
        slots: 1,
        pool: ['zap'],
        paths: [],
        catalogue: { zap: { id: 'zap', name: 'Zap', target: 'enemy', cost: 9, damage: 3 } },
      },
    };
    expect(c.abilityIds).toEqual(['zap']);
    expect(c.abilityEffects[0].name).toBe('Zap');
    expect(c.abilityCosts).toEqual([9]);
    expect(c.abilitySlots).toBe(1);
    expect(c.abilityPool).toEqual([0]);
    expect(c.abilityPaths).toEqual([]);
  });

  it('resolves a path’s abilities from ids to the slots the room asks in', () => {
    const c = room();
    // The config names a path's three by id; `isPathSlot`, `purseFor` and the
    // template all ask in slot numbers, so the translation happens once.
    const bastion = c.abilityPaths[0];
    expect(bastion.id).toBe('bastion');
    expect(c.abilityIds[bastion.passive]).toBe('bastion');
    expect(c.abilityIds[bastion.skill]).toBe('anchor');
    expect(c.abilityIds[bastion.ultimate]).toBe('fortress');
    // And those slots are path slots, which is what decides the purse.
    expect(c.isPathSlot(bastion.skill)).toBeTrue();
    expect(c.isPathSlot(0)).toBeFalse();
  });

  it('marks the owner’s testing levers, so they can be kept out of a real game', () => {
    const c = room();
    const levers = c.abilityEffects.filter((a: any) => a.testing).map((a: any) => a.id);
    // Rally hands out 300 points; letting it into networked play breaks the
    // wrap's price. Mend is its partner on the bench.
    expect(levers.sort()).toEqual(['mend', 'rally']);
    expect(c.abilityEffects[c.slotOfAbility('rally')].points).toBe(300);
  });

  it('saves the ability state by id, so a reordered catalogue keeps its meaning', () => {
    const c = room();
    c.gameId = 'local';
    // A side carrying Bulwark and Sap, on the Tempo path, with Focus cooling.
    c.myLoadout = [c.slotOfAbility('bulwark'), c.slotOfAbility('sap')];
    c.myPath = c.abilityPaths.findIndex((p: any) => p.id === 'tempo');
    c.myCooldowns = c.abilityIds.map(() => 0);
    c.myCooldowns[c.slotOfAbility('focus')] = 2;
    (c as any).persistLocalUiState();

    const saved = JSON.parse(localStorage.getItem('cpp.localGame.ui.v2')!);
    // Ids on the way out - never the slot numbers, which mean nothing away
    // from the catalogue that produced them.
    expect(saved.myLoadout).toEqual(['bulwark', 'sap']);
    expect(saved.myPath).toBe('tempo');
    expect(saved.myCooldowns).toEqual({ focus: 2 });

    // Now reorder the catalogue: same abilities, different slots.
    const base: any = (c as any).abilityConfig;
    c.gameState.snapshot.config = {
      abilities: {
        slots: base.slots,
        pool: [...base.pool].reverse(),
        paths: [...base.paths].reverse(),
        catalogue: base.catalogue,
      },
    };
    const fresh = room();
    fresh.gameId = 'local';
    fresh.gameState.snapshot.config = c.gameState.snapshot.config;
    (fresh as any).restoreLocalUiState();

    // Different slot numbers, the same three abilities. Saved by position,
    // this side would have come back holding somebody else's loadout.
    expect(fresh.myLoadout).not.toEqual(c.myLoadout);
    expect(fresh.myLoadout.map((s: number) => fresh.abilityIds[s])).toEqual(['bulwark', 'sap']);
    expect(fresh.abilityPaths[fresh.myPath!].id).toBe('tempo');
    expect(fresh.myCooldowns[fresh.slotOfAbility('focus')]).toBe(2);
    localStorage.removeItem('cpp.localGame.ui.v2');
  });

  it('drops an ability the catalogue no longer has, rather than pointing at nothing', () => {
    const c = room();
    c.gameId = 'local';
    localStorage.setItem('cpp.localGame.ui.v2', JSON.stringify({
      myLoadout: ['dash', 'retired-ability', 'sap'],
      myPath: 'no-such-path',
      myCooldowns: { focus: 3, 'retired-ability': 9 },
    }));
    (c as any).restoreLocalUiState();

    expect(c.myLoadout.map((s: number) => c.abilityIds[s])).toEqual(['dash', 'sap']);
    // A path this config does not know reads as no path, which is the same
    // answer a side that never took one gives.
    expect(c.myPath).toBeNull();
    expect(c.myCooldowns[c.slotOfAbility('focus')]).toBe(3);
    localStorage.removeItem('cpp.localGame.ui.v2');
  });

  it('lets nobody act while a committed turn plays itself back', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    expect(c.canEndTurn).toBeTrue();
    expect(c.canUseAbilities('mine')).toBeTrue();

    c.endTurn();
    // The board on screen is the turn being shown, not one to act on.
    expect(c.recapRunning).toBeTrue();
    expect(c.canEndTurn).toBeFalse();
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.canPick('mine', 5)).toBeFalse();

    c.onPlaybackDone();
    expect(c.recapRunning).toBeFalse();
    expect(c.canUseAbilities('mine')).toBeTrue();
  });

  it('stays locked across the handover that lands mid-replay', async () => {
    const c = room();
    c.gameState.snapshot.turnTimeLimit = 0;
    c.gameState.applyTurnPassed = () => {};
    // The real socket answers in a microtask (local-game.service.ts emit), so
    // in a solo game the turn changes hands *between* the commit and the
    // first beat of the replay - the board's run only starts on a timer. That
    // gap is the window the lock has to survive, and a stubbed-silent socket
    // never opens it.
    c.wsService.sendMessage = (msg: any) => {
      if (msg.type !== 'pass_turn') return;
      queueMicrotask(() => c.handleWebSocketMessage({ type: 'turn_passed', color: 'white' }));
    };
    c.pickAbility('mine', TARGETED);

    c.endTurn();
    expect(c.recapRunning).toBeTrue();

    await Promise.resolve();
    // Whoever is nominally up next, the turn on screen is still playing.
    expect(c.recapRunning).toBeTrue();
    expect(c.canEndTurn).toBeFalse();

    c.onPlaybackDone();
    expect(c.canEndTurn).toBeTrue();
  });

  it('locks and plays a turn that moved nothing, and hands the board back', () => {
    const c = room();
    // Nothing staged, nothing picked - and it is still a commit. The owner's
    // rule is that the commit is watched, because a turn that walked nowhere
    // still mends its base and still bleeds a king in overtime. So the amber
    // curtain goes up on every commit, and the board is handed an empty list
    // to play: it holds a beat for it and answers with playbackDone, which is
    // what brings the curtain back down.
    c.endTurn();
    expect(c.recapRunning).toBeTrue();
    expect(c.playback).toEqual([]);
    expect(c.canUseAbilities('mine')).toBeFalse();

    c.onPlaybackDone();
    expect(c.recapRunning).toBeFalse();
    expect(c.canUseAbilities('mine')).toBeTrue();
  });

  it('says what Mend does, rather than “no effect yet”', () => {
    const c = room();
    // Mend moves no stat and deals no damage, so the hint - which read every
    // other field - had nothing to say about the one ability the owner added
    // for testing, and told the player it did nothing.
    const hint = c.abilityHint(6);
    expect(hint).toContain('+20 HP');
    expect(hint).not.toContain('no effect yet');
  });

  it('keeps the curtain up for the turn that won the match', () => {
    const c = room();
    c.gameState.applyGameOver = () => {};
    c.endTurn();
    expect(c.recapRunning).toBeTrue();
    // A blow or a cast that WINS resolves synchronously inside endTurn, before
    // the board has even been handed the turn to replay - so dropping the
    // curtain here played the one turn most worth watching without it.
    c.handleWebSocketMessage({ type: 'game_over', winner: 'me', endReason: 'regicide' });
    expect(c.recapRunning).toBeTrue();

    // And the board still brings it down at the end of its run.
    c.onPlaybackDone();
    expect(c.recapRunning).toBeFalse();
  });

  it('drops the curtain on a game that ends with nothing playing', () => {
    const c = room();
    c.gameState.applyGameOver = () => {};
    c.recapRunning = true;
    // A resignation, a disconnect, an opponent's winning turn: nothing of ours
    // is replaying, so there is no playbackDone coming to unlock the board.
    c.handleWebSocketMessage({ type: 'game_over', winner: 'them', endReason: 'resign' });
    expect(c.recapRunning).toBeFalse();
  });

  it('refuses a pick outside your own turn', () => {
    const c = room();
    // A pick is for the match and the other player is told about it, so it
    // belongs to your turn - it used to be takeable at any moment, theirs
    // included.
    expect(c.canPick('opponent', TARGETED)).toBeFalse();
    c.pickAbility('opponent', TARGETED);
    expect(c.opponentLoadout).toEqual([]);

    c.selectAbility('opponent', TARGETED, c.opponentCooldowns);
    expect(c.focusedAbilityBlocker).toContain('not your turn');

    // Yours still works.
    expect(c.canPick('mine', TARGETED)).toBeTrue();
  });

  it('refuses a fifth pick, and says the slots are full', () => {
    const c = room();
    for (const i of [0, 1, 2, 3]) c.pickAbility('mine', i);
    expect(c.myLoadout).toEqual([0, 1, 2, 3]);

    c.clearAbilityFocus();
    c.selectAbility('mine', 4, c.myCooldowns);
    c.pickAbility('mine', 4);
    expect(c.isPicked('mine', 4)).toBeFalse();
    expect(c.focusedAbilityBlocker).toContain('slots are taken');
  });

  it('replays what the turn took up, not only what it spent', () => {
    const c = room();
    const beats: any[] = [];
    // playSteps is what reaches the board; capture what a turn hands it.
    c.pickAbility('mine', TARGETED);
    c.unlockPath('mine', 0);
    (c as any).playSteps = (steps: any[]) => beats.push(...steps);
    c.endTurn();

    const picks = beats.filter(b => b.kind === 'pick');
    // One pick, two abilities - the pair - and then the path's passive.
    expect(picks.map(p => p.index))
      .toEqual([TARGETED, TARGETED_PAIR, c.abilityPaths[0].passive]);
    expect(picks.every(p => p.side === 'mine')).toBeTrue();
  });

  it('keeps what a side took up apart from what it spent, and shows every one', () => {
    const c = room();
    // Yellow the moment each is taken, and every one of them - two picks
    // bring four abilities, and all four show.
    const four = [TARGETED, TARGETED_PAIR, UNIVERSAL, UNIVERSAL_PAIR];
    c.pickAbility('mine', TARGETED);
    c.pickAbility('mine', UNIVERSAL);
    expect(four.every(i => c.isRecentPick('mine', i))).toBeTrue();
    expect(c.isRecent('mine', TARGETED)).toBeFalse();

    // Spent: ringed, and every one of them - a turn that used two shows two.
    c.markUsed('mine', TARGETED);
    c.markUsed('mine', UNIVERSAL);
    expect(c.isRecent('mine', TARGETED)).toBeTrue();
    expect(c.isRecent('mine', UNIVERSAL)).toBeTrue();

    // Neither belongs to the other side, and both lift when this one is up again.
    expect(c.isRecentPick('opponent', TARGETED)).toBeFalse();
    c.beginTurnFor('white');
    expect(c.isRecentPick('mine', TARGETED)).toBeFalse();
    expect(c.isRecent('mine', TARGETED)).toBeFalse();
  });

  it('glows an ultimate once it is used, like every other cast', () => {
    const c = room();
    c.unlockPath('mine', 0);
    const ult = c.abilityPaths[0].ultimate;
    giveCp(c, 20);
    c.selectAbility('mine', ult, c.myCooldowns);
    expect(c.focusedAbilityCanActivate()).toBeTrue();

    c.activateFocusedAbility();
    // Spent, and the other player can see which one it was.
    expect(c.myUltimateUsed).toBeTrue();
    expect(c.isRecent('mine', ult)).toBeTrue();
    expect(c.isRecent('opponent', ult)).toBeFalse();
  });

  it('lights the passive a path is named by, and only that', () => {
    const c = room();
    const path = c.abilityPaths[0];
    // The skill and the ultimate arrive with it and speak for themselves.
    c.unlockPath('mine', 0);
    expect(c.isRecentPick('mine', path.passive)).toBeTrue();
    expect(c.isRecentPick('mine', path.skill)).toBeFalse();
    expect(c.isRecentPick('mine', path.ultimate)).toBeFalse();
  });

  it('draws everything a committed turn touched back in one at a time', () => {
    const c = room();
    const four = [TARGETED, TARGETED_PAIR, UNIVERSAL, UNIVERSAL_PAIR];
    c.pickAbility('mine', TARGETED);
    c.pickAbility('mine', UNIVERSAL);
    c.markUsed('mine', 4);
    expect(four.every(i => c.isRecentPick('mine', i))).toBeTrue();
    expect(c.isRecent('mine', 4)).toBeTrue();

    // The commit curtains both glows - what was taken up and what was spent.
    c.endTurn();
    expect(four.some(i => c.isRecentPick('mine', i))).toBeFalse();

    // Each beat lifts its own, so four picks read as four.
    const pick = (index: number) =>
      c.onPlaybackStep({ kind: 'pick', from: '', to: '', index, side: 'mine' });
    pick(TARGETED);
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();
    expect(c.isRecentPick('mine', UNIVERSAL)).toBeFalse();
    pick(TARGETED_PAIR);
    pick(UNIVERSAL);
    pick(UNIVERSAL_PAIR);
    expect(four.every(i => c.isRecentPick('mine', i))).toBeTrue();
  });

  it('curtains a cast the same way, and lifts it on its own beat', () => {
    const c = room();
    c.pickAbility('mine', 4);
    // A cast staged this turn: the green ring is up straight away.
    (c as any).stagedActions = [{
      board: {}, from: '', to: '', used: 0, attack: null,
      spend: { side: 'mine', row: 'mine', index: 4, cost: 0, uid: '', hex: '1,0',
               priorCooldown: 0, priorBuff: null, priorUsed: false },
    }];
    c.markUsed('mine', 4);
    expect(c.isRecent('mine', 4)).toBeTrue();

    c.endTurn();
    expect(c.isRecent('mine', 4)).toBeFalse();          // curtained

    c.onPlaybackStep({ kind: 'ability', from: '1,0', to: '1,0', index: 4, side: 'mine' });
    expect(c.isRecent('mine', 4)).toBeTrue();           // lifted on its beat
  });

  it('never leaves a pick hidden, however the replay ends', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    c.endTurn();
    expect(c.isRecentPick('mine', TARGETED)).toBeFalse();   // curtain down

    // A replay that ends without reaching them lifts it anyway - a unit's own
    // ability names no slot, so its beat can never lift one.
    c.onPlaybackDone();
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();

    // And the glow itself lasts until this side plays again.
    c.beginTurnFor('black');
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();
    c.beginTurnFor('white');
    expect(c.isRecentPick('mine', TARGETED)).toBeFalse();
  });

  it('always has a line to show, whatever the panel is displaying', () => {
    const c = room();
    // Nothing open, and it is your turn.
    expect(c.abilityNote('mine')).toBe('Click an ability to read it.');
    // Nothing open, and it is not.
    expect(c.abilityNote('opponent')).toBe('Unavailable: not your turn.');

    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.abilityNote('mine')).toContain('Not carried');

    c.clearAbilityFocus();
    c.focusPath('mine', 0);
    expect(c.abilityNote('mine')).toContain('Pick to take the path');

    // Before a game there is no turn to be waiting for.
    c.clearPathFocus();
    c.gameStarted = false;
    expect(c.abilityNote('mine')).toBe('The game has not started yet.');
  });

  it('shows a path in full before it is taken, and takes it only on confirm', () => {
    const c = room();
    c.focusPath('mine', 0);
    // Reading it spends nothing: the path is on show as its three buttons,
    // each of which opens its own description.
    giveCp(c, 10);
    expect(c.myPath).toBeNull();
    expect(c.cpOf('mine')).toBe(10);
    expect(c.pathFocusFor('mine').path).toBe(c.abilityPaths[0]);

    c.unlockPath('mine', 0);
    expect(c.myPath).toBe(0);
    expect(c.cpOf('mine')).toBe(10 - c.abilityPaths[0].cost);
    expect(c.pathFocusFor('mine')).toBeNull();
  });

  it('will not let a path skill be picked into the four on its own', () => {
    const c = room();
    const skill = c.abilityPaths[0].skill;
    // Readable from the path screen, but it arrives with the path or not at
    // all - it was neither a passive nor an ultimate, so it slipped through.
    c.selectAbility('mine', skill, c.myCooldowns);
    expect(c.focusedAbilityCanBePicked).toBeFalse();
    c.pickAbility('mine', skill);
    expect(c.myLoadout).toEqual([]);
    expect(c.focusedAbilityBlocker).toContain('Comes with the Bastion path');
  });

  it('says why a path cannot be taken instead of a dead button', () => {
    const c = room();
    giveCp(c, 1);
    c.focusPath('mine', 0);
    expect(c.canUnlockPath('mine', 0)).toBeFalse();
    expect(c.pathBlocker('mine', 0)).toContain('you have 1');

    giveCp(c, 10);
    c.unlockPath('mine', 0);
    expect(c.pathBlocker('mine', 1)).toContain('already taken a path');
  });

  it('gives a whole pair back through Reselect, and refills it cold', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    c.pickAbility('mine', UNIVERSAL);
    // Two picks, four abilities - the slots are full. A pair is stored in
    // panel order, so Rally's partner comes in ahead of it.
    expect(c.myLoadout).toEqual([TARGETED, TARGETED_PAIR, UNIVERSAL_PAIR, UNIVERSAL]);
    expect(c.canPick('mine', 0)).toBeFalse();

    // A turn passes, so these stop being this turn's picks. Giving one up is
    // a swap now, and a swap is paid for; taking a pick back in the turn it
    // was made is free - see the specs above.
    c.pickedThisTurn = [];

    // Armed, every carried one is on offer - and only the carried ones.
    c.toggleSwap('mine');
    expect(c.canReset('mine', TARGETED)).toBeTrue();
    expect(c.canReset('mine', UNIVERSAL)).toBeTrue();
    expect(c.canReset('mine', 1)).toBeFalse();

    // A click gives the whole pair up rather than opening it, and puts
    // Reselect away. Half a pick would leave a slot nothing could fill.
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.myLoadout).toEqual([UNIVERSAL_PAIR, UNIVERSAL]);
    expect(c.isAbilityFocused('mine', TARGETED)).toBeFalse();
    expect(c.swapArmed).toBeNull();

    // The pair of slots is free again, and what goes into them goes in cold.
    c.pickAbility('mine', 1);
    expect(c.myLoadout).toEqual([UNIVERSAL_PAIR, UNIVERSAL, 0, 1]);
    expect(c.myCooldowns[0]).toBe(3);
    expect(c.myCooldowns[1]).toBe(3);
  });

  it('picks the pool two at a time, so four slots is two picks', () => {
    const c = room();
    // One click, both halves of the row - and the panel says so before it
    // is taken, while that is still a choice.
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.partnerAlsoPicked).toBe(c.abilityEffects[TARGETED_PAIR].name);
    expect(c.focusedAbilityDescription)
      .toContain(`Also picks ${c.abilityEffects[TARGETED_PAIR].name}.`);

    c.pickAbility('mine', TARGETED);
    expect(c.myLoadout).toEqual([TARGETED, TARGETED_PAIR]);
    // Taking either half is the same pick, and it is already made.
    expect(c.canPick('mine', TARGETED_PAIR)).toBeFalse();

    // A second pick fills the slots, and there is no third.
    c.pickAbility('mine', UNIVERSAL);
    expect(c.myLoadout.length).toBe(4);
    expect(c.canPick('mine', 0)).toBeFalse();
    expect(c.canPick('mine', 4)).toBeFalse();

    // Nothing to say about a partner for one already carried.
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.partnerAlsoPicked).toBe('');
  });

  it('lets a side choose through the opening, but cast nothing in it', () => {
    const c = room();
    c.gameState.snapshot.turnNumber = 1;   // the opening

    // Choosing is what the opening is for: pairs and paths are both open.
    expect(c.canChooseAbilities('mine')).toBeTrue();
    expect(c.canPick('mine', TARGETED)).toBeTrue();
    expect(c.canUnlockPath('mine', 0)).toBeTrue();
    c.pickAbility('mine', TARGETED);
    expect(c.myLoadout).toEqual([TARGETED, TARGETED_PAIR]);
    // And handing a pair back with it.
    expect(c.canSwap('mine')).toBeTrue();

    // Casting is not. Nothing spends an ability until Phase 1 plays.
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.canAfford('mine', TARGETED, 0)).toBeFalse();

    // Nor on Phase 1's own initialization turn, which is a setup turn too.
    c.gameState.snapshot.turnNumber = 8;   // turn 4, Phase 1 Initialization
    expect(c.canChooseAbilities('mine')).toBeTrue();
    expect(c.canUseAbilities('mine')).toBeFalse();

    c.gameState.snapshot.turnNumber = 10;  // turn 5, Phase 1's first played
    expect(c.canUseAbilities('mine')).toBeTrue();
  });

  it('heads the panel with what it is asking for, not a price nobody needs', () => {
    const c = room();

    // Nothing open: the head counts picks, and a pick is a pair.
    expect(c.abilityPurseLabel('mine')).toBe('Pick 2');
    c.pickAbility('mine', TARGETED);
    expect(c.abilityPurseLabel('mine')).toBe('Pick 1');
    c.pickAbility('mine', UNIVERSAL);
    expect(c.abilityPurseLabel('mine')).toBe('Pick 0');

    // Open a pool ability and it names what buys one.
    c.myPoints = 42;
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.abilityPurseLabel('mine')).toBe('Points: 42');

    // A path's ability is bought with the other currency, and says so.
    c.abilityFocus = null;
    c.selectAbility('mine', c.abilityPaths[0].passive, c.myCooldowns);
    expect(c.abilityPurseLabel('mine')).toBe(`CP: ${c.cpOf('mine')}`);
  });

  it('will not swap out an ability that is cooling down', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    c.myCooldowns[TARGETED] = 2;
    c.myCooldowns[TARGETED_PAIR] = 2;
    // Nothing cold to offer, so Reselect has nothing to arm.
    expect(c.canSwap('mine')).toBeFalse();
    c.toggleSwap('mine');
    expect(c.swapArmed).toBeNull();

    // Armed anyway, it still refuses - and the click opens it as usual.
    c.swapArmed = 'mine';
    expect(c.canReset('mine', TARGETED)).toBeFalse();
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.myLoadout).toEqual([TARGETED, TARGETED_PAIR]);
    expect(c.isAbilityFocused('mine', TARGETED)).toBeTrue();
  });

  it('is a move: it waits for your turn, and does not outlive it', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);

    // Not your turn is not the moment to be rearranging what you carry.
    c.gameState.snapshot.currentTurn = 'them';
    expect(c.canSwap('mine')).toBeFalse();
    c.swapArmed = 'mine';
    expect(c.canReset('mine', TARGETED)).toBeFalse();

    // Nor does an armed + survive the turn ending.
    c.beginTurnFor('white');
    expect(c.swapArmed).toBeNull();
  });

  it('scores the header off the board it holds and the history of its dead', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    c.gameState.snapshot.boardState = { '0,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];
    // Hand-over 8 is turn 4, the first of Phase 1, and every loss below is
    // taken in it. A full turn is two hand-overs, so the numbers here are
    // twice the turn they name.
    c.gameState.snapshot.turnNumber = 8;
    const score = (side: string) => {
      const s = c.phaseScore(side);
      return { cap: s.cap, death: s.death, total: s.total };
    };

    // The middle of the middle patch: its own hex and the six around it.
    expect(score('mine')).toEqual({ cap: 7, death: 0, total: 7 });
    expect(score('opponent')).toEqual({ cap: 0, death: 0, total: 0 });

    // Black killed a white pawn. A pawn is worth 5 in the config, and white
    // is this client's seat, so it is 5 against us.
    c.gameState.snapshot.moveHistory = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
    ];
    expect(score('mine')).toEqual({ cap: 7, death: 5, total: 2 });

    // A counter-attack kills the mover's own unit, and counts against them.
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { color: 'black', unit_id: 'pawn', captured: null, attacker_eliminated: true, turn: 8 },
    ];
    // Which puts a side with no board and a dead pawn under water.
    expect(score('opponent')).toEqual({ cap: 0, death: 5, total: -5 });

    // Read off the record rather than tallied as it went: the same history
    // gives the same number however this client got here.
    c.gameState.snapshot.boardState = {};
    expect(score('mine')).toEqual({ cap: 0, death: 5, total: -5 });

    // A loss belongs to the phase it happened in and no other, or summing the
    // phases would charge it again in every later one.
    c.gameState.snapshot.turnNumber = 30;   // turn 15, Phase 2
    expect(score('mine').death).toBe(0);
  });

  it('sums the phases behind the running one, and glows the lead', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    c.gameState.snapshot.boardState = { '0,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.turnNumber = 50;   // turn 25, Phase 3

    // Nothing banked yet reads as the phase alone - no parenthetical to draw.
    expect(c.phaseScore('mine').banked).toEqual([]);
    expect(c.phaseScore('mine').match).toBe(7);

    // Phases 1 and 2, as they finished.
    c.phaseBank = { 1: { white: 4, black: 9 }, 2: { white: 6, black: 1 } };
    (c as any).standingsCache = null;
    const us = c.phaseScore('mine');
    const them = c.phaseScore('opponent');
    expect(us.banked).toEqual([4, 6]);
    expect(them.banked).toEqual([9, 1]);
    // The running phase counts towards the match before it has ended.
    expect(us.match).toBe(17);
    expect(them.match).toBe(10);
    expect(us.leading).toBeTrue();
    expect(them.leading).toBeFalse();

    // Level pegging lights neither, so a glow always means a lead.
    c.phaseBank = { 1: { white: 0, black: 7 } };
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine').match).toBe(7);
    expect(c.phaseScore('opponent').match).toBe(7);
    expect(c.phaseScore('mine').leading).toBeFalse();
    expect(c.phaseScore('opponent').leading).toBeFalse();
  });

  it('holds the indicator on whoever committed while it replays', () => {
    const c = room();
    // The turn has already been handed over by the time a recap plays, so
    // following the board would name the wrong side for the whole animation.
    c.gameState.snapshot.currentTurn = 'Opponent';
    expect(c.isYourTurn).toBeFalse();
    expect(c.indicatorMine).toBeFalse();

    c.recapRunning = true;
    expect(c.indicatorMine).toBeTrue();      // our commit, replaying

    c.gameState.snapshot.currentTurn = c.username;
    expect(c.indicatorMine).toBeFalse();     // theirs, replaying
    c.recapRunning = false;
    expect(c.indicatorMine).toBeTrue();
  });

  it('settles the match once the three phases are in', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: {} };
    c.gameState.snapshot.boardState = {};
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.turnNumber = 67;   // turn 34, the first of overtime
    const settle = (white: number, black: number) => {
      c.phaseBank = { 1: { white, black }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
      (c as any).standingsCache = null;
      return c.matchVerdict;
    };

    // Nothing is settled until all three are banked.
    c.phaseBank = { 1: { white: 99, black: 0 } };
    (c as any).standingsCache = null;
    expect(c.matchVerdict).toBeNull();

    // White has to be more than 5 clear; black only more than 3, because
    // white moves first.
    expect(settle(6, 0)).toBe('white');
    expect(settle(5, 0)).toBe('overtime');
    expect(settle(0, 4)).toBe('black');
    expect(settle(0, 3)).toBe('overtime');
    expect(settle(0, 0)).toBe('overtime');
  });

  it('scores overtime at nothing, and gives black the last word', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: {} };
    c.gameState.snapshot.boardState = {};
    c.gameState.snapshot.moveHistory = [];
    c.phaseBank = { 1: { white: 4, black: 4 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    const at = (turn: number) => {
      c.gameState.snapshot.turnNumber = turn;
      (c as any).standingsCache = null;
      const mine = c.phaseScore('mine');
      return { match: mine.match, verdict: c.matchVerdict };
    };

    // Overtime costs a king an HP a turn and a side nothing at all - the
    // owner's rule, "loses just HP". The score it opens on is the score it
    // keeps, however long it runs.
    expect(at(67).match).toBe(4);
    expect(at(68).match).toBe(4);
    expect(at(69).match).toBe(4);
    expect(at(70).match).toBe(4);
    expect(at(99).match).toBe(4);

    // The three phases are what the match is summed from; overtime adds no
    // score of its own either.
    expect(c.phaseScore('mine').banked).toEqual([4, 0, 0]);

    // However level it stays, black takes an overtime that runs out - at the
    // END of turn 50, so turn 50 itself (hand-overs 99 and 100) is played.
    expect(at(99).verdict).toBe('overtime');
    expect(at(100).verdict).toBe('overtime');
    expect(at(101).verdict).toBe('black');
  });

  it('banks a phase as the next one begins, once', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    c.gameState.snapshot.boardState = { '0,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
    ];

    // Still inside Phase 1: nothing to bank.
    c.gameState.snapshot.turnNumber = 20;   // turn 10, its halftime half
    (c as any).bankEndedPhases();
    expect(c.phaseBank[1]).toBeUndefined();

    // Phase 2's initialization turn is the first on which Phase 1's board is
    // still on screen and the phase itself is over.
    c.gameState.snapshot.turnNumber = 29;   // turn 15
    (c as any).bankEndedPhases();
    expect(c.phaseBank[1]).toEqual({ white: 2, black: 0 });

    // Banked once and left alone, however the board moves afterwards.
    c.gameState.snapshot.boardState = {};
    (c as any).bankEndedPhases();
    expect(c.phaseBank[1]).toEqual({ white: 2, black: 0 });
  });

  it('takes the seat the host picked, and tosses for Random', () => {
    const c = room();
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.isInviter = true;
    c.gameId = 'local';
    expect(c.seatChoice).toBe('random');

    // Solo settles a random pick itself - the browser engine plays the
    // colour it is handed - so the seat it starts on is a real one.
    c.isSinglePlayer = true;
    c.startGame();
    expect(['white', 'black']).toContain(sent[0].hostColor);
    expect(c.soloColor).toBe(sent[0].hostColor);

    // A named pick is taken as given.
    c.setSeatChoice('black');
    c.startGame();
    expect(sent[1].hostColor).toBe('black');
    expect(c.soloColor).toBe('black');

    // A two-player room sends the choice and lets the server toss: it owns
    // the seating, so a coin flipped here would be a second opinion.
    c.isSinglePlayer = false;
    c.startGame();
    expect(sent[2].hostColor).toBe('black');
    c.setSeatChoice('random');
    c.startGame();
    expect(sent[3].hostColor).toBeUndefined();
  });

  it('spends one battlefield move a turn through the opening', () => {
    const c = room();
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = 1;
    c.gameState.snapshot.moveHistory = [];
    expect(c.initBoardSpent).toBeFalse();

    // One board move is this side's allowance for the turn it is made in.
    c.gameState.snapshot.moveHistory = [{ color: 'white', turn: 1, to: '0,1' }];
    expect(c.initBoardSpent).toBeTrue();

    // The next turn brings a fresh one. Per turn, not per phase: the whole
    // opening used to hang on the first move, which left a side nothing to
    // do on its second and third turns.
    c.gameState.snapshot.turnNumber = 3;   // hand-over 3 is turn 2
    expect(c.initBoardSpent).toBeFalse();

    // The unit that moved is still done, though - one move each for the
    // whole opening - and it is named by where it landed.
    expect(c.initMovedHexes).toEqual(['0,1']);

    // The other side's move is not ours to spend.
    c.gameState.snapshot.turnNumber = 1;
    c.gameState.snapshot.moveHistory = [{ color: 'black', turn: 1, to: '0,1' }];
    expect(c.initBoardSpent).toBeFalse();
    expect(c.initMovedHexes).toEqual([]);

    // A crossing is a reserve's move, not the opening's board move, and
    // however many come through the board move is still there to make.
    c.gameState.snapshot.moveHistory = [
      { color: 'white', turn: 1, entered: true },
      { color: 'white', turn: 1, entered: true },
    ];
    expect(c.initBoardSpent).toBeFalse();

    // Nor does sending one home lock a unit that is no longer on the board.
    c.gameState.snapshot.moveHistory = [
      { color: 'white', turn: 1, to: '-12,11', withdrawn: true },
    ];
    expect(c.initMovedHexes).toEqual([]);

    // And past the opening the rule does not apply at all.
    c.gameState.snapshot.turnNumber = 20;
    c.gameState.snapshot.moveHistory = [{ color: 'white', turn: 1, to: '0,1' }];
    expect(c.initBoardSpent).toBeFalse();
    expect(c.initMovedHexes).toEqual([]);
  });

  it('keeps the start button through a match and turns it into a restart', () => {
    const c = room();
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.gameState.reset = () => {};
    c.persistLocalUiState = () => {};
    c.isInviter = true;
    c.players = [{ username: 'me' }, { username: 'Opponent' }] as any;

    // Before the match: live, and it says Start.
    c.gameStarted = false;
    expect(c.gameOver).toBeFalse();
    expect(c.startButtonDisabled).toBeFalse();

    // During: still on screen - the rail keeps its shape - but greyed.
    c.gameStarted = true;
    c.gameState.snapshot.endReason = '';
    expect(c.gameOver).toBeFalse();
    expect(c.startButtonDisabled).toBeTrue();
    expect(c.startButtonHint).toBe('The match is running.');

    // Over: it becomes the restart, and works.
    c.gameState.snapshot.endReason = 'regicide';
    expect(c.gameOver).toBeTrue();
    expect(c.startButtonDisabled).toBeFalse();

    // The host's alone.
    c.isInviter = false;
    c.restartGame();
    expect(sent.some((m: any) => m.type === 'reset_game')).toBeFalse();
    c.isInviter = true;
    c.restartGame();
    expect(sent.some((m: any) => m.type === 'reset_game')).toBeTrue();

    // And it hands the room back to the setup screen.
    c.handleWebSocketMessage({ type: 'game_reset' });
    expect(c.gameStarted).toBeFalse();
    expect(c.gameOver).toBeFalse();
  });

  it('casts nothing at all during the opening', () => {
    const c = room();
    c.gameState.snapshot.currentTurn = c.username;
    // Everything that spends an ability runs through canUseAbilities - the
    // pool, a path's skill and ultimate, and a unit's own - so the opening
    // shutting that one gate shuts all of them.
    c.gameState.snapshot.turnNumber = 1;
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.canAfford('mine', 0, 0)).toBeFalse();
    expect(c.abilityBlockedNote).toBe('Unavailable: no abilities during the initialization.');

    // A numbered phase's own initialization turn shuts them for the same
    // reason, and says which turn refused rather than naming the opening -
    // which by then ended several turns ago.
    c.gameState.snapshot.turnNumber = 8;
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.abilityBlockedNote)
      .toBe('Unavailable: no abilities during the phase 1 initialization.');

    // Past every setup turn they come back, and the note goes back to the turn.
    c.gameState.snapshot.turnNumber = 10;
    expect(c.canUseAbilities('mine')).toBeTrue();
    expect(c.abilityBlockedNote).toBe('Unavailable: not your turn.');
  });

  it('scores nothing in the opening, and stops scoring in overtime', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    // A unit sat in the middle of a capture zone, which would otherwise cap.
    c.gameState.snapshot.boardState = { '0,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];

    // The opening caps nothing and kills nobody, so it reads a flat nought.
    c.gameState.snapshot.turnNumber = 1;
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine')).toEqual(jasmine.objectContaining(
      { cap: 0, death: 0, total: 0 }));
    expect(c.showScore).toBeTrue();

    // Phase 1 counts it.
    c.gameState.snapshot.turnNumber = 10;   // turn 5
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine').cap).toBe(7);

    // Overtime scores nothing at all - it is a deathmatch - so the header
    // stops drawing the numbers rather than freezing them on screen.
    c.gameState.snapshot.turnNumber = 73;
    expect(c.showScore).toBeFalse();
  });

  it('stops counting a unit the moment it is staged to walk home', () => {
    const c = room();
    // The staged board keeps a withdrawing unit under its BASE's panel key -
    // off the battlefield, but still a key in the same record. Counting the
    // record wholesale left it standing until the engine's move_made landed.
    c.gameState.snapshot.config = { board: { radius: 11 }, units: {} } as any;
    c.gameState.snapshot.boardState = {
      '0,0': { unit_id: 'pawn', color: 'white', hp: 5, uid: 'a' },
      '1,0': { unit_id: 'pawn', color: 'white', hp: 5, uid: 'b' },
      '2,0': { unit_id: 'pawn', color: 'black', hp: 5, uid: 'c' },
    } as any;
    const mine = c.gameState.myColor(c.username) || 'white';
    expect(c.liveUnits).toBe(mine === 'white' ? 2 : 1);
    expect(c.opponentUnits).toBe(mine === 'white' ? 1 : 2);

    // One of white's is now standing on a base hex - `-12,11` is outside the
    // radius-11 battlefield, which is exactly the shape `onPlayerMove` leaves
    // in the staged board while a withdrawal waits to be committed.
    c.gameState.snapshot.boardState = {
      '0,0': { unit_id: 'pawn', color: 'white', hp: 5, uid: 'a' },
      '-12,11': { unit_id: 'pawn', color: 'white', hp: 5, uid: 'b' },
      '2,0': { unit_id: 'pawn', color: 'black', hp: 5, uid: 'c' },
    } as any;
    expect(c.liveUnits).toBe(1);
    // And the other side is read off the same position, the same way.
    expect(c.opponentUnits).toBe(1);
  });

  it('mends a unit an HP for every turn it sits in the base', () => {
    const c = room();
    const unit = { unit_id: 'pawn', color: 'white', hp: 3, max_hp: 10, uid: 'hurt' };
    c.gameState.snapshot.moveHistory = [
      { from: '-11,11', to: '-12,11', color: 'white', turn: 5, withdrawn: true, unit },
    ];

    const home = () => c.withdrawnUnits.find((w: any) => w.unit.uid === 'hurt')!;

    // The turn it came home on, it is as it arrived.
    c.gameState.snapshot.turnNumber = 5;
    expect(home().at).toBe('-12,11');
    expect(home().unit.hp).toBe(3);

    // It mends at the end of its OWN side's turns, not at every hand-over.
    // Ply 5 is white's, so ply 7 is worth one HP and ply 9 the next - and the
    // black plies between them are worth nothing.
    c.gameState.snapshot.turnNumber = 9;      // plies 1-8 have been played
    expect(home().unit.hp).toBe(4);
    c.gameState.snapshot.turnNumber = 10;     // ply 9 was white's: another
    expect(home().unit.hp).toBe(5);
    c.gameState.snapshot.turnNumber = 11;     // ply 10 was black's: no more
    expect(home().unit.hp).toBe(5);
    // The record itself is untouched, which is what lets a reload arrive at
    // the same number.
    expect(unit.hp).toBe(3);

    // Never past what it started with.
    c.gameState.snapshot.turnNumber = 99;
    expect(home().unit.hp).toBe(10);
  });

  it('mends a wounded base unit from the wound, not from the walk home', () => {
    const c = room();
    const unit = { unit_id: 'pawn', color: 'white', hp: 10, max_hp: 10, uid: 'hurt' };
    c.gameState.snapshot.moveHistory = [
      { from: '-11,11', to: '-12,11', color: 'white', turn: 5, withdrawn: true, unit },
    ];
    const home = () => c.withdrawnUnits.find((w: any) => w.unit.uid === 'hurt');

    // Whole, and mending, until something finds it there.
    c.gameState.snapshot.turnNumber = 7;
    expect(home().unit.hp).toBe(10);

    // A blow lands in the base on turn 8 and leaves it on 4.
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { color: 'black', turn: 8, panelAttack: true, intoPanel: true, unit, defenderHp: 4 },
    ];
    c.gameState.snapshot.turnNumber = 8;
    expect(home().unit.hp).toBe(4);

    // The mending picks up from the wound, not from the walk home - two of
    // white's own turns on is 4 + 2, not 10.
    c.gameState.snapshot.turnNumber = 13;
    expect(home().unit.hp).toBe(6);
    c.gameState.snapshot.turnNumber = 99;
    expect(home().unit.hp).toBe(10);
  });

  it('leaves a unit killed in the base out of the panel for good', () => {
    const c = room();
    const unit = { unit_id: 'pawn', color: 'white', hp: 10, max_hp: 10, uid: 'gone' };
    c.gameState.snapshot.moveHistory = [
      { from: '-11,11', to: '-12,11', color: 'white', turn: 5, withdrawn: true, unit },
      { color: 'black', turn: 6, panelAttack: true, intoPanel: true, unit, defenderHp: 0 },
    ];
    c.gameState.snapshot.turnNumber = 40;
    // Nothing mends back from nothing.
    expect(c.withdrawnUnits.some((w: any) => w.unit.uid === 'gone')).toBeFalse();
  });

  it('keeps two units that came home to the same hex', () => {
    const c = room();
    const one = { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 10, uid: 'first' };
    const two = { unit_id: 'rook', color: 'white', hp: 9, max_hp: 10, uid: 'second' };
    // The first was shuffled off its landing hex, freeing it for the second.
    // Keyed by hex, the later record would quietly erase the earlier unit.
    c.gameState.snapshot.moveHistory = [
      { from: '-11,11', to: '-12,11', color: 'white', turn: 5, withdrawn: true, unit: one },
      { from: '-11,10', to: '-12,11', color: 'white', turn: 12, withdrawn: true, unit: two },
    ];
    c.gameState.snapshot.turnNumber = 12;
    expect(c.withdrawnUnits.map((w: any) => w.unit.uid)).toEqual(['first', 'second']);
  });

  /**
   * The blow into a panel, from the click to the message that carries it.
   *
   * Both halves of this have their own checks - the engine resolves a
   * `panel_attack` (see local-game.service.spec) and the derivation reads the
   * record back - but nothing covered the join, and the join is where a
   * blow that vanishes without wounding anybody would have to go missing.
   */
  const swinging = (c: any) => {
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.playEndTurnSound = () => {};
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = 20;
    c.gameState.snapshot.config = {
      units: { pawn: { hp: 20, attack: 14, defense: 10, attackRange: 1, move: 6 } },
    };
    c.gameState.snapshot.boardState = {
      '-5,9': { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid: 'mine' },
    };
    return sent;
  };

  /** A reserve unit: on no board, so it travels with the message. */
  const inPanel = () =>
    ({ unit_id: 'pawn', color: 'black', hp: 20, max_hp: 20, uid: 'rtl0' });

  it('sends a blow into a panel as its own message, walk or no walk', () => {
    const c = room();
    const sent = swinging(c);
    const target = inPanel();

    // Struck from where it stands, without walking first - the commonest way
    // to swing at a panel, and the one with no move behind it to fold into.
    c.onPlayerAttack({
      from: '-5,9', to: '-5,9', attack: '-5,8', targetUnit: target,
      panel: 'tl', counters: true,
    });
    expect(c.panelHp['rtl0']).toBeLessThan(20);

    c.endTurn();
    const msg = sent.find(m => m.type === 'panel_attack');
    expect(msg).toBeDefined();
    // Not folded into a make_move, and not swallowed by a pass: either would
    // leave the panel unit standing there untouched.
    expect(sent.some(m => m.type === 'pass_turn' || m.type === 'make_move')).toBeFalse();
    expect(msg.unit.uid).toBe('rtl0');
    // The panel rides along: nothing else survives to say whether the wound
    // was taken in a base, which is the half of the game that mends.
    expect(msg.panel).toBe('tl');
    expect(msg.attack).toBe('-5,8');
    expect(msg.from).toBe('-5,9');
    expect(msg.to).toBe('-5,9');
    // A reserve answers; whether it does is the panel's rule and rides along.
    expect(msg.counters).toBeTrue();
  });

  it('still sends the panel blow when an ability is cast after it', () => {
    const c = room();
    const sent = swinging(c);
    c.onPlayerAttack({
      from: '-5,9', to: '-5,9', attack: '-5,8', targetUnit: inPanel(),
      panel: 'tr', counters: false });
    // A cast goes on the same stack and becomes the last thing staged. The
    // commit looks across the whole stack for the swing, not just at the top
    // of it, or the blow would go out as a plain pass.
    c.stageSpend({ uid: 'mine', side: 'mine', index: 1, cost: 1 });

    c.endTurn();
    expect(sent.find(m => m.type === 'panel_attack')?.unit.uid).toBe('rtl0');
    expect(sent.some(m => m.type === 'pass_turn')).toBeFalse();
  });

  it('lands an ability on a unit standing in a panel, and records what it left', () => {
    const c = room();
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.playEndTurnSound = () => {};
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = 20;
    c.gameState.snapshot.boardState = {};
    // A wounded unit of white's dealt base squad. It is on no board, so its
    // HP lives in the record and nowhere else - which is why an ability that
    // moves it has to go out as its own message.
    const HEAL = 6;
    c.myPoints = 50;
    c.pickAbility('mine', HEAL);
    c.pendingAbility = { side: 'mine', index: HEAL, cooldowns: c.myCooldowns };

    c.onHexClicked({
      key: '-12,11', uid: 'rbl0', unitId: 'rook', color: 'white',
      hp: 12, hpMax: 40, panel: 'bl',
    });

    // Staged, so the panel draws the new number before the turn commits.
    expect(c.panelHp['rbl0']).toBe(32);

    c.endTurn();
    const msg = sent.find(m => m.type === 'pass_turn')?.effectsBefore?.[0];
    expect(msg).toBeDefined();
    expect(msg.unit.uid).toBe('rbl0');
    expect(msg.hp).toBe(32);
    expect(msg.panel).toBe('bl');
  });

  it('sends a heal landing on the BOARD, so the engine keeps it too', () => {
    // The owner's report: "after healing it from 1hp, it dies next turn
    // anyways". A panel unit's HP was sent and a board unit's was not - the
    // mend lived on the staged board, the engine kept the HP the king had,
    // and overtime took its toll off that. It goes out ahead of the turn's
    // own move or pass, so the toll is taken from the healed king.
    const c = room();
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.playEndTurnSound = () => {};
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = 68;
    c.gameState.snapshot.boardState = {
      '-5,0': { unit_id: 'king', color: 'white', hp: 1, max_hp: 45, uid: 'wk' },
    };
    const HEAL = 6;
    c.myPoints = 50;
    c.pickAbility('mine', HEAL);
    c.pendingAbility = { side: 'mine', index: HEAL, cooldowns: c.myCooldowns };

    c.onHexClicked({
      key: '-5,0', uid: 'wk', unitId: 'king', color: 'white', hp: 1, hpMax: 45,
    });
    expect(c.stagedBoard['-5,0'].hp).toBe(21);

    c.endTurn();
    const order = sent.map(m => m.type);
    expect(order).toEqual(['pass_turn']);
    expect(sent[0].effectsBefore).toEqual([jasmine.objectContaining({ at: '-5,0', hp: 21 })]);
  });

  it('sends a cast staged after the blow inside the move, not ahead of it', () => {
    // A cast carries the HP worked out for the turn so far, blow included.
    // Sent ahead, the engine struck the blow again over the top - a mend
    // after a counter was lost. One staged before the move still goes ahead.
    const c = room();
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.playEndTurnSound = () => {};
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = 20;
    const spend = { cost: 0, index: 6, side: 'mine', row: 'mine', uid: 'wp', hex: '-4,0' };
    c.stagedActions = [
      { at: 1, from: '', to: '', used: 0, attack: null, spend,
        hexKey: '-9,0', hexUid: 'wq', hexHp: 30, mark: '+5' },
      { at: 2, from: '-5,0', to: '-4,0', used: 1, attack: null },
      { at: 3, from: '-5,0', to: '-4,0', used: 1, attack: '-3,0' },
      { at: 4, from: '-5,0', to: '-4,0', used: 1, attack: null, spend,
        hexKey: '-4,0', hexUid: 'wp', hexHp: 20, mark: '+16' },
    ];
    // A cast is something to take back even with nothing else staged.
    expect(c.canUndo).toBeTrue();

    c.endTurn();
    // One message: a move the engine refuses must take its casts with it.
    expect(sent.map(m => m.type)).toEqual(['make_move']);
    expect(sent[0].effectsBefore).toEqual([{ at: '-9,0', uid: 'wq', hp: 30 }]);
    expect(sent[0].effects).toEqual([{ at: '-4,0', uid: 'wp', hp: 20 }]);

    // And the turn is with the engine now: nothing on it is taken back.
    expect(c.canUndo).toBeFalse();
    c.undoMove();
    expect(c.stagedActions.length).toBe(4);
  });

  it('writes what a cast did to the HP over the unit it landed on', () => {
    // "mend also doesn't do the +x icon like damage taken." The swell said
    // something had happened and nothing said what - the beat now carries the
    // HP it actually moved, which is not always the HP it offered: a 20-point
    // mend on a unit three short of full is a +3.
    const c = room();
    const played: any[] = [];
    c.persistLocalUiState = () => {};
    c.playSteps = (steps: any[]) => played.push(...steps);
    c.gameState.snapshot.turnNumber = 20;
    c.gameState.snapshot.boardState = {
      '-5,0': { unit_id: 'king', color: 'white', hp: 42, max_hp: 45, uid: 'wk' },
    };
    const HEAL = 6;
    c.myPoints = 50;
    c.pickAbility('mine', HEAL);
    c.pendingAbility = { side: 'mine', index: HEAL, cooldowns: c.myCooldowns };
    c.onHexClicked({
      key: '-5,0', uid: 'wk', unitId: 'king', color: 'white', hp: 42, hpMax: 45,
    });

    expect(c.stagedBoard['-5,0'].hp).toBe(45);
    const cast = played.find(s => s.kind === 'ability');
    expect(cast.mark).toBe('+3');
    // And the recap replays it with the same number on it.
    expect(c.stagedActions[c.stagedActions.length - 1].mark).toBe('+3');
  });

  it('never heals a unit past what it started with', () => {
    const c = room();
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.gameState.snapshot.turnNumber = 20;
    c.gameState.snapshot.boardState = {};
    const HEAL = 6;
    c.myPoints = 50;
    c.pickAbility('mine', HEAL);
    c.pendingAbility = { side: 'mine', index: HEAL, cooldowns: c.myCooldowns };
    c.onHexClicked({
      key: '-12,11', uid: 'rbl0', unitId: 'rook', color: 'white',
      hp: 38, hpMax: 40, panel: 'bl',
    });
    expect(c.panelHp['rbl0']).toBe(40);
  });

  it('mends the squad dealt into a base, not only the units that walked home', () => {
    const c = room();
    // A unit of white's dealt squad in `bl` - white's base. It stands in the
    // same panel as a unit that walked home and closes its wound at the same
    // rate: one of them bleeding for the whole match while the other healed
    // beside it was the one rule that read as two.
    const unit = { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'rbl0' };
    c.gameState.snapshot.moveHistory = [
      { color: 'black', turn: 8, panelAttack: true, intoPanel: true, panel: 'bl', unit, defenderHp: 30 },
    ];

    // The turn the blow landed, it is as it was left.
    c.gameState.snapshot.turnNumber = 8;
    expect(c.panelHp['rbl0']).toBe(30);

    // Then an HP for each of WHITE's own hand-overs, not for each ply: plies
    // 9 and 11 are white's, ply 10 is black's and worth nothing.
    c.gameState.snapshot.turnNumber = 10;
    expect(c.panelHp['rbl0']).toBe(31);
    c.gameState.snapshot.turnNumber = 11;
    expect(c.panelHp['rbl0']).toBe(31);
    c.gameState.snapshot.turnNumber = 12;
    expect(c.panelHp['rbl0']).toBe(32);

    // Never past what it started with.
    c.gameState.snapshot.turnNumber = 200;
    expect(c.panelHp['rbl0']).toBe(40);

    // And nothing mends back from nothing: killed in a panel is killed.
    const dead = { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'rbl1' };
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { color: 'black', turn: 8, panelAttack: true, intoPanel: true, panel: 'bl', unit: dead, defenderHp: 0 },
    ];
    expect(c.panelHp['rbl1']).toBe(0);
  });

  it('leaves a wounded reserve wounded: a base mends and a reserve does not', () => {
    const c = room();
    // The same blow, in `br` - white's reserve. A reserve is a staging area,
    // not a hospital, and the panel on the record is what tells them apart
    // once the board that knew is gone.
    const unit = { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'rbr0' };
    c.gameState.snapshot.moveHistory = [
      { color: 'black', turn: 8, panelAttack: true, intoPanel: true, panel: 'br', unit, defenderHp: 30 },
    ];
    c.gameState.snapshot.turnNumber = 8;
    expect(c.panelHp['rbr0']).toBe(30);
    c.gameState.snapshot.turnNumber = 200;
    expect(c.panelHp['rbr0']).toBe(30);
  });

  it('shows the turn in progress un-mended, so a swing reads as its own cost', () => {
    const c = room();
    const unit = { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'rbl0' };
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.turnNumber = 30;
    c.stagedActions = [{ panelUnit: unit, panelUnitHp: 22 }];
    // The staged wound is what the blow just did, not what it will look like
    // after a turn of mending.
    expect(c.panelHp['rbl0']).toBe(22);
  });

  it('names the reserves that have left their panel', () => {
    const c = room();
    const runner = { unit_id: 'pawn', color: 'white', hp: 10, max_hp: 10, uid: 'rbr0' };
    c.gameState.snapshot.moveHistory = [
      { from: '3,9', to: '3,8', color: 'white', turn: 4, entered: true, unit: runner },
      { from: '0,0', to: '0,1', color: 'white', turn: 6 },
    ];
    // Only crossings count, and the record names the unit - a hex says
    // nothing once the board it walked onto has forgotten it.
    expect(c.departedUids).toEqual(['rbr0']);
  });

  it('keeps the recap curtain through the handover a commit triggers', () => {
    const c = room();
    // What ending a turn leaves behind: the beats still to be drawn, and the
    // glows they will draw.
    c.abilityPickGlow = { mine: [TARGETED, UNIVERSAL], opponent: [] };
    c.glowReveal = [
      { side: 'mine', index: TARGETED, kind: 'pick' },
      { side: 'mine', index: UNIVERSAL, kind: 'pick' },
    ];

    // The board is handed over before the first beat plays - in a solo game
    // the reply arrives on a microtask and the recap starts on a timer. This
    // used to empty the curtain, and every slot came up lit at once.
    c.beginTurnFor('black');
    expect(c.isRecentPick('mine', TARGETED)).toBeFalse();
    expect(c.isRecentPick('mine', UNIVERSAL)).toBeFalse();

    // Each beat draws its own, in order.
    c.onPlaybackStep({ kind: 'pick', from: '', to: '', index: TARGETED, side: 'mine' });
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();
    expect(c.isRecentPick('mine', UNIVERSAL)).toBeFalse();

    // And nothing stays hidden past the end of the replay.
    c.onPlaybackDone();
    expect(c.isRecentPick('mine', UNIVERSAL)).toBeTrue();
  });

  it('scores the staged board, so walking out of a zone shows before committing', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    c.gameState.snapshot.boardState = { '0,0': { unit_id: 'pawn', color: 'white' } };
    expect(c.phaseScore('mine').cap).toBe(7);

    // A step away is staged, not sent. The board being drawn is the staged
    // one, and the score reads the same board the player is looking at.
    c.stagedActions = [{ from: '0,0', to: '4,0', board: { '4,0': { unit_id: 'pawn', color: 'white' } } } as any];
    expect(c.phaseScore('mine').cap).toBe(0);

    // Taking it back puts the hexes back.
    c.stagedActions = [];
    expect(c.phaseScore('mine').cap).toBe(7);
  });

  it('takes the glow down with an ability given back the same turn', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();

    c.toggleSwap('mine');
    c.resetAbility('mine', TARGETED);
    // Picked and returned inside one turn is not a pick: nothing for the
    // other player to read, and nothing for the recap to replay.
    expect(c.isRecentPick('mine', TARGETED)).toBeFalse();
  });
});

/**
 * Leaving a room on the way out - and only a room this page actually joined.
 */
describe('GameRoomComponent leaving', () => {
  const room = (token: string) => {
    const sent: any[] = [];
    const disconnects: number[] = [];
    const ws: any = {
      sendMessage: (m: any) => sent.push(m),
      isLocal: () => false,
      isOffline: () => false,
      connect: () => {},
      disconnect: () => disconnects.push(1),
      endLocalGame: () => {},
      reconnecting$: new Subject(),
      reconnectAttempts$: new Subject(),
      connectionFailed$: new Subject(),
      connectionStatus$: new BehaviorSubject(true),
      messages$: new Subject(),
    };
    const shared: any = {
      getLobbyMessages: () => [], getLobbyUsers: () => [],
      lobbyMessages$: new Subject(), lobbyUsers$: new Subject(),
    };
    const route: any = { params: of({ id: 'room-1' }), queryParams: of(token ? { token } : {}) };
    const router: any = { navigate: () => Promise.resolve(true) };
    const auth: any = { getUsername: () => 'me', getIdentitySecret: () => 'secret' };
    const cdr: any = { markForCheck: () => {}, detectChanges: () => {} };
    const gameState: any = {
      snapshot: {}, reset: () => {},
      myColor: (who: string) => (who === 'me' ? 'white' : 'black'),
    };
    const c: any = new GameRoomComponent(
      ws, route, router, shared, new NavigationStateService(), cdr, gameState, auth,
      { playTone: () => {} } as any,
    );
    return { c, sent, ws, gameState, disconnects };
  };

  beforeEach(() => sessionStorage.removeItem('cpp.roomToken.room-1'));
  afterEach(() => sessionStorage.removeItem('cpp.roomToken.room-1'));

  it('sends no leave for a room it never joined', () => {
    // Opened without a token, the page goes straight back to the lobby. Its
    // leave used to sit in the socket's queue and go out on the lobby's
    // connection, where the lobby answered "Can only leave as yourself".
    const { c, sent } = room('');
    c.ngOnInit();
    c.ngOnDestroy();
    expect(sent.some(m => m.type === 'join_game_room')).toBeFalse();
    expect(sent.some(m => m.type === 'leave_game_room')).toBeFalse();
  });

  it('still leaves a room it did join', () => {
    const { c, sent, disconnects } = room('tok');
    c.ngOnInit();
    expect(sent.some(m => m.type === 'join_game_room')).toBeTrue();
    c.ngOnDestroy();
    expect(sent.some(m => m.type === 'leave_game_room')).toBeTrue();
    expect(disconnects.length).toBe(1);
  });

  it('still takes the socket down for a room it never joined', () => {
    // The leave and the teardown are two different questions. Gating both on
    // the join left a room socket open behind a page that had already gone.
    const { c, disconnects } = room('');
    c.ngOnInit();
    c.ngOnDestroy();
    expect(disconnects.length).toBe(1);
  });

  /**
   * The opening hands a side ONE battlefield move a turn, and only a
   * battlefield move spends it. Panel walks reach the record since stage 3, so
   * reading every non-crossing record as a board move meant shuffling one
   * reserve unit greyed out every unit on the board for the rest of the turn.
   */
  describe("the opening's one board move", () => {
    const spent = (history: any[]) => {
      const { c, gameState } = room('tok');
      gameState.snapshot = { turnNumber: 1, currentTurn: 'me', moveHistory: history };
      return c.initBoardSpent;
    };

    it('is spent by a board move', () => {
      expect(spent([{ color: 'white', turn: 1, to: '-5,8', moved: true }])).toBeTrue();
    });

    it('is not spent by a crossing, a panel walk or a cast', () => {
      expect(spent([{ color: 'white', turn: 1, to: '-5,8', entered: true }])).toBeFalse();
      expect(spent([{ color: 'white', turn: 1, to: 'bl-2', panelMove: true }])).toBeFalse();
      expect(spent([{ color: 'white', turn: 1, to: '', panelEffect: true }])).toBeFalse();
    });

    /**
     * This asserted the opposite, under the title "which ends the turn like any
     * other move" - true of a walk home until a setup turn's became a
     * deployment that three units may take. Were it still counted, the first
     * one would grey every battlefield unit for the rest of the turn, taking an
     * allowance it no longer spends.
     */
    it('is not spent by a walk home, which is a deployment while setting out', () => {
      expect(spent([{ color: 'white', turn: 1, to: '-12,11', withdrawn: true }])).toBeFalse();
    });

    it('is still spent by a board move taken beside three walks home', () => {
      expect(spent([
        { color: 'white', turn: 1, to: '-12,11', withdrawn: true },
        { color: 'white', turn: 1, to: '-11,11', withdrawn: true },
        { color: 'white', turn: 1, to: '-10,11', withdrawn: true },
        { color: 'white', turn: 1, to: '-5,8', moved: true },
      ])).toBeTrue();
    });

    it('is not spent by the other side', () => {
      expect(spent([{ color: 'black', turn: 1, to: '5,8', moved: true }])).toBeFalse();
    });
  });

  /**
   * Three units may walk home on a setup turn, and every layer said so except
   * the one a player can click. A walk home was staged as the turn's board
   * action, which locked every other unit behind it - so the allowance both
   * engines had just been taught was unreachable, and the browser was the only
   * thing that could see it.
   *
   * On a setup turn each one is a **deployment**: its own message, the seat
   * kept, and no claim on the turn's move. In overtime it stays the turn's
   * move, which is the schedule's own exception.
   */
  describe('walking home while setting out', () => {
    /** A room mid-game with `board` standing and the clock on `ply`. */
    const playing = (ply: number, board: Record<string, any>) => {
      const kit = room('tok');
      kit.c.gameStarted = true;
      // Set by ngOnInit in a real room, which is not run here: it would join,
      // and the point of these is the staging, not the socket.
      kit.c.username = 'me';
      kit.gameState.snapshot = {
        turnNumber: ply, currentTurn: 'me', moveHistory: [], boardState: board,
        config: { units: { pawn: { move: 3, value: 4 } } },
      };
      return kit;
    };

    /** Three of white's own, each a step from a doorway. */
    const three = () => ({
      '-12,11': { unit_id: 'pawn', color: 'white', hp: 4 },
      '-11,11': { unit_id: 'pawn', color: 'white', hp: 4 },
      '-10,11': { unit_id: 'pawn', color: 'white', hp: 4 },
    });

    /** Walk `from` home into the base, the way the board emits it. */
    const walkHome = (c: any, from: string, to: string) =>
      c.onPlayerMove({ from, to, cost: 2, refund: 4 });

    it('leaves the turn\'s board action unclaimed, so the next unit is free', () => {
      const { c } = playing(1, three());
      walkHome(c, '-12,11', 'bl-0');
      // The lock the board reads. Before this change the first walk home set
      // it, and `drivable` refused every other unit for the rest of the turn.
      expect(c.pendingMove).toBeNull();
      expect(c.stagedActions.length).toBe(1);
      expect(c.stagedActions[0].homecoming).toBeTrue();
    });

    it('counts the staged ones, so the board stops offering a fourth', () => {
      const { c } = playing(1, three());
      expect(c.homecomingsSpent).toBe(0);
      walkHome(c, '-12,11', 'bl-0');
      walkHome(c, '-11,11', 'bl-1');
      walkHome(c, '-10,11', 'bl-2');
      // Read off the record alone this was 0 until End Turn, because the record
      // does not move while a turn is staged - and the board would have offered
      // a fourth, a fifth and a sixth.
      expect(c.homecomingsSpent).toBe(3);
    });

    it('sends all three as their own messages, then hands the turn over', () => {
      const { c, sent } = playing(1, three());
      walkHome(c, '-12,11', 'bl-0');
      walkHome(c, '-11,11', 'bl-1');
      walkHome(c, '-10,11', 'bl-2');
      c.endTurn();
      const walks = sent.filter((m: any) => m.type === 'make_move');
      expect(walks.length).toBe(3);
      expect(walks.every((m: any) => m.withdraw === true)).toBeTrue();
      // Each from where its own unit stood - not from the first one's hex,
      // which is what inheriting the previous action's origin used to do.
      expect(walks.map((m: any) => m.from)).toEqual(['-12,11', '-11,11', '-10,11']);
      // Nothing is left to be the turn's board action, and doing nothing else
      // is a legal turn - so the hand-over is a pass.
      expect(sent.some((m: any) => m.type === 'pass_turn')).toBeTrue();
    });

    it('takes one back with its refund, and frees the allowance again', () => {
      const { c } = playing(1, three());
      walkHome(c, '-12,11', 'bl-0');
      const paid = c.myPoints;
      walkHome(c, '-11,11', 'bl-1');
      expect(c.homecomingsSpent).toBe(2);
      c.undoMove();
      expect(c.homecomingsSpent).toBe(1);
      expect(c.myPoints).toBe(paid);
    });

    /**
     * Overtime opens the doorways with no count, and a walk home there is an
     * ordinary move that happens to end off the board - so it keeps the turn's
     * slot and ends the turn, exactly as the server's own split has it.
     */
    it('is still the turn\'s own move in overtime', () => {
      const { c, sent } = playing(73, three());
      walkHome(c, '-12,11', 'bl-0');
      expect(c.stagedActions[0].homecoming).toBeUndefined();
      expect(c.pendingMove).toEqual({ from: '-12,11', to: 'bl-0', used: 2 });
      c.endTurn();
      const walks = sent.filter((m: any) => m.type === 'make_move');
      expect(walks.length).toBe(1);
      expect(walks[0].withdraw).toBeTrue();
      expect(sent.some((m: any) => m.type === 'pass_turn')).toBeFalse();
    });

    /**
     * A unit that steps and then carries on into the base has not made a
     * deployment - that is the turn's move reaching the doorway, and it has to
     * go out from the hex the engine still has the unit on.
     */
    it('is the turn\'s move when it finishes a walk already begun', () => {
      const { c, sent } = playing(1, three());
      c.onPlayerMove({ from: '-12,11', to: '-12,10', cost: 1 });
      walkHome(c, '-12,10', 'bl-0');
      expect(c.pendingMove).toEqual({ from: '-12,11', to: 'bl-0', used: 3 });
      c.endTurn();
      const walks = sent.filter((m: any) => m.type === 'make_move');
      expect(walks.length).toBe(1);
      expect(walks[0].from).toBe('-12,11');
      expect(walks[0].withdraw).toBeTrue();
    });
  });
});
