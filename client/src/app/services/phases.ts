/**
 * The match schedule.
 *
 * Five phases: three turns to set up, three ten-turn phases with a halftime
 * halfway through each, then overtime, which runs until the game ends.
 *
 * The turns here are *full* turns - white's hand-over and black's together.
 * The engine counts one per hand-over, so everything exported below takes
 * that count and converts, which keeps the conversion at this one boundary
 * rather than at every call site.
 *
 * ponytail: a schedule and nothing else. What a phase *does* - banking a
 * score, opening deployment - is not decided yet, so nothing here acts on a
 * phase change. Adding that means giving these entries handlers, not
 * rewriting the shape.
 */
export interface Phase {
  name: string;
  /** Turns it runs for; Infinity for the one that runs out the match. */
  turns: number;
  /** Whether it breaks in the middle. A halftime splits the turns evenly. */
  halftime?: boolean;
}

/** Hand-overs to a full turn: white plays, then black. */
export const PLIES_PER_TURN = 2;

/** The full turn a hand-over belongs to. White opens turn 1. */
export function turnOf(ply: number): number {
  return Math.ceil(ply / PLIES_PER_TURN);
}

export const PHASES: Phase[] = [
  { name: 'Initialization', turns: 3 },
  { name: 'Phase 1', turns: 10, halftime: true },
  { name: 'Phase 2', turns: 10, halftime: true },
  { name: 'Phase 3', turns: 10, halftime: true },
  { name: 'Overtime', turns: Infinity },
];

/**
 * Where in the schedule a turn falls. The last phase runs out the match, so
 * any turn past the schedule belongs to it.
 */
export function phaseIndexAt(ply: number): number {
  const turn = turnOf(ply);
  let end = 0;
  for (let i = 0; i < PHASES.length; i++) {
    if (!Number.isFinite(PHASES[i].turns)) return i;
    end += PHASES[i].turns;
    if (turn <= end) return i;
  }
  return PHASES.length - 1;
}

/** Which phase a hand-over falls in. */
export function phaseAt(ply: number): Phase {
  return PHASES[phaseIndexAt(ply)];
}

/**
 * The phases that bank a score, by their place in the schedule: the three
 * numbered ones. The opening banks nothing, and overtime has no end to bank
 * at - it runs until the match does.
 */
export const SCORING_PHASES = [1, 2, 3];

/**
 * The first hand-over of overtime: everything on the schedule has been
 * played. Derived from the schedule rather than written down, so moving a
 * phase moves this with it.
 */
export const OVERTIME_FIRST_PLY = PHASES
  .filter(phase => Number.isFinite(phase.turns))
  .reduce((sum, phase) => sum + phase.turns, 0) * PLIES_PER_TURN + 1;

/**
 * The opening turns, where nobody attacks and both sides are still setting
 * out: three base units and three reserve units a turn, one battlefield unit
 * for the whole of it, and a unit that has been moved is done for the phase.
 */
export function isInitialization(ply: number): boolean {
  return phaseAt(ply) === PHASES[0];
}

/**
 * What overtime takes off a commander at the end of each of its side's turns.
 * Real damage, and a commander on this much HP dies of it.
 */
export const OVERTIME_TOLL = 1;

/**
 * Overtime: the schedule is spent and the match is a deathmatch until a king
 * falls or turn 50 runs out. Nothing is scored in it, so the header stops
 * drawing the phase numbers.
 */
export function isOvertime(ply: number): boolean {
  return phaseAt(ply) === PHASES[PHASES.length - 1];
}

/** The first full turn of a phase. */
function phaseStartTurn(index: number): number {
  let turn = 1;
  for (let i = 0; i < index; i++) turn += PHASES[i].turns;
  return turn;
}

/**
 * Whether a turn falls before its phase's break - or in a phase that has no
 * break to fall either side of. The opening and overtime are the two of
 * those, so they are always "before".
 *
 * Read off the schedule rather than written down as turn numbers, so moving
 * a phase moves everything that hangs off this with it.
 */
