import { StagedAction, AbilitySpend, onlineTurnCommands, soloTurnCommands, stagedActionRecords, stagedTurnEvents } from './turn-staging';
import type { BoardState, PieceData } from './game-state.service';

const unit: PieceData = { unit_id: 'test-unit', color: 'white', hp: 10, max_hp: 10, uid: 'actor' };
const context = { moveBonusFor: () => 0, pathMoveFor: () => 0, bonusFor: () => 0, offBoard: () => false };
const spend: AbilitySpend = { side: 'mine', row: 'mine', index: 0, cost: 1, uid: '',
  priorCooldown: 0, priorBuff: null, priorUsed: false };
const action = (at: number, from: string, to: string, board: BoardState): StagedAction =>
  ({ at, from, to, board, attack: null, used: 1 });

describe('One staged-turn chronology for both engines', () => {
  it('resolves Convert before its funded crossing without paying the same reward twice', () => {
    const board = { '1,0': unit, '4,0': { ...unit, uid: 'second' } };
    const reward = { castId: 'reward', color: 'white', abilityCast: { id: 'convert', up: 50 } };
    const actions = [action(10, '0,0', '1,0', board),
      { ...action(20, '0,0', '1,0', board), spend, effects: [reward] },
      action(40, '4,0', '5,0', { '1,0': unit, '5,0': { ...unit, uid: 'second' } })];
    const panel = { type: 'panel_move' as const, from: '-13,11', to: '13,-11', cost: 1, price: 12, unit: { ...unit, uid: 'recruit' } };
    const events = stagedTurnEvents(actions, [panel], [{ at: 30, command: { type: 'panel_move', from: panel.from, to: panel.to } }], []);
    expect(stagedActionRecords(events, 7, 'white', { '0,0': unit }).map(record => record.from)).toEqual(['0,0', '-13,11', '4,0']);
    const online = onlineTurnCommands(events, { '0,0': unit, '4,0': board['4,0'] }, [{ id: 'convert', target: 'universal' }]);
    expect(online.map(command => command.type)).toEqual(['make_move', 'cast_ability', 'panel_move', 'make_move', 'pass_turn']);
    expect(online[2]).toEqual({ type: 'panel_move', from: panel.from, to: panel.to });
    const solo = soloTurnCommands(events, context);
    expect(solo.map(command => command.type)).toEqual(['make_move', 'panel_move', 'make_move', 'pass_turn']);
    expect(solo[1].effectsBefore).toEqual([reward]);
    expect(solo.flatMap(command => [...command.effectsBefore ?? [], ...command.effects ?? []])).toEqual([reward]);
  });

  it('keeps a lethal intervening cast after combat and before the remaining walk', () => {
    const attacked = { ...action(10, '0,0', '0,0', { '0,0': unit }), attack: '1,0' };
    const death = { at: '1,0', uid: 'defender', hp: 0 };
    const cast = { ...action(20, '0,0', '0,0', attacked.board), spend, effects: [death] };
    const walk = { ...action(30, '0,0', '1,0', { '1,0': unit }), attack: '1,0', attackFrom: '0,0', afterAttackWalk: true };
    const solo = soloTurnCommands(stagedTurnEvents([attacked, cast, walk], [], [], []), context);
    expect(solo[0].attack).toBe('1,0'); expect(solo[0].afterAttackTo).toBe('1,0');
    expect(solo[0].effectsAfterAttack).toEqual([death]);
    expect(solo[0].effects).toBeUndefined(); expect(solo[0].effectsBefore).toBeUndefined();
  });
  it('restores legacy untimed panel actions without moving them after equal-time casts or mutating the saved stacks', () => {
    const legacy: StagedAction[] = [{ from: '0,0', to: '1,0', board: { '1,0': unit }, used: 1, attack: null }];
    const panel = { type: 'panel_move' as const, from: '-12,1', to: '-12,2',
      unit: { ...unit, uid: 'recruit' }, cost: 1, price: 0 };
    const choices = [{ at: 0, command: { type: 'pick_pair' as const, id: 'warcry' } }];
    const saved = JSON.stringify({ legacy, panel, choices });
    const events = stagedTurnEvents(legacy, [panel], [], choices);
    expect(events.map(event => event.kind)).toEqual(['choice', 'panel', 'action']);
    expect(onlineTurnCommands(events, { '0,0': unit }, []).map(command => command.type))
      .toEqual(['pick_pair', 'panel_move', 'make_move', 'pass_turn']);
    expect(soloTurnCommands(events, context).map(command => command.type))
      .toEqual(['panel_move', 'make_move', 'pass_turn']);
    expect(stagedActionRecords(events, 7, 'white', { '0,0': unit }).map(record => record.from))
      .toEqual(['-12,1', '0,0']);
    expect(JSON.stringify({ legacy, panel, choices })).toBe(saved);
  });

});
