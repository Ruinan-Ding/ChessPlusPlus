/**
 * The match's score, and how the schedule ends it. Mirrors
 * server/game/engine/scoring.py - keep the two in step.
 *
 * Three numbered phases each bank a score: the capture hexes a side holds as
 * the phase's play ends, less what its units were worth that died in the
 * phase. The three are summed, and the match ends in one of two ways the
 * owner set out:
 *
 * - **On points, when Phase 3 banks.** A side more than the other's margin
 *   clear takes it outright (`OVERTIME_MARGIN`). Anything closer goes to
 *   overtime.
 * - **At the end of turn 50.** Overtime is a deathmatch until a king falls,
 *   and *"if both survives, black wins."*
 *
 * Both used to be read in the room's header and enforced nowhere, because the
 * score lived in the room: banked by whichever client happened to be watching
 * when a phase ended. The engines keep the bank now - the server on its state
 * row, the browser engine on its game - and hand it out with every hand-over,
 * so the room shows the engine's bank rather than keeping one of its own.
 */
import { captureClaims, captureScore } from './hex-rules';
import {
  OVERTIME_LAST_TURN, SCORING_PHASES, isPostmatch, phaseIndexAt, turnOf,
} from './phases';

export type Side = 'white' | 'black';

/**
 * What each scoring phase finished on, by its place in the schedule. Keys
 * arrive as strings off the wire ("1") and are read as numbers here - an
 * object's keys are strings either way, so `bank[1]` finds `"1"`.
 *
 * `late` marks a phase banked after its moment - see `bankEndedPhases`.
 */
export type PhaseBank = Record<number, { white: number; black: number; late?: boolean }>;

/**
 * How far behind a side may finish the third phase and still force overtime.
 * Black is allowed the wider gap because white moves first: white has to be
 * more than 5 clear to take it outright, black only more than 3.
 */
export const OVERTIME_MARGIN = { white: 3, black: 5 };

/** How a match the schedule ends was ended. Mirrors the server's reasons. */
export type ScheduleEndReason = 'points' | 'overtime';

/** What a side is holding on `board`, right now. */
export function capOf(board: Record<string, any> | null | undefined, radius: number, color: Side): number {
  return captureScore(captureClaims(board ?? {}, radius), color);
}

/**
 * What a side's losses have cost it: the `value` of every unit of its that
 * died, in `phase` alone when one is named. A loss counts against the phase
 * it happened in and no other, so summing the three never charges one twice.
 * The defender belongs to whoever was not moving; a counter-attack kills the
 * mover's own unit.
 */
export function deathsOf(config: any, history: any[] | null | undefined, color: Side, phase?: number): number {
  const units = config?.units ?? {};
  const value = (unitId: string | null | undefined) =>
    (unitId ? units[unitId]?.value : 0) ?? 0;
  let total = 0;
  for (const move of history ?? []) {
    if (phase !== undefined && phaseIndexAt(move.turn) !== phase) continue;
    if (move.defender_eliminated && move.color !== color) total += value(move.captured);
    if (move.attacker_eliminated && move.color === color) total += value(move.unit_id);
  }
  return total;
}

/**
 * Whether a scoring phase is over by `ply`: once its postmatch begins, not
 * once the next phase does. The postmatch still counts as the phase's own
 * (`phaseIndexAt`), which is why this asks about it as well as the index.
 */
export function phaseOver(phase: number, ply: number): boolean {
  const now = phaseIndexAt(ply);
  return phase < now || (phase === now && isPostmatch(ply));
}

/**
 * `bank` with every scoring phase that is over by `ply` banked, the rest left
 * alone. Called on each hand-over with the ply it hands to and the board it
 * leaves: the hand-over into a phase's postmatch is the one moment the board
 * still shows how the phase's play finished, before the postmatch's crossings
 * and walks home reshape it. A phase already banked is never read again.
 *
 * **A phase banked after that moment is marked `late`.** It still banks - the
 * header shows it - but off a board that no longer shows how the phase
 * finished: a game saved before the engines kept the bank, or a position
 * built by hand. `decidedOnPoints` refuses to decide a match on a bank with a
 * late phase in it.
 *
 * Returns `bank` itself when nothing new banked, so a caller comparing
 * identities sees no change.
 */
export function bankEndedPhases(
  bank: PhaseBank | null | undefined, config: any, board: Record<string, any> | null | undefined,
  history: any[] | null | undefined, ply: number,
): PhaseBank {
  const radius: number = config?.board?.radius ?? 11;
  let out: PhaseBank | null = null;
  let claims: ReturnType<typeof captureClaims> | null = null;
  for (const phase of SCORING_PHASES) {
    if (bank?.[phase] || !phaseOver(phase, ply)) continue;
    out ??= { ...(bank ?? {}) };
    claims ??= captureClaims(board ?? {}, radius);
    out[phase] = {
      white: captureScore(claims, 'white') - deathsOf(config, history, 'white', phase),
      black: captureScore(claims, 'black') - deathsOf(config, history, 'black', phase),
      // Already over before this hand-over: its moment has passed.
      ...(phaseOver(phase, ply - 1) ? { late: true } : {}),
    };
  }
  return out ?? bank ?? {};
}

function allBanked(bank: PhaseBank | null | undefined): bank is PhaseBank {
  return !!bank && SCORING_PHASES.every(phase => !!bank[phase]);
}

/**
 * The side the three phases hand the match to outright, or `null` - while
 * any is unbanked, while the two are close enough for overtime, or while any
 * phase was banked late (see `bankEndedPhases`): a score read off the wrong
 * board decides nothing.
 */
export function decidedOnPoints(bank: PhaseBank | null | undefined): Side | null {
  if (!allBanked(bank) || SCORING_PHASES.some(phase => bank[phase].late)) return null;
  const total = (side: Side) => SCORING_PHASES.reduce((sum, phase) => sum + bank[phase][side], 0);
  const lead = total('white') - total('black');
  if (lead > OVERTIME_MARGIN.black) return 'white';
  if (-lead > OVERTIME_MARGIN.white) return 'black';
  return null;
}

/**
 * What the bank says of the match at `ply`, for the header: `null` until all
 * three phases are in, then the side that took it on points, else overtime -
 * and once turn 50 has been played out, black. The same answers
 * `scheduleEnding` ends the match on, so the header never names a result the
 * engine will not reach.
 */
export function matchVerdict(bank: PhaseBank | null | undefined, ply: number): Side | 'overtime' | null {
  if (!allBanked(bank)) return null;
  return decidedOnPoints(bank) ?? (turnOf(ply) > OVERTIME_LAST_TURN ? 'black' : 'overtime');
}

/**
 * The winner and the reason if the schedule ends the match at `ply` - the
 * hand-over just made - or `null`.
 *
 * Asked after the hand-over has banked what it closed, and only when nothing
 * on the board ended the match first: a king killed on the turn Phase 3
 * banks, or on turn 50, has already decided it.
 *
 * - `points`: all three phases are in, none of them late, and one side is
 *   past the other's margin. That is first true on the hand-over into
 *   Phase 3's postmatch, which is where a match ends on it.
 * - `overtime`: turn 50 has been played out - the hand-over is into turn 51 -
 *   with both kings standing. Black's.
 */
export function scheduleEnding(
  bank: PhaseBank | null | undefined, ply: number,
): { winner: Side; reason: ScheduleEndReason } | null {
  const points = decidedOnPoints(bank);
  if (points) return { winner: points, reason: 'points' };
  if (turnOf(ply) > OVERTIME_LAST_TURN) return { winner: 'black', reason: 'overtime' };
  return null;
}
