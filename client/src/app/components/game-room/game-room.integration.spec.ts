import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { GameRoomComponent } from './game-room.component';
import { GameBoardComponent } from '../game-board/game-board.component';
import { AuthService } from '../../services/auth.service';
import { AudioService } from '../../services/audio.service';
import { DEFAULT_GAME_CONFIG } from '../../services/config.service';
import { GameStateService } from '../../services/game-state.service';
import { LocalGameService } from '../../services/local-game.service';
import { WebsocketService } from '../../services/websocket.service';
import { unitStats } from '../../services/unit-stats';
import { statSetting } from '../../services/ability-rules';
import { carries } from '../../services/unit-combat';
import { readStore, removeStore, writeStore } from '../../services/storage';

/** Real template events, room, transport, engine and saved state; only sound and animation delays are skipped. */
describe('Solo game through the rendered room and real services', () => {
  let fixture: ComponentFixture<GameRoomComponent>;
  let room: GameRoomComponent;
  let ws: WebsocketService;
  let engine: LocalGameService;
  let state: GameStateService;
  const keys = [
    ['local', 'cpp.localGame.v1'], ['local', 'cpp.localGame.ui.v2'],
    ['local', 'username'], ['local', 'tripcodeToken'],
    ['session', 'cpp.localGame'], ['session', 'cpp.offline'],
    ['session', 'cpp.roomToken.local'], ['session', 'username'], ['session', 'tripcodeToken'],
  ] as const;
  let stored: Array<string | null>;

  beforeEach(() => {
    stored = keys.map(([kind, key]) => readStore(kind, key));
    for (const [kind, key] of keys) removeStore(kind, key);
    writeStore('session', 'cpp.offline', '1');
  });
  afterEach(() => {
    fixture?.destroy();
    ws?.disconnect();
    for (let i = 0; i < keys.length; i++) {
      const [kind, key] = keys[i];
      if (stored[i] === null) removeStore(kind, key); else writeStore(kind, key, stored[i]!);
    }
  });

  const run = (body: () => void) => fakeAsync(() => {
    try { body(); }
    finally { fixture?.destroy(); ws?.disconnect(); tick(100); }
  });

  const configure = () => {
    TestBed.configureTestingModule({
      imports: [GameRoomComponent],
      providers: [provideRouter([]),
        { provide: ActivatedRoute, useValue: { params: of({ id: 'local' }), queryParams: of({ token: 'local' }) } },
        { provide: AudioService, useValue: { volume: 0, muted: true, playTone: () => {}, playSwoosh: () => {} } },
      ],
    });
    TestBed.inject(AuthService).setUsername('Flow', false);
    ws = TestBed.inject(WebsocketService);
    engine = TestBed.inject(LocalGameService);
    state = TestBed.inject(GameStateService);
    ws.startLocalGame();
    ws.sendMessage({ type: 'create_single_player_game', username: 'Flow' });
    fixture = TestBed.createComponent(GameRoomComponent);
    room = fixture.componentInstance;
    fixture.detectChanges();
    settle();
  };
  const board = (): GameBoardComponent | undefined =>
    fixture.debugElement.query(By.directive(GameBoardComponent))?.componentInstance;
  const animationsSkipped = new WeakSet<GameBoardComponent>();
  const settle = () => {
    tick(0); flushMicrotasks(); fixture.detectChanges();
    const rendered = board();
    if (rendered && !animationsSkipped.has(rendered)) {
      spyOn<any>(rendered, 'playStep').and.returnValue(Promise.resolve());
      spyOn<any>(rendered, 'wait').and.returnValue(Promise.resolve());
      animationsSkipped.add(rendered);
    }
    tick(20); flushMicrotasks(); fixture.detectChanges();
    tick(0); flushMicrotasks(); fixture.detectChanges();
  };
  const click = (selector: string, label?: string) => {
    const buttons = [...fixture.nativeElement.querySelectorAll(selector)] as HTMLElement[];
    const element = label ? buttons.find(button => button.textContent?.trim().startsWith(label)) : buttons[0];
    expect(element).withContext(`${selector}: ${label ?? ''}`).toBeDefined();
    expect((element as HTMLButtonElement)?.disabled).withContext(label ?? selector).not.toBeTrue();
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    settle();
  };
  const start = (color = 'White') => {
    configure();
    const radio = [...fixture.nativeElement.querySelectorAll('.seat-choices label')]
      .find((label: Element) => label.textContent?.trim() === color)?.querySelector('input') as HTMLInputElement;
    radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); settle();
    click('.start-game-btn');
    expect(state.snapshot.turnNumber).toBe(1);
    expect(room.isSinglePlayer).toBeTrue();
    expect(board() instanceof GameBoardComponent).toBeTrue();
  };
  const hex = (key: string) => {
    const cell = board()!.cells.find(cell => cell.key === key)!;
    const polygon = [...fixture.nativeElement.querySelectorAll('polygon.hex-cell')]
      .find((element: Element) => element.getAttribute('points') === cell.points) as Element;
    expect(polygon).withContext(key).toBeDefined();
    polygon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    settle();
  };
  const finish = () => {
    const before = state.snapshot.turnNumber;
    click('.end-turn-btn');
    expect(state.snapshot.turnNumber).toBe(before + 1);
    expect(room.recapRunning).toBeFalse();
  };
  const reload = () => {
    const before = structuredClone(state.snapshot);
    fixture.destroy(); ws.disconnect(); TestBed.resetTestingModule();
    configure();
    expect(state.snapshot.turnNumber).toBe(before.turnNumber);
    expect(state.snapshot.boardState).toEqual(before.boardState);
    expect(state.snapshot.moveHistory).toEqual(before.moveHistory);
  };
  const seed = (id: string, color: 'white' | 'black' = 'white', enemyKey = '1,0', cp = 200) => {
    start(color === 'white' ? 'White' : 'Black');
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.rules!.upAtStart = 100; config.rules!.cpAtStart = cp - 3 * config.rules!.cpPhaseOffset;
    config.setup = { white: {}, black: {} };
    const piece = (unit: string, side: 'white' | 'black', uid: string, hp?: number) => {
      const full = unitStats(unit, config, 3).hp;
      return { unit_id: unit, color: side, uid, hp: hp ?? full, max_hp: full, vet: 3,
        ...(config.units[unit].veterancy?.hp ? { veterancyHpActive: true } : {}) };
    };
    const enemy = color === 'white' ? 'black' : 'white';
    Object.assign((engine as any).game, {
      config, turnNumber: color === 'white' ? 55 : 56,
      currentTurn: 'Flow', moveHistory: [],
      phaseBank: { '1': { white: 0, black: 0 }, '2': { white: 0, black: 0 } },
      boardState: {
        '-8,0': piece('king', 'white', 'wk'), '8,0': piece('king', 'black', 'bk'),
        '0,0': piece(id, color, 'actor'), '-1,0': piece('pawn', color, 'friend', 5),
        [enemyKey]: piece('pawn', enemy, 'enemy'),
      },
    });
    writeStore('local', 'cpp.localGame.v1', JSON.stringify((engine as any).game));
    ws.sendMessage({ type: 'request_game_state' }); settle();
    expect([room.myUnitPoints, room.myCp]).toEqual([100, cp]);
  };
  const useUnit = (name: string) => {
    hex('0,0'); click('.stats-panel .unit-ability-row button', name);
    click('.stats-panel .ability-detail-actions button', 'Use');
  };
  const cast = (name: string, side = 'mine', hexSkill = false) => {
    const panel = side === 'mine' ? '.abilities-panel' : '.opponent-panel';
    click(`${panel} ${hexSkill ? '.path-pair ' : ''}button`, name);
    const action = fixture.nativeElement.querySelector(`${panel} .pick-btn`) as HTMLButtonElement;
    if (action.textContent?.trim() === 'Use') click(`${panel} .pick-btn`, 'Use');
    else expect(room.pendingAbility).withContext(name).not.toBeNull();
  };
  const path = (name: string, side = 'mine') => {
    const panel = side === 'mine' ? '.abilities-panel' : '.opponent-panel';
    click(`${panel} .path-btn`, name); click(`${panel} .pick-btn`, 'Pick');
  };

  it('starts, stages a default board move, undoes, commits and restores the same board and history', run(() => {
    start();
    expect([room.myCp, room.myUnitPoints]).toEqual([5, 10]);
    hex('-4,9'); hex('-4,8');
    expect(room.stagedBoard?.['-4,8']?.unit_id).toBe('pawn');
    expect(state.snapshot.boardState['-4,9'].unit_id).toBe('pawn');
    click('.undo-btn');
    expect(room.stagedBoard).toBeNull();
    hex('-4,9'); hex('-4,8'); finish();
    expect(state.snapshot.boardState['-4,8'].unit_id).toBe('pawn');
    expect(state.snapshot.boardState['-4,9']).toBeUndefined();
    expect(state.snapshot.moveHistory.some(move => move.from === '-4,9' && move.to === '-4,8')).toBeTrue();
    reload();
    expect(room.myUnitPoints).toBe(10);
    expect(room.canEndTurn).toBeTrue();
  }));

  it('automatically commits both sides’ staged moves at expiry and restores the committed position', run(() => {
    start('Black');
    for (const [from, to] of [['-4,9', '-4,8'], ['4,-9', '4,-8']]) {
      const ply = state.snapshot.turnNumber;
      hex(from); hex(to);
      const actor = room.stagedBoard![to].uid;
      expect(state.snapshot.boardState[to]).toBeUndefined();
      Object.assign(state.snapshot, { turnTimeLimit: 15, turnStartedAt: new Date(Date.now() - 16_000).toISOString() });
      (room as any).lastTimerBeep = 1;
      (room as any).updateTurnClock();
      settle();
      expect(state.snapshot.turnNumber).toBe(ply + 1);
      expect(state.snapshot.boardState[to].uid).toBe(actor);
      expect(state.snapshot.moveHistory.filter(move => move.from === from && move.to === to).length).toBe(1);
    }
    reload();
    expect(state.snapshot.turnNumber).toBe(3);
    expect(state.snapshot.boardState['-4,8'].color).toBe('white');
    expect(state.snapshot.boardState['4,-8'].color).toBe('black');
  }));

  for (const color of ['white', 'black'] as const) {
    it(`groups ${color} Fortress recipients and keeps the exhausted ultimate readable and undoable`, run(() => {
      seed('king', color, '1,0', 300); path('Bastion'); cast('Fortress');
      expect(room.playback.length).toBe(1);
      expect(room.playback[0].targets!.length).toBe(Object.keys(state.snapshot.boardState).length);
      expect(room.playback[0].targets!.some(target => target.hostile)).toBeTrue();
      expect(room.playback[0].targets!.some(target => !target.hostile)).toBeTrue();
      const button = fixture.nativeElement.querySelector('.abilities-panel .ultimate-btn') as HTMLButtonElement;
      expect(button.classList.contains('exhausted')).toBeTrue();
      expect(button.disabled).toBeFalse();
      expect(getComputedStyle(button).backgroundColor).toBe('rgb(141, 152, 163)');
      click('.abilities-panel .ultimate-btn');
      expect(room.focusedAbilityBlocker).toContain('Used up');
      expect(room.focusedAbilityDescription).toContain('damage');
      expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
      click('.undo-btn');
      expect(room.usesLeft('mine', room.slotOfAbility('fortress'))).toBe(1);
      expect(fixture.nativeElement.querySelector('.abilities-panel .ultimate-btn').classList.contains('exhausted')).toBeFalse();
    }));

    it(`greys ${color} Drain only after its third use and preserves its description`, run(() => {
      seed('king', color);
      (engine as any).game.config.rules.cpAtStart += 100;
      ws.sendMessage({ type: 'request_game_state' }); settle(); path('Bastion');
      const i = room.slotOfAbility('anchor');
      for (let use = 0; use < 3; use++) {
        room.myCooldowns[i] = 0; cast('Drain', 'mine', true); hex('1,0');
        expect(room.playback.length).toBe(1);
        expect(room.playback[0].targets!.length).toBeGreaterThan(1);
        expect(room.playback[0].targets!.some(target => target.hostile)).toBeTrue();
        expect(room.playback[0].targets!.some(target => !target.hostile)).toBeTrue();
        const button = fixture.nativeElement.querySelector('.abilities-panel .path-pair .scaffold-btn:not(.ultimate-btn)') as HTMLButtonElement;
        expect(button.classList.contains('exhausted')).toBe(use === 2);
      }
      const cp = room.myCp;
      click('.abilities-panel .path-pair .scaffold-btn:not(.ultimate-btn)');
      expect(room.focusedAbilityBlocker).toContain('Used up');
      expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
      expect(room.myCp).toBe(cp);
    }));
  }

  it('replays a completed panel walk after End Turn and saved-game reload', run(() => {
    start();
    let source = '', destination = '';
    for (const cell of board()!.cells.filter(cell => cell.panel === 'bl' && cell.piece)) {
      hex(cell.key);
      const target = board()!.cells.find(cell => cell.panel === 'bl' && !cell.piece && board()!.legalTargets.has(cell.key));
      if (target) { source = cell.key; destination = target.key; break; }
    }
    expect(destination).withContext('a reachable empty base hex').not.toBe('');
    hex(destination); finish();
    expect((room as any).lastReplay.steps).toContain(jasmine.objectContaining({ kind: 'move', from: source, to: destination }));
    reload();
    click('.view-controls button', 'Replay');
    expect((room as any).lastReplay.steps).toContain(jasmine.objectContaining({ kind: 'move', from: source, to: destination }));
    expect(board()!.cells.find(cell => cell.key === destination)!.piece).toBeTruthy();
  }));

  it('replays the completed turn through the button and Z while preserving a later staged move', run(() => {
    start();
    expect((fixture.nativeElement.querySelector('.view-controls button:last-child') as HTMLButtonElement).disabled).toBeTrue();
    hex('-4,9'); hex('-4,8'); finish();
    hex('4,-9'); hex('4,-8');
    const staged = (room as any).stagedActions, before = structuredClone(room.stagedBoard);
    const history = state.snapshot.moveHistory;
    click('.view-controls button', 'Replay');
    expect(room.stagedBoard).toEqual(before); expect((room as any).stagedActions).toBe(staged);
    expect(state.snapshot.moveHistory).toBe(history);
    expect(board()!.cells.find(cell => cell.key === '4,-8')!.piece?.color).toBe('black');
    room.windowFocused = true; room.chatFocused = false;
    room.onShortcut(new KeyboardEvent('keydown', { key: 'z' })); settle();
    expect(room.stagedBoard).toEqual(before); expect(state.snapshot.moveHistory).toBe(history);
    expect(fixture.nativeElement.querySelector('.view-controls').textContent).not.toContain('Flip');
    reload();
    expect(room.stagedBoard).toEqual(before);
    click('.view-controls button', 'Replay');
    expect(room.stagedBoard).toEqual(before); expect(state.snapshot.moveHistory).toEqual(history);
    expect((room as any).lastReplay.cells.find((cell: any) => cell.key === '4,-9').piece?.color).toBe('black');
    expect((room as any).lastReplay.cells.find((cell: any) => cell.key === '4,-8').piece).toBeNull();
  }));

  it('waits five full turns for the second pair through rendered picks, End Turn and reload', run(() => {
    start(); click('.abilities-panel .scaffold-btn', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
    click('.abilities-panel .scaffold-btn', 'Bulwark');
    expect(room.focusedAbilityBlocker).toContain('Turn 6');
    expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
    reload(); expect(room.poolPairWait('mine')).toBe(5);
    for (let ply = 1; ply <= 10; ply++) finish();
    expect(state.snapshot.turnNumber).toBe(11);
    click('.abilities-panel .scaffold-btn', 'Bulwark'); click('.abilities-panel .pick-btn', 'Pick');
    expect(room.myLoadout.length).toBe(4);
  }));

  it('plays a small-lead shipped match through all 100 plies, buys paths, earns VP/UP/CP and restores the final result', run(() => {
    start();
    expect(room.myCp).toBe(5);
    hex('-4,9'); hex('-4,8'); finish();
    hex('8,-10'); hex('7,-2');
    for (let turns = 0; state.snapshot.turnNumber <= 100 && !room.gameOver && turns < 100; turns++) {
      const ply = state.snapshot.turnNumber;
      if ([7, 27, 49, 71].includes(ply)) {
        expect(state.snapshot.boardState['-4,8'].vet).withContext(`ply ${ply}`)
          .toBe(({ 7: 1, 27: 2, 49: 3, 71: 3 } as Record<number, number>)[ply]);
        const bases = board()!.cells.filter(cell => ['bl', 'tr'].includes(cell.panel ?? '') && cell.piece);
        expect(bases.length).toBeGreaterThan(0);
        expect(bases.every(cell => (cell.piece!.vet ?? 0) === 0)).toBeTrue();
      }
      if ([17, 39, 61].includes(ply)) {
        expect(room.myUnitPoints).withContext(`ply ${ply}`)
          .toBe(({ 17: 13, 39: 19, 61: 28 } as Record<number, number>)[ply]);
        expect(room.opponentUnitPoints).toBe(({ 17: 11, 39: 13, 61: 16 } as Record<number, number>)[ply]);
      }
      if (ply === 27 || ply === 28) path('Bastion', ply === 27 ? 'mine' : 'opponent');
      if (ply === 49 || ply === 50) {
        const mine = ply === 49;
        const cp = mine ? room.myCp : room.cpOf('opponent');
        const points = mine ? room.myPoints : room.opponentPoints;
        cast('Convert', mine ? 'mine' : 'opponent');
        expect(mine ? room.myCp : room.cpOf('opponent')).toBe(cp - 25);
        expect(mine ? room.myPoints : room.opponentPoints).toBe(points + 50);
      }
      if (ply === 39) {
        const purses = [room.myCp, room.cpOf('opponent'), room.myPoints, room.myUnitPoints];
        reload();
        expect([room.myCp, room.cpOf('opponent'), room.myPoints, room.myUnitPoints]).toEqual(purses);
        expect(room.phaseBank['1']).toEqual({ white: 3, black: 1 });
      }
      if (ply === 71) {
        const ultimate = room.slotOfAbility('fortress');
        expect(room.canAfford('mine', ultimate, 0)).toBeFalse();
        expect(room.abilityUses['mine|fortress'] ?? 0).toBe(0);
      }
      finish();
    }
    expect(state.snapshot.endReason).toBe('overtime');
    expect(state.snapshot.winner).toBe(state.snapshot.playerBlack);
    expect(state.snapshot.turnNumber).toBe(101);
    expect(room.phaseBank).toEqual({
      '1': { white: 3, black: 1 }, '2': { white: 6, black: 2 }, '3': { white: 9, black: 3 },
    });
    reload();
    expect(room.gameOver).toBeTrue();
    expect(state.snapshot.winner).toBe(state.snapshot.playerBlack);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('YOU LOST');
  }));

  const kits = [
    ['pawn', 'Sacrifice', 76], ['archer', 'Snare', 92], ['shieldman', 'Taunt', 94],
    ['rook', 'Bash', 84], ['knight', 'Charge', 84], ['bishop', 'Cast', 68],
    ['queen', 'Nullify', 88], ['king', 'Call', 96],
  ] as const;
  for (const [id, name, balance] of kits) {
    it(`${name} reaches the real engine from unit controls and survives reload`, run(() => {
      seed(id, 'white', id === 'archer' ? '3,0' : '1,0');
      if (id === 'rook') {
        (engine as any).game.boardState['0,1'] = {
          unit_id: 'pawn', color: 'black', uid: 'splash', hp: 14, max_hp: 14, vet: 3,
        };
        ws.sendMessage({ type: 'request_game_state' }); settle();
      }
      useUnit(name);
      if (id === 'pawn') { hex('-1,0'); hex('-1,0'); }
      if (id === 'bishop') { hex('1,0'); hex('1,0'); hex('1,1'); }
      if (['archer', 'rook', 'knight', 'queen'].includes(id)) hex(id === 'archer' ? '3,0' : '1,0');
      expect(room.myUnitPoints).withContext(name).toBe(balance);
      const committedBalance = balance + (id === 'knight' ? state.snapshot.config.units.pawn.value : 0);
      finish();
      const saved = state.snapshot.boardState;
      expect(room.myUnitPoints).toBe(committedBalance);
      if (id === 'pawn') {
        expect(saved['0,0']).toBeUndefined(); expect(saved['-1,0'].hp).toBe(14);
        expect((room as any).buffs.friend.atk).toBe(6); expect(room.extraActionUids).toEqual([]);
        expect(state.snapshot.moveHistory.some(move => (move as any).unitCast?.id === 'unit-sacrifice')).toBeTrue();
      }
      if (id === 'archer') { expect(saved['3,0'].hp).toBe(13); expect(room.buffs['enemy'].mov).toBe(-4); }
      if (id === 'shieldman') expect(carries(room.buffs['actor'], 'taunt')).toBeTrue();
      if (id === 'rook') { expect(saved['1,0'].hp).toBe(6); expect(saved['0,1'].hp).toBe(6); expect(saved['0,0'].hp).toBe(23); }
      if (id === 'knight') { expect(saved['1,0']).toBeUndefined(); expect(saved['0,0'].hp).toBe(18); }
      if (id === 'bishop') { expect(saved['1,1'].color).toBe('white'); expect(saved['1,1'].owner).toBe('black'); }
      if (id === 'queen') { expect(saved['1,0'].hp).toBe(4); expect(saved['0,0'].hp).toBe(34); }
      if (id === 'king') { expect(saved['-1,0'].hp).toBe(6); expect(saved['1,0'].hp).toBe(13); expect(room.buffs['enemy'].atk).toBe(-1); }
      const cooldown = structuredClone(room.unitCooldowns);
      const effects = structuredClone(room.buffs);
      reload();
      expect(room.myUnitPoints).toBe(committedBalance);
      expect(room.unitCooldowns).toEqual(cooldown);
      expect(room.buffs).toEqual(effects);
      finish();
      if (id === 'bishop') { expect(state.snapshot.boardState['1,1'].color).toBe('black'); expect(state.snapshot.boardState['1,1'].owner).toBe('black'); }
      if (id === 'archer') expect(room.buffs['enemy']).toBeUndefined();
    }));
  }

  for (const color of ['white', 'black'] as const) for (const buffedActor of [true, false]) {
    it(`Sacrifice grants one unused extra actor for ${color}, commits two actions and reloads`, run(() => {
      seed('pawn', color, '0,1');
      useUnit('Sacrifice'); expect(room.myUnitPoints).toBe(100);
      hex('-1,0'); expect(room.myUnitPoints).toBe(76);
      const king = color === 'white' ? '-8,0' : '8,0';
      const kingTo = color === 'white' ? '-7,0' : '7,0';
      const extra = buffedActor ? '-1,0' : king;
      const normal = buffedActor ? king : '-1,0';
      const normalTo = buffedActor ? kingTo : '-1,1';
      const extraTo = buffedActor ? '-1,1' : kingTo;
      hex(extra); expect(room.extraActionUids.length).toBe(1);
      hex(normal); hex(normalTo);
      if (!buffedActor) hex('0,1');
      hex(extra); hex(extraTo);
      if (buffedActor) hex('0,1');
      expect(room.unitActionsSpent).toBe(1);
      finish(); expect(state.snapshot.boardState[extraTo]).toBeDefined();
      expect(state.snapshot.boardState[normalTo]).toBeDefined();
      expect(state.snapshot.boardState['0,0']).toBeUndefined();
      expect(state.snapshot.boardState['-1,1'].hp).toBe(13);
      expect(state.snapshot.boardState['0,1'].hp).toBe(6);
      expect((room as any).buffs.friend.atk).toBe(6);
      expect(room.myUnitPoints).toBe(76);
      reload(); expect(room.myUnitPoints).toBe(76);
      expect(state.snapshot.boardState['-1,1'].hp).toBe(13);
      finish(); expect((room as any).buffs.friend).toBeUndefined();
    }));
  }

  it('Checkmate applies on arrival without extending the current walk, and commits its combat', run(() => {
    seed('pawn', 'white', '1,-9');
    const g = (engine as any).game;
    g.boardState['0,-8'] = g.boardState['0,0']; delete g.boardState['0,0'];
    g.boardState['1,-9'] = { unit_id: 'shieldman', color: 'black', uid: 'enemy', hp: 30, max_hp: 30, vet: 3, veterancyHpActive: true };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('0,-8'); hex('0,-9');
    expect(room.statAtk).toBe('1:14/8'); expect(room.statDef).toBe('12/6');
    expect(room.movesLeft).toBe(5);
    hex('1,-9'); expect(room.stagedBoard?.['1,-9'].hp).toBe(29);
    expect(room.movesLeft).toBe(0);
    finish(); reload();
    expect(state.snapshot.boardState['0,-9'].uid).toBe('actor');
    expect(state.snapshot.boardState['1,-9'].hp).toBe(29);
  }));

  it('Checkmate keeps its starting MOV while leaving but immediately loses its combat bonus', run(() => {
    seed('pawn'); const g = (engine as any).game;
    g.boardState['0,-9'] = g.boardState['0,0']; delete g.boardState['0,0'];
    ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('0,-9'); hex('0,-3');
    expect(room.movesLeft).toBe(2); expect(room.statAtk).toBe('1:8/8'); expect(room.statDef).toBe('6/6');
    hex('0,-1'); finish(); reload();
    expect(state.snapshot.boardState['0,-1'].uid).toBe('actor');
  }));

  it('Quick lets a veteran archer use its remaining MOV after attacking, through commit and reload', run(() => {
    seed('archer', 'white', '4,0'); const g = (engine as any).game;
    g.boardState['4,0'] = { unit_id: 'shieldman', color: 'black', uid: 'enemy', hp: 30, max_hp: 30, vet: 3, veterancyHpActive: true };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('0,0'); hex('1,0'); hex('4,0');
    expect(room.movesLeft).toBe(7);
    hex('1,0'); hex('2,0'); expect(room.movesLeft).toBe(6);
    finish(); reload();
    expect(state.snapshot.boardState['2,0'].uid).toBe('actor'); expect(state.snapshot.boardState['4,0'].hp).toBe(29);
    expect(state.snapshot.moveHistory.filter(move => move.attacked).length).toBe(1);
  }));

  it('retains Rapid Movement actors in the completed replay after reload', run(() => {
    seed('pawn', 'white', '2,0');
    const game = (engine as any).game;
    game.config.units.pawn.passive = 'rapid-movement';
    game.config.units.shieldman.passive = 'deflect';
    game.boardState['2,0'] = { unit_id: 'shieldman', color: 'black', uid: 'enemy', vet: 3, hp: 32, max_hp: 32 };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('0,0'); hex('1,0'); hex('2,0'); hex('1,1'); finish();
    const saved = JSON.parse(readStore('local', 'cpp.localGame.ui.v2')!);
    saved.replay.steps.forEach((step: any) => delete step.actor);
    writeStore('local', 'cpp.localGame.ui.v2', JSON.stringify(saved)); reload();
    const before = structuredClone(state.snapshot);
    const replayed: any[] = [];
    board()!.playbackStep.subscribe(step => replayed.push(step));
    click('.view-controls button', 'Replay');
    expect(replayed.map(step => step.kind)).toEqual(['move', 'attack', 'move']);
    expect(replayed.map(step => step.actor)).toEqual(Array(3).fill({ unit_id: 'pawn', color: 'white', uid: 'actor' }));
    expect(state.snapshot).toEqual(before); expect(state.snapshot.boardState['1,1'].uid).toBe('actor');
  }));

  it('retains the killed Charge defender in staged and received replay beats', run(() => {
    seed('knight');
    (engine as any).game.boardState['1,0'].hp = 9;
    ws.sendMessage({ type: 'request_game_state' }); settle();
    useUnit('Charge'); hex('1,0');
    expect(room.playback.map((step: any) => step.actor?.uid)).toEqual(['actor', 'enemy', 'actor']);
    finish(); expect(state.snapshot.boardState['1,0']).toBeUndefined(); reload();
    const before = structuredClone(state.snapshot), replayed: any[] = [];
    board()!.playbackStep.subscribe(step => replayed.push(step));
    click('.view-controls button', 'Replay');
    const combat = replayed.filter(step => step.kind === 'attack' || step.kind === 'counter');
    expect(combat.map(step => step.actor?.uid)).toEqual(['actor', 'enemy', 'actor']);
    expect(combat[1].actor).toEqual({ unit_id: 'pawn', color: 'black', uid: 'enemy' });
    expect(state.snapshot).toEqual(before);
  }));

  it('keeps a protected Charge exchange in staging, committed history and Replay after solo reload', run(() => {
    seed('knight', 'white', '1,0', 300);
    const game = (engine as any).game;
    game.boardState['1,0'] = { unit_id: 'rook', color: 'black', uid: 'enemy', vet: 3, hp: 40, max_hp: 40 };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    finish(); path('Bastion', 'opponent'); cast('Fortress', 'opponent'); finish();
    useUnit('Charge'); hex('1,0');
    expect(room.stagedActions.at(-1)?.secondStrike).toBeTrue();
    expect(room.playback.map((step: any) => step.kind)).toEqual(['attack', 'counter', 'attack']);
    finish();
    const record: any = state.snapshot.moveHistory.find(move => move.attacked);
    expect(record).toEqual(jasmine.objectContaining({ countered: true, secondStrike: true, damage_dealt: 0 }));
    expect(state.snapshot.boardState['1,0'].hp).toBe(40);
    reload();
    const replayed: string[] = [];
    board()!.playbackStep.subscribe(step => replayed.push(step.kind));
    click('.view-controls button', 'Replay');
    expect(replayed.filter(kind => kind === 'attack').length).toBe(2);
    expect(replayed).toContain('counter');
  }));

  it('updates Capture claims through movement, Undo, commit and reload, and displays the new king passive', run(() => {
    seed('king');
    const g = (engine as any).game;
    g.boardState['2,0'] = g.boardState['0,0']; delete g.boardState['0,0'];
    g.boardState['1,0'] = { ...g.boardState['1,0'], unit_id: 'rook', hp: 24, max_hp: 24 };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    expect(board()!.captureClaim.get('0,-2')).toBe('white');
    expect(board()!.captureClaim.get('1,0')).toBe('black');
    hex('2,0'); click('.stats-panel .unit-ability-row button', 'Capture');
    expect(fixture.nativeElement.querySelector('.stats-panel').textContent).toContain('eligible enemies keep their occupied hexes');
    click('.stats-panel .ability-back-btn', 'Back'); hex('3,0');
    expect(board()!.captureClaim.has('0,-2')).toBeFalse();
    click('.undo-btn'); expect(board()!.captureClaim.get('0,-2')).toBe('white');
    hex('2,0'); hex('3,0'); finish(); reload();
    expect(board()!.captureClaim.has('0,-2')).toBeFalse();
    expect(state.snapshot.boardState['3,0'].uid).toBe('actor');
  }));

  it('applies Persuade from the queen on her next turn without the former king aura or enemy drain', run(() => {
    seed('queen');
    const g = (engine as any).game;
    g.boardState['-7,0'] = { ...g.boardState['-1,0'], uid: 'king-neighbor' };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('0,0'); click('.stats-panel .unit-ability-row button', 'Persuade');
    finish(); finish();
    expect([room.buffs['friend'].atk, room.buffs['friend'].def, room.buffs['friend'].mov]).toEqual([1, 1, 1]);
    expect(room.buffs['enemy']).toBeUndefined(); expect(room.buffs['king-neighbor']).toBeUndefined();
    reload(); expect(room.buffs['friend'].atk).toBe(1);
  }));

  it('uses Black unit controls, restores a staged cast, and undoes its cost and effects before commit', run(() => {
    seed('king', 'black');
    useUnit('Call');
    expect(room.myUnitPoints).toBe(96);
    expect(room.stagedBoard?.['1,0'].hp).toBe(13);
    reload();
    expect(room.myUnitPoints).toBe(96);
    expect(room.stagedBoard?.['1,0'].hp).toBe(13);
    click('.undo-btn');
    expect(room.myUnitPoints).toBe(100);
    expect(room.stagedBoard).toBeNull();
    expect(room.unitCooldowns['actor']).toBeUndefined();
    finish();
    expect(state.snapshot.boardState['1,0'].hp).toBe(14);
    expect(room.myUnitPoints).toBe(100);
  }));

  it('resigns through the controls, restarts with a new seat, and clears the saved game only on deliberate leave', run(() => {
    start();
    expect(engine.hasSavedGame()).toBeTrue();
    click('.resign-btn');
    expect(state.snapshot.endReason).toBe('resign');
    reload();
    expect(state.snapshot.endReason).toBe('resign');
    click('.start-game-btn', 'Restart');
    expect(room.gameStarted).toBeFalse();
    const black = [...fixture.nativeElement.querySelectorAll('.seat-choices label')]
      .find((label: Element) => label.textContent?.trim() === 'Black')!.querySelector('input') as HTMLInputElement;
    black.checked = true; black.dispatchEvent(new Event('change', { bubbles: true })); settle();
    click('.start-game-btn', 'Start');
    expect(state.snapshot.playerBlack).toBe('Flow');
    expect(state.snapshot.turnNumber).toBe(1);
    expect(state.snapshot.endReason).toBe('');
    // Reload creates a new router instance, so capture that instance's navigation too.
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    click('.leave-btn');
    expect(engine.hasSavedGame()).toBeFalse();
    expect(readStore('local', 'cpp.localGame.v1')).toBeNull();
    expect(ws.isLocal()).toBeFalse();
    expect(readStore('session', 'cpp.localGame')).toBeNull();
  }));

  it('prioritizes an armed friendly buff over bishop healing, then permits normal healing after expiry', run(() => {
    seed('bishop'); hex('0,0');
    click('.abilities-panel button', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
    cast('Warcry'); hex('-1,0');
    expect(room.buffs['friend'].atk).toBe(8);
    expect((room.stagedBoard ?? state.snapshot.boardState)['-1,0'].hp).toBe(5);
    finish();
    expect(state.snapshot.boardState['-1,0'].hp).toBe(5);
    reload(); expect(room.buffs['friend'].atk).toBe(8);
    finish(); expect(room.buffs['friend']).toBeUndefined();
    hex('0,0'); hex('-1,0');
    expect(room.stagedBoard?.['-1,0'].hp).toBe(13);
    finish(); expect(state.snapshot.boardState['-1,0'].hp).toBe(13);
  }));

  for (const [pathName, skill, cost] of [['Bastion', 'Drain', 50], ['Onslaught', 'Cleave', 50], ['Sprint', 'Trap', 50]] as const) {
    it(`${pathName} hex skill targets through the SVG, undoes, commits and expires after reload`, run(() => {
      seed('bishop'); path(pathName);
      const before = room.myCp;
      cast(skill, 'mine', true); hex('1,0');
      expect(room.myCp).toBe(before - cost);
      click('.undo-btn');
      expect(room.myCp).toBe(before);
      expect(room.abilityUses[`mine|${skill === 'Drain' ? 'anchor' : skill === 'Cleave' ? 'cleave' : 'surge'}`] ?? 0).toBe(0);
      cast(skill, 'mine', true); hex('1,0'); finish();
      if (skill === 'Cleave') {
        expect(state.snapshot.boardState['1,0'].hp).toBe(9);
        expect(state.snapshot.boardState['0,0'].hp).toBe(10);
      }
      if (skill === 'Drain') {
        expect(statSetting(room.buffs['enemy'], 'atk')).toBe(0);
        expect(room.buffs['actor'].atk).toBe(-4);
        expect(room.buffs['actor'].hel).toBe(-4);
      }
      if (skill === 'Trap') expect(carries(room.buffs['enemy'], 'action-lock')).toBeTrue();
      const effects = structuredClone(room.buffs);
      const cooldowns = [...room.myCooldowns];
      reload();
      expect(room.myCp).toBe(before - cost);
      expect(room.buffs).toEqual(effects); expect(room.myCooldowns).toEqual(cooldowns);
      finish();
      if (skill === 'Drain' || skill === 'Trap') expect(room.buffs['enemy']).toBeUndefined();
    }));
  }

  it('Strengthen promotes wounded current/max HP once through targeting, Undo, commit and reload', run(() => {
    seed('pawn');
    const actor = (engine as any).game.boardState['0,0'];
    Object.assign(actor, { hp: 5, max_hp: 12, vet: 0, veterancyHpActive: false });
    const game = (engine as any).game;
    delete game.boardState['0,0']; game.boardState['-10,9'] = actor;
    // A late arrival stayed in red through all previous rank awards.
    game.moveHistory = [
      { turn: 51, from: '-12,11', to: '11,1', panelMove: true, panel: 'bl', unit: { ...actor }, price: 0 },
      { turn: 53, from: '11,1', to: '-10,9', entered: true, color: 'white', unit: { ...actor } },
    ];
    ws.sendMessage({ type: 'request_game_state' }); settle(); hex('-10,9');
    const row = (): HTMLElement => fixture.nativeElement.querySelector('.veterancy-row');
    expect(row().textContent).toContain('Not active:');
    path('Onslaught'); cast('Strengthen'); hex('-10,9');
    expect(row().classList.contains('active')).toBeTrue();
    expect(room.stagedBoard?.['-10,9']).toEqual(jasmine.objectContaining({ hp: 7, max_hp: 14, vet: 1 }));
    click('.undo-btn');
    expect(room.myCp).toBe(200 - room.abilityPaths.find(p => p.id === 'onslaught')!.cost);
    expect(room.stagedBoard).toBeNull();
    expect(row().textContent).toContain('Not active:');
    expect(row().classList.contains('active')).toBeFalse();
    cast('Strengthen'); hex('-10,9'); finish(); reload(); hex('-10,9');
    expect(row().classList.contains('active')).toBeTrue();
    expect(state.snapshot.boardState['-10,9']).toEqual(jasmine.objectContaining({ hp: 7, max_hp: 14, vet: 1 }));
    expect(room.myCp).toBe(200 - room.abilityPaths.find(p => p.id === 'onslaught')!.cost - room.abilityCosts[room.slotOfAbility('strengthen')]);
  }));

  for (const color of ['white', 'black'] as const) {
    for (const [id, name, stat] of [['sap', 'Sap', 'atk'], ['weakening', 'Weakening', 'def'], ['mire', 'Mire', 'mov']] as const) {
      it(`${color} ${name} waits for one enemy, cancels red bases, undoes and restores only its recipient`, run(() => {
        seed('pawn', color); const g = (engine as any).game;
        const enemy = color === 'white' ? 'black' : 'white';
        const baseKey = enemy === 'black' ? '12,-1' : '-12,1';
        const reserveKey = enemy === 'black' ? '-11,-1' : '11,1';
        g.config.setup[enemy][baseKey] = 'pawn';
        g.config.setup[enemy][reserveKey] = 'pawn';
        g.boardState['2,0'] = { ...g.boardState['1,0'], uid: 'other' };
        ws.sendMessage({ type: 'request_game_state' }); settle();
        click('.abilities-panel .scaffold-btn', name); click('.abilities-panel .pick-btn', 'Pick');
        const before = room.myPoints, i = room.slotOfAbility(id);
        cast(name); expect(room.pendingAbility?.index).toBe(i);
        expect(room.myPoints).toBe(before); expect(room.buffs).toEqual({});
        hex('-1,0'); expect(room.pendingAbility).toBeNull(); expect(room.myPoints).toBe(before);
        cast(name); hex(baseKey); expect(room.pendingAbility).toBeNull();
        expect(room.myPoints).toBe(before); expect(room.myCooldowns[i]).toBe(0);
        cast(name); hex('1,0');
        expect(Object.keys(room.buffs)).toEqual(['enemy']);
        expect(room.buffs['enemy'][stat]).toBe(room.abilityEffects[i][stat]);
        expect(room.myPoints).toBe(before - room.abilityCosts[i]);
        click('.undo-btn'); expect(room.buffs).toEqual({}); expect(room.myPoints).toBe(before);
        cast(name); hex(reserveKey);
        const recipient = board()!.cells.find(cell => cell.key === reserveKey)!.piece!.uid!;
        expect(Object.keys(room.buffs)).toEqual([recipient]);
        finish(); reload(); expect(Object.keys(room.buffs)).toEqual([recipient]);
        expect(room.buffs[recipient][stat]).toBe(room.abilityEffects[i][stat]);
        expect(room.myCooldowns[i]).toBe(room.abilityEffects[i].cooldown);
        finish(); expect(room.buffs[recipient]).toBeUndefined();
      }));
    }
  }

  it('Recharge selects either carried button, reduces both cooldowns, undoes and restores the committed result', run(() => {
    seed('pawn'); path('Sprint');
    click('.abilities-panel button', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
    cast('Warcry'); hex('-1,0'); cast('Sap'); hex('1,0');
    const warcry = room.slotOfAbility('warcry'), sap = room.slotOfAbility('sap');
    expect([room.myCooldowns[warcry], room.myCooldowns[sap]]).toEqual([3, 5]);
    click('.abilities-panel .path-extra-btn', 'Recharge');
    expect(fixture.nativeElement.querySelector('.abilities-panel .ability-detail').textContent).toContain('stopping at 1');
    expect(room.pendingAbility).toBeNull();
    click('.abilities-panel .pick-btn', 'Use');
    expect(room.pendingAbility?.index).toBe(room.slotOfAbility('recharge'));
    click('.abilities-panel .panel-buttons > button', 'Sap');
    expect([room.myCooldowns[warcry], room.myCooldowns[sap], room.myCp]).toEqual([2, 4, 125]);
    click('.undo-btn');
    expect([room.myCooldowns[warcry], room.myCooldowns[sap], room.myCp]).toEqual([3, 5, 150]);
    cast('Recharge'); click('.abilities-panel .panel-buttons > button', 'Warcry');
    finish(); reload();
    expect([room.myCooldowns[warcry], room.myCooldowns[sap], room.myCp]).toEqual([2, 4, 125]);
    expect(room.myCooldowns[room.slotOfAbility('recharge')]).toBe(1);
  }));

  it('Ruin applies damage before healing survivors, and its single use stays spent across reload', run(() => {
    seed('pawn', 'white', '1,0', 300); path('Onslaught');
    cast('Ruin');
    expect(room.stagedBoard?.['-1,0'].hp).toBe(5);
    expect(room.stagedBoard?.['1,0'].hp).toBe(11);
    expect(room.myCp).toBe(300 - room.abilityPaths.find(p => p.id === 'onslaught')!.cost - room.abilityCosts[room.slotOfAbility('ruin')]);
    finish(); reload();
    expect(state.snapshot.boardState['1,0'].hp).toBe(11);
    expect(state.snapshot.boardState['-1,0'].hp).toBe(5);
    expect(room.abilityUses['mine|ruin']).toBe(1);
    finish();
    click('.abilities-panel button', 'Ruin');
    expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
  }));

  it('Blitz locks enemy unit actions while pool casts remain usable, and expires after the opponent turn', run(() => {
    seed('bishop', 'white', '1,0', 300); path('Sprint'); cast('Blitz');
    expect(room.buffs['actor'].hel).toBe(4);
    hex('-1,0'); expect(room.statHel).toBe('—');
    expect(room.myCp).toBe(0);
    finish(); reload();
    expect(carries(room.buffs['enemy'], 'action-lock')).toBeTrue();
    hex('1,0'); hex('2,0');
    expect(room.stagedBoard).toBeNull();
    click('.opponent-panel button', 'Mend'); click('.opponent-panel .pick-btn', 'Pick');
    cast('Strike', 'opponent'); hex('-1,0');
    expect(room.stagedBoard?.['-1,0'].hp).toBe(1);
    finish();
    expect(state.snapshot.boardState['-1,0'].hp).toBe(1);
    expect(room.buffs['enemy']).toBeUndefined();
    expect(room.buffs['actor']).toBeUndefined();
  }));

  for (const [pathName, utility, id] of [['Bastion', 'Convert', 'convert'], ['Onslaught', 'Strengthen', 'strengthen'], ['Sprint', 'Recharge', 'recharge']] as const) {
    it(`${utility} enforces five uses per phase with turn locks, Undo, reload and fresh phase budgets`, run(() => {
      seed('pawn');
      const g = (engine as any).game;
      g.config.rules.cpAtStart += 300;
      g.turnNumber = 7; g.currentTurn = 'Flow';
      ws.sendMessage({ type: 'request_game_state' }); settle(); path(pathName);
      const i = room.slotOfAbility(id);
      if (id === 'recharge') { click('.abilities-panel button', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick'); }
      const use = () => {
        cast(utility);
        if (id === 'strengthen') hex('0,0');
        if (id === 'recharge') click('.abilities-panel .panel-buttons > button', 'Warcry');
      };
      use(); expect(room.usesLeft('mine', i)).toBe(4);
      expect(room.canAfford('mine', i, room.myCooldowns[i])).toBeFalse();
      expect(fixture.nativeElement.querySelector('.abilities-panel .path-extra-btn').classList.contains('cooling')).toBeTrue();
      click('.undo-btn'); expect(room.usesLeft('mine', i)).toBe(5);
      for (let used = 1; used <= 5; used++) {
        use(); expect(room.abilityLabel(i, room.myCooldowns[i])).toBe(`${utility} (${5 - used}) ${room.abilityCosts[i]}`);
        finish(); reload(); expect(room.usesLeft('mine', i)).toBe(5 - used);
        finish();
      }
      const balance = room.myCp;
      click('.abilities-panel .path-extra-btn', utility);
      expect(fixture.nativeElement.querySelector('.abilities-panel').textContent).toContain('no uses left this phase');
      expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
      expect(room.myCp).toBe(balance);
      // Halftime/postmatch stay in Phase 1; all overtime stages share one budget.
      for (const ply of [17, 27, 29, 51, 73, 83, 105]) {
        Object.assign((engine as any).game, { turnNumber: ply, currentTurn: 'Flow' });
        ws.sendMessage({ type: 'request_game_state' }); settle();
        expect(room.usesLeft('mine', i)).withContext(`ply ${ply}`).toBe(ply < 29 ? 0 : 5);
      }
      expect(room.usesLeft('opponent', i)).toBe(5);
    }));
  }

  for (const [pathName, utility] of [['Bastion', 'Convert'], ['Onslaught', 'Strengthen'], ['Sprint', 'Recharge']] as const) {
    it(`${utility} commits during initialization while ordinary casts remain blocked`, run(() => {
      seed('pawn'); const g = (engine as any).game;
      g.turnNumber = 1; g.currentTurn = 'Flow';
      Object.assign(g.boardState['0,0'], { vet: 0, hp: 5, max_hp: 12, veterancyHpActive: false });
      ws.sendMessage({ type: 'request_game_state' }); settle(); path(pathName);
      if (utility === 'Recharge') { click('.abilities-panel button', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick'); }
      const i = room.slotOfAbility(utility.toLowerCase());
      expect(room.canAfford('mine', room.slotOfAbility('warcry'), 0)).toBeFalse();
      cast(utility);
      if (utility === 'Strengthen') hex('0,0');
      if (utility === 'Recharge') click('.abilities-panel .panel-buttons > button', 'Warcry');
      finish(); reload();
      expect(room.usesLeft('mine', i)).toBe(4);
      if (utility === 'Strengthen') expect(state.snapshot.boardState['0,0']).toEqual(jasmine.objectContaining({ hp: 7, max_hp: 14, vet: 1 }));
    }));
  }

  it('shows configured Vet 1 bonuses and active rank while switching units, opening details and reloading', run(() => {
    seed('pawn');
    const g = (engine as any).game;
    g.turnNumber = 1; g.phaseBank = {};
    const descriptions: Record<string, string> = {
      pawn: '+2 ATK, +2 DEF, +2 HP', archer: '+2 MOV', shieldman: '+2 DEF, +2 HP',
      rook: '+2 ATK, +2 DEF', knight: '+2 ATK, +2 HP',
      bishop: '+2 HP, HEL 3:4 4:2', queen: '+1 MOV, +2 HP', king: '+2 MOV, ATK 2:20',
    };
    const row = (): HTMLElement => fixture.nativeElement.querySelector('.veterancy-row');
    for (const [id, description] of Object.entries(descriptions)) {
      for (const vet of [0, 1, 3]) {
        const hp = unitStats(id, g.config, vet).hp;
        g.boardState['0,0'] = { unit_id: id, color: 'white', uid: `veteran-${id}`, hp, max_hp: hp, vet };
        ws.sendMessage({ type: 'request_game_state' }); settle(); hex('0,0');
        expect(row().textContent).withContext(`${id}, vet ${vet}`).toContain(description);
        expect(row().textContent).toContain(vet ? 'Active:' : 'Not active:');
        expect(row().classList.contains('active')).toBe(vet >= 1);
      }
    }
    click('.stats-panel .unit-ability-row button', 'Capture');
    expect(row().textContent).toContain(descriptions['king']);
    hex('-1,0'); expect(row().textContent).toContain(descriptions['pawn']);
    expect(room.unitAbilityFocus).toBeNull();
    g.turnNumber = 55; g.phaseBank = { '1': { white: 0, black: 0 }, '2': { white: 0, black: 0 } };
    ws.sendMessage({ type: 'request_game_state' }); settle();
    writeStore('local', 'cpp.localGame.v1', JSON.stringify(g)); reload(); hex('0,0');
    expect(row().textContent).toContain(descriptions['king']);
    expect(row().classList.contains('active')).toBeTrue();
    room.onHexSelected(null); room.onHexHovered(null); settle();
    expect(row().textContent).toContain('Not active:');
    expect(row().textContent).not.toContain(descriptions['king']);
  }));

  it('closes passive and active details when selecting another unit and keeps Use pinned while hovering', run(() => {
    seed('pawn'); hex('0,0');
    click('.stats-panel .unit-ability-row button', 'Checkmate');
    hex('-1,0'); expect(room.unitAbilityFocus).toBeNull();
    hex('0,0'); click('.stats-panel .unit-ability-row button', 'Sacrifice');
    const friend = board()!.cells.find(c => c.key === '-1,0')!;
    room.onHexHovered({ ...room.selectedUnit!, key: friend.key, uid: friend.piece!.uid! }); settle();
    expect(room.displayUnit?.uid).toBe('actor');
    hex('-1,0'); expect(room.unitAbilityFocus).toBeNull();
    expect(fixture.nativeElement.querySelector('.stats-panel .ability-detail-actions')).toBeNull();
  }));

  it('closes unit details on the first touch targeting tap without committing healing or an attack', run(() => {
    seed('bishop'); hex('0,0');
    click('.stats-panel .unit-ability-row button', 'Regenerate');
    expect(room.unitAbilityFocus).not.toBeNull();
    (board() as any).lastPointer = 'touch';
    hex('-1,0');
    expect(board()!.armedAttack).toBe('-1,0');
    expect(room.unitAbilityFocus).toBeNull();
    expect(room.stagedBoard).toBeNull();
    expect(state.snapshot.boardState['-1,0'].hp).toBe(5);
  }));

  it('keeps Sap on unavailable shieldman ATK through promotion, commit and reload', run(() => {
    seed('shieldman'); const g = (engine as any).game;
    Object.assign(g.boardState['0,0'], { vet: 1, hp: 32, max_hp: 32 });
    const actor = { ...g.boardState['0,0'] };
    g.moveHistory = [
      { turn: 51, from: '-12,11', to: '11,1', panelMove: true, panel: 'bl', unit: actor, price: 0 },
      { turn: 53, from: '11,1', to: '0,0', entered: true, color: 'white', unit: actor },
      { turn: 54, promotion: actor },
    ];
    ws.sendMessage({ type: 'request_game_state' }); settle(); finish();
    click('.opponent-panel button', 'Warcry'); click('.opponent-panel .pick-btn', 'Pick');
    cast('Sap', 'opponent'); hex('0,0'); finish();
    hex('0,0'); expect(room.statAtk).toBe('—'); expect(room.buffs['actor'].atk).toBe(-8);
    path('Onslaught'); cast('Strengthen'); hex('0,0');
    expect(room.statAtk).toBe('—'); expect(room.buffs['actor'].atk).toBe(-8);
    finish(); reload();
    expect(state.snapshot.boardState['0,0'].vet).toBe(2);
    expect(room.buffs['actor']).toBeUndefined();
  }));

  it('agrees a solo draw through the controls and restores the drawn result without assigning a winner', run(() => {
    start(); click('.draw-btn');
    expect(state.snapshot.endReason).toBe('draw_agreed');
    expect(state.snapshot.winner).toBe('');
    expect(state.snapshot.currentTurn).toBe('');
    reload();
    expect(room.gameOver).toBeTrue();
    expect(state.snapshot.endReason).toBe('draw_agreed');
    expect(state.snapshot.winner).toBe('');
    expect(room.resultBanner).toBe('DRAW');
  }));

});
