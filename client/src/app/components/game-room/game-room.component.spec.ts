import { GameRoomComponent } from './game-room.component';

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
    c.gameState.snapshot.turnNumber = 8;   // turn 4, the first of Phase 1
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

  it('does not lock a turn that has nothing to play back', () => {
    const c = room();
    // Nothing staged, nothing picked: there is no replay, so nothing would
    // ever arrive to hand the board back.
    c.endTurn();
    expect(c.recapRunning).toBeFalse();
    expect(c.canUseAbilities('mine')).toBeTrue();
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

    // Casting is not. Nothing spends an ability until Phase 1.
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.canAfford('mine', TARGETED, 0)).toBeFalse();

    c.gameState.snapshot.turnNumber = 8;   // turn 4, Phase 1
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

  it('bleeds a point a turn through overtime, and gives black the last word', () => {
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

    // Overtime opens at hand-over 67 - turn 34 - with nothing taken off.
    expect(at(67).match).toBe(4);
    // White's half played, so white has paid for it.
    expect(at(68).match).toBe(3);
    expect(at(69).match).toBe(3);   // that one was black's
    expect(at(70).match).toBe(2);

    // The three phases are what the match is summed from - overtime takes
    // away rather than adding a score of its own.
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
    c.gameState.snapshot.turnNumber = 20;   // turn 10
    (c as any).bankEndedPhases();
    expect(c.phaseBank[1]).toBeUndefined();

    // The first turn of Phase 2 is when Phase 1's board is still on screen.
    c.gameState.snapshot.turnNumber = 27;   // turn 14
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

    // Past the opening they come back, and the note goes back to the turn.
    c.gameState.snapshot.turnNumber = 8;
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
    c.gameState.snapshot.turnNumber = 8;   // turn 4
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine').cap).toBe(7);

    // Overtime scores nothing at all - it is a deathmatch - so the header
    // stops drawing the numbers rather than freezing them on screen.
    c.gameState.snapshot.turnNumber = 67;
    expect(c.showScore).toBeFalse();
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
