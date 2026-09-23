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

import { BASE_PANELS } from './hex-rules';
import {
  PHASE_INIT_ENTRIES, isInitialization, isPhaseInitialization, isSetupTurn,
} from './phases';

/**
 * How many units of one panel may be started in a turn. An allowance each:
 * three out of the base and three out of the reserve, all match.
 * ponytail: the owner's placeholder - "3 of these (for now)". A constant
 * because that is all it is; it moves to config when the real number lands.
 * Mirrors PANEL_MOVERS_PER_TURN in server/game/engine/panels.py.
 */
export const PANEL_MOVERS_PER_TURN = 3;

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
 * **The hex key rests on "nothing is captured in the opening", which is true
 * of the server and not quite of solo play**: a damage ability can empty a hex
 * during the opening, and a different unit that later moves onto it inherits
 * the lock. It wants a uid on a board move's record to fix properly, which is
 * a protocol change; on the shipped three-turn opening the window is one ply
 * wide. Written down rather than papered over - and one more thing that
 * settles when the abilities do.
 */
export function openingMovedHexes(history: Move[] | undefined, color: string): Set<string> {
  const out = new Set<string>();
  for (const move of history ?? []) {
    if (!move || move.color !== color) continue;
    if (move.entered || move.withdrawn || move.panelMove || move.panelEffect) continue;
    if (move.turn == null || !isInitialization(move.turn)) continue;
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
export function lockedPanelUnits(history: Move[] | undefined, ply: number): Set<string> {
  const out = new Set<string>();
  if (!isInitialization(ply)) return out;
  for (const move of history ?? []) {
    if (!move || !(move.panelMove || move.entered)) continue;
    const turn = move.turn;
    if (turn == null || turn >= ply || !isInitialization(turn)) continue;
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
  history: Move[] | undefined, ply: number, color: string,
): { base: Set<string>; reserve: Set<string> } {
  const movers = { base: new Set<string>(), reserve: new Set<string>() };
  for (const move of history ?? []) {
    if (!move || move.turn !== ply) continue;
    const unit = move.unit ?? {};
    if (!unit.uid || unit.color !== color) continue;
    if (move.entered) movers.reserve.add(unit.uid);
    else if (move.panelMove) {
      movers[BASE_PANELS.has(move.panel) ? 'base' : 'reserve'].add(unit.uid);
    }
  }
  return movers;
}

/**
 * Whether *uid* may be started out of `panel` this ply - it is already one of
 * the panel's movers, or the panel has an allowance left. Mirrors the mover
 * half of `panel_allowance`; the MOV half stays with the board, which is the
 * only place that knows what a one-turn boost lent the unit.
 *
 * **The reserve's allowance is five in a phase initialization**, and it stands
 * instead of the three rather than beside it. It covers walking inside the
 * reserve as well as crossing out of it, because they are the same allowance:
 * capping the walk at three would leave two of the five unable to reach a
 * gateway to spend their crossing on. The base keeps its three - nothing in
 * the rule was about the base, and the wrap is shut on that turn anyway.
 */
export function panelMoverAllowed(
  history: Move[] | undefined, ply: number, color: string, uid: string, panel?: string,
): boolean {
  const base = BASE_PANELS.has(panel ?? '');
  const movers = panelMoversAt(history, ply, color)[base ? 'base' : 'reserve'];
  const cap = !base && isPhaseInitialization(ply) ? PHASE_INIT_ENTRIES : PANEL_MOVERS_PER_TURN;
  return movers.has(uid) || movers.size < cap;
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
/**
 * How many board moves of `color` this ply already holds. Mirrors
 * `board_moves_at` in server/game/engine/game_logic.py.
 *
 * What it is for: overtime's later stretches allow a side two or three moves
 * on the main board, so "has this side moved yet" stopped being a yes/no and
 * became a count - and the count has to come off the record, because the
 * moves arrive as separate messages and only the last of them ends the turn.
 *
 * **A panel's move is not a board move.** A crossing (`entered`), a walk
 * inside a panel (`panelMove`) and a cast's damage (`panelEffect`) each have
 * an allowance of their own, and counting them here would spend the board's.
 *
 * **A walk home is one, except while setting out.** In overtime it *is* the
 * turn's board action - that is what the window there is for - so it counts
 * against this. On a setup turn three may go as deployments and none of them
 * is the turn's action, so none of them counts. Same split both engines make.
 */
export function boardMovesAt(
  history: Move[] | undefined, ply: number, color: string,
): number {
  const setup = isSetupTurn(ply);
  let moves = 0;
  for (const move of history ?? []) {
    if (!move || move.turn !== ply || move.color !== color) continue;
    if (move.panelMove || move.entered || move.panelEffect) continue;
    if (move.withdrawn && setup) continue;
    moves++;
  }
  return moves;
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
  history: Move[] | undefined, ply: number, color: string,
): Set<string> {
  const out = new Set<string>();
  for (const move of history ?? []) {
    if (!move || move.turn !== ply || move.color !== color) continue;
    if (move.panelMove || move.entered || move.panelEffect) continue;
    // A walk home lands off the board, so it leaves nothing to move again.
    if (move.withdrawn) continue;
    if (move.to) out.add(move.to);
  }
  return out;
}

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
