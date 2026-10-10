/** Schedule and stage permissions resolved from each match's configuration. */
import { sectionOf } from './game-rules';
export interface Phase { name: string; turns: number; points: number; grant: number; multiplier: number;
  halftime?: boolean; postmatch?: boolean; halftimeAfter?: number; postmatchTurns?: number; cpAward?: number; pointsBeforeHalftime?: number; postmatchPointsPerTurn?: number; }
export interface OvertimeStage { name: string; turns: number; toll: number; moves: number; categoryMoves: Record<string, number>; }
export interface Milestone { turn: number; next: string; }
export const PLIES_PER_TURN = 2;
export const turnOf = (ply: number): number => Math.ceil(ply / PLIES_PER_TURN);
export const sideOfPly = (ply: number): 'white' | 'black' => ply % 2 ? 'white' : 'black';
export function handOversBy(color: 'white' | 'black', ply: number): number {
  const played = Math.max(0, ply);
  return color === 'white' ? Math.ceil(played / 2) : Math.floor(played / 2);
}
export function phasesOf(config?: any): Phase[] {
  const match = sectionOf(config, 'match'), opening = match.opening;
  return [{ ...opening, points: opening.pointsPerTurn, multiplier: 1, halftime: false, postmatch: false, postmatchTurns: 0 },
    ...match.phases.map((p: any) => ({ ...p, points: p.pointsPerTurn, multiplier: p.vpMultiplier, halftime: p.halftimeAfter > 0, postmatch: p.postmatchTurns > 0 })),
    { ...match.overtime, turns: Infinity, points: match.overtime.pointsPerTurn, grant: 0, multiplier: 1, halftime: false, postmatch: false, postmatchTurns: 0 }];
}
export const scoringPhases = (config?: any): number[] => sectionOf(config, 'match').phases.map((_: any, i: number) => i + 1);
export function overtimeStages(config?: any): OvertimeStage[] {
  return sectionOf(config, 'match').overtime.stages.map((s: any) => ({ ...s, toll: s.kingToll, moves: s.moves.battlefield, categoryMoves: s.moves }));
}
const phaseSpan = (phase: Phase): number => phase.turns + (phase.postmatchTurns ?? Number(!!phase.postmatch));
export function phaseIndexAt(ply: number, config?: any): number {
  const turn = turnOf(ply), phases = phasesOf(config); let end = 0;
  for (let i = 0; i < phases.length - 1; i++) { end += phaseSpan(phases[i]); if (turn <= end) return i; }
  return phases.length - 1;
}
export const phaseAt = (ply: number, config?: any): Phase => phasesOf(config)[phaseIndexAt(ply, config)];
export const phaseStartTurn = (index: number, config?: any): number => 1 + phasesOf(config).slice(0, index).reduce((sum, p) => sum + phaseSpan(p), 0);
export const overtimeFirstPly = (config?: any): number => (phaseStartTurn(phasesOf(config).length - 1, config) - 1) * 2 + 1;
export const overtimeLastTurn = (config?: any): number => turnOf(overtimeFirstPly(config)) + overtimeStages(config).reduce((sum, s) => sum + s.turns, 0) - 1;
export const isInitialization = (ply: number, config?: any): boolean => phaseIndexAt(ply, config) === 0;
export const isScoringPhase = (ply: number, config?: any): boolean => scoringPhases(config).includes(phaseIndexAt(ply, config));
export const isOvertime = (ply: number, config?: any): boolean => phaseIndexAt(ply, config) === phasesOf(config).length - 1;
export function isPostmatch(ply: number, config?: any): boolean {
  const index = phaseIndexAt(ply, config), phase = phasesOf(config)[index];
  return !!phase.postmatch && turnOf(ply) >= phaseStartTurn(index, config) + phase.turns;
}
export const isSetupTurn = (ply: number, config?: any): boolean => isInitialization(ply, config) || isPostmatch(ply, config);
export function beforeHalftime(ply: number, config?: any): boolean {
  const index = phaseIndexAt(ply, config), phase = phasesOf(config)[index];
  return !phase.halftime || turnOf(ply) < phaseStartTurn(index, config) + phase.halftimeAfter!;
}
export function stageKey(ply: number, config?: any): string {
  if (isInitialization(ply, config)) return 'opening';
  if (isPostmatch(ply, config)) return 'postmatch';
  if (isOvertime(ply, config)) return 'overtime';
  return beforeHalftime(ply, config) ? 'firstHalf' : 'secondHalf';
}
export const stageRules = (ply: number, config?: any): any => sectionOf(config, 'stageRules')[stageKey(ply, config)];
export const isWrapOpen = (ply: number, config?: any): boolean => stageRules(ply, config).wrap;
export const isEntryOpen = (ply: number, config?: any): boolean => stageRules(ply, config).reserveEntry;
export const isHomecomingOpen = (ply: number, config?: any): boolean => stageRules(ply, config).homecoming;
export const attacksAllowed = (ply: number, config?: any): boolean => stageRules(ply, config).attack;
export function noAttackMessage(ply: number, config?: any): string {
  if (attacksAllowed(ply, config)) return '';
  if (isPostmatch(ply, config)) return 'Nobody attacks in the postmatch';
  if (isInitialization(ply, config)) return 'Nobody attacks in the opening';
  return 'Attacks are disabled in this stage';
}
export function overtimeStageAt(ply: number, config?: any): OvertimeStage | null {
  if (!isOvertime(ply, config)) return null;
  const stages = overtimeStages(config); let end = turnOf(overtimeFirstPly(config)) - 1;
  for (const stage of stages) { end += stage.turns; if (turnOf(ply) <= end) return stage; }
  return stages[stages.length - 1];
}
export function movesPerTurn(ply: number, zone = 'battlefield', config?: any): number {
  if (isOvertime(ply, config)) return overtimeStageAt(ply, config)!.categoryMoves[zone];
  const moves = stageRules(ply, config).moves[zone];
  return Array.isArray(moves) ? moves[Math.max(0, turnOf(ply) - 1)] : moves;
}
export const boardMovesPerTurn = (ply: number, config?: any): number => movesPerTurn(ply, 'battlefield', config);
export const overtimeTollAt = (ply: number, config?: any): number => overtimeStageAt(ply, config)?.toll ?? 0;
export function overtimeTollOver(ply: number, turns: number, config?: any): number {
  let sum = 0; for (let i = 0; i < turns; i++) sum += overtimeTollAt(ply + i * 2, config); return sum;
}
export function turnPointsBy(color: 'white' | 'black', ply: number, config?: any): number {
  const played = Math.max(0, ply), phases = phasesOf(config);
  const rates: Array<{from: number; rate: number}> = [];
  let points = 0;
  phases.forEach((phase, index) => {
    const first = phaseStartTurn(index, config), start = (first - 1) * PLIES_PER_TURN + 1;
    if (handOversBy(color, played) > handOversBy(color, start - 1)) points += phase.grant;
    rates.push({from: start, rate: phase.halftime ? phase.pointsBeforeHalftime! : phase.points});
    if (phase.halftime) rates.push({from: (first + phase.halftimeAfter! - 1) * PLIES_PER_TURN + 1, rate: phase.points});
    if (phase.postmatch) rates.push({from: (first + phase.turns - 1) * PLIES_PER_TURN + 1, rate: phase.postmatchPointsPerTurn!});
  });
  rates.forEach((rate, index) => {
    if (played < rate.from) return;
    const end = index + 1 < rates.length ? Math.min(played, rates[index + 1].from - 1) : played;
    points += (handOversBy(color, end) - handOversBy(color, rate.from - 1)) * rate.rate;
  });
  return points;
}

