import type { HistoryEffect } from './game-history';
import { GameCommand } from './game-command';
import type { BoardState, PieceData, PieceIdentity } from './game-state.service';
import type { UnitBuff, UnitCooldown } from './ability-rules';
import type { CombatBonuses } from './unit-combat';
import type { AnimStep, FallenUnit } from '../components/game-board/game-board.component';

export type StagedEffect = HistoryEffect;
export interface StagedAction {
  board: BoardState;
  /** Where the unit stood at the start of the turn. */
  from: string;
  to: string;
  /** Steps walked so far this turn. */
  used: number;
  /** Hex it struck, or null for a plain step. */
  attack: string | null;
  /** Friendly battlefield hex healed instead of attacking. No ability spend. */
  heal?: string;
  priorBuffs?: Record<string, UnitBuff>;
  combatBonuses?: CombatBonuses;
  moveBonus?: number;
  pathMov?: number;
  effects?: StagedEffect[];
  extraDeaths?: FallenUnit[];
  endsAction?: boolean;
  sourcePanel?: string;
  secondStrike?: boolean;
  secondCounter?: boolean;
  actor?: PieceIdentity;
  counterActor?: PieceIdentity;
  refundColor?: string;
  unitUid?: string;
  attackFrom?: string;
  afterAttackWalk?: boolean;
  /** When it was staged, so Undo can tell it from a panel walk. */
  at?: number;
  /** What walking home into the base paid back, for Undo to take away again. */
  refund?: number;
  killed?: string;
  /** What died there, so the board can draw its ghost under the skull. */
  killedUnit?: { unit_id: string; color: 'white' | 'black' };
  /** Simultaneous damage marks for an attack with splash. */
  impactTargets?: AnimStep[];
  spend?: AbilitySpend;
  /** Panel participant retained for commit, recap and Undo outside battlefield snapshots. */
  panelUnit?: PieceData;
  panelUnitHp?: number;
  /** Which panel it landed in - a base mends its wounded, a reserve does not. */
  panelName?: string;
  /** Whether the defender answered. A base never does, nor does anything out of reach. */
  countered?: boolean;
  /** Legacy staged board HP result; UID follows recipients that move after the cast. */
  hexHp?: number;
  hexKey?: string;
  /** Who it was, so the engine can find it if the walk has moved it since. */
  hexUid?: string;
  /** What to write over the unit as the cast plays: `+20`, `-14`. */
  mark?: string;
  /** The panel end was the defender, not the attacker. */
  intoPanel?: boolean;
  /** Whether that panel unit strikes back - a reserve does, a base does not. */
  counters?: boolean;
}

/**
 * Everything a cast took, and what the unit held before it. Data rather than
 * a closure because the staged stack is persisted as JSON.
 */
export interface AbilitySpend {
  side: 'mine' | 'opponent';
  /** Which cooldown row was armed - the unit's own, or a side's. */
  row: 'mine' | 'opponent' | 'unit';
  index: number;
  cost: number;
  /** The hex it landed on, or '' for a universal ability that named none. */
  hex?: string;
  /** Points the cast handed back, to take away again on Undo. */
  gain?: number;
  upGain?: number;
  uid: string;
  targetUid?: string;
  extraUid?: string;
  priorCooldown: number;
  priorPairCooldowns?: Array<{ index: number; turns: number }>;
  /** For a unit's own ability: its cooldown before the cast, or null for none. */
  priorUnitCooldown?: UnitCooldown | null;
  /** Whose `uses` the cast counted against - a side, or a unit's uid. */
  holder?: string;
  priorUses?: number;
  useKey?: string;
  /** Read from stacks saved before `uses`; nothing writes it now. */
  priorUltimate?: boolean;
  priorBuff: UnitBuff | null;
  priorUsed: boolean;
  up?: boolean;
  /** Recipient animations retained for staging, recap and reload. */
  visuals?: AnimStep[];
  /** The recipients captured by a universal debuff, for atomic Undo and reload. */
  targets?: Array<{ uid: string; priorBuff: UnitBuff | null; priorUsed: boolean }>;
}

export type LocalPanelStep =
  | { type: 'panel_move'; from: string; to: string; unit?: PieceData; panel?: string; cost: number; price: number }
  | { type: 'enter_board'; from: string; to: string; unit: PieceData };
