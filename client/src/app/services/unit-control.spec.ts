import { controlledUnit, controlsAt } from './unit-control';
import type { PieceData } from './game-state.service';

describe('unit control history', () => {
  const unit: PieceData = { unit_id: 'pawn', color: 'black', uid: 'original', hp: 5, max_hp: 14, vet: 3 };
  const control: PieceData = { ...unit, owner: 'black', color: 'white', controlTurn: 55, controlledUntil: 57 };

  it('projects only control metadata onto the current unit without restoring earlier wounds or stats', () => {
    const current = { ...unit, hp: 2, max_hp: 16, vet: 2 };
    const history = [{ turn: 55, at: '1,0', control }];
    const before = structuredClone({ current, history });
    const projected = controlledUnit(current, controlsAt(history, 56), 56);
    expect(projected).toEqual({ ...current, owner: 'black', color: 'white', controlTurn: 55, controlledUntil: 57 });
    expect({ current, history }).toEqual(before);
  });

  it('returns control at the exact expiry while preserving ownership, wounds and veterancy', () => {
    const current = { ...control, hp: 2 };
    expect(controlledUnit(current, controlsAt([{ control }], 56), 56).color).toBe('white');
    const restored = JSON.parse(JSON.stringify(current));
    expect(controlsAt([{ control }], 57)).toEqual({});
    expect(controlledUnit(restored, {}, 57)).toEqual({ ...unit, owner: 'black', hp: 2 });
    expect(current.controlledUntil).toBe(57);
  });

  it('uses the latest cast for each UID and never revives a superseded cast when the latest expires', () => {
    const older = { ...control, controlledUntil: 61 };
    const newer = { ...control, controlTurn: 56, controlledUntil: 59 };
    const other = { ...control, uid: 'other', controlledUntil: 60 };
    const history = JSON.parse(JSON.stringify([{ control: older }, { control: other }, { control: newer }]));
    expect(controlsAt(history, 58)).toEqual({ original: newer, other });
    expect(controlsAt(history, 59)).toEqual({ other });
    expect(controlsAt(history, 60)).toEqual({});
  });

  it('leaves units of the same type with another UID and units without a UID unchanged', () => {
    const controls = controlsAt([{ control }, { turn: 56, abilityDeath: unit }], 56);
    const other = { ...unit, uid: 'other' };
    const anonymous = { ...unit, uid: undefined };
    expect(controlledUnit(other, controls, 56)).toBe(other);
    expect(controlledUnit(anonymous, controls, 56)).toBe(anonymous);
  });
});
