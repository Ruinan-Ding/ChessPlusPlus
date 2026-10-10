/**
 * The match's score, and how the schedule ends it. Mirrors
 * server/game/engine/scoring.py and economy.py - keep the engines in step.
 *
 * Three numbered phases each bank a score: what the capture hexes a side holds
 * are worth as the phase's play ends (`ZONE_WORTH`: 3, 2 or 1 a hex, by zone),
 * less what its units were worth that died in the phase - never less than 0,
 * and times the phase's number (`phaseTotal`).
 * The three are summed, and the match ends in one of two ways the owner set
 * out:
 *
 * - **On points, once Phase 3's postmatch is played.** Phase 3 banks as its
 *   postmatch begins; a side more than the other's margin clear then takes
 *   it outright (`OVERTIME_MARGIN`) as the postmatch ends. Anything closer
 *   goes to overtime.
 * - **At the end of turn 50.** Overtime is a deathmatch until a king falls,
 *   and *"if both survives, black wins."*
 *
 * Both used to be read in the room's header and enforced nowhere, because the
 * score lived in the room: banked by whichever client happened to be watching
 * when a phase ended. The engines keep the bank now - the server on its state
 * row, the browser engine on its game - and hand it out with every hand-over,
 * so the room shows the engine's bank rather than keeping one of its own.
 */
import { ruleOf } from './config.service';
import { capStat, unitStats } from './unit-stats';
import { captureClaims, captureScore, captureZones, captureEligible } from './hex-rules';
import {
  OVERTIME_FIRST_PLY, OVERTIME_LAST_TURN, PHASES, SCORING_PHASES, handOversBy, isPostmatch,
  phaseIndexAt, phaseStartTurn, PLIES_PER_TURN, turnOf, turnPointsBy,
} from './phases';

export type Side = 'white' | 'black';

/**
 * What each scoring phase finished on, by its place in the schedule. Keys
 * arrive as strings off the wire ("1") and are read as numbers here - an
 * object's keys are strings either way, so `bank[1]` finds `"1"`.
 *
 * `late` marks a phase banked after its moment - see `bankEndedPhases`.
 */
export type PhaseBank = Record<number, { white: number; black: number; late?: boolean; pendingLoss?: Side }>;

/**
 * How far behind a side may finish the third phase and still force overtime,
 * keyed by the side behind. Black is allowed the wider gap because white
 * moves first. The owner's 9 Oct revision allows a White lead of 50 or a
 * Black lead of 25; larger leads settle on points after both postmatch turns.
 */
export const OVERTIME_MARGIN = { white: 25, black: 50 };

/** How a match the schedule ends was ended. Mirrors the server's reasons. */
export type ScheduleEndReason = 'points' | 'overtime' | 'phase_result';

/**
 * What a unit is worth, by its config `value`; 0 for no unit, or one the
 * config has no value for. The one reading of it - a kill's pay, a death's
 * cost and a walk home's refund all go through here - mirrored by
 * `unit_value` in scoring.py.
 */
export function unitValue(config: any, unitId: string | null | undefined): number {
  return (unitId ? Number(config?.units?.[unitId]?.value) : 0) || 0;
}

/**
 * What scoring phase `phase` scores: what the capture hexes held are worth
 * (`cap`, `captureScore`), less what its losses cost, **never below 0**, and
 * **times the phase's `multiplier`** - x1 in Phase 1, x2 in Phase 2, x3 in
 * Phase 3 (`PHASES`).
 *
 * *The owner, 24 Sep 2026: "the total points racked shouldnt go negative by
 * death. max is 0"*, so losses can wipe out what a side holds but cannot push
 * it under; and *"the total victory points for each phase is multiplied by 2
 * on phase 2, multipled by 3 on phase 3"*, so the later phases weigh more.
 * The floor comes first: 4 - 18 in Phase 3 is 0, not -42.
 *
 * The one place the sum is made, for the bank and the header's live figure
 * alike, so the two cannot disagree. Everything downstream - the match total,
 * the margins, the CP award - reads the multiplied figure.
 */
export function phaseTotal(cap: number, deaths: number, multiplier: number): number {
  return Math.max(0, cap - deaths) * multiplier;
}

/** What a side is holding on `board`, right now. */
export function capOf(board: Record<string, any> | null | undefined, radius: number, color: Side, config?: any): number {
  return captureScore(captureClaims(board ?? {}, radius, config), color, radius);
}