export function milestones(config?: any): Milestone[] {
  const out: Milestone[] = [], phases = phasesOf(config); let end = 0;
  phases.slice(0, -1).forEach((phase, index) => {
    if (phase.halftime) out.push({ turn: end + phase.halftimeAfter!, next: `${phase.name} Halftime` });
    end += phase.turns;
    if (phase.postmatch) { out.push({ turn: end, next: `${phase.name} Postmatch` }); end += phase.postmatchTurns!; }
    const next = phases[index + 1]; if (Number.isFinite(next.turns)) out.push({ turn: end, next: next.name });
  });
  for (const stage of overtimeStages(config)) { out.push({ turn: end, next: stage.name }); end += stage.turns; }
  return out;
}
export function stageAt(ply: number, config?: any): string {
  const phase = phaseAt(ply, config);
  if (isPostmatch(ply, config)) return `${phase.name} Postmatch`;
  if (isOvertime(ply, config)) return overtimeStageAt(ply, config)!.name;
  return phase.halftime && !beforeHalftime(ply, config) ? `${phase.name} Halftime` : phase.name;
}
export function turnHeading(ply: number, config?: any): string {
  const turn = turnOf(ply), changes = milestones(config), last = changes[changes.length - 1];
  const next = changes.find(m => m.turn > turn) ?? (last.turn >= turn ? last : null);
  return next ? `Turn ${turn} - ${next.turn - turn} Until ${next.next}` : `Turn ${turn} - ${stageAt(ply, config)}`;
}
/** Default views for callers inspecting the shipped schedule. Match logic passes its own config. */
export const PHASES = phasesOf();
export const SCORING_PHASES = scoringPhases();
export const OVERTIME_STAGES = overtimeStages();
export const OVERTIME_FIRST_PLY = overtimeFirstPly();
export const OVERTIME_FIRST_TURN = turnOf(OVERTIME_FIRST_PLY);
export const OVERTIME_LAST_TURN = overtimeLastTurn();
export const BOARD_MOVES_PER_TURN = boardMovesPerTurn(sectionOf(undefined, 'match').opening.turns * 2 + 1);
export const MILESTONES = milestones();
