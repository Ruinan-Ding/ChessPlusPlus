import { AnimStep } from '../components/game-board/game-board.component';

/** The parts of a staged action a replay cares about. */
export interface PlayableAction {
  from: string;
  to: string;
  attack: string | null;
  killed?: string;
  /** Present when the action was an ability cast rather than a move. */
  spend?: { index: number };
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
  for (const action of actions) {
    const origin = standing || action.from;
    if (action.spend) {
      // A cast: the hex it landed on, or the caster when it hit nobody.
      const target = action.killed || action.to || origin;
      if (origin && target) {
        // In the recap every cast gets a beat, so each is kept short.
        steps.push({
          kind: 'ability', from: origin, to: target,
          index: action.spend.index, brief: collapseMoves,
        });
      }
      continue;
    }
    if (action.attack) {
      steps.push({ kind: 'attack', from: action.to, to: action.attack });
      // The defender answers unless this blow killed it - see onPlayerAttack.
      if (action.killed !== action.attack) {
        steps.push({ kind: 'counter', from: action.attack, to: action.to });
      }
      standing = action.to;
      continue;
    }
    if (origin && action.to && origin !== action.to) {
      const last = steps[steps.length - 1];
      // Replaying a committed turn, the walk is one straight line from where
      // the unit set off to where it ended up - the detours were the player's
      // business while they were staging it.
      if (collapseMoves && last?.kind === 'move') last.to = action.to;
      else steps.push({ kind: 'move', from: origin, to: action.to });
    }
    standing = action.to || standing;
  }
  return steps;
}
