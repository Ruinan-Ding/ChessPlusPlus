import recordedMatch from '../../../../../shared/recording/match.json';
import recordedResult from '../../../../../shared/recording/match.json.expected.json';
import { CpuService } from '../../services/cpu.service';
import configuredMatch from '../../services/game-rules-parity.json';
import { ConfigService, DEFAULT_GAME_CONFIG as SHIPPED_GAME_CONFIG } from '../../services/config.service';
import BALANCE_CONFIG from '../../../../../shared/testing/balance-config.json';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { GameRoomComponent } from './game-room.component';
import { GameBoardComponent } from '../game-board/game-board.component';
import { AuthService } from '../../services/auth.service';
import { AudioService } from '../../services/audio.service';
import { PREVIOUS_GAME_CONFIG as DEFAULT_GAME_CONFIG } from '../../services/config.service';
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
    ['session', 'cpp.localGame'], ['session', 'cpp.offline'], ['session', 'cpp.replayActive'],
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

  const configure = (config: any = BALANCE_CONFIG) => {
    TestBed.configureTestingModule({
      imports: [GameRoomComponent],
      providers: [provideRouter([]),
        { provide: ActivatedRoute, useValue: { params: of({ id: 'local' }), queryParams: of({ token: 'local' }) } },
        { provide: AudioService, useValue: { volume: 0, muted: true, playTone: () => {}, playSwoosh: () => {} } },
      ],
    });
    if (config) expect(TestBed.inject(ConfigService).updateConfig(JSON.stringify(config)).valid).toBeTrue();
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
  const start = (color = 'White', config?: any) => {
    configure(config);
    if (config) click('#custom-mode');
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
  const enableReplay = (actions: any[]) => {
    const ui = (room as any).localUiState();
    const file: any = { type: 'chessplusplus-replay', version: 1, config: state.snapshot.config,
      players: { white: 'White', black: 'Black' }, actions };
    ws.replay.session = { file, cursor: 0, branched: false, skipped: [] };
    spyOn(ws.replay, 'save').and.returnValue(Promise.resolve());
    writeStore('session', 'cpp.replayActive', '1');
    engine.openReplay(file.config, 'Flow', ws.captureReplayFrame(ui));
    room.replayReady = true;
    (room as any).replayController.remember(0, ws.captureReplayFrame(ui));
    (room as any).cdr.markForCheck(); settle();
  };
  const seek = (target: number) => {
    let done = false, error: unknown;
    (room as any).replayController.seek(target, false).then(() => done = true).catch((failure: unknown) => { error = failure; done = true; });
    for (let i = 0; i < 60 && !done; i++) { tick(25); flushMicrotasks(); fixture.detectChanges(); }
    expect(error).toBeUndefined(); expect(done).toBeTrue();
  };

  it('excludes kings from Cast targets without charging, then casts a legal enemy through Undo and reload', run(() => {
    const config: any = structuredClone(SHIPPED_GAME_CONFIG);
    config.veterancy.startingRank = 3;
    config.stageRules.opening.unitAbilities = true;
    config.economy.upAtStart = 100;
    config.setup = { white: { '-8,0': 'king', '0,0': 'bishop' },
      black: { '1,0': 'king', '0,1': 'pawn' } };
    start('White', config);
    const arm = () => {
      hex('0,0'); click('.stats-panel .unit-ability-row button', 'Cast');
      expect(fixture.nativeElement.querySelector('.stats-panel').textContent).toContain('Cannot target commanders');
      click('.stats-panel .ability-detail-actions button', 'Use');
    };
    arm();
    const cell = (key: string) => board()!.cells.find(cell => cell.key === key)!;
    expect(board()!.isAbilityTarget(cell('1,0'), 'enemy')).toBeFalse();
    expect(board()!.isAbilityTarget(cell('0,1'), 'enemy')).toBeTrue();
    hex('1,0');
    expect(room.stagedActions.length).toBe(0); expect(room.myUnitPoints).toBe(100);
    expect(state.snapshot.boardState['1,0'].color).toBe('black');
    arm(); hex('0,1');
    expect(room.myUnitPoints).toBe(68); expect(room.stagedBoard!['0,1'].color).toBe('white');
    reload();
    expect(room.stagedBoard!['0,1'].color).toBe('white');
    click('.undo-btn'); expect(room.myUnitPoints).toBe(100);
    arm(); hex('0,1'); finish(); reload();
    expect(state.snapshot.boardState['0,1'].color).toBe('white');
    expect(state.snapshot.boardState['0,1'].owner).toBe('black');
    expect(state.snapshot.boardState['1,0'].color).toBe('black');
  }));

  it('starts the actual shipped preset in the rendered room', run(() => {
    start('White', SHIPPED_GAME_CONFIG);
    expect(state.snapshot.config.units).toEqual(SHIPPED_GAME_CONFIG.units);
    expect(state.snapshot.config.economy).toEqual(SHIPPED_GAME_CONFIG.economy);
    expect(Object.keys(state.snapshot.boardState).length).toBeGreaterThan(0);
    expect(room.canEndTurn).toBeTrue();
  }));

  it('replays a complete real online recording with the same board, phase bank and ending', run(() => {
    start('White', recordedMatch.config);
    enableReplay(recordedMatch.actions);
    seek(recordedMatch.actions.length);
    expect(room.replayCorruptions).toEqual([]);
    expect(room.replayCursor).toBe(recordedMatch.actions.length);
    expect<unknown>(state.snapshot.boardState).toEqual(recordedResult.board);
    expect(state.snapshot.phaseBank).toEqual(recordedResult.phaseBank);
    expect(state.snapshot.turnNumber).toBe(recordedResult.turn);
    expect(state.snapshot.endReason).toBe(recordedResult.endReason);
    expect<string>(state.myColor(state.snapshot.winner)).toBe(recordedResult.winnerColor);
  }));

  it('offers Myself, CPU and an unavailable AI explanation beneath Me', run(() => {
    configure();
    expect(room.opponentKind).toBe('myself');
    click('.ai-choice');
    expect(room.opponentKind).toBe('myself');
    expect(fixture.nativeElement.textContent).toContain('AI opponent is not implemented yet.');
    click('.end-modal button', 'OK');
    room.setOpponent('cpu'); settle();
    expect(fixture.nativeElement.textContent).toContain('CPU Difficulty');
    expect(room.cpuDifficulty).toBe('normal');
  }));

  it('plays CPU commands through solo services and Q retains them for R', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,0': 'king' }, black: { '-8,0': 'king' } };
    configure(config);
    const cpu = TestBed.inject(CpuService);
    spyOn(cpu, 'think').and.returnValue(Promise.resolve([
      { type: 'pick_pair', id: 'warcry' },
      { type: 'make_move', from: '0,0', to: '0,1', more: true },
      { type: 'pass_turn' },
    ]));
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 15; i++) settle();
    tick(3000); settle();
    expect(state.snapshot.turnNumber).toBe(2);
    expect(state.snapshot.boardState['0,1']).toBeDefined();
    expect(room.canEndTurn).withContext(JSON.stringify({recap:room.recapRunning,playback:room.playbackRunning,turn:state.snapshot.currentTurn,user:room.username,cpuLocked:room.cpuTurnLocked,thinking:room.cpuThinking})).toBeTrue();
    expect(ws.replayFile!.actions.map(a => a.command.type)).toEqual(['pick_pair', 'make_move', 'pass_turn']);
    room.rewindTurn(); settle();
    expect(state.snapshot.turnNumber).toBe(1);
    expect(room.cpuManualTurn).toBeTrue();
    expect(cpu.think).toHaveBeenCalledTimes(1);
    room.undoMove(); settle();
    expect(room.stagedBoard?.['0,1']).toBeUndefined();
    expect(state.snapshot.boardState['0,0']).toBeDefined();
  }));

  it('opens native modal dialogs, restores focus and keeps room shortcuts outside them', run(() => {
    configure();
    const trigger = fixture.nativeElement.querySelector('.ai-choice button') as HTMLButtonElement;
    trigger.focus(); click('.ai-choice button');
    let dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog?.open).toBeTrue();
    expect(dialog?.matches(':modal')).toBeTrue();
    expect(dialog?.contains(document.activeElement)).toBeTrue();
    const numbers = room.showHexNumbers;
    dialog?.querySelector('button')?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    expect(room.showHexNumbers).toBe(numbers);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    expect(room.showHexNumbers).toBe(numbers);
    click('dialog button', 'OK');
    expect(document.activeElement).toBe(trigger);
    room.requestReplayBranch(); (room as any).cdr.markForCheck(); settle();
    dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog?.matches(':modal')).toBeTrue();
    expect(dialog?.contains(document.activeElement)).toBeTrue();
    click('dialog button', 'Cancel');
    expect(room.showBranchWarning).toBeFalse();
    expect(document.activeElement).toBe(trigger);
    room.cpuError = 'No server'; (room as any).cdr.markForCheck(); settle();
    dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog?.matches(':modal')).toBeTrue();
    const cancel = new Event('cancel', { cancelable: true });
    dialog?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBeTrue();
    expect(room.cpuError).toBe('No server');
  }));

  it('restores a failed CPU turn and offers retry, lobby and manual continuation', run(() => {
    configure();
    spyOn(TestBed.inject(CpuService), 'think').and.callFake(() => Promise.reject(new Error('No server')));
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 5; i++) settle();
    expect(state.snapshot.turnNumber).toBe(1);
    expect(room.cpuError).toBe('No server');
    expect(fixture.nativeElement.textContent).toContain('Continue as Myself');
    room.continueAsMyself(); settle();
    expect(room.opponentKind).toBe('myself'); expect(room.canEndTurn).toBeTrue();
    expect(JSON.parse(readStore('local', 'cpp.localGame.v1')!).opponentKind).toBe('myself');
  }));

  it('pauses the CPU clock during an outage and preserves remaining time on manual continuation', run(() => {
    configure(); room.setTurnTimeLimit(15);
    spyOn(TestBed.inject(CpuService), 'think').and.callFake(() => Promise.reject(new Error('Offline')));
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 5; i++) settle();
    const remaining = room.turnSecondsRemaining;
    tick(5000); settle();
    expect(room.turnSecondsRemaining).toBe(remaining);
    room.continueAsMyself(); settle();
    expect(room.turnSecondsRemaining).toBe(remaining);
    tick(2000); settle(); expect(room.turnSecondsRemaining).toBeLessThan(remaining);
  }));

  it('restores the complete turn if a CPU batch becomes illegal while staging', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,0': 'king' }, black: { '-8,0': 'king' } };
    configure(config);
    spyOn(TestBed.inject(CpuService), 'think').and.returnValue(Promise.resolve([
      {type:'pick_pair',id:'warcry'}, {type:'make_move',from:'0,0',to:'0,1',more:true},
      {type:'make_move',from:'0,1',to:'99,99',more:true}, {type:'pass_turn'},
    ]));
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 15; i++) settle();
    expect(room.cpuError).toBeTruthy(); expect(state.snapshot.turnNumber).toBe(1);
    expect(state.snapshot.boardState['0,0']).toBeDefined(); expect(room.stagedActions.length).toBe(0);
    expect(room.opponentLoadout.length).toBe(0); expect(ws.replayFile!.actions.length).toBe(0);
  }));

  it('rolls back an accepted panel move when the later CPU commit fails', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,0': 'king', '-12,11': 'pawn' }, black: { '8,0': 'king' } };
    configure(config);
    spyOn(TestBed.inject(CpuService), 'think').and.returnValue(Promise.resolve([
      { type: 'panel_move', from: '-12,11', to: '-12,10' },
      { type: 'make_move', from: '0,0', to: '0,1', more: true }, { type: 'pass_turn' },
    ]));
    const send = engine.send.bind(engine);
    let panelCommitted = false;
    spyOn(engine, 'send').and.callFake(message => {
      if (message.type === 'make_move') {
        return send({ ...message, to: '99,99' });
      }
      const accepted = send(message);
      if (message.type === 'panel_move') panelCommitted = (engine as any).game.moveHistory.some((move: any) => move.panelMove);
      return accepted;
    });
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 20; i++) settle();
    expect(panelCommitted).toBeTrue(); expect(room.cpuError).toBeTruthy();
    expect(engine.send).not.toHaveBeenCalledWith(jasmine.objectContaining({ type: 'pass_turn' }));
    expect(state.snapshot.turnNumber).toBe(1); expect(state.snapshot.moveHistory).toEqual([]);
    expect((engine as any).game.moveHistory).toEqual([]);
    expect(ws.replayFile!.actions).toEqual([]); expect(room.stagedActions).toEqual([]);
  }));

  it('cancels a late CPU response after rewinding the human turn', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,0': 'king' }, black: { '-8,0': 'king' } };
    configure(config);
    let respond!: (commands: any[]) => void;
    spyOn(TestBed.inject(CpuService), 'think').and.returnValue(new Promise(resolve => respond = resolve));
    room.setSeatChoice('white'); room.setOpponent('cpu'); room.startGame(); settle();
    room.endTurn(); for (let i = 0; i < 5; i++) settle();
    expect(room.cpuThinking).toBeTrue();
    expect(room.canEndTurn).toBeFalse();
    room.rewindTurn(); settle();
    respond([{ type: 'pass_turn' }]); settle();
    expect(state.snapshot.turnNumber).toBe(1);
    expect(room.cpuManualTurn).toBeTrue();
  }));

  it('allows unit inspection without staging moves while CPU is thinking', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,0': 'king' }, black: { '-8,0': 'king' } };
    configure(config);
    spyOn(TestBed.inject(CpuService), 'think').and.returnValue(new Promise(() => {}));
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 5; i++) settle();
    expect(room.cpuThinking).toBeTrue();
    hex('0,0'); expect(room.selectedUnit?.unitId).toBe('king');
    hex('0,1'); expect(room.stagedActions).toEqual([]);
    expect(state.snapshot.boardState['0,0']).toBeDefined();
  }));

  it('expires a thinking CPU turn and ignores its later response', run(() => {
    configure(); room.setTurnTimeLimit(15);
    let respond!: (commands: any[]) => void;
    spyOn(TestBed.inject(CpuService), 'think').and.returnValue(new Promise(resolve => respond = resolve));
    room.setSeatChoice('black'); room.setOpponent('cpu'); room.startGame();
    for (let i = 0; i < 5; i++) settle();
    expect(room.cpuThinking).toBeTrue(); expect(room.canEndTurn).toBeFalse();
    tick(16000); for (let i = 0; i < 5; i++) settle();
    expect(state.snapshot.turnNumber).toBe(2); expect(room.cpuThinking).toBeFalse();
    respond([{ type: 'pick_pair', id: 'warcry' }, { type: 'pass_turn' }]); settle();
    expect(state.snapshot.turnNumber).toBe(2); expect(room.opponentLoadout).toEqual([]);
    expect(ws.replayFile!.actions.map(action => action.command.type)).toEqual(['pass_turn']);
  }));

  it('records each accepted solo input and truncates abandoned turns on Q', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config); hex('0,0'); hex('1,0'); hex('2,0'); finish();
    const tape = ws.replayFile!.actions;
    expect(tape.map(a => a.command.type)).toEqual(['make_move', 'make_move', 'pass_turn']);
    expect(tape[1].command.from).toBe('1,0');
    click('.draw-btn');
    expect(ws.replayFile!.actions).toEqual([]);
    room.undoMove(); settle(); finish();
    expect(ws.replayFile!.actions.map(a => a.command.to)).toEqual(['1,0', undefined]);
  }));

  it('validates playback, branches at completed staging, disables forwards and permits R', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    const normal = localStorage.getItem('cpp.localGame.v1');
    enableReplay([
      { ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', more: true } },
      { ply: 1, color: 'white', command: { type: 'pass_turn' } },
    ]);
    expect(room.canEndTurn).toBeFalse(); seek(1);
    expect(room.stagedBoard!['1,0'].unit_id).toBe('pawn'); expect(room.replayError).toBe('');
    room.confirmReplayBranch(); settle();
    expect(room.replayForwardEnabled).toBeFalse(); expect(room.canUndo).toBeTrue();
    room.undoMove(); settle(); expect(room.stagedBoard).toBeNull();
    expect(ws.replay.session!.file.actions.length).toBe(2);
    expect(localStorage.getItem('cpp.localGame.v1')).toBe(normal);
  }));

  it('navigates replay steps and completed turns through the controls, pauses autoplay and edits a branch', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king', '4,0': 'pawn' } };
    start('White', config);
    enableReplay([
      { ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', more: true } },
      { ply: 1, color: 'white', command: { type: 'make_move', from: '1,0', to: '2,0', more: true } },
      { ply: 1, color: 'white', command: { type: 'pass_turn' } },
      { ply: 2, color: 'black', command: { type: 'make_move', from: '4,0', to: '3,0', more: true } },
      { ply: 2, color: 'black', command: { type: 'pass_turn' } },
    ]);
    expect(fixture.nativeElement.querySelector('[aria-label="Previous step"]').disabled).toBeTrue();
    click('[aria-label="Next step"]');
    expect(room.replayCursor).toBe(1); expect(room.stagedBoard!['1,0'].uid).toBe('w0,0');
    click('[aria-label="Next turn"]');
    expect(room.replayCursor).toBe(2); expect(state.snapshot.turnNumber).toBe(1);
    expect(room.stagedBoard!['2,0'].uid).toBe('w0,0');
    click('[aria-label="Next turn"]');
    expect(room.replayCursor).toBe(4); expect(state.snapshot.turnNumber).toBe(2);
    expect(room.stagedBoard!['3,0'].uid).toBe('b4,0');
    click('[aria-label="Previous turn"]');
    expect(room.replayCursor).toBe(2); expect(state.snapshot.turnNumber).toBe(1);
    click('[aria-label="Previous step"]');
    expect(room.replayCursor).toBe(1);
    click('[aria-label="Autoplay replay"]');
    expect(room.replayPlaying).toBeTrue(); expect(room.replayCursor).toBe(2);
    click('[aria-label="Pause replay"]'); tick(150); settle();
    expect(room.replayPlaying).toBeFalse(); expect(room.replayCursor).toBe(2);
    click('.replay-controls button', 'Branch here');
    expect(room.showBranchWarning).toBeTrue();
    click('dialog button', 'Branch here');
    for (const label of ['Next step', 'Next turn', 'Autoplay replay']) {
      expect(fixture.nativeElement.querySelector(`[aria-label="${label}"]`).disabled).withContext(label).toBeTrue();
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })); settle();
    expect(room.stagedActions.length).toBe(1); expect(room.stagedBoard!['1,0'].uid).toBe('w0,0');
    expect(ws.replay.session!.branchActions?.length).toBe(1);
    finish();
    expect(state.snapshot.boardState['1,0'].uid).toBe('w0,0');
    expect(ws.replay.session!.branchActions?.map(action => action.command.type)).toEqual(['make_move', 'pass_turn']);
    expect(room.replayCorruptions).toEqual([]);
  }));

  it('skips a corrupt compound action atomically and continues with a valid move', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.stageRules.opening.attack = true;
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    enableReplay([
      { ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', attack: '9,0', more: true } },
      { ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '-1,0', more: true } },
      { ply: 1, color: 'white', command: { type: 'pass_turn' } },
    ]);
    seek(2);
    expect(room.replayError).toContain('Move corrupted');
    expect(ws.replay.session!.skipped).toEqual([0]);
    expect(room.stagedBoard!['-1,0'].unit_id).toBe('pawn'); expect(room.stagedBoard!['1,0']).toBeUndefined();
    seek(3); expect(state.snapshot.turnNumber).toBe(2);
    seek(2); expect(state.snapshot.turnNumber).toBe(1); expect(room.stagedActions.length).toBe(1);
  }));

  it('replays a compound walk/attack with its counter as one reversible input', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.stageRules.opening.attack = true;
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king', '2,0': 'pawn' } };
    start('White', config);
    enableReplay([{ ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', attack: '2,0', more: true } }]);
    seek(1);
    expect(room.replayError).toBe('');
    expect(room.stagedActions.length).toBe(2);
    expect(room.stagedBoard!['1,0'].hp).toBeLessThan(12);
    expect(room.stagedBoard!['2,0'].hp).toBeLessThan(12);
    seek(0);
    expect(room.stagedBoard).toBeNull(); expect(state.snapshot.boardState['2,0'].hp).toBe(12);
  }));

  it('validates picks and derives cast costs/effects without imported bonuses', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.stageRules.opening.poolAbilities = true;
    config.economy.pointsAtStart = 500;
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    const points = room.myPoints;
    enableReplay([
      { ply: 1, color: 'white', command: { type: 'pick_pair', id: 'warcry' } },
      { ply: 1, color: 'white', command: { type: 'cast_ability', id: 'warcry', targetUid: 'w0,0', bonuses: { atk: 99 } } },
    ]);
    seek(2);
    expect(room.replayError).toBe('');
    expect(room.myPoints).toBe(points - config.abilities.catalogue.warcry.cost);
    expect(room.buffs['w0,0'].atk).toBe(config.abilities.catalogue.warcry.atk);
    seek(0); expect(room.myLoadout.length).toBe(0); expect(room.myPoints).toBe(points);
  }));

  it('accepts a non-active side resignation and reconstructs a restored viewer from its config', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    enableReplay([{ ply: 1, color: 'black', command: { type: 'result', reason: 'resign' } }]);
    seek(1); expect(room.gameOver).toBeTrue(); expect(state.snapshot.winner).toBe('Flow'); expect(room.replayError).toBe('');
    (room as any).replayController.clear(); seek(0);
    expect(room.gameOver).toBeFalse(); expect(state.snapshot.turnNumber).toBe(1); expect(state.snapshot.boardState['0,0'].hp).toBe(12);
  }));

  it('blocks manual board input during the internal replay executor', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    enableReplay([{ ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', more: true } }]);
    room.replayExecuting = true; room.replayBusy = true; fixture.detectChanges();
    hex('0,0'); hex('1,0'); expect(room.stagedActions.length).toBe(0);
    room.replayBusy = false; room.replayExecuting = false; seek(1);
    expect(room.stagedBoard!['1,0'].unit_id).toBe('pawn'); expect(room.replayError).toBe('');
  }));

  for (const unit of ['pawn', 'archer', 'shieldman', 'rook', 'knight', 'bishop', 'queen', 'king']) {
    it(`replays the ${unit} unit ability through its ordinary targeting rules`, run(() => {
      const config: any = structuredClone(BALANCE_CONFIG);
      config.veterancy.startingRank = 3; config.stageRules.opening.unitAbilities = true;
      config.economy.upAtStart = 500;
      config.setup = { white: { ...(unit === 'king' ? {} : { '-3,6': 'king' }), '0,0': unit, '2,0': 'pawn', '4,0': 'knight' },
        black: { '1,0': 'king' } };
      start('White', config);
      const command: any = { type: 'cast_ability', id: config.units[unit].ability, unitUid: 'w0,0' };
      if (unit === 'pawn') { command.targetUid = 'w2,0'; command.extraUid = 'w4,0'; }
      if (unit === 'bishop') command.targetUid = 'b1,0';
      enableReplay([{ ply: 1, color: 'white', command }]); seek(1);
      expect(room.replayError).toBe(''); expect(room.stagedActions.length).toBe(1);
      expect(room.stagedActions[0].spend?.row).toBe('unit');
      if (unit === 'pawn') expect(room.stagedBoard!['0,0']).toBeUndefined();
      if (unit === 'bishop') expect(room.stagedBoard!['1,0'].color).toBe('white');
      seek(0); expect(room.stagedActions.length).toBe(0); expect(state.snapshot.boardState['0,0'].unit_id).toBe(unit);
    }));
  }

  it('derives panel crossing prices and restores panel actions during step navigation', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.economy.upAtStart = 50; config.economy.wrapPriceMultiplier = 2; config.stageRules.opening.wrap = true;
    config.setup = { white: { '0,11': 'king', '-12,1': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    enableReplay([
      { ply: 1, color: 'white', command: { type: 'panel_move', from: '-12,1', to: '11,1' } },
      { ply: 1, color: 'white', command: { type: 'panel_move', from: '11,1', to: '10,2' } },
    ]);
    seek(2); expect(room.replayError).toBe(''); expect(board()!.pendingPanelSteps.length).toBe(2);
    expect(room.myUnitPoints).toBe(26);
    seek(1); expect(board()!.pendingPanelSteps.length).toBe(1); expect(room.myUnitPoints).toBe(26);
    seek(0); expect(board()!.pendingPanelSteps.length).toBe(0); expect(room.myUnitPoints).toBe(50);
  }));

  it('treats nullable movement options and either half of a Recharge pair consistently', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.match.cpAtStart = 500;
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    enableReplay([
      { ply: 1, color: 'white', command: { type: 'pick_pair', id: 'warcry' } },
      { ply: 1, color: 'white', command: { type: 'pick_path', id: 'tempo' } },
      { ply: 1, color: 'white', command: { type: 'cast_ability', id: 'recharge', pairId: 'sap' } },
      { ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', attack: null, heal: null, withdraw: false } },
    ]);
    seek(4); expect(room.replayError).toBe('');
    expect(room.stagedBoard!['1,0'].unit_id).toBe('pawn');
    expect(ws.replay.session!.file.actions[2].command.pairId).toBe('sap');
    expect(ws.replay.session!.file.actions[3].command.attack).toBeNull();
  }));

  it('rolls back an expensive replay step instead of retaining its partial position', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    enableReplay([{ ply: 1, color: 'white', command: { type: 'make_move', from: '0,0', to: '1,0', more: true } }]);
    const capture = ws.captureReplayFrame.bind(ws);
    spyOn(ws, 'captureReplayFrame').and.callFake(ui => {
      const frame = capture(ui);
      if (room.stagedActions.length) frame.ui.gameRoomMessages = [{ content: 'x'.repeat(5 * 1024 * 1024) }];
      return frame;
    });
    seek(1);
    expect(room.replayError).toContain('processing limit');
    expect(room.stagedBoard).toBeNull(); expect(state.snapshot.boardState['0,0'].unit_id).toBe('pawn');
    expect(ws.replay.session!.skipped).toEqual([0]);
  }));

  it('bounds replay frame caching by size and shares the validated config with snapshots', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config); enableReplay([]);
    const base = ws.captureReplayFrame((room as any).localUiState());
    for (let i = 1; i <= 6; i++) (room as any).replayController.remember(i, { core: base.core,
      ui: { ...base.ui, gameRoomMessages: [{ content: 'x'.repeat(2 * 1024 * 1024) }] } });
    expect((room as any).replayController.frames.size).toBeLessThan(6);
    expect((room as any).replayController.cacheSize).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect((room as any).replayController.frames.get(0).core.config).toBeUndefined();
  }));

  const reload = () => {
    const before = structuredClone(state.snapshot);
    fixture.destroy(); ws.disconnect(); TestBed.resetTestingModule();
    configure();
    expect(state.snapshot.turnNumber).toBe(before.turnNumber);
    expect(state.snapshot.boardState).toEqual(before.boardState);
    expect(state.snapshot.moveHistory).toEqual(before.moveHistory);
  };
  const seed = (id: string, color: 'white' | 'black' = 'white', enemyKey = '1,0', cp = 200, baseConfig: any = DEFAULT_GAME_CONFIG) => {
    start(color === 'white' ? 'White' : 'Black');
    const config: any = structuredClone(baseConfig);
    if (config.rules) { config.rules.upAtStart = 100; config.rules.cpAtStart = cp - 3 * config.rules.cpPhaseOffset; }
    else { config.economy.upAtStart = 100; config.match.cpAtStart = cp - config.match.phases.slice(0, 2).reduce((sum: number, phase: any) => sum + phase.cpAward, 0); }
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
  const useUnit = (name: string, key = '0,0') => {
    hex(key); click('.stats-panel .unit-ability-row button', name);
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

  it('Onslaught boosts normal healing and its HEL display through commit and reload', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.match.cpAtStart = 1000; config.stageRules.opening.normalHeal = true;
    config.setup = { white: { '0,11': 'king', '0,0': 'bishop', '1,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config); path('Onslaught');
    const g = (engine as any).game; g.boardState['1,0'].hp = 1;
    writeStore('local', 'cpp.localGame.v1', JSON.stringify(g)); ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('0,0'); expect(room.statHel).toBe('1:10/8 2:8/6'); hex('1,0');
    expect(room.stagedBoard!['1,0'].hp).toBe(11); finish();
    expect(state.snapshot.moveHistory.find(move => move.healedHex)?.healed_amount).toBe(10);
    reload(); expect(state.snapshot.boardState['1,0'].hp).toBe(11); expect(room.myCp).toBe(950);
  }));

  it('Onslaught adds attack damage but does not boost the same unit counter on the next turn', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.match.cpAtStart = 1000; config.stageRules.opening.attack = true;
    config.setup = { white: { '0,11': 'king', '0,0': 'pawn' }, black: { '0,-11': 'king', '1,0': 'pawn' } };
    start('White', config); path('Onslaught');
    hex('0,0'); expect(room.statAtk).toBe('1:8/6'); hex('1,0');
    expect([room.stagedBoard!['0,0'].hp, room.stagedBoard!['1,0'].hp]).toEqual([10, 8]); finish();
    hex('1,0'); hex('0,0');
    expect([room.stagedBoard!['0,0'].hp, room.stagedBoard!['1,0'].hp]).toEqual([8, 6]); finish(); reload();
    expect([state.snapshot.boardState['0,0'].hp, state.snapshot.boardState['1,0'].hp]).toEqual([8, 6]);
  }));

  it('stages a Vet-3 home refund and reset, restores stars with R, and preserves the committed reset after reload', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.veterancy.startingRank = 3; config.veterancy.kitZones = ['battlefield', 'base'];
    config.panels.baseHealPerTurn = 0;
    config.setup = { white: { '0,11': 'king', '-11,11': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config);
    const g = (engine as any).game; g.boardState['-11,11'].hp = 5;
    writeStore('local', 'cpp.localGame.v1', JSON.stringify(g)); ws.sendMessage({ type: 'request_game_state' }); settle();
    hex('-11,11'); expect(board()!.refundTargets.get('-12,11')).toBe(36); hex('-12,11');
    let home = board()!.cells.find(cell => cell.key === '-12,11')!.piece!;
    expect([home.vet, home.hp, home.max_hp]).toEqual([0, 5, 12]); expect(room.myUnitPoints).toBe(46);
    hex('-12,11'); expect(room.statVet).toBe('—');
    click('.undo-btn');
    expect(board()!.cells.find(cell => cell.key === '-11,11')!.piece!.vet).toBe(3);
    expect(room.myUnitPoints).toBe(10);
    hex('-11,11'); hex('-12,11'); reload();
    expect(room.myUnitPoints).toBe(46);
    home = board()!.cells.find(cell => cell.key === '-12,11')!.piece!;
    expect([home.vet, home.hp, home.max_hp]).toEqual([0, 5, 12]);
    finish();
    const move: any = state.snapshot.moveHistory.find(record => record.withdrawn)!;
    expect([move.refund, move.unit.vet, move.veterancyReset]).toEqual([36, 0, true]);
    reload();
    home = board()!.cells.find(cell => cell.key === '-12,11')!.piece!;
    expect([home.vet, home.hp, home.max_hp]).toEqual([0, 5, 12]); expect(room.myUnitPoints).toBe(46);
    hex('-12,11'); expect(room.statVet).toBe('—');
  }));

  it('shows and spends Sprint-discounted pool, UP and CP prices, restores them with Undo, and boosts base MOV', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.veterancy.startingRank = 3;
    config.stageRules.opening.poolAbilities = true;
    config.stageRules.opening.unitAbilities = true;
    config.economy.upAtStart = 1000; config.economy.pointsAtStart = 1000; config.match.cpAtStart = 1000;
    config.setup = { white: { '0,11': 'king', '0,0': 'bishop', '-12,11': 'pawn', '-1,0': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config); path('Sprint');
    expect(room.myCp).toBe(900);
    hex('-12,11'); expect(room.statMov).toBe('11/6');
    const warcry = room.slotOfAbility('warcry'), recharge = room.slotOfAbility('recharge'), call = room.slotOfAbility('king-call');
    expect(room.abilityLabel(warcry, 0)).toContain('22');
    expect(room.abilityLabel(recharge, 0)).toContain('22');
    expect((room as any).abilityCost(call)).toBe(1);
    click('.abilities-panel .panel-buttons button', 'Warcry');
    click('.abilities-panel .pick-btn', 'Pick');
    const points = room.myPoints; cast('Warcry'); hex('-1,0');
    expect(room.myPoints).toBe(points - 22); click('.undo-btn'); expect(room.myPoints).toBe(points);
    const cp = room.myCp; cast('Recharge'); click('.abilities-panel .panel-buttons button', 'Warcry');
    expect(room.myCp).toBe(cp - 22); click('.undo-btn'); expect(room.myCp).toBe(cp);
    hex('0,0'); click('.stats-panel .unit-ability-row button', 'Cast');
    const castLabel = [...fixture.nativeElement.querySelectorAll('.stats-panel .unit-ability-row button')]
      .find((button: any) => button.textContent.trim().startsWith('Cast')) as HTMLElement;
    expect(castLabel.textContent).toContain('29');
    hex('0,11'); click('.stats-panel .unit-ability-row button', 'Call');
    click('.stats-panel .ability-detail-actions button', 'Use');
    expect(room.myUnitPoints).toBe(999);
    finish(); reload(); expect(room.myCp).toBe(900);
    expect(room.myUnitPoints).toBe(999);
    expect((room as any).abilityCost(warcry)).toBe(22);
  }));

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

  it('rewinds Black Turn 2 to White Turn 2, discards a draft and restores opening actions and timer', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);config.match.turnTimeLimit=15;
    config.setup={white:{'0,11':'king','0,0':'pawn'},black:{'0,-11':'king','4,0':'pawn','5,0':'pawn'}};
    start('Black',config);
    expect(fixture.nativeElement.querySelector('.draw-btn').textContent.trim()).toBe('Rewind Turn (Q)');
    expect(fixture.nativeElement.querySelector('.draw-btn').disabled).toBeTrue();
    hex('0,0');hex('1,0');finish();hex('4,0');hex('3,0');finish();finish();
    expect(state.snapshot.turnNumber).toBe(4);
    hex('5,0');hex('4,0');expect(room.stagedBoard!['4,0'].uid).toBe('b5,0');tick(4000);settle();
    room.windowFocused=true;room.chatFocused=false;
    room.replayTurn();expect(room.manualReplayRunning).toBeTrue();
    room.onPlaybackStep({kind:'pick',from:'',to:'',index:0,side:'mine'});expect(room.castingIndex).toBe(0);
    room.onShortcut(new KeyboardEvent('keydown',{key:'q'}));settle();
    expect(room.manualReplayRunning).toBeFalse();
    expect([room.castingIndex,room.castingSide,room.castingPick,room.castingBrief]).toEqual([null,null,false,false]);
    expect(state.snapshot.turnNumber).toBe(3);expect(state.snapshot.currentTurn).toBe('Opponent');
    expect(room.stagedBoard).toBeNull();expect(state.snapshot.boardState['1,0'].uid).toBe('w0,0');
    expect(state.snapshot.boardState['3,0'].uid).toBe('b4,0');expect(state.snapshot.boardState['5,0'].uid).toBe('b5,0');
    expect(state.snapshot.boardState['4,0']).toBeUndefined();expect(room.turnSecondsRemaining).toBe(15);
    reload();click('.draw-btn');expect(state.snapshot.turnNumber).toBe(2);
    expect(room.stagedBoard!['3,0'].uid).toBe('b4,0');
    room.onShortcut(new KeyboardEvent('keydown',{key:'r'}));settle();
    expect(room.stagedBoard).toBeNull();
    hex('4,0');expect(board()!.legalTargets.has('3,0')).toBeTrue();hex('3,0');finish();
    click('.draw-btn');click('.draw-btn');expect(state.snapshot.turnNumber).toBe(1);
    expect(state.snapshot.moveHistory).toEqual([]);expect(room.canRewind).toBeFalse();
  }));

  it('rewinds casts, path purchases, unit stars, panel payments and both income totals together', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.economy.upAtStart=24;config.economy.pointsAtStart=500;config.match.cpAtStart=500;
    config.stageRules.opening.poolAbilities=true;
    config.setup={white:{'0,11':'king','0,0':'pawn','-12,1':'pawn'},black:{'0,-11':'king'}};
    start('White',config);for(let ply=1;ply<7;ply++)finish();
    const before=structuredClone(state.snapshot),balances=[room.myPoints,room.myCp,room.myUnitPoints,room.opponentPoints,room.cpOf('opponent'),room.opponentUnitPoints];
    path('Bastion');cast('Strengthen');hex('0,0');
    click('.abilities-panel .panel-buttons > button','Warcry');click('.abilities-panel .pick-btn','Pick');
    cast('Warcry');hex('0,0');hex('-12,1');hex('11,1');
    const staged=structuredClone(room.stagedActions),spent=[room.myPoints,room.myCp,room.myUnitPoints];
    finish();
    expect(room.myPath).not.toBeNull();expect(room.myLoadout.length).toBe(2);
    expect(state.snapshot.boardState['0,0'].vet).toBe(2);expect(room.myUnitPoints).toBe(12);
    reload();click('.draw-btn');
    expect(state.snapshot.turnNumber).toBe(7);expect(state.snapshot.boardState).toEqual(before.boardState);
    expect(state.snapshot.moveHistory).toEqual(before.moveHistory);expect(state.snapshot.phaseBank).toEqual(before.phaseBank);
    expect(room.stagedActions).toEqual(staged);
    expect([room.myPoints,room.myCp,room.myUnitPoints]).toEqual(spent);
    expect(room.myPath).not.toBeNull();expect(room.myLoadout.length).toBe(2);
    expect(board()!.cells.find(cell=>cell.key==='11,1')!.piece!.uid).toBe('w-12,1');
    expect(board()!.cells.find(cell=>cell.key==='0,0')!.piece!.vet).toBe(2);
    reload();expect(room.canEndTurn).toBeTrue();expect(room.stagedActions).toEqual(staged);
    expect(board()!.pendingPanelSteps.length).toBe(1);expect(room.myUnitPoints).toBe(spent[2]);
    room.windowFocused=true;room.chatFocused=false;
    for(let action=0;action<4;action++){room.onShortcut(new KeyboardEvent('keydown',{key:'r'}));settle();}
    expect(room.stagedActions).toEqual([]);expect(board()!.pendingPanelSteps).toEqual([]);
    expect([room.myPoints,room.myCp,room.myUnitPoints]).toEqual([balances[0],balances[1]-config.abilities.paths.find((path: any) => path.id === 'bastion').cost,balances[2]]);
    expect(room.buffs).toEqual({});expect(room.myCooldowns.every(cd=>cd===0)).toBeTrue();
    expect(room.usesLeft('mine',room.slotOfAbility('strengthen'))).toBe(5);
    expect(board()!.cells.find(cell=>cell.key==='-12,1')!.piece!.uid).toBe('w-12,1');
    expect(board()!.cells.find(cell=>cell.key==='11,1')!.piece).toBeNull();
    expect(board()!.cells.find(cell=>cell.key==='0,0')!.piece!.vet).toBe(1);
    expect(room.gameRoomMessages.map(message=>message.content)).not.toContain('white ended the turn.');
  }));

  it('reopens panel walks and reserve entries with their chronological R Undo stack', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.economy.upAtStart = 24;
    config.setup = { white: { '0,11': 'king', '-12,1': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config); for (let ply = 1; ply < 7; ply++) finish();
    hex('-12,1'); hex('11,1'); hex('10,2');
    expect(board()!.pendingPanelSteps.length).toBe(2); finish(); click('.draw-btn');
    expect(state.snapshot.turnNumber).toBe(7); expect(board()!.pendingPanelSteps.length).toBe(2);
    expect(board()!.cells.find(cell => cell.key === '10,2')!.piece!.uid).toBe('w-12,1');
    reload(); expect(board()!.pendingPanelSteps.length).toBe(2);
    room.windowFocused = true; room.chatFocused = false;
    room.onShortcut(new KeyboardEvent('keydown', { key: 'r' })); settle();
    expect(board()!.cells.find(cell => cell.key === '11,1')!.piece!.uid).toBe('w-12,1');
    expect(room.myUnitPoints).toBe(12);
    room.onShortcut(new KeyboardEvent('keydown', { key: 'r' })); settle();
    expect(board()!.cells.find(cell => cell.key === '-12,1')!.piece!.uid).toBe('w-12,1');
    expect(room.myUnitPoints).toBe(24); expect(room.canUndo).toBeFalse();
    const reserve = board()!.cells.find(cell => cell.panel === 'br' && cell.gateway && cell.arrowKind === 'entry')!;
    config.setup.white = { '0,11': 'king', [reserve.key]: 'pawn' };
    expect(TestBed.inject(ConfigService).updateConfig(JSON.stringify(config)).valid).toBeTrue();
    click('.resign-btn'); click('.start-game-btn', 'Restart'); click('.start-game-btn', 'Start');
    const gateway = board()!.cells.find(cell => cell.panel === 'br' && cell.piece?.unit_id === 'pawn')!;
    hex(gateway.key);
    const landing = [...board()!.legalTargets].find(key => !board()!.cells.find(cell => cell.key === key)!.filler)!;
    expect(landing).toBeDefined(); hex(landing); finish(); click('.draw-btn');
    expect(board()!.pendingPanelSteps[0].type).toBe('enter_board');
    expect(board()!.cells.find(cell => cell.key === landing)!.piece!.unit_id).toBe('pawn');
    click('.undo-btn'); expect(board()!.cells.find(cell => cell.key === gateway.key)!.piece!.unit_id).toBe('pawn');
    expect(board()!.cells.find(cell => cell.key === landing)!.piece).toBeNull();
  }));

  it('drops a stale saved panel draft without losing the completed turn available to Q', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king', '-12,1': 'pawn' }, black: { '0,-11': 'king' } };
    start('White', config); hex('-12,1');
    const destination = [...board()!.legalTargets].find(key => board()!.cells.find(cell => cell.key === key)!.panel === 'bl')!;
    expect(destination).toBeDefined(); hex(destination);
    const savedUi = readStore('local', 'cpp.localGame.ui.v2')!;
    finish(); writeStore('local', 'cpp.localGame.ui.v2', savedUi); reload();
    expect(state.snapshot.turnNumber).toBe(2); expect(board()!.pendingPanelSteps).toEqual([]);
    expect(room.canUndo).toBeFalse();
    expect(board()!.cells.find(cell => cell.key === destination)!.piece!.uid).toBe('w-12,1');
    click('.draw-btn'); expect(state.snapshot.turnNumber).toBe(1);
    expect(board()!.pendingPanelSteps.length).toBe(1); click('.undo-btn');
    expect(board()!.cells.find(cell => cell.key === '-12,1')!.piece!.uid).toBe('w-12,1');
    expect(board()!.cells.find(cell => cell.key === destination)!.piece).toBeNull();
  }));

  it('restores a panel casualty when R undoes the reopened cast after reload', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.match.cpAtStart = 500; config.units.pawn.hp = 1;
    config.setup = { white: { '0,11': 'king' }, black: { '0,-11': 'king', '-11,-1': 'pawn' } };
    start('White', config); for (let ply = 1; ply < 7; ply++) finish();
    const victim = board()!.cells.find(cell => cell.key === '-11,-1')!.piece!;
    path('Onslaught'); const cp = room.myCp; cast('Cleave', 'mine', true); hex('-11,-1');
    expect(board()!.cells.find(cell => cell.key === '-11,-1')!.piece).toBeNull();
    finish(); click('.draw-btn'); reload();
    expect(board()!.cells.find(cell => cell.key === '-11,-1')!.piece).toBeNull();
    room.windowFocused = true; room.chatFocused = false;
    room.onShortcut(new KeyboardEvent('keydown', { key: 'r' })); settle();
    expect(board()!.cells.find(cell => cell.key === '-11,-1')!.piece).toEqual(victim);
    expect(room.myCp).toBe(cp); expect(room.usesLeft('mine', room.slotOfAbility('cleave'))).toBe(3);
    expect(room.canUndo).toBeTrue(); click('.undo-btn'); expect(room.myPath).toBeNull();
    expect(room.canUndo).toBeFalse(); finish();
    expect(board()!.cells.find(cell => cell.key === '-11,-1')!.piece).toEqual(victim);
  }));

  it('rewinds the winning attack after reload and allows the restored unit to win again', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);config.stageRules.opening.attack=true;
    config.units.king.hp=1;config.units.king.defense=0;config.units.king.attack=0;
    config.setup={white:{'0,11':'king','0,0':'pawn'},black:{'1,0':'king'}};
    start('White',config);const before=structuredClone(state.snapshot.boardState);
    hex('0,0');expect(board()!.attackTargets.has('1,0')).toBeTrue();
    hex('1,0');expect(room.stagedBoard!['1,0']).toBeUndefined();finish();expect(room.gameOver).toBeTrue();
    reload();expect(fixture.nativeElement.querySelector('.draw-btn').disabled).toBeFalse();click('.draw-btn');
    expect(room.gameOver).toBeFalse();expect(state.snapshot.turnNumber).toBe(1);
    expect(state.snapshot.boardState).toEqual(before);expect(state.snapshot.moveHistory).toEqual([]);
    expect(room.stagedBoard!['1,0']).toBeUndefined();expect(room.canUndo).toBeTrue();
    click('.undo-btn');expect(room.stagedBoard).toBeNull();
    expect(board()!.cells.find(cell=>cell.key==='1,0')!.piece!.unit_id).toBe('king');
    expect(fixture.nativeElement.querySelector('.result-banner')).toBeNull();
    expect(room.canEndTurn).toBeTrue();hex('0,0');hex('1,0');finish();expect(room.gameOver).toBeTrue();
  }));

  it('rewinds across phase awards and halftime without retaining stars, payouts or duplicate grants', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.setup={white:{'0,11':'king','-3,6':'pawn'},black:{'0,-11':'king'}};
    start('White',config);for(let ply=1;ply<6;ply++)finish();
    const beforePhase=structuredClone(state.snapshot.boardState);finish();expect(state.snapshot.boardState['-3,6'].vet).toBe(1);
    click('.draw-btn');expect(state.snapshot.turnNumber).toBe(6);expect(state.snapshot.boardState).toEqual(beforePhase);
    finish();for(let ply=7;ply<16;ply++)finish();
    const before=structuredClone(state.snapshot),balances=[room.myUnitPoints,room.opponentUnitPoints];
    finish();expect(state.snapshot.moveHistory.some((move:any)=>move.halftimeUp)).toBeTrue();
    click('.draw-btn');expect(state.snapshot.turnNumber).toBe(16);
    expect(state.snapshot.moveHistory).toEqual(before.moveHistory);expect(state.snapshot.phaseBank).toEqual(before.phaseBank);
    expect([room.myUnitPoints,room.opponentUnitPoints]).toEqual(balances);
    finish();finish();click('.draw-btn');expect(state.snapshot.turnNumber).toBe(17);
    expect(state.snapshot.moveHistory.filter((move:any)=>move.halftimeUp).length).toBe(1);
  }));

  it('does not turn an older mid-turn purchase or its animation into a turn-start checkpoint', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.stageRules.opening.poolAbilities = true; config.match.cpAtStart = 500;
    start('White', config);
    click('.abilities-panel .panel-buttons > button', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
    const game = (engine as any).game; game.turnCheckpoints = [];
    writeStore('local', 'cpp.localGame.v1', JSON.stringify(game)); reload();
    expect((engine as any).game.turnCheckpoints).toEqual([]);
    ws.sendMessage({ type: 'request_game_state' }); settle();
    expect((engine as any).game.turnCheckpoints).toEqual([]);
    path('Bastion');
    expect((engine as any).game.turnCheckpoints).toEqual([]);
    finish(); expect(room.canRewind).toBeFalse();
    finish(); expect(room.canRewind).toBeTrue(); click('.draw-btn');
    expect(state.snapshot.turnNumber).toBe(2); expect(room.myLoadout.length).toBe(2);
    expect(room.myPath).not.toBeNull(); expect(room.canRewind).toBeFalse();
  }));

  it('refuses rewind when resignation interrupts recap before the new turn checkpoint exists', run(() => {
    start('Black');
    const rendered = board()!;
    (rendered as any).playStep.and.returnValue(new Promise(() => {}));
    click('.end-turn-btn');
    expect(state.snapshot.turnNumber).toBe(2); expect(room.recapRunning).toBeTrue();
    click('.resign-btn');
    expect(room.gameOver).toBeTrue(); room.onPlaybackDone(); settle();
    expect(room.canRewind).toBeFalse();
    room.rewindTurn(); settle(); expect(state.snapshot.turnNumber).toBe(2);
    expect(state.snapshot.endReason).toBe('resign');
  }));

  it('ignores Shift+Q without discarding a staged move', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.setup = { white: { '0,11': 'king' }, black: { '0,-11': 'king', '4,0': 'pawn' } };
    start('Black', config); finish(); hex('4,0'); hex('3,0');
    const actions = structuredClone(room.stagedActions);
    room.windowFocused = true; room.chatFocused = false;
    room.onShortcut(new KeyboardEvent('keydown', { key: 'Q', shiftKey: true })); settle();
    expect(state.snapshot.turnNumber).toBe(2); expect(room.stagedActions).toEqual(actions);
    expect(room.stagedBoard!['3,0'].uid).toBe('b4,0');
  }));

  it('keeps Offer Draw online and ignores Q while typing, using modifiers or holding the key', run(() => {
    start();finish();const ply=state.snapshot.turnNumber;
    room.windowFocused=true;room.chatFocused=false;
    const input=fixture.nativeElement.querySelector('input');input.dispatchEvent(new KeyboardEvent('keydown',{key:'q',bubbles:true}));settle();
    room.onShortcut(new KeyboardEvent('keydown',{key:'q',ctrlKey:true}));
    room.onShortcut(new KeyboardEvent('keydown',{key:'q',repeat:true}));settle();expect(state.snapshot.turnNumber).toBe(ply);
    room.isSinglePlayer=false;(room as any).cdr.markForCheck();fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.draw-btn').textContent.trim()).toBe('Offer Draw');
    room.onShortcut(new KeyboardEvent('keydown',{key:'q'}));settle();expect(state.snapshot.turnNumber).toBe(ply);
  }));

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

  it('Undo reverses pool and CP picks through buttons, R and solo reload', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);config.match.cpAtStart=100;
    start('White',config);
    click('.abilities-panel .scaffold-btn','Warcry');click('.abilities-panel .pick-btn','Pick');
    click('.abilities-panel .path-btn','Bastion');click('.abilities-panel .pick-btn','Pick');
    expect(room.myCp).toBe(95);expect(room.myLoadout.length).toBe(2);
    reload();click('.undo-btn');expect(room.myCp).toBe(100);expect(room.myPath).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}));settle();
    expect(room.myLoadout).toEqual([]);expect(room.poolPairWait('mine')).toBe(0);
    finish();expect(state.snapshot.moveHistory.some((move:any)=>move.abilityChoice)).toBeFalse();
  }));

  it('Leech and move → ability → attack agree with forecast, Undo, commit and reload', run(() => {
    start();const g=(engine as any).game;g.config.units.rook.attack=20;
    Object.assign(g,{turnNumber:7,currentTurn:'Flow',moveHistory:[],phaseBank:{},boardState:{
      '-8,0':{unit_id:'king',color:'white',uid:'wk',hp:60,max_hp:60,vet:3,veterancyHpActive:true},
      '8,0':{unit_id:'king',color:'black',uid:'bk',hp:60,max_hp:60,vet:3,veterancyHpActive:true},
      '0,0':{unit_id:'queen',color:'white',uid:'q',hp:8,max_hp:34,vet:3,veterancyHpActive:true},
      '1,0':{unit_id:'rook',color:'black',uid:'r',hp:24,max_hp:24,vet:3,veterancyHpActive:true}}});
    ws.sendMessage({type:'request_game_state'});settle();
    hex('0,0');hex('0,1');click('.stats-panel .unit-ability-row button','Leech');
    click('.stats-panel .ability-detail-actions button','Use');
    expect(board()!.legalTargets.size).toBe(0);
    expect(board()!.attackTargets.has('1,0')).toBeTrue();
    board()!.onHexHover(board()!.cells.find(cell=>cell.key==='1,0')!);settle();
    expect((board() as any).forecast.attackerHp).toBe(4);
    board()!.onHexHover(null); settle();
    hex('1,0');expect(room.stagedBoard?.['0,1'].hp).toBe(4);
    click('.undo-btn');expect(room.stagedBoard?.['0,1'].hp).toBe(8);
    click('.undo-btn');expect(carries(room.buffs['q'],'leech')).toBeFalse();
    expect(board()!.legalTargets.size).toBeGreaterThan(0);
    expect(room.selectedUnit?.uid).toBe('q');
    click('.stats-panel .unit-ability-row button','Leech');click('.stats-panel .ability-detail-actions button','Use');
    hex('1,0');finish();
    expect(state.snapshot.boardState['0,1'].hp).toBe(4);
    expect(state.snapshot.moveHistory.find((move:any)=>move.attacked)?.leech_heal).toBe(8);
    reload();expect(state.snapshot.boardState['0,1'].hp).toBe(4);
  }));

  it('legacy Withdraw permits remaining movement only after attacking', run(() => {
    start();const g=(engine as any).game;g.config=structuredClone(g.config);delete g.config.abilities.catalogue.quick.freeOrder;Object.assign(g,{turnNumber:7,currentTurn:'Flow',moveHistory:[],phaseBank:{},boardState:{
      '-8,0':{unit_id:'king',color:'white',uid:'wk',hp:60,max_hp:60,vet:3,veterancyHpActive:true},
      '8,0':{unit_id:'king',color:'black',uid:'bk',hp:60,max_hp:60,vet:3,veterancyHpActive:true},
      '0,0':{unit_id:'archer',color:'white',uid:'a',hp:6,max_hp:6,vet:3,veterancyHpActive:true},
      '3,0':{unit_id:'pawn',color:'black',uid:'p',hp:12,max_hp:12,vet:0,veterancyHpActive:false}}});
    ws.sendMessage({type:'request_game_state'});settle();hex('0,0');
    expect(fixture.nativeElement.querySelector('.stats-panel .passive-row').textContent).toContain('Withdraw');
    click('.stats-panel .unit-ability-row button','Snare');click('.stats-panel .ability-detail-actions button','Use');
    expect(board()!.legalTargets.size).toBe(0);
    expect(room.buffs['a'].mov).toBe(0);hex('3,0');
    expect(board()!.legalTargets.has('0,6')).toBeTrue();
    expect(room.buffs['p'].mov).toBe(-4);
    expect(room.displayUnitAbilityReady).toBeFalse();
    hex('0,6');finish();expect(state.snapshot.boardState['0,6'].uid).toBe('a');
    reload();expect(state.snapshot.boardState['0,6'].uid).toBe('a');
  }));

  it('waits three full turns for the second pair through rendered picks, End Turn and reload', run(() => {
    start(); click('.abilities-panel .scaffold-btn', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
    click('.abilities-panel .scaffold-btn', 'Bulwark');
    expect(room.focusedAbilityBlocker).toContain('Turn 4');
    expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
    reload(); expect(room.poolPairWait('mine')).toBe(3);
    for (let ply = 1; ply <= 6; ply++) finish();
    expect(state.snapshot.turnNumber).toBe(7);
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
        cast('Strengthen', mine ? 'mine' : 'opponent'); hex(mine ? '-4,8' : '7,-2');
        expect(mine ? room.myCp : room.cpOf('opponent')).toBe(cp - 25);
        expect(mine ? room.myPoints : room.opponentPoints).toBe(points);
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

  for (const color of ['white', 'black'] as const) {
    it(`a different battlefield unit ability closes the previous mover for ${color} until R Undo`, run(() => {
      seed('knight', color, '0,2');
      (engine as any).game.turnNumber = color === 'white' ? 89 : 90;
      ws.sendMessage({ type: 'request_game_state' }); settle();
      hex('-1,0'); hex('-1,1');
      const before = structuredClone(room.stagedBoard);
      useUnit('Charge');
      expect(room.endedUnitIds).toContain('friend');
      hex('-1,1'); hex('-2,1');
      expect(room.stagedBoard).toEqual(before);
      expect(room.endedUnitIds).toContain('friend');
      click('.undo-btn');
      expect(room.endedUnitIds).not.toContain('friend');
      hex('-1,1'); hex('-2,1');
      expect(room.stagedBoard!['-2,1']?.uid).toBe('friend');
      expect(room.stagedBoard!['-1,1']).toBeUndefined();
      finish(); expect(state.snapshot.boardState['-2,1']?.uid).toBe('friend');
    }));
  }

  for (const color of ['white', 'black'] as const) {
    it(`Sacrifice grants a general battlefield slot for ${color} with Undo, commit and expiry`, run(() => {
      seed('pawn', color, '0,1');
      const g = (engine as any).game;
      g.config = structuredClone(g.config);
      g.config.abilities.catalogue['unit-sacrifice'] = structuredClone(BALANCE_CONFIG.abilities.catalogue['unit-sacrifice']);
      ws.sendMessage({ type: 'request_game_state' }); settle();
      useUnit('Sacrifice'); hex('-1,0');
      expect(room.battlefieldActionBonus).toBe(1);
      expect(room.extraActionUids).toEqual([]);
      expect((room as any).pendingSacrificeAction).toBeUndefined();
      click('.undo-btn');
      expect(room.battlefieldActionBonus).toBe(0);
      expect(room.myUnitPoints).toBe(100);
      useUnit('Sacrifice'); hex('-1,0');
      const king = color === 'white' ? '-8,0' : '8,0';
      const kingTo = color === 'white' ? '-7,0' : '7,0';
      hex(king); hex(kingTo); hex('-1,0'); hex('-1,1');
      expect(room.unitActionsSpent).toBe(2);
      expect(room.canMoveOnBoard).toBeTrue();
      expect(room.stagedBoard!['-1,1']).toBeUndefined();
      click('.undo-btn'); hex('-1,0'); hex('-1,1');
      finish();
      expect(state.snapshot.boardState[king]?.unit_id).toBe('king');
      expect(state.snapshot.boardState['-1,1']?.uid).toBe('friend');
      expect(room.battlefieldActionBonus).toBe(0);
      expect(state.snapshot.moveHistory.filter(move => (move as any).battlefieldActions).length).toBe(1);
      reload(); expect(room.battlefieldActionBonus).toBe(0);
      expect(room.myUnitPoints).toBe(76);
    }));
  }

  for (const color of ['white', 'black'] as const) for (const buffedActor of [true, false]) {
    it(`Sacrifice grants one unused extra actor for ${color}, commits two actions and reloads`, run(() => {
      seed('pawn', color, '0,1');
      (engine as any).game.turnNumber = color === 'white' ? 89 : 90;
      ws.sendMessage({ type: 'request_game_state' }); settle();
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
      expect(room.unitActionsSpent).toBe(2);
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

  for (const color of ['white', 'black'] as const) {
    it(`opposing Charge gives four replay strikes and restores second-counter casualties for ${color}`, run(() => {
      seed('knight', color);
      const game = (engine as any).game;
      game.config = structuredClone(game.config);
      game.config.abilities.catalogue['knight-charge'] = structuredClone(BALANCE_CONFIG.abilities.catalogue['knight-charge']);
      game.boardState['0,0'].hp = 10;
      game.boardState['1,0'] = { unit_id: 'knight', color: color === 'white' ? 'black' : 'white', uid: 'enemy', vet: 3, hp: 20, max_hp: 20, veterancyHpActive: true };
      ws.sendMessage({ type: 'request_game_state' }); settle();
      finish(); useUnit('Charge', '1,0'); finish();
      useUnit('Charge'); hex('1,0');
      expect(room.playback.map((step: any) => step.kind)).toEqual(['attack', 'counter', 'attack', 'counter']);
      expect(room.stagedBoard?.['0,0']).toBeUndefined();
      expect(room.stagedBoard?.['1,0'].hp).toBe(4);
      click('.undo-btn'); expect(room.stagedBoard?.['0,0'].hp).toBe(10);
      hex('0,0'); hex('1,0'); finish();
      const record: any = state.snapshot.moveHistory.find(move => move.attacked);
      expect(record).toEqual(jasmine.objectContaining({ secondCounter: true, counter_damage: 16, second_counter_damage: 8, attacker_eliminated: true }));
      reload(); expect(state.snapshot.boardState['0,0']).toBeUndefined();
      const replayed: any[] = [];
      board()!.playbackStep.subscribe(step => replayed.push(step));
      click('.view-controls button', 'Replay');
      const combat = replayed.filter(step => step.kind === 'attack' || step.kind === 'counter');
      expect(combat.map(step => step.kind)).toEqual(['attack', 'counter', 'attack', 'counter']);
      expect(combat.map(step => step.actor?.uid)).toEqual(['actor', 'enemy', 'actor', 'enemy']);
    }));

    it(`Archer interleaves move, attack, move, cast, move for ${color} with Undo and reload`, run(() => {
      seed('archer', color, '3,0');
      const game = (engine as any).game;
      game.config = structuredClone(game.config);
      game.config.abilities.catalogue.quick = structuredClone(BALANCE_CONFIG.abilities.catalogue.quick);
      game.boardState['3,0'].vet = 0; game.boardState['3,0'].hp = game.boardState['3,0'].max_hp = 12;
      ws.sendMessage({ type: 'request_game_state' }); settle();
      hex('0,0'); hex('0,1'); hex('3,0'); hex('0,2');
      useUnit('Snare', '0,2');
      expect(room.displayUnitAbilityReady).toBeFalse();
      expect(room.buffs['enemy']).toBeUndefined();
      hex('0,3'); expect(room.stagedBoard?.['0,3'].uid).toBe('actor');
      expect(room.unitActionsSpent).toBe(1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })); settle();
      expect(room.stagedBoard?.['0,2'].uid).toBe('actor');
      hex('0,2'); hex('0,3');
      expect(room.stagedBoard?.['0,3']?.uid).withContext(JSON.stringify({selected:room.selectedUnit,targets:[...board()!.legalTargets]})).toBe('actor');
      const commands = (room as any).turnCommands(); finish();
      expect(state.snapshot.boardState['0,3']?.uid).withContext(JSON.stringify({commands,history:state.snapshot.moveHistory,error:(room as any).localCommitError})).toBe('actor');
      expect(state.snapshot.boardState['3,0'].hp).toBe(11);
      reload(); expect(state.snapshot.boardState['0,3']?.uid).toBe('actor');
      expect(room.buffs['enemy']).toBeUndefined();
    }));
  }

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

  for (const color of ['white', 'black'] as const) {
    it(`Convert funds a same-turn ${color} Initialization wrap through Undo, commit and reload`, run(() => {
      const config: any = structuredClone(BALANCE_CONFIG);
      config.match.cpAtStart = 500; config.match.turnTimeLimit = 0;
      const source = color === 'white' ? '-12,1' : '12,-1', destination = color === 'white' ? '11,1' : '-11,-1';
      config.setup = { white: { '-8,0': 'king' }, black: { '8,0': 'king' } };
      config.setup[color][source] = 'pawn';
      start(color === 'white' ? 'White' : 'Black', config);
      if (color === 'black') finish();
      path('Onslaught'); cast('Convert'); hex(source); hex(destination);
      expect(room.myUnitPoints).toBe(48); expect(board()!.pendingPanelSteps.length).toBe(1);
      click('.undo-btn'); expect(room.myUnitPoints).toBe(60);
      click('.undo-btn'); expect(room.myUnitPoints).toBe(10);
      cast('Convert'); hex(source); hex(destination); finish(); reload();
      expect(room.myUnitPoints).toBe(48);
      const history: any[] = state.snapshot.moveHistory;
      expect(history.filter(move => move.abilityCast?.up === 50).length).toBe(1);
      expect(history.findIndex(move => move.abilityCast?.up)).toBeLessThan(history.findIndex(move => move.price === 12));
      expect(board()!.cells.find(cell => cell.key === destination)!.piece!.uid).toBe(color[0] + source);
    }));
    it(`Convert grants UP on Onslaught for ${color} through Undo, staging reload and commit`, run(() => {
      const config: any = structuredClone(BALANCE_CONFIG);
      config.match.cpAtStart = 500; config.match.turnTimeLimit = 0;
      start(color === 'white' ? 'White' : 'Black', config);
      if (color === 'black') finish();
      path('Onslaught');
      const points = room.myPoints, cp = room.myCp, up = room.myUnitPoints;
      cast('Convert');
      expect([room.myPoints, room.myCp, room.myUnitPoints]).toEqual([points, cp - 25, up + 50]);
      expect(room.abilityHint(room.slotOfAbility('convert'))).toContain('+50 UP');
      reload(); expect(room.myUnitPoints).toBe(up + 50);
      click('.undo-btn'); expect([room.myPoints, room.myCp, room.myUnitPoints]).toEqual([points, cp, up]);
      cast('Convert'); finish();
      expect(room.myUnitPoints).toBe(up + 50);
      expect(state.snapshot.moveHistory.filter((move: any) => move.abilityCast?.up === 50).length).toBe(1);
      reload(); expect(room.myUnitPoints).toBe(up + 50);
    }));
  }

  for (const color of ['white', 'black'] as const) {
    for (const [ability, name, partner, target] of [['mend', 'Mend', 'Strike', '-1,0'], ['weakening', 'Weakening', 'Bulwark', '1,0']]) {
      it(`${color} Recharge pays full point worth for used 1-CD ${name}; Undo, reload and commit preserve cooldowns`, run(() => {
        seed('pawn', color, '1,0', 500, BALANCE_CONFIG); path('Sprint');
        click('.abilities-panel .scaffold-btn', name); click('.abilities-panel .pick-btn', 'Pick');
        const i = room.slotOfAbility(ability), other = room.slotOfAbility(partner.toLowerCase());
        const baseCost = room.abilityCosts[i], price = room.abilityCost(i), points = room.myPoints;
        expect(price).toBe(baseCost - 3);
        expect(room.abilityHint(i)).toContain(`grants ${baseCost} regular points`);
        cast(name); hex(target); expect(room.myCooldowns[i]).toBe(1);
        const cp = room.myCp, payout = baseCost + room.abilityCosts[other];
        cast('Recharge'); click('.abilities-panel .panel-buttons > button', name);
        expect(room.myPoints).toBe(points - price + payout);
        expect([room.myCooldowns[i], room.myCooldowns[other]]).toEqual([1, 0]);
        expect(room.myCp).toBe(cp - 22);
        click('.abilities-panel .panel-buttons > button', name);
        expect((fixture.nativeElement.querySelector('.abilities-panel .pick-btn') as HTMLButtonElement).disabled).toBeTrue();
        reload(); expect(room.myPoints).toBe(points - price + payout);
        click('.undo-btn'); expect(room.myPoints).toBe(points - price); expect(room.myCp).toBe(cp);
        expect([room.myCooldowns[i], room.myCooldowns[other]]).toEqual([1, 0]);
        cast('Recharge'); click('.abilities-panel .panel-buttons > button', partner);
        finish(); reload();
        expect(room.myPoints).toBe(points - price + payout);
        expect(room.myCooldowns[i]).toBe(1);
      }));
    }
    it(`${color} Recharge pays ready members without changing their normal cast price`, run(() => {
      seed('pawn', color, '1,0', 500, BALANCE_CONFIG); path('Sprint');
      click('.abilities-panel .scaffold-btn', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
      const first = room.slotOfAbility('warcry'), second = room.slotOfAbility('sap');
      const points = room.myPoints, payout = room.abilityCosts[first] + room.abilityCosts[second];
      cast('Recharge'); click('.abilities-panel .panel-buttons > button', 'Warcry');
      expect(room.myPoints).toBe(points + payout);
      expect([room.myCooldowns[first], room.myCooldowns[second]]).toEqual([0, 0]);
      cast('Warcry'); hex('-1,0'); expect(room.myPoints).toBe(points + payout - 22);
      click('.undo-btn'); click('.undo-btn'); expect(room.myPoints).toBe(points);
    }));
    it(`${color} Bastion carries Strengthen with its existing promotion and Undo`, run(() => {
      const config = structuredClone(BALANCE_CONFIG);
      config.veterancy.firstPhaseStartAward = false; config.veterancy.postmatchAwards = false;
      seed('pawn', color, '1,0', 500, config); path('Bastion');
      expect(room.abilityPaths.find(p => p.id === 'bastion')!.utility).toBe(room.slotOfAbility('strengthen'));
      const g = (engine as any).game; g.boardState['-1,0'].vet = 0; g.boardState['-1,0'].max_hp = 12;
      g.boardState['-1,0'].veterancyHpActive = false;
      ws.sendMessage({ type: 'request_game_state' }); settle();
      const cp = room.myCp; cast('Strengthen'); hex('-1,0');
      expect(room.stagedBoard?.['-1,0'].vet).toBe(1); expect(room.myCp).toBe(cp - 25);
      click('.undo-btn'); expect(room.myCp).toBe(cp); expect(room.stagedBoard).toBeNull();
      cast('Strengthen'); hex('-1,0'); finish(); reload(); expect(state.snapshot.boardState['-1,0'].vet).toBe(1);
    }));
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

  it('custom Recharge can refresh to zero through rendered controls, Undo and saved-turn reload', run(() => {
    const config: any = structuredClone(BALANCE_CONFIG);
    config.abilities.catalogue.recharge.minimumCooldown = 0;
    config.abilities.catalogue.recharge.recharge = 10;
    seed('pawn', 'white', '1,0', 500, config); path('Sprint');
    click('.abilities-panel button', 'Warcry'); click('.abilities-panel .pick-btn', 'Pick');
    cast('Warcry'); hex('-1,0'); cast('Sap'); hex('1,0');
    const warcry = room.slotOfAbility('warcry'), sap = room.slotOfAbility('sap');
    expect([room.myCooldowns[warcry], room.myCooldowns[sap]]).toEqual([3, 5]);
    cast('Recharge'); click('.abilities-panel .panel-buttons > button', 'Warcry');
    expect([room.myCooldowns[warcry], room.myCooldowns[sap]]).toEqual([0, 0]);
    expect(room.abilityHint(room.slotOfAbility('recharge'))).toContain('stopping at 0');
    reload(); expect([room.myCooldowns[warcry], room.myCooldowns[sap]]).toEqual([0, 0]);
    click('.undo-btn'); expect([room.myCooldowns[warcry], room.myCooldowns[sap]]).toEqual([3, 5]);
    cast('Recharge'); click('.abilities-panel .panel-buttons > button', 'Sap');
    finish(); reload();
    expect([room.myCooldowns[warcry], room.myCooldowns[sap]]).toEqual([0, 0]);
    expect(state.snapshot.config.abilities.catalogue.recharge.minimumCooldown).toBe(0);
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

  it('restores an older solo drawn result without assigning a winner, and can rewind it', run(() => {
    start(); room.offerDraw(); settle();
    expect(state.snapshot.endReason).toBe('draw_agreed');
    expect(state.snapshot.winner).toBe('');
    expect(state.snapshot.currentTurn).toBe('');
    reload();
    expect(room.gameOver).toBeTrue();
    expect(state.snapshot.endReason).toBe('draw_agreed');
    expect(state.snapshot.winner).toBe('');
    expect(room.resultBanner).toBe('DRAW');
    click('.draw-btn');expect(room.gameOver).toBeFalse();expect(state.snapshot.turnNumber).toBe(1);
  }));

  it('keeps wounded enabled panel HP exact through inspection and reload', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.veterancy.startingRank=1;config.veterancy.kitZones=['battlefield','base','reserve'];
    config.panels.baseHealPerTurn=0;
    config.setup={white:{'0,11':'king','-12,11':'pawn','11,1':'pawn'},black:{'0,-11':'king'}};
    start('White',config);
    const g=(engine as any).game;
    g.moveHistory=['-12,11','11,1'].map(at=>({from:'',to:'',turn:1,intoPanel:true,panelEffect:true,
      panel:at==='11,1'?'br':'bl',attackedHex:at,defenderHp:5,
      panelDefender:{unit_id:'pawn',color:'white',uid:`w${at}`,hp:14,max_hp:14,vet:1,veterancyHpActive:true}}));
    writeStore('local','cpp.localGame.v1',JSON.stringify(g));
    ws.sendMessage({type:'request_game_state'});settle();
    for(const at of ['-12,11','11,1']) {
      const unit=board()!.cells.find(cell=>cell.key===at)!.piece!;
      expect([unit.hp,unit.max_hp,unit.veterancyHpActive]).toEqual([5,14,true]);
      hex(at);expect(room.statHp).toBe('5/14');
    }
    reload();
    for(const at of ['-12,11','11,1'])expect(board()!.cells.find(cell=>cell.key===at)!.piece!.hp).toBe(5);
  }));

  it('keeps multiplied wrap payments exact through staging, commit and reload', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.economy.upAtStart=24;config.economy.wrapPriceMultiplier=2;
    config.setup={white:{'0,11':'king','-12,1':'pawn'},black:{'0,-11':'king'}};
    start('White',config);
    for(let ply=1;ply<7;ply++)finish();
    hex('-12,1');expect(board()!.wrapTargets.get('11,1')).toBe(24);hex('11,1');
    expect(room.myUnitPoints).toBe(0);
    finish();
    const crossing=(state.snapshot.moveHistory as any[]).find(move=>move.panelMove)!;
    expect(crossing.price).toBe(24);expect(room.myUnitPoints).toBe(0);
    reload();expect(room.myUnitPoints).toBe(0);
  }));

  it('commits a zero-refund homecoming as a withdrawal, including restored online commands', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.economy.walkHomeRefund={valueMultiplier:1,fee:100,missingHpMultiplier:1,minimum:0};
    config.panels.baseHealPerTurn=0;
    config.setup={white:{'0,11':'king','-11,11':'pawn'},black:{'0,-11':'king'}};
    start('White',config);hex('-11,11');expect(board()!.refundTargets.get('-12,11')).toBe(0);hex('-12,11');
    expect((room as any).onlineTurnCommands()).toContain(jasmine.objectContaining({type:'make_move',withdraw:true}));
    expect(room.myUnitPoints).toBe(10);reload();
    expect((room as any).onlineTurnCommands()).toContain(jasmine.objectContaining({type:'make_move',withdraw:true}));
    finish();
    expect(state.snapshot.boardState['-11,11']).toBeUndefined();
    expect(state.snapshot.moveHistory).toContain(jasmine.objectContaining({withdrawn:true,refund:0}));
    expect(board()!.cells.find(cell=>cell.key==='-12,11')!.piece!.uid).toBe('w-11,11');
    reload();expect(room.myUnitPoints).toBe(10);
  }));

  for(const baseEnabled of [false,true])it(`keeps wounded withdrawal HP when base kits are ${baseEnabled?'enabled':'disabled'}`, run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.veterancy.startingRank=1;config.veterancy.kitZones=baseEnabled?['battlefield','base']:['battlefield'];
    delete config.economy.walkHomeRefund.veterancy; config.economy.walkHomeRefund.resetVeterancy=false;
    config.panels.baseHealPerTurn=0;
    config.setup={white:{'0,11':'king','-11,11':'pawn'},black:{'0,-11':'king'}};
    start('White',config);
    const g=(engine as any).game;g.boardState['-11,11'].hp=5;
    writeStore('local','cpp.localGame.v1',JSON.stringify(g));ws.sendMessage({type:'request_game_state'});settle();
    hex('-11,11');hex('-12,11');
    let unit=board()!.cells.find(cell=>cell.key==='-12,11')!.piece!;
    expect([unit.hp,unit.max_hp,unit.veterancyHpActive]).toEqual([5,baseEnabled?14:12,baseEnabled]);
    finish();
    const withdrawn=state.snapshot.moveHistory.find(move=>move.withdrawn)!.unit!;
    expect([withdrawn.hp,withdrawn.max_hp,withdrawn.veterancyHpActive]).toEqual([5,baseEnabled?14:12,baseEnabled]);
    reload();unit=board()!.cells.find(cell=>cell.key==='-12,11')!.piece!;
    expect([unit.hp,unit.max_hp]).toEqual([5,baseEnabled?14:12]);expect(room.myUnitPoints).toBe(12);
  }));

  it('uses base healing amounts when battlefield veterancy kits are disabled', run(() => {
    const config:any=structuredClone(BALANCE_CONFIG);
    config.veterancy.startingRank=1;config.veterancy.kitZones=[];
    config.stageRules.opening.normalHeal=true;
    config.units.bishop.veterancy.heal=[20,20,20,20];config.units.pawn.hp=30;
    config.setup={white:{'0,11':'king','0,0':'bishop','1,0':'pawn'},black:{'0,-11':'king'}};
    start('White',config);
    const g=(engine as any).game;g.boardState['1,0'].hp=1;
    writeStore('local','cpp.localGame.v1',JSON.stringify(g));ws.sendMessage({type:'request_game_state'});settle();
    hex('0,0');
    const target=board()!.cells.find(cell=>cell.key==='1,0')!;
    const polygon=[...fixture.nativeElement.querySelectorAll('polygon.hex-cell')]
      .find((element:any)=>element.getAttribute('points')===target.points) as Element;
    polygon.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));settle();
    expect((board() as any).forecast.targetHp).toBe(9);
    hex('1,0');expect(room.stagedBoard!['1,0'].hp).toBe(9);
    finish();expect(state.snapshot.boardState['1,0'].hp).toBe(9);
    expect(state.snapshot.moveHistory.find(move=>move.healedHex)!.healed_amount).toBe(8);
    reload();expect(state.snapshot.boardState['1,0'].hp).toBe(9);
  }));

  it('plays a custom two-phase match through the controls, reload and the configured overtime ending', run(() => {
    start('White', configuredMatch.config);
    for (let ply=1; ply<=18; ply++) {
      if (ply===8) {
        const saved=structuredClone(state.snapshot.config);
        reload();
        expect(state.snapshot.config).toEqual(saved);
        expect(state.snapshot.config.ruleset.revision).toBeNull();
      }
      finish();
    }
    expect(state.snapshot.endReason).toBe('overtime');
    expect(state.snapshot.winner).toBe('Flow');
    expect(state.snapshot.phaseBank).toEqual(configuredMatch.bank);
    expect(room.myCp).toBe(33);
    expect(room.myUnitPoints).toBe(39);
    expect(room.opponentUnitPoints).toBe(29);
    expect(fixture.nativeElement.textContent).not.toContain('PHASE 3');
  }));

  it('applies a configured panel aura on the first turn, without waiting for stars', run(() => {
    const config:any=structuredClone(configuredMatch.config);
    config.veterancy.passiveUnlock=0;
    config.veterancy.kitZones=['battlefield','base'];
    config.setup={white:{'0,11':'king','-12,11':'queen','-11,11':'pawn'},black:{'0,-11':'king'}};
    start('White',config);
    expect(room.buffs['w-11,11'].atk).toBe(1);
    expect(room.buffs['w-11,11'].mov).toBe(1);
    reload();
    expect(room.buffs['w-11,11'].atk).toBe(1);
  }));

  it('uses independent stage gates for unit and pool abilities in custom mode', run(() => {
    start();
    const g=(engine as any).game;
    g.config.stageRules.firstHalf.poolAbilities=false;
    g.config.stageRules.firstHalf.unitAbilities=true;
    g.config.economy.upAtStart=100;
    Object.assign(g,{turnNumber:7,currentTurn:'Flow',moveHistory:[],phaseBank:{},boardState:{
      '-8,0':{unit_id:'king',color:'white',uid:'wk',hp:60,max_hp:60,vet:3},
      '8,0':{unit_id:'king',color:'black',uid:'bk',hp:60,max_hp:60,vet:3},
      '0,0':{unit_id:'queen',color:'white',uid:'q',hp:34,max_hp:34,vet:3,veterancyHpActive:true}}});
    ws.sendMessage({type:'request_game_state'});settle();
    room.gameMode='custom';fixture.detectChanges();
    hex('0,0');
    expect(fixture.nativeElement.textContent).not.toContain('Coming soon');
    expect(room.canUseAbilities('mine',0)).toBeFalse();
    click('.stats-panel .unit-ability-row button','Leech');
    expect(room.unitAbilityCanActivate()).toBeTrue();
    click('.stats-panel .ability-detail-actions button','Use');
    expect(carries(room.buffs['q'],'leech')).toBeTrue();
    finish();
    expect(state.snapshot.config.stageRules.firstHalf.poolAbilities).toBeFalse();
  }));

});