/**
 * What a side's losses have cost it: the `value` of every unit of its that
 * died, in `phase` alone when one is named. A loss counts against the phase
 * it happened in and no other, so summing the three never charges one twice.
 * The defender belongs to whoever was not moving; a counter-attack kills the
 * mover's own unit.
 *
 * Battlefield, reserve and base deaths count attrition VP; panel kills pay no UP bounty.
 */
export function deathsOf(config: any, history: readonly any[] | null | undefined, color: Side, phase?: number): number {
  let total = 0;
  for (const move of history ?? []) {
    if (phase !== undefined && phaseIndexAt(move.turn) !== phase) continue;
    if (move.abilityDeath?.color === color) total += unitValue(config, move.abilityDeath.unit_id);
    if (move.defender_eliminated && move.color !== color) total += unitValue(config, move.captured);
    if (move.attacker_eliminated && move.color === color) total += unitValue(config, move.unit_id);
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
    claims ??= captureClaims(board ?? {}, radius, config);
    out[phase] = {
      white: phaseTotal(captureScore(claims, 'white', radius), deathsOf(config, history, 'white', phase), PHASES[phase].multiplier),
      black: phaseTotal(captureScore(claims, 'black', radius), deathsOf(config, history, 'black', phase), PHASES[phase].multiplier),
      // Already over before this hand-over: its moment has passed.
      ...(phaseOver(phase, ply - 1) ? { late: true } : {}),
    };
    const entry = out[phase];
    if (!entry.late) {
      if (phase === 1 && !Object.entries(board ?? {}).some(([at, piece]) =>
          piece?.color === 'white' && (piece.hp === undefined || piece.hp > 0)
          && captureZones(radius).some(zone => zone.hexes.has(at) && captureEligible(piece, zone, config)))) entry.pendingLoss = 'white';
      if (phase === 2 && entry.black === 0) entry.pendingLoss = 'black';
    }
  }
  return out ?? bank ?? {};
}

/**
 * The CP `side` has been awarded so far: one award per phase banked, landing
 * as the phase's postmatch begins - which is when a phase banks, so the bank
 * is all this needs. CP comes from nothing else.
 *
 * Phase N pays N times the room's offset (10, 20, 30 by default), plus
 * both phase scores and the shortfall for the side behind. Starting CP
 * is separate. A late bank still awards; only that phase is compared.
 */
export function cpAwarded(bank: PhaseBank | null | undefined, side: Side, offset: number): number {
  const other: Side = side === 'white' ? 'black' : 'white';
  let total = 0;
  for (const phase of SCORING_PHASES) {
    const entry = bank?.[phase];
    if (!entry) continue;
    const mine = entry[side];
    const theirs = entry[other];
    total += phase * offset + mine + theirs + Math.max(0, theirs - mine);
  }
  return total;
}

/**
 * What `side`'s victory points are worth as points by `ply`: its whole banked
 * total, paid into its purse as its first overtime turn begins, and nothing
 * before. *The owner, 24 Sep 2026: "at the start of the overtime, all your
 * accumlated victory points turn into regular points."*
 *
 * Paid the way a turn's own point is - at the start of that side's turn, so
 * white on hand-over 73 and black on 74 - which is why it asks whether the
 * side has begun an overtime turn rather than whether the match is in
 * overtime. The bank is not emptied - it is the record of how the three
 * phases finished - but nothing reads it once overtime is under way: the
 * header hides the score for all of overtime (`showScore` in the room), so
 * on screen the victory points are gone and the points are what is left of
 * them. A match decided on points never reaches overtime, so never converts.
 */
export function vpAsPoints(bank: PhaseBank | null | undefined, side: Side, ply: number): number {
  const begun = handOversBy(side, ply) - handOversBy(side, OVERTIME_FIRST_PLY - 1);
  // A match decided on points ends ON the hand-over into overtime's first
  // ply, which is the one moment the arithmetic below would read as begun.
  if (begun <= 0 || decidedOnPoints(bank)) return 0;
  return SCORING_PHASES.reduce((sum, phase) => sum + (bank?.[phase]?.[side] ?? 0), 0);
}

/** Regular points from the starting balance, turn income, phase grants and overtime VP conversion. */
export function scheduledPoints(bank: PhaseBank | null | undefined, side: Side, ply: number, config?: any): number {
  return ruleOf(config, 'pointsAtStart') + turnPointsBy(side, ply) + vpAsPoints(bank, side, ply);
}

