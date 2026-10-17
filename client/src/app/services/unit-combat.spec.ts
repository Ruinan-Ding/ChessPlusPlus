import { sectionOf } from './game-rules';
import { combatStatuses, combatExchange, carries, tauntAllows } from './unit-combat';
import { controlsAt, controlledUnit } from './unit-control';
import { PREVIOUS_GAME_CONFIG as config } from './config.service';
import BALANCE_CONFIG from '../../../../shared/testing/balance-config.json';
import { stackEffect } from './ability-rules';

const piece = (unit_id: string, color = 'white', hp = 20): any => ({ unit_id, color, uid: unit_id + color, hp, vet: 3, max_hp: hp });
const bonuses = { atk: 0, def: 0, targetAtk: 0, targetDef: 0 };
describe('unit combat effects', () => {
  it('Leech heals actual attack damage before the counter, with overkill and max-HP caps', () => {
    const config = structuredClone(BALANCE_CONFIG);
    config.units.rook.attack = 20;
    const queen = { unit_id: 'queen', color: 'white', uid: 'q', vet: 3, hp: 4, max_hp: 34 };
    const rook = { unit_id: 'rook', color: 'black', uid: 'r', vet: 0, hp: 24, max_hp: 24 };
    const bonuses = { atk: 4, def: 2, targetAtk: 0, targetDef: 0, leech: true };
    const result = combatExchange(queen, rook, 1, config, bonuses);
    expect([result.damage, result.counterDamage, result.leechHeal, result.attackerHp]).toEqual([10, 10, 10, 4]);
    const overkill = combatExchange(queen, { ...rook, hp: 1 }, 1, config, bonuses);
    expect([overkill.leechHeal, overkill.attackerHp, overkill.countered]).toEqual([1, 5, false]);
    const capped = combatExchange({ ...queen, hp: 33 }, rook, 1, config, bonuses);
    expect([capped.leechHeal, capped.attackerHp]).toEqual([1, 24]);
    expect(combatExchange(queen, rook, 1, config, { ...bonuses, targetImmune: true }).leechHeal).toBe(0);
  });

  it('Leech on a defender does not heal from its counterattack', () => {
    const config = structuredClone(BALANCE_CONFIG);
    const pawn = { unit_id: 'pawn', color: 'white', uid: 'p', vet: 0, hp: 12, max_hp: 12 };
    const queen = { unit_id: 'queen', color: 'black', uid: 'q', vet: 3, hp: 10, max_hp: 34 };
    const buff = stackEffect(undefined, { name: 'Leech', effect: 'leech', mov: 0, atk: 4, def: 2 }, 'black');
    const result = combatExchange(pawn, queen, 1, config, { atk: 0, def: 0, targetAtk: 4, targetDef: 2,
      ...combatStatuses(undefined, buff) });
    expect(result.countered).toBeTrue(); expect(result.targetHp).toBe(9); expect(result.leechHeal).toBe(0);
  });

  it('caps ATK and DEF before damage, fixed stats and HP before an exchange', () => {
    const custom: any = { units: { attacker: { attack: 95, attackRange: 1, defense: 0 },
      defender: { attack: 0, defense: 95, attackRange: 1 } }, rules: { minStrikeDamage: 1 } };
    const attacker = { unit_id: 'attacker', color: 'white', hp: 200, max_hp: 250 };
    const defender = { unit_id: 'defender', color: 'black', hp: 200, max_hp: 250 };
    expect(combatExchange(attacker, defender, 1, custom, { ...bonuses, atk: 20, targetDef: 10 }))
      .toEqual(jasmine.objectContaining({ damage: 1, attackerHp: 99, targetHp: 98, countered: false }));
    expect(combatExchange(attacker, defender, 1, custom, { ...bonuses, atkSet: 150, targetDefSet: 0 }))
      .toEqual(jasmine.objectContaining({ damage: 99, attackerHp: 99, targetHp: 0 }));
    expect(attacker.hp).toBe(200); expect(defender.hp).toBe(200);
  });

  it('resolves two charged units as attack, counter, attack, counter with no further chain', () => {
    const config = structuredClone(BALANCE_CONFIG);
    const attacker = piece('knight'), defender = piece('knight', 'black');
    const buff = stackEffect(undefined, { ...config.abilities.catalogue['knight-charge'], mov: 0, atk: 0, def: 0 }, 'black');
    const modifiers = { ...bonuses, charge: true, ...combatStatuses(undefined, buff) };
    for (const [hp, targetHp, end, targetEnd, second, counter] of [
      [20, 20, 4, 4, true, true], [8, 20, 0, 12, false, false],
      [20, 12, 12, 0, true, false], [10, 20, 0, 4, true, true],
    ]) {
      const result = combatExchange({ ...attacker, hp }, { ...defender, hp: targetHp }, 1, config, modifiers);
      expect([result.attackerHp, result.targetHp, result.secondStrike, result.secondCounter]).toEqual([end, targetEnd, second, counter]);
    }
    const immune = combatExchange(attacker, defender, 1, config, { ...modifiers, immune: true, targetImmune: true });
    expect([immune.damage, immune.counterDamage, immune.secondDamage, immune.secondCounterDamage]).toEqual([0, 0, 0, 0]);
    expect(immune.secondCounter).toBeTrue();
    expect(combatExchange(attacker, defender, 1, config, modifiers, false).secondCounter).toBeFalse();
    expect(combatExchange(attacker, defender, 1, config, { ...modifiers, nullify: true }).secondCounter).toBeFalse();
    delete buff.effects![0].secondCounter;
    const legacy = combatExchange(attacker, defender, 1, config, { ...bonuses, charge: true, ...combatStatuses(undefined, buff) });
    expect([legacy.attackerHp, legacy.secondCounter]).toEqual([12, false]);
  });

  it('charges only after an actual counter while alive, with no second counter', () => {
    const knight = piece('knight'), pawn = piece('pawn', 'black', 14);
    const exchange = combatExchange(knight, pawn, 1, config, { ...bonuses, charge: true });
    expect([exchange.targetHp, exchange.attackerHp, exchange.counterDamage, exchange.secondDamage]).toEqual([0, 18, 2, 8]);
    expect(combatExchange({ ...knight, hp: 1 }, pawn, 1, config, { ...bonuses, charge: true }).secondDamage).toBe(0);
    expect(combatExchange(knight, { ...piece('shieldman', 'black', 28), vet: 1 }, 1, config, { ...bonuses, charge: true }).secondDamage).toBe(0);
    const nullified = combatExchange(knight, pawn, 1, config, { ...bonuses, charge: true, nullify: true });
    expect([nullified.countered, nullified.attackerHp, nullified.secondDamage]).toEqual([false, 20, 0]);
  });
  it('records a Charge strike even when Fortress prevents all its damage', () => {
    const knight = piece('knight'), rook = piece('rook', 'black', 40);
    const exchange = combatExchange(knight, rook, 1, config, { ...bonuses, charge: true, targetImmune: true });
    expect(exchange).toEqual(jasmine.objectContaining({ damage: 0, secondDamage: 0, countered: true, secondStrike: true }));
    expect(exchange.targetHp).toBe(40);
    expect(combatExchange(knight, rook, 1, config, { ...bonuses, charge: true, targetImmune: true, nullify: true }))
      .toEqual(jasmine.objectContaining({ secondStrike: false, countered: false }));
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
  it('prevents counters and Charge after a lethal strike or when counters are disabled', () => {
    const knight = piece('knight'), pawn = piece('pawn', 'black', 1);
    const killed = combatExchange(knight, pawn, 1, config, { ...bonuses, charge: true });
    expect([killed.targetHp, killed.attackerHp, killed.countered, killed.counterDamage, killed.secondDamage])
      .toEqual([0, 20, false, 0, 0]);
    const disabled = combatExchange(knight, { ...pawn, hp: 14, max_hp: 14 }, 1, config, { ...bonuses, charge: true }, false);
    expect([disabled.targetHp, disabled.attackerHp, disabled.countered, disabled.secondDamage])
      .toEqual([6, 20, false, 0]);
  });

  it('bases Taunt eligibility on the exact attack ring and ATK buffs, ignoring dead or friendly taunters', () => {
    const custom = structuredClone(config);
    Object.assign(custom.units.archer, { attack: [0, 8], attackMinRange: 1, attackRange: 2 });
    const attacker = piece('archer'), shield = piece('shieldman', 'black', 32);
    const board = { '0,0': attacker, '1,0': shield, '2,0': piece('pawn', 'black', 14) };
    const taunt = stackEffect(undefined, { name: 'Taunt', effect: 'taunt', mov: 0, atk: 0, def: 0 }, 'black');
    const buffs: any = { [shield.uid]: taunt };
    expect(tauntAllows(board, '0,0', '2,0', custom, buffs)).toBeTrue();
    buffs[attacker.uid] = { atk: 8 };
    expect(tauntAllows(board, '0,0', '2,0', custom, buffs)).toBeFalse();
    expect(tauntAllows(board, '0,0', '1,0', custom, buffs)).toBeTrue();
    board['1,0'] = { ...shield, hp: 0 };
    expect(tauntAllows(board, '0,0', '2,0', custom, buffs)).toBeTrue();
    board['1,0'] = { ...shield, color: 'white' };
    expect(tauntAllows(board, '0,0', '2,0', custom, buffs)).toBeTrue();
  });

  it('checks Taunt reach using active kit stats rather than earned stars', () => {
    const custom:any=structuredClone(config);custom.version='2.0';
    custom.veterancy={...sectionOf(undefined,'veterancy'),kitZones:['reserve']};
    const board={'0,0':piece('king'),'2,0':piece('shieldman','black',28),'1,-1':piece('pawn','black',14)};
    const taunt=stackEffect(undefined,{name:'Taunt',effect:'taunt',mov:0,atk:0,def:0},'black');
    const buffs={[board['2,0'].uid]:taunt};
    expect(tauntAllows(board,'0,0','1,-1',custom,buffs)).toBeTrue();
    custom.veterancy.kitZones.push('battlefield');
    expect(tauntAllows(board,'0,0','1,-1',custom,buffs)).toBeFalse();
  });

  it('retains original ownership, position and wounds through control expiry and reload', () => {
    const unit = { ...piece('king', 'black', 7), owner: 'black', color: 'white', controlledUntil: 57, controlTurn: 55 };
    const history = JSON.parse(JSON.stringify([{ turn: 55, control: unit, at: '-12,11' }]));
    expect(controlledUnit({ ...unit, hp: 3 }, controlsAt(history, 56), 56).color).toBe('white');
    const returned = controlledUnit({ ...unit, hp: 3 }, controlsAt(history, 57), 57);
    expect([returned.color, returned.owner, returned.hp, returned.controlledUntil]).toEqual(['black', 'black', 3, undefined]);
  });
});
