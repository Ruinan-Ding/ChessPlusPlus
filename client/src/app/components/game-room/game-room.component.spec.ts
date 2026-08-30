import { GameRoomComponent } from './game-room.component';

/**
 * The ability panel decides everything below on its own fields, so it is built
 * by hand rather than stood up in a room: TestBed here would exercise the DI
 * container and the router, neither of which has an opinion about picking.
 */
describe('GameRoomComponent ability panel', () => {
  /** Bulwark - carried from the pool, aimed at one of your own units. */
  const TARGETED = 2;
  /** Rally - carried from the pool, no target at all. */
  const UNIVERSAL = 7;

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
    expect(c.myPoints).toBe(10);

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
    c.myPoints = 0;
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.focusedAbilityBlocker).toContain('costs 1, you have 0');

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
    expect(picks.map(p => p.index)).toEqual([TARGETED, c.abilityPaths[0].passive]);
    expect(picks.every(p => p.side === 'mine')).toBeTrue();
  });

  it('keeps what a side took up apart from what it spent, and shows every one', () => {
    const c = room();
    // Yellow the moment each is taken, and every one of them - a turn that
    // picked three shows three.
    [TARGETED, UNIVERSAL, 1].forEach(i => c.pickAbility('mine', i));
    expect([TARGETED, UNIVERSAL, 1].every(i => c.isRecentPick('mine', i))).toBeTrue();
    expect(c.isRecent('mine', TARGETED)).toBeFalse();

    // Spent: ringed, and every one of them - a turn that used three shows three.
    c.markUsed('mine', TARGETED);
    c.markUsed('mine', 1);
    expect(c.isRecent('mine', TARGETED)).toBeTrue();
    expect(c.isRecent('mine', 1)).toBeTrue();

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
    c.myPoints = 20;
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
    [TARGETED, UNIVERSAL, 1].forEach(i => c.pickAbility('mine', i));
    c.markUsed('mine', 4);
    expect([TARGETED, UNIVERSAL, 1].every(i => c.isRecentPick('mine', i))).toBeTrue();
    expect(c.isRecent('mine', 4)).toBeTrue();

    // The commit curtains both glows - what was taken up and what was spent.
    c.endTurn();
    expect([TARGETED, UNIVERSAL, 1].some(i => c.isRecentPick('mine', i))).toBeFalse();

    // Each beat lifts its own, so three picks read as three.
    const pick = (index: number) =>
      c.onPlaybackStep({ kind: 'pick', from: '', to: '', index, side: 'mine' });
    pick(TARGETED);
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();
    expect(c.isRecentPick('mine', UNIVERSAL)).toBeFalse();
    pick(UNIVERSAL);
    pick(1);
    expect([TARGETED, UNIVERSAL, 1].every(i => c.isRecentPick('mine', i))).toBeTrue();
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
    expect(c.myPath).toBeNull();
    expect(c.myPoints).toBe(10);
    expect(c.pathFocusFor('mine').path).toBe(c.abilityPaths[0]);

    c.unlockPath('mine', 0);
    expect(c.myPath).toBe(0);
    expect(c.myPoints).toBe(10 - c.abilityPaths[0].cost);
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
    c.myPoints = 1;
    c.focusPath('mine', 0);
    expect(c.canUnlockPath('mine', 0)).toBeFalse();
    expect(c.pathBlocker('mine', 0)).toContain('you have 1');

    c.myPoints = 10;
    c.unlockPath('mine', 0);
    expect(c.pathBlocker('mine', 1)).toContain('already taken a path');
  });

  it('swaps a carried ability out through the +, and the one that replaces it comes in cold', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    c.pickAbility('mine', UNIVERSAL);
    expect(c.myLoadout).toEqual([TARGETED, UNIVERSAL]);

    // Armed, both are on offer - and only the carried ones.
    c.toggleSwap('mine');
    expect(c.canReset('mine', TARGETED)).toBeTrue();
    expect(c.canReset('mine', UNIVERSAL)).toBeTrue();
    expect(c.canReset('mine', 1)).toBeFalse();

    // A click gives it up rather than opening it, and puts the + away.
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.myLoadout).toEqual([UNIVERSAL]);
    expect(c.isAbilityFocused('mine', TARGETED)).toBeFalse();
    expect(c.swapArmed).toBeNull();

    // The slot is free again, and what goes into it goes in on cooldown.
    c.pickAbility('mine', 1);
    expect(c.myLoadout).toEqual([UNIVERSAL, 1]);
    expect(c.myCooldowns[1]).toBe(3);
    // One slot freed, one pick spent: the next is a normal pick.
    c.pickAbility('mine', 3);
    expect(c.myCooldowns[3]).toBe(0);
  });

  it('will not swap out an ability that is cooling down', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    c.myCooldowns[TARGETED] = 2;
    // Nothing cold to offer, so the + has nothing to arm.
    expect(c.canSwap('mine')).toBeFalse();
    c.toggleSwap('mine');
    expect(c.swapArmed).toBeNull();

    // Armed anyway, it still refuses - and the click opens it as usual.
    c.swapArmed = 'mine';
    expect(c.canReset('mine', TARGETED)).toBeFalse();
    c.selectAbility('mine', TARGETED, c.myCooldowns);
    expect(c.myLoadout).toEqual([TARGETED]);
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
    // The middle of the middle patch: its own hex and the six around it.
    expect(c.phaseScore('mine')).toEqual({ cap: 7, death: 0, total: 7 });
    expect(c.phaseScore('opponent')).toEqual({ cap: 0, death: 0, total: 0 });

    // Black killed a white pawn. A pawn is worth 5 in the config, and white
    // is this client's seat, so it is 5 against us.
    c.gameState.snapshot.moveHistory = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true },
    ];
    expect(c.phaseScore('mine')).toEqual({ cap: 7, death: 5, total: 2 });

    // A counter-attack kills the mover's own unit, and counts against them.
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { color: 'black', unit_id: 'pawn', captured: null, attacker_eliminated: true },
    ];
    // Which puts a side with no board and a dead pawn under water.
    expect(c.phaseScore('opponent')).toEqual({ cap: 0, death: 5, total: -5 });

    // Read off the record rather than tallied as it went: the same history
    // gives the same number however this client got here.
    c.gameState.snapshot.boardState = {};
    expect(c.phaseScore('mine')).toEqual({ cap: 0, death: 5, total: -5 });
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
