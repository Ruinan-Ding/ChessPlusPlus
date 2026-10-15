import { parseGameCommand, replayCommand } from './game-command';
import type { GameCommand } from './game-command';

describe('Semantic command boundary', () => {
  it('normalizes coordinates and retains intent without accepting resolved outcomes', () => {
    expect(parseGameCommand({ type: 'make_move', from: '00,01', to: '-02,03', attack: null,
      withdraw: false, bonuses: { atk: 99 }, effectsBefore: [{ hp: 0 }] }))
      .toEqual({ type: 'make_move', from: '0,1', to: '-2,3' });
  });
  it('keeps corrupt imported fields untrusted until the action is executed', () => {
    const raw = replayCommand({ type: 'make_move', from: ['0,0'], to: '1,0' });
    expect(raw.from).toEqual(['0,0']);
    expect(() => parseGameCommand(raw)).toThrow();
    expect(() => parseGameCommand({ type: 'cast_ability', targetUid: 'target' })).toThrow();
    expect(() => parseGameCommand({ type: 'make_move', from: '0,0', to: '1,0', more: 'yes' })).toThrow();
    expect(() => parseGameCommand({ type: 'constructor' })).toThrow();
  });
  it('requires each command variant’s own fields and excludes fields belonging to other variants', () => {
    const cases: GameCommand[] = [
      { type: 'make_move', from: '0,0', to: '1,0' },
      { type: 'panel_move', from: '0,0', to: '1,0' },
      { type: 'enter_board', from: '0,0', to: '1,0' },
      { type: 'panel_attack', from: '0,0', to: '1,0', attack: '2,0' },
      { type: 'cast_ability', id: 'custom-ability' }, { type: 'pick_pair', id: 'custom-pair' },
      { type: 'reset_pair', id: 'custom-pair' }, { type: 'pick_path', id: 'custom-path' },
      { type: 'result', reason: 'resign' }, { type: 'pass_turn' },
    ];
    for (const command of cases) {
      expect(parseGameCommand({ ...command, hp: 99, effects: [{ hp: 0 }], token: 'secret' })).toEqual(command);
      for (const key of Object.keys(command).filter(key => key !== 'type')) {
        const incomplete: Record<string, unknown> = { ...command }; delete incomplete[key];
        expect(() => parseGameCommand(incomplete)).withContext(`${command.type} missing ${key}`).toThrow();
      }
    }
    expect(parseGameCommand({ type: 'pass_turn', from: 'invalid', more: 'invalid' })).toEqual({ type: 'pass_turn' });
  });

  it('rejects unsafe coordinate integers, non-boolean options and inherited required fields', () => {
    for (const to of ['9007199254740992,0', '1.5,0', '1, 0', '1,0,0']) {
      expect(() => parseGameCommand({ type: 'make_move', from: '0,0', to })).withContext(to).toThrow();
    }
    for (const field of ['more', 'withdraw']) for (const value of [0, 1, null, 'true', {}, []]) {
      expect(() => parseGameCommand({ type: 'make_move', from: '0,0', to: '1,0', [field]: value }))
        .withContext(`${field}: ${JSON.stringify(value)}`).toThrow();
    }
    const inherited = Object.assign(Object.create({ id: 'inherited' }), { type: 'pick_pair' });
    expect(() => parseGameCommand(inherited)).toThrow();
    expect(parseGameCommand({ type: 'cast_ability', id: 'constructor', targetUid: '__proto__' }))
      .toEqual({ type: 'cast_ability', id: 'constructor', targetUid: '__proto__' });
  });

});
