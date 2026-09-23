/**
 * The match schedule.
 *
 * Five phases: three turns to set up, three ten-turn phases with a halftime
 * halfway through each, then overtime, which runs until the game ends. Each
 * numbered phase opens with an **initialization turn** of its own, which its
 * ten do not count - see `init` below.
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
  /**
   * Whether the phase opens with an initialization turn - one full turn, both
   * sides, before its play begins.
   *
   * **`turns` does not count it.** The owner's rule: it "counts as a turn but
   * not any turn taking from any phases", so Phase 1 still gets its ten. That
   * is why this is a flag on the phase rather than a phase of its own: a
   * separate entry would have to be excluded from `SCORING_PHASES` and from
   * every "which phase am I in" answer, and the init turn *is* part of Phase
   * 1. The span it occupies is `phaseSpan`; the ten are still `turns`.
   */
  init?: boolean;
}

/** Hand-overs to a full turn: white plays, then black. */
export const PLIES_PER_TURN = 2;

/** The full turn a hand-over belongs to. White opens turn 1. */
export function turnOf(ply: number): number {
  return Math.ceil(ply / PLIES_PER_TURN);
}

export const PHASES: Phase[] = [
  { name: 'Initialization', turns: 3 },
  { name: 'Phase 1', turns: 10, halftime: true, init: true },
  { name: 'Phase 2', turns: 10, halftime: true, init: true },
  { name: 'Phase 3', turns: 10, halftime: true, init: true },
  { name: 'Overtime', turns: Infinity },
];

/**
 * How many turns of the clock a phase occupies: its own `turns`, plus the
 * initialization turn if it opens with one.
 *
 * Every "where am I on the schedule" answer counts in spans; everything that
 * asks how long a phase *plays* for - the halftime split, the score it banks -
 * counts in `turns`. Keeping the two apart is the whole point of the flag.
 */
function phaseSpan(phase: Phase): number {
  return Number.isFinite(phase.turns) && phase.init ? phase.turns + 1 : phase.turns;
}

/**
 * Where in the schedule a turn falls. The last phase runs out the match, so
 * any turn past the schedule belongs to it.
 */
