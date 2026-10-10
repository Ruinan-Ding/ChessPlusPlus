import { sectionOf } from './game-rules';
/**
 * What the move history says about who has already moved.
 *
 * The opening's lock and the panels' allowance are **derived, not tallied** -
 * the same choice the panels and the points made. The board keeps its own
 * running Sets (`lockedUnits`, `baseMovers`, `reserveMovers`) because it has
 * to draw a half-staged turn before anything is recorded; these are the same
 * answers read off the record, for the two places that have only the record:
 * the room after a reload, and the offline engine.
 *
 * Each one mirrors a server function, named in its own doc comment, and the
 * server's are the authority. Both sides of a networked game are checked
 * there; these keep a solo game honest about the same rules.
 */

import { ruleOf } from './config.service';
import { activeVet, kitActive, capStat, capUnit, rankedUnit, unitPassive } from './unit-stats';
import { controlledUnit, controlsAt } from './unit-control';
import { BASE_PANELS, isInsideBoard, panelOfHex } from './hex-rules';
import { phasesOf, PLIES_PER_TURN, scoringPhases, phaseStartTurn, boardMovesPerTurn, movesPerTurn, isInitialization, isPostmatch, isSetupTurn } from './phases';

/**
 * A move record, as loosely as the history actually holds one: what a record
 * carries depends on what kind of move it was, and these read whichever keys
 * that kind put there.
 */
type Move = any;

/**
 * "q, r" in whatever form a message used, back to the one the board keys on.
 *
 * **Exactly two integer fields, or nothing.** The server's `int()` raises on
 * anything else and the record is skipped; a looser parse here would disagree
 * with it on exactly the malformed keys it was written to survive - `Number('')`
 * is 0, so `','` would come back `'0,0'` and lock a hex on one side only.
 */
function normalizeKey(key: unknown): string | null {
  const parts = String(key ?? '').split(',');
  if (parts.length !== 2) return null;
  const [q, r] = parts.map(part => (part.trim() === '' ? NaN : Number(part)));
  return Number.isInteger(q) && Number.isInteger(r) ? `${q},${r}` : null;
}

/**
 * Where *color*'s battlefield units that have already moved in the opening
 * now stand. Mirrors `opening_moved_hexes` in server/game/engine/game_logic.py.
 *
 * Through the initialization a battlefield unit gets one move for the whole
 * phase, not one a turn. Keyed by the hex it moved to: nothing is captured in
 * the opening - nobody may attack - so a unit that has moved is still standing
 * where it landed, and a board move's record carries no uid to key on.
 *
 * Crossings, walks home and walks inside a panel are not battlefield moves and
 * are not counted. A unit sent home has left the board entirely.
 *
 */
export function openingMovedHexes(history: Move[] | undefined, color: string, config?: any): Set<string> {
  const out = new Set<string>();
  if (!sectionOf(config, 'stageRules').movedUnitsLockedInOpening) return out;
  for (const move of history ?? []) {
    if (!move || move.color !== color) continue;
    if (move.withdrawn || move.panelMove || move.panelEffect) continue;
    if (move.turn == null || !isInitialization(move.turn, config)) continue;
    const key = normalizeKey(move.to);
    if (key) out.add(key);
  }
  return out;
}

/**
 * Panel units that may not move again for the rest of the opening. Mirrors
 * `locked_units` in server/game/engine/panels.py.
 *
 * Through the initialization a panel unit gets one move for the whole phase,
 * so one that moved on an *earlier* turn of it stays out until the phase ends -
 * and only then. This turn's own walks are not a lock: a unit is walked a few
 * steps at a time, and each step is a record.
 */
export function lockedPanelUnits(history: Move[] | undefined, ply: number, config?: any): Set<string> {
  const out = new Set<string>();
  if (!sectionOf(config, 'stageRules').movedUnitsLockedInOpening || !isInitialization(ply, config)) return out;
  for (const move of history ?? []) {
    if (!move || !(move.panelMove || move.entered || move.withdrawn)) continue;
    const turn = move.turn;
    if (turn == null || turn >= ply || !isInitialization(turn, config)) continue;
    const uid = move.unit?.uid;
    if (uid) out.add(uid);
  }
  return out;
}

