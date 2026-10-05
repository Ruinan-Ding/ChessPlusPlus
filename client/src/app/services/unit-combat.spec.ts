import { combatExchange, carries, tauntAllows } from './unit-combat';
import { controlsAt, controlledUnit } from './unit-control';
import { DEFAULT_GAME_CONFIG as config } from './config.service';
import { stackEffect } from './ability-rules';

const piece = (unit_id: string, color = 'white', hp = 20): any => ({ unit_id, color, uid: unit_id + color, hp, vet: 3, max_hp: hp });
const bonuses = { atk: 0, def: 0, targetAtk: 0, targetDef: 0 };
describe('unit combat effects', () => {
  it('charges only after an actual counter while alive, with no second counter', () => {
    const knight = piece('knight'), pawn = piece('pawn', 'black', 14);
    const exchange = combatExchange(knight, pawn, 1, config, { ...bonuses, charge: true });
    expect([exchange.targetHp, exchange.attackerHp, exchange.counterDamage, exchange.secondDamage]).toEqual([6, 19, 1, 4]);
    expect(combatExchange({ ...knight, hp: 1 }, pawn, 1, config, { ...bonuses, charge: true }).secondDamage).toBe(0);
    expect(combatExchange(knight, piece('shieldman', 'black', 32), 1, config, { ...bonuses, charge: true }).secondDamage).toBe(0);
    const nullified = combatExchange(knight, pawn, 1, config, { ...bonuses, charge: true, nullify: true });
    expect([nullified.countered, nullified.attackerHp, nullified.secondDamage]).toEqual([false, 20, 0]);
  });
  it('allows any reachable taunter and releases other targets when none can be reached', () => {
    const board = { '0,0': piece('pawn'), '1,0': piece('shieldman', 'black', 32), '0,1': piece('shieldman', 'black', 32), '1,-1': piece('pawn', 'black', 14) };
    const buff = stackEffect(undefined, { name: 'Taunt', effect: 'taunt', mov: 0, atk: 0, def: 0 }, 'black');
    const buffs = { shieldmanblack: JSON.parse(JSON.stringify(buff)) };
    expect(carries(buffs.shieldmanblack, 'taunt')).toBeTrue();
    expect(tauntAllows(board, '0,0', '1,-1', config, buffs)).toBeFalse();
    expect(tauntAllows(board, '0,0', '1,0', config, buffs)).toBeTrue();
    expect(tauntAllows(board, '0,0', '0,1', config, buffs)).toBeTrue();
    expect(tauntAllows(board, '0,0', '1,-1', config, buffs, false)).toBeTrue();
    expect(tauntAllows({ '0,0': board['0,0'], '1,-1': board['1,-1'], '3,0': board['1,0'] }, '0,0', '1,-1', config, buffs)).toBeTrue();
  });
  it('retains original ownership, position and wounds through control expiry and reload', () => {
    const unit = { ...piece('king', 'black', 7), owner: 'black', color: 'white', controlledUntil: 57, controlTurn: 55 };
    const history = JSON.parse(JSON.stringify([{ turn: 55, control: unit, at: '-12,11' }]));
    expect(controlledUnit({ ...unit, hp: 3 }, controlsAt(history, 56), 56).color).toBe('white');
    const returned = controlledUnit({ ...unit, hp: 3 }, controlsAt(history, 57), 57);
    expect([returned.color, returned.owner, returned.hp, returned.controlledUntil]).toEqual(['black', 'black', 3, undefined]);
  });
});