export function phaseIndexAt(ply: number): number {
  const turn = turnOf(ply);
  let end = 0;
  for (let i = 0; i < PHASES.length; i++) {
    if (!Number.isFinite(PHASES[i].turns)) return i;
    end += phaseSpan(PHASES[i]);
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
  .reduce((sum, phase) => sum + phaseSpan(phase), 0) * PLIES_PER_TURN + 1;

/**
 * The opening turns, where nobody attacks and both sides are still setting
 * out: three base units and three reserve units a turn, one battlefield unit
 * for the whole of it, and a unit that has been moved is done for the phase.
 *
 * **The opening only** - not a numbered phase's initialization turn, which is
 * one turn with its own allowances (`isPhaseInitialization`). Widening this to
 * mean "any setup turn" would hand the opening's one-move-per-phase lock to a
 * single turn that was never about it; `isSetupTurn` is the predicate for what
 * the two genuinely share.
 */
export function isInitialization(ply: number): boolean {
  return phaseIndexAt(ply) === 0;
}

/**
 * The phases that bank a score, as a question about a hand-over. The opening
 * and overtime are the two that do not.
 */
export function isScoringPhase(ply: number): boolean {
  return SCORING_PHASES.includes(phaseIndexAt(ply));
}

/**
 * A numbered phase's own initialization turn: the first turn of its span,
 * which its ten turns of play do not count.
 *
 * One full turn - white's hand-over and black's. Both sides get one, because
 * a turn either side could set out on and the other could not would hand the
 * second mover a free look at the first's deployment.
 */
export function isPhaseInitialization(ply: number): boolean {
  const index = phaseIndexAt(ply);
  return !!PHASES[index].init && turnOf(ply) === phaseStartTurn(index);
}

/**
 * A turn given to setting out rather than playing: the opening's three, and
 * each numbered phase's initialization turn.
 *
 * What the two share, and *all* they share: **nobody attacks and no ability
 * fires**. Their movement allowances are different - the opening gives a
 * battlefield unit one move for the whole phase, a phase initialization gives
 * five crossings and three walks home for the one turn - so anything about
 * how much may move asks the narrower predicate.
 */
export function isSetupTurn(ply: number): boolean {
  return isInitialization(ply) || isPhaseInitialization(ply);
}

/**
 * What to tell someone who tried to strike on a turn given to setting out.
 *
 * Two turns refuse a blow for two different reasons, and saying "the opening"
 * on turn 15 would send the player looking at a phase that ended ten turns
 * ago. Lives here rather than at the call sites so the server's copy has one
 * thing to mirror.
 *
 * Total, not partial: a ply that refuses no blow gets `''`. Asked the other
 * way round - "not the opening, so a phase initialization" - it answered
 * `Nobody attacks in a phase initialization` for every playable turn of every
 * phase, which is exactly the reading a caller without a guard would take.
 */
export function noAttackMessage(ply: number): string {
  if (isPhaseInitialization(ply)) return 'Nobody attacks in a phase initialization';
  if (isInitialization(ply)) return 'Nobody attacks in the opening';
  return '';
}

/**
 * How many units a side may bring out of its reserve in a phase
 * initialization, and how many it may walk home in any setup turn.
 *
 * The owner's numbers. During a phase initialization these stand *instead of*
 * the per-panel allowance, not beside it: five out of the reserve for the
 * side, counted for the side as a whole.
 */
export const PHASE_INIT_ENTRIES = 5;
export const HOMECOMINGS_PER_SETUP_TURN = 3;

/**
 * Overtime's three stretches, and what each takes off a commander at the end
 * of that side's turn.
 *
 * Real damage, and a commander on that much HP dies of it. The toll climbs so
 * that a match neither side can win on the board still ends: the last turn
 * takes three, and a king who walks into it on three or less does not walk
 * out. A match still standing after it goes to black - see `matchVerdict`.
 *
 * `turns` are full turns - white's hand-over and black's - counted forward
 * from overtime's first, which gives turns 37-44, 45-49 and 50 on the shipped
 * schedule. Counted forward rather than written down, because a written-down
 * turn number is exactly what went wrong last time: `OVERTIME_LAST_TURN` was
 * the literal 50, the initialization turns pushed overtime from turn 34 to
 * turn 37, and the literal stayed where it was and quietly shortened overtime
 * by three turns.
 *
 * The stretches are named, and the phase they sit in is not: `phaseAt` still
 * answers `Overtime` for all fourteen turns, while `stageAt` answers
 * `Overtime 1`, `Overtime 2`, `Overtime 3`. That is the same split a numbered
 * phase already has between itself and its halftime, and it is why the turn
 * the match *enters* overtime is announced as `Overtime 1` rather than as the
 * phase's own name - two names for one boundary would have the header read
 * `Until Overtime` and then land on something else.
 */
export interface OvertimeStage {
  name: string;
  /** Full turns it runs for. */
  turns: number;
  /** HP off that side's commander at the end of each of its turns. */
  toll: number;
  /**
   * Points a side banks at the start of each of its turns in the stretch,
   * in place of `POINTS_PER_TURN`.
   *
   * The toll takes and this gives, and they climb together: the pressure to
   * finish comes with the means to. Points are the board's currency - the
   * pool abilities, the wrap crossing - not the match score, which overtime
   * still does not touch.
   */
  points: number;
  /**
   * How many units a side may move on the **main board** in one of its turns,
   * in place of `BOARD_MOVES_PER_TURN`.
   *
   * Each one is a whole board action - a walk and, if it ends in reach, a
   * swing - so a stretch that allows three allows three blows. The owner's
   * call when asked. Panel deployments are not counted here and never were:
   * a crossing, a walk inside a panel and a setup turn's walk home have
   * allowances of their own.
   */
  moves: number;
}

export const OVERTIME_STAGES: OvertimeStage[] = [
  { name: 'Overtime 1', turns: 8, toll: 1, points: 1, moves: 1 },
  { name: 'Overtime 2', turns: 5, toll: 2, points: 3, moves: 2 },
  { name: 'Overtime 3', turns: 1, toll: 3, points: 5, moves: 3 },
];

/** Overtime's first full turn, and its last. Both read off the schedule. */
export const OVERTIME_FIRST_TURN = turnOf(OVERTIME_FIRST_PLY);
export const OVERTIME_LAST_TURN = OVERTIME_FIRST_TURN
  + OVERTIME_STAGES.reduce((sum, stage) => sum + stage.turns, 0) - 1;

/**
 * Overtime: the schedule is spent and the match is a deathmatch until a king
 * falls or `OVERTIME_LAST_TURN` runs out. Nothing is scored in it, so the
 * header stops drawing the phase numbers.
 */
export function isOvertime(ply: number): boolean {
  return phaseAt(ply) === PHASES[PHASES.length - 1];
}

/**
 * Which stretch of overtime a hand-over falls in, or `null` before overtime
 * begins.
 *
 * Past the last turn it is the last stretch rather than `null`: the match is
 * black's by then, but that verdict is read and not enforced, so a game
 * played on past turn 50 keeps paying the heaviest toll instead of quietly
 * ceasing to pay one at all.
 */
export function overtimeStageAt(ply: number): OvertimeStage | null {
  if (!isOvertime(ply)) return null;
  const turn = turnOf(ply);
  let end = OVERTIME_FIRST_TURN - 1;
  for (const stage of OVERTIME_STAGES) {
    end += stage.turns;
    if (turn <= end) return stage;
  }
  return OVERTIME_STAGES[OVERTIME_STAGES.length - 1];
}

/**
 * What overtime takes off the commander of the side playing `ply`, at the end
 * of that hand-over. `0` outside overtime, which is what "no toll" means to
 * every caller: both engines take it off unconditionally.
 */
export function overtimeTollAt(ply: number): number {
  return overtimeStageAt(ply)?.toll ?? 0;
}

/**
 * What a side's next `turns` of tolls come to, starting with the one at the
 * end of `ply`. A side pays once a full turn, so this steps by two.
 *
 * What the board's skull warns on. With a toll that climbs, "will he live
 * through the next two" stopped being `toll * 2`: a king on 3 HP is safe in
 * the first stretch, on his last turn in the second, and already dead in the
 * third.
 */
export function overtimeTollOver(ply: number, turns: number): number {
  let sum = 0;
  for (let i = 0; i < turns; i++) sum += overtimeTollAt(ply + i * PLIES_PER_TURN);
  return sum;
}

/**
 * What a side banks at the start of one of its own turns, everywhere the
 * schedule is still running. Overtime's stretches pay more - see
 * `OVERTIME_STAGES` - and `pointsPerTurnAt` is the one place to ask.
 */
export const POINTS_PER_TURN = 1;

/**
 * How many units a side may move on the main board in one of its turns,
 * everywhere the schedule is still running: **one**, which is what "the
 * turn's board action" has always meant.
 *
 * Overtime 2 and 3 raise it to two and three (`OVERTIME_STAGES`). That is the
 * one rule in this file that changes what a *turn* is rather than what it
 * costs, so everything built on "there is exactly one" has to ask rather than
 * assume: the board's lock, the room's commit, and both engines.
 */
export const BOARD_MOVES_PER_TURN = 1;

/** How many board moves the side playing `ply` may make. */
export function boardMovesPerTurn(ply: number): number {
  return overtimeStageAt(ply)?.moves ?? BOARD_MOVES_PER_TURN;
}

/** What the turn at `ply` pays the side playing it. */
export function pointsPerTurnAt(ply: number): number {
  return overtimeStageAt(ply)?.points ?? POINTS_PER_TURN;
}

/**
 * What a side's own turns have paid it in points by `ply` - the hand-over
 * about to be played, which counts, since a turn pays at its start.
 *
 * **Not `handOversBy(color, ply) * POINTS_PER_TURN` any more.** The rate
 * climbs through overtime, so this walks the stretches and counts how many of
 * that side's hand-overs fall in each, which is a difference of two
 * `handOversBy` at the stretch's ends - the same shape `panelMoversSince`
 * uses to count a side's turns between two plies.
 *
 * Past the last stretch it keeps paying at the last rate, for the reason the
 * toll keeps taking at it: the verdict there is read and not enforced, and a
 * game played on must not quietly stop settling up.
 */
export function turnPointsBy(color: 'white' | 'black', ply: number): number {
  const played = Math.max(0, ply);
  // Everything on the schedule pays the flat rate.
  let start = OVERTIME_FIRST_PLY - 1;
  let points = handOversBy(color, Math.min(played, start)) * POINTS_PER_TURN;
  for (const stage of OVERTIME_STAGES) {
    if (played <= start) return points;
    const end = start + stage.turns * PLIES_PER_TURN;
    points += (handOversBy(color, Math.min(played, end))
      - handOversBy(color, start)) * stage.points;
    start = end;
  }
  const last = OVERTIME_STAGES[OVERTIME_STAGES.length - 1];
  if (played <= start) return points;
  return points + (handOversBy(color, played) - handOversBy(color, start)) * last.points;
}

/**
 * The first full turn of a phase - its initialization turn, where it has one.
 * Counted in spans, so an earlier phase's init turn pushes this along too.
 */
function phaseStartTurn(index: number): number {
  let turn = 1;
  for (let i = 0; i < index; i++) turn += phaseSpan(PHASES[i]);
  return turn;
}

/**
 * The first turn a phase actually *plays*: one past its start where it opens
 * with an initialization turn, its start where it does not. What the halftime
 * splits, since the init turn is not one of the ten it halves.
 */
function playStartTurn(index: number): number {
  return phaseStartTurn(index) + (PHASES[index].init ? 1 : 0);
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
  return turnOf(ply) < playStartTurn(index) + phase.turns / 2;
}

/**
 * Whether the wrap is open - the crossing out of a side's base, over the
 * outer tip and onto the reserve tip facing it across the board.
 *
 * **Only the played first half of a numbered phase.** Not the opening, not a
 * phase's initialization turn, and not overtime: the owner's rule is that the
 * wrap belongs to the half before the halftime and to nothing else. On the
 * shipped schedule that is turns 5-9, 16-20 and 27-31, and no others.
 *
 * `beforeHalftime` alone used to be the whole answer, and it said yes for
 * every phase that has no break to fall either side of - which quietly
 * included the opening and the whole of overtime. The three conditions are
 * spelled out because each one refuses a different turn.
 */
export function isWrapOpen(ply: number): boolean {
  return isScoringPhase(ply) && !isPhaseInitialization(ply) && beforeHalftime(ply);
}

/**
 * Whether units may come out of the reserve onto the board - the three arrows
 * on each side's reserve, pointing in.
 *
 * Open on any setup turn and through a phase's halftime half; shut through the
 * played first half and through overtime. On the shipped schedule that is
 * turns 1-4, 10-15, 21-26 and 32-36.
 *
 * The complement of the wrap, near enough: a side spends the first half of a
 * phase sending units home around the outside and the second half bringing
 * them back in. Overtime is the one turn of the match where neither runs.
 */
export function isEntryOpen(ply: number): boolean {
  return isSetupTurn(ply) || (isScoringPhase(ply) && !beforeHalftime(ply));
}

/**
 * Whether units may walk home to their own base for the refund - the three
 * arrows on each side's base, pointing in.
 *
 * Open on any setup turn and through **all** of overtime; shut through both
 * halves of a numbered phase's play. On the shipped schedule that is turns
 * 1-4, 15, 26 and 37 on.
 *
 * Overtime is the owner's exception and is not a setup turn: the toll is
 * running and units are still attacking, so a walk home there is an ordinary
 * move that happens to end off the board. What does not change with the window
 * is *who* may go - a unit standing in its own first three rows that can reach
 * a doorway within its MOV - which is a question for the board, not the clock.
 */
export function isHomecomingOpen(ply: number): boolean {
  return isSetupTurn(ply) || isOvertime(ply);
}

/**
 * Where the match is, as a name: `Initialization`, `Phase 1 Initialization`,
 * `Phase 1`, `Phase 1 Halftime`, ... , `Overtime`, `Overtime 2`, `Overtime 3`.
 * A phase that breaks in the middle is two stages, and the second takes the
 * halftime's name - the same name the history header counts down to, so the
 * two agree on what to call it. Overtime breaks twice more, on the same terms.
 */
export function stageAt(ply: number): string {
  const phase = phaseAt(ply);
  if (isPhaseInitialization(ply)) return `${phase.name} Initialization`;
  const overtime = overtimeStageAt(ply);
  if (overtime) return overtime.name;
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
    if (phase.init) {
      // An initialization turn is a gear change twice over: into it at the end
      // of the turn before, and out of it into the phase's play one turn later.
      // Nothing changes gear at the end of turn 0, though - a leading phase
      // with an initialization turn has no turn before it to count from, and
      // the entry would be unreachable while shifting every later one by a
      // turn. Not reachable on the shipped table; the point of deriving this
      // from PHASES is that the table can be edited without minding the sums.
      if (end > 0) out.push({ turn: end, next: `${phase.name} Initialization` });
      end += 1;
      out.push({ turn: end, next: phase.name });
    }
    if (phase.halftime) {
      out.push({ turn: end + phase.turns / 2, next: `${phase.name} Halftime` });
    }
    end += phase.turns;
    const following = PHASES[i + 1];
    // A phase that opens with an initialization announces itself above, on its
    // own pass. Announcing it here as well would put two changes on one turn.
    //
    // The phase that runs out the match announces itself in the overtime block
    // below, in the name of its FIRST STRETCH rather than its own: the match
    // arrives in `Overtime 1`, and a countdown to a bare `Overtime` would name
    // something `stageAt` never says.
    if (following && !following.init && Number.isFinite(following.turns)) {
      out.push({ turn: end, next: following.name });
    }
  });
  // Overtime's own gear changes, including the one into it: the loop above
  // returns before the phase that runs out the match, so this is where all
  // three stretches are announced. The toll climbs twice inside overtime, and
  // a turn where the damage doubles is as much a change to count down to as a
  // halftime is.
  //
  // Each is announced at the end of the turn BEFORE it opens, which is what
  // every other milestone means. So the last stretch pushes one and nothing
  // follows it, and `turnHeading` falls through to naming the stage instead.
  let overtimeEnd = OVERTIME_FIRST_TURN - 1;
  for (const stage of OVERTIME_STAGES) {
    out.push({ turn: overtimeEnd, next: stage.name });
    overtimeEnd += stage.turns;
  }
  return out;
}