/**
 * The units of *color* walked this ply, split by the panel each walk began in.
 * Mirrors `panel_movers` in server/game/engine/panels.py.
 *
 * The wrap starts in the base, so it spends a base mover; a crossing starts in
 * the reserve and spends a reserve one. One set each, because the cap is a
 * per-panel allowance, and counting one panel's walks against the other would
 * spend it on units it was never about.
 */
export function panelMoversAt(
  history: Move[] | undefined, ply: number, color: string, panel?: string, orientation = 'edge-up',
): { base: Set<string>; reserve: Set<string> } {
  const movers = { base: new Set<string>(), reserve: new Set<string>() };
  for (const move of history ?? []) {
    if (!move || move.turn !== ply) continue;
    if (move.controlSource && move.sourcePanel && move.color === color) {
      movers[BASE_PANELS.has(move.sourcePanel) ? 'base' : 'reserve'].add(move.controlSource);
    }
    const unit = move.unit ?? {};
    if (!unit.uid || unit.color !== color) continue;
    const origin = (move.entered ? panelOfHex(move.from, orientation) : move.panel)
      || (color === 'white' ? (move.entered ? 'br' : 'bl') : (move.entered ? 'tl' : 'tr'));
    if (panel && origin !== panel) continue;
    if (move.entered) movers.reserve.add(unit.uid);
    else if (move.panelMove) {
      movers[BASE_PANELS.has(move.panel) ? 'base' : 'reserve'].add(unit.uid);
    }
  }
  return movers;
}

/** Stage-based category slots; only the most recent mover may continue until Undo. */
export function panelMoverAllowed(
  history: Move[] | undefined, ply: number, color: string, uid: string, panel?: string,
  config?: any,
): boolean {
  const base = BASE_PANELS.has(panel ?? '');
  const movers = panelMoversAt(history, ply, color, undefined, config?.board?.orientation)[base ? 'base' : 'reserve'];
  const last = (history ?? []).filter(move => move?.turn === ply && move.unit?.color === color
    && (move.entered || move.panelMove) && BASE_PANELS.has(move.entered ? '' : move.panel) === base).at(-1);
  if (movers.has(uid) && last?.unit?.uid !== uid) return false;
  const extra = new Set(Object.values(controlsAt(history ?? [], ply))
    .filter(unit => unit.color === color && unit.controlTurn === ply).map(unit => unit.uid));
  return movers.has(uid) || extra.has(uid) || [...movers].filter(id => !extra.has(id)).length < movesPerTurn(ply, base ? 'base' : 'reserve', config);
}

/** Cast and Sacrifice grant one action to their chosen unit, only on the casting ply. */
export function extraActionUids(history: Move[], ply: number, color: string): string[] {
  return [...new Set([
    ...Object.values(controlsAt(history, ply)).filter(unit => unit.color === color && unit.controlTurn === ply).map(unit => unit.uid!),
    ...history.filter(move => move.turn === ply && move.extraUnit?.color === color).map(move => move.extraUnit.uid),
  ])];
}

/** Distinct battlefield actors this ply, including walks home. */
export function boardMoveUids(history: Move[] | undefined, ply: number, color: string): Set<string> {
  const out = new Set<string>();
  for (const [i, move] of (history ?? []).entries()) {
    if (!move || move.turn !== ply || (move.color ?? move.unit?.color) !== color) continue;
    if (move.panelMove || move.entered) continue;
    if (['panelEffect', 'unitCast', 'abilityCast', 'abilityChoice', 'abilityDeath', 'control', 'extraUnit', 'extraAction', 'continuedAction'].some(key => move[key])) continue;
    out.add(move.uid || move.unit?.uid || move.from || `legacy:${i}`);
  }
  return out;
}

export function boardMovesAt(history: Move[] | undefined, ply: number, color: string): number {
  return boardMoveUids(history, ply, color).size;
}

/**
 * The hexes this side's board moves have already landed on this ply. Mirrors
 * `board_move_landings` in server/game/engine/game_logic.py.
 *
 * **What stops a unit taking two of the turn's moves.** The allowance counts
 * moves, and the owner's rule counts *units* - "you can move two units each
 * turn". Without this a side in Overtime 3 could move A, then B, then A
 * again: each message is legal on its own, judged from where the unit stands
 * with a full MOV, so both engines took it and the unit travelled twice its
 * budget in one turn.
 *
 * A unit continuing a walk it has already begun is not this: the room folds
 * those into one move and sends the origin it really set out from, so a `from`
 * that matches an earlier landing is always a unit coming back for a second
 * go.
 */