export function beforeHalftime(ply: number): boolean {
  const index = phaseIndexAt(ply);
  const phase = PHASES[index];
  if (!phase.halftime) return true;
  return turnOf(ply) < phaseStartTurn(index) + phase.turns / 2;
}

/**
 * Whether the wrap is open - the crossing out of a side's base, over the
 * outer tip and onto the reserve tip facing it across the board.
 *
 * Open through the opening, through the first half of each numbered phase,
 * and through overtime; shut from a phase's halftime to the end of it. On the
 * shipped schedule that is turns 1-8, 14-18, 24-28 and 34 on; shut for 9-13,
 * 19-23 and 29-33.
 *
 * Which is exactly the half of a phase the header names without "Halftime" -
 * one predicate, so the board can never shut the crossing on a turn the
 * header still calls Phase 1.
 */
export function isWrapOpen(ply: number): boolean {
  return beforeHalftime(ply);
}

/**
 * Where the match is, as a name: `Initialization`, `Phase 1`, `Phase 1
 * Halftime`, ... , `Overtime`. A phase that breaks in the middle is two
 * stages, and the second takes the halftime's name - the same name the
 * history header counts down to, so the two agree on what to call it.
 */
export function stageAt(ply: number): string {
  const phase = phaseAt(ply);
  return phase.halftime && !beforeHalftime(ply)
    ? `${phase.name} Halftime` : phase.name;
}

/**
 * Whose hand-over a ply is. White opens, so white plays the odd ones.
 */
export function sideOfPly(ply: number): 'white' | 'black' {
  return ply % 2 ? 'white' : 'black';
}

/**
 * How many of a side's own hand-overs have been played by the end of `ply`.
 *
 * What anything paid or given "each turn" counts: a side's base mends once a
 * turn, not once a hand-over, so counting plies would hand out two. Taking
 * the difference of two of these gives the turns between them for that side.
 */
export function handOversBy(color: 'white' | 'black', ply: number): number {
  const played = Math.max(0, ply);
  return color === 'white' ? Math.ceil(played / 2) : Math.floor(played / 2);
}

/** A point the match changes gear: the turn it lands on, and what follows. */
export interface Milestone {
  /** The last turn played before the change. */
  turn: number;
  /** What the match changes to at the end of that turn. */
  next: string;
}

function buildMilestones(): Milestone[] {
  const out: Milestone[] = [];
  let end = 0;
  PHASES.forEach((phase, i) => {
    // The last phase runs to the end of the match, so nothing follows it.
    if (!Number.isFinite(phase.turns)) return;
    if (phase.halftime) {
      out.push({ turn: end + phase.turns / 2, next: `${phase.name} Halftime` });
    }
    end += phase.turns;
    const following = PHASES[i + 1];
    if (following) out.push({ turn: end, next: following.name });
  });
  return out;
}

/** The schedule as turn numbers. Fixed, so it is worked out once. */
export const MILESTONES: Milestone[] = buildMilestones();

/**
 * What the history header says: the turn, and how many more turns of play
 * before the match changes gear.
 *
 * A change lands at the *end* of the turn it is counted to, so the turn it
 * lands on has already moved on to counting the next one - turn 3 is the
 * last of the initialization, so it looks ahead to Phase 1's halftime rather
 * than to Phase 1, which arrives as it finishes.
 *
 * The last change has nothing beyond it to move on to, so its own turn keeps
 * counting to it and reads `0 Until Overtime`. Naming the phase there instead
 * would put Overtime on the header for the last turn of Phase 3, which is a
 * turn of Phase 3. Only once the schedule is spent does it say where you are
 * rather than what is coming.
 */
export function turnHeading(ply: number): string {
  const turn = turnOf(ply);
  const last = MILESTONES[MILESTONES.length - 1];
  const next = MILESTONES.find(m => m.turn > turn)
    ?? (last.turn >= turn ? last : null);
  if (!next) return `Turn ${turn} - ${PHASES[PHASES.length - 1].name}`;
  return `Turn ${turn} - ${next.turn - turn} Until ${next.next}`;
}
