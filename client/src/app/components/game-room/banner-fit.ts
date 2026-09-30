/**
 * Fits the room's header to its one row, and says how: whether it had to go
 * compact, and the fraction of full size the turn banner settled on (written
 * to the banner as `--banner-fit`, which its font sizes multiply by).
 *
 * What the banner holds changes all match long: the turn, the clock, the
 * stage, and two scores that grow a bracket per banked phase. A size chosen
 * for the longest of those would shrink every short one on every window, and
 * a size chosen for the common case ran the long one over the buttons. So it
 * is measured, the way the timer app on ruinan-ding.com fits its rows, and it
 * gives way in the same order - the words around the thing before the thing:
 *
 * 1. Everything at full size, each score on one line.
 * 2. Compact: the buttons and the connection status say the same in fewer
 *    words ("Setup", "Leave", "Connected"); still full size, one line.
 * 3. The banner up to a fifth smaller, the scores still on one line.
 * 4. The scores on up to two lines, and the banner as big as that allows,
 *    down to `least`. Late in a match a score with a multiplier and three
 *    banked phases runs to forty-odd characters, which no laptop header
 *    holds on one line beside the turn. Two lines of it are no taller than
 *    the banner's own line; a third would take height off both columns.
 * 5. Stacked: the banner leaves the title and the buttons its row and takes
 *    one of its own under them, the whole width, and goes through 1-4 again
 *    there. It costs the columns a row, so in the three columns it comes
 *    last, where the sweep never finds it needed.
 * 6. Scores under the turn: in its own row the banner is still too narrow -
 *    a phone upright - so the turn keeps a line to itself and the two scores
 *    go side by side on the line under it, half the width each, where they
 *    had been squeezed beside the turn to four lines apiece. Through 1-4 once
 *    more there (`.banner-scores-below`).
 * 7. The short word: "THEIR TURN" for "OPPONENT'S TURN" (`.banner-short`),
 *    through 1-4 again. Only here - the turn's own words are the thing the
 *    banner is for, and they give way after everything around them.
 * 8. In the held box (below), the turn may take a second line
 *    (`.banner-turn-wraps`), which the box's fixed height makes safe; a
 *    one-row header's would grow, so there it is skipped.
 * 9. Under the 12px floor, the turn's line alone - the scores keep theirs -
 *    as far as `DEEPEST`. Nothing else at the size the text is at, on a phone
 *    in the longest online stages: "OPPONENT'S TURN - 4:59 - PHASE 3
 *    POSTMATCH" was wider than a 360-390px phone at 12px, and ran into the
 *    margin. The owner, 29 Sep 2026, offered the three as choices: "do it
 *    all" - so each in turn: a shorter word keeps the line whole at 12px, a
 *    second line keeps the 12px, and only then does the size give.
 *
 * **Held** (`alwaysStacked`): the header of the tabbed and stacked layouts
 * under 1100px wide. It is stacked from the start - under ~1000px even the
 * opening's banner wants a row of its own - and nothing the banner says moves
 * anything outside it, because there the window decides, never the words:
 * - The banner is a box of fixed height, worked out from the turn's line at
 *   full size, and 1-4 and 6 all happen inside it: the height is one more
 *   thing that has to fit. It used to grow and shrink with the words - a
 *   phone's board went from 106px down to 142px over a match, and at some
 *   stages between one turn and the next. Found playing on an emulated
 *   phone, 29 Sep 2026.
 * - Narrow enough that the scores will need to go under the turn before the
 *   match is out (`scoresBelow`, a phone upright), they go there from the
 *   start (`.banner-scores-below` from the first), in a taller box.
 * - Compact or not is the first row's own question - does the title fit
 *   beside the buttons - and not the banner's: in a row of its own, a
 *   shorter "Setup" gives it nothing, and the buttons changed their words
 *   with the stage.
 *
 * Overrunning is `scrollWidth > clientWidth`: the banner is centred, and a
 * centred row spills both ways, so scrollWidth sees only the half past the
 * right-hand edge - enough to answer yes or no, which is all a bisection asks.
 * The same goes for the held box's height and scrollHeight.
 */
/** Two lines of a score at its 12px floor: .phase-score is max(12px, 0.55em), line-height 1.2. */
const SCORE_FLOOR_LINES = 2 * 1.2 * 12;

/**
 * The turn's share of its full-size line in a phone's box when the scores
 * under it take two lines. It costs a phone about 18px against the opening's
 * banner, and no board: the board is as wide as the phone, and the height
 * comes off the tabs' panel.
 */
const NARROW_TURN = 0.65;

/** The last step's floor (9): the turn at 9.6px at the 12px unit, a fifth under `least`'s 12. */
const DEEPEST = 0.4;