export interface TimedCommand { at: number; command: GameCommand; }
type ActionEvent = { kind: 'action'; at: number; action: StagedAction };
type PanelEvent = { kind: 'panel'; at: number; command: GameCommand; local?: LocalPanelStep };
export type StagedTurnEvent = ActionEvent | PanelEvent | { kind: 'choice'; at: number; command: GameCommand };
export type LocalTurnCommand = GameCommand & {
  effectsBefore?: StagedEffect[]; effectsAfterAttack?: StagedEffect[]; effects?: StagedEffect[];
  unit?: PieceData; panel?: string; cost?: number; price?: number; moveBonus?: number;
  pathMov?: number; bonuses?: CombatBonuses; counters?: boolean; unitAction?: boolean; afterAttackTo?: string;
};

/** Equal timestamps retain the existing choice/panel/action order, including old saves. */
export function stagedTurnEvents(actions: readonly StagedAction[], panels: readonly LocalPanelStep[],
  timedPanels: readonly TimedCommand[], choices: readonly TimedCommand[]): StagedTurnEvent[] {
  const events: StagedTurnEvent[] = choices.map(event => ({ ...event, kind: 'choice' }));
  for (let i = 0; i < Math.max(panels.length, timedPanels.length); i++) {
    const local = panels[i], timed = timedPanels[i];
    const command = timed?.command ?? { type: local.type, from: local.from, to: local.to };
    events.push({ kind: 'panel', at: timed?.at ?? 0, command, local });
  }
  events.push(...actions.map(action => ({ kind: 'action' as const, at: action.at ?? 0, action })));
  return events.sort((a, b) => a.at - b.at);
}

export function actionUid(step: StagedAction, initialBoard: BoardState): string | undefined {
  return step.unitUid ?? initialBoard?.[step.from]?.uid ?? step.board?.[step.to]?.uid;
}

/** Collapse only consecutive continuations of the same unit; retain the original steps for Undo. */
export function boardActions(actions: readonly StagedAction[]): StagedAction[] {
  const out: StagedAction[] = [];
  for (const step of actions) {
    if ((step.spend && !step.endsAction) || !step.from) continue;
    if (out.at(-1)?.from === step.from) out[out.length - 1] = step;
    else out.push(step);
  }
  return out;
}

interface UnitActionRecord {
  turn: number; color?: string; from?: string; to?: string; uid?: string; unit?: PieceData;
  unitCast?: { uid: string; at?: string; color?: string }; entered?: boolean; panelMove?: boolean;
  battlefieldActions?: number; extraUnit?: { uid: string; color: string }; control?: PieceData;
}

/** Project only unit actions for movement budgets; picks and pool/CP casts do not switch actors. */
export function stagedActionRecords(events: readonly StagedTurnEvent[], ply: number, color: string, initialBoard: BoardState) {
  return events.flatMap<UnitActionRecord>(event => {
    if (event.kind === 'choice') return [];
    if (event.kind === 'panel') {
      const step = event.local;
      return step ? [{ ...step, turn: ply, color: step.unit?.color ?? color,
        entered: step.type === 'enter_board', panelMove: step.type === 'panel_move' }] : [];
    }
    const step = event.action;
    return [
      ...(step.spend?.row === 'unit' ? [{ turn: ply, color, unitCast: { uid: step.spend.uid, at: step.spend.hex } }]
        : !step.spend && step.from ? [{ turn: ply, color, from: step.from, uid: actionUid(step, initialBoard) }] : []),
      ...(step.effects ?? []).filter(effect => effect.battlefieldActions || effect.extraUnit || effect.control)
        .map(effect => ({ turn: ply, ...effect })),
    ];
  });
}

