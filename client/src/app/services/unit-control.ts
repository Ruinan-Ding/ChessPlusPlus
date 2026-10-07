import type { PieceData } from './game-state.service';

export function controlsAt(history: readonly any[], ply: number): Record<string, PieceData> {
  const controls: Record<string, PieceData> = {};
  for (const record of history ?? []) {
    if (record.control?.uid && record.control.controlledUntil > ply) controls[record.control.uid] = record.control;
    else if (record.control?.uid) delete controls[record.control.uid];
  }
  return controls;
}

export function controlledUnit<T extends PieceData>(unit: T, controls: Record<string, PieceData>, ply: number): T {
  const control = unit.uid ? controls[unit.uid] : undefined;
  if (control && (control.controlledUntil ?? 0) > ply) return { ...unit,
    owner: control.owner, color: control.color, controlledUntil: control.controlledUntil, controlTurn: control.controlTurn };
  if (unit.owner) {
    const { controlledUntil, controlTurn, ...owned } = unit;
    return { ...owned, color: unit.owner } as T;
  }
  return unit;
}
