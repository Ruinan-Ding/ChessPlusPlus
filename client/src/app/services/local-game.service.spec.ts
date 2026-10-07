import { stackEffect } from './ability-rules';
import { carries } from './unit-combat';
import { TestBed } from '@angular/core/testing';
import { LocalGameService, LOCAL_OPPONENT } from './local-game.service';
import { unitPoints } from './match-score';
import { unitStats } from './unit-stats';
import { DEFAULT_GAME_CONFIG, ConfigService } from './config.service';

/**
 * The offline engine is the only thing standing between the player and the
 * rules when there is no server, so it gets a check: seats, a legal move, an
 * illegal one, and that the game survives being reloaded from cache.
 */
describe('LocalGameService', () => {
  let service: LocalGameService;
  let replies: any[];

  /** Let queued reply microtasks settle after the sending call. */
  const flush = async () => { await new Promise(r => setTimeout(r, 0)); };

  beforeEach(async () => {
    localStorage.removeItem('cpp.localGame.v1');
    TestBed.configureTestingModule({});
    service = TestBed.inject(LocalGameService);
    replies = [];
    service.messages$.subscribe(m => replies.push(m));
    service.send({ type: 'create_single_player_game', username: 'Solo' });
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
  });

  const last = (type: string) => [...replies].reverse().find(m => m.type === type);
  const unitOf = (unitId: string) => {
    const unit = Object.values(DEFAULT_GAME_CONFIG.units).find(({ id }) => id === unitId);
    if (!unit) throw new Error(`Unknown configured unit ${unitId}`);
    return unit;
  };
  const hpOf = (unitId: string) => unitOf(unitId).hp;
  const valueOf = (unitId: string) => unitOf(unitId).value;
  const fullUnit = (unit_id: string, color: string, uid: string) => ({
    unit_id, color, hp: hpOf(unit_id), max_hp: hpOf(unit_id), uid,
  });

  /**
   * Past every turn given to setting out, where nobody attacks at all.
   *
   * Six plies of passing rather than a turn number written over the cache:
   * the pass is what a real game does to get there, and the specs that need
   * it are about blows, which a setup turn refuses outright. A pass moves
   * nobody, so the board they were written against is the board they get.
   *
   * Six - the opening's three turns and nothing after them. It was eight
   * while Phase 1 opened with an initialization turn of its own, which
   * refused a blow for the same reason; that extra turn is the phase's
   * postmatch now, at its other end, so play starts the moment the opening
   * is over. Ply 7 is turn 4, the first of Phase 1's play.
   */
  const pastOpening = async () => {
    for (let i = 0; i < 6; i++) service.send({ type: 'pass_turn' });
    await flush();
  };

  // The stock unit these tests push about is the pawn on -5,9. The two hexes
  // it has been on before, -9,9 and -7,9, have each in turn been dealt an
  // archer; -5,9 is a pawn on the setup as it stands.

  it('persists Fortress immunity through the opponent turn, prevents the overtime toll and expires next caster turn', async () => {
    const g = (service as any).game;
    Object.assign(g, { turnNumber: 77, currentTurn: 'Solo', moveHistory: [], phaseBank: {} });
    g.boardState = { '-8,0': { ...fullUnit('king', 'white', 'wk'), hp: 1 }, '8,0': fullUnit('king', 'black', 'bk') };
    const protection = stackEffect(undefined, { name: 'Fortress', effect: 'invulnerable', mov: 0, atk: 0, def: 0 }, 'white', false, 79);
    service.send({ type: 'pass_turn', effectsBefore: [{ status: { uid: 'wk', buff: protection } }, { at: '-8,0', uid: 'wk', hp: 0 }] });
    await flush();
    expect(g.boardState['-8,0'].hp).toBe(1); expect(g.turnNumber).toBe(78); expect(last('game_over')).toBeUndefined();
    const restored = new LocalGameService(TestBed.inject(ConfigService)), saved = (restored as any).game;
    expect(carries(saved.abilityBuffs.wk, 'invulnerable')).toBeTrue();
    restored.send({ type: 'pass_turn' }); await flush();
    expect(saved.turnNumber).toBe(79); expect(saved.abilityBuffs.wk).toBeUndefined();
    restored.send({ type: 'pass_turn' }); await flush();
    expect(saved.boardState['-8,0']).toBeUndefined(); expect(saved.endReason).toBe('regicide');
  });

  it('rolls back status changes when their accompanying walk is refused', async () => {
    const g = (service as any).game;
    g.turnNumber = 9; g.currentTurn = 'Solo';
    const before = structuredClone(g.boardState), history = g.moveHistory;
    const lock = stackEffect(undefined, { name: 'Trap', effect: 'action-lock', mov: 0, atk: 0, def: 0 }, 'black', true, 11);
    service.send({ type: 'make_move', from: '20,20', to: '21,20', effectsBefore: [{ status: { uid: 'victim', buff: lock } }] });
    await flush();
    expect(last('invalid_move')).toBeDefined(); expect(g.abilityBuffs).toBeUndefined();
    expect(g.boardState).toEqual(before); expect(g.moveHistory).toBe(history); expect(g.turnNumber).toBe(9);
  });

  it('rejects ordinary moves, healing and unit actions for locked units while permitting their counters', async () => {
    const g = (service as any).game;
    g.turnNumber = 9; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = { '0,0': fullUnit('bishop', 'white', 'own'), '1,0': fullUnit('pawn', 'white', 'ally'),
      '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk') };
    g.abilityBuffs = { own: stackEffect(undefined, { name: 'Blitz', effect: 'action-lock', mov: 0, atk: 0, def: 0 }, 'black', true, 11) };
    for (const action of [{ to: '0,1' }, { to: '0,0', heal: '1,0' }, { to: '0,0', unitAction: true }]) {
      service.send({ type: 'make_move', from: '0,0', ...action }); await flush();
      expect(last('invalid_move').message).toContain('cannot act'); expect(g.turnNumber).toBe(9);
    }
    g.boardState['0,0'] = fullUnit('pawn', 'white', 'own'); g.boardState['1,0'].color = 'black'; g.currentTurn = LOCAL_OPPONENT;
    service.send({ type: 'make_move', from: '1,0', to: '1,0', attack: '0,0' }); await flush();
    expect(last('move_made').move.counter_damage).toBeGreaterThan(0);
  });

  it('locks panel walks, reserve deployments and attacks into panels without spending the turn or UP', async () => {
    const g = (service as any).game;
    Object.assign(g, { turnNumber: 17, currentTurn: 'Solo', moveHistory: [], phaseBank: {} });
    g.boardState = { '-10,0': fullUnit('archer', 'white', 'actor'),
      '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk') };
    const reserve = fullUnit('pawn', 'white', 'reserve');
    const lock = stackEffect(undefined, { name: 'Trap', effect: 'action-lock', mov: 0, atk: 0, def: 0 }, 'black', true, 19);
    g.abilityBuffs = { actor: lock, reserve: lock };
    const board = structuredClone(g.boardState);
    const commands = [
      { type: 'panel_move', from: '11,1', to: '12,1', panel: 'br', cost: 1, unit: reserve },
      { type: 'enter_board', from: '12,1', to: '-10,9', unit: reserve },
      { type: 'panel_attack', from: '-10,0', to: '-10,0', attack: '-12,-1', panel: 'tl',
        unit: fullUnit('pawn', 'black', 'enemy') },
    ];
    for (const command of commands) {
      replies.length = 0;
      service.send(command); await flush();
      expect(last('invalid_move')?.message).withContext(command.type).toContain('cannot act');
      expect(g.boardState).toEqual(board); expect(g.moveHistory).toEqual([]);
      expect(g.turnNumber).toBe(17); expect(g.currentTurn).toBe('Solo');
      expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(10);
    }
    g.abilityBuffs = {};
    for (const command of commands) {
      replies.length = 0;
      service.send(command); await flush();
      expect(last('invalid_move')).withContext(command.type).toBeUndefined();
    }
    expect(g.turnNumber).toBe(18);
    expect(g.boardState['-10,9'].uid).toBe('reserve');
    expect(g.moveHistory.some((move: any) => move.intoPanel && move.attacked)).toBeTrue();
  });

  it('commits HEL modifiers and zero settings without granting healing to non-healers', async () => {
    const g = (service as any).game;
    for (const [bonus, amount] of [[{ hel: 4 }, 10], [{ helSet: 0 }, 0]] as const) {
      Object.assign(g, { turnNumber: 9, currentTurn: 'Solo', moveHistory: [], phaseBank: {} });
      g.boardState = { '0,0': fullUnit('bishop', 'white', 'b'), '2,0': { ...fullUnit('pawn', 'white', 'p'), hp: 1, max_hp: 14, vet: 1 },
        '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk') };
      service.send({ type: 'make_move', from: '0,0', to: '0,0', heal: '2,0', bonuses: { atk: 0, def: 0, targetAtk: 0, targetDef: 0, ...bonus } }); await flush();
      expect(last('move_made').move.healed_amount).toBe(amount); expect(g.boardState['2,0'].hp).toBe(1 + amount);
    }
    g.turnNumber = 9; g.currentTurn = 'Solo'; g.boardState['0,0'] = fullUnit('pawn', 'white', 'b');
    replies.length = 0;
    service.send({ type: 'make_move', from: '0,0', to: '0,0', heal: '2,0', bonuses: { hel: 4 } }); await flush();
    expect(last('invalid_move')).toBeDefined();
  });

  it('records Strengthen current/max HP once and reloads its rank without reapplying the first-star gain', async () => {
    const g = (service as any).game;
    Object.assign(g, { turnNumber: 9, currentTurn: 'Solo', moveHistory: [], phaseBank: {} });
    g.boardState = { '0,0': { ...fullUnit('pawn', 'white', 'p'), hp: 5, vet: 0 },
      '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk') };
    const promotion = { ...g.boardState['0,0'], hp: 7, max_hp: 14, vet: 1 };
    service.send({ type: 'pass_turn', effectsBefore: [{ at: '0,0', uid: 'p', hp: 7, promotion }] }); await flush();
    expect(g.boardState['0,0']).toEqual(promotion);
    const restored = new LocalGameService(TestBed.inject(ConfigService)), saved = (restored as any).game;
    restored.send({ type: 'pass_turn' }); await flush();
    expect(saved.boardState['0,0']).toEqual(promotion);
  });

  it('records UP casts and ability deaths once, without paying a kill reward, through reload', async () => {
    const g = (service as any).game; g.turnNumber = 55; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
      '0,0': { ...fullUnit('pawn', 'white', 'wp'), hp: 14, max_hp: 14, vet: 3 } };
    service.send({ type: 'pass_turn', effectsBefore: [{ castId: 'sacrifice-55', unitCast: { uid: 'wp', id: 'unit-sacrifice', color: 'white', cost: 3, gain: 8 } }, { at: '0,0', uid: 'wp', hp: 0 }] }); await flush();
    expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(15); expect(unitPoints(g.config, g.moveHistory, 'black')).toBe(10);
    expect(g.moveHistory.find((m: any) => m.abilityDeath).abilityDeath.color).toBe('white');
    const restored = new LocalGameService(TestBed.inject(ConfigService));
    expect(unitPoints(g.config, (restored as any).game.moveHistory, 'white')).toBe(15);
  });

  it('commits Charge and Nullify using the same counter rules as their previews', async () => {
    const g = (service as any).game;
    for (const nullify of [false, true]) {
      g.turnNumber = 55; g.currentTurn = 'Solo'; g.moveHistory = [];
      g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
        '0,0': { ...fullUnit('knight', 'white', 'wn'), hp: 20, max_hp: 20, vet: 3 },
        '1,0': { ...fullUnit('pawn', 'black', 'bp'), hp: 14, max_hp: 14, vet: 3 } };
      service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', bonuses: { charge: true, nullify } }); await flush();
      expect([g.boardState['0,0'].hp, g.boardState['1,0'].hp]).toEqual(nullify ? [20, 10] : [19, 6]);
      expect(last('move_made').move.secondStrike).toBe(nullify ? undefined : true);
    }
  });

  it('commits Cast with its extra action, preserves king ownership and returns control at the next caster turn', async () => {
    const g = (service as any).game; g.turnNumber = 55; g.currentTurn = 'Solo'; g.moveHistory = [];
    const target = { ...fullUnit('king', 'black', 'bk'), vet: 3, owner: 'black', color: 'white', controlledUntil: 57, controlTurn: 55 };
    g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '1,0': { ...target, color: 'black' }, '0,0': { ...fullUnit('bishop', 'white', 'wb'), vet: 3 } };
    service.send({ type: 'make_move', from: '0,0', to: '0,0', unitAction: true, more: true,
      effectsBefore: [{ castId: 'cast-55', unitCast: { uid: 'wb', id: 'bishop-cast', color: 'white', cost: 10, gain: 0 } }, { at: '1,0', control: target, controlSource: 'wb' }] }); await flush();
    expect(g.turnNumber).toBe(55); expect(g.boardState['1,0'].color).toBe('white');
    service.send({ type: 'make_move', from: '1,0', to: '2,0' }); await flush();
    expect(g.turnNumber).toBe(56); expect(g.endReason).toBeFalsy(); expect(g.boardState['2,0'].owner).toBe('black');
    const restored = new LocalGameService(TestBed.inject(ConfigService)); expect((restored as any).game.boardState['2,0'].color).toBe('white');
    service.send({ type: 'pass_turn' }); await flush(); expect(g.boardState['2,0'].color).toBe('black');
    expect(last('turn_passed').boardState['2,0'].color).toBe('black'); expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(0);
  });

  it('a controlled king death defeats its original owner and charges attrition to the caster', async () => {
    const g = (service as any).game; g.turnNumber = 55; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'),
      '0,0': { ...fullUnit('king', 'black', 'bk'), color: 'white', owner: 'black', controlledUntil: 57, hp: 1 } };
    service.send({ type: 'pass_turn', effectsBefore: [{ at: '0,0', uid: 'bk', hp: 0 }] }); await flush();
    expect(g.winner).toBe('Solo'); expect(g.endReason).toBe('regicide');
    expect(g.moveHistory.find((m: any) => m.abilityDeath).abilityDeath.color).toBe('white');
  });

  it('keeps each physical reserve cap separate for a controlled unit', async () => {
    const g = (service as any).game; g.turnNumber = 55; g.currentTurn = 'Solo'; g.moveHistory = [];
    for (let i = 0; i < 3; i++) {
      service.send({ type: 'panel_move', from: '12,1', to: '13,1', panel: 'br', cost: 1,
        unit: fullUnit('pawn', 'white', `w${i}`) });
    }
    await flush();
    service.send({ type: 'panel_move', from: '-12,-1', to: '-13,-1', panel: 'tl', cost: 1,
      unit: { ...fullUnit('pawn', 'white', 'controlled'), owner: 'black', controlledUntil: 57 } });
    await flush();
    expect(last('invalid_move')).toBeUndefined();
    expect(g.moveHistory.filter((m: any) => m.panelMove).length).toBe(4);
    service.send({ type: 'panel_move', from: '12,1', to: '13,1', panel: 'br', cost: 1,
      unit: fullUnit('pawn', 'white', 'fourth') }); await flush();
    expect(last('invalid_move').message).toContain('started its units');
  });

  it('keeps the controlled unit extra action separate when it attacks a panel first', async () => {
    const g = (service as any).game; g.turnNumber = 75; g.currentTurn = 'Solo'; g.moveHistory = [];
    const controlled = { ...fullUnit('knight', 'white', 'bn'), owner: 'black', controlTurn: 75, controlledUntil: 77, vet: 3, hp: 20, max_hp: 20 };
    g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
      '-10,0': controlled, '0,0': fullUnit('pawn', 'white', 'wp') };
    g.moveHistory = [{ at: '-10,0', control: controlled, turn: 75 }];
    service.send({ type: 'panel_attack', from: '-10,0', to: '-10,0', attack: '-11,0',
      unit: fullUnit('pawn', 'black', 'bp'), panel: 'tl', counters: true, more: true }); await flush();
    expect(g.turnNumber).toBe(75); expect(last('invalid_move')).toBeUndefined();
    service.send({ type: 'make_move', from: '0,0', to: '0,1' }); await flush();
    expect(g.boardState['0,1'].uid).toBe('wp'); expect(g.turnNumber).toBe(76);
  });

  it('a controlled green-reserve bishop regenerates for its caster, then for its owner after expiry', async () => {
    const g = (service as any).game; g.turnNumber = 55; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk') };
    const controlled = { ...fullUnit('bishop', 'white', 'bb'), owner: 'black', controlTurn: 55, controlledUntil: 57, vet: 3, hp: 2 };
    g.moveHistory = [{ at: '-12,-1', control: controlled, turn: 55 }];
    service.send({ type: 'pass_turn' }); await flush();
    const heal = g.moveHistory.find((m: any) => m.regenerationHeal);
    expect(heal.unit.uid).toBe('bb'); expect(heal.unit.color).toBe('white'); expect(heal.defenderHp).toBe(8);
    service.send({ type: 'pass_turn' }); await flush();
    service.send({ type: 'pass_turn', effectsBefore: [{ unit: controlled, panel: 'tl', at: '-12,-1', hp: 2 }] }); await flush();
    expect(g.moveHistory.filter((m: any) => m.regenerationHeal).length).toBe(1);
    service.send({ type: 'pass_turn' }); await flush();
    const healed = g.moveHistory.filter((m: any) => m.regenerationHeal);
    expect(healed.length).toBe(2); expect(healed[1].unit.color).toBe('black');
  });

  it('Rapid Movement can walk home after field or panel combat, preserving HP, both units and UP through reload', async () => {
    const g = (service as any).game;
    for (const intoPanel of [false, true]) {
      g.turnNumber = 73; g.currentTurn = 'Solo'; g.moveHistory = [];
      g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
        '-10,9': { ...fullUnit('pawn', 'white', 'wp'), hp: 14, max_hp: 14, vet: 3 } };
      const defender = { ...fullUnit('pawn', 'black', 'bp'), hp: 14, max_hp: 14, vet: 3 };
      const attack = intoPanel ? '-11,10' : '-9,9';
      if (!intoPanel) g.boardState[attack] = defender;
      service.send({ type: intoPanel ? 'panel_attack' : 'make_move', from: '-10,9', to: '-10,9',
        attack, afterAttackTo: '-12,9', withdraw: true,
        ...(intoPanel ? { unit: defender, panel: 'bl', counters: true } : {}) }); await flush();
      expect(last('invalid_move')).toBeUndefined(); expect(g.boardState['-10,9']).toBeUndefined();
      const move = last('move_made').move;
      expect(move.withdrawn).toBeTrue(); expect(move.to).toBe('-12,9'); expect(move.unit.uid).toBe('wp');
      expect(move.unit.hp).toBe(13); expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(18);
      if (intoPanel) { expect(move.panelDefender.uid).toBe('bp'); expect(move.defenderHp).toBe(13); }
      const restored = new LocalGameService(TestBed.inject(ConfigService));
      expect((restored as any).game.moveHistory.find((m: any) => m.withdrawn).unit.hp).toBe(13);
      if (!intoPanel) {
        g.turnNumber = 73; g.currentTurn = 'Solo'; g.moveHistory = [];
        g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
          '-10,9': { ...move.unit, hp: 14 }, '-9,9': { ...defender, hp: 1 } };
        service.send({ type: 'make_move', from: '-10,9', to: '-10,9', attack: '-9,9', afterAttackTo: '-12,9', withdraw: true }); await flush();
        expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(26);
      }
    }
  });

  it('resolves post-combat casts before a Rapid walk atomically, including held panel blows', async () => {
    const g = (service as any).game;
    for (const intoPanel of [false, true]) {
      g.turnNumber = intoPanel ? 89 : 55; g.currentTurn = 'Solo'; g.moveHistory = [];
      const ply = g.turnNumber;
      const at = intoPanel ? '-10,0' : '0,0', target = intoPanel ? '-11,0' : '1,0';
      g.boardState = { '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
        [at]: { ...fullUnit('pawn', 'white', 'wp'), hp: 14, max_hp: 14, vet: 3 } };
      const defender = { ...fullUnit('rook', 'black', 'br'), hp: 2, vet: 3 };
      if (!intoPanel) g.boardState[target] = defender;
      const effect = intoPanel ? { unit: defender, panel: 'tl', at: target, hp: 0 } : { at: target, uid: 'br', hp: 0 };
      const message = { type: intoPanel ? 'panel_attack' : 'make_move', from: at, to: at, attack: target,
        effectsAfterAttack: [effect], ...(intoPanel ? { unit: defender, panel: 'tl', counters: true, more: true } : {}) };
      const before = structuredClone(g.boardState);
      service.send({ ...message, afterAttackTo: '7,0' }); await flush();
      expect(g.boardState).toEqual(before); expect(g.moveHistory).toEqual([]); expect(g.turnNumber).toBe(ply);
      expect(last('invalid_move').message).toContain('Rapid Movement');
      service.send({ ...message, afterAttackTo: intoPanel ? '-9,0' : target }); await flush();
      expect(g.boardState[intoPanel ? '-9,0' : target]).toEqual(jasmine.objectContaining({ uid: 'wp', hp: 10 }));
      expect(g.moveHistory.some((m: any) => intoPanel ? m.panelEffect && m.defenderHp === 0 : m.abilityDeath?.unit_id === 'rook')).toBeTrue();
      expect(g.turnNumber).toBe(intoPanel ? ply : ply + 1);
      if (intoPanel) { service.send({ type: 'pass_turn' }); await flush(); expect(g.turnNumber).toBe(ply + 1); }
      const restored = new LocalGameService(TestBed.inject(ConfigService));
      expect((restored as any).game.boardState).toEqual(g.boardState);
    }
  });

  it('commits a Rapid Movement attack before the remaining walk, with refusal and reload', async () => {
    const g = (service as any).game;
    g.turnNumber = 31; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = {
      '0,0': { ...fullUnit('pawn', 'white', 'wp'), hp: 14, max_hp: 14, vet: 2 },
      '1,0': { ...fullUnit('rook', 'black', 'br'), vet: 2 },
      '-8,0': { ...fullUnit('king', 'white', 'wk'), vet: 2 },
      '8,0': { ...fullUnit('king', 'black', 'bk'), vet: 2 },
    };
    const before = structuredClone(g.boardState);
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', afterAttackTo: '-7,0' });
    await flush();
    expect(last('invalid_move').message).toContain('Rapid Movement');
    expect(g.boardState).toEqual(before);
    expect(g.turnNumber).toBe(31);
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', afterAttackTo: '-5,0' });
    await flush();
    expect(g.boardState['0,0']).toBeUndefined();
    expect(g.boardState['-5,0'].uid).toBe('wp');
    expect(g.boardState['-5,0'].hp).toBe(10);
    expect(last('move_made').move.attackFrom).toBe('0,0');
    expect(last('move_made').move.to).toBe('-5,0');
    const restored = new LocalGameService(TestBed.inject(ConfigService));
    expect((restored as any).game.boardState['-5,0']).toEqual(g.boardState['-5,0']);
  });

  it('resolves veteran Counter, Deflect and Hop when the local engine commits', async () => {
    const g = (service as any).game;
    g.turnNumber = 31; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = {
      '0,0': { ...fullUnit('knight', 'white', 'wn'), hp: 20, max_hp: 20, vet: 2 },
      '1,0': { ...fullUnit('pawn', 'black', 'bp'), hp: 14, max_hp: 14, vet: 2 },
      '2,0': { ...fullUnit('pawn', 'black', 'bp2'), hp: 14, max_hp: 14, vet: 2 },
      '-8,0': { ...fullUnit('king', 'white', 'wk'), vet: 2 },
      '9,-3': { ...fullUnit('king', 'black', 'bk'), vet: 2 },
    };
    service.send({ type: 'make_move', from: '0,0', to: '8,0' }); await flush();
    expect(g.boardState['8,0'].uid).toBe('wn');
    g.turnNumber = 31; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = { ...g.boardState, '0,0': { ...fullUnit('shieldman', 'white', 'ws'), hp: 32, max_hp: 32, vet: 2 },
      '1,0': { ...fullUnit('archer', 'black', 'ba'), hp: 6, max_hp: 6, vet: 2 } };
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0' }); await flush();
    expect(last('move_made').move.damage_dealt).toBe(1);
    expect(last('move_made').move.counter_damage).toBe(1);
  });

  it('regenerates living veteran bishops only on their side in field and green reserve', async () => {
    const g = (service as any).game;
    g.turnNumber = 31; g.currentTurn = 'Solo'; g.moveHistory = [
      { turn: 5, from: '11,1', to: '11,1', panelMove: true, unit: { ...fullUnit('bishop', 'white', 'wb-green'), vet: 2 } },
      { turn: 30, intoPanel: true, panelEffect: true, attackedHex: '11,1', panel: 'tr', defenderHp: 2,
        unit: { ...fullUnit('bishop', 'white', 'wb-green'), vet: 2 } },
      { turn: 30, intoPanel: true, panelEffect: true, attackedHex: '-12,11', panel: 'bl', defenderHp: 2,
        unit: { ...fullUnit('bishop', 'white', 'wb-base'), vet: 0 } },
    ];
    g.boardState = { '-8,0': { ...fullUnit('king', 'white', 'wk'), vet: 2 },
      '8,0': { ...fullUnit('king', 'black', 'bk'), vet: 2 },
      '0,0': { ...fullUnit('bishop', 'white', 'wb'), hp: 2, vet: 2 },
      '2,0': { ...fullUnit('bishop', 'black', 'bb'), hp: 2, vet: 2 } };
    service.send({ type: 'pass_turn' }); await flush();
    expect(g.boardState['0,0'].hp).toBe(8);
    expect(g.boardState['2,0'].hp).toBe(2);
    const heals = g.moveHistory.filter((move: any) => move.regenerationHeal);
    expect(heals.length).toBe(1);
    expect([heals[0].unit.uid, heals[0].defenderHp]).toEqual(['wb-green', 8]);
    const restored = new LocalGameService(TestBed.inject(ConfigService));
    expect((restored as any).game.moveHistory.filter((move: any) => move.regenerationHeal)).toEqual(heals);
  });

  it('promotes wounded units once at Phase 1 and preserves their HP and stats through reload', async () => {
    const g = (service as any).game;
    g.turnNumber = 6; g.currentTurn = LOCAL_OPPONENT; g.moveHistory = [];
    g.boardState = {
      '0,0': { ...fullUnit('pawn', 'white', 'wp'), hp: 5, vet: 0 },
      '1,0': { ...fullUnit('archer', 'black', 'ba'), vet: 0 },
      '-8,0': { ...fullUnit('king', 'white', 'wk'), vet: 0 },
      '8,0': { ...fullUnit('king', 'black', 'bk'), vet: 0 },
    };
    service.send({ type: 'pass_turn' }); await flush();
    expect([g.boardState['0,0'].hp, g.boardState['0,0'].max_hp, g.boardState['0,0'].vet]).toEqual([7, 14, 1]);
    const restored = new LocalGameService(TestBed.inject(ConfigService));
    expect((restored as any).game.boardState['0,0']).toEqual(g.boardState['0,0']);
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0' }); await flush();
    expect(last('move_made').move.damage_dealt).toBe(6);
    expect(last('move_made').move.defender_eliminated).toBeTrue();
    expect([g.boardState['0,0'].hp, g.boardState['0,0'].max_hp]).toEqual([7, 14]);
  });

  it('uses the earned king attack ring and bishop healing ring in committed actions', async () => {
    const g = (service as any).game;
    g.turnNumber = 6; g.currentTurn = LOCAL_OPPONENT; g.moveHistory = [];
    g.boardState = {
      '0,0': { ...fullUnit('king', 'white', 'wk'), vet: 0 },
      '2,0': { ...fullUnit('king', 'black', 'bk'), vet: 0 },
      '-3,0': { ...fullUnit('bishop', 'white', 'wb'), vet: 0 },
      '-1,0': { ...fullUnit('pawn', 'white', 'wp'), hp: 1, vet: 0 },
    };
    service.send({ type: 'pass_turn' }); await flush();
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '2,0' }); await flush();
    expect(last('move_made').move.damage_dealt).toBe(2);
    service.send({ type: 'pass_turn' }); await flush();
    service.send({ type: 'make_move', from: '-3,0', to: '-3,0', heal: '-1,0' }); await flush();
    expect(last('move_made').move.healed_amount).toBe(6);
    expect(g.boardState['-1,0'].hp).toBe(9);
    expect(g.boardState['-1,0'].max_hp).toBe(14);
  });

  it('persists both halftime UP awards on moves and passes, once through reload and later board changes', async () => {
    for (const [phase, ply] of [[1, 17], [2, 39], [3, 61]]) {
      const g = (service as any).game;
      g.turnNumber = ply - 1; g.currentTurn = LOCAL_OPPONENT; g.moveHistory = [];
      g.phaseBank = {}; g.endReason = ''; g.winner = '';
      g.boardState = {
        '-10,0': fullUnit('king', 'white', 'wk'), '10,0': fullUnit('king', 'black', 'bk'),
        '-3,6': fullUnit('pawn', 'white', 'wp'), '7,0': fullUnit('rook', 'black', 'br'),
      };
      replies.length = 0;
      service.send(phase === 2 ? { type: 'make_move', from: '10,0', to: '10,-1' } : { type: 'pass_turn' });
      await flush();
      const handed = last(phase === 2 ? 'move_made' : 'turn_passed');
      const award = { turn: ply, halftimeUp: { phase, white: 57 * phase, black: 19 * phase } };
      expect(handed.effects).withContext(`phase ${phase}`).toEqual([award]);
      const restored = new LocalGameService(TestBed.inject(ConfigService));
      expect((restored as any).game.moveHistory.filter((m: any) => m.halftimeUp)).toEqual([award]);
      g.boardState = { '-10,0': fullUnit('king', 'white', 'wk'), '10,0': fullUnit('king', 'black', 'bk') };
      service.send({ type: 'pass_turn' }); await flush();
      expect(g.moveHistory.filter((m: any) => m.halftimeUp)).toEqual([award]);
      expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(10 + 57 * phase);
      expect(unitPoints(g.config, g.moveHistory, 'black')).toBe(10 + 19 * phase);
      expect(g.phaseBank[String(phase)]).toBeUndefined();
    }
  });

  it('refuses unaffordable UP crossings for either side even with plenty of regular points', async () => {
    const g = (service as any).game;
    for (const color of ['white', 'black']) {
      g.turnNumber = color === 'white' ? 15 : 16;
      g.currentTurn = color === 'white' ? 'Solo' : LOCAL_OPPONENT;
      g.moveHistory = []; g.config.rules.upAtStart = 7;
      const unit = fullUnit('pawn', color, `${color}-pool`);
      replies.length = 0;
      service.send({ type: 'panel_move', from: 'base', to: 'reserve', panel: color === 'white' ? 'bl' : 'tr',
        cost: 1, price: 1, unit }); await flush();
      expect(last('invalid_move').message).toBe('Not enough UP for the crossing');
      expect(g.moveHistory).toEqual([]);
      g.config.rules.upAtStart = 8;
      service.send({ type: 'panel_move', from: 'base', to: 'reserve', panel: color === 'white' ? 'bl' : 'tr',
        cost: 1, price: 1, unit }); await flush();
      expect(unitPoints(g.config, g.moveHistory, color as 'white' | 'black')).toBe(0);
      expect(g.moveHistory[0].price).toBe(8);
    }
  });

  it('rejects a boosted walk from an empty hex without changing the board or turn', async () => {
    await pastOpening();
    const before = JSON.stringify((service as any).game);
    expect(() => service.send({ type: 'make_move', from: '0,0', to: '0,1', moveBonus: 4 })).not.toThrow();
    await flush();
    expect(last('invalid_move').message).toBe('Illegal move');
    expect(JSON.stringify((service as any).game)).toBe(before);
  });

  it('starts a game with both setups placed and white to move', () => {
    const started = last('game_started');
    expect(started.playerWhite).toBe('Solo');
    expect(started.playerBlack).toBe(LOCAL_OPPONENT);
    expect(started.currentTurn).toBe('Solo');
    const radius = DEFAULT_GAME_CONFIG.board.radius;
    const placements = Object.values(DEFAULT_GAME_CONFIG.setup).reduce((total, side) =>
      total + Object.keys(side).filter(key => {
        const [q, r] = key.split(',').map(Number);
        return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius;
      }).length, 0);
    expect(Object.keys(started.boardState).length).toBe(placements);
    for (const [key, piece] of Object.entries(started.boardState) as [string, any][]) {
      const unit = Object.values(DEFAULT_GAME_CONFIG.units).find(({ id }) => id === piece.unit_id);
      expect(unit).withContext(key).toBeDefined();
      if (!unit) throw new Error(`Unknown configured unit ${piece.unit_id} at ${key}`);
      expect(piece.hp).withContext(key).toBe(unit.hp);
      expect(piece.max_hp).withContext(key).toBe(unit.hp);
    }
  });

  it('puts a finished room back to waiting, keeping its settings', async () => {
    service.send({ type: 'change_game_mode', mode: 'default', options: { turnTimeLimit: 30 } });
    service.send({ type: 'resign' });
    await flush();
    expect(last('game_over')).toBeDefined();

    service.send({ type: 'reset_game' });
    await flush();
    expect(last('game_reset')).toBeDefined();

    // Waiting again, with an empty board - and the host's settings survive,
    // because the point of the stop is to change them if you want to.
    service.send({ type: 'join_game_room', username: 'Solo' });
    await flush();
    expect(last('join_game_room_success').gameStatus).toBe('waiting');
    service.send({ type: 'request_game_state' });
    await flush();
    expect(Object.keys(last('game_state_update').boardState).length).toBe(0);

    // And it deals again from there.
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
    const radius = DEFAULT_GAME_CONFIG.board.radius;
    const placements = Object.values(DEFAULT_GAME_CONFIG.setup).reduce((total, side) =>
      total + Object.keys(side).filter(key => {
        const [q, r] = key.split(',').map(Number);
        return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= radius;
      }).length, 0);
    expect(Object.keys(last('game_started').boardState).length).toBe(placements);
  });

  it('awards stars on passes, persists them, and reconstructs an older save on reload', async () => {
    expect(Object.values(last('game_started').boardState).every((u: any) => u.vet === 0)).toBeTrue();
    const game = (service as any).game;
    for (const [from, to] of [['-4,9', '-4,8'], ['4,-9', '4,-8']]) {
      game.boardState[to] = game.boardState[from]; delete game.boardState[from];
    }
    for (const [ply, vet] of [[6, 1], [26, 2], [48, 3], [70, 3]]) {
      const g = (service as any).game;
      g.turnNumber = ply;
      g.currentTurn = LOCAL_OPPONENT;
      service.send({ type: 'pass_turn' });
      await flush();
      const passed = last('turn_passed');
      expect(passed.turnNumber).toBe(ply + 1);
      expect(Object.values(passed.boardState).every((u: any) => u.vet === vet)).toBeTrue();
      const saved = JSON.parse(localStorage.getItem('cpp.localGame.v1')!);
      expect(Object.values(saved.boardState).every((u: any) => u.vet === vet)).toBeTrue();
    }
    const saved = JSON.parse(localStorage.getItem('cpp.localGame.v1')!);
    Object.values(saved.boardState).forEach((u: any) => delete u.vet);
    localStorage.setItem('cpp.localGame.v1', JSON.stringify(saved));
    const restored = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    restored.messages$.subscribe(m => seen.push(m));
    restored.send({ type: 'request_game_state' });
    await flush();
    expect(Object.values(seen[0].boardState).every((u: any) => u.vet === 3)).toBeTrue();
  });

  it('records a cast made after a blow into a panel after the blow', async () => {
    // The blow's record used to be the last word on the unit's HP: the cast
    // went ahead of it, so a panel unit struck and then finished by a spell
    // came back from the dead on a reload.
    await pastOpening();
    const home = fullUnit('rook', 'black', 'rtr0');
    service.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr',
      from: '-5,9', attack: '-5,8', unit: home,
      effects: [{ unit: home, hp: 0, panel: 'tr' }],
    });
    await flush();
    expect(last('move_made').effects[0].defenderHp).toBe(0);
    service.send({ type: 'request_game_state' });
    await flush();
    const history = last('game_state_update').moveHistory;
    expect(history.slice(-2)[0].panelAttack).toBeTrue();
    expect(history.slice(-1)[0]).toEqual(jasmine.objectContaining({ panelEffect: true, defenderHp: 0 }));
  });

  it('lands a blow in a panel, and the panel answers', async () => {
    // The defender is not on this board - panels are the client's - so it
    // rides in with the message and its remaining HP comes back on the
    // record. `from` is a real board hex: the attacker IS on the board.
    const started = last('game_started');
    const attacker = '-5,9';
    expect(started.boardState[attacker].unit_id).toBe('pawn');
    await pastOpening();
    const opened = last('turn_passed').turnNumber;

    const home = fullUnit('rook', 'black', 'rtr0');
    service.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr',
      from: attacker, attack: '-5,8', unit: home,
    });
    await flush();
    const msg = last('move_made');
    const hit = msg.move;
    expect(hit.panelAttack).toBeTrue();
    expect(hit.intoPanel).toBeTrue();
    // The panel is carried, not derived - this engine has none to look one up
    // in - and kept, because the record is the only place it survives a
    // reload, where it says whether the wound mends.
    expect(hit.panel).toBe('tr');
    service.send({ type: 'request_game_state' });
    await flush();
    expect(last('game_state_update').moveHistory.slice(-1)[0]).toEqual(hit);
    expect(hit.damage_dealt).toBeGreaterThan(0);
    // The panel unit's wound is on the record, not on the board.
    expect(hit.defenderHp).toBeLessThan(home.hp);
    expect(msg.boardState['-5,8']).toBeUndefined();
    // It answers, and the answer lands on the attacker where it stands - a
    // base unit never starts a fight but always finishes its part of one.
    expect(hit.counter_damage).toBeGreaterThan(0);
    expect(msg.boardState[attacker].hp).toBeLessThan(unitStats('pawn', DEFAULT_GAME_CONFIG, 1).hp);
    expect(msg.turnNumber).toBe(opened + 1);

    // Out of range is refused rather than resolved.
    service.send({
      type: 'panel_attack', intoPanel: true,
      from: attacker, attack: '9,-9', unit: home,
    });
    await flush();
    expect(last('invalid_move')).toBeDefined();
  });

  it('takes no answer from a base, which is struck and says nothing', async () => {
    // Whether a panel answers is the panel's own rule and travels with the
    // message - the client owns panels, this engine has no idea which one a
    // unit is standing in. A reserve strikes back; a base never does.
    await pastOpening();
    const attacker = '-4,9';
    const home = fullUnit('rook', 'black', 'rbl0');
    const struck = () => last('move_made').move;

    service.send({
      type: 'panel_attack', intoPanel: true, counters: false,
      from: attacker, attack: '-4,8', unit: home,
    });
    await flush();
    expect(struck().damage_dealt).toBeGreaterThan(0);
    expect(struck().counter_damage).toBe(0);
    // Untouched where it stands: nothing answered it.
    expect(last('move_made').boardState[attacker].hp)
      .toBe(unitStats('pawn', DEFAULT_GAME_CONFIG, 1).hp);
  });

  it('walks the attacker before it swings into a panel, and leaves it there', async () => {
    // The blow into a panel is the WHOLE turn - no make_move follows it - so
    // the walk rides with it. Sent without `to`, the engine resolved from
    // where the unit set off and left it there, which read as the unit being
    // teleported back to where it had moved from.
    const started = last('game_started');
    const from = '-5,9', to = '-5,8';
    expect(started.boardState[from].unit_id).toBe('pawn');
    expect(started.boardState[to]).toBeUndefined();
    await pastOpening();

    const home = fullUnit('rook', 'black', 'rtr0');
    service.send({
      type: 'panel_attack', intoPanel: true,
      from, to, attack: '-5,7', unit: home,
    });
    await flush();
    const msg = last('move_made');
    // It stands where it walked to, not where it started.
    expect(msg.boardState[from]).toBeUndefined();
    expect(msg.boardState[to]).toBeDefined();
    expect(msg.move.moved).toBeTrue();
    expect(msg.move.to).toBe(to);
    // And the range was measured from there: -5,7 is one step from `to` and
    // two from `from`, which a pawn could not reach.
    expect(msg.move.damage_dealt).toBeGreaterThan(0);

    // A walk the rules would refuse is refused here too, not taken on trust.
    // Black's turn now, so the attacker has to be one of black's.
    const theirs = fullUnit('rook', 'white', 'rbl0');
    service.send({
      type: 'panel_attack', intoPanel: true,
      from: '0,-9', to: '0,5', attack: '0,6', unit: theirs,
    });
    await flush();
    expect(last('invalid_move').message).toBe('Illegal move');
  });

  it('applies a legal move and hands the turn over', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();
    const move = last('move_made');
    expect(move.boardState['-5,8'].unit_id).toBe('pawn');
    expect(move.boardState['-5,9']).toBeUndefined();
    expect(move.currentTurn).toBe(LOCAL_OPPONENT);
    expect(move.turnNumber).toBe(2);
  });

  it('holds the seat for a move that is not the turn’s last', async () => {
    // Ply 89 is turn 45 - Overtime 2, two board moves to a side. The first
    // carries `more`: same seat, same ply, same clock, and the next message
    // plays the next unit. Mirrors `_commit_deployment` on the server.
    const g = (service as any).game;
    g.turnNumber = 2 * 45 - 1;
    const kingOf = (board: any) => Object.values(board).find(
      (c: any) => c.color === 'white' && g.config.units[c.unit_id]?.commander) as any;
    const hpBefore = kingOf(g.boardState).hp;

    service.send({ type: 'make_move', from: '-5,9', to: '-5,8', more: true });
    await flush();
    expect(last('move_made')).toBeUndefined();
    const held = last('game_state_update');
    expect(held.turnNumber).toBe(2 * 45 - 1);
    expect(held.currentTurn).toBe('Solo');
    expect(held.boardState['-5,8'].unit_id).toBe('pawn');

    // The second ends it.
    service.send({ type: 'make_move', from: '-4,9', to: '-4,8' });
    await flush();
    expect(last('move_made').turnNumber).toBe(2 * 45);

    // **The toll was taken once, not once per move.** Overtime 2 takes 3, so a
    // two-move turn costs 3 and not 6 - and Overtime 3, the stretch that
    // allows three, is where charging it per move would hurt most. The held
    // move must leave it alone: the toll is what the END of a turn costs.
    expect(kingOf(last('move_made').boardState).hp).toBe(hpBefore - 3);
    // And the held message took none of it at all.
    expect(kingOf(held.boardState).hp).toBe(hpBefore);
  });

  it('holds the seat for a blow into a panel that is not the turn’s last', async () => {
    // A blow into a panel ended the turn outright, so the room sent it alone
    // and dropped every other move an overtime turn had staged with it.
    const g = (service as any).game;
    g.turnNumber = 2 * 45 - 1;
    const kingOf = (board: any) => Object.values(board).find(
      (c: any) => c.color === 'white' && g.config.units[c.unit_id]?.commander) as any;
    const hpBefore = kingOf(g.boardState).hp;
    const home = fullUnit('rook', 'black', 'rtr0');

    service.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr', more: true,
      from: '-5,9', attack: '-5,8', unit: home,
    });
    await flush();
    expect(last('move_made')).toBeUndefined();
    const held = last('game_state_update');
    expect(held.turnNumber).toBe(2 * 45 - 1);
    expect(held.currentTurn).toBe('Solo');
    expect(held.moveHistory.slice(-1)[0].intoPanel).toBeTrue();
    expect(kingOf(held.boardState).hp).toBe(hpBefore);

    service.send({ type: 'make_move', from: '-4,9', to: '-4,8' });
    await flush();
    expect(last('move_made').turnNumber).toBe(2 * 45);
    // The toll once, for the whole turn.
    expect(kingOf(last('move_made').boardState).hp).toBe(hpBefore - 3);
  });

  it('counts a blow into a panel against the turn’s allowance', async () => {
    await pastOpening();
    service.send({ type: 'make_move', from: '-4,9', to: '-4,8' });
    await flush();
    // Wound back into the same hand-over: the one move of turn 4 is spent.
    (service as any).game.turnNumber = 7;
    (service as any).game.currentTurn = 'Solo';
    const home = fullUnit('rook', 'black', 'rtr0');
    service.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr',
      from: '-5,9', attack: '-5,8', unit: home,
    });
    await flush();
    expect(last('invalid_move').message).toBe('That side has had all 1 of its moves this turn');
  });

  it('keeps a mend cast between two units’ moves on top of the first unit’s wound', async () => {
    // The order the room now sends it in: the blow, then - riding ahead of the
    // second unit's move - the mend worked out after the counter. The engine
    // takes the counter first and the mend second, and ends where the staged
    // board did.
    const g = (service as any).game;
    g.turnNumber = 2 * 45 - 1;
    g.boardState = {
      ...g.boardState,
      '-5,5': { unit_id: 'rook', color: 'white', hp: hpOf('rook') - 10, max_hp: hpOf('rook'), uid: 'wr' },
      '-4,5': { unit_id: 'pawn', color: 'black', hp: hpOf('pawn'), max_hp: hpOf('pawn'), uid: 'bs' },
    };
    service.send({ type: 'make_move', from: '-5,5', to: '-5,5', attack: '-4,5', more: true });
    await flush();
    const struck = last('game_state_update').boardState['-5,5'].hp;
    expect(struck).toBeLessThan(30);
    const mended = struck + 5;

    service.send({
      type: 'make_move', from: '-4,9', to: '-4,8',
      effectsBefore: [{ at: '-5,5', uid: 'wr', hp: mended }],
    });
    await flush();
    expect(last('move_made').boardState['-5,5'].hp).toBe(mended);
  });

  it('refuses a move once the turn’s allowance is spent', async () => {
    // Ply 7 is turn 4, one board move. The second message is refused rather
    // than quietly played into the next side’s turn.
    await pastOpening();
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8', more: true });
    await flush();
    // `more` on the last move the allowance permits ends the turn anyway -
    // there is nothing left for it to hold the seat open for.
    expect(last('move_made').turnNumber).toBe(8);

    // Wind back into the same hand-over: a second board move is refused.
    (service as any).game.turnNumber = 7;
    (service as any).game.currentTurn = 'Solo';
    service.send({ type: 'make_move', from: '-4,9', to: '-4,8' });
    await flush();
    expect(last('invalid_move').message)
      .toBe('That side has had all 1 of its moves this turn');
  });

  it('rejects moving the other side and moving out of range', async () => {
    service.send({ type: 'make_move', from: '3,-10', to: '3,-9' }); // black, not their turn
    service.send({ type: 'make_move', from: '-7,10', to: '0,0' }); // far out of range
    await flush();
    expect(replies.filter(m => m.type === 'invalid_move').length).toBe(2);
    expect(last('move_made')).toBeUndefined();
  });

  it('walks reserves in without ending the turn', async () => {
    const started = last('game_started');
    // The panels are the client's own, so each unit arrives with its message
    // - there is nothing at `from` for the engine to pick up.
    // Empty hexes inside white's own first three rows - the only ground a
    // crossing may stop on.
    const free = ['1,9', '-1,9', '-3,9', '-6,9'].filter(k => !started.boardState[k]).slice(0, 2);
    expect(free.length).toBe(2);
    const unit = (i: number) =>
      ({ unit_id: 'pawn', color: 'white', hp: 10, max_hp: 10, uid: `rbr${i}` });

    service.send({ type: 'enter_board', from: '3,9', to: free[0], unit: unit(0) });
    service.send({ type: 'enter_board', from: '2,10', to: free[1], unit: unit(1) });
    await flush();

    const state = last('game_state_update');
    expect(state.boardState[free[0]].uid).toBe('rbr0');
    expect(state.boardState[free[1]].uid).toBe('rbr1');
    // Deployment, not the turn's action: more than one comes through, and the
    // turn is still ours afterwards.
    expect(state.currentTurn).toBe('Solo');
    expect(state.turnNumber).toBe(1);
  });

  it('records a walk inside a panel without ending the turn', async () => {
    // A walk used to reach no engine: the board kept it in its own memory, so
    // a reload re-dealt the unit where it began. Recorded, it is replayed.
    const archer = fullUnit('archer', 'white', 'rbr4');
    service.send({
      type: 'panel_move', from: '7,7', to: '6,7', unit: archer, panel: 'br', cost: 1, price: 0,
    });
    await flush();

    const state = last('game_state_update');
    const record = state.moveHistory[state.moveHistory.length - 1];
    expect(record.panelMove).toBeTrue();
    expect(record.unit.uid).toBe('rbr4');
    expect(record.panel).toBe('br');
    expect(record.cost).toBe(1);
    expect(record.to).toBe('6,7');
    expect(state.currentTurn).toBe('Solo');
    expect(state.turnNumber).toBe(1);
  });

  it('refuses a walk for the side that is not on turn', async () => {
    service.send({
      type: 'panel_move', from: '-7,-7', to: '-6,-7', panel: 'tl', cost: 1, price: 0,
      unit: fullUnit('archer', 'black', 'rtl4'),
    });
    await flush();
    expect(last('invalid_move')).toBeTruthy();
    expect(last('game_state_update')).toBeUndefined();
  });

  it('refuses an entry onto an occupied hex or off the board', async () => {
    const started = last('game_started');
    const taken = Object.keys(started.boardState)[0];
    const unit = fullUnit('pawn', 'white', 'rbr9');

    service.send({ type: 'enter_board', from: '3,9', to: taken, unit });
    service.send({ type: 'enter_board', from: '3,9', to: '40,0', unit });
    await flush();

    expect(replies.filter(m => m.type === 'invalid_move').length).toBe(2);
  });

  it('walks a unit home into its own base, and nowhere else', async () => {
    // The enemy's base is off the board and empty too, so nothing but the
    // side check stands between a withdrawal and mending in their back line.
    service.send({ type: 'make_move', from: '-5,9', to: '12,-11', withdraw: true });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();

    // Its own base, which is the point mirror of that, is allowed. Turn 1 is
    // a setup turn, so the walk is deployment: a state update rather than a
    // `move_made`, and the seat stays where it is.
    service.send({ type: 'make_move', from: '-5,9', to: '-12,11', withdraw: true });
    await flush();
    expect(last('move_made')).toBeUndefined();
    const move = last('game_state_update');
    expect(move.boardState['-5,9']).toBeUndefined();
    // It leaves the board entirely rather than landing on a hex of it.
    expect(move.boardState['-12,11']).toBeUndefined();
    expect(move.turnNumber).toBe(1);

    service.send({ type: 'request_game_state' });
    await flush();
    const history = last('game_state_update').moveHistory;
    const record = history[history.length - 1];
    expect(record.withdrawn).toBeTrue();
    // The unit rides in the record - it is the only place it survives.
    expect(record.unit.unit_id).toBe('pawn');
  });

  it('never walks the king home', async () => {
    // The owner's rule. Off the board he counted as no commander, so the walk
    // home lost the match on the spot.
    const started = last('game_started');
    const king = Object.keys(started.boardState).find(k =>
      started.boardState[k].unit_id === 'king' && started.boardState[k].color === 'white')!;
    service.send({ type: 'make_move', from: king, to: '-12,11', withdraw: true });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();
    expect(last('game_over')).toBeUndefined();
  });

  it('resumes the cached game after a reload', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();

    const reloaded = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    reloaded.messages$.subscribe(m => seen.push(m));
    reloaded.send({ type: 'join_game_room', username: 'Solo' });
    reloaded.send({ type: 'request_game_state' });
    await flush();

    expect(seen.find(m => m.type === 'join_game_room_success').gameStatus).toBe('started');
    const state = seen.find(m => m.type === 'game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('refuses an attack on a unit that is nowhere near', async () => {
    // The two setups start opposite ends of a radius-11 board.
    service.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '9,-9' });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(last('move_made')).toBeUndefined();
  });

  it('keeps the seat name when the player renames themselves Opponent', async () => {
    // The placeholder's own name: writing it raw into currentTurn used to make
    // every one of the player's moves come back illegal.
    service.send({ type: 'join_game_room', username: LOCAL_OPPONENT });
    await flush();
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();
    expect(last('invalid_move')).toBeUndefined();
    expect(last('move_made').boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('refuses to re-deal a game that is still running', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();
    service.send({ type: 'start_game', hostColor: 'white' });
    await flush();
    // Still the position we played into, not a fresh board on turn 1.
    service.send({ type: 'request_game_state' });
    await flush();
    const state = last('game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('resumes a saved game rather than dealing over the top of it', async () => {
    service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
    await flush();

    // Entering solo play again - a reload on /lobby?solo=1, or Back into it.
    const fresh = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    fresh.messages$.subscribe(m => seen.push(m));
    fresh.send({ type: 'create_single_player_game', username: 'Solo' });
    fresh.send({ type: 'request_game_state' });
    await flush();

    const state = seen.find(m => m.type === 'game_state_update');
    expect(state.turnNumber).toBe(2);
    expect(state.boardState['-5,8'].unit_id).toBe('pawn');
  });

  it('enforces archer minimum range after walking, counters, shieldman silence and bishop range', async () => {
    const g = (service as any).game;
    const position = (actor: string, victim = 'pawn', distance = 1) => {
      replies.length = 0;
      g.turnNumber = 7; g.currentTurn = 'Solo'; g.moveHistory = [];
      g.boardState = {
        '0,0': fullUnit(actor, 'white', 'actor'),
        [`${distance},0`]: { ...fullUnit(victim, 'black', 'victim'), hp: 100, max_hp: 100 },
        '-8,0': fullUnit('king', 'white', 'wk'),
        '8,0': fullUnit('king', 'black', 'bk'),
      };
    };
    for (const [unit, distance] of [['archer', 1], ['archer', 2], ['archer', 7], ['shieldman', 1]] as const) {
      position(unit, 'pawn', distance);
      const before = structuredClone(g.boardState);
      service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: `${distance},0` });
      await flush();
      expect(last('invalid_move')).withContext(`${unit} ring ${distance}`).toBeDefined();
      expect(g.boardState).toEqual(before); expect(g.turnNumber).toBe(7);
    }
    position('archer', 'pawn', 3);
    service.send({ type: 'make_move', from: '0,0', to: '-1,0', attack: '3,0' }); await flush();
    expect(last('move_made').move.damage_dealt).toBe(1); // Ring 4 attack 3, armor 6, floor 1.
    expect(last('move_made').move.counter_damage).toBe(0);
    for (const victim of ['archer', 'shieldman']) {
      position('pawn', victim);
      service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', bonuses: { targetAtk: 30 } });
      await flush();
      expect(last('move_made').move.counter_damage).withContext(victim).toBe(0);
    }
    for (const distance of [1, 2]) {
      position('bishop', 'rook', distance); g.boardState[`${distance},0`].color = 'white';
      g.boardState[`${distance},0`].hp = 1;
      service.send({ type: 'make_move', from: '0,0', to: '0,0', heal: `${distance},0` }); await flush();
      expect(last('move_made').move.healed_amount).toBe(distance === 1 ? 8 : 6);
    }
  });

  it('rejects an unarmed buffed shieldman, commits Shove attacks and enforces movement drains', async () => {
    const g = (service as any).game;
    g.turnNumber = 9; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = {
      '0,0': fullUnit('shieldman', 'white', 's'),
      '1,0': { ...fullUnit('pawn', 'black', 'p'), hp: 100, max_hp: 100 },
      '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk'),
    };
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', bonuses: { atk: 8 } });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(g.turnNumber).toBe(9);
    g.boardState['0,0'].vet = 2;
    g.boardState['0,0'].hp = unitStats('shieldman', g.config, 2).hp;
    g.boardState['0,0'].max_hp = g.boardState['0,0'].hp;
    replies.length = 0;
    service.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', bonuses: { atk: 8 } });
    await flush();
    expect(last('move_made').move.damage_dealt).toBe(4);
    expect(last('move_made').boardState['0,0'].hp).toBe(31);
    g.turnNumber = 11; g.currentTurn = 'Solo'; g.moveHistory = [];
    g.boardState = { '0,0': fullUnit('pawn', 'white', 'p'), '-8,0': fullUnit('king', 'white', 'wk'), '8,0': fullUnit('king', 'black', 'bk') };
    replies.length = 0;
    service.send({ type: 'make_move', from: '0,0', to: '5,0', moveBonus: -2 });
    await flush();
    expect(last('invalid_move')).toBeDefined();
    expect(g.boardState['0,0'].uid).toBe('p');
    service.send({ type: 'make_move', from: '0,0', to: '4,0', moveBonus: -2 });
    await flush();
    expect(last('move_made').boardState['4,0'].uid).toBe('p');
  });

  it('persists and broadcasts the Phase 3 full heal once, including reserve HP records', async () => {
    const g = (service as any).game;
    const reserve = { ...fullUnit('pawn', 'white', 'reserve'), hp: 1 };
    g.boardState = { '0,0': { ...fullUnit('king', 'white', 'W'), hp: 1 },
      '1,0': { ...fullUnit('king', 'black', 'B'), hp: 2 },
      '2,0': { ...fullUnit('pawn', 'white', 'late'), hp: 3, max_hp: 14, vet: 2 } };
    g.moveHistory = [{ turn: 8, from: '-12,1', to: '2,0', entered: true, unit: fullUnit('pawn', 'white', 'late') },
      { turn: 60, from: '', to: '', intoPanel: true, panelEffect: true,
        unit: reserve, panel: 'br', attackedHex: '11,1', defenderHp: 1 }];
    g.turnNumber = 70; g.currentTurn = g.playerBlack; g.phaseBank = {};
    service.send({ type: 'pass_turn' }); await flush();
    const passed = last('turn_passed');
    expect(passed.turnNumber).toBe(71);
    expect(passed.boardState['0,0'].hp).toBe(hpOf('king'));
    expect(passed.boardState['1,0'].hp).toBe(hpOf('king'));
    expect(passed.boardState['2,0'].hp).toBe(3);
    expect(passed.effects.length).toBe(1);
    expect(passed.effects[0].unit.uid).toBe('reserve');
    expect(passed.effects[0].defenderHp).toBe(unitStats('pawn', DEFAULT_GAME_CONFIG, 3).hp);
    const restored = new LocalGameService(TestBed.inject(ConfigService));
    const messages: any[] = []; restored.messages$.subscribe(m => messages.push(m));
    restored.send({ type: 'request_game_state' }); await flush();
    const state = messages.find(m => m.type === 'game_state_update');
    expect(state.boardState['0,0'].hp).toBe(hpOf('king'));
    expect(state.moveHistory[state.moveHistory.length - 1]).toEqual(passed.effects[0]);
    g.boardState['0,0'].hp = 7;
    service.send({ type: 'pass_turn' }); await flush();
    expect(last('turn_passed').boardState['0,0'].hp).toBe(7);
    expect(last('turn_passed').effects).toBeUndefined();
  });

  describe('normal unit healing', () => {
    const position = (ply = 7) => {
      const g = (service as any).game;
      g.config.units.bishop.heal = [14, 13, 12, 11];
      g.turnNumber = ply;
      g.boardState = {
        '0,0': fullUnit('bishop', 'white', 'healer'),
        '3,0': { ...fullUnit('rook', 'white', 'friend'), hp: 1, max_hp: 50 },
        '0,1': fullUnit('pawn', 'black', 'enemy'),
        '-6,0': fullUnit('king', 'white', 'wk'),
        '6,0': fullUnit('king', 'black', 'bk'),
      };
      return g;
    };

    it('uses each exact ring, caps HP, and reloads the committed heal', async () => {
      for (const [ring, amount] of [[1, 14], [2, 13], [3, 12], [4, 11]]) {
        const g = position();
        g.currentTurn = 'Solo';
        g.moveHistory = [];
        g.boardState[`${ring},0`] = g.boardState['3,0'];
        if (ring !== 3) delete g.boardState['3,0'];
        service.send({ type: 'make_move', from: '0,0', to: '0,0', heal: `${ring},0` });
        await flush();
        const made = last('move_made');
        expect(made.move.healed_amount).toBe(amount);
        expect(made.boardState[`${ring},0`].hp).toBe(1 + amount);
        expect(made.boardState['0,0'].hp).toBe(hpOf('bishop'));
        expect(made.move.attacked).toBeFalse();
        expect(made.move.counter_damage).toBeUndefined();
      }
      const g = position(); g.currentTurn = 'Solo'; g.moveHistory = [];
      g.boardState['3,0'].hp = 48;
      service.send({ type: 'make_move', from: '0,0', to: '1,0', heal: '3,0' });
      await flush();
      expect(last('move_made').move.healed_amount).toBe(2);
      expect(last('move_made').boardState['3,0'].hp).toBe(50);
      const fresh = new LocalGameService((service as any).configService);
      const seen: any[] = []; fresh.messages$.subscribe(m => seen.push(m));
      fresh.send({ type: 'request_game_state' }); await flush();
      const snapshot = seen.find(m => m.type === 'game_state_update');
      expect(snapshot.boardState['3,0'].hp).toBe(50);
      expect(snapshot.moveHistory.at(-1).healedHex).toBe('3,0');
      // The heal resolves before overtime's toll, so an endangered king can be saved.
      const overtime = position(89); overtime.currentTurn = 'Solo'; overtime.moveHistory = [];
      overtime.boardState['-6,0'].hp = 1;
      service.send({ type: 'make_move', from: '0,0', to: '-2,0', heal: '-6,0' }); await flush();
      expect(last('move_made').boardState['-6,0'].hp).toBe(9);  // 1 + ring-4's 11 - toll 3
      expect(last('move_made').turnNumber).toBe(90);
      const counter = position(); counter.currentTurn = LOCAL_OPPONENT; counter.moveHistory = [];
      service.send({ type: 'make_move', from: '0,1', to: '0,1', attack: '0,0', bonuses: { targetAtk: 30 } });
      await flush();
      expect(last('move_made').move.counter_damage).toBe(0);
      expect(last('move_made').boardState['0,1'].hp).toBe(unitStats('pawn', DEFAULT_GAME_CONFIG, 1).hp);
    });

    it('commits and reloads normal healing for both players in every postmatch', async () => {
      for (const ply of [27, 28, 49, 50, 71, 72]) {
        const g = position(ply);
        const color = ply % 2 ? 'white' : 'black';
        g.currentTurn = color === 'white' ? 'Solo' : LOCAL_OPPONENT;
        g.endReason = ''; g.moveHistory = [];
        g.boardState['0,0'].color = color;
        g.boardState['3,0'].color = color;
        service.send({ type: 'make_move', from: '0,0', to: '1,0', heal: '3,0' });
        await flush();
        const made = last('move_made');
        expect(made.turnNumber).withContext(`ply ${ply}`).toBe(ply + 1);
        expect(made.boardState['3,0'].hp).toBe(14);
        expect(made.move.attacked).toBeFalse();
        const fresh = new LocalGameService((service as any).configService);
        const seen: any[] = []; fresh.messages$.subscribe(m => seen.push(m));
        fresh.send({ type: 'request_game_state' }); await flush();
        expect(seen.find(m => m.type === 'game_state_update').boardState['3,0'].hp).toBe(14);
      }
    });

    it('refuses invalid targets, combined actions, enemy strikes and opening heals atomically', async () => {
      const g = position(); const original = JSON.stringify(g.boardState);
      const bad: any[] = [
        { heal: '0,0' }, { heal: '0,1' }, { heal: '6,0' }, { heal: '-6,0' }, { heal: '2,0' },
        { heal: '12,-4' }, { heal: 'bad' }, { heal: 123 }, { heal: ',0' },
        { heal: '3,0', attack: '6,0' }, { heal: '3,0', withdraw: true },
        { attack: '6,0' }, { from: '3,0', to: '3,0', heal: '0,0' },
        { to: '1,0', heal: '6,0' },
      ];
      for (const data of bad) {
        service.send({ type: 'make_move', from: '0,0', to: '0,0', ...data }); await flush();
        expect(last('invalid_move')).withContext(JSON.stringify(data)).toBeDefined();
        expect(JSON.stringify(g.boardState)).toBe(original);
        expect(g.turnNumber).toBe(7);
        expect(g.moveHistory.length).toBe(0);
      }
      for (const ply of [1, 2, 5, 6]) {
        g.turnNumber = ply;
        service.send({ type: 'make_move', from: '0,0', to: '1,0', heal: '3,0' }); await flush();
        expect(JSON.stringify(g.boardState)).toBe(original);
        expect(g.turnNumber).toBe(ply);
      }
    });
  });

  it('lands the ability boosts the panel promises', async () => {
    // Two units toe to toe, written straight into the cache: the real setups
    // start twenty hexes apart and this is about the sums, not the walk.
    const config = (service as any).game.config;
    const position = (hp: number) => ({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: {
        '0,0': { unit_id: 'rook', color: 'white', hp, max_hp: hp, uid: 'w0,0' },
        '1,0': { unit_id: 'rook', color: 'black', hp, max_hp: hp, uid: 'b1,0' },
      },
      // Ply 7: the first on which anybody may swing at all.
      currentTurn: 'Solo', turnNumber: 7, moveHistory: [], winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    });

    const strike = async (bonuses?: any) => {
      localStorage.setItem('cpp.localGame.v1', JSON.stringify(position(200)));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      engine.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0', bonuses });
      await flush();
      return [...seen].reverse().find(m => m.type === 'move_made').move;
    };

    // Keep this boost test above the damage floor, independently of roster balance.
    config.units.rook.attack = 20;
    config.units.rook.defense = 10;
    const plain = await strike();
    expect(plain.damage_dealt).toBeGreaterThan(0);

    // +5 ATK lands five more; +5 on their armour takes five back off.
    expect((await strike({ atk: 5 })).damage_dealt).toBe(plain.damage_dealt + 5);
    expect((await strike({ targetDef: 5 })).damage_dealt).toBe(plain.damage_dealt - 5);
    // Their boost answers on the counter, not on our strike.
    const answered = await strike({ targetAtk: 6 });
    expect(answered.damage_dealt).toBe(plain.damage_dealt);
    expect(answered.counter_damage).toBe(plain.counter_damage + 6);
  });

  it('hands over to nobody on the move that ends the game', async () => {
    // consumers.py sends currentTurn '' with the last move_made; naming the
    // next player starts a clock and sounds a turn for a finished match.
    const config = (service as any).game.config;
    config.units.rook.attack = config.units.king.defense + hpOf('king') + 1;
    config.units.king.attack = 0;
    const kingHp = hpOf('king');
    const rookHp = hpOf('rook');
    localStorage.setItem('cpp.localGame.v1', JSON.stringify({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: {
        '0,0': { unit_id: 'rook', color: 'white', hp: rookHp, max_hp: rookHp, uid: 'w0,0' },
        '1,0': { unit_id: 'king', color: 'black', hp: 1, max_hp: kingHp, uid: 'b1,0' },
        '-5,0': { unit_id: 'king', color: 'white', hp: kingHp, max_hp: kingHp, uid: 'w-5,0' },
      },
      // Ply 7: the opening is over and Phase 1 is playing, so the killing blow
      // may land.
      currentTurn: 'Solo', turnNumber: 7, moveHistory: [], winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    }));
    const engine = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    engine.messages$.subscribe(m => seen.push(m));
    engine.send({ type: 'make_move', from: '0,0', to: '0,0', attack: '1,0' });
    await flush();

    const move = seen.find(m => m.type === 'move_made');
    expect(move.move.defender_eliminated).toBeTrue();
    expect(move.currentTurn).toBe('');
    expect(seen.find(m => m.type === 'game_over').endReason).toBe('regicide');
  });

  it('hands over to nobody when a pass runs the turn limit out', async () => {
    const config = JSON.parse(JSON.stringify((service as any).game.config));
    config.rules.maxTurns = 1;
    localStorage.setItem('cpp.localGame.v1', JSON.stringify({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: {}, currentTurn: 'Solo', turnNumber: 1, moveHistory: [],
      winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    }));
    const engine = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    engine.messages$.subscribe(m => seen.push(m));
    engine.send({ type: 'pass_turn' });
    await flush();

    expect(seen.find(m => m.type === 'turn_passed').currentTurn).toBe('');
    expect(seen.find(m => m.type === 'game_over').endReason).toBe('draw_max_turns');
  });

  /**
   * Overtime bleeds a commander an HP at the end of each of its side's turns,
   * and a commander on 1 dies of it. Real damage, not a mark - which is what
   * eventually settles a deathmatch neither side is winning on points.
   */
  describe('the overtime toll', () => {
    /** A game standing at `ply` with both kings on the HP given. */
    const at = (ply: number, whiteHp: number, blackHp = hpOf('king')) => {
      const config = JSON.parse(JSON.stringify((service as any).game.config));
      const kingHp = hpOf('king');
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-5,0': { unit_id: 'king', color: 'white', hp: whiteHp, max_hp: kingHp, uid: 'wk' },
          '5,0': { unit_id: 'king', color: 'black', hp: blackHp, max_hp: kingHp, uid: 'bk' },
        },
        // White plays the odd plies, so an odd `ply` is white's to pay for.
        currentTurn: ply % 2 ? 'Solo' : LOCAL_OPPONENT,
        turnNumber: ply, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      return { engine, seen, find: (t: string) => seen.find(m => m.type === t) };
    };

    it('takes nothing before overtime starts', async () => {
      const hp = Math.min(20, hpOf('king'));
      const g = at(71, hp);          // one full turn short of hand-over 73
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(hp);
    });

    it('takes one off the king of whoever just played', async () => {
      const hp = Math.min(20, hpOf('king'));
      const kingHp = hpOf('king');
      const white = at(73, hp);
      white.engine.send({ type: 'pass_turn' });
      await flush();
      let board = white.find('turn_passed').boardState;
      expect(board['-5,0'].hp).toBe(hp - 1);   // white paid
      expect(board['5,0'].hp).toBe(kingHp);    // black did not

      const black = at(74, hp);
      black.engine.send({ type: 'pass_turn' });
      await flush();
      board = black.find('turn_passed').boardState;
      expect(board['-5,0'].hp).toBe(hp);
      expect(board['5,0'].hp).toBe(kingHp - 1);
    });

    it('kills a king on 1, and the game ends with it', async () => {
      const g = at(73, 1);
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0']).toBeUndefined();
      // Hands over to nobody, and black takes it.
      expect(g.find('turn_passed').currentTurn).toBe('');
      expect(g.find('game_over').endReason).toBe('regicide');
      expect(g.find('game_over').winner).toBe(LOCAL_OPPONENT);
    });

    it('under elimination, a king the toll kills loses nothing while his army stands', async () => {
      // Elimination ends when a side has no units at all. This called the
      // felled king a defeat on a pass - `move` never did - and the server's
      // pass does not either, so the two engines would disagree about whether
      // a networked match was over.
      const config = JSON.parse(JSON.stringify((service as any).game.config));
      config.rules = { ...config.rules, objective: 'elimination' };
      const kingHp = hpOf('king');
      const pawnHp = hpOf('pawn');
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-5,0': { unit_id: 'king', color: 'white', hp: 1, max_hp: kingHp, uid: 'wk' },
          '-4,0': { unit_id: 'pawn', color: 'white', hp: pawnHp, max_hp: pawnHp, uid: 'wp' },
          '5,0': { unit_id: 'king', color: 'black', hp: kingHp, max_hp: kingHp, uid: 'bk' },
        },
        currentTurn: 'Solo', turnNumber: 73, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));

      engine.send({ type: 'pass_turn' });
      await flush();

      const passed = seen.find(m => m.type === 'turn_passed');
      expect(passed.boardState['-5,0']).toBeUndefined();
      expect(passed.currentTurn).toBeTruthy();
      expect(seen.find(m => m.type === 'game_over')).toBeUndefined();
    });

    it('saves a king healed off 1 before the turn commits', async () => {
      // The owner's report: "after healing it from 1hp, it dies next turn
      // anyways". No engine holds an ability, so a heal on a unit standing on
      // the BOARD has to be sent as its own message - only the panel half ever
      // was. The mend lived on the room's staged board, the toll came off the
      // 1 HP the engine still had, and the king died anyway.
      const kingHp = hpOf('king');
      const g = at(73, 1);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: kingHp }] });
      await flush();
      // Healed to full, then the toll takes one back off.
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(kingHp - 1);
      expect(g.find('game_over')).toBeUndefined();
    });

    it('finds a cast\'s unit by uid when the hex it names is stale', async () => {
      // Addressed by hex alone, a mend on a unit the client had walked fell on
      // an empty square and was silently dropped.
      const kingHp = hpOf('king');
      const g = at(73, 1);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-4,0', uid: 'wk', hp: kingHp }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(kingHp - 1);
    });

    it('keeps none of a turn\'s casts when it refuses the turn', async () => {
      // Sent as messages of their own, the casts were kept before the move was
      // looked at, so a refused move came back half-played.
      const hp = Math.min(12, hpOf('king'));
      const g = at(21, hp);
      g.engine.send({
        type: 'make_move', from: '-5,0', to: '9,9',
        effectsBefore: [{ at: '-5,0', uid: 'wk', hp: hpOf('king') }],
      });
      await flush();
      expect(g.find('invalid_move')).toBeDefined();
      const game = (g.engine as any).game;
      expect(game.boardState['-5,0'].hp).toBe(hp);
      expect(game.moveHistory.length).toBe(0);
    });

    it('never ends the match on a cast that killed nothing', async () => {
      // The same line `pass()` draws: a side can hold no commander on the
      // BOARD for reasons of its own - one that walked home into its base is
      // off the board and still alive. Checking who is beaten on every cast
      // meant a heal on your own pawn could end a match it had no part in.
      // Black holds no commander on the board - a hand-built position. A mend
      // on white's own king must not read that as a regicide.
      const hp = Math.max(1, hpOf('king') - 1);
      const g = at(20, hp);
      delete (g.engine as any).game.boardState['5,0'];
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp, uid: 'wk' }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(hp);
      expect(g.find('game_over')).toBeUndefined();
    });

    it('lands a cast made after the blow after the blow', async () => {
      // A cast carries the HP the client worked out for the turn, blow
      // included. Sent ahead of the move, the engine wrote it and then
      // resolved the blow over the top: a king mended after taking a counter
      // lost the mend.
      const kingHp = hpOf('king');
      const g = at(21, kingHp);
      const game = (g.engine as any).game;
      game.boardState = { '-5,0': game.boardState['-5,0'], '-4,0': game.boardState['5,0'] };
      g.engine.send({
        type: 'make_move', from: '-5,0', to: '-5,0', attack: '-4,0',
        effects: [{ at: '-5,0', uid: 'wk', hp: kingHp }],
      });
      await flush();
      const made = g.find('move_made');
      expect(made.move.counter_damage).toBeGreaterThan(0);
      expect(made.boardState['-5,0'].hp).toBe(kingHp);
    });

    it('never writes an HP past what the unit can hold', async () => {
      const g = at(20, 12);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: 900, uid: 'wk' }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0'].hp).toBe(hpOf('king'));
    });

    it('ends the match when a cast takes the last king off the board', async () => {
      // A commander killed by an ability is a commander killed. Left out, the
      // game carried on with a side that had already lost.
      const g = at(20, 12);
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: '-5,0', hp: 0 }] });
      await flush();
      expect(g.find('turn_passed').boardState['-5,0']).toBeUndefined();
      expect(g.find('game_over').endReason).toBe('regicide');
      expect(g.find('game_over').winner).toBe(LOCAL_OPPONENT);
    });

    it('takes its toll after the turn, not before it', async () => {
      // The king walks, and the toll comes off where it ended up - not off
      // the HP it had when the turn started, and not instead of the walk.
      const g = at(73, 20);
      g.engine.send({ type: 'make_move', from: '-5,0', to: '-4,0' });
      await flush();
      const board = g.find('move_made').boardState;
      expect(board['-5,0']).toBeUndefined();
      expect(board['-4,0'].hp).toBe(19);
    });
  });

  /**
   * The schedule's two endings, which this engine enforces the way the server
   * does (match-score.ts): a side past the other's margin once Phase 3 has
   * banked and its postmatch is played wins on points, and a match still
   * standing once turn 50 is played out is black's. Both kings stand on the rim of a side zone each - one occupied
   * hex apiece - so whatever the board banks, it banks level.
   */
  describe('the schedule\'s endings', () => {
    const at = (ply: number, phaseBank: any = {}, blackHp = hpOf('king')) => {
      const config = JSON.parse(JSON.stringify((service as any).game.config));
      const kingHp = hpOf('king');
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-5,0': { unit_id: 'king', color: 'white', hp: kingHp, max_hp: kingHp, uid: 'wk' },
          '5,0': { unit_id: 'king', color: 'black', hp: blackHp, max_hp: kingHp, uid: 'bk' },
        },
        currentTurn: ply % 2 ? 'Solo' : LOCAL_OPPONENT,
        turnNumber: ply, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {}, phaseBank,
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      return { engine, seen, find: (t: string) => seen.find(m => m.type === t) };
    };

    it('banks a phase on the hand-over into its postmatch, and hands the bank out', async () => {
      const g = at(26);   // black's half of turn 13, the last of Phase 1's play
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').phaseBank).toEqual({ 1: { white: 1, black: 1 } });
      // And it is the game's: a reload brings it back.
      g.engine.send({ type: 'request_game_state' });
      await flush();
      expect(g.find('game_state_update').phaseBank).toEqual({ 1: { white: 1, black: 1 } });
    });

    it('ends the match at the end of turn 50, with both kings standing - black\'s', async () => {
      const g = at(99);
      // White's half of turn 50 is played, and the match goes on.
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('game_over')).toBeUndefined();
      expect(g.find('turn_passed').currentTurn).toBe(LOCAL_OPPONENT);
      // Black's half ends it.
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('game_over')).toEqual(jasmine.objectContaining({
        winner: LOCAL_OPPONENT, endReason: 'overtime',
      }));
      expect(g.seen.filter(m => m.type === 'turn_passed')[1].currentTurn).toBe('');
    });

    it('ends it the same on a move that plays turn 50 out', async () => {
      // A move hands over through its own path, not the pass's: both ask.
      const g = at(100);
      g.engine.send({ type: 'make_move', from: '5,0', to: '6,0' });
      await flush();
      expect(g.find('move_made').currentTurn).toBe('');
      expect(g.find('game_over')).toEqual(jasmine.objectContaining({
        winner: LOCAL_OPPONENT, endReason: 'overtime',
      }));
    });

    it('but a king the last toll kills still loses by regicide', async () => {
      // The board decides before the schedule does.
      const g = at(100, {}, 3);
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('game_over')).toEqual(jasmine.objectContaining({
        winner: 'Solo', endReason: 'regicide',
      }));
    });

    /** Pass `n` hand-overs in a row. */
    const passes = async (g: { engine: LocalGameService }, n: number) => {
      for (let i = 0; i < n; i++) {
        g.engine.send({ type: 'pass_turn' });
        await flush();
      }
    };

    it("plays Phase 3's postmatch out, then ends the match on points", async () => {
      // Phase 3 banks as its postmatch begins and the result is known there,
      // but the postmatch is still played - "phase 3 post match still happens
      // even if overtime isnt triggered" - and the match ends as it does.
      const g = at(70, { 1: { white: 12, black: 0 }, 2: { white: 0, black: 0 } });
      await passes(g, 1);   // black's half of turn 35: into the postmatch
      // Four hexes apiece, tripled in Phase 3.
      expect(g.find('turn_passed').phaseBank[3]).toEqual({ white: 3, black: 3 });
      expect(g.find('turn_passed').currentTurn).toBe('Solo');
      await passes(g, 1);   // white's half of the postmatch
      expect(g.find('game_over')).toBeUndefined();
      await passes(g, 1);   // black's: out of it, into turn 37
      expect(g.seen.filter(m => m.type === 'turn_passed')[2].currentTurn).toBe('');
      expect(g.find('game_over')).toEqual(jasmine.objectContaining({
        winner: 'Solo', endReason: 'points',
      }));
    });

    it('plays a close match on into overtime', async () => {
      // Ten clear is not more than ten.
      const g = at(70, { 1: { white: 10, black: 0 }, 2: { white: 0, black: 0 } });
      await passes(g, 3);
      expect(g.find('game_over')).toBeUndefined();
      expect(g.seen.filter(m => m.type === 'turn_passed')[2].currentTurn).toBe('Solo');
    });

    it('decides nothing on points while a phase was banked late', async () => {
      // Phase 1 banked after its moment, off the wrong board: Phase 3 banks on
      // time, white reads nine clear, and the match still goes on past the
      // postmatch.
      const g = at(70, { 1: { white: 12, black: 0, late: true }, 2: { white: 0, black: 0 } });
      await passes(g, 3);
      expect(g.find('turn_passed').phaseBank[3].late).toBeUndefined();
      expect(g.find('game_over')).toBeUndefined();
    });

    it('does not end a match on a Phase 3 bank taken late', async () => {
      // A game saved past the moment banks Phase 3 at its next hand-over, off
      // a board that no longer shows how Phase 3 finished - and plays on.
      const g = at(80, { 1: { white: 12, black: 0 }, 2: { white: 0, black: 0 } });
      g.engine.send({ type: 'pass_turn' });
      await flush();
      expect(g.find('turn_passed').phaseBank[3]).toBeDefined();
      expect(g.find('game_over')).toBeUndefined();
    });
  });

  it('ends on resign, with the other seat winning', async () => {
    service.send({ type: 'resign' });
    await flush();
    expect(last('game_over')).toEqual(jasmine.objectContaining({
      winner: LOCAL_OPPONENT, endReason: 'resign', resignedBy: 'Solo',
    }));
  });

  /**
   * The rules this engine can keep without a panel model, a purse or an
   * ability catalogue - so they hold today and do not have to be written
   * twice when those settle. The board's click handler keeps an honest player
   * inside them; these are what a console runs into.
   *
   * What is deliberately NOT here: how far a panel walk went, which panel a
   * unit stood in, and whether a side could afford the wrap. Each wants
   * something this engine has not got, and the purse also holds what
   * abilities have paid in and out - see 6.15 and 6.17.
   */
  it('calls a blow into a panel that leaves no commander standing a draw', async () => {
    // Every hand-over settles the match in one place now. The panel blow's
    // copy of the order had no mutual draw in it, so a blow that left both
    // sides without a commander went to black by regicide, off nothing more
    // than list order. No commander on either side is the plainest way there.
    const config = (service as any).game.config;
    localStorage.setItem('cpp.localGame.v1', JSON.stringify({
      username: 'Solo', hostColor: 'white', started: true, config,
      boardState: { '-5,9': { unit_id: 'pawn', color: 'white', hp: hpOf('pawn'), max_hp: hpOf('pawn'), uid: 'wp' } },
      currentTurn: 'Solo', turnNumber: 9, moveHistory: [], winner: '', endReason: '',
      turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
    }));
    const engine = new LocalGameService((service as any).configService);
    const seen: any[] = [];
    engine.messages$.subscribe(m => seen.push(m));
    const home = fullUnit('rook', 'black', 'rtr0');
    engine.send({
      type: 'panel_attack', intoPanel: true, panel: 'tr',
      from: '-5,9', attack: '-5,8', unit: home,
    });
    await flush();
    expect(seen.find(m => m.type === 'move_made')).toBeDefined();
    expect(seen.find(m => m.type === 'game_over')).toEqual(jasmine.objectContaining({
      winner: '', endReason: 'draw_mutual',
    }));
  });

  describe('the rules it keeps without a panel', () => {
    /** A reserve unit of white's, as a panel message carries one. */
    const reserve = (uid: string, over: any = {}) => ({
      unit_id: 'pawn', color: 'white', hp: hpOf('pawn'), max_hp: hpOf('pawn'), uid, ...over,
    });

    /**
     * A cached position at `ply`, white to play, with whatever board is given.
     * The windows are read off the ply and nothing else, so these need no
     * panel, no purse and no history - which is the point of them.
     */
    const at = (ply: number, boardState: any = {}, config = (service as any).game.config) => {
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config, boardState,
        currentTurn: ply % 2 ? 'Solo' : LOCAL_OPPONENT,
        turnNumber: ply, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      return {
        engine, seen,
        refusal: () => seen.filter(m => m.type === 'invalid_move').slice(-1)[0]?.message,
      };
    };

    /**
     * A white pawn standing on `at`, which is all a walk home needs - plus
     * both kings, because a board with no commander on it is a mutual defeat
     * under regicide and the game would end on the first move that committed.
     */
    const walker = (at: string, uid = 'w1') => ({
      [at]: { unit_id: 'pawn', color: 'white', hp: hpOf('pawn'), max_hp: hpOf('pawn'), uid },
    });
    const kings = {
      '0,0': { unit_id: 'king', color: 'white', hp: hpOf('king'), max_hp: hpOf('king'), uid: 'wk' },
      '1,0': { unit_id: 'king', color: 'black', hp: hpOf('king'), max_hp: hpOf('king'), uid: 'bk' },
    };

    it('refuses an attack in a postmatch, and says which turn', async () => {
      // Turn 14 - Phase 1's postmatch, plies 27 and 28 - refuses a blow for
      // the same reason the opening does, and saying "the opening" there
      // points at a phase that ended at turn 3.
      const g = at(27, { ...kings, ...walker('-5,9') });
      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '-5,8' });
      await flush();
      expect(g.refusal()).toBe('Nobody attacks in the postmatch');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();
    });

    it('lets a blow land on turn 4, which used to be a setup turn and now plays', async () => {
      // Phase 1's extra turn moved from its start to its end, so the turn
      // straight after the opening is a turn of play. Refused here, it would
      // be the four-setup-turn opening the move was made to get rid of.
      const g = at(7, {
        ...kings, ...walker('-5,9'),
        '-5,8': { unit_id: 'pawn', color: 'black', hp: hpOf('pawn'), max_hp: hpOf('pawn'), uid: 'b1' },
      });
      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '-5,8' });
      await flush();
      expect(g.refusal()).toBeUndefined();
      expect(g.seen.find(m => m.type === 'move_made').move.damage_dealt).toBeGreaterThan(0);
    });

    it('refuses a crossing that would stop past its own first three rows', async () => {
      // Row 8 is one short of white's own ground. The engine has no panel to
      // check the walk with, but where a crossing may STOP is a question about
      // the hex and the mover's colour, and it can answer that.
      service.send({ type: 'enter_board', from: 'bl-1', to: '3,8', unit: reserve('r1') });
      await flush();
      expect(last('invalid_move').message)
        .toBe('A crossing stops in your own first three rows');
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['3,8']).toBeUndefined();
    });

    it('refuses a crossing while the way in is shut', async () => {
      // Ply 15 is turn 8, Phase 1's played first half - when the wrap runs and
      // the three ways in do not.
      const g = at(15);
      g.engine.send({ type: 'enter_board', from: 'bl-1', to: '-10,9', unit: reserve('r1') });
      await flush();
      expect(g.refusal()).toBe('The way in is shut');
    });

    it('starts five out of a reserve in a postmatch, and no more', async () => {
      // Five stands INSTEAD of the per-panel three on that turn, so the fourth
      // and fifth go through and the sixth does not. Ply 27 is turn 14, Phase
      // 1's postmatch.
      const hexes = ['-10,9', '-8,9', '-6,9', '-3,9', '-1,9', '1,9'];
      const g = at(27);
      hexes.forEach((to, i) => g.engine.send({
        type: 'enter_board', from: 'bl-1', to, unit: reserve(`r${i}`),
      }));
      await flush();
      expect(g.refusal()).toBe('That reserve has started its units for the turn');
      g.engine.send({ type: 'request_game_state' });
      await flush();
      const board = g.seen.filter(m => m.type === 'game_state_update').slice(-1)[0].boardState;
      expect(hexes.filter(h => board[h]).length).toBe(5);
    });

    it("reads a postmatch's entries off the game's config", async () => {
      // rules.postmatchEntries: a room that says two stops the third.
      const rules = (service as any).game.config.rules;
      const saved = rules.postmatchEntries;
      rules.postmatchEntries = 2;
      try {
        const g = at(27);
        ['-10,9', '-8,9', '-6,9'].forEach((to, i) => g.engine.send({
          type: 'enter_board', from: 'bl-1', to, unit: reserve(`r${i}`),
        }));
        await flush();
        expect(g.refusal()).toBe('That reserve has started its units for the turn');
      } finally {
        rules.postmatchEntries = saved;
      }
    });

    it('refuses a walk home while the way home is shut', async () => {
      // Both halves of a numbered phase's play shut the base doorways.
      const g = at(15, { ...kings, ...walker('-11,11') });
      g.engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
      await flush();
      expect(g.refusal()).toBe('The way home is shut');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();
    });

    it('refuses a walk home from outside its own first three rows', async () => {
      // Row 8 again: a unit that has pushed up the board walks back down into
      // its own ground before it can walk off it. On a postmatch, where the
      // way home is open, so the rows are what refuse it.
      const g = at(27, { ...kings, ...walker('-11,8') });
      g.engine.send({ type: 'make_move', from: '-11,8', to: '-12,8', withdraw: true });
      await flush();
      expect(g.refusal()).toBe('Only your own first three rows walk home');
    });

    it("reads a setup turn's walks home off the game's config", async () => {
      // rules.homecomingsPerSetupTurn: a room that says one stops the second.
      const rules = (service as any).game.config.rules;
      const saved = rules.homecomingsPerSetupTurn;
      rules.homecomingsPerSetupTurn = 1;
      try {
        const g = at(27, { ...kings, ...walker('-11,11', 'w1'), ...walker('-10,11', 'w2') });
        g.engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
        await flush();
        expect(g.refusal()).toBeUndefined();
        g.engine.send({ type: 'make_move', from: '-10,11', to: '-12,10', withdraw: true });
        await flush();
        expect(g.refusal()).toBe('That is all who may walk home this turn');
      } finally {
        rules.homecomingsPerSetupTurn = saved;
      }
    });

    it('walks three home in a setup turn and no more', async () => {
      // Ply 27, Phase 1's postmatch.
      const g = at(27, {
        ...kings,
        ...walker('-11,11', 'w1'), ...walker('-10,11', 'w2'),
        ...walker('-8,11', 'w3'), ...walker('-7,11', 'w4'),
      });
      // All three inside the one turn, nothing wound between them. A walk
      // home on a setup turn is deployment, not the turn's board action, so
      // it hands the seat to nobody - which is the only reason a count of
      // three is reachable. It used to end the turn on the first walk, and
      // this spec had to put the seat and the ply back by hand to pretend
      // otherwise; that the fake was needed was the bug showing through.
      const walks: Array<[string, string]> = [
        ['-11,11', '-12,11'], ['-10,11', '-12,10'],
        ['-8,11', '-12,9'], ['-7,11', '-12,8'],
      ];
      for (const [from, to] of walks) {
        g.engine.send({ type: 'make_move', from, to, withdraw: true });
        await flush();
      }
      expect(g.refusal()).toBe('That is all who may walk home this turn');
      // Three went, and the turn is still the one they went on.
      expect((g.engine as any).game.turnNumber).toBe(27);
      expect(g.seen.filter(m => m.type === 'game_state_update').length).toBe(3);
      expect(g.seen.filter(m => m.type === 'move_made').length).toBe(0);
    });

    it('counts nobody home in overtime, where the doorways never shut', async () => {
      // The owner's exception: overtime is not a setup turn, so the three do
      // not apply - the turn's own move allowance is the only cap there.
      const g = at(73, { ...kings, ...walker('-11,11') });
      g.engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
      await flush();
      expect(g.refusal()).toBeUndefined();
      expect(g.seen.find(m => m.type === 'move_made')).toBeDefined();
    });

    it('commits postmatch HP casts on passes and moves, including a Dash-length walk', async () => {
      for (const ply of [27, 28, 49, 50, 71, 72]) {
        const color = ply % 2 ? 'white' : 'black';
        const board = { ...kings, '-5,5': { ...fullUnit('pawn', color, 'actor'), hp: 4 } };
        const cast = [{ uid: 'actor', at: '-5,5', hp: 8 }];
        for (const type of ['pass_turn', 'make_move']) {
          const g = at(ply, structuredClone(board));
          g.engine.send({ type, effectsBefore: cast,
            ...(type === 'make_move' ? { from: '-5,5', to: '-5,-2', moveBonus: 4, bonuses: { atk: 8 } } : {}),
          });
          await flush();
          expect(g.refusal()).withContext(`${ply}: ${type}`).toBeUndefined();
          const made = g.seen.find(m => m.type === (type === 'make_move' ? 'move_made' : 'turn_passed'));
          expect(made.boardState[type === 'make_move' ? '-5,-2' : '-5,5'].hp).toBe(8);
          expect(made.turnNumber).toBe(ply + 1);
          const fresh = new LocalGameService((service as any).configService);
          const restored: any[] = []; fresh.messages$.subscribe(m => restored.push(m));
          fresh.send({ type: 'request_game_state' }); await flush();
          expect(restored.find(m => m.type === 'game_state_update').boardState).toEqual(made.boardState);
        }
      }
    });

    it('refuses boosted normal attacks and enemy landings in both halves of every postmatch', async () => {
      for (const ply of [27, 28, 49, 50, 71, 72]) {
        const color = ply % 2 ? 'white' : 'black';
        const board = { ...kings,
          '-5,5': fullUnit('pawn', color, 'actor'),
          '-4,5': fullUnit('pawn', color === 'white' ? 'black' : 'white', 'enemy'),
        };
        for (const action of [{ to: '-5,5', attack: '-4,5' }, { to: '-4,5' }]) {
          const g = at(ply, structuredClone(board));
          const before = structuredClone((g.engine as any).game.boardState);
          g.engine.send({ type: 'make_move', from: '-5,5', bonuses: { atk: 8 }, ...action });
          await flush();
          expect(g.refusal()).toBeDefined();
          expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();
          expect((g.engine as any).game.boardState).toEqual(before);
        }
      }
    });

    it('lets a Phase 3 postmatch cast kill a king before points or overtime can settle the match', async () => {
      for (const ply of [71, 72]) {
        const victim = ply % 2 ? '1,0' : '0,0';
        const g = at(ply, structuredClone(kings));
        (g.engine as any).game.phaseBank = { 1: { white: 0, black: 100 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
        g.engine.send({ type: 'pass_turn', effectsBefore: [{ at: victim, uid: kings[victim as keyof typeof kings].uid, hp: 0 }] });
        await flush();
        expect(g.seen.find(m => m.type === 'game_over')).toEqual(jasmine.objectContaining({
          winner: ply % 2 ? 'Solo' : LOCAL_OPPONENT, endReason: 'regicide',
        }));
      }
    });

    it('fires no ability during the opening', async () => {
      // The opening refuses casts arriving with either a move or a pass.
      const g = at(1, { ...kings, ...walker('-5,9') });
      g.engine.send({
        type: 'make_move', from: '-5,9', to: '-5,8',
        effectsBefore: [{ uid: 'w1', hp: 6, at: '-5,9' }],
      });
      await flush();
      expect(g.refusal()).toBe('No ability fires while a side is setting out');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();

      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,8',
        effectsAfterAttack: [{ uid: 'w1', hp: 6, at: '-5,9' }] });
      await flush();
      expect(g.refusal()).toBe('No ability fires while a side is setting out');
      expect(g.seen.find(m => m.type === 'move_made')).toBeUndefined();

      // A pass is the other way a cast reaches the engine.
      g.engine.send({ type: 'pass_turn', effectsBefore: [{ uid: 'w1', hp: 6, at: '-5,9' }] });
      await flush();
      expect(g.seen.find(m => m.type === 'turn_passed')).toBeUndefined();

      // A zero is not a use: an ordinary move still goes through.
      g.engine.send({ type: 'make_move', from: '-5,9', to: '-5,8', moveBonus: 0, bonuses: {} });
      await flush();
      expect(g.seen.find(m => m.type === 'move_made')).toBeDefined();
    });

    it('reads a bonus as a number, both ways round', async () => {
      // `Number(x) || 0` was inert as a guard: nonsense came back NaN, which
      // is falsy, so it passed for "no ability"; a negative one is truthy, so
      // it refused a move no ability had touched.
      const nonsense = at(1, { ...kings, ...walker('-5,9') });
      nonsense.engine.send({
        type: 'make_move', from: '-5,9', to: '-5,8', moveBonus: 'x' as any,
      });
      await flush();
      expect(nonsense.refusal()).toBe('No ability fires while a side is setting out');

      const negative = at(1, { ...kings, ...walker('-5,9') });
      negative.engine.send({
        type: 'make_move', from: '-5,9', to: '-5,8', bonuses: { atk: -1 } as any,
      });
      await flush();
      expect(negative.refusal()).toBe('No ability fires while a side is setting out');
    });

    it('takes the extra steps an ability lent, past the old cap of 10', async () => {
      // The test fixture gives its pawn 5 MOV; -5,9 to 6,-8 is 17 steps. The
      // engine capped a bonus at 10, so a Surge the config made 12 was offered
      // on the board and refused here.
      const slowerPawnConfig = JSON.parse(JSON.stringify((service as any).game.config));
      slowerPawnConfig.units.pawn.move = 5;
      const capped = at(11, { ...kings, ...walker('-5,9') }, slowerPawnConfig);
      capped.engine.send({ type: 'make_move', from: '-5,9', to: '6,-8', moveBonus: 10 });
      await flush();
      expect(capped.seen.find(m => m.type === 'move_made')).toBeUndefined();

      const lent = at(11, { ...kings, ...walker('-5,9') }, slowerPawnConfig);
      lent.engine.send({ type: 'make_move', from: '-5,9', to: '6,-8', moveBonus: 12 });
      await flush();
      expect(lent.refusal()).toBeUndefined();
      expect(lent.seen.find(m => m.type === 'move_made')).toBeDefined();
    });

    it('refuses an attack in the opening', async () => {
      // The board never offered one; nothing else said no, so a crafted
      // message could open the match by swinging.
      service.send({ type: 'make_move', from: '-5,9', to: '-5,9', attack: '-5,8' });
      await flush();
      expect(last('invalid_move').message).toBe('Nobody attacks in the opening');
      expect(last('move_made')).toBeUndefined();
    });

    it('refuses a blow into a panel in the opening', async () => {
      service.send({
        type: 'panel_attack', intoPanel: true, panel: 'tr',
        from: '-5,9', attack: '-5,8',
        unit: fullUnit('rook', 'black', 'rtr0'),
      });
      await flush();
      expect(last('invalid_move').message).toBe('Nobody attacks in the opening');
      expect(last('move_made')).toBeUndefined();
    });

    it('gives a battlefield unit one move for the whole opening', async () => {
      service.send({ type: 'make_move', from: '-5,9', to: '-5,8' });
      await flush();
      expect(last('move_made').move.moved).toBeTrue();
      // Round to white again, still inside the opening.
      service.send({ type: 'pass_turn' });
      await flush();
      expect(last('turn_passed').turnNumber).toBe(3);

      service.send({ type: 'make_move', from: '-5,8', to: '-5,7' });
      await flush();
      expect(last('invalid_move').message).toBe('That unit has had its move for the opening');
      // It has not budged.
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['-5,8'].unit_id).toBe('pawn');
    });

    it('refuses a crossing by a unit already standing on the board', async () => {
      // The uid is the one on -5,9 in the dealt setup, so this is that unit
      // asking to be in two places at once.
      const standing = last('game_started').boardState['-5,9'];
      service.send({
        type: 'enter_board', from: 'bl-1', to: '0,0',
        unit: { ...standing, hp: hpOf(standing.unit_id) },
      });
      await flush();
      expect(last('invalid_move').message).toBe('That unit is already on the board');
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['0,0']).toBeUndefined();
    });

    it('refuses a panel message naming a unit the config never heard of', async () => {
      service.send({
        type: 'enter_board', from: 'bl-1', to: '0,0',
        unit: reserve('made-up', { unit_id: 'dragon' }),
      });
      await flush();
      expect(last('invalid_move').message).toBe('No such unit');
    });

    it('clamps a crossing unit to the HP its own config allows', async () => {
      service.send({
        type: 'enter_board', from: 'bl-1', to: '-10,9', unit: reserve('r1', { hp: 9999 }),
      });
      await flush();
      service.send({ type: 'request_game_state' });
      await flush();
      // The configured pawn HP, not the 9999 it asked for. A cast may have mended or hurt
      // it in the panel, so a lower number is still taken on trust.
      expect(last('game_state_update').boardState['-10,9'].hp).toBe(hpOf('pawn'));
    });

    it('starts three of a panel in a turn and no more', async () => {
      const hexes = ['-10,9', '-8,9', '-6,9', '-3,9'];
      hexes.forEach((to, i) => service.send({
        type: 'enter_board', from: 'bl-1', to, unit: reserve(`r${i}`),
      }));
      await flush();
      expect(last('invalid_move').message)
        .toBe('That reserve has started its units for the turn');
      service.send({ type: 'request_game_state' });
      await flush();
      const board = last('game_state_update').boardState;
      expect(hexes.filter(h => board[h]).length).toBe(3);
    });

    it('locks a panel unit out for the rest of the opening once it has moved', async () => {
      // A walk inside a panel, so the unit is still in the panel afterwards -
      // a crossing would put it on the board, which is refused first and for
      // a different reason.
      const walk = (to: string) => service.send({
        type: 'panel_move', from: 'bl-1', to, panel: 'bl', cost: 1, unit: reserve('r1'),
      });
      walk('bl-2');
      await flush();
      expect(last('invalid_move')).toBeUndefined();

      // A panel walk does not end the turn, so two passes come back round to
      // white - still inside the opening.
      service.send({ type: 'pass_turn' });
      service.send({ type: 'pass_turn' });
      await flush();
      expect(last('turn_passed').turnNumber).toBe(3);

      walk('bl-3');
      await flush();
      expect(last('invalid_move').message)
        .toBe('That unit has had its move for the opening');
    });

    it('refuses a crossing by a unit the record says is dead', async () => {
      // A panel unit a cast emptied is off the roster the server rebuilds.
      // Flooring the HP at 1 walked it onto the board instead of refusing it.
      service.send({
        type: 'enter_board', from: 'bl-1', to: '-10,9', unit: reserve('r1', { hp: 0 }),
      });
      await flush();
      expect(last('invalid_move').message).toBe('Nothing is standing there');
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['0,0']).toBeUndefined();
    });

    it("takes a crossing unit's ceiling from config, not from the message", async () => {
      // max_hp is what every later cast is clamped against, so trusting it
      // undid the HP clamp one mend later.
      service.send({
        type: 'enter_board', from: 'bl-1', to: '-10,9',
        unit: reserve('r1', { hp: hpOf('pawn'), max_hp: 9999 }),
      });
      await flush();
      service.send({ type: 'request_game_state' });
      await flush();
      expect(last('game_state_update').boardState['-10,9'].max_hp).toBe(hpOf('pawn'));
    });

    it('refuses a blow into a panel against a unit the config never heard of', async () => {
      // The defender is named by the message too. Unchecked, strikeDamage read
      // an undefined unit out of config and the record went into the history.
      await pastOpening();
      service.send({
        type: 'panel_attack', intoPanel: true, panel: 'tr', from: '-5,9', attack: '-5,8',
        unit: { unit_id: 'dragon', color: 'black', hp: 1, max_hp: 1, uid: 'z' },
      });
      await flush();
      expect(last('invalid_move').message).toBe('No such unit');
      expect(last('move_made')).toBeUndefined();
    });

    it('refuses the wrap while it is shut', async () => {
      // The schedule needs only the ply, so it needs none of the three things
      // this engine has not got. Turns 9-13 are Phase 1's halftime half, with
      // the wrap shut; ply 19 is turn 10. `panel_move_targets` offers no wrap
      // there at all.
      const config = (service as any).game.config;
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {}, currentTurn: 'Solo', turnNumber: 19, moveHistory: [],
        winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      engine.send({
        type: 'panel_move', from: 'bl-1', to: 'tr-1', panel: 'bl',
        cost: 2, price: 5, unit: reserve('r9'),
      });
      await flush();
      expect(seen.find(m => m.type === 'invalid_move').message).toBe('The wrap is shut');
    });

    it('names the rule that refuses the king his walk home', async () => {
      // "Illegal move" sends the player looking for a doorway that works.
      const config = (service as any).game.config;
      localStorage.setItem('cpp.localGame.v1', JSON.stringify({
        username: 'Solo', hostColor: 'white', started: true, config,
        boardState: {
          '-11,11': {
            unit_id: 'king', color: 'white', hp: hpOf('king'), max_hp: hpOf('king'), uid: 'wk',
          },
        },
        // Turn 14, Phase 1's postmatch: the way home is open there, so the
        // king is refused by his own rule and not by a shut doorway.
        currentTurn: 'Solo', turnNumber: 27, moveHistory: [], winner: '', endReason: '',
        turnStartedAt: new Date().toISOString(), mode: 'default', options: {},
      }));
      const engine = new LocalGameService((service as any).configService);
      const seen: any[] = [];
      engine.messages$.subscribe(m => seen.push(m));
      engine.send({ type: 'make_move', from: '-11,11', to: '-12,11', withdraw: true });
      await flush();
      expect(seen.find(m => m.type === 'invalid_move').message)
        .toBe('The king never walks home');
      expect(seen.find(m => m.type === 'move_made')).toBeUndefined();
    });

    it('charges the wrap what the unit is worth, not what the message says', async () => {
      // Config sets the price even when the message names a bargain.
      //
      // Past the setup turns first: the wrap is shut on every one of them, so
      // the crossing would be refused before its price was ever worked out.
      await pastOpening();
      service.send({
        type: 'panel_move', from: 'bl-1', to: 'tr-1', panel: 'bl',
        cost: 2, price: 1, unit: reserve('r9'),
      });
      await flush();
      service.send({ type: 'request_game_state' });
      await flush();
      const walk = last('game_state_update').moveHistory.slice(-1)[0];
      expect(walk.panelMove).toBeTrue();
      expect(walk.price).toBe(valueOf('pawn')); // the pawn's value, not the 1 sent
      expect(walk.cost).toBe(2);               // what it cost to walk is still theirs
    });
  });
});