export function onlineTurnCommands(events: readonly StagedTurnEvent[], initialBoard: BoardState,
  abilities: ReadonlyArray<{ id: string; target: string }>): GameCommand[] {
  const commands: GameCommand[] = [];
  let before = initialBoard;
  for (const event of events) {
    if (event.kind !== 'action') { commands.push(event.command); continue; }
    const step = event.action;
    const spend = step.spend;
    if (spend) {
      const effect = abilities[spend.index];
      const command: Extract<GameCommand, { type: 'cast_ability' }> = { type: 'cast_ability', id: effect.id };
      if (spend.row === 'unit') {
        command.unitUid = spend.uid;
        const control = step.effects?.find(e => e.control)?.control;
        if (control) command.targetUid = control.uid;
        if (spend.targetUid) command.targetUid = spend.targetUid;
        if (spend.extraUid) command.extraUid = spend.extraUid;
      } else if (effect.target === 'hex') command.hex = spend.hex;
      else if (effect.target === 'pair') command.pairId = abilities[spend.priorPairCooldowns![0].index].id;
      else if (['friendly', 'enemy'].includes(effect.target)) command.targetUid = spend.uid;
      commands.push(command);
    } else {
      const uid = actionUid(step, initialBoard);
      const from = Object.keys(before).find(key => before[key].uid === uid) ?? step.from;
      const attack = step.afterAttackWalk ? undefined : step.attack ?? undefined;
      const command: GameCommand = step.intoPanel && attack
        ? { type: 'panel_attack', from, to: step.to, attack, more: true }
        : { type: 'make_move', from, to: step.to, ...(attack ? { attack } : {}),
          ...(step.heal ? { heal: step.heal } : {}), ...(step.refund !== undefined ? { withdraw: true } : {}), more: true };
      commands.push(command);
    }
    before = step.board;
  }
  return [...commands, { type: 'pass_turn' }];
}

