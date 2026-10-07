import { AnimStep } from '../components/game-board/game-board.component';

/** The parts of a staged action a replay cares about. */
export interface PlayableAction {
  from: string;
  to: string;
  attack: string | null;
  heal?: string;
  afterAttackWalk?: boolean;
  secondStrike?: boolean;
  impactTargets?: AnimStep[];
  killed?: string;
  /** Who was killed there, when something was. */
  killedUnit?: { color: 'white' | 'black' };
  /**
   * Whether the defender actually answered. Not derivable from the rest: a
   * base never counters however alive it is, and neither does anything the
   * attacker stood outside the reach of.
   */
  countered?: boolean;
  /** Present when the action was an ability cast rather than a move. */
  spend?: {
    index: number; row?: string; hex?: string; uid?: string;
    side?: 'mine' | 'opponent';
    visuals?: AnimStep[];
  };
  /** What the cast did to the target's HP: `+20`, `-14`. Drawn over it. */
  mark?: string;
}

/**
 * A committed turn, beat by beat: each step walked, each blow struck and
 * answered, each cast lit. Staged actions chain - the second step starts
 * where the first ended - so the walk is followed rather than re-read from
 * each action's own origin.
 *
 * **Followed per unit.** Every staged action carries the hex its unit set off
 * from this turn, and that origin is what tells one unit's walk from
 * another's. A single "where the unit stands" used to serve the whole turn,
 * so a turn that moved two units - overtime's, or a setup turn's walks home -
 * played the second as a walk from wherever the first had stopped, and the
 * recap folded both into one line from the first origin to the last
 * landing: a move nobody made, and the two that were made gone.
 */
export function buildPlayback(actions: PlayableAction[], collapseMoves = false): AnimStep[] {
  const steps: AnimStep[] = [];
  /** Which unit each beat belongs to, by origin - or null for nobody's. */
  const owners: Array<string | null> = [];
  /** Where each unit that has acted stands now, by the hex it set off from. */
  const standing = new Map<string, string>();
  const targetOwners = new Map<AnimStep, string>();
  const at = (origin: string) => standing.get(origin) ?? origin;
  /** Every unit that moves or strikes this turn, by origin. */
  const origins = [...new Set(actions.filter(a => !a.spend && a.from).map(a => a.from))];
  for (const action of actions) {
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
      steps.push({
        kind: 'ability', from: target, to: target, ...slot,
        ...(action.spend.visuals ? { targets: action.spend.visuals } : {}),
        brief: collapseMoves, ...(action.mark ? { mark: action.mark } : {}),
        // Whose mark it is. The recap plays against the board the turn ended
        // on, so the hex is not enough to say who the cast landed on.
        ...(action.spend.uid ? { uid: action.spend.uid } : {}),
        // And, for a kill, whose it was: nobody is left to read it off.
        ...(action.killedUnit ? { color: action.killedUnit.color } : {}),
      });
      for (const target of action.spend.visuals ?? []) {
        const owner = origins.find(origin => at(origin) === target.to);
        if (owner) targetOwners.set(target, owner);
      }
      // Who stood there as it landed: a unit that has moved is where it got
      // to, and one that has not is still where it set off from.
      owners.push(target ? origins.find(origin => at(origin) === target) ?? null : null);
      continue;
    }
    const origin = at(action.from);
    const owner = action.from || null;
    if (action.heal) {
      steps.push({ kind: 'heal', from: action.heal, to: action.heal, mark: action.mark, brief: collapseMoves });
      owners.push(origins.find(origin => at(origin) === action.heal) ?? null);
      if (action.from && action.to) standing.set(action.from, action.to);
      continue;
    }
    if (action.attack && !action.afterAttackWalk) {
      steps.push({ kind: 'attack', from: action.to, to: action.attack,
        ...(action.impactTargets ? { targets: action.impactTargets } : {}) });
      owners.push(owner);
      // Only if it answered. `killed` alone used to stand in for that, which
      // played a counter beat for every blow a base absorbed and every one
      // struck from outside the defender's reach - see onPlayerAttack. The
      // fallback is for a turn staged before this was recorded and restored
      // off disk afterwards.
      if (action.countered ?? (action.killed !== action.attack)) {
        steps.push({ kind: 'counter', from: action.attack, to: action.to });
        owners.push(owner);
      }
      if (action.secondStrike) { steps.push({ kind: 'attack', from: action.to, to: action.attack }); owners.push(owner); }
      if (action.from && action.to) standing.set(action.from, action.to);
      continue;
    }
    if (origin && action.to && origin !== action.to) {
      steps.push({ kind: 'move', from: origin, to: action.to });
      owners.push(owner);
    }
    if (action.from && action.to) standing.set(action.from, action.to);
  }
  if (!collapseMoves) return steps;

  // Replaying a committed turn, each unit's walk is one straight line from
  // where it set off to where it ended up - the detours were the player's
  // business while they were staging it - and it goes before anything else
  // that happens to that unit, because the board is already showing the
  // finished position. A cast played on a hex the unit has since left pops an
  // empty hex, and the walk after it reads as the unit teleporting back to
  // start again. The units themselves go in the order they acted.
  const rapid = new Set(actions.filter(action => action.afterAttackWalk).map(action => action.from));
  const recap: AnimStep[] = [];
  const walked = new Set<string>();
  steps.forEach((step, i) => {
    const owner = owners[i];
    if (owner !== null && rapid.has(owner) && !step.targets) { recap.push(step); return; }
    for (const target of step.targets ?? []) {
      const targetOwner = targetOwners.get(target);
      if (!targetOwner || rapid.has(targetOwner) || walked.has(targetOwner)) continue;
      walked.add(targetOwner);
      if (at(targetOwner) !== targetOwner) recap.push({ kind: 'move', from: targetOwner, to: at(targetOwner) });
    }
    if (owner !== null && !rapid.has(owner) && !walked.has(owner)) {
      walked.add(owner);
      if (at(owner) !== owner) recap.push({ kind: 'move', from: owner, to: at(owner) });
    }
    if (step.kind === 'move') return;              // folded into its unit's line
    if (step.targets) {
      recap.push({ ...step, targets: step.targets.map(target => {
        const targetOwner = targetOwners.get(target);
        return targetOwner && !rapid.has(targetOwner)
          ? { ...target, from: at(targetOwner), to: at(targetOwner) } : target;
      }) });
      return;
    }
    if ((step.kind === 'ability' || step.kind === 'heal') && owner !== null) {
      // It landed on a unit that acted, so it lands where that unit is now.
      recap.push({ ...step, from: at(owner), to: at(owner) });
      return;
    }
    recap.push(step);
  });
  return recap;
}
