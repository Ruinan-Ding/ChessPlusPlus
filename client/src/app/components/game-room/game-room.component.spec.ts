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

  it('draws the picks of a committed turn back in one at a time', () => {
    const c = room();
    [TARGETED, UNIVERSAL, 1].forEach(i => c.pickAbility('mine', i));
    expect([TARGETED, UNIVERSAL, 1].every(i => c.isRecentPick('mine', i))).toBeTrue();

    // The commit puts a curtain over this turn's picks...
    c.endTurn();
    expect([TARGETED, UNIVERSAL, 1].some(i => c.isRecentPick('mine', i))).toBeFalse();

    // ...and each beat lifts its own, so three picks read as three.
    const beat = (index: number) =>
      c.onPlaybackStep({ kind: 'pick', from: '', to: '', index, side: 'mine' });
    beat(TARGETED);
    expect(c.isRecentPick('mine', TARGETED)).toBeTrue();
    expect(c.isRecentPick('mine', UNIVERSAL)).toBeFalse();
    beat(UNIVERSAL);
    beat(1);
    expect([TARGETED, UNIVERSAL, 1].every(i => c.isRecentPick('mine', i))).toBeTrue();
  });

  it('never leaves a pick hidden, however the replay ends', () => {
    const c = room();
    c.pickAbility('mine', TARGETED);
    c.endTurn();
    expect(c.isRecentPick('mine', TARGETED)).toBeFalse();   // curtain down

    // A replay that ends without reaching them lifts it anyway.
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
});