interface SoloContext {
  moveBonusFor(key: string): number;
  pathMoveFor(key: string): number;
  bonusFor(key: string, stat: 'atk' | 'def', unit?: PieceData, inBase?: boolean, counter?: boolean): number;
  offBoard(key: string): boolean;
}
export function soloTurnCommands(events: readonly StagedTurnEvent[], context: SoloContext): LocalTurnCommand[] {
  const commands: Array<{ command: LocalTurnCommand; at: number }> = [];
  const actions = events.filter((event): event is ActionEvent => event.kind === 'action').map(event => event.action);
  const panels = events.filter((event): event is PanelEvent => event.kind === 'panel');
  const moves = boardActions(actions);
  const panelRewards = new Set<StagedEffect>();
  // Resolve an earlier UP grant before a panel crossing's affordability check.
  // Panel and battlefield commands retain their chronological order.
  for (const { local: step, at } of panels) {
    if (!step) continue;
    const rewards = actions.filter(action => (action.at ?? 0) <= at
      && !moves.some(move => (move.at ?? 0) >= (action.at ?? 0) && (move.at ?? 0) < at))
      .flatMap(action => action.effects ?? []).filter(effect => effect.abilityCast?.up && !panelRewards.has(effect));
    for (const reward of rewards) panelRewards.add(reward);
    commands.push({ command: { ...step, ...(rewards.length ? { effectsBefore: rewards } : {}) }, at });
  }
  // Attach each resolved cast to its causal move. A cast between an attack
  // and Withdraw must land before the remaining walk; identify moving recipients by UID.
  const ends = moves.map(step => actions.indexOf(step));
  const attacks = moves.map(step => step.afterAttackWalk
    ? actions.findIndex(action => action.from === step.from && action.attack && !action.afterAttackWalk)
    : -1);
  const before: StagedEffect[][] = moves.map(() => []);
  const afterAttack: StagedEffect[][] = moves.map(() => []);
  const after: StagedEffect[] = [];
  actions.forEach((step, i) => {
    const owner = ends.findIndex(end => step.endsAction ? end >= i : end > i);
    const list = owner < 0 ? after : attacks[owner] >= 0 && i > attacks[owner]
      ? afterAttack[owner] : before[owner];
    const effects = step.effects?.filter(effect => !panelRewards.has(effect));
    if (effects?.length && !step.afterAttackWalk) {
      const attackIndex = moves.findIndex(move => move.from === step.from && move.attack === step.attack);
      if (step.attack && attackIndex >= 0) {
        const next = attackIndex + 1;
        (attacks[attackIndex] >= 0 ? afterAttack[attackIndex]
          : next < moves.length ? before[next] : after).push(...effects);
      } else list.push(...effects);
    }
    if (step.attack !== null) return;
    const effect = step.panelUnit
      ? { unit: step.panelUnit, hp: step.panelUnitHp, panel: step.panelName }
      // The uid as well as the hex: a unit can be walked after the cast
      // lands on it, so the hex named here is where the client has it, not
      // where the engine does. The uid is what survives that.
      : step.hexKey && step.hexHp !== undefined && step.mark
        ? { at: step.hexKey, uid: step.hexUid, hp: step.hexHp }
        : null;
    if (!effect) return;
    list.push(effect);
  });
  if (!moves.length) {
    // Doing nothing is a legal turn - and every cast came before it.
    commands.push({ command: { type: 'pass_turn', ...(after.length ? { effectsBefore: after } : {}) }, at: Infinity });
    return commands.sort((a, b) => a.at - b.at).map(event => event.command);
  }
  // Held moves preserve independent panel actions; the final pass hands over the turn.
  moves.forEach((step, i) => {
    const swing = step.attack ?? undefined;
    // Solo re-checks the staged walk using its recorded movement modifiers.
    const moveBonus = step.moveBonus ?? context.moveBonusFor(step.to);
    const pathMov = step.pathMov ?? context.pathMoveFor(step.to);
    // Online commands carry ability IDs; the server derives combat modifiers
    // from its own state instead of trusting these solo values.
    const bonuses = step.combatBonuses ?? {
      atk: context.bonusFor(step.to, 'atk'),
      def: context.bonusFor(step.to, 'def'),
      targetAtk: swing ? context.bonusFor(swing, 'atk', step.panelUnit, false, true) : 0,
      targetDef: swing ? context.bonusFor(swing, 'def', step.panelUnit) : 0,
    };
    const boosted = !!(swing || step.heal) && Object.entries(bonuses).some(([key, value]) => key.endsWith('Set') || value !== 0);
    const casts = {
      ...(step.attackFrom && step.attackFrom !== step.to ? { afterAttackTo: step.to } : {}),
      more: true,
      ...(before[i].length ? { effectsBefore: before[i] } : {}),
      ...(afterAttack[i].length ? { effectsAfterAttack: afterAttack[i] } : {}),
      ...(i === moves.length - 1 && after.length ? { effects: after } : {}),
    };
    if (swing && step.panelUnit) {
      // A panel exchange carries the preceding walk and the defender's resolved context.
      commands.push({
        at: step.at ?? 0, command: {
          type: 'panel_attack',
          from: step.from, to: step.attackFrom ?? step.to, attack: swing, unit: step.panelUnit,
          // Which panel took the blow. The engine keeps it on the record and
          // nothing else: it is what tells the mending a base from a reserve
          // after a reload, when the board that knew is long gone.
          panel: step.panelName,
          ...(moveBonus ? { moveBonus } : {}),
          ...(pathMov ? { pathMov } : {}),
          // The same bonuses `make_move` carries, for the same reason: the
          // engine re-resolves the blow and would otherwise disagree with the
          // preview the room already drew. `targetDef`/`targetAtk` are the
          // panel unit's, which stands on `attack`.
          bonuses,
          // Whether the panel answers is the panel's rule, and the client owns
          // panels - the browser engine has no idea which one a unit is in.
          counters: step.counters !== false,
          ...casts,
        }
      });
      return;
    }
    commands.push({
      at: step.at ?? 0, command: {
        type: 'make_move',
        from: step.from,
        to: step.attackFrom ?? step.to,
        ...(swing ? { attack: swing } : {}),
        ...(step.heal ? { heal: step.heal } : {}),
        ...(step.endsAction ? { unitAction: true } : {}),
        ...(moveBonus ? { moveBonus } : {}),
        ...(pathMov ? { pathMov } : {}),
        ...(boosted ? { bonuses } : {}),
        // Walking off the board into a base. Both engines answer it: the
        // browser one takes the walk on trust, and the server re-derives it -
        // the real doorways, the MOV to reach them - from its own panel model.
        ...(context.offBoard(step.to) ? { withdraw: true } : {}),
        ...casts,
      }
    });
  });
  commands.push({ at: Infinity, command: { type: 'pass_turn' } });
  return commands.sort((a, b) => a.at - b.at).map(event => event.command);
}