export function boardMoveLandings(
  history: Move[] | undefined, ply: number, color: string,config?: any
): Set<string> {
  const out = new Set<string>();
  for (const move of history ?? []) {
    if (!move || move.turn !== ply || move.color !== color) continue;
    if (move.panelMove || move.entered || move.panelEffect || ['unitCast', 'abilityCast', 'abilityChoice', 'abilityDeath', 'control', 'extraUnit', 'extraAction', 'continuedAction'].some(key => (move as any)[key])) continue;
    // A walk home lands off the board, so it leaves nothing to move again.
    if (move.withdrawn) continue;
    if (move.to) out.add(move.to);
  }
  return out;
}

/**
 * The units of *color* walked home this ply. Mirrors `homecomings_at` in
 * server/game/engine/panels.py.
 *
 * Keyed by uid, off the record's own copy of the unit as it left the board -
 * the only place a withdrawn unit survives. A set rather than a count because
 * a unit walks home in one record and could not be counted twice anyway; the
 * set makes that explicit rather than lucky.
 */
export function homecomingsAt(
  history: Move[] | undefined, ply: number, color: string,
): Set<string> {
  const out = new Set<string>();
  for (const move of history ?? []) {
    if (!move || move.turn !== ply || !move.withdrawn) continue;
    const unit = move.unit ?? {};
    if (unit.color !== color || !unit.uid) continue;
    out.add(unit.uid);
  }
  return out;
}

/**
 * Earned stars, reconstructed from the unit's recorded panel crossings.
 * Mirrors panels.unit_veterancy. Everyone starts at zero; both sides gain
 * together at Phase 1's start and each postmatch's start, capped at three.
 * Only battlefield/reserve occupancy at that boundary counts. A veteran
 * keeps its stars when it walks home, but earns none while in the base.
 * Strengthen promotions are recorded separately as the explicit CP exception.
 * Ordinary walks, damage and kills cannot change rank. Deriving from the
 * record also brings existing saved games up to date without a migration.
 */
export function unitVeterancy(
  uid: string, at: string, history: Move[] | undefined, ply: number,
  radius: number, orientation = 'edge-up',config?: any
): number {
  const crossings = (history ?? []).filter(move => move?.unit?.uid === uid
    && (move.entered || move.withdrawn || move.panelMove)
    && Number.isInteger(move.turn) && normalizeKey(move.from) && normalizeKey(move.to));
  const settings = sectionOf(config, 'veterancy');
  const boundaries = [...(settings.firstPhaseStartAward ? [phaseStartTurn(1, config)] : []),
    ...scoringPhases(config).filter(index => settings.postmatchAwards && phasesOf(config)[index].postmatch)
      .map(index => phaseStartTurn(index, config) + phasesOf(config)[index].turns)]
    .map(turn => (turn - 1) * PLIES_PER_TURN + 1);
  let where = normalizeKey(crossings[0]?.from ?? at);
  const promotions = (history ?? []).filter(move => move?.promotion?.uid === uid && Number.isInteger(move.turn)
    && Number.isInteger(move.promotion.vet)).sort((a, b) => a.turn - b.turn);
  let promoted = 0;
  let next = 0, vet = settings.startingRank;
  for (const boundary of boundaries) {
    if (boundary > ply) break;
    while (promoted < promotions.length && promotions[promoted].turn < boundary) {
      vet = Math.min(3, Math.max(vet, promotions[promoted++].promotion.vet));
    }
    // A deployment recorded in the new stage happens AFTER its award.
    while (next < crossings.length && crossings[next].turn < boundary) {
      where = normalizeKey(crossings[next++].to);
    }
    if (!where) continue;
    const [q, r] = where.split(',').map(Number);
    const zone = isInsideBoard(q, r, radius) ? 'battlefield' : BASE_PANELS.has(panelOfHex(where, orientation)) ? 'base' : 'reserve';
    if (settings.awardZones.includes(zone)) {
      vet = Math.min(3, vet + settings.award);
    }
  }
  while (promoted < promotions.length && promotions[promoted].turn <= ply) {
    vet = Math.min(3, Math.max(vet, promotions[promoted++].promotion.vet));
  }
  return vet;
}

