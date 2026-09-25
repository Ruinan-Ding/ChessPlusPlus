/**
 * The match schedule.
 *
 * Five phases: three turns to set up, three ten-turn phases with a halftime
 * halfway through each, then overtime, which runs until the game ends. Each
 * numbered phase closes with a **postmatch turn** of its own, which its ten
 * do not count - see `postmatch` below.
 *
 * The extra turn used to sit at the *start* of each phase, as that phase's
 * "initialization". Put there, it followed the opening's three setup turns
 * straight away, so a match opened on four setup turns in a row. At the end
 * of a phase it is a breather between two phases of play instead, and play
 * starts the moment the opening is over.
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
   * Whether the phase closes with a postmatch turn - one full turn, both
   * sides, after its play is over.
   *
   * **`turns` does not count it.** The owner's rule: it "counts as a turn but
   * not any turn taking from any phases", so Phase 1 still gets its ten. That
   * is why this is a flag on the phase rather than a phase of its own: a
   * separate entry would have to be excluded from `SCORING_PHASES` and from
   * every "which phase am I in" answer, and the postmatch *is* part of the
   * phase it closes - turn 14 is Phase 1's. The span it occupies is
   * `phaseSpan`; the ten are still `turns`.
   */
  postmatch?: boolean;
  /**
   * Points a side banks at the start of each of its own turns - the board's
   * currency, for the pool abilities and the wrap crossing, not the match
   * score. `turnPointsBy` is the one place that adds them up.
   *
   * The phase's number - 1, 2, 3 - and **from its halftime**, not its first
   * turn: a phase's first half still pays the rate before it (`POINT_RATES`).
   * A phase with no halftime pays from its start: the opening the regular 1,
   * and **overtime nothing**. *The owner, 24 Sep 2026: "regular points are
   * multipled by x ... phase 1 is 1 points, phase 2 is 2 points. phase 3 is 3
   * points"*, *"OT stops gaining points"*, and then *"1x, 2x, 3x regular point
   * accumation now happens at the start of half time of each phase instead of
   * start of a phase."*
   */
  points: number;
  /**
   * Points a side is handed as the phase begins, on top of the turn's rate -
   * paid on its own first turn of the phase, the way a turn's point is: 10
   * for Phase 1, 20 for Phase 2, 30 for Phase 3, nothing for the opening or
   * overtime. *The owner, 24 Sep 2026: "at the start of each phase (not start
   * of each postmatch), +10 regular points for phase 1, 20 for phase 2, 30 for
   * phase 3."*
   */
  grant: number;
  /**
   * What the phase's victory points are multiplied by as it scores
   * (`phaseTotal` in match-score.ts): 1, 2, 3 for Phases 1-3. *The owner, 24
   * Sep 2026: "the total victory points for each phase is multiplied by 2 on
   * phase 2, multipled by 3 on phase 3".* 1 on the two phases that score
   * nothing, so reading it there changes nothing.
   */
  multiplier: number;
}

/** Hand-overs to a full turn: white plays, then black. */
export const PLIES_PER_TURN = 2;

/** The full turn a hand-over belongs to. White opens turn 1. */
export function turnOf(ply: number): number {
  return Math.ceil(ply / PLIES_PER_TURN);
}

export const PHASES: Phase[] = [
  { name: 'Initialization', turns: 3, points: 1, grant: 0, multiplier: 1 },
  { name: 'Phase 1', turns: 10, halftime: true, postmatch: true, points: 1, grant: 10, multiplier: 1 },
  { name: 'Phase 2', turns: 10, halftime: true, postmatch: true, points: 2, grant: 20, multiplier: 2 },
  { name: 'Phase 3', turns: 10, halftime: true, postmatch: true, points: 3, grant: 30, multiplier: 3 },
  { name: 'Overtime', turns: Infinity, points: 0, grant: 0, multiplier: 1 },
];

/**
 * How many turns of the clock a phase occupies: its own `turns`, plus the
 * postmatch turn if it closes with one.
 *
 * Every "where am I on the schedule" answer counts in spans; everything that
 * asks how long a phase *plays* for - the halftime split, the score it banks -
 * counts in `turns`. Keeping the two apart is the whole point of the flag.
 */
