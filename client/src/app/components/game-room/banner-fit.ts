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
 *    last, where the sweep never finds it needed. The tabbed layout under
 *    1100px wide (`alwaysStacked`) starts here: under ~1000px even the
 *    opening's banner wants it, and a header that went from one row to two as
 *    the turn's words changed length would move every panel under it, every
 *    turn - so there it is the window's width that decides, never the words.
 * 6. Scores under the turn: in its own row the banner is still too narrow -
 *    a phone upright - so the turn keeps a line to itself and the two scores
 *    go side by side on the line under it, half the width each, where they
 *    had been squeezed beside the turn to four lines apiece. Through 1-4 once
 *    more there (`.banner-scores-below`).
 *
 * Overrunning is `scrollWidth > clientWidth`: the banner is centred, and a
 * centred row spills both ways, so scrollWidth sees only the half past the
 * right-hand edge - enough to answer yes or no, which is all a bisection asks.
 */
export function fitHeader(header: HTMLElement, banner: HTMLElement | null, alwaysStacked = false,
    least = 0.5): { compact: boolean; stacked: boolean; scoresBelow?: boolean; fit: number; lines: number } {
  const set = (fit: number) => banner?.style.setProperty('--banner-fit', String(fit));
  const scores = banner ? Array.from(banner.querySelectorAll<HTMLElement>('.phase-score')) : [];
  const fits = (lines: number) => header.scrollWidth <= header.clientWidth + 1
    && (!banner || banner.scrollWidth <= banner.clientWidth + 1)
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

  header.classList.remove('header-compact');
  header.classList.toggle('header-stacked', alwaysStacked);
  banner?.classList.remove('banner-scores-below');
  set(1);
  if (fits(1)) return { compact: false, stacked: alwaysStacked, fit: 1, lines: 1 };
  header.classList.add('header-compact');
  if (fits(1) || !banner) return { compact: true, stacked: alwaysStacked, fit: 1, lines: 1 };
  if (!alwaysStacked) {
    const inRow = shrink();
    if (inRow) return { compact: true, stacked: false, ...inRow };
    header.classList.add('header-stacked');
  }
  const stacked = shrink();
  if (stacked) return { compact: true, stacked: true, ...stacked };
  banner.classList.add('banner-scores-below');
  const below = shrink();
  if (below) return { compact: true, stacked: true, scoresBelow: true, ...below };
  set(least);
  return { compact: true, stacked: true, scoresBelow: true, fit: least, lines: 2 };
}