/** Phase 3 postmatch heals units that had already reached vet 3, once. */
export function promotionHeals(config: any, board: Record<string, any>, history: Move[], ply: number): Move[] {
  const settings = sectionOf(config, 'veterancy');
  const phase = settings.fullHealPhase === 'last' ? scoringPhases(config).length : settings.fullHealPhase;
  if (!phase || !phasesOf(config)[phase].postmatch) return [];
  const boundary = (phaseStartTurn(phase, config) + phasesOf(config)[phase].turns - 1) * PLIES_PER_TURN + 1;
  if (ply !== boundary) return [];
  const radius = config?.board?.radius ?? 11;
  const orientation = config?.board?.orientation ?? 'edge-up';
  const veteran = (uid: string, at: string) =>
    unitVeterancy(uid, at, history, ply - 1, radius, orientation, config) >= settings.fullHealRank;
  return healVeterans(config, board, history, ply, (unit, at) => settings.awardZones.includes(isInsideBoard(...at.split(',').map(Number) as [number, number], radius) ? 'battlefield' : BASE_PANELS.has(unit.panel) ? 'base' : 'reserve') && veteran(unit.uid ?? `${unit.color[0]}${at}`, at), 'promotionHeal');
}

export function regenerationHeals(config: any, board: Record<string, any>, history: Move[], ply: number, color: string): Move[] {
  return healVeterans(config, board, history, ply, (unit, at) => {
    const [q, r] = at.split(',').map(Number);
    return unit.color === color
    && unitPassive(unit.unit_id, config, activeVet(unit, unit.panel, config))?.effect === 'regenerate';
  }, 'regenerationHeal');
}

function healVeterans(config: any, board: Record<string, any>, history: Move[], ply: number,
  eligible: (unit: any, at: string) => boolean, mark: string): Move[] {
  const radius = config?.board?.radius ?? 11;
  const orientation = config?.board?.orientation ?? 'edge-up';
  for (const [at, raw] of Object.entries(board)) {
    const unit = capUnit(raw); board[at] = unit;
    if (unit.hp > 0 && eligible(unit, at)) {
      board[at] = { ...unit, hp: capStat(unit.max_hp ?? config?.units?.[unit.unit_id]?.hp ?? unit.hp) };
    }
  }
  const panels = new Map<string, { at: string; unit: any; panel: string }>();
  for (const move of history) {
    const unit = move?.unit;
    if (move.control?.uid && move.at) {
      const [q, r] = move.at.split(',').map(Number);
      if (!isInsideBoard(q, r, radius)) panels.set(move.control.uid, {
        at: move.at, unit: move.control, panel: panelOfHex(move.at, orientation),
      });
    }
    if (!unit?.uid) continue;
    if (move.entered) {
      panels.delete(unit.uid);
    } else if (move.withdrawn || move.panelMove) {
      panels.set(unit.uid, { at: move.to, unit: { ...unit }, panel: panelOfHex(move.to, orientation) });
    }
    const defender = move.panelDefender ?? unit;
    if (move.intoPanel && Number.isFinite(move.defenderHp) && defender?.uid) {
      const held = panels.get(defender.uid);
      const at = held?.at || move.attackedHex || '';
      panels.set(defender.uid, {
        at, unit: { ...defender, hp: move.defenderHp },
        panel: held?.panel || move.panel || (at ? panelOfHex(at, orientation) : ''),
      });
    }
  }
  const heals: Move[] = [];
  for (const { at, unit: snapshot, panel } of panels.values()) {
    const unit = controlledUnit(rankedUnit({ ...snapshot, panel }, config,
      unitVeterancy(snapshot.uid, at || '0,0', history, ply, radius, orientation, config), kitActive({ ...snapshot, panel }, config)), controlsAt(history, ply), ply);
    const full = unit.max_hp ?? config?.units?.[unit.unit_id]?.hp ?? unit.hp;
    if (!panel || unit.hp <= 0 || unit.hp >= full
        || !eligible(unit, at || '0,0')) continue;
    heals.push({
      from: '', to: '', unit_id: unit.unit_id, color: unit.color, turn: ply,
      captured: null, attacked: false, damage_dealt: 0, moved: false,
      defender_eliminated: false, intoPanel: true, panelEffect: true,
      [mark]: true, unit, defenderHp: full, panel,
    });
  }
  return heals;
}