function phaseSpan(phase: Phase): number {
  return Number.isFinite(phase.turns) && phase.postmatch ? phase.turns + 1 : phase.turns;
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
 * **The opening only** - not a numbered phase's postmatch, which is one turn
 * with its own allowances (`isPostmatch`). Widening this to mean "any setup
 * turn" would hand the opening's one-move-per-phase lock to a single turn that
 * was never about it; `isSetupTurn` is the predicate for what the two
 * genuinely share.
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
 * A numbered phase's own postmatch turn: the last turn of its span, straight
 * after its ten turns of play, which do not count it. Turns 14, 25 and 36 on
 * the shipped schedule.
 *
 * One full turn - white's hand-over and black's. Both sides get one, because
 * a turn either side could set out on and the other could not would hand the
 * second mover a free look at the first's deployment.
 *
 * It belongs to the phase it closes, not the one after: `phaseIndexAt` still
 * answers the closing phase's index for it, so whatever reads "which phase is
 * this" - the deaths a phase is charged, the phase's rate of points - reads
 * the closing phase there. It is also where CP arrives: each postmatch pays
 * the award for the phase just banked (`cpAwarded`, off the bank, not the
 * index). The score is the one thing that has to know better,
 * in two places: `bankEndedPhases` (match-score.ts, run by the engines on
 * each hand-over), which banks the phase as its postmatch begins, and the
 * room's `standings`, which reads the postmatch as nought so the phase just
 * banked is not counted a second time.
 */
export function isPostmatch(ply: number): boolean {
  const index = phaseIndexAt(ply);
  const phase = PHASES[index];
  return !!phase.postmatch && turnOf(ply) === phaseStartTurn(index) + phase.turns;
}

/**
 * A turn given to setting out rather than playing: the opening's three, and
 * each numbered phase's postmatch.
 *
 * What the two share, and *all* they share: **nobody attacks and no ability
 * fires**. Their movement allowances are different - the opening gives a
 * battlefield unit one move for the whole phase, a postmatch gives five
 * crossings and three walks home for the one turn - so anything about how
 * much may move asks the narrower predicate.
 */
export function isSetupTurn(ply: number): boolean {
  return isInitialization(ply) || isPostmatch(ply);
}

/**
 * What to tell someone who tried to strike on a turn given to setting out.
 *
 * Two turns refuse a blow for two different reasons, and saying "the opening"
 * on turn 14 would send the player looking at a phase that ended at turn 3.
 * Lives here rather than at the call sites so the server's copy has one thing
 * to mirror.
 *
 * Total, not partial: a ply that refuses no blow gets `''`. Asked the other
 * way round - "not the opening, so a postmatch" - it would answer `Nobody
 * attacks in the postmatch` for every playable turn of every phase, which is
 * exactly the reading a caller without a guard would take. (It did exactly
 * that when the extra turn was a phase's initialization.)
 */
export function noAttackMessage(ply: number): string {
  if (isPostmatch(ply)) return 'Nobody attacks in the postmatch';
  if (isInitialization(ply)) return 'Nobody attacks in the opening';
  return '';
}

// How many units a side may bring out of its reserve in a postmatch, and walk
// home in a setup turn, are config: rules.postmatchEntries and
// rules.homecomingsPerSetupTurn (see ruleOf).

/**
 * Overtime's three stretches, and what each takes off a commander at the end
 * of that side's turn.
 *
 * Real damage, and a commander on that much HP dies of it. The toll climbs so
 * that a match neither side can win on the board still ends: **1 a turn, then
 * 3, then 5 on the last turn**, and a king who walks into it on five or less
 * does not walk out. *The owner, 24 Sep 2026: "the 3 and 5 is DAMAGE TAKEN TO
 * KING"*. A match still standing after it goes to black,
 * and both engines end it there - see `scheduleEnding` in match-score.ts.
 *
 * `turns` are full turns - white's hand-over and black's - counted forward
 * from overtime's first, which gives turns 37-44, 45-49 and 50 on the shipped
 * schedule. Counted forward rather than written down, because a written-down
 * turn number is exactly what went wrong last time: `OVERTIME_LAST_TURN` was
 * the literal 50, the extra turn each numbered phase gained (an initialization
 * at its start then, a postmatch at its end now - either way one more turn a
 * phase) pushed overtime from turn 34 to turn 37, and the literal stayed where
 * it was and quietly shortened overtime by three turns.
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
  { name: 'Overtime 1', turns: 8, toll: 1, moves: 1 },
  { name: 'Overtime 2', turns: 5, toll: 3, moves: 2 },
  { name: 'Overtime 3', turns: 1, toll: 5, moves: 3 },
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
 * Past the last turn it is the last stretch rather than `null`. Both engines
 * end the match as turn 50 is played out (`scheduleEnding` in match-score.ts),
 * so no game reaches it by playing; a position built past it - a saved game,
 * a test - still pays the heaviest toll rather than quietly none at all.
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
 * the first stretch and dies on his first turn of the second.
 */
export function overtimeTollOver(ply: number, turns: number): number {
  let sum = 0;
  for (let i = 0; i < turns; i++) sum += overtimeTollAt(ply + i * PLIES_PER_TURN);
  return sum;
}

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

/**
 * What each phase pays, as first hand-overs: `from` is where its points rate
 * starts - the opening from its first turn, each numbered phase from its
 * **halftime**, overtime from its first turn - and `start` is its first turn,
 * where its `grant` is paid. On the shipped schedule the rates are 1 from turn
 * 1, 1 from turn 9, 2 from turn 20, 3 from turn 31 and nothing from turn 37.
 * Read off the schedule rather than written down, so a phase that moves
 * carries its rate with it; worked out once, the schedule being fixed.
 */
const POINT_RATES: { from: number; rate: number; start: number; grant: number }[] = PHASES.map(
  (phase, index) => {
    const first = phaseStartTurn(index);
    // The first turn not before the halftime, by `beforeHalftime`'s own test
    // (`turn < first + turns / 2`) - so an odd phase breaks where it does.
    const turn = phase.halftime ? Math.ceil(first + phase.turns / 2) : first;
    return {
      from: (turn - 1) * PLIES_PER_TURN + 1, rate: phase.points,
      start: (first - 1) * PLIES_PER_TURN + 1, grant: phase.grant,
    };
  });

/**
 * What a side's own turns have paid it in points by `ply` - the hand-over
 * about to be played, which counts, since a turn pays at its start: each
 * turn's rate, and each phase's `grant` once the side has begun a turn in it.
 *
 * The rate changes at each halftime (`POINT_RATES`), so this walks the rates
 * and counts how many of that side's hand-overs fall under each, which is a
 * difference of two `handOversBy` at its ends - the same shape
 * `panelMoversSince` uses to count a side's turns between two plies.
 * Overtime pays nothing, however long a position built past it runs.
 *
 * What one turn pays - the room's live award - is this at the turn's ply less
 * this at the ply before, so the grant and the rate come from one sum.
 */
export function turnPointsBy(color: 'white' | 'black', ply: number): number {
  const played = Math.max(0, ply);
  const begun = handOversBy(color, played);
  let points = 0;
  POINT_RATES.forEach(({ from, rate, start, grant }, i) => {
    if (grant && begun > handOversBy(color, start - 1)) points += grant;
    if (played < from) return;
    const to = i + 1 < POINT_RATES.length ? Math.min(played, POINT_RATES[i + 1].from - 1) : played;
    points += (handOversBy(color, to) - handOversBy(color, from - 1)) * rate;
  });
  return points;
}

/**
 * The first full turn of a phase. For a numbered phase that is its first turn
 * of play - its one extra turn is its postmatch, at the other end. (The
 * opening's first turn is a setup turn like the rest of it.) Counted in spans,
 * so an earlier phase's postmatch pushes this along too.
 */
function phaseStartTurn(index: number): number {
  let turn = 1;
  for (let i = 0; i < index; i++) turn += phaseSpan(PHASES[i]);
  return turn;
}

/**
 * Whether a turn falls before its phase's break - or in a phase that has no
 * break to fall either side of. The opening and overtime are the two of
 * those, so they are always "before".
 *
 * Play starts on the phase's first turn, so the break is half its ten turns
 * on from there. A postmatch comes after all ten, which puts it on the far
 * side of the break: it reads as *not* before the halftime. So anything that
 * means "the played first half" already leaves it out, and it is the other
 * half's readers that have to ask about it first - `stageAt`, which would
 * otherwise call it one more turn of the halftime.
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
 * **Only the played first half of a numbered phase.** Not the opening, not a
 * phase's postmatch, and not overtime: the owner's rule is that the wrap
 * belongs to the half before the halftime and to nothing else. On the shipped
 * schedule that is turns 4-8, 15-19 and 26-30, and no others.
 *
 * `beforeHalftime` alone used to be the whole answer, and it said yes for
 * every phase that has no break to fall either side of - which quietly
 * included the opening and the whole of overtime. The scoring-phase and
 * halftime conditions are spelled out because each refuses turns the other
 * does not. The postmatch one refuses nothing more today - `beforeHalftime`
 * already shuts it now that it sits after the break - and is kept anyway: it
 * says what the rule is rather than leaning on where the postmatch happens to
 * fall.
 */
export function isWrapOpen(ply: number): boolean {
  return isScoringPhase(ply) && !isPostmatch(ply) && beforeHalftime(ply);
}

/**
 * Whether units may come out of the reserve onto the board - the three arrows
 * on each side's reserve, pointing in.
 *
 * Open on any setup turn and through a phase's halftime half; shut through the
 * played first half and through overtime. On the shipped schedule that is
 * turns 1-3, 9-14, 20-25 and 31-36 - each halftime half running straight on
 * into the postmatch that closes its phase.
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
 * 1-3, 14, 25, and 36 on - Phase 3's postmatch running straight on into
 * overtime.
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
 * Where the match is, as a name: `Initialization`, `Phase 1`, `Phase 1
 * Halftime`, `Phase 1 Postmatch`, ... , `Overtime 1`, `Overtime 2`,
 * `Overtime 3`. A phase that breaks in the middle is two stages, and the
 * second takes the halftime's name - the same name the history header counts
 * down to, so the two agree on what to call it. One that closes with a
 * postmatch is a third, on the same terms. Overtime breaks twice more, again
 * on the same terms.
 */
export function stageAt(ply: number): string {
  const phase = phaseAt(ply);
  if (isPostmatch(ply)) return `${phase.name} Postmatch`;
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
    // Play starts on the phase's first turn, so the break is half its ten on.
    if (phase.halftime) {
      out.push({ turn: end + phase.turns / 2, next: `${phase.name} Halftime` });
    }
    end += phase.turns;
    if (phase.postmatch) {
      // A postmatch is one more gear change, at the phase's own end: into it
      // once the ten are played, and out of it into whatever follows one turn
      // later - which the block below announces, from the end it now sits at.
      out.push({ turn: end, next: `${phase.name} Postmatch` });
      end += 1;
    }
    const following = PHASES[i + 1];
    // The phase that runs out the match announces itself in the overtime block
    // below, in the name of its FIRST STRETCH rather than its own: the match
    // arrives in `Overtime 1`, and a countdown to a bare `Overtime` would name
    // something `stageAt` never says.
    if (following && Number.isFinite(following.turns)) {
      out.push({ turn: end, next: following.name });
    }
  });
  // Overtime's own gear changes, including the one into it: the loop above
  // returns before the phase that runs out the match, so this is where all
  // three stretches are announced. The toll climbs twice inside overtime, and
  // a turn where the damage goes up is as much a change to count down to as a
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
 * of the opening, so it looks past Phase 1, which it is about to hand over
 * to, and reads `5 Until Phase 1 Halftime`. The postmatch that closes each
 * phase is counted to as well, and the same rule carries the countdown over
 * it: turn 12 reads `1 Until Phase 1 Postmatch`, and turn 13 - the last of
 * the play, handing over to the postmatch - already reads `1 Until Phase 2`.
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
