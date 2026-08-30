/**
 * The match schedule.
 *
 * Five phases: three turns to set up, three ten-turn phases with a halftime
 * halfway through each, then overtime, which runs until the game ends.
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

export const PHASES: Phase[] = [
  { name: 'Initialization', turns: 3 },
  { name: 'Phase 1', turns: 10, halftime: true },
  { name: 'Phase 2', turns: 10, halftime: true },
  { name: 'Phase 3', turns: 10, halftime: true },
  { name: 'Overtime', turns: Infinity },
];

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
export function turnHeading(turn: number): string {
  const last = MILESTONES[MILESTONES.length - 1];
  const next = MILESTONES.find(m => m.turn > turn)
    ?? (last.turn >= turn ? last : null);
  if (!next) return `Turn ${turn} - ${PHASES[PHASES.length - 1].name}`;
  return `Turn ${turn} - ${next.turn - turn} Until ${next.next}`;
}
