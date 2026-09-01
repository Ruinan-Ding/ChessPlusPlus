import { AnimStep } from '../components/game-board/game-board.component';

/** The parts of a staged action a replay cares about. */
export interface PlayableAction {
  from: string;
  to: string;
  attack: string | null;
  killed?: string;
  /**
   * Whether the defender actually answered. Not derivable from the rest: a
   * base never counters however alive it is, and neither does anything the
   * attacker stood outside the reach of.
   */
  countered?: boolean;
  /** Present when the action was an ability cast rather than a move. */
  spend?: { index: number; row?: string; hex?: string; side?: 'mine' | 'opponent' };
}

/**
 * A committed turn, beat by beat: each step walked, each blow struck and
 * answered, each cast lit. Staged actions chain - the second step starts
 * where the first ended - so the walk is followed rather than re-read from
 * each action's own origin.
 */
export function buildPlayback(actions: PlayableAction[], collapseMoves = false): AnimStep[] {
  const steps: AnimStep[] = [];
  let standing = '';
  /** Every hex the acting unit stood on, and the one it set off from. */
  const walked = new Set<string>();
  let firstHex = '';
  for (const action of actions) {
    const origin = standing || action.from;
    if (origin) {
      walked.add(origin);
      if (!firstHex) firstHex = origin;
    }
    if (action.spend) {
      // The hex the cast landed on, which the spend recorded when it was made.
      // Reading it back off the action's own from/to gave the *caster's* hex,
      // so a debuff replayed as a swell on the wrong unit - or, for a
      // universal ability that names no hex at all, as no beat whatsoever.
      const target = action.spend.hex || action.killed || '';
      // A unit's own ability lands on the unit and nowhere else, so it names
      // no slot: the panel button it came from does not pop with it.
      const slot = action.spend.row === 'unit'
        ? {}
        : { index: action.spend.index, ...(action.spend.side ? { side: action.spend.side } : {}) };
      // Every cast gets its beat, hex or no hex - a universal one is the
      // button alone, and the board simply holds for it.
      steps.push({ kind: 'ability', from: target, to: target, ...slot, brief: collapseMoves });
      continue;
    }
    if (action.attack) {
      steps.push({ kind: 'attack', from: action.to, to: action.attack });
      // Only if it answered. `killed` alone used to stand in for that, which
      // played a counter beat for every blow a base absorbed and every one
      // struck from outside the defender's reach - see onPlayerAttack. The
      // fallback is for a turn staged before this was recorded and restored
      // off disk afterwards.
      if (action.countered ?? (action.killed !== action.attack)) {
        steps.push({ kind: 'counter', from: action.attack, to: action.to });
      }
      standing = action.to;
      continue;
    }
    if (origin && action.to && origin !== action.to) {
      steps.push({ kind: 'move', from: origin, to: action.to });
    }
    standing = action.to || standing;
    if (standing) walked.add(standing);
  }
  if (!collapseMoves) return steps;

  // Replaying a committed turn, the walk is one straight line from where the
  // unit set off to where it ended up - the detours were the player's business
  // while they were staging it - and it goes first, because the board is
  // already showing the finished position. A cast played on a hex the unit has
  // since left pops an empty hex, and the walk after it reads as the unit
  // teleporting back to start again.
  const first = firstHex;
  const last = standing || first;
  const recap: AnimStep[] = [];
  if (first && last && first !== last) recap.push({ kind: 'move', from: first, to: last });
  for (const step of steps) {
    if (step.kind === 'move') continue;              // folded into the one above
    if (step.kind === 'ability' && step.to && walked.has(step.to)) {
      // It landed on the unit that acted, so it lands where that unit is now.
      recap.push({ ...step, from: last, to: last });
      continue;
    }
    recap.push(step);
  }
  return recap;
}
