import { BehaviorSubject, Subject, of } from 'rxjs';
import { GameRoomComponent } from './game-room.component';
import { GameStateService } from '../../services/game-state.service';
import { LocalGameService } from '../../services/local-game.service';
import { DEFAULT_GAME_CONFIG, ConfigService, ruleOf } from '../../services/config.service';
import { advanceBuffs, stackEffect, statSetting, passiveStat } from '../../services/ability-rules';
import { carries, combatExchange, combatStatuses } from '../../services/unit-combat';
import { turnHeading } from '../../services/phases';
import { unitPoints } from '../../services/match-score';
import { NavigationStateService } from '../../services/navigation-state.service';
import legacyAbilities from '../../services/legacy-abilities.fixture.json';

// Earlier saved catalogues keep their targeting, prices and effects.
const LEGACY_GAME_CONFIG = { ...DEFAULT_GAME_CONFIG,
  units: Object.fromEntries(Object.entries(DEFAULT_GAME_CONFIG.units).map(([id, unit]) => [id, { ...unit, ability: 'dash' }])),
  abilities: legacyAbilities };

/** Angular's zone, for a room built by hand: everything runs where it is. */
const zone = { run: (f: () => unknown) => f(), runOutsideAngular: (f: () => unknown) => f() } as any;

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
   * Set the available CP through prior spending, using a negative spend when
   * the test needs more than the configured starting balance.
   */
  const fundCp = (c: any, cp: number) => {
    // Less the CP a side starts with, so `cp` is exactly what it has.
    c.myCpSpent = ruleOf(c.gameState.snapshot.config, 'cpAtStart') - cp;
  };

  const giveCp = (c: any, cp: number) => {
    // Turn 5, in Phase 1's play, after the opening's casting restriction.
    c.gameState.snapshot.turnNumber = 10;
    fundCp(c, cp);
  };

  const room = (): any => {
    const cdr = { markForCheck: () => {}, detectChanges: () => {} } as any;
    const gameState = {
      snapshot: { currentTurn: 'me', config: LEGACY_GAME_CONFIG }, myColor: () => 'white',
    } as any;
    // Picking flashes and sounds, and ending a turn talks to the socket.
    const audio = { playTone: () => {} } as any;
    const ws = { sendMessage: () => {} } as any;
    const c: any = new GameRoomComponent(
      ws, {} as any, {} as any, {} as any, {} as any,
      cdr, gameState, {} as any, audio, zone,
      { getConfig: () => DEFAULT_GAME_CONFIG } as any,
    );
    c.username = 'me';
    c.gameStarted = true;
    c.isSinglePlayer = true;
    c.myPoints = 10;
    return c;
  };

  describe('online turn drafts', () => {
    const online = () => {
      const c = room(); c.isSinglePlayer = false; c.gameId = 'draft-room';
      Object.assign(c.gameState.snapshot, { turnNumber: 7, revision: 4, boardState: {}, moveHistory: [] });
      c.turnDraftsSupported = true;
      c.wsService.sendMessage = jasmine.createSpy('send');
      return c;
    };

    it('coalesces changes, saves Undo as an empty turn, and commits the same commands once', async () => {
      const c = online();
      const commands = [{ type: 'make_move', from: '0,0', to: '1,0' }];
      spyOn(c, 'turnCommands').and.returnValue(commands);
      c.queueTurnDraft(); c.queueTurnDraft(); await Promise.resolve();
      expect(c.wsService.sendMessage.calls.count()).toBe(1);
      expect(c.wsService.sendMessage.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
        type: 'save_turn_draft', gameId: 'draft-room', turnNumber: 7, revision: 4, commands,
      }));
      const saved = c.wsService.sendMessage.calls.mostRecent().args[0].sequence;
      c.endTurn(); c.endTurn();
      expect(c.wsService.sendMessage.calls.count()).toBe(2);
      expect(c.wsService.sendMessage.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ type: 'commit_turn', commands }));
      expect(c.wsService.sendMessage.calls.mostRecent().args[0].sequence).toBeGreaterThan(saved);
      c.submittedTurn = -1; c.recapRunning = false;
      c.turnCommands.and.returnValue([]); c.queueTurnDraft(); await Promise.resolve();
      expect(c.wsService.sendMessage.calls.mostRecent().args[0].commands).toEqual([]);
    });

    for (const type of ['panel_move', 'enter_board']) {
      it(`saves a ${type} even when no battlefield action is staged`, async () => {
        const c = online();
        const step = { type, from: '-12,9', to: '-11,9', cost: 1, price: 0 };
        c.boardRef = { pendingPanelSteps: [step] };
        c.onHexSelected(null);
        await Promise.resolve();
        expect(c.wsService.sendMessage).toHaveBeenCalledWith(jasmine.objectContaining({
          type: 'save_turn_draft', commands: jasmine.arrayContaining([step]),
        }));
        c.onHexSelected(null);
        await Promise.resolve();
        expect(c.wsService.sendMessage.calls.count()).toBe(1);
      });
    }

    it('renders the incoming snapshot before restoring draft clicks and refreshes between commands', async () => {
      const c = online(); let bound = false;
      c.cdr.detectChanges = jasmine.createSpy('detect').and.callFake(() => bound = true);
      c.boardRef = { restoreDraftCommands: jasmine.createSpy('restore').and.callFake(async (commands: any[], refresh: () => void) => {
        expect(bound).toBeTrue(); bound = false; refresh(); expect(bound).toBeTrue();
      }) };
      const commands = [{ type: 'make_move', from: '0,0', to: '1,0' }];
      await c.restoreTurnDraft({ turnNumber: 7, sequence: 20, commands });
      expect(c.boardRef.restoreDraftCommands).toHaveBeenCalledWith(commands, jasmine.any(Function));
      expect(c.cdr.detectChanges.calls.count()).toBe(2);
      expect(c.restoringOnlineDraft).toBeFalse();
    });

    it('does not send or restore a deferred draft after the room ends or the route changes', async () => {
      const c = online(); c.queueTurnDraft(); c.gameStarted = false; await Promise.resolve();
      expect(c.wsService.sendMessage).not.toHaveBeenCalled();
      c.gameStarted = true; c.boardRef = { restoreDraftCommands: jasmine.createSpy('restore') };
      const restored = c.restoreTurnDraft({ turnNumber: 7, sequence: 20, commands: [] });
      c.gameId = 'another-room'; await restored;
      expect(c.boardRef.restoreDraftCommands).not.toHaveBeenCalled();
    });
  });

  it('describes status effects with remaining expiry and omits instant healing from ongoing effects', () => {
    const c = room(); c.gameState.snapshot.turnNumber = 11;
    spyOnProperty(c, 'displayBuff').and.returnValue({ effects: [
      { name: 'Mend', mov: 0, atk: 0, def: 0, turns: 1 },
      { name: 'Cast', mov: 0, atk: 0, def: 0, turns: 3, expiresAt: 13, effect: 'control' },
      { name: 'Charge', mov: 0, atk: 0, def: 0, turns: 1, effect: 'charge' },
    ] });
    spyOnProperty(c, 'displayUnit').and.returnValue(null);
    expect(c.displayEffects).toEqual([
      { name: 'Cast', detail: 'Controlled by the caster', life: '1 turn' },
      { name: 'Charge', detail: 'Second strike after a counter', life: '1 turn' },
    ]);
  });

  describe('turn timer selection', () => {
    it('shows the timer Start uses for edited solo setup and default online games', () => {
      const c = room(); c.gameStarted = false; c.gameOptions = {};
      c.configService = { getConfig: () => ({ rules: { turnTimeLimit: 120 } }) };
      expect(c.selectedTurnTimeLimit).toBe(120);
      c.isSinglePlayer = false;
      expect(c.selectedTurnTimeLimit).toBe(DEFAULT_GAME_CONFIG.rules.turnTimeLimit);
    });

    it('honours an explicit choice before start and the authoritative snapshot afterwards', () => {
      const c = room(); c.gameStarted = false; c.gameOptions = { turnTimeLimit: 15 };
      c.configService = { getConfig: () => ({ rules: { turnTimeLimit: 120 } }) };
      expect(c.selectedTurnTimeLimit).toBe(15);
      c.gameStarted = true; c.gameState.snapshot.turnTimeLimit = 0;
      expect(c.selectedTurnTimeLimit).toBe(0);
      expect(c.formattedTurnTime).toBe('');
      c.gameState.snapshot.turnTimeLimit = 30; c.turnSecondsRemaining = 29;
      expect(c.formattedTurnTime).toBe('0:29');
    });

    it('does not invent a one-minute override for a mode message without options', () => {
      const c = room(); c.gameStarted = false; c.isSinglePlayer = false;
      c.gameOptions = { turnTimeLimit: 15 };
      c.handleWebSocketMessage({ type: 'game_mode_changed', mode: 'default' });
      expect(c.gameOptions).toEqual({});
      expect(c.selectedTurnTimeLimit).toBe(DEFAULT_GAME_CONFIG.rules.turnTimeLimit);
    });
  });

  describe('the specified first pool', () => {
    const current = (color = 'white') => {
      const c = room();
      c.gameState = new GameStateService();
      c.gameState.applyGameStarted({
        config: structuredClone(DEFAULT_GAME_CONFIG), turnNumber: 9,
        playerWhite: color === 'white' ? 'me' : 'bot',
        playerBlack: color === 'black' ? 'me' : 'bot', currentTurn: 'me',
        boardState: {
          '0,0': { unit_id: 'shieldman', color, hp: 30, max_hp: 30, uid: 'own' },
          '1,0': { unit_id: 'pawn', color: color === 'white' ? 'black' : 'white', hp: 12, max_hp: 12, uid: 'enemy' },
        },
      });
      c.myPoints = 100; c.opponentPoints = 100;
      c.playSteps = () => {}; c.playAbilitySound = () => {};
      return c;
    };
    const shown = (c: any, key: string) => {
      const p = c.gameState.snapshot.boardState[key];
      return { key, uid: p.uid, unitId: p.unit_id, color: p.color, hp: p.hp, hpMax: p.max_hp, name: p.unit_id, vet: p.vet ?? 0, atk: [0] };
    };
    const arm = (c: any, id: string) => {
      const i = c.slotOfAbility(id);
      c.pickAbility('mine', i);
      c.selectAbility('mine', i, c.myCooldowns);
      return i;
    };

    const veteran = (c: any, id: string, key = '0,0', color = 'white', hp?: number) => {
      const u = c.gameState.snapshot.config.units[id];
      const full = u.hp + (u.veterancy?.hp ?? 0);
      c.gameState.snapshot.boardState[key] = { unit_id: id, color, uid: id + key, hp: hp ?? full, max_hp: full, vet: 3 };
      return { ...shown(c, key), vet: 3, hp: hp ?? full, hpMax: full };
    };
    const useUnit = (c: any, u: any) => { c.hoveredUnit = null; c.selectedUnit = u; c.unitAbilityFocus = { index: c.unitAbilityIndex(u) }; c.activateUnitAbility(); };
    const kitRoom = () => { const c = current(); c.gameState.snapshot.turnNumber = 55;
      c.gameState.snapshot.config.rules.upAtStart = 100; c.myUnitPoints = 100; c.opponentUnitPoints = 100; return c; };

    describe('CP paths', () => {
      const setup = (path: number, color = 'white') => {
        const c = current(color);
        fundCp(c, 100);
        c.persistLocalUiState = () => {}; c.playEndTurnSound = () => {};
        c.boardRef = { cells: Object.entries(c.gameState.snapshot.boardState).map(([key, piece]) => ({ key, piece, panel: '' })), clearMarks: () => {} };
        c.unlockPath('mine', path);
        return c;
      };
      const cast = (c: any, id: string, key?: string) => {
        const i = c.slotOfAbility(id);
        c.selectAbility('mine', i, c.myCooldowns);
        if (key) c.onAbilityHexClicked(key); else c.activateFocusedAbility();
        return i;
      };
      const addPanel = (c: any, key: string, panel: string, unit_id: string, color: string, hp = 10) => {
        const piece = { unit_id, color, uid: key, hp, max_hp: 30, vet: 0 };
        c.boardRef.cells.push({ key, piece, panel });
        return piece;
      };
      const unit = (c: any, key: string) => {
        const p = (c.stagedBoard ?? c.gameState.snapshot.boardState)[key];
        return { key, uid: p.uid, unitId: p.unit_id, color: p.color, hp: p.hp, hpMax: p.max_hp, vet: p.vet ?? 0 };
      };
      const commit = (c: any) => {
        localStorage.removeItem('cpp.localGame.v1');
        const engine = new LocalGameService({ getConfig: () => c.gameState.snapshot.config } as any);
        engine.send({ type: 'create_single_player_game', username: 'me' });
        engine.send({ type: 'start_game', hostColor: 'white' });
        const g = (engine as any).game;
        Object.assign(g, { boardState: structuredClone(c.gameState.snapshot.boardState), turnNumber: c.gameState.snapshot.turnNumber,
          currentTurn: 'me', moveHistory: [], phaseBank: {} });
        g.boardState['-8,0'] = { unit_id: 'king', color: 'white', uid: 'wk', hp: 60, max_hp: 60 };
        g.boardState['8,0'] = { unit_id: 'king', color: 'black', uid: 'bk', hp: 60, max_hp: 60 };
        c.wsService.sendMessage = (m: any) => engine.send(m);
        c.endTurn();
        return { engine, g };
      };

      it('buys each path at its configured cost and applies its passive at Vet 0 only outside the red base', () => {
        for (const [path, stat, delta] of [[0, 'def', 1], [1, 'atk', 1], [2, 'mov', 1]] as const) {
          const c = setup(path), passive = c.pathPassiveFor('white');
          expect(c.myCp).toBe(100 - c.abilityPaths[path].cost);
          expect(passiveStat(passive, stat, 0, false, true)).toBe(delta);
          expect(passiveStat(passive, stat, 0, true, true)).toBe(0);
          expect(passiveStat(passive, stat, 0, false, false)).toBe(stat === 'def' ? 0 : delta);
          expect(c.pathPassiveFor('black')).toBeNull();
          c.unlockPath('mine', (path + 1) % 3);
          expect(c.myPath).toBe(path);
          const config = structuredClone(c.gameState.snapshot.config);
          delete config.abilities.paths[path].utility; c.gameState.snapshot.config = config;
          expect(passiveStat(c.pathPassiveFor('white'), stat, 0, false, true)).toBe(delta);
        }
      });

      it('shows only applicable path bonuses before and after Shove unlocks', () => {
        const c = setup(1);
        c.gameState.snapshot.boardState['0,0'] = { unit_id: 'shieldman', color: 'white', uid: 'own', hp: 32, max_hp: 32, vet: 1 };
        c.selectedUnit = unit(c, '0,0'); c.selectedUnit.vet = 1;
        expect(c.displayEffects.some((e: any) => e.name === 'Onslaught')).toBeFalse();
        c.selectedUnit.vet = 2;
        expect(c.displayEffects).toContain(jasmine.objectContaining({ name: 'Onslaught', detail: '+1 ATK' }));
      });

      it('converts CP to regular points and restores both currencies and cooldown on Undo', () => {
        const c = setup(0), points = c.myPoints;
        const i = cast(c, 'convert');
        expect([c.myCp, c.myPoints, c.myCooldowns[i]]).toEqual([92, points + 5, 1]);
        c.undoMove();
        expect([c.myCp, c.myPoints, c.myCooldowns[i]]).toEqual([95, points, 0]);
      });

      it('promotes a wounded unit once, keeps the vet-3 cap and restores current/max HP on Undo', () => {
        const c = setup(1);
        c.gameState.snapshot.boardState['0,0'] = { unit_id: 'pawn', color: 'white', uid: 'own', hp: 5, max_hp: 12, vet: 0 };
        const i = c.slotOfAbility('strengthen');
        c.selectAbility('mine', i, c.myCooldowns); c.onHexClicked(unit(c, '0,0'));
        expect(c.stagedBoard['0,0']).toEqual(jasmine.objectContaining({ hp: 7, max_hp: 14, vet: 1 }));
        expect([c.myCp, c.myCooldowns[i]]).toEqual([100 - c.abilityPaths[1].cost - c.abilityCosts[i], 1]);
        c.undoMove(); expect(c.stagedBoard).toBeNull(); expect(c.myCp).toBe(100 - c.abilityPaths[1].cost);
        c.gameState.snapshot.boardState['0,0'] = { ...c.gameState.snapshot.boardState['0,0'], hp: 7, max_hp: 14, vet: 3 };
        c.clearAbilityFocus(); c.selectAbility('mine', i, c.myCooldowns); c.onHexClicked(unit(c, '0,0'));
        expect(c.stagedBoard['0,0']).toEqual(jasmine.objectContaining({ hp: 7, max_hp: 14, vet: 3 }));
      });

      it('sets Sap centre ATK and HEL to zero, drains adjacent occupants and retains zero overrides through commit', () => {
        const c = setup(0);
        c.gameState.snapshot.boardState['1,0'].unit_id = 'bishop';
        c.gameState.snapshot.boardState['2,0'] = { unit_id: 'bishop', color: 'black', uid: 'adj', hp: 8, max_hp: 8 };
        c.gameState.snapshot.boardState['3,0'] = { unit_id: 'bishop', color: 'black', uid: 'far', hp: 8, max_hp: 8 };
        cast(c, 'anchor', '1,0');
        expect(statSetting(c.buffs.enemy, 'atk')).toBe(0); expect(statSetting(c.buffs.enemy, 'hel')).toBe(0);
        expect([c.buffs.adj.atk, c.buffs.adj.hel]).toEqual([-4, -4]); expect(c.buffs.far).toBeUndefined();
        c.selectedUnit = unit(c, '1,0'); expect(c.statHel).toBe('1:0/8 2:0/6');
        const { g } = commit(c);
        expect(statSetting(g.abilityBuffs.enemy, 'hel')).toBe(0);
        expect(advanceBuffs(g.abilityBuffs, 'white', 11)).toEqual({});
      });

      it('blocks counters with Sap ATK 0 even when all numerical bonuses are zero', () => {
        const c = setup(0);
        c.gameState.snapshot.boardState['0,0'] = { unit_id: 'pawn', color: 'white', uid: 'own', hp: 12, max_hp: 12 };
        cast(c, 'anchor', '1,0');
        // The adjacent Sap drain is removed here to isolate the explicit zero override.
        delete c.buffs.own;
        c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
        const sent: any[] = []; c.wsService.sendMessage = (m: any) => sent.push(m); c.endTurn();
        expect(sent[0].bonuses.targetAtkSet).toBe(0);
        expect(sent[0].bonuses.atk).toBe(0);
      });

      it('damages the Cleave centre and six neighbours including friends, with one payment and whole-cast Undo', () => {
        const c = setup(1);
        const adjacent = ['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1'];
        for (const key of adjacent) c.gameState.snapshot.boardState[key] = { unit_id: 'pawn', color: 'white', uid: key, hp: 10, max_hp: 12 };
        c.gameState.snapshot.boardState['0,0'].hp = 10;
        const i = cast(c, 'cleave', '0,0');
        expect(c.stagedBoard['0,0'].hp).toBe(5);
        for (const key of adjacent) expect(c.stagedBoard[key].hp).withContext(key).toBe(7);
        expect([c.myCp, c.myCooldowns[i], c.abilityUses['mine|cleave']]).toEqual([100 - c.abilityPaths[1].cost - c.abilityCosts[i], 1, 1]);
        c.undoMove(); expect(c.myCp).toBe(100 - c.abilityPaths[1].cost); expect(c.stagedBoard).toBeNull(); expect(c.abilityUses['mine|cleave'] ?? 0).toBe(0);
      });

      it('Ruin includes both panel colours and red bases, damages first and heals only friendly survivors', () => {
        const c = setup(1);
        c.gameState.snapshot.boardState['0,0'].hp = 2;
        addPanel(c, '-12,11', 'bl', 'pawn', 'white', 3);
        addPanel(c, '-12,0', 'br', 'pawn', 'white', 10);
        addPanel(c, '12,-11', 'tr', 'pawn', 'black', 10);
        cast(c, 'ruin');
        expect(c.stagedBoard['0,0']).toBeUndefined();
        const hp = Object.fromEntries(c.stagedActions[0].effects.filter((e: any) => e.unit).map((e: any) => [e.unit.uid, e.hp]));
        expect(hp).toEqual({ '-12,11': 0, '-12,0': 10, '12,-11': 7 });
        expect(c.stagedBoard['1,0'].hp).toBe(9); expect(c.myCp).toBe(100 - c.abilityPaths[1].cost - c.abilityCosts[c.slotOfAbility('ruin')]);
        expect(c.killMarkers.length).toBe(2);
      });

      it('Sacrifice removes a Fortress-protected pawn through commit and reload without treating removal as damage', () => {
        const c = setup(0), pawn = veteran(c, 'pawn');
        c.gameState.snapshot.turnNumber = 55;
        c.gameState.snapshot.config.rules.upAtStart = 100; c.myUnitPoints = 100;
        cast(c, 'fortress');
        useUnit(c, pawn);
        expect(c.stagedBoard['0,0']).toBeUndefined();
        expect(c.myUnitPoints).toBe(105);
        c.undoMove();
        expect(c.stagedBoard['0,0'].uid).toBe(pawn.uid);
        expect(carries(c.buffs[pawn.uid], 'invulnerable')).toBeTrue();
        expect(c.myUnitPoints).toBe(100);
        useUnit(c, pawn);
        const { g } = commit(c);
        expect(g.boardState['0,0']).toBeUndefined();
        expect(g.moveHistory.filter((m: any) => m.abilityDeath?.uid === pawn.uid).length).toBe(1);
        const restored = new LocalGameService({ getConfig: () => g.config } as any);
        expect((restored as any).game.boardState['0,0']).toBeUndefined();
        expect(unitPoints(g.config, g.moveHistory, 'white')).toBe(105);
        expect(unitPoints((restored as any).game.config, (restored as any).game.moveHistory, 'white')).toBe(105);
      });

      it('Trap strips positive buffs while retaining drains and control, locks actions but leaves counters possible', () => {
        const c = setup(2);
        c.buffs.enemy = stackEffect(undefined, { name: 'Warcry', mov: 0, atk: 8, def: 0 }, 'black');
        c.buffs.enemy = stackEffect(c.buffs.enemy, { name: 'Mire', mov: -2, atk: 0, def: 0 }, 'white', true);
        c.buffs.enemy = stackEffect(c.buffs.enemy, { name: 'Cast', mov: 0, atk: 0, def: 0, effect: 'control' }, 'white');
        cast(c, 'surge', '1,0');
        expect([c.buffs.enemy.atk, c.buffs.enemy.mov]).toEqual([0, -2]);
        expect(carries(c.buffs.enemy, 'control')).toBeTrue(); expect(carries(c.buffs.enemy, 'action-lock')).toBeTrue();
        expect(c.buffs.own.mov).toBe(-4);
        expect(c.canTakeBoardAction('1,0')).toBeFalse();
        const exchange = combatExchange(c.gameState.snapshot.boardState['0,0'], c.gameState.snapshot.boardState['1,0'], 1,
          c.gameState.snapshot.config, { atk: 8, def: 0, targetAtk: 0, targetDef: 0, ...combatStatuses(c.buffs.own, c.buffs.enemy) });
        expect(exchange.countered).toBeTrue();
        c.undoMove(); expect(c.buffs.enemy.atk).toBe(8); expect(c.myCp).toBe(80);
      });

      it('Recharge targets either member of a carried pair, stops at one, accepts ready pairs and restores cooldowns on Undo', () => {
        const c = setup(2), warcry = c.slotOfAbility('warcry'), sap = c.slotOfAbility('sap');
        c.pickAbility('mine', warcry); c.myCooldowns[warcry] = 2; c.myCooldowns[sap] = 5;
        const i = c.slotOfAbility('recharge');
        c.gameState.snapshot.config.abilities.catalogue.recharge.description = 'Old saved description: floor at 0.';
        c.selectAbility('mine', i, c.myCooldowns);
        expect(c.isAbilityFocusedSide('mine')).toBeTrue();
        expect(c.pendingAbility).toBeNull();
        expect(c.focusedAbilityDescription).toContain('stopping at 1');
        c.activateFocusedAbility();
        expect(c.isAbilityFocusedSide('mine')).toBeFalse();
        c.selectAbility('mine', sap, c.myCooldowns);
        expect([c.myCooldowns[warcry], c.myCooldowns[sap], c.myCooldowns[i], c.myCp]).toEqual([1, 4, 1, 75]);
        c.undoMove(); expect([c.myCooldowns[warcry], c.myCooldowns[sap], c.myCp]).toEqual([2, 5, 80]);
        c.myCooldowns[warcry] = 1; c.myCooldowns[sap] = 0; c.clearAbilityFocus();
        c.selectAbility('mine', i, c.myCooldowns); c.activateFocusedAbility();
        c.selectAbility('mine', sap, c.myCooldowns);
        expect([c.myCooldowns[warcry], c.myCooldowns[sap]]).toEqual([1, 0]);
        expect(c.abilityCanActivate('mine', warcry, c.myCooldowns[warcry])).toBeFalse();
        c.undoMove();
        c.myCooldowns[warcry] = c.myCooldowns[sap] = 0; c.clearAbilityFocus();
        c.selectAbility('mine', i, c.myCooldowns); c.activateFocusedAbility(); c.selectAbility('mine', warcry, c.myCooldowns);
        expect([c.myCooldowns[warcry], c.myCooldowns[sap], c.myCp]).toEqual([0, 0, 75]);
      });

      it('Blitz boosts existing heal profiles only and locks battlefield/reserve enemies without affecting red bases', () => {
        const c = setup(2);
        c.gameState.snapshot.boardState['0,0'] = { unit_id: 'bishop', color: 'white', uid: 'own', hp: 8, max_hp: 8, vet: 1 };
        const reserve = addPanel(c, '-12,0', 'br', 'pawn', 'white');
        const base = addPanel(c, '-12,11', 'bl', 'pawn', 'white');
        cast(c, 'blitz');
        c.selectedUnit = unit(c, '0,0'); expect(c.statHel).toBe('1:12/8 2:10/6 3:8/4 4:6/2');
        c.selectedUnit = { ...c.selectedUnit, unitId: 'pawn', uid: reserve.uid }; expect(c.statHel).toBe('—');
        expect(c.buffs[reserve.uid].mov).toBe(8); expect(c.buffs[base.uid]).toBeUndefined();
        expect(carries(c.buffs.enemy, 'action-lock')).toBeTrue();
        expect(c.myCp).toBe(45);
      });

      it('Fortress prevents direct damage and sets enemy DEF to zero through the opponent turn, then expires', () => {
        const c = setup(0);
        cast(c, 'fortress');
        const exchange = combatExchange(c.gameState.snapshot.boardState['1,0'], c.gameState.snapshot.boardState['0,0'], 1,
          c.gameState.snapshot.config, { atk: 0, def: 0, targetAtk: 0, targetDef: 0, ...combatStatuses(c.buffs.enemy, c.buffs.own) });
        expect(exchange.damage).toBe(0); expect(statSetting(c.buffs.enemy, 'def')).toBe(0);
        expect(advanceBuffs(c.buffs, 'black', 10)['own']).toBeDefined();
        expect(advanceBuffs(c.buffs, 'white', 11)).toEqual({});
        const result = c.hpChange(unit(c, '0,0'), -99, c.stagedBoard);
        expect(result.board['0,0'].hp).toBe(30);
        c.undoMove(); expect(c.buffs).toEqual({}); expect(c.myCp).toBe(95);
      });

      it('allows empty hex casts, refuses missing hexes and enforces three uses after cooldown resets', () => {
        const c = setup(0), i = c.slotOfAbility('anchor');
        c.boardRef.cells.push({ key: '5,0', piece: null, panel: '' });
        cast(c, 'anchor', '30,0'); expect(c.myCp).toBe(95);
        c.clearAbilityFocus();
        for (let n = 0; n < 3; n++) { c.myCooldowns[i] = 0; cast(c, 'anchor', '5,0'); }
        expect(c.myCp).toBe(80); expect(c.abilityUses['mine|anchor']).toBe(3);
        c.myCooldowns[i] = 0; cast(c, 'anchor', '5,0'); expect(c.myCp).toBe(80);
      });

      it('commits opening moves under purchased stat passives without treating them as casts', () => {
        for (const path of [0, 1]) {
          const c = setup(path); c.gameState.snapshot.turnNumber = 1;
          c.onPlayerMove({ from: '0,0', to: '0,1', cost: 1 });
          const { g } = commit(c);
          expect(g.turnNumber).withContext(`path ${path}`).toBe(2);
          expect(g.boardState['0,1']?.uid).withContext(`path ${path}`).toBe('own');
        }
      });

      it('captures the movement budget before later Trap casts and commits Sprint movements during initialization', () => {
        const c = setup(2);
        c.gameState.snapshot.boardState['0,0'].unit_id = 'pawn';
        c.onPlayerMove({ from: '0,0', to: '0,7', cost: 7 });
        c.boardRef.cells.push({ key: '0,6', piece: null, panel: '' });
        cast(c, 'surge', '0,6');
        expect(c.buffs.own.mov).toBe(-4);
        const { g } = commit(c);
        expect(g.turnNumber).toBe(10); expect(g.boardState['0,7'].uid).toBe('own');
        const opening = setup(2); opening.gameState.snapshot.turnNumber = 1;
        opening.gameState.snapshot.boardState['0,0'].unit_id = 'pawn';
        opening.onPlayerMove({ from: '0,0', to: '0,7', cost: 7 });
        const result = commit(opening);
        expect(result.g.turnNumber).toBe(2); expect(result.g.boardState['0,7'].uid).toBe('own');
      });
    });

    it('ends a returned Cast unit’s postmatch withdrawal as deployment and pass for either seat', async () => {
      for (const color of ['white', 'black']) {
        const c = current(color), s = c.gameState.snapshot;
        const sign = color === 'white' ? 1 : -1;
        s.turnNumber = color === 'white' ? 71 : 72;
        const at = `${-10 * sign},${9 * sign}`, home = `${-12 * sign},${10 * sign}`;
        veteran(c, 'king', '-8,0', 'white'); veteran(c, 'king', '8,0', 'black');
        const returned = veteran(c, 'pawn', at, color);
        s.boardState[at].owner = color;
        const sent: any[] = []; c.wsService.sendMessage = (m: any) => sent.push(m);
        c.persistLocalUiState = () => {}; c.playEndTurnSound = () => {};
        c.onPlayerMove({ from: at, to: home, cost: 3, refund: 8 });
        expect(c.stagedActions[0].homecoming).toBeTrue();
        c.endTurn();
        expect(sent.map(m => m.type)).toEqual(['make_move', 'pass_turn']);
        localStorage.removeItem('cpp.localGame.v1');
        const engine = new LocalGameService(new ConfigService());
        engine.send({ type: 'create_single_player_game', username: 'me' });
        engine.send({ type: 'start_game', hostColor: color });
        Object.assign((engine as any).game, { boardState: structuredClone(s.boardState), config: s.config,
          turnNumber: s.turnNumber, currentTurn: 'me', moveHistory: [] });
        const seen: any[] = []; engine.messages$.subscribe(m => seen.push(m));
        sent.forEach(m => engine.send(m)); await new Promise(r => setTimeout(r, 0));
        expect((engine as any).game.turnNumber).toBe(s.turnNumber + 1);
        expect(seen.find(m => m.type === 'invalid_move')).toBeUndefined();
        expect((engine as any).game.moveHistory.find((m: any) => m.withdrawn).unit.uid).toBe(returned.uid);
        localStorage.removeItem('cpp.localGame.v1');
      }
    });

    it('commits an intervening Strike before Rapid Movement enters its vacated hex, then lands a later Mend', async () => {
      const c = kitRoom(), s = c.gameState.snapshot;
      veteran(c, 'king', '-8,0', 'white'); veteran(c, 'king', '8,0', 'black');
      const pawn = veteran(c, 'pawn'), enemy = veteran(c, 'rook', '1,0', 'black', 2);
      const sent: any[] = []; c.wsService.sendMessage = (m: any) => sent.push(m);
      c.persistLocalUiState = () => {}; c.playEndTurnSound = () => {};
      c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
      arm(c, 'strike'); c.onHexClicked({ ...enemy, hp: 1 });
      expect(c.stagedBoard['1,0']).toBeUndefined();
      c.onPlayerMove({ from: '0,0', to: '1,0', cost: 1 });
      arm(c, 'mend'); c.onHexClicked({ ...pawn, key: '1,0', hp: 10 });
      expect(c.stagedBoard['1,0'].hp).toBe(12);
      c.endTurn();
      expect(sent[0].effectsAfterAttack).toContain(jasmine.objectContaining({ uid: enemy.uid, hp: 0 }));
      expect(sent[0].effects).toContain(jasmine.objectContaining({ uid: pawn.uid, hp: 12 }));
      localStorage.removeItem('cpp.localGame.v1');
      const engine = new LocalGameService(new ConfigService());
      engine.send({ type: 'create_single_player_game', username: 'me' });
      engine.send({ type: 'start_game', hostColor: 'white' });
      Object.assign((engine as any).game, { boardState: structuredClone(s.boardState), config: s.config,
        turnNumber: 55, currentTurn: 'me', moveHistory: [] });
      const seen: any[] = []; engine.messages$.subscribe(m => seen.push(m));
      sent.forEach(m => engine.send(m)); await new Promise(r => setTimeout(r, 0));
      expect(seen.find(m => m.type === 'invalid_move')).toBeUndefined();
      expect((engine as any).game.turnNumber).toBe(56);
      expect((engine as any).game.boardState['1,0']).toEqual(jasmine.objectContaining({ uid: pawn.uid, hp: 12 }));
      const restored = new LocalGameService(new ConfigService());
      expect((restored as any).game.boardState['1,0']).toEqual((engine as any).game.boardState['1,0']);
      expect((restored as any).game.moveHistory.some((m: any) => m.abilityDeath?.unit_id === 'rook')).toBeTrue();
      localStorage.removeItem('cpp.localGame.v1');
    });

    it('keeps configured three-turn Archer and Rook Bog recipients through two caster returns and reload', () => {
      for (const color of ['white', 'black']) {
        for (const id of ['archer', 'rook']) {
          const c = current(color), s = c.gameState.snapshot, ply = color === 'white' ? 55 : 56;
          s.turnNumber = ply;
          s.config.abilities.catalogue[id === 'archer' ? 'archer-bog' : 'rook-bog'].turns = 3;
          const source = veteran(c, id, '0,0', color);
          const enemy = veteran(c, 'pawn', id === 'archer' ? '3,0' : '1,0', color === 'white' ? 'black' : 'white');
          if (id === 'archer') useUnit(c, source);
          c.onPlayerAttack({ from: '0,0', to: '0,0', attack: enemy.key });
          expect(c.buffs[enemy.uid].effects[0].expiresAt).toBe(ply + 6);
          s.boardState = c.stagedBoard; c.stagedActions = [];
          for (const offset of [2, 4]) {
            c.buffs = JSON.parse(JSON.stringify(c.buffs));
            s.turnNumber = ply + offset; c.beginTurnFor(color);
            expect(c.buffs[enemy.uid]).withContext(`${id} ${color} +${offset}`).toBeDefined();
          }
          s.turnNumber = ply + 6; c.beginTurnFor(color);
          expect(c.buffs[enemy.uid]).toBeUndefined();
        }
      }
    });

    it('honors configured durations for adjacent auras and Cast too', () => {
      for (const id of ['queen', 'king', 'bishop']) {
        const c = kitRoom(), s = c.gameState.snapshot;
        const source = veteran(c, id);
        const target = veteran(c, 'pawn', '1,0', id === 'king' ? 'white' : 'black');
        const ability = id === 'bishop' ? 'bishop-cast' : id === 'king' ? 'persuade' : 'intimidate';
        s.config.abilities.catalogue[ability].turns = 3;
        if (id === 'bishop') {
          useUnit(c, source); c.onHexClicked(target);
          expect(c.stagedBoard['1,0'].controlledUntil).toBe(61);
        } else {
          c.beginTurnFor('white');
          expect(c.buffs[target.uid].effects[0].expiresAt).toBe(61);
          s.turnNumber = 57; c.beginTurnFor('black');
          expect(c.buffs[target.uid]).toBeDefined();
          s.boardState = {}; s.turnNumber = 61; c.beginTurnFor('white');
          expect(c.buffs[target.uid]).toBeUndefined();
        }
      }
    });

    it('gates all eight UP abilities at Vet 3 and keeps their per-unit prices separate from points and CP', () => {
      for (const [id, cost] of [['pawn', 3], ['archer', 3], ['shieldman', 1], ['rook', 5], ['knight', 5], ['bishop', 10], ['queen', 3], ['king', 5]] as const) {
        const c = kitRoom(), u = veteran(c, id); c.selectedUnit = { ...u, vet: 2 };
        c.unitAbilityFocus = { index: c.unitAbilityIndex(u) };
        expect(c.unitAbilityCanActivate()).withContext(id).toBeFalse();
        c.selectedUnit = u; expect(c.unitAbilityCanActivate()).withContext(id).toBeTrue();
        expect(c.purseName(c.unitAbilityIndex(u), cost)).toBe('UP');
        expect(c.abilityCosts[c.unitAbilityIndex(u)]).toBe(cost);
      }
    });

    it('refuses all eight unit casts atomically with insufficient UP or an active cooldown for either seat', () => {
      for (const color of ['white', 'black']) {
        for (const id of ['pawn', 'archer', 'shieldman', 'rook', 'knight', 'bishop', 'queen', 'king']) {
          const c = current(color), s = c.gameState.snapshot;
          s.turnNumber = color === 'white' ? 55 : 56;
          c.myUnitPoints = 0;
          const unit = veteran(c, id, '0,0', color);
          const before = structuredClone(s.boardState);
          useUnit(c, unit);
          expect(c.unitAbilityCanActivate()).withContext(`${color} ${id} UP`).toBeFalse();
          expect(c.stagedActions).toEqual([]);
          expect(c.stagedBoard).toBeNull();
          expect(c.pendingUnitCast).toBeNull();
          expect(c.unitCooldownOf(unit.uid)).toBe(0);
          expect([c.myPoints, c.myUnitPoints, c.myCpSpent]).toEqual([100, 0, 0]);
          c.myUnitPoints = 100;
          c.unitCooldowns[unit.uid] = { color, turns: 1 };
          useUnit(c, unit);
          expect(c.unitAbilityCanActivate()).withContext(`${color} ${id} cooldown`).toBeFalse();
          expect(c.stagedActions).toEqual([]);
          expect(c.buffs).toEqual({});
          expect(c.pendingUnitCast).toBeNull();
          expect(c.unitCooldownOf(unit.uid)).toBe(1);
          expect(s.boardState).toEqual(before);
          expect([c.myPoints, c.myUnitPoints, c.myCpSpent]).toEqual([100, 100, 0]);
        }
      }
    });

    it('keeps cooldowns independent for two veterans of the same type', () => {
      const c = kitRoom(), first = veteran(c, 'knight'), second = veteran(c, 'knight', '1,0');
      useUnit(c, first);
      expect(c.unitCooldownOf(first.uid)).toBe(5);
      expect(c.unitCooldownOf(second.uid)).toBe(0);
      c.selectedUnit = second; c.unitAbilityFocus = { index: c.unitAbilityIndex(second) };
      expect(c.unitAbilityCanActivate()).toBeTrue();
      useUnit(c, second);
      expect([c.unitCooldownOf(first.uid), c.unitCooldownOf(second.uid), c.myUnitPoints]).toEqual([5, 5, 90]);
      c.beginTurnFor('black');
      expect(c.unitCooldownOf(first.uid)).toBe(5);
    });

    it('stages Sacrifice atomically across battlefield and green reserve, with exact UP and Undo', () => {
      const c = kitRoom(), u = veteran(c, 'pawn'), ally = veteran(c, 'pawn', '-2,0', 'white', 9);
      c.boardRef = { cells: [{ key: '11,1', panel: 'br', piece: { unit_id: 'pawn', color: 'white', uid: 'green', hp: 4, max_hp: 14, vet: 3 } },
        { key: '-12,11', panel: 'bl', piece: { unit_id: 'pawn', color: 'white', uid: 'base', hp: 4, max_hp: 14, vet: 3 } }], clearMarks: () => {} };
      useUnit(c, u);
      expect([c.myUnitPoints, c.myPoints, c.myCpSpent]).toEqual([105, 100, 0]);
      expect(c.stagedBoard['0,0']).toBeUndefined(); expect(c.stagedBoard['-2,0'].hp).toBe(10);
      expect([c.buffs[ally.uid].atk, c.buffs.green.def, c.buffs.green.mov, c.panelHp.green]).toEqual([1, 1, 1, 5]);
      expect(c.buffs.base).toBeUndefined(); expect(c.unitCooldownOf(u.uid)).toBe(5);
      c.reconcilePoints(); expect(c.myUnitPoints).toBe(105);
      c.undoMove(); expect(c.myUnitPoints).toBe(100); expect(c.stagedBoard).toBeNull(); expect(c.buffs).toEqual({});
      expect(c.unitCooldownOf(u.uid)).toBe(0);
    });

    it('applies Call to fixed battlefield and green recipients, with immediate damage and full-turn drains', () => {
      const c = kitRoom(), king = veteran(c, 'king', '0,0', 'white', 50);
      veteran(c, 'pawn', '1,0', 'black', 1);
      c.boardRef = { cells: [{ key: '-11,-1', panel: 'tl', piece: { unit_id: 'pawn', color: 'black', uid: 'green', hp: 4, max_hp: 14, vet: 3 } }], clearMarks: () => {} };
      useUnit(c, king);
      expect(c.stagedBoard['0,0'].hp).toBe(52); expect(c.stagedBoard['1,0']).toBeUndefined();
      expect([c.buffs[king.uid].def, c.buffs.green.def, c.buffs.green.atk, c.panelHp.green]).toEqual([2, -2, -1, 3]);
      expect(c.myUnitPoints).toBe(95);
      c.gameState.snapshot.turnNumber = 56; c.beginTurnFor('black'); expect(c.buffs.green.atk).toBe(-1);
      c.gameState.snapshot.boardState = c.stagedBoard; c.stagedActions = []; c.gameState.snapshot.turnNumber = 57;
      c.beginTurnFor('white'); expect(c.buffs.green).toBeUndefined();
    });

    it('restricts attacks under Taunt while preserving the normal ability and movement choices', () => {
      const c = kitRoom(), shield = veteran(c, 'shieldman'); useUnit(c, shield);
      c.gameState.snapshot.boardState = c.stagedBoard; c.stagedActions = []; c.gameState.snapshot.turnNumber = 56; c.gameState.snapshot.currentTurn = 'bot';
      veteran(c, 'pawn', '1,0', 'black'); veteran(c, 'pawn', '0,1', 'white');
      c.onPlayerAttack({ from: '1,0', to: '1,0', attack: '0,1' }); expect(c.stagedActions.length).toBe(0);
      c.onPlayerMove({ from: '1,0', to: '2,0', cost: 1 }); expect(c.stagedBoard['2,0']).toBeDefined();
      c.undoMove(); c.onPlayerAttack({ from: '1,0', to: '1,0', attack: '0,0' }); expect(c.boardMoves[0].attack).toBe('0,0');
    });

    it('Cleave hits adjacent enemies only, gives them no counter, and keeps its effects after the exchange', () => {
      const c = kitRoom(), rook = veteran(c, 'rook'); veteran(c, 'pawn', '1,0', 'black');
      veteran(c, 'pawn', '0,1', 'black'); veteran(c, 'pawn', '-1,0', 'white');
      useUnit(c, rook); c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
      expect([c.stagedBoard['1,0'].hp, c.stagedBoard['0,1'].hp, c.stagedBoard['-1,0'].hp, c.stagedBoard['0,0'].hp]).toEqual([10, 10, 14, 39]);
      const sent: any[] = []; c.wsService.sendMessage = (m: any) => sent.push(m); c.endTurn();
      expect(sent[0].effectsBefore[0].unitCast.cost).toBe(5); expect(sent[0].effects[0].at).toBe('0,1');
    });

    it('Archer Bog drains only its attack target and undoes with the exchange', () => {
      const c = kitRoom(), archer = veteran(c, 'archer'); const enemy = veteran(c, 'pawn', '3,0', 'black');
      useUnit(c, archer); c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '3,0' });
      expect(c.buffs[enemy.uid].mov).toBe(-4); expect(c.stagedBoard['3,0'].hp).toBe(13);
      c.undoMove(); expect(c.buffs[enemy.uid]).toBeUndefined(); expect(c.buffs[archer.uid].effects[0].effect).toBe('attack-drain');
    });

    it('arms Cast without charging, then ends the bishop action and grants only the controlled unit an extra action', () => {
      const c = kitRoom(), bishop = veteran(c, 'bishop'), target = veteran(c, 'pawn', '1,0', 'black');
      useUnit(c, bishop); expect(c.myUnitPoints).toBe(100); expect(c.activeBoardAbilityMode()).toBe('enemy');
      c.onHexClicked(target); expect(c.myUnitPoints).toBe(90);
      expect([c.stagedBoard['1,0'].color, c.stagedBoard['1,0'].owner]).toEqual(['white', 'black']);
      expect(c.extraActionUids).toEqual([target.uid]); expect(c.ordinaryBoardMoves.length).toBe(1);
      expect(c.unitActionSpent).toBeTrue();
      c.onPlayerMove({ from: '1,0', to: '2,0', cost: 1 }); expect(c.boardMoves.length).toBe(2);
      const sent: any[] = []; c.wsService.sendMessage = (m: any) => sent.push(m); c.endTurn();
      expect(sent.length).toBe(2); expect(sent[0].unitAction).toBeTrue(); expect(sent[0].more).toBeTrue();
      expect(sent[0].effectsBefore.some((e: any) => e.control?.uid === target.uid)).toBeTrue(); expect(sent[1].from).toBe('1,0');
    });

    it('applies one Bog stack after each exchange, preserves combat pricing, and restores Undo', () => {
      const c = current(); const s = c.gameState.snapshot;
      s.turnNumber = 31;
      s.boardState = {
        '0,0': { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'wr', vet: 2 },
        '1,0': { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'br', vet: 2 },
      };
      c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
      expect([c.buffs.wr.atk, c.buffs.br.atk]).toEqual([-1, -1]);
      expect(c.stagedBoard['0,0'].hp).toBe(39);
      expect(c.stagedActions[0].combatBonuses).toEqual({ atk: 0, def: 0, targetAtk: 0, targetDef: 0 });
      c.undoMove();
      expect(c.buffs).toEqual({});
      expect(c.stagedBoard).toBeNull();
      c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
      s.boardState = c.stagedBoard; c.stagedActions = []; s.turnNumber = 32; s.currentTurn = 'bot';
      c.beginTurnFor('black');
      c.onPlayerAttack({ from: '1,0', to: '1,0', attack: '0,0' });
      expect([c.buffs.wr.atk, c.buffs.br.atk]).toEqual([-2, -2]);
      c.buffs = JSON.parse(JSON.stringify(c.buffs));
      s.turnNumber = 33; c.beginTurnFor('white');
      expect([c.buffs.wr.atk, c.buffs.br.atk]).toEqual([-1, -1]);
      s.turnNumber = 34; c.beginTurnFor('black');
      expect(c.buffs).toEqual({});
    });

    it('takes fixed adjacent aura recipients at the owner turn start and unlocks the unit passive at Vet 2', () => {
      const c = current(); const s = c.gameState.snapshot;
      s.turnNumber = 31;
      s.boardState = {
        '0,0': { unit_id: 'king', color: 'white', hp: 60, max_hp: 60, uid: 'wk', vet: 2 },
        '1,0': { unit_id: 'pawn', color: 'white', hp: 14, max_hp: 14, uid: 'wp', vet: 2 },
        '3,0': { unit_id: 'queen', color: 'white', hp: 32, max_hp: 32, uid: 'wq', vet: 2 },
        '2,0': { unit_id: 'pawn', color: 'black', hp: 14, max_hp: 14, uid: 'bp', vet: 2 },
      };
      c.beginTurnFor('white');
      expect([c.buffs.wp.atk, c.buffs.wp.def, c.buffs.wp.mov]).toEqual([1, 1, 1]);
      expect([c.buffs.bp.atk, c.buffs.bp.def, c.buffs.bp.mov]).toEqual([-1, -1, -1]);
      expect(c.buffs.wk).toBeUndefined();
      s.boardState['6,0'] = s.boardState['2,0']; delete s.boardState['2,0'];
      s.turnNumber = 32; c.beginTurnFor('black');
      expect(c.buffs.bp.atk).toBe(-1);
      s.turnNumber = 33; c.beginTurnFor('white');
      expect(c.buffs.bp).toBeUndefined();
      c.selectedUnit = { ...shown(c, '0,0'), vet: 1 };
      expect(c.displayUnitPassive).toBe(c.slotOfAbility('persuade'));
      expect(c.vetUnlocked(c.displayUnitPassive)).toBeFalse();
      c.selectedUnit.vet = 2;
      expect(c.vetUnlocked(c.displayUnitPassive)).toBeTrue();
    });

    it('preserves a pawn attack through a later cast and remaining walk, without permitting a second attack', () => {
      const c = current(); const s = c.gameState.snapshot;
      s.turnNumber = 31;
      s.boardState = {
        '0,0': { unit_id: 'pawn', color: 'white', hp: 14, max_hp: 14, uid: 'wp', vet: 2 },
        '1,0': { unit_id: 'rook', color: 'black', hp: 40, max_hp: 40, uid: 'br', vet: 2 },
      };
      c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
      expect(c.movesLeft).toBe(6);
      const heal = c.slotOfAbility('mend');
      const spend = c.spendOf('wp', 'mine', 'mine', heal, '0,0');
      c.stageSpend(spend);
      c.onPlayerMove({ from: '0,0', to: '-2,0', cost: 2 });
      expect(c.boardMoves.length).toBe(1);
      expect(c.boardMoves[0].attack).toBe('1,0');
      expect(c.boardMoves[0].attackFrom).toBe('0,0');
      expect(c.movesLeft).toBe(4);
      expect(c.attackedUnitHexes).toEqual(['-2,0']);
      const staged = c.stagedActions.length;
      c.onPlayerAttack({ from: '-2,0', to: '-2,0', attack: '1,0' });
      expect(c.stagedActions.length).toBe(staged);
      const sent: any[] = []; c.wsService.sendMessage = (message: any) => sent.push(message);
      c.playEndTurnSound = () => {}; c.endTurn();
      expect(sent[0].to).toBe('0,0');
      expect(sent[0].afterAttackTo).toBe('-2,0');
      expect(sent[0].bonuses).toBeUndefined();
    });

    it('promotes wounded green units once, excludes red bases, and preserves promoted HP records on reload', () => {
      for (const color of ['white', 'black']) {
        const c = current(color);
        const green = color === 'white' ? '11,1' : '-11,-1';
        const base = color === 'white' ? '-12,1' : '12,-1';
        const uid = `${color[0]}${green}`;
        const snapshot = c.gameState.snapshot;
        snapshot.config.setup[color] = { [green]: 'pawn', [base]: 'pawn' };
        snapshot.turnNumber = 6;
        snapshot.moveHistory = [[green, color === 'white' ? 'br' : 'tl'], [base, color === 'white' ? 'bl' : 'tr']].map(([at, panel]) => ({
          turn: 6, intoPanel: true, panelEffect: true, panel, attackedHex: at, defenderHp: 5,
          unit: { unit_id: 'pawn', color, hp: 5, max_hp: 12, vet: 0, uid: `${color[0]}${at}` },
        }));
        expect(c.panelHp[uid]).toBe(5);
        snapshot.turnNumber = 7;
        expect(c.panelHp[uid]).toBe(7);
        expect(c.panelHp[`${color[0]}${base}`]).toBe(5);
        snapshot.moveHistory = [...snapshot.moveHistory, {
          turn: 7, intoPanel: true, panelEffect: true, panel: color === 'white' ? 'br' : 'tl',
          attackedHex: green, defenderHp: 4,
          unit: { unit_id: 'pawn', color, hp: 7, max_hp: 14, vet: 1, uid },
        }];
        snapshot.turnNumber = 9;
        expect(c.panelHp[uid]).toBe(4);
        const restored = current(color);
        restored.gameState.snapshot.config = snapshot.config;
        restored.gameState.snapshot.turnNumber = 9;
        restored.gameState.snapshot.moveHistory = JSON.parse(JSON.stringify(snapshot.moveHistory));
        expect(restored.panelHp[uid]).toBe(4);
      }
    });

    it('casts every first-pool ability in both halves of every postmatch while Warcry cannot enable normal attacks there', () => {
      for (const ply of [27, 28, 49, 50, 71, 72]) {
        const color = ply % 2 ? 'white' : 'black';
        for (const id of ['warcry', 'sap', 'bulwark', 'weakening', 'dash', 'mire', 'mend', 'strike']) {
          const c = current(color);
          c.gameState.snapshot.turnNumber = ply;
          c.gameState.snapshot.boardState['0,0'].hp = 20;
          c.gameState.snapshot.boardState['0,0'].vet = 2;
          c.persistLocalUiState = () => {};
          const i = arm(c, id);
          if (c.abilityTargetMode(i) === 'universal') c.activateFocusedAbility();
          else c.onHexClicked(shown(c, id === 'strike' ? '1,0' : '0,0'));
          expect(c.myPoints).withContext(`${ply}: ${id}`).toBe(100 - c.abilityCosts[i]);
          expect(c.myCooldowns[i]).toBe(c.cooldownOf(i));
          if (id === 'mend') expect(c.stagedBoard['0,0'].hp).toBe(20 + c.abilityEffects[i].heal);
          if (id === 'strike') expect(c.stagedBoard['1,0'].hp).toBe(8);
          if (id === 'warcry') {
            const actions = c.stagedActions.length;
            c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
            expect(c.stagedActions.length).toBe(actions);
            expect((c.stagedBoard ?? c.gameState.snapshot.boardState)['1,0'].hp).toBe(12);
          }
        }
      }
    });

    it('offers the four pairs and applies friendly stats with their configured price and cooldown', () => {
      expect(current().abilityIds.slice(0, 8)).toEqual([
        'warcry', 'sap', 'bulwark', 'weakening', 'dash', 'mire', 'mend', 'strike',
      ]);
      for (const [id, stat] of [['warcry', 'atk'], ['bulwark', 'def'], ['dash', 'mov']]) {
        const c = current();
        c.gameState.snapshot.boardState['0,0'].vet = 2;
        const target = shown(c, '0,0');
        const i = arm(c, id);
        const e = c.abilityEffects[i];
        c.onHexClicked(shown(c, '1,0'));
        expect(c.myPoints).toBe(100);
        expect(c.buffs).toEqual({});
        c.selectAbility('mine', i, c.myCooldowns);
        c.onHexClicked(target);
        expect(c.buffs.own[stat]).toBe(e[stat]);
        expect(c.myPoints).toBe(100 - c.abilityCosts[i]);
        expect(c.myCooldowns[i]).toBe(e.cooldown);
        c.beginTurnFor('black');
        expect(c.buffs.own[stat]).toBe(e[stat]);
        c.beginTurnFor('white');
        expect(c.buffs.own).toBeUndefined();
      }
    });

    it('refuses pure ATK buffs on unavailable stats without spending points, cooldown or a staged action', () => {
      for (const [id, vet] of [['bishop', 0], ['bishop', 3], ['shieldman', 0], ['shieldman', 1]] as const) {
        const c = current();
        Object.assign(c.gameState.snapshot.boardState['0,0'], { unit_id: id, vet });
        const u = { ...shown(c, '0,0'), vet };
        const i = arm(c, 'warcry');
        c.onHexClicked(u); c.selectedUnit = u;
        expect(c.myPoints).withContext(`${id} ${vet}`).toBe(100);
        expect(c.myCooldowns[i]).toBe(0);
        expect(c.stagedActions.length).toBe(0);
        expect(c.buffs.own).toBeUndefined();
        expect(c.statAtk).toBe('—');
        expect(c.statHel).toBe(id === 'bishop' ? (vet ? '1:8/8 2:6/6 3:4/4 4:2/2' : '1:8/8 2:6/6') : '—');
      }
    });

    it('pins unit details to their owner and closes them on another unit, another same-type unit, or deselection', () => {
      for (const passive of [true, false]) {
        const c = kitRoom(); const first = veteran(c, 'shieldman');
        c.onHexSelected(first);
        const index = passive ? c.slotOfAbility('deflect') : c.unitAbilityIndex(first);
        c.selectUnitAbility(index);
        expect(c.unitAbilityFocus?.uid).toBe(first.uid);
        const other = veteran(c, 'shieldman', '2,0');
        c.onHexHovered(other);
        expect(c.displayUnit.uid).toBe(first.uid);
        expect(c.unitAbilityFocus?.index).toBe(index);
        c.onHexSelected({ ...first, key: '-1,0' });
        expect(c.unitAbilityFocus?.index).toBe(index);
        c.onHexSelected(other);
        expect(c.unitAbilityFocus).toBeNull();
        c.selectUnitAbility(index); c.onHexSelected(null);
        expect(c.unitAbilityFocus).toBeNull();
        const bishop = veteran(c, 'bishop', '3,0'); c.onHexSelected(first); c.onHexHovered(null);
        c.selectUnitAbility(index); c.onHexSelected(bishop);
        expect(c.unitAbilityFocus).toBeNull();
      }
    });

    it('uses Warcry to boost Shove attacks while the shieldman never counters', () => {
      const c = current();
      c.gameState.snapshot.config.units.pawn.defense = 0;
      c.gameState.snapshot.boardState['0,0'].vet = 2;
      const unit = { ...shown(c, '0,0'), vet: 2 };
      const i = arm(c, 'warcry');
      c.onHexClicked(unit);
      c.selectedUnit = unit;
      const attack = c.abilityEffects[i].atk;
      expect(c.statAtk).toBe(`1:${attack + 4}/4`);
      c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
      expect(c.stagedBoard['1,0']).toBeUndefined();
      expect(c.stagedBoard['0,0'].hp).toBe(30);
      c.undoMove(); c.undoMove();
      expect(c.statAtk).toBe('1:4/4');
      expect(c.myPoints).toBe(100);
    });

    it('casts army debuffs once on field and reserve recipients and restores the whole cast after reload and Undo', () => {
      const key = 'cpp.localGame.ui.v2';
      const previous = localStorage.getItem(key);
      try {
        for (const color of ['white', 'black']) {
          for (const [id, stat] of [['sap', 'atk'], ['weakening', 'def'], ['mire', 'mov']]) {
            const c = current(color);
            c.gameId = 'local';
            const enemy = color === 'white' ? 'black' : 'white';
            const reserve = enemy === 'white' ? 'br' : 'tl';
            const base = enemy === 'white' ? 'bl' : 'tr';
            c.boardRef = { clearMarks: () => {}, cells: [
              { key: '11,1', panel: reserve, piece: { unit_id: 'rook', color: enemy, hp: 1, max_hp: 40, uid: 'reserve' } },
              { key: '12,-1', panel: base, piece: { unit_id: 'rook', color: enemy, hp: 40, max_hp: 40, uid: 'base' } },
              { key: '-11,-1', panel: reserve, piece: { unit_id: 'pawn', color, hp: 12, max_hp: 12, uid: 'ally' } },
              { key: '-12,1', panel: reserve, piece: { unit_id: 'pawn', color: enemy, hp: 0, max_hp: 12, uid: 'dead' } },
            ] };
            const before = structuredClone(c.buffs);
            const i = arm(c, id);
            expect(c.pendingAbility).toBeNull();
            expect(c.abilityTargetMode(i)).toBe('universal');
            c.activateFocusedAbility();
            expect(Object.keys(c.buffs).sort()).toEqual(['enemy', 'reserve']);
            expect(c.buffs.enemy[stat]).toBe(c.abilityEffects[i][stat]);
            expect(c.buffs.reserve[stat]).toBe(c.abilityEffects[i][stat]);
            expect(c.myPoints).toBe(100 - c.abilityCosts[i]);
            expect(c.myCooldowns[i]).toBe(c.cooldownOf(i));
            const fresh = current(color);
            fresh.gameId = 'local'; fresh.boardRef = c.boardRef;
            fresh.restoreLocalUiState();
            fresh.undoMove();
            expect(fresh.buffs).toEqual(before);
            expect(fresh.myCooldowns[i]).toBe(0);
            expect(fresh.myPoints).toBe(100);
            c.boardRef.cells[0].panel = base;
            c.boardRef.cells[1].panel = reserve;
            c.beginTurnFor(enemy);
            expect(c.buffs.reserve[stat]).toBe(c.abilityEffects[i][stat]);
            expect(c.buffs.base).toBeUndefined();
            c.beginTurnFor(color);
            expect(c.buffs).toEqual({});
          }
        }
      } finally {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      }
    });

    it('honours Sap and Weakening on reserve defenders through reload, preview and commit for both seats', () => {
      const key = 'cpp.localGame.ui.v2';
      const previous = localStorage.getItem(key);
      try {
        for (const color of ['white', 'black']) {
          for (const ids of [['sap'], ['weakening'], ['sap', 'weakening']]) {
            const c = current(color); c.gameId = 'local';
            const enemy = color === 'white' ? 'black' : 'white';
            const target = { unit_id: 'pawn', color: enemy, hp: 20, max_hp: 20, uid: 'reserve' };
            c.gameState.snapshot.boardState = {
              '0,0': { unit_id: 'pawn', color, hp: 20, max_hp: 20, uid: 'own' },
            };
            c.boardRef = { cells: [{ key: '1,0', panel: enemy === 'white' ? 'br' : 'tl', piece: target }] };
            for (const id of ids) { arm(c, id); c.activateFocusedAbility(); }
            const fresh = current(color); fresh.gameId = 'local'; fresh.boardRef = c.boardRef;
            fresh.restoreLocalUiState();
            fresh.handleWebSocketMessage({ type: 'game_state_update', ...c.gameState.snapshot });
            const sent: any[] = [];
            fresh.wsService = { sendMessage: (message: any) => sent.push(message) };
            fresh.playEndTurnSound = () => {};
            fresh.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0', targetUnit: target,
              panel: enemy === 'white' ? 'br' : 'tl', counters: true });
            const sap = ids.includes('sap'), weak = ids.includes('weakening');
            expect(fresh.panelHp.reserve).withContext(`${color}: ${ids}`).toBe(weak ? 12 : 19);
            expect(fresh.stagedBoard['0,0'].hp).toBe(sap ? 20 : 19);
            expect(fresh.stagedActions.at(-1).countered).toBe(!sap);
            fresh.endTurn();
            expect(sent.find(message => message.type === 'panel_attack')?.bonuses).toEqual({
              atk: 0, def: 0, targetAtk: sap ? -8 : 0, targetDef: weak ? -8 : 0,
            });
          }
        }
      } finally {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      }
    });

    it('caps Mend at maximum HP and preserves its instant heal in the commit payload', () => {
      const c = current();
      c.gameState.snapshot.boardState['0,0'].hp = 20;
      const i = arm(c, 'mend');
      c.onHexClicked(shown(c, '0,0'));
      expect(c.stagedBoard['0,0'].hp).toBe(20 + c.abilityEffects[i].heal);
      c.undoMove();
      expect(c.gameState.snapshot.boardState['0,0'].hp).toBe(20);
      c.gameState.snapshot.boardState['0,0'].hp = 28;
      arm(c, 'mend');
      c.onHexClicked(shown(c, '0,0'));
      expect(c.stagedBoard['0,0'].hp).toBe(30);
      expect(c.myPoints).toBe(100 - c.abilityCosts[i]);
      expect(c.myCooldowns[i]).toBe(1);
      c.beginTurnFor('black');
      expect(c.stagedBoard['0,0'].hp).toBe(30);
      const sent: any[] = [];
      c.wsService.sendMessage = (m: any) => sent.push(m);
      c.endTurn();
      expect(sent[sent.length - 1]).toEqual({
        type: 'pass_turn', effectsBefore: [{ at: '0,0', uid: 'own', hp: 30 }],
      });
    });

    it('deals Strike damage directly, stages a kill and returns HP and its price with Undo', () => {
      const c = current();
      c.gameState.snapshot.boardState['1,0'].hp = 3;
      const i = arm(c, 'strike');
      c.onHexClicked(shown(c, '1,0'));
      expect(c.stagedBoard['1,0']).toBeUndefined();
      expect(c.myPoints).toBe(100 - c.abilityCosts[i]);
      expect(c.myCooldowns[i]).toBe(c.cooldownOf(i));
      c.undoMove();
      expect(c.gameState.snapshot.boardState['1,0'].hp).toBe(3);
      expect(c.myPoints).toBe(100);
      expect(c.myCooldowns[i]).toBe(0);
    });
  });

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

  describe('GameRoomComponent network state revisions', () => {
    it('requests a full snapshot for a revision gap and ignores stale events', () => {
      const sent: any[] = [];
      const gameState = new GameStateService();
      const c: any = new GameRoomComponent(
        { sendMessage: (message: any) => sent.push(message) } as any,
        {} as any, {} as any, {} as any, {} as any,
        { markForCheck: () => {}, detectChanges: () => {} } as any,
        gameState, {} as any, { playTone: () => {} } as any, zone,
        { getConfig: () => DEFAULT_GAME_CONFIG } as any,
      );
      gameState.applyGameStarted({ revision: 1 });

      expect(c.acceptStateRevision({ type: 'move_made', revision: 3 })).toBeFalse();
      expect(sent).toEqual([{ type: 'request_game_state' }]);
      expect(c.acceptStateRevision({ type: 'move_made', revision: 3 })).toBeFalse();
      expect(sent.length).toBe(1);

      expect(c.acceptStateRevision({ type: 'game_state_update', revision: 3 })).toBeTrue();
      gameState.applyFullState({ revision: 3, turnNumber: 2 });
      expect(c.acceptStateRevision({ type: 'move_made', revision: 2 })).toBeFalse();
      expect(c.acceptStateRevision({ type: 'move_made', revision: 3 })).toBeFalse();
    });

    for (const staged of [false, true]) {
      it(`allows retrying a discarded ${staged ? 'move' : 'pass'} after rejoining at the same ply`, () => {
        const c = room();
        const sent: any[] = [];
        c.wsService = { sendMessage: (m: any) => sent.push(m), isLocal: () => false };
        c.isSinglePlayer = false;
        c.gameState = new GameStateService();
        c.persistLocalUiState = () => {};
        c.reconcilePoints = () => {};
        const snapshot = {
          revision: 4, turnNumber: 7, currentTurn: 'me', playerWhite: 'me', playerBlack: 'them',
          config: { ...LEGACY_GAME_CONFIG, rules: { ...LEGACY_GAME_CONFIG.rules, turnTimeLimit: 0 } },
          boardState: {}, moveHistory: [],
        };
        c.gameState.applyGameStarted(snapshot);
        if (staged) c.stagedActions = [{
          at: 1, from: '0,0', to: '1,0', used: 1, attack: null,
          board: { '1,0': { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20 } },
        }];
        const commits = () => sent.filter(m => m.type === (staged ? 'make_move' : 'pass_turn'));

        c.endTurn();
        c.onPlaybackDone();
        c.endTurn();
        expect(commits().length).toBe(1);
        expect(c.canUndo).toBeFalse();

        // The reconnect discarded that queued commit. Its snapshot is unchanged.
        c.handleWebSocketMessage({ type: 'join_game_room_success', gameStatus: 'started' });
        c.handleWebSocketMessage({ type: 'game_state_update', ...snapshot });
        expect(c.turnSubmitted).toBeFalse();
        expect(c.canUndo).toBe(staged);
        c.endTurn();
        c.onPlaybackDone();
        c.endTurn();
        expect(commits().length).toBe(2);
      });
    }

    it('keeps a solo submission latched when joining its local room', () => {
      const c = room();
      c.wsService.isLocal = () => true;
      c.gameState.snapshot.turnNumber = 7;
      c.submittedTurn = 7;
      c.handleWebSocketMessage({ type: 'join_game_room_success', gameStatus: 'started' });
      expect(c.turnSubmitted).toBeTrue();
    });

    it('applies an authoritative full snapshot at the current revision', () => {
      const gameState = new GameStateService();
      const c: any = new GameRoomComponent(
        { sendMessage: () => {} } as any,
        {} as any, {} as any, {} as any, {} as any,
        { markForCheck: () => {}, detectChanges: () => {} } as any,
        gameState, {} as any, { playTone: () => {} } as any, zone,
        { getConfig: () => DEFAULT_GAME_CONFIG } as any,
      );
      gameState.applyGameStarted({ revision: 4, turnNumber: 1 });
      c.stateResyncPending = true;
      c.reconcilePoints = () => {};
      c.startTurnClock = () => {};

      c.handleWebSocketMessage({
        type: 'game_state_update',
        revision: 4,
        turnNumber: 7,
        currentTurn: 'opponent',
        boardState: { '0,0': { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20 } },
        moveHistory: [],
        config: LEGACY_GAME_CONFIG,
      });

      expect(gameState.snapshot.turnNumber).toBe(7);
      expect(gameState.snapshot.boardState['0,0'].unit_id).toBe('pawn');
      expect(c.stateResyncPending).toBeFalse();
    });

    it('accepts a same-revision game_over only once after its turn event', () => {
      const gameState = new GameStateService();
      const c: any = new GameRoomComponent(
        { sendMessage: () => {} } as any,
        {} as any, {} as any, {} as any, {} as any,
        { markForCheck: () => {}, detectChanges: () => {} } as any,
        gameState, {} as any, { playTone: () => {} } as any, zone,
        { getConfig: () => DEFAULT_GAME_CONFIG } as any,
      );
      gameState.applyGameStarted({ revision: 1 });

      expect(c.acceptStateRevision({ type: 'move_made', revision: 2 })).toBeTrue();
      gameState.applyMoveMade({ revision: 2, move: {} });
      expect(c.acceptStateRevision({ type: 'game_over', revision: 2 })).toBeTrue();
      gameState.applyGameOver({ revision: 2, endReason: 'regicide' });
      expect(c.acceptStateRevision({ type: 'game_over', revision: 2 })).toBeFalse();
    });

    it('draws a player called "System" as a player, not as a notice', () => {
      const c: any = new GameRoomComponent(
        { sendMessage: () => {} } as any,
        {} as any, {} as any, {} as any, {} as any,
        { markForCheck: () => {}, detectChanges: () => {} } as any,
        new GameStateService(), {} as any, { playTone: () => {} } as any, zone,
        { getConfig: () => DEFAULT_GAME_CONFIG } as any,
      );
      c.persistLocalUiState = () => {};
      c.scrollChatToBottom = () => {};
      c.addSystemMessage('Game mode changed to Default');

      c.handleWebSocketMessage({
        type: 'game_room_message', username: 'System',
        content: 'Game mode changed - you have resigned', timestamp: '',
      });

      expect(c.historyMessages.map((m: any) => m.content)).toEqual(['Game mode changed to Default']);
      expect(c.gameRoomChatMessages.map((m: any) => m.content))
        .toEqual(['Game mode changed - you have resigned']);
    });

    it('announces a finished game once, however many resyncs repeat it', () => {
      const gameState = new GameStateService();
      const c: any = new GameRoomComponent(
        { sendMessage: () => {} } as any,
        {} as any, {} as any, {} as any, {} as any,
        { markForCheck: () => {}, detectChanges: () => {} } as any,
        gameState, {} as any, { playTone: () => {} } as any, zone,
        { getConfig: () => DEFAULT_GAME_CONFIG } as any,
      );
      c.username = 'me';
      c.reconcilePoints = () => {};
      const said: string[] = [];
      c.addSystemMessage = (text: string) => said.push(text);
      const finished = {
        type: 'game_state_update', revision: 9, turnNumber: 30, currentTurn: 'them',
        boardState: {}, moveHistory: [], config: LEGACY_GAME_CONFIG,
        winner: 'me', endReason: 'regicide',
      };

      // A reload into a game already over: said once, popup up.
      c.handleWebSocketMessage(finished);
      expect(said.length).toBe(1);
      expect(c.showEndModal).toBeTrue();

      // The player closes it, and a later resync of the same result.
      c.showEndModal = false;
      c.handleWebSocketMessage({ ...finished });
      expect(said.length).toBe(1);
      expect(c.showEndModal).toBeFalse();
      expect(gameState.snapshot.currentTurn).toBe('');
    });
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

  it('pays each turn at its rate, and puts it in the purse with the record', () => {
    // One place hands the turn's pay out: the record's sum, which every
    // hand-over lays over both purses (`reconcilePoints`). It used to be paid
    // live as well, and a second copy is a second thing to get wrong.
    const c = room();
    c.gameState.snapshot.config = { units: {} };
    c.gameState.snapshot.moveHistory = [];

    // Turn 19 is the last before Phase 2's halftime: 19 at one apiece, and
    // Phases 1 and 2's grants, 10 and 20.
    c.gameState.snapshot.turnNumber = 2 * 19 - 1;
    expect(c.pointsFromHistory('white')).toBe(19 + 30);
    // The halftime (turn 20) pays two; Phase 3's (turn 31) three, with its 30.
    c.gameState.snapshot.turnNumber = 2 * 20 - 1;
    expect(c.pointsFromHistory('white')).toBe(21 + 30);
    c.gameState.snapshot.turnNumber = 2 * 31 - 1;
    expect(c.pointsFromHistory('white')).toBe(44 + 60);
    // And overtime pays nothing: 59 in rates and 60 in grants by turn 36.
    c.gameState.snapshot.turnNumber = 2 * 50 - 1;
    expect(c.pointsFromHistory('white')).toBe(119);

    // Beginning a turn pays nothing by itself; the re-sum after it does.
    c.gameState.snapshot.turnNumber = 2 * 4 - 1;
    c.myPoints = 0;
    c.beginTurnFor('white');
    expect(c.myPoints).toBe(0);
    c.reconcilePoints();
    expect(c.myPoints).toBe(4 + 10);
  });

  it('turns the banked victory points into points as overtime begins', () => {
    // The owner, 24 Sep 2026: "at the start of the overtime, all your
    // accumlated victory points turn into regular points." Once, as a side's
    // first overtime turn begins - white on hand-over 73, black on 74.
    const c = room();
    c.gameState.snapshot.config = { units: {} };
    c.gameState.snapshot.moveHistory = [];
    // 14 against 4: ten clear, not more, so it goes to overtime.
    c.gameState.snapshot.phaseBank = {
      1: { white: 5, black: 1 }, 2: { white: 9, black: 0 }, 3: { white: 0, black: 3 },
    };
    const history = (ply: number, color: 'white' | 'black') => {
      c.gameState.snapshot.turnNumber = ply;
      return c.pointsFromHistory(color);
    };
    expect(history(72, 'white')).toBe(119);
    expect(history(73, 'white')).toBe(119 + 14);
    expect(history(99, 'white')).toBe(119 + 14);
    expect(history(73, 'black')).toBe(119);
    expect(history(74, 'black')).toBe(119 + 4);

    // A match won on points ends ON hand-over 73 and never reaches overtime:
    // its finished position converts nothing.
    c.gameState.snapshot.phaseBank = {
      1: { white: 30, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    };
    expect(history(73, 'white')).toBe(119);
  });

  it('separates unit transactions in UP from regular ability points', () => {
    // Both engines keep unit transactions in UP and scheduled income in regular points.
    const c = room();
    c.gameState.snapshot.config = { units: { knight: { value: 12 }, queen: { value: 30 }, pawn: { value: 5 } } };
    c.gameState.snapshot.turnNumber = 21;
    c.gameState.snapshot.moveHistory = [];
    // A point for each of white's eleven turns begun by ply 21, and Phase 1's
    // 10 as it began.
    expect(c.pointsFromHistory('white')).toBe(21);
    expect(c.pointsFromHistory('black')).toBe(20);

    const wrap = { panelMove: true, price: 12, unit: { color: 'white' } };
    const home = { withdrawn: true, color: 'white', unit_id: 'knight', unit: {} };
    c.gameState.snapshot.moveHistory = [wrap];
    expect(c.pointsFromHistory('white')).toBe(21);
    c.reconcilePoints();
    expect(c.myUnitPoints).toBe(10 - 12);
    // A round trip costs nothing.
    c.gameState.snapshot.moveHistory = [wrap, home];
    expect(c.pointsFromHistory('white')).toBe(21);

    // A kill pays its maker the dead unit's worth; the attacker dying to a
    // counter pays the defender its worth; a cast that kills pays nobody; and
    // a blow into a panel pays nobody either, base or reserve.
    const into = { intoPanel: true, panelAttack: true };
    c.gameState.snapshot.moveHistory = [
      { color: 'white', unit_id: 'pawn', captured: 'queen', defender_eliminated: true },
      { color: 'black', unit_id: 'knight', attacker_eliminated: true },
      { panelEffect: true, color: 'white', captured: 'queen', defender_eliminated: true },
      { ...into, panel: 'tr', color: 'white', unit_id: 'pawn', captured: 'queen', defender_eliminated: true },
      { ...into, panel: 'tl', color: 'white', unit_id: 'knight', attacker_eliminated: true },
    ];
    expect(c.pointsFromHistory('white')).toBe(21);
    c.reconcilePoints();
    expect(c.myUnitPoints).toBe(10 + 30 + 12);
    expect(c.opponentUnitPoints).toBe(10);
    expect(c.pointsFromHistory('black')).toBe(20);
  });

  it('prices both seats in UP, keeps ability spending separate, and reverses staged crossings', () => {
    const c = room();
    c.username = 'me';
    c.gameState = new GameStateService();
    for (const mine of ['white', 'black']) {
      c.gameState.applyGameStarted({ playerWhite: mine === 'white' ? 'me' : 'bot',
        playerBlack: mine === 'black' ? 'me' : 'bot', currentTurn: 'me', turnNumber: mine === 'white' ? 9 : 10,
        config: { rules: { upAtStart: 10 }, units: {} }, boardState: {} });
      c.myAbilityPoints = 100;
      c.reconcilePoints();
      expect(c.movePoints).toBe(10);
      expect(c.theirMovePoints).toBe(10);
      c.onWrapCrossed(8);
      expect(c.myUnitPoints).toBe(2);
      expect(c.myPoints).toBe(115);
      c.chargeFor('mine', c.slotOfAbility('warcry'), 3);
      expect(c.myUnitPoints).toBe(2);
      const points = c.myPoints;
      c.boardRef = { lastPanelMove: 1, undoPanelMove: () => 8, clearMarks: () => {} };
      c.undoMove();
      expect(c.myUnitPoints).toBe(10);
      expect(c.myPoints).toBe(points);
      c.boardRef = undefined;
    }
  });

  it('keeps a committed crossing charged once while the board still holds its previous-turn staging', () => {
    const c = room(); c.username = 'me'; c.gameState = new GameStateService();
    const config = { units: { pawn: { value: 8 } } };
    c.gameState.applyGameStarted({ playerWhite: 'me', playerBlack: 'bot', currentTurn: 'me',
      turnNumber: 7, config, boardState: {} });
    const step = { type: 'panel_move', from: '-12,6', to: '11,1', price: 8, unit: { color: 'white' } };
    c.boardRef = { turnNumber: 7, pendingPanelSteps: [step] };
    c.reconcilePoints(); expect(c.myUnitPoints).toBe(2);
    const move = { ...step, turn: 7, panelMove: true };
    c.handleWebSocketMessage({ type: 'game_state_update', turnNumber: 7, currentTurn: 'me',
      config, boardState: {}, moveHistory: [move] });
    expect(c.myUnitPoints).toBe(2);
    c.handleWebSocketMessage({ type: 'turn_passed', color: 'white', turnNumber: 8,
      currentTurn: 'bot', boardState: {} });
    expect(c.myUnitPoints).toBe(2); expect(c.opponentUnitPoints).toBe(10);
  });

  it('restores a staged withdrawal refund and keeps it single when the committed crossing resyncs', () => {
    const c = room(); c.gameId = 'local'; c.username = 'me';
    c.gameState = new GameStateService();
    const snapshot = { playerWhite: 'me', playerBlack: 'bot', currentTurn: 'me', turnNumber: 27,
      config: { units: { pawn: { move: 6, value: 8 } } },
      boardState: { '-5,9': { unit_id: 'pawn', color: 'white', hp: 12, max_hp: 12, uid: 'wp' } } };
    c.gameState.applyGameStarted(snapshot); c.reconcilePoints();
    c.onPlayerMove({ from: '-5,9', to: '-12,11', cost: 1, refund: 8 });
    expect(c.myUnitPoints).toBe(18);
    const fresh = room(); fresh.gameId = 'local'; fresh.username = 'me';
    fresh.gameState = new GameStateService(); fresh.restoreLocalUiState();
    fresh.handleWebSocketMessage({ type: 'game_state_update', ...snapshot, moveHistory: [] });
    expect(fresh.myUnitPoints).toBe(18);
    fresh.undoMove(); expect(fresh.myUnitPoints).toBe(10);
    expect(fresh.myPoints).toBe(24);
    c.handleWebSocketMessage({ type: 'game_state_update', ...snapshot, boardState: {}, moveHistory: [
      { turn: 27, from: '-5,9', to: '-12,11', unit_id: 'pawn', color: 'white', withdrawn: true },
    ] });
    expect(c.myUnitPoints).toBe(18);
    localStorage.removeItem('cpp.localGame.ui.v2');
  });

  it('discards withdrawals from an earlier turn before reconciling live and restored snapshots for both seats', () => {
    const key = 'cpp.localGame.ui.v2';
    const previous = localStorage.getItem(key);
    try {
      for (const color of ['white', 'black']) {
        const c = room(); c.gameId = 'local'; c.gameState = new GameStateService();
        const ply = color === 'white' ? 27 : 28;
        const from = color === 'white' ? '-5,9' : '5,-9';
        const to = color === 'white' ? '-12,11' : '12,-11';
        const snapshot = { playerWhite: color === 'white' ? 'me' : 'bot',
          playerBlack: color === 'black' ? 'me' : 'bot', currentTurn: 'me', turnNumber: ply,
          config: { units: { pawn: { move: 6, value: 8 } } },
          boardState: { [from]: { unit_id: 'pawn', color, hp: 12, max_hp: 12, uid: 'veteran' } } };
        c.gameState.applyGameStarted(snapshot); c.reconcilePoints();
        c.onPlayerMove({ from, to, cost: 1, refund: 8 });
        expect(c.myUnitPoints).toBe(18);
        const saved = localStorage.getItem(key)!;
        const restored = room(); restored.gameId = 'local'; restored.gameState = new GameStateService();
        restored.restoreLocalUiState();
        const moveHistory = [{ turn: ply, from, to, unit_id: 'pawn', color, withdrawn: true }];
        for (const r of [c, restored]) {
          for (const advance of [1, 2]) {
            r.handleWebSocketMessage({ type: 'game_state_update', ...snapshot, boardState: {},
              turnNumber: ply + advance, currentTurn: advance === 1 ? 'bot' : 'me', moveHistory });
            expect(r.myUnitPoints).withContext(`${color}, +${advance}`).toBe(18);
            expect(r.opponentUnitPoints).toBe(10);
            expect(r.stagedActions).toEqual([]);
            expect(r.stagedBoard).toBeNull();
          }
        }
        // An older UI save with no turn provenance cannot overlay a loaded match.
        const oldSave = JSON.parse(saved); delete oldSave.turnNumber;
        localStorage.setItem(key, JSON.stringify(oldSave));
        const legacy = room(); legacy.gameId = 'local'; legacy.gameState = new GameStateService();
        legacy.restoreLocalUiState();
        legacy.handleWebSocketMessage({ type: 'game_state_update', ...snapshot, moveHistory: [] });
        expect(legacy.stagedActions).toEqual([]);
        expect(legacy.myUnitPoints).toBe(10);
      }
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it('marks only a game_started message as a fresh start, including at ply one', () => {
    const c = room(); c.gameState = new GameStateService();
    c.startTurnClock = () => {}; c.playTurnSoundIfNeeded = () => {};
    const snapshot = { playerWhite: 'me', playerBlack: 'bot', currentTurn: 'me',
      turnNumber: 1, config: DEFAULT_GAME_CONFIG, boardState: {} };
    c.handleWebSocketMessage({ type: 'game_started', ...snapshot });
    expect(c.freshGameStart).toBeTrue();
    c.handleWebSocketMessage({ type: 'game_state_update', ...snapshot, moveHistory: [] });
    expect(c.freshGameStart).toBeFalse();
    c.handleWebSocketMessage({ type: 'game_started', ...snapshot });
    expect(c.freshGameStart).toBeTrue();
  });

  it('reconstructs halftime UP from messages and resyncs without putting awards in the action log', () => {
    const c = room();
    c.username = 'me'; c.gameState = new GameStateService();
    c.gameState.applyGameStarted({ playerWhite: 'bot', playerBlack: 'me', currentTurn: 'me',
      turnNumber: 16, config: { units: {} }, boardState: {} });
    const award = { turn: 17, halftimeUp: { phase: 1, white: 38, black: 19 } };
    c.handleWebSocketMessage({ type: 'turn_passed', color: 'black', currentTurn: 'bot',
      turnNumber: 17, effects: [award], boardState: {} });
    expect(c.myUnitPoints).toBe(29); expect(c.opponentUnitPoints).toBe(48);
    expect(c.turnRecords(17, 'white')).toEqual([]);
    const snapshot = c.gameState.snapshot;
    c.handleWebSocketMessage({ type: 'game_state_update', ...snapshot });
    expect(c.myUnitPoints).toBe(29); expect(c.opponentUnitPoints).toBe(48);
    expect(c.myPoints).toBe(18);
  });

  it('resets both purses from the history, and keeps what abilities did in solo', () => {
    const networked = room();
    networked.isSinglePlayer = false;
    networked.gameState.snapshot.config = { units: {} };
    networked.gameState.snapshot.turnNumber = 3;
    networked.gameState.snapshot.moveHistory = [];
    networked.myPoints = 99;          // a stale tally, as after a reload
    networked.reconcilePoints();
    expect(networked.myPoints).toBe(2);
    expect(networked.opponentPoints).toBe(1);

    // Solo is summed from the record too. It buys abilities with points, and
    // abilities are not recorded - so what they did is kept apart and added
    // on, and the reset hands back nothing spent on one.
    const solo = room();
    solo.gameState.snapshot.config = { units: {} };
    solo.gameState.snapshot.turnNumber = 3;
    solo.gameState.snapshot.moveHistory = [];
    solo.myPoints = 99;               // a stale tally
    solo.reconcilePoints();
    expect(solo.myPoints).toBe(2);
    const pool = solo.abilityIds.findIndex((_: string, i: number) => !solo.isPathSlot(i));
    (solo as any).chargeFor('mine', pool, 5);
    expect(solo.myAbilityPoints).toBe(-5);
    solo.reconcilePoints();
    expect(solo.myPoints).toBe(2 - 5);
    // A refund hands it back through the same door.
    (solo as any).chargeFor('mine', pool, -5);
    solo.reconcilePoints();
    expect(solo.myPoints).toBe(2);
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

  it('ignores incomplete saved panel effects without a unit ID or an HP result', () => {
    const c = room();
    c.gameState.snapshot.turnNumber = 8;
    c.gameState.snapshot.moveHistory = [{ to: 'b1', turn: 6, withdrawn: true,
      unit: { uid: 'u1', unit_id: 'rook', color: 'white', hp: 9, max_hp: 40 } }];
    const units = c.withdrawnUnits;
    const hp = c.panelHp;
    for (const action of [{ panelUnit: {}, panelUnitHp: 0 }, { panelUnit: { uid: 'u1' } }]) {
      c.stagedActions = [action];
      expect(c.withdrawnUnits).toBe(units);
      expect(c.panelHp).toBe(hp);
      expect(Object.keys(c.panelHp)).not.toContain('undefined');
    }
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
    expect(c.focusedAbilityBlocker).toBe(`On cooldown: 2/${c.abilityEffects[TARGETED].cooldown}.`);
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

  it('beeps once per final second, sounds a hard expiry and commits staged work once in either mode', () => {
    for (const solo of [true, false]) {
      const c = room();
      const sent: any[] = [];
      c.wsService = { sendMessage: (m: any) => sent.push(m) };
      c.persistLocalUiState = () => {};
      c.playSteps = () => {};
      c.playEndTurnSound = () => {};
      const warning = spyOn(c, 'playTone');
      const hard = spyOn(c.audioService, 'playTone');
      c.isSinglePlayer = solo;
      c.gameState.snapshot.turnNumber = 7;
      c.gameState.snapshot.turnTimeLimit = 15;
      c.stagedActions = [{ at: 7, board: {}, from: '0,0', to: '0,1', used: 1, attack: null }];
      for (let seconds = 6; seconds >= 0; seconds--) {
        c.gameState.snapshot.turnStartedAt = new Date(Date.now() - (15 - seconds) * 1000).toISOString();
        c.updateTurnClock();
        c.updateTurnClock();
      }
      expect(warning.calls.allArgs()).toEqual(Array.from({ length: 5 }, () => [[880], 0.08]));
      expect(hard).toHaveBeenCalledOnceWith([220, 110], 0.16, { type: 'triangle' });
      expect(c.turnSecondsRemaining).toBe(0);
      expect(sent.length).toBe(1);
      expect(sent[0]).toEqual(jasmine.objectContaining({ type: 'make_move', from: '0,0', to: '0,1' }));
    }
  });

  it('commits panel-only and empty turns at expiry, and never submits the opponent’s online turn', () => {
    for (const panel of [false, true]) {
      const c = room();
      const sent: any[] = [];
      c.wsService = { sendMessage: (m: any) => sent.push(m) };
      c.persistLocalUiState = () => {}; c.playSteps = () => {}; c.playEndTurnSound = () => {};
      c.gameState.snapshot.turnNumber = 7;
      c.gameState.snapshot.turnTimeLimit = 15;
      c.gameState.snapshot.turnStartedAt = new Date(Date.now() - 16_000).toISOString();
      const panelStep = { type: 'make_move', from: '-6,11', to: '-7,11', panel: 'bl' };
      c.boardRef = panel ? { pendingPanelSteps: [panelStep] } : undefined;
      c.lastTimerBeep = 1;
      c.isSinglePlayer = false; c.gameState.snapshot.currentTurn = 'opponent';
      c.updateTurnClock(); expect(sent).toEqual([]);
      c.lastTimerBeep = 1; c.gameState.snapshot.currentTurn = 'me';
      c.updateTurnClock();
      expect(sent).toEqual(panel ? [panelStep, jasmine.objectContaining({ type: 'pass_turn' })]
        : [jasmine.objectContaining({ type: 'pass_turn' })]);
    }
  });

  it('sounds expiry once if the server timeout arrives before the local clock tick', () => {
    const c = room();
    const hard = spyOn(c.audioService, 'playTone');
    c.gameState.applyTurnPassed = () => {};
    c.beginTurnFor = () => {}; c.reconcilePoints = () => {};
    c.playTurnSoundIfNeeded = () => {}; c.startTurnClock = () => {};
    c.turnRecords = () => []; c.showTurn = () => {}; c.addSystemMessage = () => {};
    c.persistLocalUiState = () => {};
    c.lastTimerBeep = 1;
    const message = { type: 'turn_passed', timedOut: true, color: 'white' };
    c.handleWebSocketMessage(message);
    c.handleWebSocketMessage(message);
    expect(hard).toHaveBeenCalledOnceWith([220, 110], 0.16, { type: 'triangle' });
  });

  it('stages, undoes and commits a bishop heal as its one action without CP or an attack', () => {
    const c = room();
    const sent: any[] = [];
    c.wsService.sendMessage = (m: any) => sent.push(m);
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.gameState.snapshot.turnNumber = 7;
    c.gameState.snapshot.config = structuredClone(LEGACY_GAME_CONFIG);
    c.gameState.snapshot.config.units.bishop.heal = [14, 13, 12, 11];
    c.gameState.snapshot.boardState = {
      '0,0': { unit_id: 'bishop', color: 'white', hp: 22, max_hp: 22, uid: 'bishop' },
      '3,0': { unit_id: 'rook', color: 'white', hp: 5, max_hp: 50, uid: 'rook' },
    };
    const cp = c.myCpSpent;
    c.onPlayerMove({ from: '0,0', to: '1,0', cost: 1 });
    const heal = { from: '1,0', to: '1,0', attack: '3,0', heal: true };
    c.onPlayerAttack(heal);
    expect(c.stagedBoard['3,0'].hp).toBe(18);
    expect(c.gameState.snapshot.boardState['3,0'].hp).toBe(5);
    expect(c.canMoveOnBoard).toBeFalse();
    expect(c.movesLeft).toBe(0);
    expect(c.attackMarkers).toEqual([]);
    expect(c.movedUnitHexes).toEqual(['1,0']);
    expect(c.myCpSpent).toBe(cp);
    c.onPlayerAttack(heal);
    expect(c.stagedActions.length).toBe(2);
    c.undoMove();
    expect(c.stagedBoard['3,0'].hp).toBe(5);
    expect(c.canMoveOnBoard).toBeTrue();
    c.onPlayerAttack(heal);
    c.endTurn();
    expect(sent).toEqual([{ type: 'make_move', from: '0,0', to: '1,0', heal: '3,0' }]);
    expect(c.myCpSpent).toBe(cp);
    expect(c.describeMove({ from: '0,0', to: '1,0', color: 'white', unit_id: 'bishop',
      healedHex: '3,0', healed_unit: 'rook', healed_amount: 13, healed_hp: 18, attacked: false }))
      .toContain('healed rook');
  });

  it('stages, undoes and commits normal healing in every postmatch', () => {
    for (const ply of [27, 28, 49, 50, 71, 72]) {
      const c = room();
      const color = ply % 2 ? 'white' : 'black';
      c.gameState.myColor = () => color;
      c.gameState.snapshot.turnNumber = ply;
      c.gameState.snapshot.config = structuredClone(DEFAULT_GAME_CONFIG);
      c.gameState.snapshot.boardState = {
        '0,0': { unit_id: 'bishop', color, hp: 8, max_hp: 8, uid: 'bishop' },
        '1,0': { unit_id: 'rook', color, hp: 5, max_hp: 40, uid: 'rook' },
      };
      c.persistLocalUiState = () => {};
      c.playSteps = () => {};
      const sent: any[] = [];
      c.wsService.sendMessage = (m: any) => sent.push(m);
      const heal = { from: '0,0', to: '0,0', attack: '1,0', heal: true };
      c.onPlayerAttack(heal);
      expect(c.stagedBoard['1,0'].hp).withContext(`ply ${ply}`).toBe(13);
      c.undoMove();
      expect((c.stagedBoard ?? c.gameState.snapshot.boardState)['1,0'].hp).toBe(5);
      c.onPlayerAttack(heal);
      c.endTurn();
      expect(sent).toEqual([{ type: 'make_move', from: '0,0', to: '0,0', heal: '1,0' }]);
    }
  });

  it('never plays or deals a counter from a healer, even carrying an ATK boost', () => {
    const c = room();
    c.persistLocalUiState = () => {}; c.playSteps = () => {};
    c.gameState.snapshot.turnNumber = 7;
    c.gameState.snapshot.config = LEGACY_GAME_CONFIG;
    c.gameState.snapshot.boardState = {
      '0,0': { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid: 'wp' },
      '1,0': { unit_id: 'bishop', color: 'black', hp: 22, max_hp: 22, uid: 'bb' },
    };
    c.buffs = { bb: { atk: 30, def: 0, mov: 0 } };
    c.onPlayerAttack({ from: '0,0', to: '0,0', attack: '1,0' });
    expect(c.stagedBoard['0,0'].hp).toBe(20);
    expect(c.stagedActions.at(-1).countered).toBeFalse();
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

  it('restores mixed-caster effects and unit cooldowns, then ticks them only on incoming turns', () => {
    const key = 'cpp.localGame.ui.v2';
    const previous = localStorage.getItem(key);
    const freshRoom = () => {
      const c = room();
      c.gameId = 'local';
      c.gameState = new GameStateService();
      c.gameState.applyGameStarted({
        playerWhite: 'me', playerBlack: 'bot', currentTurn: 'me', turnNumber: 9,
        config: LEGACY_GAME_CONFIG,
        boardState: {
          '0,0': { unit_id: 'pawn', color: 'white', hp: 12, max_hp: 12, uid: 'wp' },
          '2,0': { unit_id: 'pawn', color: 'black', hp: 12, max_hp: 12, uid: 'bp' },
          '4,0': { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'wr' },
        },
      });
      return c;
    };
    try {
      const c = freshRoom();
      c.buffs = {
        wp: {
          mov: 0, atk: -2, def: -2, caster: 'white', label: 'Sap', up: true, down: true,
          effects: [
            { name: 'Dash', mov: 2, atk: 0, def: 0, turns: 2, caster: 'white' },
            { name: 'Sap', mov: -2, atk: -2, def: -2, turns: 1, caster: 'black', hostile: true },
          ],
        },
        wr: {
          mov: 2, atk: 0, def: 0, caster: 'white', label: 'Dash',
          effects: [{ name: 'Dash', mov: 2, atk: 0, def: 0, turns: 1 }],
        },
      };
      c.unitCooldowns = { wp: { color: 'white', turns: 2 }, bp: { color: 'black', turns: 1 } };
      c.persistLocalUiState();
      const fresh = freshRoom();
      fresh.restoreLocalUiState();
      expect(fresh.buffs).toEqual(c.buffs);
      expect(fresh.unitCooldowns).toEqual(c.unitCooldowns);

      fresh.handleWebSocketMessage({ type: 'game_state_update', ...fresh.gameState.snapshot });
      expect(fresh.buffs).toEqual(c.buffs);
      expect(fresh.unitCooldowns).toEqual(c.unitCooldowns);
      fresh.handleWebSocketMessage({
        type: 'turn_passed', color: 'white', currentTurn: 'bot', turnNumber: 10,
      });
      expect(fresh.buffs.wp.effects.map((e: any) => [e.name, e.turns])).toEqual([['Dash', 2]]);
      expect([fresh.buffs.wp.mov, fresh.buffs.wp.atk, fresh.buffs.wp.def, fresh.buffs.wp.down])
        .toEqual([2, 0, 0, false]);
      expect(fresh.buffs.wr.effects[0].turns).toBe(1);
      expect(fresh.unitCooldowns).toEqual({ wp: { color: 'white', turns: 2 } });

      const reloaded = freshRoom();
      reloaded.gameState.applyFullState(fresh.gameState.snapshot);
      reloaded.restoreLocalUiState();
      expect(reloaded.buffs).toEqual(fresh.buffs);
      expect(reloaded.unitCooldowns).toEqual(fresh.unitCooldowns);
      reloaded.handleWebSocketMessage({
        type: 'move_made', currentTurn: 'me', turnNumber: 11,
        move: { color: 'black', unit_id: 'pawn', from: '2,0', to: '2,1', turn: 10, moved: true },
      });
      expect(reloaded.buffs.wp.effects[0].turns).toBe(1);
      expect(reloaded.buffs.wr).toBeUndefined();
      expect(reloaded.unitCooldowns).toEqual({ wp: { color: 'white', turns: 1 } });
      reloaded.handleWebSocketMessage({
        type: 'turn_passed', color: 'white', currentTurn: 'bot', turnNumber: 12,
      });
      expect(reloaded.buffs.wp.effects[0].turns).toBe(1);
      expect(reloaded.unitCooldowns).toEqual({ wp: { color: 'white', turns: 1 } });
      reloaded.handleWebSocketMessage({
        type: 'turn_passed', color: 'black', currentTurn: 'me', turnNumber: 13,
      });
      expect(reloaded.buffs).toEqual({});
      expect(reloaded.unitCooldowns).toEqual({});
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it('ticks the correct slot cooldown row when the local seat is Black', () => {
    const c = room();
    c.gameState = new GameStateService();
    c.gameState.applyGameStarted({
      playerWhite: 'bot', playerBlack: 'me', currentTurn: 'bot', turnNumber: 9,
      config: LEGACY_GAME_CONFIG,
    });
    const dash = c.slotOfAbility('dash');
    const sap = c.slotOfAbility('sap');
    const focus = c.slotOfAbility('focus');
    c.myCooldowns[dash] = 2;
    c.myCooldowns[sap] = 1;
    c.opponentCooldowns[focus] = 2;

    c.handleWebSocketMessage({
      type: 'move_made', currentTurn: 'me', turnNumber: 10,
      move: { color: 'white', unit_id: 'pawn', from: '0,0', to: '0,1', turn: 9, moved: true },
    });
    expect([c.myCooldowns[dash], c.myCooldowns[sap], c.opponentCooldowns[focus]])
      .toEqual([1, 0, 2]);
    c.handleWebSocketMessage({
      type: 'turn_passed', color: 'black', currentTurn: 'bot', turnNumber: 11,
    });
    expect([c.myCooldowns[dash], c.myCooldowns[sap], c.opponentCooldowns[focus]])
      .toEqual([1, 0, 1]);
    c.handleWebSocketMessage({
      type: 'turn_passed', color: 'white', currentTurn: 'me', turnNumber: 12,
    });
    expect([c.myCooldowns[dash], c.myCooldowns[sap], c.opponentCooldowns[focus]])
      .toEqual([0, 0, 1]);
  });

  it('forgives a CP spend saved before CP was earned, and keeps one saved since', () => {
    // A save from the flat 100-a-phase days spent out of a purse that no
    // longer exists; read against what is earned now it would sit in debt.
    const c = room();
    c.gameId = 'local';
    localStorage.setItem('cpp.localGame.ui.v2', JSON.stringify({ myCpSpent: 150, opponentCpSpent: 90 }));
    (c as any).restoreLocalUiState();
    expect(c.myCpSpent).toBe(0);
    expect(c.opponentCpSpent).toBe(0);

    c.myCpSpent = 4;
    c.myAbilityPoints = -7;
    (c as any).persistLocalUiState();
    const fresh = room();
    fresh.gameId = 'local';
    (fresh as any).restoreLocalUiState();
    expect(fresh.myCpSpent).toBe(4);
    // And what abilities did to the points purse, the part no record holds.
    expect(fresh.myAbilityPoints).toBe(-7);
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

  it('does not advertise unit rank gates on pool abilities', () => {
    const c = room();
    for (const index of c.abilityPool) {
      expect(c.abilityHint(index)).withContext(c.abilityEffects[index].name).not.toContain('(needs ');
    }
    expect(c.unitAbilityHint(0)).toContain('needs ★★');
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
    fundCp(c, 10);
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
    fundCp(c, 10);
    c.unlockPath('mine', 0);
    const ult = c.abilityPaths[0].ultimate;
    giveCp(c, 20);
    c.selectAbility('mine', ult, c.myCooldowns);
    expect(c.focusedAbilityCanActivate()).toBeTrue();

    c.activateFocusedAbility();
    // Spent - its one use of the match - and the other player can see which
    // one it was.
    expect(c.usesLeft('mine', ult)).toBe(0);
    expect(c.focusedAbilityCanActivate()).toBeFalse();
    expect(c.isRecent('mine', ult)).toBeTrue();
    expect(c.isRecent('opponent', ult)).toBeFalse();
  });

  it('lights the passive a path is named by, and only that', () => {
    const c = room();
    fundCp(c, 10);
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
    fundCp(c, 10);
    c.focusPath('mine', 0);
    expect(c.abilityNote('mine')).toContain('Pick to take the path');

    // Before a game there is no turn to be waiting for.
    c.clearPathFocus();
    c.gameStarted = false;
    expect(c.abilityNote('mine')).toBe('The game has not started yet.');
  });

  it('starts each side on 5 CP and earns the rest at the start of each postmatch', () => {
    // The owner, 24 Sep 2026: "at the start of the game, user has 5cp", and
    // "cp should be awarded at the start of post match" - phase_x (5, 10, 15)
    // plus both sides' scores for the phase, plus the gap for whoever scored
    // less. The engine's bank is the record of the awards.
    const c = room();
    c.myCpSpent = 0;
    c.opponentCpSpent = 0;
    c.gameState.snapshot.turnNumber = 26;   // turn 13, the last of Phase 1's play
    c.gameState.snapshot.phaseBank = {};
    expect(c.cpOf('mine')).toBe(5);
    expect(c.cpOf('opponent')).toBe(5);

    // Phase 1 banks as its postmatch begins: this seat (white) 12, black 4.
    c.gameState.snapshot.turnNumber = 27;
    c.gameState.snapshot.phaseBank = { 1: { white: 12, black: 4 } };
    expect(c.cpOf('mine')).toBe(5 + 21);       // 5 + 16
    expect(c.cpOf('opponent')).toBe(5 + 29);   // 5 + 16, and the 8 it was behind

    // Phase 2's adds its own, on top: 10 + 6 each.
    c.gameState.snapshot.turnNumber = 49;
    c.gameState.snapshot.phaseBank = { 1: { white: 12, black: 4 }, 2: { white: 3, black: 3 } };
    expect(c.cpOf('mine')).toBe(5 + 21 + 16);
    expect(c.cpOf('opponent')).toBe(5 + 29 + 16);

    // Both numbers are the room's config, and what is spent comes off.
    c.gameState.snapshot.config = { rules: { cpAtStart: 0, cpPhaseOffset: 7 } };
    expect(c.cpOf('mine')).toBe(23 + 20);      // (7 + 16) + (14 + 6)
    c.myCpSpent = 7;
    expect(c.cpOf('mine')).toBe(23 + 20 - 7);
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

    // Choosing is what the opening is for: pairs and paths are both open. A
    // path wants CP, though, and nothing awards any before turn 14 - the
    // opening does not refuse it, the purse does.
    expect(c.canChooseAbilities('mine')).toBeTrue();
    expect(c.canPick('mine', TARGETED)).toBeTrue();
    expect(c.canUnlockPath('mine', 0)).toBeFalse();
    fundCp(c, 10);
    expect(c.canUnlockPath('mine', 0)).toBeTrue();
    c.pickAbility('mine', TARGETED);
    expect(c.myLoadout).toEqual([TARGETED, TARGETED_PAIR]);
    // And handing a pair back with it.
    expect(c.canSwap('mine')).toBeTrue();

    // Casting is not. Nothing spends an ability until Phase 1 plays.
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.canAfford('mine', TARGETED, 0)).toBeFalse();

    // Which is the turn straight after the opening now.
    c.gameState.snapshot.turnNumber = 8;   // turn 4, Phase 1's first played
    expect(c.canUseAbilities('mine')).toBeTrue();

    // Postmatch permits casting as well as choosing.
    c.gameState.snapshot.turnNumber = 27;  // turn 14, Phase 1 Postmatch
    expect(c.canChooseAbilities('mine')).toBeTrue();
    expect(c.canUseAbilities('mine')).toBeTrue();

    c.gameState.snapshot.turnNumber = 29;  // turn 15, Phase 2's first played
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
    // The right-hand zone, 1 a hex, so what is held is the count of hexes
    // (the middle one is 2 a hex).
    c.gameState.snapshot.boardState = { '7,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];
    // Hand-over 8 is turn 4, the first of Phase 1, and every loss below is
    // taken in it. A full turn is two hand-overs, so the numbers here are
    // twice the turn they name.
    c.gameState.snapshot.turnNumber = 8;
    const score = (side: string) => {
      const s = c.phaseScore(side);
      return { cap: s.cap, death: s.death, total: s.total };
    };

    // The middle of the patch: its own hex and the six around it.
    expect(score('mine')).toEqual({ cap: 19, death: 0, total: 19 });
    expect(score('opponent')).toEqual({ cap: 0, death: 0, total: 0 });

    // Black killed a white pawn. A pawn is worth 5 in the config, and white
    // is this client's seat, so it is 5 against us.
    c.gameState.snapshot.moveHistory = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
    ];
    expect(score('mine')).toEqual({ cap: 19, death: 5, total: 14 });

    // A counter-attack kills the mover's own unit, and counts against them.
    c.gameState.snapshot.moveHistory = [
      ...c.gameState.snapshot.moveHistory,
      { color: 'black', unit_id: 'pawn', captured: null, attacker_eliminated: true, turn: 8 },
    ];
    // A side with no board and a dead pawn stops at 0 - the phase never goes
    // under, however much its deaths outweigh its cap (phaseTotal).
    expect(score('opponent')).toEqual({ cap: 0, death: 5, total: 0 });

    // Read off the record rather than tallied as it went: the same history
    // gives the same number however this client got here.
    c.gameState.snapshot.boardState = {};
    expect(score('mine')).toEqual({ cap: 0, death: 5, total: 0 });

    // A loss belongs to the phase it happened in and no other, or summing the
    // phases would charge it again in every later one.
    c.gameState.snapshot.turnNumber = 30;   // turn 15, Phase 2
    expect(score('mine').death).toBe(0);
  });

  it('sums the phases behind the running one, and glows the lead', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    // The right-hand zone, 1 a hex, so what is held is the count of hexes
    // (the middle one is 2 a hex).
    c.gameState.snapshot.boardState = { '7,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.turnNumber = 52;   // turn 26, Phase 3's first played

    // Nothing banked yet reads as the phase alone - no parenthetical to draw.
    // Seven held, tripled in Phase 3.
    expect(c.phaseScore('mine').banked).toEqual([]);
    expect(c.phaseScore('mine').multiplier).toBe(3);
    expect(c.phaseScore('mine').match).toBe(57);

    // Phases 1 and 2, as they finished.
    c.gameState.snapshot.phaseBank = { 1: { white: 4, black: 9 }, 2: { white: 6, black: 1 } };
    (c as any).standingsCache = null;
    const us = c.phaseScore('mine');
    const them = c.phaseScore('opponent');
    expect(us.banked).toEqual([4, 6]);
    expect(them.banked).toEqual([9, 1]);
    // The running phase counts towards the match before it has ended.
    expect(us.match).toBe(67);
    expect(them.match).toBe(10);
    expect(us.leading).toBeTrue();
    expect(them.leading).toBeFalse();

    // Level pegging lights neither, so a glow always means a lead.
    c.gameState.snapshot.phaseBank = { 1: { white: 0, black: 57 } };
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine').match).toBe(57);
    expect(c.phaseScore('opponent').match).toBe(57);
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
    c.gameState.snapshot.turnNumber = 73;   // turn 37, the first of overtime
    const settle = (white: number, black: number) => {
      c.gameState.snapshot.phaseBank = { 1: { white, black }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
      (c as any).standingsCache = null;
      return c.matchVerdict;
    };

    // Nothing is settled until all three are banked.
    c.gameState.snapshot.phaseBank = { 1: { white: 99, black: 0 } };
    (c as any).standingsCache = null;
    expect(c.matchVerdict).toBeNull();

    // White has to be more than 10 clear; black only more than 5, because
    // white moves first.
    expect(settle(11, 0)).toBe('white');
    expect(settle(10, 0)).toBe('overtime');
    expect(settle(0, 6)).toBe('black');
    expect(settle(0, 5)).toBe('overtime');
    expect(settle(0, 0)).toBe('overtime');
  });

  it('scores overtime at nothing, and gives black the last word', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: {} };
    c.gameState.snapshot.boardState = {};
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.phaseBank = { 1: { white: 4, black: 4 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    const at = (turn: number) => {
      c.gameState.snapshot.turnNumber = turn;
      (c as any).standingsCache = null;
      const mine = c.phaseScore('mine');
      return { match: mine.match, verdict: c.matchVerdict };
    };

    // Overtime costs a king an HP a turn and a side nothing at all - the
    // owner's rule, "loses just HP". The score it opens on is the score it
    // keeps, however long it runs. Hand-over 73 is turn 37, its first.
    expect(at(73).match).toBe(4);
    expect(at(74).match).toBe(4);
    expect(at(75).match).toBe(4);
    expect(at(76).match).toBe(4);
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

  it('shows the bank the engine keeps, and banks nothing of its own', () => {
    // The engines bank a phase as its postmatch begins (match-score.ts) and
    // hand the bank out with every hand-over. The room used to bank as well,
    // off whatever board it happened to be looking at when a phase ended - so
    // a reload or a late join banked late, off a board the postmatch had
    // already reshuffled. It shows the engine's now.
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    c.gameState.snapshot.boardState = { '0,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.phaseBank = {};

    // Into Phase 1's postmatch with no bank on the hand-over: nothing is made up.
    c.gameState.snapshot.turnNumber = 27;
    c.beginTurnFor('white');
    expect(c.phaseBank).toEqual({});

    // The engine's, as it arrived.
    c.gameState.snapshot.phaseBank = { 1: { white: 3, black: 1 } };
    expect(c.phaseScore('mine').banked).toEqual([3]);
    expect(c.phaseScore('opponent').banked).toEqual([1]);
  });

  it('reads nought on a postmatch, and counts the phase it banked once', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    // The right-hand zone, 1 a hex, so what is held is the count of hexes
    // (the middle one is 2 a hex).
    c.gameState.snapshot.boardState = { '7,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [
      { color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, turn: 8 },
    ];
    // Phase 1, as the engine banked it when its postmatch began: 19 held, 5 lost.
    c.gameState.snapshot.turnNumber = 27;
    c.gameState.snapshot.phaseBank = { 1: { white: 14, black: 0 } };

    // The postmatch is still Phase 1's by the index, but nothing of it is
    // live: the phase is in the bank, and read live beside it as well it
    // would be counted twice - 14 banked and the same 14 running, for 28.
    const mine = c.phaseScore('mine');
    expect(mine).toEqual(jasmine.objectContaining({ cap: 0, death: 0, total: 0 }));
    expect(mine.banked).toEqual([14]);
    expect(mine.match).toBe(14);
    c.gameState.snapshot.turnNumber = 28;   // black's half reads the same
    expect(c.phaseScore('mine').match).toBe(14);

    // A postmatch shows no multiplier: it scores nothing to multiply.
    c.gameState.snapshot.turnNumber = 49;   // turn 25, Phase 2's postmatch
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine').multiplier).toBe(1);

    // And the next phase counts live again, with Phase 1's loss left behind -
    // doubled, because it is Phase 2.
    c.gameState.snapshot.turnNumber = 29;
    expect(c.phaseScore('mine')).toEqual(
      jasmine.objectContaining({ cap: 19, death: 0, total: 38, multiplier: 2 }));
    expect(c.phaseScore('mine').match).toBe(52);
  });

  it('reads the verdict from Phase 3\'s postmatch, a turn before overtime', () => {
    // The engines bank Phase 3 as its postmatch begins, like the other two,
    // so all three are in on turn 36 rather than on overtime's first turn.
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: {} };
    c.gameState.snapshot.boardState = {};
    c.gameState.snapshot.moveHistory = [];
    const two = { 1: { white: 12, black: 0 }, 2: { white: 0, black: 0 } };

    c.gameState.snapshot.turnNumber = 70;   // turn 35, the last of Phase 3's play
    c.gameState.snapshot.phaseBank = two;
    expect(c.matchVerdict).toBeNull();

    c.gameState.snapshot.turnNumber = 71;   // turn 36, Phase 3 Postmatch
    c.gameState.snapshot.phaseBank = { ...two, 3: { white: 0, black: 0 } };
    expect(c.matchVerdict).toBe('white');
    // A decided match says so in the header from that turn - it is the result
    // the engine has just ended the match on...
    expect(c.stageLabel).toBe('YOU WIN');

    // ...and a close one is bound for overtime, but the header names the turn
    // being played until overtime actually arrives with the next.
    c.gameState.snapshot.phaseBank = { 1: { white: 0, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    expect(c.matchVerdict).toBe('overtime');
    expect(c.stageLabel).toBe('PHASE 3 POSTMATCH');
    c.gameState.snapshot.turnNumber = 73;   // turn 37
    expect(c.stageLabel).toBe('OVERTIME 1');
  });

  it('names no points winner off a bank with a late phase in it', () => {
    // The engines refuse to end a match on a phase banked late, off the wrong
    // board; the header must not name that result either, or it shows a win
    // for fourteen turns that the engine then hands the other way.
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: {} };
    c.gameState.snapshot.boardState = {};
    c.gameState.snapshot.moveHistory = [];
    c.gameState.snapshot.phaseBank = {
      1: { white: 12, black: 0, late: true }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 },
    };
    c.gameState.snapshot.turnNumber = 80;   // turn 40, overtime
    expect(c.matchVerdict).toBe('overtime');
    expect(c.stageLabel).toBe('OVERTIME 1');
    c.gameState.snapshot.turnNumber = 101;
    expect(c.matchVerdict).toBe('black');
  });

  it('takes the bank each hand-over brings', () => {
    // The live road, through the real state service: the bank rides on the
    // hand-over, and the room shows the one the message carried.
    const c = room();
    c.gameState = new GameStateService();
    c.gameState.applyGameStarted({
      playerWhite: 'me', playerBlack: 'Opponent', currentTurn: 'Opponent', turnNumber: 26,
      config: { board: { radius: 11 }, units: {} }, boardState: {},
    });
    expect(c.phaseBank).toEqual({});
    const bank = { 1: { white: 7, black: 0 } };

    // Black's last move of Phase 1's play hands the postmatch to white.
    c.handleWebSocketMessage({
      type: 'move_made', turnNumber: 27, currentTurn: 'me', boardState: {}, phaseBank: bank,
      move: { color: 'black', unit_id: 'pawn', from: '0,0', to: '0,0' },
    });
    expect(c.phaseBank).toEqual(bank);

    // A pass that carries none - an older server - keeps what was there.
    c.handleWebSocketMessage({
      type: 'turn_passed', color: 'white', turnNumber: 28, currentTurn: 'Opponent', boardState: {},
    });
    expect(c.phaseBank).toEqual(bank);

    // A resync after a reload brings it back whole, and a new match has none.
    c.gameState.applyFullState({ turnNumber: 40, phaseBank: bank });
    expect(c.phaseBank).toEqual(bank);
    c.gameState.applyGameStarted({ playerWhite: 'me', playerBlack: 'Opponent' });
    expect(c.phaseBank).toEqual({});
  });

  it("pays a kill at the dead unit's worth on the move that made it, and a blow into a panel nothing", () => {
    // Through the real state service: the move lands in the record and the
    // purses are re-summed from it, solo included.
    const c = room();
    c.isSinglePlayer = true;
    c.gameState = new GameStateService();
    c.gameState.applyGameStarted({
      playerWhite: 'me', playerBlack: 'Opponent', currentTurn: 'me', turnNumber: 9,
      config: { board: { radius: 11 }, units: { pawn: { value: 5 }, queen: { value: 30 } } },
      boardState: {},
    });
    c.myPoints = 0;
    c.opponentPoints = 0;

    // The queen pays 30 UP; regular points stay at the scheduled income.
    c.handleWebSocketMessage({
      type: 'move_made', turnNumber: 10, currentTurn: 'Opponent', boardState: {},
      move: { color: 'white', unit_id: 'pawn', captured: 'queen', defender_eliminated: true, from: '0,0', to: '0,1' },
    });
    expect(c.myPoints).toBe(15);
    expect(c.myUnitPoints).toBe(10 + 30);
    expect(c.opponentPoints).toBe(15);

    // Black kills a pawn in white's reserve: nobody is paid for it. White's
    // sixth turn begins, at its one.
    c.handleWebSocketMessage({
      type: 'move_made', turnNumber: 11, currentTurn: 'me', boardState: {},
      move: {
        color: 'black', unit_id: 'pawn', captured: 'pawn', defender_eliminated: true, from: '1,0', to: '1,1',
        intoPanel: true, panelAttack: true, panel: 'br',
      },
    });
    expect(c.myPoints).toBe(16);
    expect(c.myUnitPoints).toBe(10 + 30);
    expect(c.opponentPoints).toBe(15);
  });

  /** A networked room at `ply`, with the opponent (black) to move. */
  const watching = (ply: number) => {
    const c = room();
    c.gameState = new GameStateService();
    c.gameState.applyGameStarted({
      playerWhite: 'me', playerBlack: 'Opponent', currentTurn: 'Opponent', turnNumber: ply,
      config: { board: { radius: 11 }, units: {} }, boardState: {},
    });
    return c;
  };
  const logged = (c: any) => c.gameRoomMessages.map((m: any) => m.content);

  it('logs the finishing atomic turn and its kill marker once before the result', () => {
    const c = watching(8); c.isSinglePlayer = false;
    const attack = { turn: 8, color: 'black', unit_id: 'rook', from: '1,0', to: '1,0',
      attacked: true, attackedHex: '0,0', captured: 'king', defender_eliminated: true, damage_dealt: 60 };
    const final = { type: 'game_state_update', turnNumber: 9, currentTurn: '', revision: 1,
      committedTurn: 8, color: 'black', endReason: 'regicide', winner: 'Opponent',
      config: DEFAULT_GAME_CONFIG, boardState: {}, moveHistory: [attack] };
    c.handleWebSocketMessage(final);
    expect(logged(c)[0]).toContain('hit king');
    expect(logged(c)[0]).toContain('(eliminated)');
    expect(logged(c)[1]).toContain('Game over');
    expect(c.opponentMoveVisuals[0].killed).toBe('0,0');
    const before = logged(c).slice();
    c.handleWebSocketMessage(final);
    c.handleWebSocketMessage({ type: 'game_over', revision: 1, winner: 'Opponent', endReason: 'regicide' });
    expect(logged(c)).toEqual(before);
  });

  it('draws and logs every unit of an opponent’s overtime turn, not only the last', () => {
    // Found in Chrome: the first units of a two- or three-unit turn arrive as
    // state updates, and the arrows and the log were built from the closing
    // move_made alone - so the first unit's move, here a blow into a panel,
    // left no arrow and no line.
    const c = watching(90);
    const blow = {
      turn: 90, color: 'black', unit_id: 'pawn', from: '0,-5', to: '0,-4', attacked: true,
      attackedHex: '-1,-11', damage_dealt: 4, intoPanel: true, panelAttack: true, panel: 'bl',
      unit: { unit_id: 'rook', color: 'white', uid: 'w-1,-11' }, defenderHp: 36,
    };
    c.handleWebSocketMessage({
      type: 'game_state_update', turnNumber: 90, currentTurn: 'Opponent', boardState: {},
      config: { board: { radius: 11 }, units: {} }, moveHistory: [blow],
    });
    c.handleWebSocketMessage({
      type: 'move_made', turnNumber: 91, currentTurn: 'me', boardState: {},
      move: { turn: 90, color: 'black', unit_id: 'knight', from: '2,-5', to: '2,-3' },
    });
    expect(c.opponentMovementArrows).toEqual([
      { from: '0,-5', to: '0,-4' }, { from: '2,-5', to: '2,-3' },
    ]);
    expect(c.opponentAttackMarkers).toEqual([{ from: '0,-4', to: '-1,-11' }]);
    const lines = logged(c).filter((line: string) => line.startsWith('black '));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('hit rook in its base for 4 (36 HP left)');
    expect(lines[1]).toContain('black knight');
  });

  describe('the log line for a blow', () => {
    // Found playing a solo game, 29 Sep 2026: a blow from where the unit
    // stood read "black pawn: 200 -> 200 - dealt 4 dmg (pawn survives, 16
    // HP)" - a move to nowhere, the unit it hit unnamed, the blow back left out.
    const line = (move: any, board: any = {}) => {
      const c = watching(20);
      c.gameState.snapshot.boardState = board;
      return { text: (c as any).describeMove({ turn: 20, attacked: true, ...move }) as string,
        n: (key: string) => (c as any).hexLabel(key) as string };
    };
    const pawn = { unit_id: 'pawn', color: 'white', hp: 16, max_hp: 20 };

    it('says who it hit, where, what it left, and what came back', () => {
      const { text, n } = line({
        color: 'black', unit_id: 'pawn', from: '1,-3', to: '1,-3', attackedHex: '0,-3',
        damage_dealt: 4, defender_hp: 16, counter_damage: 4, attacker_eliminated: false,
      }, { '0,-3': pawn });
      expect(text).toBe(`black pawn ${n('1,-3')} hit pawn ${n('0,-3')} for 4 (16 HP left), took 4 back`);
    });

    it('gives the walk first when the unit moved to strike', () => {
      const { text, n } = line({
        color: 'white', unit_id: 'archer', from: '-3,3', to: '-1,0', attackedHex: '1,-2',
        damage_dealt: 6, defender_hp: 10, counter_damage: 0,
      }, { '1,-2': { ...pawn, color: 'black' } });
      // Out of the pawn's reach: nothing came back, and the line says nothing of it.
      expect(text).toBe(`white archer ${n('-3,3')} -> ${n('-1,0')} hit pawn ${n('1,-2')} for 6 (10 HP left)`);
    });

    it('says a kill, and an attacker the answer killed', () => {
      expect(line({
        color: 'black', unit_id: 'pawn', from: '1,-3', to: '1,-3', attackedHex: '0,-3',
        damage_dealt: 4, defender_eliminated: true, captured: 'pawn', counter_damage: 0,
      }).text).toMatch(/hit pawn \d+ for 4 \(eliminated\)$/);
      expect(line({
        color: 'black', unit_id: 'pawn', from: '1,-3', to: '1,-3', attackedHex: '0,-3',
        damage_dealt: 2, defender_hp: 30, counter_damage: 9, attacker_eliminated: true,
      }, { '0,-3': { ...pawn, unit_id: 'rook', hp: 30 } }).text)
        .toMatch(/hit rook \d+ for 2 \(30 HP left\), took 9 back and was eliminated$/);
    });

    it('names the panel a blow landed in, a reserve as well as a base', () => {
      expect(line({
        color: 'white', unit_id: 'knight', from: '4,-8', to: '4,-8', attackedHex: '12,-9',
        damage_dealt: 5, intoPanel: true, panelAttack: true, panel: 'br',
        unit: { unit_id: 'archer', color: 'black' }, defenderHp: 11, counter_damage: 3,
      }).text).toMatch(/^white knight \d+ hit archer in its reserve for 5 \(11 HP left\), took 3 back$/);
    });

    it('reads the server\'s older record, with no attackedHex, as a blow from where it stood', () => {
      const { text, n } = line({
        color: 'black', unit_id: 'pawn', from: '1,-3', to: '0,-3',
        damage_dealt: 4, defender_hp: 16,
      }, { '0,-3': pawn });
      expect(text).toBe(`black pawn ${n('1,-3')} hit pawn ${n('0,-3')} for 4 (16 HP left)`);
    });

    it('leaves a move without a blow as it was', () => {
      const c = watching(20);
      expect((c as any).describeMove({ color: 'black', unit_id: 'pawn', from: '5,-9', to: '1,-3' }))
        .toBe(`black pawn: ${(c as any).hexLabel('5,-9')} -> ${(c as any).hexLabel('1,-3')}`);
    });
  });

  it('reads a unit\'s HP as "16/20", a forecast first - and never "/null"', () => {
    // A unit its config gives no maximum read "HP 20/null" on the Unit strip.
    const c = room();
    expect(c.statHp).toBe('—');
    const unit = { key: '0,0', uid: 'u', unitId: 'pawn', name: 'Pawn', color: 'white', hp: 20, hpMax: 20,
      hpAfter: null, atk: [14], def: 10, mv: 6, points: 5, vet: 0, drivable: true };
    c.selectedUnit = unit;
    expect(c.statHp).toBe('20/20');
    c.selectedUnit = { ...unit, hpAfter: 16 };
    expect(c.statHp).toBe('16/20');
    c.selectedUnit = { ...unit, hpMax: null };
    expect(c.statHp).toBe('20');
  });

  it('embeds each range in ATK, keeping the base under buffs', () => {
    const c = room();
    c.gameState.snapshot.config = structuredClone(LEGACY_GAME_CONFIG);
    c.selectedUnit = { key: '0,0', uid: 'u', unitId: 'archer', name: 'Archer', color: 'white',
      hp: 6, hpMax: 6, atk: [4, 3, 2, 1], def: 4, mv: 6, points: 8, vet: 0, drivable: true };
    expect(c.statAtk).toBe('3:4/4 4:3/3 5:2/2 6:1/1');
    expect(c.statHel).toBe('—');
    expect(c.statVet).toBe('—');
    c.buffs = { u: { atk: 2 } };
    expect(c.statAtk).toBe('3:6/4 4:5/3 5:4/2 6:3/1');
  });

  it('shows the bishop’s healing rings and puts earned stars in VET instead of its title', () => {
    const c = room();
    c.gameState.snapshot.config = structuredClone(LEGACY_GAME_CONFIG);
    c.selectedUnit = { key: '0,0', uid: 'b', unitId: 'bishop', name: 'Bishop', color: 'white',
      hp: 8, hpMax: 8, atk: [0], def: 4, mv: 6, points: 16, vet: 0, drivable: true };
    expect(c.statAtk).toBe('—');
    expect(c.statHel).toBe('1:8/8 2:6/6');
    for (const [vet, stars] of ['—', '★', '★★', '★★★'].entries()) {
      c.selectedUnit = { ...c.selectedUnit, vet };
      expect(c.statVet).toBe(stars);
      expect(c.unitPanelTitle).toBe('Bishop - 16 pts');
    }
    expect(c.statParts('hel').map((p: any) => p.ring)).toEqual([1, 2, 3, 4]);
  });

  it('says "Tap again to strike" in the Unit strip, wherever there is one', () => {
    // The board's own hint lay over a dozen of a phone's 15px hexes; the
    // strip, right under the board, has the forecast the hint is about.
    const c = room();
    c.roomLayout = 'stacked';
    c.unitPinned = false;
    expect(c.stripShown).toBeTrue();
    c.onArmedChange(true);
    expect(c.boardArmed).toBeTrue();
    c.onArmedChange(false);
    expect(c.boardArmed).toBeFalse();
    // Where there is no strip, the board keeps its hint.
    c.roomLayout = 'columns';
    expect(c.stripShown).toBeFalse();
  });

  it('leaves Tab to a board played from the keys, and ends the turn with it otherwise', () => {
    // A click on the board focuses it too: a mouse player's TAB there is End
    // Turn, as ever. Only a board the keys are playing moves on with it.
    const c = room();
    c.windowFocused = true;
    c.chatFocused = false;
    const ended = spyOn(c, 'endTurn');
    const board = document.createElement('app-game-board');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    board.appendChild(svg);
    const tab = (target: Element) => c.onShortcut({ key: 'Tab', target, preventDefault: () => {} } as any);
    c.boardRef = { keyFocused: false };
    tab(svg);
    expect(ended).toHaveBeenCalledTimes(1);
    c.boardRef.keyFocused = true;
    tab(svg);
    expect(ended).toHaveBeenCalledTimes(1);
    tab(document.createElement('div'));
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it('fits the header two frames on when the room changes under it', () => {
    // Its classes are drawn by the change detection the next frame brings; a
    // fit one frame on measured the layout that was.
    const c = room();
    const roomEl = document.createElement('div');
    const header = document.createElement('header');
    const banner = document.createElement('div');
    header.appendChild(banner);
    roomEl.appendChild(header);
    document.body.appendChild(roomEl);
    const frames: FrameRequestCallback[] = [];
    try {
      c.headerEl = header;
      c.bannerEl = banner;
      c.watchHeader();
      spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => frames.push(cb));
      banner.style.removeProperty('--banner-fit');
      c.refitHeader();
      frames.shift()!(0);
      expect(banner.style.getPropertyValue('--banner-fit')).toBe('');
      frames.shift()!(0);
      expect(banner.style.getPropertyValue('--banner-fit')).not.toBe('');
    } finally {
      c.headerEl = c.bannerEl = null;
      c.watchHeader();
      roomEl.remove();
    }
  });

  it('fits the header again when the pointer changes, layout or no layout', () => {
    // The "?" beside the turn comes and goes with the same media query, and
    // a banner fitted without it ran 16px over once it was there.
    const c = room();
    let refits = 0;
    c.refitHeader = () => refits++;
    c.roomLayout = 'columns';
    spyOn(c, 'fitRoom');
    c.onPointerChange();
    expect(c.fitRoom).toHaveBeenCalled();
    expect(refits).toBe(1);
  });

  it('logs a turn that wrapped and then ended as what it did, not as a pass', () => {
    const c = watching(9);
    c.handleWebSocketMessage({
      type: 'game_state_update', turnNumber: 9, currentTurn: 'Opponent', boardState: {},
      config: { board: { radius: 11 }, units: {} },
      moveHistory: [{
        turn: 9, color: 'black', unit_id: 'pawn', from: '12,-1', to: '-11,-1',
        panelMove: true, panel: 'tr', price: 5, unit: { unit_id: 'pawn', color: 'black', uid: 'b12,-1' },
      }],
    });
    c.handleWebSocketMessage({
      type: 'turn_passed', color: 'black', turnNumber: 10, currentTurn: 'me', boardState: {},
    });
    const lines = logged(c);
    expect(lines.some((line: string) => line.includes('(wrapped, 5 UP)'))).toBeTrue();
    expect(lines).toContain('black ended the turn.');
    expect(lines).not.toContain('black passed the turn.');
    // The panels' walks get a line, as ever, but no arrow.
    expect(c.opponentMovementArrows).toEqual([]);

    // A turn that did nothing at all is still a pass.
    c.handleWebSocketMessage({
      type: 'turn_passed', color: 'white', turnNumber: 11, currentTurn: 'Opponent', boardState: {},
    });
    expect(logged(c)).toContain('white passed the turn.');
  });

  it('pays a kill made by a held overtime move, which lands as a state update', () => {
    // Overtime 2 and 3 allow several board moves a turn; all but the last are
    // held, and come back as game_state_update rather than move_made. The
    // held move is in the record the update carries, so the re-sum pays it.
    const config = { board: { radius: 11 }, units: { pawn: { value: 5 }, queen: { value: 30 } } };
    const held = { color: 'white', unit_id: 'pawn', captured: 'queen', defender_eliminated: true };
    const c = room();
    c.isSinglePlayer = true;
    c.gameState = new GameStateService();
    c.gameState.applyGameStarted({
      playerWhite: 'me', playerBlack: 'Opponent', currentTurn: 'me', turnNumber: 89, config, boardState: {},
    });
    c.myPoints = 0;
    c.opponentPoints = 0;
    c.handleWebSocketMessage({
      type: 'game_state_update', turnNumber: 89, currentTurn: 'me', config, boardState: {},
      moveHistory: [held],
    });
    // Regular income is 119; the queen's 30 goes to UP.
    expect(c.myPoints).toBe(119);
    expect(c.myUnitPoints).toBe(10 + 30);
    // The same state again - a refresh - pays it once, not twice.
    c.handleWebSocketMessage({
      type: 'game_state_update', turnNumber: 89, currentTurn: 'me', config, boardState: {},
      moveHistory: [held],
    });
    expect(c.myPoints).toBe(119);
    expect(c.myUnitPoints).toBe(10 + 30);
  });

  it('keeps the score up and the toll off on the finished position of a points win', () => {
    // A match decided on points ends ON hand-over 73, overtime's first ply.
    const c = room();
    const decided = { 1: { white: 30, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    c.gameState.snapshot.turnNumber = 73;
    c.gameState.snapshot.phaseBank = decided;
    expect(c.showScore).toBeTrue();
    expect(c.tollBind).toBeFalse();
    // A close match there is in overtime, score down and the toll on.
    c.gameState.snapshot.phaseBank = { ...decided, 1: { white: 10, black: 0 } };
    expect(c.showScore).toBeFalse();
    expect(c.tollBind).toBeTrue();
  });

  it('calls the last turn the last once the match is decided on points', () => {
    const c = room();
    const decided = { 1: { white: 12, black: 0 }, 2: { white: 0, black: 0 }, 3: { white: 0, black: 0 } };
    c.gameState.snapshot.phaseBank = decided;
    // Phase 3's postmatch: the match ends as it does, so there is no overtime
    // to count down to - and the record of it says the same once it is over.
    c.gameState.snapshot.turnNumber = 71;
    expect(c.historyTitle).toBe('Turn 36 - Last Turn');
    c.gameState.snapshot.turnNumber = 73;
    expect(c.historyTitle).toBe('Turn 36 - Last Turn');

    // A close match counts on down to overtime, and turn 50's black win is
    // not a points win.
    c.gameState.snapshot.phaseBank = { ...decided, 1: { white: 10, black: 0 } };
    c.gameState.snapshot.turnNumber = 71;
    expect(c.historyTitle).toBe(turnHeading(71));
    c.gameState.snapshot.turnNumber = 101;
    expect(c.historyTitle).toBe(turnHeading(101));
  });

  it("names the room's own starting CP in the purse's tooltip", () => {
    const c = room();
    expect(c.cpTitle).toContain('5 to start');
    c.gameState.snapshot.config = { rules: { cpAtStart: 12 } };
    expect(c.cpTitle).toContain('12 to start');
  });

  it('says how a match the schedule ended was ended', () => {
    const c = room();
    expect(c.endReasonDetail({ endReason: 'points' }))
      .toBe('Phase 3 ended with one side past the margin.');
    expect(c.endReasonDetail({ endReason: 'overtime' }))
      .toBe('Overtime ran out with both kings standing: black wins.');
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

  it('blocks ordinary abilities during the opening', () => {
    const c = room();
    c.gameState.snapshot.currentTurn = c.username;
    // Everything that spends an ability runs through canUseAbilities - the
    // pool, a path's skill and ultimate, and a unit's own - so the opening
    // shutting that one gate shuts all of them.
    c.gameState.snapshot.turnNumber = 1;
    expect(c.canUseAbilities('mine')).toBeFalse();
    expect(c.canAfford('mine', 0, 0)).toBeFalse();
    expect(c.abilityBlockedNote).toBe('Unavailable: only CP utilities can be used during initialization.');

    // All postmatches permit casts, for either half of the full turn.
    for (const ply of [7, 10, 27, 28, 29, 49, 50, 71, 72]) {
      c.gameState.snapshot.turnNumber = ply;
      expect(c.canUseAbilities('mine')).withContext(`ply ${ply}`).toBeTrue();
      expect(c.abilityBlockedNote).withContext(`ply ${ply}`).toBe('Unavailable: not your turn.');
    }
  });

  it('sounds the toll and a base mending one after the other, never on top', () => {
    // The owner, 26 Sep 2026: "try to add a sound effect for damage taken to
    // king during over time and heal sound in base. they may collide when
    // they both happen".
    const c = room();
    const played: Array<{ notes: number[]; step: number; delay: number }> = [];
    c.audioService.playTone = (notes: number[], step: number, options: any = {}) =>
      played.push({ notes, step, delay: options.delay ?? 0 });

    // Each alone plays at once, and the two are different sounds.
    c.onUpkeepSettled({ toll: true, heal: false });
    c.onUpkeepSettled({ toll: false, heal: true });
    const [toll, heal] = played;
    expect([toll.delay, heal.delay]).toEqual([0, 0]);
    expect(toll.notes).not.toEqual(heal.notes);

    // Both at once: the toll first, and the mend only once it has finished.
    played.length = 0;
    c.onUpkeepSettled({ toll: true, heal: true });
    expect(played.map(p => p.notes)).toEqual([toll.notes, heal.notes]);
    expect(played[0].delay).toBe(0);
    expect(played[1].delay).toBeGreaterThan(toll.notes.length * toll.step);

    // Nothing owed, nothing played.
    played.length = 0;
    c.onUpkeepSettled({ toll: false, heal: false });
    expect(played).toEqual([]);
  });

  it('shows what the opening holds without counting it, and stops scoring in overtime', () => {
    const c = room();
    c.gameState.snapshot.config = { board: { radius: 11 }, units: { pawn: { value: 5 } } };
    // A unit sat in the middle of a capture zone.
    // The right-hand zone, 1 a hex, so what is held is the count of hexes
    // (the middle one is 2 a hex).
    c.gameState.snapshot.boardState = { '7,0': { unit_id: 'pawn', color: 'white' } };
    c.gameState.snapshot.moveHistory = [];

    // The owner, 26 Sep 2026: "its ok to show capture points during
    // initialization because it wont tally anyways". The opening shows what
    // is held, and none of it reaches the match total or leads.
    c.gameState.snapshot.turnNumber = 1;
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine')).toEqual(jasmine.objectContaining(
      { cap: 19, death: 0, total: 19, multiplier: 1, banked: [], match: 0, leading: false }));
    expect(c.phaseScore('opponent').leading).toBeFalse();
    expect(c.showScore).toBeTrue();

    // Phase 1 counts it.
    c.gameState.snapshot.turnNumber = 10;   // turn 5
    (c as any).standingsCache = null;
    expect(c.phaseScore('mine').cap).toBe(19);

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

  it('stops mending a unit wrapped out of its base into its reserve', () => {
    // The review's case: struck in the base on ply 8 to 16, wrapped into the
    // reserve on ply 9 - and drawn at 17, 18, 19 on plies 10, 12, 14, mending
    // in a reserve, which never mends. panels.py agrees now, and agreed then.
    const c = room();
    const pawn = { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid: 'w-12,1' };
    const wound = { intoPanel: true, panel: 'bl', turn: 8, defenderHp: 16, unit: pawn };
    const wrap = (turn: number, to: string) =>
      ({ panelMove: true, panel: 'bl', turn, unit: pawn, from: '-12,1', to });
    const hpAt = (ply: number) => {
      c.gameState.snapshot.turnNumber = ply;
      return c.panelHp['w-12,1'];
    };

    c.gameState.snapshot.moveHistory = [wound];
    expect(hpAt(14)).toBe(19);                    // had it stayed
    c.gameState.snapshot.moveHistory = [wound, wrap(9, '11,1')];
    expect([10, 12, 14].map(hpAt)).toEqual([16, 16, 16]);

    // A walk inside the base keeps it mending, until the wrap on ply 13:
    // white's hand-overs 9 and 11 closed with it in the base.
    c.gameState.snapshot.moveHistory = [
      wound, wrap(9, '-12,2'), { ...wrap(13, '11,1'), from: '-12,2' },
    ];
    expect(hpAt(12)).toBe(18);
    expect(hpAt(20)).toBe(18);
  });

  it('stops mending a unit that walked home once it is wrapped out again', () => {
    const c = room();
    const unit = { unit_id: 'pawn', color: 'white', hp: 9, max_hp: 20, uid: 'w3,9' };
    c.gameState.snapshot.moveHistory = [
      { from: '-11,11', to: '-12,11', color: 'white', turn: 5, withdrawn: true, unit },
      // Hand-over 7 closes in the base; the wrap on ply 9 takes it out.
      { panelMove: true, panel: 'bl', turn: 9, unit, from: '-12,11', to: '11,1' },
    ];
    c.gameState.snapshot.turnNumber = 20;
    expect(c.withdrawnUnits.find((w: any) => w.unit.uid === 'w3,9').unit.hp).toBe(10);
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

  /** An overtime turn's staged stack, and what ending it sends. */
  const committing = (c: any, ply: number, staged: any[]) => {
    const sent: any[] = [];
    c.wsService = { sendMessage: (m: any) => sent.push(m) };
    c.persistLocalUiState = () => {};
    c.playSteps = () => {};
    c.playEndTurnSound = () => {};
    c.gameState.snapshot.currentTurn = 'me';
    c.gameState.snapshot.turnNumber = ply;
    c.stagedActions = staged;
    c.endTurn();
    return sent;
  };
  const OVERTIME_TWO = 89, OVERTIME_THREE = 99;
  const blowIntoPanel = (at: number, from: string) => ({
    at, from, to: from, used: 0, attack: '-5,8',
    panelUnit: inPanel(), panelUnitHp: 18, intoPanel: true, panelName: 'tl', counters: true,
  });
  const walk = (at: number, from: string, to: string) =>
    ({ at, from, to, used: 1, attack: null });

  it('sends a blow into a panel in its place among the turn’s moves, whichever comes first', () => {
    // It went alone and ended the turn, so every other move an overtime turn
    // had staged was lost - before it or after it.
    let sent = committing(room(), OVERTIME_TWO,
      [blowIntoPanel(1, '-5,9'), walk(2, '-4,9', '-4,8')]);
    expect(sent.map(m => m.type)).toEqual(['panel_attack', 'make_move']);
    expect(sent[0].more).toBeTrue();
    expect(sent[1].more).toBeUndefined();
    expect(sent[1].from).toBe('-4,9');

    sent = committing(room(), OVERTIME_TWO,
      [walk(1, '-4,9', '-4,8'), blowIntoPanel(2, '-5,9')]);
    expect(sent.map(m => m.type)).toEqual(['make_move', 'panel_attack']);
    expect(sent[0].more).toBeTrue();
    expect(sent[1].more).toBeUndefined();
    expect(sent[1].unit.uid).toBe('rtl0');
  });

  it('sends all three of an Overtime 3 turn with the blow into a panel in the middle', () => {
    const sent = committing(room(), OVERTIME_THREE, [
      walk(1, '-4,9', '-4,8'), blowIntoPanel(2, '-5,9'), walk(3, '-2,9', '-2,8'),
    ]);
    expect(sent.map(m => m.type)).toEqual(['make_move', 'panel_attack', 'make_move']);
    expect(sent.map(m => !!m.more)).toEqual([true, true, false]);
  });

  it('lands a cast made between two units’ moves between them, not before the first', () => {
    // The report's case: a rook strikes and takes a one-point counter (10 to
    // 9), Mend takes it to 29, and a second unit moves. Every cast before the
    // last move used to ride on the FIRST message - so the mend landed before
    // the blow, the counter came off 29, and the rook was committed at 28.
    const spend = { cost: 0, index: 6, side: 'mine', row: 'mine', uid: 'wr', hex: '-5,0' };
    const sent = committing(room(), OVERTIME_TWO, [
      { at: 1, from: '-5,0', to: '-5,0', used: 0, attack: '-4,0' },
      { at: 2, from: '-5,0', to: '-5,0', used: 0, attack: null, spend,
        hexKey: '-5,0', hexUid: 'wr', hexHp: 29, mark: '+20' },
      // A blow on an enemy between the two, which the second unit then meets.
      { at: 3, from: '-5,0', to: '-5,0', used: 0, attack: null, spend,
        hexKey: '-3,1', hexUid: 'bs', hexHp: 4, mark: '-6' },
      walk(4, '-4,9', '-4,8'),
      { at: 5, from: '-4,9', to: '-4,8', used: 1, attack: null, spend,
        hexKey: '-4,8', hexUid: 'wp', hexHp: 12, mark: '+2' },
    ]);
    expect(sent.map(m => m.type)).toEqual(['make_move', 'make_move']);
    expect(sent[0].effectsBefore).toBeUndefined();
    expect(sent[0].effects).toBeUndefined();
    expect(sent[1].effectsBefore).toEqual([
      { at: '-5,0', uid: 'wr', hp: 29 },
      { at: '-3,1', uid: 'bs', hp: 4 },
    ]);
    // What came after the last move lands after it.
    expect(sent[1].effects).toEqual([{ at: '-4,8', uid: 'wp', hp: 12 }]);
  });

  it('gives the next unit its own MOV after another unit has struck', () => {
    // movesLeft asked "has anything swung this turn" - the one-unit rule - so a
    // second unit, free to walk in Overtime 2, had 0 MOV after its first hop.
    const c = room();
    c.gameState.snapshot.turnNumber = OVERTIME_TWO;
    c.gameState.snapshot.config = { units: { pawn: { move: 5 }, rook: { move: 4 } } };
    const board = {
      '-5,0': { unit_id: 'rook', color: 'white', hp: 9, uid: 'wr' },
      '-4,8': { unit_id: 'pawn', color: 'white', hp: 10, uid: 'wp' },
    };
    c.stagedActions = [
      { at: 1, board, from: '-5,0', to: '-5,0', used: 0, attack: '-4,0' },
      { at: 2, board, from: '-4,9', to: '-4,8', used: 1, attack: null },
    ];
    expect(c.movesLeft).toBe(4);

    // Its own blow still ends its walk.
    c.stagedActions.push({ at: 3, board, from: '-4,9', to: '-4,8', used: 1, attack: '-4,7' });
    expect(c.movesLeft).toBe(0);

    // And the unit that struck first stays done, a cast on top of it or not.
    c.stagedActions = [
      { at: 1, board, from: '-5,0', to: '-5,0', used: 0, attack: '-4,0' },
      { at: 2, board, from: '-5,0', to: '-5,0', used: 0, attack: null, spend: { cost: 0 } },
    ];
    expect(c.movesLeft).toBe(0);
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
    // The right-hand zone, 1 a hex, so what is held is the count of hexes
    // (the middle one is 2 a hex).
    c.gameState.snapshot.boardState = { '7,0': { unit_id: 'pawn', color: 'white' } };
    expect(c.phaseScore('mine').cap).toBe(19);

    // A step away is staged, not sent. The board being drawn is the staged
    // one, and the score reads the same board the player is looking at.
    c.stagedActions = [{ from: '7,0', to: '4,0', board: { '4,0': { unit_id: 'pawn', color: 'white' } } } as any];
    expect(c.phaseScore('mine').cap).toBe(0);

    // Taking it back puts the hexes back.
    c.stagedActions = [];
    expect(c.phaseScore('mine').cap).toBe(19);
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

  /**
   * The catalogue's numbers are the numbers: a cast cools for its own
   * `cooldown`, a stat change lasts its own `turns` of its caster's, `uses`
   * caps it per side (or per unit), and a unit type's own ability is the one
   * its config names. Each was a constant, or a slot, before.
   */
  describe('the numbers the catalogue holds', () => {
    /** The shipped config with `edit` applied, and three units dealt. */
    const tuned = (edit: (config: any) => void = () => {}) => {
      const c = room();
      const config: any = structuredClone(LEGACY_GAME_CONFIG);
      edit(config);
      c.gameState.snapshot.config = config;
      c.gameState.snapshot.turnNumber = 20;
      c.gameState.snapshot.boardState = {
        '0,0': { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20, uid: 'wp' },
        '1,0': { unit_id: 'pawn', color: 'black', hp: 20, max_hp: 20, uid: 'bp' },
        '2,0': { unit_id: 'rook', color: 'white', hp: 40, max_hp: 40, uid: 'wr' },
      };
      c.persistLocalUiState = () => {};
      c.playSteps = () => {};
      c.playAbilitySound = () => {};
      c.myPoints = 100;
      c.opponentPoints = 100;
      return c;
    };
    const unit = (key: string, uid: string, unitId: string, color: string) =>
      ({ key, uid, unitId, name: unitId, color, hp: 20, hpMax: 20, vet: 3 });
    const WP = unit('0,0', 'wp', 'pawn', 'white');
    const BP = unit('1,0', 'bp', 'pawn', 'black');
    const WR = unit('2,0', 'wr', 'rook', 'white');

    /** Pick `id`'s pair if need be, arm it off the panel, and land it on `target`. */
    const cast = (c: any, side: 'mine' | 'opponent', id: string, target: any): boolean => {
      const index = c.slotOfAbility(id);
      if (!c.isPicked(side, index)) c.pickAbility(side, index);
      c.selectAbility(side, index, side === 'mine' ? c.myCooldowns : c.opponentCooldowns);
      if (c.pendingAbility?.index !== index) {
        c.clearAbilityFocus();
        return false;
      }
      c.onHexClicked(target);
      return true;
    };

    it("cools a cast for the catalogue's cooldown, not a fixed three", () => {
      const c = tuned(config => {
        config.abilities.catalogue.dash.cooldown = 1;
        config.abilities.catalogue.focus.cooldown = 0;
      });
      expect(cast(c, 'mine', 'dash', WP)).toBeTrue();
      expect(c.myCooldowns[c.slotOfAbility('dash')]).toBe(1);
      expect(cast(c, 'mine', 'focus', WR)).toBeTrue();
      expect(c.myCooldowns[c.slotOfAbility('focus')]).toBe(0);
      // Nothing to wait for, so it is ready again at once.
      expect(cast(c, 'mine', 'focus', WP)).toBeTrue();
    });

    it("keeps a stat change for its caster's turns, and lifts each on its own caster's", () => {
      const c = tuned(config => { config.abilities.catalogue.dash.turns = 2; });
      expect(cast(c, 'mine', 'dash', WP)).toBeTrue();       // white's +2 MOV, two white turns
      c.gameState.snapshot.currentTurn = 'bot';
      expect(cast(c, 'opponent', 'sap', WP)).toBeTrue();    // black's -2 all round, one black turn
      expect(c.buffs['wp'].mov).toBe(0);
      expect(c.buffs['wp'].atk).toBe(-2);

      // White's turn counts white's down and leaves black's alone. Both used to
      // go together, on whichever side had cast first.
      c.beginTurnFor('white');
      expect(c.buffs['wp'].effects.map((e: any) => [e.name, e.turns]))
        .toEqual([['Dash', 1], ['Sap', 1]]);
      c.beginTurnFor('black');
      expect(c.buffs['wp'].mov).toBe(2);
      expect(c.buffs['wp'].atk).toBe(0);
      expect(c.buffs['wp'].down).toBeFalse();
      c.beginTurnFor('white');
      expect(c.buffs['wp']).toBeUndefined();
    });

    it("stops an ability at its uses, and Undo gives the last one back", () => {
      const c = tuned(config => {
        config.abilities.catalogue.dash.uses = 2;
        config.abilities.catalogue.dash.cooldown = 0;
      });
      const dash = c.slotOfAbility('dash');
      expect(cast(c, 'mine', 'dash', WP)).toBeTrue();
      expect(cast(c, 'mine', 'dash', WR)).toBeTrue();
      expect(c.usesLeft('mine', dash)).toBe(0);
      expect(cast(c, 'mine', 'dash', WP)).toBeFalse();
      c.undoMove();
      expect(c.usesLeft('mine', dash)).toBe(1);
      // Per side: the other side's count is its own.
      expect(c.usesLeft('opponent', dash)).toBe(2);
    });

    it("pays a path's ultimate in CP and hands its points out as points", () => {
      const c = tuned();
      fundCp(c, 20);
      c.unlockPath('mine', 0);      // Bastion; Fortress costs 8 CP and hands out 4 points
      const cp = c.cpOf('mine');
      const fortress = c.slotOfAbility('fortress');
      c.selectAbility('mine', fortress, c.myCooldowns);
      c.activateFocusedAbility();
      // They were netted in CP: -4 CP, and the points purse never moved.
      expect(c.cpOf('mine')).toBe(cp - 8);
      expect(c.myPoints).toBe(104);
      c.undoMove();
      expect(c.cpOf('mine')).toBe(cp);
      expect(c.myPoints).toBe(100);
      expect(c.usesLeft('mine', fortress)).toBe(1);
    });

    it("gives a unit type its own ability, cooling per unit, on either side's turn", () => {
      const c = tuned(config => {
        config.units.pawn.ability = 'focus';
        config.units.rook.ability = 'bulwark';
        delete config.units.king.ability;
      });
      const focus = c.slotOfAbility('focus');
      // Nothing picked: a unit's own ability is not a pool pick.
      c.selectedUnit = WP;
      expect(c.displayUnitAbility).toBe(focus);
      c.selectUnitAbility(focus);
      expect(c.unitAbilityCanActivate()).toBeTrue();
      c.activateUnitAbility();
      expect(c.buffs['wp'].atk).toBe(2);
      expect(c.unitCooldownOf('wp')).toBe(3);
      expect(c.myPoints).toBe(95);

      // Per unit: the pawn cooling leaves the rook's own alone.
      c.selectedUnit = WR;
      expect(c.displayUnitAbility).toBe(c.slotOfAbility('bulwark'));
      c.selectUnitAbility(c.slotOfAbility('bulwark'));
      expect(c.unitAbilityCanActivate()).toBeTrue();

      // Black's pawn uses its own on black's turn, from black's purse.
      c.gameState.snapshot.currentTurn = 'bot';
      c.selectedUnit = BP;
      c.selectUnitAbility(focus);
      expect(c.unitAbilityCanActivate()).toBeTrue();
      c.activateUnitAbility();
      expect(c.opponentPoints).toBe(95);
      expect(c.unitCooldownOf('bp')).toBe(3);

      // Each side's turn ticks its own units' cooldowns, and Undo hands one back.
      c.beginTurnFor('white');
      expect(c.unitCooldownOf('wp')).toBe(2);
      expect(c.unitCooldownOf('bp')).toBe(3);
      c.undoMove();
      expect(c.unitCooldownOf('bp')).toBe(0);
      expect(c.opponentPoints).toBe(100);

      // A unit type with none has none.
      c.selectedUnit = unit('3,0', 'wk', 'king', 'white');
      expect(c.displayUnitAbility).toBeNull();
    });

    it("opens a unit's own ability it has not the stars for, and says what it needs", () => {
      // Its button is not disabled for want of stars - disabled, a touch
      // screen could not read what it does at all - so a tap lands here.
      const c = tuned(config => { config.units.pawn.ability = 'focus'; });
      const focus = c.slotOfAbility('focus');
      c.selectedUnit = { ...WP, vet: 1 };
      expect(c.vetUnlocked(focus)).toBeFalse();
      c.selectUnitAbility(focus);
      expect(c.unitAbilityFocus).toEqual({ index: focus, uid: WP.uid });
      expect(c.unitAbilityNote).toBe('Unavailable: needs ★★.');
      expect(c.unitAbilityCanActivate()).toBeFalse();
      c.activateUnitAbility();
      expect(c.myPoints).toBe(100);
      // A unit in a panel still opens nothing.
      c.unitAbilityFocus = null;
      c.selectedUnit = { ...WP, panel: 'base' };
      c.selectUnitAbility(focus);
      expect(c.unitAbilityFocus).toBeNull();
    });
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
      { playTone: () => {} } as any, zone,
      { getConfig: () => DEFAULT_GAME_CONFIG } as any,
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

  it('handles each socket message once across room route reuse and stops on destroy', () => {
    const { c, ws } = room('tok');
    const params = new BehaviorSubject({ id: 'room-1' });
    c.route.params = params;
    const handled = spyOn(c, 'handleWebSocketMessage');
    try {
      c.ngOnInit();
      ws.messages$.next({ type: 'heartbeat_ack' });
      expect(handled).toHaveBeenCalledTimes(1);
      params.next({ id: 'room-2' });
      ws.messages$.next({ type: 'heartbeat_ack' });
      expect(handled).toHaveBeenCalledTimes(2);
      c.ngOnDestroy();
      ws.messages$.next({ type: 'heartbeat_ack' });
      expect(handled).toHaveBeenCalledTimes(2);
    } finally { sessionStorage.removeItem('cpp.roomToken.room-2'); }
  });

  it('rejoins only the current room once after a reconnect and stops on destroy', () => {
    const { c, ws, sent } = room('tok');
    const params = new BehaviorSubject({ id: 'room-1' });
    c.route.params = params;
    try {
      c.ngOnInit();
      params.next({ id: 'room-2' });
      sent.length = 0;
      ws.connectionStatus$.next(false); ws.connectionStatus$.next(true);
      expect(sent.filter(m => m.type === 'join_game_room').map(m => m.gameId)).toEqual(['room-2']);
      c.ngOnDestroy(); sent.length = 0;
      ws.connectionStatus$.next(false); ws.connectionStatus$.next(true);
      params.next({ id: 'room-1' });
      expect(sent).toEqual([]);
    } finally { sessionStorage.removeItem('cpp.roomToken.room-2'); }
  });

  it('still leaves a room it did join', () => {
    const { c, sent, disconnects } = room('tok');
    c.ngOnInit();
    expect(sent.some(m => m.type === 'join_game_room')).toBeTrue();
    c.ngOnDestroy();
    expect(sent.some(m => m.type === 'leave_game_room')).toBeTrue();
    expect(disconnects.length).toBe(1);
  });

  it('takes the seat back once when another tab has it, and drops the refused turn', () => {
    const { c, sent } = room('tok');
    c.ngOnInit();
    const joins = () => sent.filter(m => m.type === 'join_game_room').length;
    expect(joins()).toBe(1);
    c.stagedActions = [{ from: '0,0', to: '1,0' }];
    c.submittedTurn = 3;

    // End Turn sends several messages, and every one of them is refused.
    const stale = { type: 'error', code: 'STALE_GAME_SOCKET', message: 'replaced' };
    c.handleWebSocketMessage(stale);
    c.handleWebSocketMessage(stale);

    expect(joins()).toBe(2);
    expect(c.stagedActions).toEqual([]);
    expect(c.submittedTurn).toBe(-1);

    // Joined again, a later refusal can take it back again.
    c.handleWebSocketMessage({ type: 'join_game_room_success', gameStatus: 'waiting' });
    c.handleWebSocketMessage(stale);
    expect(joins()).toBe(3);
    c.ngOnDestroy();
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
      const paid = c.myUnitPoints;
      walkHome(c, '-11,11', 'bl-1');
      expect(c.homecomingsSpent).toBe(2);
      c.undoMove();
      expect(c.homecomingsSpent).toBe(1);
      expect(c.myUnitPoints).toBe(paid);
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

/**
 * The owner: "DO NOT HIDE ANYTHING AS IT MAKES THIS GAME UNPLAYABLE". Above
 * its least size the room is laid out to the window by its stylesheet (the
 * room's unit, --u), and nothing is scaled; a little below it the three
 * columns are scaled, and below that the room has a layout of its own - the
 * board and a column of tabs, or the board over the tabs - rather than a
 * panel crushed. What the stylesheet does at each size is measured in a real
 * browser by client/scripts/layout-sweep.mjs, not here.
 */
describe('GameRoomComponent fitting the window', () => {
  let innerWidth: jasmine.Spy;
  let innerHeight: jasmine.Spy;
  beforeEach(() => {
    innerWidth = spyOnProperty(window, 'innerWidth');
    innerHeight = spyOnProperty(window, 'innerHeight');
  });

  /** A window of width x height - a touch screen's, a phone's or a tablet's,
   *  when `touch`; a computer's otherwise. */
  const fit = (width: number, height: number, touch = false) => {
    innerWidth.and.returnValue(width);
    innerHeight.and.returnValue(height);
    const c: any = {
      cdr: { markForCheck: () => {} }, refitHeader: () => {}, scrollLogsToBottom: () => {}, touchOnly: touch,
    };
    GameRoomComponent.prototype.fitRoom.call(c);
    return c;
  };

  it('scales the room down by whichever side is shorter, laid out at its least', () => {
    // A little short of the least width, and taller than the least height:
    // width decides. (Much narrower is the tabs, or upright the board over
    // them - neither is scaled.)
    const c = fit(1100, 1000);
    expect(c.roomLayout).toBe('columns');
    expect(c.roomZoom).toBeCloseTo(1100 / 1180, 6);
    expect(c.roomWidth).toBeCloseTo(1180, 6);
    expect(c.roomHeight).toBeCloseTo(1000 * 1180 / 1100, 6);
    // Height decides here - a laptop a little short of the columns' least
    // height, which keeps them, scaled. (Much shorter is the tabs.)
    const d = fit(1904, 670);
    expect(d.roomLayout).toBe('columns');
    expect(d.roomZoom).toBeCloseTo(670 / 1025, 6);
    expect(d.roomHeight).toBeCloseTo(1025, 6);
  });

  it('leaves a window big enough for the whole room alone', () => {
    const c = fit(2000, 1200);
    expect(c.roomZoom).toBe(1);
    expect(c.roomWidth).toBeNull();
    expect(c.roomHeight).toBeNull();
  });

  it('leaves the columns unscaled once the taller left column fits', () => {
    for (const [w, h] of [[1920, 1080], [1600, 1025], [1180, 1025]]) {
      expect(fit(w, h).roomZoom).withContext(`${w}x${h}`).toBe(1);
    }
    expect(fit(1180, 1024).roomZoom).toBeLessThan(1);
    expect(fit(1179, 1025).roomZoom).toBeLessThan(1);
  });

  it('keeps desktop panels visible while fitting the taller left column', () => {
    // A 1366x768 laptop's browser window: every panel in sight is worth a
    // pixel of type, so this is not the tabs.
    for (const [w, h] of [[1366, 650], [1100, 700], [1180, 640], [1280, 720]]) {
      const c = fit(w, h);
      expect(c.roomLayout).withContext(`${w}x${h}`).toBe('columns');
      expect(c.roomZoom).withContext(`${w}x${h}`).toBeGreaterThanOrEqual(640 / 1025);
      expect(c.roomZoom).withContext(`${w}x${h}`).toBeLessThan(1);
    }
    // A touch screen as far as ROOM_MILD_ZOOM, and no further.
    for (const [w, h] of [[1366, 930], [1100, 950], [1180, 930]]) {
      const c = fit(w, h, true);
      expect(c.roomLayout).withContext(`${w}x${h} held`).toBe('columns');
      expect(c.roomZoom).withContext(`${w}x${h} held`).toBeGreaterThanOrEqual(0.9);
      expect(c.roomZoom).withContext(`${w}x${h} held`).toBeLessThan(1);
    }
    expect(fit(1366, 922, true).roomLayout).toBe('tabbed');
  });

  it("keeps a computer's window in the columns much further down than a touch screen", () => {
    // Moving Unit below Abilities must not send an existing desktop window
    // to tabs. The same touch screen keeps the 90% limit and uses its tabs.
    for (const [w, h] of [[1366, 620], [1280, 600], [1024, 768], [1024, 600], [960, 540]]) {
      const c = fit(w, h);
      expect(c.roomLayout).withContext(`${w}x${h}`).toBe('columns');
      expect(c.roomZoom).withContext(`${w}x${h}`).toBeGreaterThanOrEqual(540 / 1025);
      expect(c.roomZoom).withContext(`${w}x${h}`).toBeLessThan(0.9);
      expect(c.unitPinned).withContext(`${w}x${h}`).toBeTrue();
      expect(fit(w, h, true).roomLayout).withContext(`${w}x${h} held`).toBe('tabbed');
    }
    for (const [w, h] of [[900, 520], [800, 505], [800, 1000], [849, 1000], [1284, 525], [600, 400]]) {
      const c = fit(w, h);
      expect(c.roomLayout).withContext(`${w}x${h} resized desktop`).toBe('columns');
      expect(c.unitPinned).withContext(`${w}x${h} resized desktop`).toBeTrue();
      expect(c.roomZoom).withContext(`${w}x${h} resized desktop`).toBeCloseTo(Math.min(1, w / 1180, h / 1025), 6);
    }
  });

  it('gives a landscape touch screen short of that the board and one column of tabs, unscaled', () => {
    for (const [w, h] of [[1024, 768], [1024, 600], [960, 540], [844, 390], [1366, 620]]) {
      const c = fit(w, h, true);
      expect(c.roomLayout).withContext(`${w}x${h}`).toBe('tabbed');
      expect(c.roomZoom).withContext(`${w}x${h}`).toBe(1);
      expect(c.roomWidth).withContext(`${w}x${h}`).toBeNull();
    }
  });

  it('pins the Unit panel above the tabs only where the window is tall enough for it', () => {
    expect(fit(1024, 805, true).unitPinned).toBeTrue();
    expect(fit(1024, 804, true).unitPinned).toBeFalse();
    expect(fit(1024, 768, true).unitPinned).toBeFalse();
    expect(fit(844, 390, true).unitPinned).toBeFalse();
    // In the columns it is always in sight.
    expect(fit(1920, 1080).unitPinned).toBeTrue();
  });

  it('gives a portrait window the board over the tabs, unscaled', () => {
    // The owner, 28 Sep 2026: the board the whole width on top, the tabs
    // under it. A tablet upright pins the Unit panel beside them; a phone
    // makes it a tab.
    for (const [w, h, pinned] of [[820, 1180, true], [768, 1024, true], [600, 900, true],
                                  [390, 844, false], [360, 740, false]] as const) {
      const c = fit(w, h, true);
      expect(c.roomLayout).withContext(`${w}x${h}`).toBe('stacked');
      expect(c.roomZoom).withContext(`${w}x${h}`).toBe(1);
      expect(c.unitPinned).withContext(`${w}x${h}`).toBe(pinned);
      expect(c.roomShort).withContext(`${w}x${h}`).toBeFalse();
    }
    // A portrait window big enough for the columns keeps them.
    expect(fit(1180, 1400).roomLayout).toBe('columns');
  });

  it('tightens the column for a phone on its side', () => {
    expect(fit(844, 390, true).roomShort).toBeTrue();
    expect(fit(932, 430, true).roomShort).toBeTrue();
    expect(fit(1024, 600, true).roomShort).toBeFalse();
    expect(fit(960, 520, true).roomShort).toBeFalse();
    expect(fit(960, 519, true).roomShort).toBeTrue();
  });
});

/** The tabbed layout's strip: what it offers, and which panel shows. */
describe('GameRoomComponent tabs', () => {
  const read = (c: any, name: 'shownTab' | 'roomTabs') =>
    Object.getOwnPropertyDescriptor(GameRoomComponent.prototype, name)!.get!.call(c);

  it('offers Unit a tab of its own only while it is not pinned', () => {
    expect(read({ unitPinned: true }, 'roomTabs').map((t: any) => t.id))
      .toEqual(['yours', 'theirs', 'history', 'room']);
    expect(read({ unitPinned: false }, 'roomTabs').map((t: any) => t.id))
      .toEqual(['yours', 'unit', 'theirs', 'history', 'room']);
  });

  it('shows Yours in place of a Unit tab that pinning took away', () => {
    // Chosen on a short window, then the window grew: the Unit panel is in
    // sight above the tabs, and the panel under them must not go blank.
    expect(read({ unitPinned: true, roomTab: 'unit' }, 'shownTab')).toBe('yours');
    expect(read({ unitPinned: false, roomTab: 'unit' }, 'shownTab')).toBe('unit');
    expect(read({ unitPinned: true, roomTab: 'history' }, 'shownTab')).toBe('history');
  });

  it('hands the strip the same tabs every check, so its buttons are never rebuilt', () => {
    // Built afresh on every call, the strip's buttons were torn down and
    // made again four times a second in a timed game - a click whose press
    // and release fell either side of one never happened.
    for (const unitPinned of [true, false]) {
      expect(read({ unitPinned }, 'roomTabs')).toBe(read({ unitPinned }, 'roomTabs'));
    }
  });

  /** A room with just enough behind it for the tabs and the room's business. */
  const make = (): any => {
    const gameState: any = {
      snapshot: {}, reset: () => {}, applyGameStarted: () => {},
      myColor: (who: string) => (who === 'me' ? 'white' : 'black'),
    };
    const c: any = new GameRoomComponent(
      { sendMessage: () => {}, isLocal: () => false } as any, {} as any, {} as any, {} as any, {} as any,
      { markForCheck: () => {}, detectChanges: () => {} } as any, gameState, {} as any,
      { playTone: () => {} } as any, zone,
      { getConfig: () => DEFAULT_GAME_CONFIG } as any,
    );
    c.username = 'me';
    c.persistLocalUiState = () => {};
    c.roomLayout = 'tabbed';
    c.unitPinned = true;
    return c;
  };

  it('opens on the Room tab before a match, and leaves it for Yours once one is dealt', () => {
    // Ready and Start are on the Room tab; before a match there is nothing
    // else to do, and a guest used to land on Yours with no Ready in sight.
    const c = make();
    expect(c.shownTab).toBe('room');
    c.gameId = 'room-1';
    c.handleWebSocketMessage({ type: 'join_game_room_success', gameStatus: 'started' });
    expect(c.shownTab).toBe('yours');
    // Joined again on a reconnect mid-match: wherever the player was, they
    // stay - on the chat, or an offer they were answering.
    c.selectRoomTab('room');
    c.handleWebSocketMessage({ type: 'join_game_room_success', gameStatus: 'started' });
    expect(c.shownTab).toBe('room');

    // A match dealt in the room: the same. A tab chosen other than Room is
    // left alone.
    const d = make();
    for (const name of ['beginTurnFor', 'reconcilePoints', 'playTurnSoundIfNeeded', 'startTurnClock']) {
      d[name] = () => {};
    }
    d.handleWebSocketMessage({ type: 'game_started', playerWhite: 'me', playerBlack: 'them' });
    expect(d.gameStarted).toBeTrue();
    expect(d.shownTab).toBe('yours');
    d.selectRoomTab('history');
    d.handleWebSocketMessage({ type: 'game_started', playerWhite: 'me', playerBlack: 'them' });
    expect(d.shownTab).toBe('history');

    // Back to waiting: back to Room - and its chats to their newest, which
    // spent the match under another tab where nothing could scroll them.
    const scrolled: string[] = [];
    const scroll = d.scrollChatToBottom.bind(d);
    d.scrollChatToBottom = (which: string, ...rest: any[]) => { scrolled.push(which); scroll(which, ...rest); };
    d.handleWebSocketMessage({ type: 'game_reset' });
    expect(d.shownTab).toBe('room');
    expect(scrolled).toContain('gameRoom');
    expect(scrolled).toContain('lobby');
  });

  it('marks the Room tab while something on it is waiting on you', () => {
    const c = make();
    // A guest before a match: Ready.
    c.gameStarted = false;
    c.isInviter = false;
    expect(c.roomNeedsYou).toBeTrue();
    c.isReady = true;
    expect(c.roomNeedsYou).toBeFalse();
    // The host: their own Ready first - Start waits on it as on anyone's -
    // then Start, once it can be pressed.
    c.isInviter = true;
    spyOn(c, 'canStartGame').and.returnValue(false);
    c.isReady = false;
    expect(c.roomNeedsYou).toBeTrue();
    c.isReady = true;
    expect(c.roomNeedsYou).toBeFalse();
    (c.canStartGame as jasmine.Spy).and.returnValue(true);
    expect(c.roomNeedsYou).toBeTrue();

    // A match under way: nothing on the Room tab waits on you. An offer of a
    // draw is over the board instead (drawOfferToYou) - theirs, not yours.
    c.gameStarted = true;
    expect(c.roomNeedsYou).toBeFalse();
    expect(c.drawOfferToYou).toBeFalse();
    c.gameState.snapshot.drawOfferedBy = 'them';
    expect(c.roomNeedsYou).toBeFalse();
    expect(c.drawOfferToYou).toBeTrue();
    c.gameState.snapshot.drawOfferedBy = 'me';
    expect(c.drawOfferToYou).toBeFalse();
    c.gameState.snapshot.drawOfferedBy = '';

    // Over, in a solo room: Restart.
    c.isSinglePlayer = true;
    c.gameState.snapshot.endReason = 'regicide';
    expect(c.roomNeedsYou).toBeTrue();
  });

  it('counts the chat come in while it was out of sight, and no more once seen', () => {
    const c = make();
    c.gameStarted = true;
    c.isInviter = false;
    c.selectRoomTab('yours');
    const say = (username: string) =>
      c.handleWebSocketMessage({ type: 'game_room_message', username, content: 'hi', timestamp: '' });
    say('them');
    say('me');                     // your own is not news
    c.addSystemMessage('White moved.');   // nor the log's
    say('them');
    c.ngAfterViewChecked();
    expect(c.roomCue).toBe('2');

    // Seen: the Room tab opened, its chat on screen through a check.
    c.selectRoomTab('room');
    c.ngAfterViewChecked();
    c.selectRoomTab('yours');
    expect(c.roomCue).toBe('');
    say('them');
    expect(c.roomCue).toBe('1');

    // Out of sight in the columns too: behind the rail's Lobby tab.
    c.roomLayout = 'columns';
    c.ngAfterViewChecked();
    expect(c.chatUnread).toBe(0);
    c.activeSideTab = 'lobby';
    say('them');
    expect(c.chatUnread).toBe(1);

    // Past nine it says so rather than growing.
    for (let i = 0; i < 12; i++) say('them');
    expect(c.roomCue).toBe('9+');
  });

  it('counts the first lines of a match, whatever the chat held before it', () => {
    // Counted off the log, the cue went quiet for as many lines as the chat
    // had held before the deal cleared it - three seen before the match, and
    // the match's first three said nothing.
    const c = make();
    for (const name of ['beginTurnFor', 'reconcilePoints', 'playTurnSoundIfNeeded', 'startTurnClock']) {
      c[name] = () => {};
    }
    const say = (username: string) =>
      c.handleWebSocketMessage({ type: 'game_room_message', username, content: 'hi', timestamp: '' });
    // Before the match, on the Room tab: seen as they come.
    say('them'); say('them'); say('them');
    c.ngAfterViewChecked();
    expect(c.chatUnread).toBe(0);
    c.handleWebSocketMessage({ type: 'game_started', playerWhite: 'me', playerBlack: 'them' });
    expect(c.shownTab).toBe('yours');
    say('them'); say('them');
    c.ngAfterViewChecked();
    expect(c.roomCue).toBe('2');

    // Unseen when the next match is dealt: those lines went with the log.
    c.handleWebSocketMessage({ type: 'game_started', playerWhite: 'me', playerBlack: 'them' });
    expect(c.roomCue).toBe('');

    // And whoever leaves takes their unseen lines with them.
    say('them');
    expect(c.chatUnread).toBe(1);
    c.handleWebSocketMessage({ type: 'player_list', players: [{ username: 'me' }] });
    expect(c.chatUnread).toBe(0);
  });

  it('keeps History at its newest line, as the chats are', () => {
    // Oldest first, and at the columns' least height room for about one
    // line: with nothing to scroll it, it showed "Game started!" all match.
    const c = make();
    const scrolled: string[] = [];
    c.scrollChatToBottom = (which: string) => scrolled.push(which);
    c.addSystemMessage('White moved.');
    c.handleWebSocketMessage({ type: 'game_room_message', username: 'them', content: 'hi', timestamp: '' });
    c.addSystemMessage('Black moved.');
    expect(scrolled).toEqual(['history', 'gameRoom', 'history']);
    scrolled.length = 0;
    c.selectRoomTab('history');
    expect(scrolled).toEqual(['history']);
  });

  it('leaves a log where it is while its reader is reading back', () => {
    // A line coming in follows the log only if it was at its newest; a log
    // coming into sight goes there whatever.
    const c = make();
    const later = jasmine.createSpy('runOutsideAngular');
    c.zone = { runOutsideAngular: later };
    c.historyEl = { clientHeight: 100, scrollHeight: 500, scrollTop: 0 };   // reading back
    c.scrollChatToBottom('history', true);
    expect(later).not.toHaveBeenCalled();
    c.scrollChatToBottom('history');
    expect(later).toHaveBeenCalledTimes(1);
    c.historyEl.scrollTop = 400;                                            // at its newest
    c.scrollChatToBottom('history', true);
    expect(later).toHaveBeenCalledTimes(2);
  });

  it('follows the reader\'s own line in either chat, even while they read back', () => {
    // Sent from a chat scrolled back, it landed below the fold and nothing
    // seemed to happen. The lobby kept this rule; the room's chats had not.
    const c = make();
    const later = jasmine.createSpy('runOutsideAngular');
    c.zone = { runOutsideAngular: later };
    c.gameChatEl = { clientHeight: 100, scrollHeight: 500, scrollTop: 0 };  // reading back
    c.handleWebSocketMessage({ type: 'game_room_message', username: 'them', content: 'hi', timestamp: '' });
    expect(later).not.toHaveBeenCalled();
    c.handleWebSocketMessage({ type: 'game_room_message', username: 'me', content: 'gg', timestamp: '' });
    expect(later).toHaveBeenCalledTimes(1);
    c.lobbyChatEl = { clientHeight: 100, scrollHeight: 500, scrollTop: 0 };
    c.scrollChatToBottom('lobby', true);
    expect(later).toHaveBeenCalledTimes(1);
    c.scrollChatToBottom('lobby', true, true);
    expect(later).toHaveBeenCalledTimes(2);
  });

  it('brings the chats to their newest when the Room tab is chosen', () => {
    // One that is not drawn cannot be scrolled, so while it sat under
    // another tab it kept its place, above everything that came in.
    const c = make();
    const scrolled: string[] = [];
    c.scrollChatToBottom = (which: string) => scrolled.push(which);
    c.selectRoomTab('theirs');
    expect(scrolled).toEqual([]);
    c.selectRoomTab('room');
    expect(scrolled).toEqual(['gameRoom', 'lobby']);
  });

  describe('a "?" on a touch screen', () => {
    // A "?" at (left, top), 24px square, as its click hands it over.
    const press = (left: number, top: number) => ({
      currentTarget: { getBoundingClientRect: () => ({ left, top, width: 24, height: 24, right: left + 24, bottom: top + 24 }) },
    });
    let width: jasmine.Spy;
    let height: jasmine.Spy;
    beforeEach(() => {
      width = spyOnProperty(window, 'innerWidth').and.returnValue(390);
      height = spyOnProperty(window, 'innerHeight').and.returnValue(664);
    });

    it('opens under it in the top half of the window and over it in the bottom, inside the gutter', () => {
      const c = make();
      // By the right-hand edge, near the top: under it, drawn in to the gutter.
      c.toggleTip('score', press(360, 40));
      expect(c.tip).toEqual({
        id: 'score', width: 320, left: 390 - 16 - 320, top: 70, bottom: null, maxHeight: 664 - 64 - 6 - 16,
      });
      // Pressed again: shut.
      c.toggleTip('score', press(360, 40));
      expect(c.tip).toBeNull();
      // Near the bottom: over it - and another "?" pressed while one is open
      // takes its place.
      c.toggleTip('purse-mine', press(180, 100));
      c.toggleTip('start', press(4, 600));
      expect(c.tip).toEqual({
        id: 'start', width: 320, left: 16, top: null, bottom: 664 - 600 + 6, maxHeight: 600 - 6 - 16,
      });
      // A window narrower than the bubble: the window less its gutters.
      c.closeTip();
      width.and.returnValue(300);
      c.toggleTip('tally', press(100, 100));
      expect(c.tip.width).toBe(268);
      expect(c.tip.left).toBe(16);
      c.closeTip();
    });

    it('shuts on a press anywhere but a "?" or itself, on Escape, and when the room moves under it', () => {
      const c = make();
      const other = document.createElement('button');
      other.className = 'tip-btn';
      document.body.appendChild(other);
      try {
        c.toggleTip('score', press(10, 10));
        // Another "?" answers on its own click; the bubble's words can be pressed.
        other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(c.tip).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(c.tip).toBeNull();

        c.toggleTip('score', press(10, 10));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(c.tip).not.toBeNull();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(c.tip).toBeNull();

        c.toggleTip('score', press(10, 10));
        window.dispatchEvent(new Event('resize'));
        expect(c.tip).toBeNull();

        // A scroll that moves its "?" shuts it; one elsewhere - History or a
        // chat keeping to its newest line - does not. Any scroll shut it, and
        // a move coming in closed the bubble being read.
        const panel = document.createElement('div');
        const log = document.createElement('div');
        const q = document.createElement('button');
        panel.appendChild(q);
        document.body.append(panel, log);
        try {
          c.toggleTip('score', { currentTarget: q });
          log.dispatchEvent(new Event('scroll'));
          expect(c.tip).not.toBeNull();
          panel.dispatchEvent(new Event('scroll'));
          expect(c.tip).toBeNull();
        } finally {
          panel.remove();
          log.remove();
        }

        // And once shut it is listening to nothing: a press then is nobody's.
        const shut = spyOn(c, 'closeTip').and.callThrough();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(shut).not.toHaveBeenCalled();
      } finally {
        other.remove();
        c.closeTip();
      }
    });

    it('shuts once its "?" has nothing left to say', () => {
      // Start's bubble stayed an empty dark box once the match began, and the
      // tally's stayed over a panel a unit had filled.
      const c = make();
      c.toggleTip('start', press(4, 600));
      c.ngDoCheck();
      expect(c.tip).not.toBeNull();
      c.gameStarted = true;
      c.ngDoCheck();
      expect(c.tip).toBeNull();

      c.toggleTip('tally', press(100, 100));
      c.ngDoCheck();
      expect(c.tip).not.toBeNull();
      c.selectedUnit = { unit_id: 'pawn', color: 'white', hp: 20, max_hp: 20 };
      c.ngDoCheck();
      expect(c.tip).toBeNull();

      // The score's "?" is in the turn banner, which goes with the match: its
      // bubble floated over the end of it.
      c.selectedUnit = null;
      c.gameState.snapshot.turnNumber = 10;          // Phase 1: the scores up
      expect(c.showScore).toBeTrue();
      c.toggleTip('score', press(10, 10));
      c.ngDoCheck();
      expect(c.tip).not.toBeNull();
      c.gameState.snapshot.endReason = 'resignation';
      c.ngDoCheck();
      expect(c.tip).toBeNull();
    });

    it('stays inside the window top to bottom, what is past it scrolling in the bubble', () => {
      // A phone on its side: the Points/CP bubble ran off the foot of the
      // screen, fixed where nothing could scroll to it.
      height.and.returnValue(330);
      const c = make();
      c.toggleTip('purse-mine', press(100, 150));
      expect(c.tip.top).toBe(180);
      expect(c.tip.maxHeight).toBe(330 - 174 - 6 - 16);
      c.closeTip();
    });

    it('says what the tooltip it stands for says, as the room stands now', () => {
      const c = make();
      expect(c.tipText('score')).toBe(c.scoreTitle);
      expect(c.tipText('purse-mine')).toContain(c.pointsTitle);
      expect(c.tipText('purse-opponent')).toContain(c.cpTitle);
      expect(c.tipText('tally')).toContain(c.tallyTitles.mine);
      expect(c.tipText('tally')).toContain(c.tallyTitles.theirs);
      // Start's: why it is greyed before a match - and nothing during one,
      // where a greyed Start says so for itself.
      expect(c.tipText('start')).toBe('Waiting for both players to be ready.');
      c.gameStarted = true;
      expect(c.startButtonHint).toBe('The match is running.');
      expect(c.tipText('start')).toBe('');
    });
  });
});