/** The schedule as turn numbers. Fixed, so it is worked out once. */
export const MILESTONES: Milestone[] = buildMilestones();

/**
 * What the history header says: the turn, and how many more turns of play
 * before the match changes gear.
 *
 * A change lands at the *end* of the turn it is counted to, so the turn it
 * lands on has already moved on to counting the next one - turn 3 is the last
 * of the opening, so it looks ahead to Phase 1's initialization turn rather
 * than to the opening, which it is still in. Since each phase now opens with
 * an initialization turn, the countdowns run to those too: turn 3 reads
 * `1 Until Phase 1`, the phase's play being what turn 4 counts to.
 *
 * The last change has nothing beyond it to move on to, so its own turn keeps
 * counting to it and reads `0 Until Overtime 3`. Naming the stage there
 * instead would put Overtime 3 on the header for the last turn of Overtime 2,
 * which is a turn of Overtime 2. Only once every change is spent does it say
 * where you are rather than what is coming - and it says it in the *stage's*
 * name, not the phase's, so the final turns read `Overtime 3` rather than
 * falling back to a plain `Overtime` the match left ten turns ago.
 */
export function turnHeading(ply: number): string {
  const turn = turnOf(ply);
  const last = MILESTONES[MILESTONES.length - 1];
  const next = MILESTONES.find(m => m.turn > turn)
    ?? (last.turn >= turn ? last : null);
  if (!next) return `Turn ${turn} - ${stageAt(ply)}`;
  return `Turn ${turn} - ${next.turn - turn} Until ${next.next}`;
}