export function fitHeader(header: HTMLElement, banner: HTMLElement | null, alwaysStacked = false,
    least = 0.5, scoresBelow = false,
): {
  compact: boolean; stacked: boolean; scoresBelow?: boolean; short?: boolean; wrapped?: boolean;
  fit: number; lines: number;
} {
  const set = (fit: number) => banner?.style.setProperty('--banner-fit', String(fit));
  const scores = banner ? Array.from(banner.querySelectorAll<HTMLElement>('.phase-score')) : [];
  const fits = (lines: number) => header.scrollWidth <= header.clientWidth + 1
    && (!banner || banner.scrollWidth <= banner.clientWidth + 1)
    && (!alwaysStacked || !banner || banner.scrollHeight <= banner.clientHeight + 1)
    && scores.every(score => {
      const line = parseFloat(getComputedStyle(score).lineHeight);
      return !(line > 0) || score.clientHeight <= lines * line + 1;
    });
  // The largest fraction in [low, 1] that fits, or null if not even `low`.
  const largest = (low: number, lines: number): number | null => {
    set(low);
    if (!fits(lines)) return null;
    let good = low;
    let bad = 1;
    // Six halvings leave it within 1% of the largest size that fits.
    for (let i = 0; i < 6; i++) {
      const mid = (good + bad) / 2;
      set(mid);
      if (fits(lines)) good = mid;
      else bad = mid;
    }
    set(good);
    return good;
  };

  // 7-9, once every size and arrangement above has failed: the words, then
  // the turn's own line, then the floor. Wrapping is for the held box only,
  // where it cannot move anything; a one-row header's line would grow.
  type Fitted = { fit: number; lines: number; short: true; wrapped?: true };
  const lastResort = (canWrap: boolean): Fitted => {
    banner!.classList.add('banner-short');
    const short = shrink();
    if (short) return { short: true, ...short };
    if (canWrap) {
      banner!.classList.add('banner-turn-wraps');
      const wrapped = shrink();
      if (wrapped) return { short: true, wrapped: true, ...wrapped };
    }
    const under = largest(DEEPEST, 2);
    return { short: true, ...(canWrap ? { wrapped: true } : {}), fit: under ?? DEEPEST, lines: 2 };
  };

  // 2-4, in whichever row the banner is in.
  const shrink = (): { fit: number; lines: number } | null => {
    set(1);
    if (fits(1)) return { fit: 1, lines: 1 };
    const oneLine = largest(0.8, 1);
    if (oneLine !== null) return { fit: oneLine, lines: 1 };
    set(1);
    if (fits(2)) return { fit: 1, lines: 2 };
    const twoLines = largest(least, 2);
    return twoLines === null ? null : { fit: twoLines, lines: 2 };
  };

  header.classList.remove('header-compact', 'header-stacked', 'header-held');
  banner?.classList.remove('banner-scores-below', 'banner-short', 'banner-turn-wraps');
  set(1);
  // The turn's line at full size: one line whatever it says, and as tall as
  // its font makes it - weight 800 is Arial Black on Windows, 1.41 of the
  // size, and Arial Bold elsewhere, 1.15. The header is pinned to it, so a
  // banner shrunk to fit its words never takes height with it: 9px came off
  // the header at 1536x864 on one stage, and the columns moved up and down
  // with the turn. Measured rather than written in the stylesheet, where it
  // could only be the font's line over the fit - rounded at each size, so
  // it still moved by a pixel or two.
  let line = 0;
  if (banner) {
    banner.style.minHeight = '';
    banner.style.height = '';
    const turn = Array.from(banner.children).find(child => !child.classList.contains('phase-score'));
    line = turn ? parseFloat(getComputedStyle(turn).height) || 0 : 0;
    banner.style.minHeight = `${line}px`;
  }
  if (alwaysStacked) {
    // The title and the buttons on one row, the banner out of it: does it fit?
    if (banner) banner.style.display = 'none';
    const compact = header.scrollWidth > header.clientWidth + 1;
    if (banner) banner.style.display = '';
    header.classList.add('header-stacked', 'header-held');
    header.classList.toggle('header-compact', compact);
    if (!banner) return { compact, stacked: true, fit: 1, lines: 1 };
    // The box: beside the turn, its line or two lines of the scores at their
    // floor, whichever is more - what it took on its biggest turns. Under it
    // (a phone upright), two lines of them and the turn at NARROW_TURN of its
    // size; one line of them leaves the turn its full size.
    banner.style.height = `${scoresBelow ? NARROW_TURN * line + SCORE_FLOOR_LINES
      : Math.max(line, SCORE_FLOOR_LINES)}px`;
    banner.classList.toggle('banner-scores-below', scoresBelow);
    const held = shrink();
    if (held) return { compact, stacked: true, ...(scoresBelow ? { scoresBelow } : {}), ...held };
    if (!scoresBelow) {
      banner.classList.add('banner-scores-below');
      const below = shrink();
      if (below) return { compact, stacked: true, scoresBelow: true, ...below };
    }
    return { compact, stacked: true, scoresBelow: true, ...lastResort(true) };
  }
  if (fits(1)) return { compact: false, stacked: false, fit: 1, lines: 1 };
  header.classList.add('header-compact');
  if (fits(1) || !banner) return { compact: true, stacked: false, fit: 1, lines: 1 };
  const inRow = shrink();
  if (inRow) return { compact: true, stacked: false, ...inRow };
  header.classList.add('header-stacked');
  const stacked = shrink();
  if (stacked) return { compact: true, stacked: true, ...stacked };
  banner.classList.add('banner-scores-below');
  const below = shrink();
  if (below) return { compact: true, stacked: true, scoresBelow: true, ...below };
  return { compact: true, stacked: true, scoresBelow: true, ...lastResort(false) };
}
