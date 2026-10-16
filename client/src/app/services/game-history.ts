import type { PieceData, PieceIdentity } from './game-state.service';
import type { UnitBuff } from './ability-rules';

interface EffectFields {
  at?: string; uid?: string; unit?: PieceData; panel?: string; hp?: number; color?: string;
  castId?: string; promotion?: PieceData; status?: { uid: string; buff: UnitBuff | null };
  control?: PieceData; controlSource?: string; sourcePanel?: string;
  unitCast?: { uid: string; id: string; color: string; at?: string; cost: number; gain?: number };
  abilityCast?: { id: string; name?: string; row?: string; up?: number; unitUid?: string; targets?: Array<{ at: string; uid: string; color: string; delta: number; hostile: boolean }> };
  battlefieldActions?: number; extraUnit?: { uid: string; color: string };
}
/** Existing wire markers discriminate resolved effects without changing saved data. */
export type HistoryEffect = EffectFields & (
  | { hp: number }
  | { unit: PieceData }
  | { promotion: PieceData }
  | { status: NonNullable<EffectFields['status']> }
  | { control: PieceData }
  | { unitCast: NonNullable<EffectFields['unitCast']> }
  | { abilityCast: NonNullable<EffectFields['abilityCast']> }
  | { battlefieldActions: number }
  | { extraUnit: NonNullable<EffectFields['extraUnit']> }
);

/** Common optional fields allow readers to inspect a marker before narrowing a variant. */
interface HistoryFields extends EffectFields {
  turn: number; from?: string; to?: string; unit_id?: string; captured?: string | null;
  attacked?: boolean; damage_dealt?: number; leech_heal?: number; defender_eliminated?: boolean;
  moved?: boolean; defender_hp?: number; countered?: boolean; counterActor?: PieceIdentity;
  counter_damage?: number; second_counter_damage?: number; secondStrike?: boolean; secondCounter?: boolean; attackFrom?: string; attackedHex?: string;
  healedHex?: string; healed_amount?: number; healed_hp?: number; healed_unit?: string;
  attacker_eliminated?: boolean; entered?: boolean; withdrawn?: boolean; panelMove?: boolean;
  panelEffect?: boolean; intoPanel?: boolean; defenderHp?: number; attackerHp?: number; abilityDeath?: PieceData & { key?: string }; refund?: number; refundColor?: string;
  price?: number; cost?: number; steps?: number; continuedAction?: boolean; veterancyReset?: boolean;
  abilityChoice?: { type: string; id: string }; halftimeUp?: { phase: number; white: number; black: number };
  promotionHeal?: boolean; regenerationHeal?: boolean;
}
export type BattlefieldMoveRecord = HistoryFields & {
  from: string; to: string; unit_id: string; color: string; captured: string | null;
  attacked: boolean; damage_dealt: number; defender_eliminated: boolean; moved: boolean;
};
export type MoveRecord = BattlefieldMoveRecord | (HistoryFields & (
  | HistoryEffect
  | { abilityChoice: NonNullable<HistoryFields['abilityChoice']> }
  | { abilityDeath: NonNullable<HistoryFields['abilityDeath']> }
  | { panelEffect: true }
  | { halftimeUp: NonNullable<HistoryFields['halftimeUp']> }
  | { promotionHeal: true }
  | { regenerationHeal: true }
));