/** Refund the unit as it stood on withdrawal; later base healing does not change the transaction. */
export function withdrawalRefund(config: any, unit: any): number {
  const maxHp = capStat(unit.max_hp ?? unitStats(unit.unit_id, config, unit.vet).hp ?? unit.hp ?? 0);
  const missingHp = Math.max(0, maxHp - capStat(unit.hp ?? maxHp));
  return Math.max(1, unitValue(config, unit.unit_id) - 1 - missingHp);
}

/** UP is independent of ability points. All committed unit transactions live in history. */
export function unitPoints(config: any, history: readonly any[], side: Side): number {
  const other = side === 'white' ? 'black' : 'white';
  let points = ruleOf(config, 'upAtStart');
  for (const move of history ?? []) {
    if (!move) continue;
    if (move.halftimeUp) points += move.halftimeUp[side];
    if (move.unitCast?.color === side) points += (move.unitCast.gain ?? 0) - move.unitCast.cost;
    if (move.panelEffect || move.entered || move.abilityDeath) continue;
    if (move.panelMove) {
      if (move.unit?.color === side) points -= Math.trunc(Number(move.price) || 0);
      continue;
    }
    if (move.withdrawn && (move.refundColor ?? move.color) === side) points += move.refund ?? withdrawalRefund(config, { unit_id: move.unit_id, ...move.unit });
    if (!move.intoPanel) {
      if (move.defender_eliminated && move.color === side) points += unitValue(config, move.captured);
      if (move.attacker_eliminated && move.color === other) points += unitValue(config, move.unit_id);
    }
  }
  return points;
}

/** Persist the current phase VP once on the White hand-over into halftime. */
export function halftimeUpAwards(config: any, board: any, history: readonly any[], ply: number): any[] {
  const phase = SCORING_PHASES.find(index =>
    ply === (Math.ceil(phaseStartTurn(index) + PHASES[index].turns / 2) - 1) * PLIES_PER_TURN + 1);
  if (phase === undefined || history.some(move => move?.halftimeUp?.phase === phase)) return [];
  const radius = config?.board?.radius ?? 11;
  const claims = captureClaims(board, radius, config);
  const score = (side: Side) => phaseTotal(captureScore(claims, side, radius),
    deathsOf(config, history, side, phase), PHASES[phase].multiplier ?? 1);
  return [{ turn: ply, halftimeUp: { phase, white: score('white'), black: score('black') } }];
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
 * What the bank says of the match at `ply`, for the header: a pending early
 * loss, or after all three phases the points winner, else overtime -
 * and once turn 50 has been played out, black. The same answers
 * `scheduleEnding` ends the match on, so the header never names a result the
 * schedule will not reach. A resignation, a draw or a forfeit can still end it
 * first, even through Phase 3's postmatch once it is decided: the owner, 25 Sep
 * 2026 - *"you can draw/forfiet anytime"*.
 */
export function matchVerdict(bank: PhaseBank | null | undefined, ply: number): Side | 'overtime' | null {
  const pending = [1, 2].find(phase => bank?.[phase]?.pendingLoss && !bank[phase].late);
  if (pending !== undefined) return bank![pending].pendingLoss === 'white' ? 'black' : 'white';
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
 * - `phase_result`: a frozen Phase 1/2 loss, after both postmatch halves.
 * - `points`: all three phases are in, none of them late, and one side is
 *   past the other's margin - **once Phase 3's postmatch has been played**,
 *   on the hand-over into turn 37 (`OVERTIME_FIRST_PLY`). The result is
 *   known as the postmatch begins, and the header names it from there
 *   (`matchVerdict`), but the postmatch is still played: *the owner, 24 Sep
 *   2026: "phase 3 post match still happens even if overtime isnt
 *   triggered."* Its CP award lands with it.
 * - `overtime`: turn 50 has been played out - the hand-over is into turn 51 -
 *   with both kings standing. Black's.
 */
export function scheduleEnding(
  bank: PhaseBank | null | undefined, ply: number,
): { winner: Side; reason: ScheduleEndReason } | null {
  for (const phase of [1, 2]) {
    const loss = bank?.[phase]?.pendingLoss;
    if (loss && !bank![phase].late && ply >= (phaseStartTurn(phase + 1) - 1) * PLIES_PER_TURN + 1)
      return { winner: loss === 'white' ? 'black' : 'white', reason: 'phase_result' };
  }
  const points = ply >= OVERTIME_FIRST_PLY ? decidedOnPoints(bank) : null;
  if (points) return { winner: points, reason: 'points' };
  if (turnOf(ply) > OVERTIME_LAST_TURN) return { winner: 'black', reason: 'overtime' };
  return null;
}
