import { fitHeader } from './banner-fit';

/**
 * The header's ladder, measured the way the room measures it: a header of the
 * room's shape, laid out for real in the test browser, narrowed a step at a
 * time. What is asserted is the order it gives way in and that whatever it
 * settles on fits - not pixel widths, which belong to the fonts.
 */
describe('fitHeader', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  const LONG_SCORE = '(🚩 99 − 💀 99) ×3 = 297 (+ 297 + 297 = 891)';

  function header(width: number, score: string) {
    host.innerHTML = `
      <style>
        .h { display: flex; flex-wrap: nowrap; gap: 8px; width: ${width}px; font: 16px Arial, sans-serif; }
        .h.header-compact .label-long { display: none; }
        .h.header-stacked { flex-wrap: wrap; }
        .h.header-stacked .b { order: 1; flex-basis: 100%; }
        .t, .a { flex: 0 0 auto; white-space: nowrap; }
        .b { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center;
             gap: 16px; white-space: nowrap; font-weight: 800; font-size: calc(var(--banner-fit, 1) * 32px); }
        .phase-score { flex: 1 1 0; font-size: max(12px, 0.55em); font-weight: 700;
                       white-space: normal; line-height: 1.2; }
      </style>
      <header class="h">
        <span class="t">Game Room</span>
        <div class="b"><span class="phase-score">${score}</span><span>YOUR TURN - PHASE 1</span><span
          class="phase-score">${score}</span></div>
        <span class="a"><span class="label-long">Configure </span>Setup Leave<span class="label-long"> Room</span></span>
      </header>`;
    return { head: host.querySelector<HTMLElement>('.h')!, banner: host.querySelector<HTMLElement>('.b')! };
  }

  // Where on the ladder an answer is: full, compact, a smaller banner, two
  // lines, and a row of its own.
  const rung = (r: { compact: boolean; stacked: boolean; fit: number; lines: number }) =>
    r.stacked ? 4 : r.lines === 2 ? 3 : r.fit < 1 ? 2 : r.compact ? 1 : 0;

  function sweep(score: string) {
    const seen: number[] = [];
    for (let width = 1600; width >= 260; width -= 20) {
      const { head, banner } = header(width, score);
      const got = fitHeader(head, banner);
      seen.push(rung(got));
      // It never goes further than it has to, and what it claims fits, fits.
      expect(head.classList.contains('header-compact')).withContext(`${width}px`).toBe(got.compact);
      expect(head.classList.contains('header-stacked')).withContext(`${width}px`).toBe(got.stacked);
      if (got.fit > 0.5) {
        expect(banner.scrollWidth).withContext(`${width}px`).toBeLessThanOrEqual(banner.clientWidth + 1);
        for (const s of Array.from(banner.querySelectorAll<HTMLElement>('.phase-score'))) {
          const line = parseFloat(getComputedStyle(s).lineHeight);
          expect(s.clientHeight).withContext(`${width}px`).toBeLessThanOrEqual(got.lines * line + 1);
        }
      }
    }
    return seen;
  }

  it('gives way in order - the words around the banner first - and fits at every width', () => {
    const seen = sweep('🚩 3 − 💀 1 = 2');
    // Narrower never climbs back up the ladder.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    // Full size while there is room, compact before any shrinking, and a
    // short score shrinks the banner rather than wrapping.
    expect(seen[0]).toBe(0);
    expect(seen).toContain(1);
    expect(seen).toContain(2);
    expect(seen.indexOf(1)).toBeLessThan(seen.indexOf(2));
  });

  it('lets a long score take a second line rather than shrink the turn to nothing', () => {
    const seen = sweep(LONG_SCORE);
    expect(seen).toContain(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('gives the banner a row of its own last, and it fits there', () => {
    // A tablet's width with the longest scores: in the row beside the title
    // and the buttons they ran to four lines. Stacked, two at most - sweep()
    // checks every width it settles on.
    const seen = sweep(LONG_SCORE);
    expect(seen).toContain(4);
    expect(seen.indexOf(3)).toBeLessThan(seen.indexOf(4));
  });

  it('shrinks a banner with no scores to fit, where nothing wraps to give it away', () => {
    // No score is shown on some turns, and then the turn is the whole line:
    // too long for the row, only the size can give.
    let shrank = false;
    for (let width = 900; width >= 260; width -= 20) {
      const { head, banner } = header(width, '');
      banner.querySelectorAll('.phase-score').forEach(s => s.remove());
      const got = fitHeader(head, banner);
      shrank ||= got.fit < 1;
      if (got.fit > 0.5) {
        expect(banner.scrollWidth).withContext(`${width}px`).toBeLessThanOrEqual(banner.clientWidth + 1);
      }
    }
    expect(shrank).toBeTrue();
  });

  it('stacks from the start when told to, however wide, and still fits', () => {
    // The tabbed layout's header: two rows whatever the turn says, so the
    // panels under it do not move when it says something longer.
    const { head, banner } = header(3000, '🚩 3 − 💀 1 = 2');
    const got = fitHeader(head, banner, true);
    expect(got).toEqual({ compact: false, stacked: true, fit: 1, lines: 1 });
    expect(head.classList.contains('header-stacked')).toBeTrue();
    const narrow = header(420, LONG_SCORE);
    const squeezed = fitHeader(narrow.head, narrow.banner, true);
    expect(squeezed.stacked).toBeTrue();
    expect(narrow.banner.scrollWidth).toBeLessThanOrEqual(narrow.banner.clientWidth + 1);
  });

  it('puts the scores under the turn when even a row of its own is too narrow', () => {
    // A phone upright: stacked, the scores still squeezed to four lines
    // beside the turn. Under it, half the width each, they fit.
    host.innerHTML = '';
    const { head, banner } = header(360, LONG_SCORE);
    const style = document.createElement('style');
    style.textContent = '.b.banner-scores-below { flex-wrap: wrap; } '
      + '.b.banner-scores-below > span:not(.phase-score) { order: 0; flex-basis: 100%; } '
      + '.b.banner-scores-below .phase-score { order: 1; }';
    host.appendChild(style);
    const got = fitHeader(head, banner, true);
    expect(got.scoresBelow).toBeTrue();
    expect(banner.classList.contains('banner-scores-below')).toBeTrue();
    expect(banner.scrollWidth).toBeLessThanOrEqual(banner.clientWidth + 1);
    for (const s of Array.from(banner.querySelectorAll<HTMLElement>('.phase-score'))) {
      expect(s.clientHeight).toBeLessThanOrEqual(got.lines * parseFloat(getComputedStyle(s).lineHeight) + 1);
    }
    // And it comes off again once there is room.
    head.style.width = '3000px';
    expect(fitHeader(head, banner, true).scoresBelow).toBeUndefined();
    expect(banner.classList.contains('banner-scores-below')).toBeFalse();
  });

  it('keeps a one-row header at its full-size line when the banner shrinks to fit', () => {
    // 9px came off the header at 1536x864 on a stage long enough to shrink
    // the banner, and the columns under it moved with the turn.
    //
    // The width is found, not fixed: where the long stage first has to shrink
    // depends on the fonts the browser has. It was a fixed 1300px, which only
    // shrank with Windows' emoji - with a Linux runner's fonts the stage fit
    // there whole, and CI failed on every push.
    const SHORT = 'YOUR TURN - PHASE 1';
    const LONG = "OPPONENT'S TURN - 4:59 - PHASE 3 POSTMATCH";
    for (let width = 1600; width >= 260; width -= 20) {
      const { head, banner } = header(width, '🚩 3 − 💀 1 = 2');
      const turn = banner.children[1];
      turn.textContent = LONG;
      const shrunk = fitHeader(head, banner);
      expect(shrunk.stacked).withContext(`${width}px: stacked before it shrank`).toBeFalse();
      if (shrunk.stacked) return;
      if (shrunk.fit === 1) continue;

      turn.textContent = SHORT;
      expect(fitHeader(head, banner).fit).withContext(`${width}px`).toBe(1);
      const full = head.getBoundingClientRect().height;
      turn.textContent = LONG;
      expect(fitHeader(head, banner).fit).withContext(`${width}px`).toBeLessThan(1);
      expect(head.getBoundingClientRect().height).withContext(`${width}px`).toBe(full);
      return;
    }
    fail('the long stage never had to shrink');
  });

  describe('held - the tabbed layouts\' header', () => {
    // The room's banner at its 12px unit: 24px, in the font's own line, the
    // rows under it with no gap between them. fitHeader sizes the box.
    function held(width: number, score: string) {
      const got = header(width, score);
      const style = document.createElement('style');
      style.textContent = '.h .b { font-size: calc(var(--banner-fit, 1) * 24px); letter-spacing: 0.08em; } '
        + '.h.header-held .b { align-content: center; } '
        + '.b.banner-scores-below { flex-wrap: wrap; row-gap: 0; } '
        + '.b.banner-scores-below > span:not(.phase-score) { order: 0; flex-basis: 100%; } '
        + '.b.banner-scores-below .phase-score { order: 1; } '
        + '.b .turn-short { display: none; } .b.banner-short .turn-long { display: none; } '
        + '.b.banner-short .turn-short { display: inline; } '
        + '.b.banner-turn-wraps > span:not(.phase-score) { white-space: normal; flex-shrink: 1; min-width: 0; }';
      host.appendChild(style);
      return got;
    }
    const TURNS = ['YOUR TURN - INITIALIZATION', "OPPONENT'S TURN - PHASE 1",
      "OPPONENT'S TURN - 4:59 - PHASE 2 HALFTIME", 'YOUR TURN - OVERTIME 3'];
    const SCORES = ['🚩 0 − 💀 0 = 0', '🚩 10 − 💀 0 = 10', '(🚩 14 − 💀 3) ×2 = 22 (+ 12 = 34)', LONG_SCORE];

    it('keeps the header one height whatever the banner says, and fits inside it', () => {
      // A phone upright (390px, less the room's padding) and a tablet (820).
      for (const [width, below] of [[366, true], [796, false]] as const) {
        const { head, banner } = held(width, SCORES[0]);
        const heights = new Set<number>();
        for (const turn of TURNS) {
          for (const score of SCORES) {
            banner.children[1].textContent = turn;
            banner.querySelectorAll('.phase-score').forEach(s => { s.textContent = score; });
            const got = fitHeader(head, banner, true, 0.5, below);
            const at = `${width}px, "${turn}", "${score}"`;
            heights.add(Math.round(head.getBoundingClientRect().height));
            expect(head.classList.contains('header-held')).withContext(at).toBeTrue();
            expect(banner.scrollWidth).withContext(at).toBeLessThanOrEqual(banner.clientWidth + 1);
            expect(banner.scrollHeight).withContext(at).toBeLessThanOrEqual(banner.clientHeight + 1);
            expect(got.fit).withContext(at).toBeGreaterThanOrEqual(0.5);
          }
        }
        expect([...heights]).withContext(`${width}px`).toHaveSize(1);
      }
    });

    it('gives way in the turn\'s own words, then a second line, then under 12px - in that order', () => {
      // The longest online stage was wider than a 360-390px phone at 12px and
      // ran into the margin. "OPPONENT'S TURN" stays whenever the line fits.
      const order = ['whole', 'short', 'wrapped', 'under'];
      const seen: string[] = [];
      for (let width = 520; width >= 160; width -= 10) {
        const { head, banner } = held(width, '🚩 0 − 💀 0 = 0');
        const turn = banner.children[1] as HTMLElement;
        turn.innerHTML = '<span class="turn-long">OPPONENT\'S</span><span class="turn-short">THEIR</span>'
          + ' TURN - 4:59 - PHASE 3 POSTMATCH';
        const got = fitHeader(head, banner, true, 0.5, true);
        const at = `${width}px`;
        seen.push(got.fit < 0.5 ? 'under' : got.wrapped ? 'wrapped' : got.short ? 'short' : 'whole');
        expect(banner.classList.contains('banner-short')).withContext(at).toBe(!!got.short);
        expect(banner.classList.contains('banner-turn-wraps')).withContext(at).toBe(!!got.wrapped);
        const shown = (sel: string) => getComputedStyle(turn.querySelector(sel)!).display !== 'none';
        expect(shown('.turn-long')).withContext(at).toBe(!got.short);
        expect(shown('.turn-short')).withContext(at).toBe(!!got.short);
        if (got.fit > 0.41) {
          expect(banner.scrollWidth).withContext(at).toBeLessThanOrEqual(banner.clientWidth + 1);
          expect(banner.scrollHeight).withContext(at).toBeLessThanOrEqual(banner.clientHeight + 1);
        }
      }
      for (let i = 1; i < seen.length; i++) {
        expect(order.indexOf(seen[i])).withContext(seen.join(' ')).toBeGreaterThanOrEqual(order.indexOf(seen[i - 1]));
      }
      for (const step of order) expect(seen).withContext(seen.join(' ')).toContain(step);
    });

    it('puts the scores under the turn from the start when told to, however short they are', () => {
      const { head, banner } = held(3000, '🚩 0 − 💀 0 = 0');
      expect(fitHeader(head, banner, true, 0.5, true)).toEqual(
        { compact: false, stacked: true, scoresBelow: true, fit: 1, lines: 1 });
      expect(banner.classList.contains('banner-scores-below')).toBeTrue();
      // In a taller box: the turn's line and two of the scores'.
      const under = parseFloat(banner.style.height);
      // And off again, told otherwise, in the shorter one.
      expect(fitHeader(head, banner, true).scoresBelow).toBeUndefined();
      expect(banner.classList.contains('banner-scores-below')).toBeFalse();
      expect(parseFloat(banner.style.height)).toBeLessThan(under);
    });

    it('goes compact for the title and the buttons alone, never for the banner', () => {
      // The buttons used to say "Setup" whenever the banner did not fit at
      // full size - in a row of its own, where their words give it nothing.
      const roomy = held(600, LONG_SCORE);
      expect(fitHeader(roomy.head, roomy.banner, true).compact).toBeFalse();
      expect(roomy.head.classList.contains('header-compact')).toBeFalse();
      const tight = held(250, '');
      expect(fitHeader(tight.head, tight.banner, true).compact).toBeTrue();
      expect(tight.head.classList.contains('header-compact')).toBeTrue();
    });
  });

  it('comes all the way back when the room returns', () => {
    const { head, banner } = header(300, LONG_SCORE);
    expect(fitHeader(head, banner).fit).toBeLessThan(1);
    head.style.width = '3000px';
    expect(fitHeader(head, banner)).toEqual({ compact: false, stacked: false, fit: 1, lines: 1 });
    expect(head.classList.contains('header-compact')).toBeFalse();
    expect(head.classList.contains('header-stacked')).toBeFalse();
    expect(banner.style.getPropertyValue('--banner-fit')).toBe('1');
  });

  it('fits a header with no banner - before the match - by its words alone', () => {
    const { head, banner } = header(200, '');
    banner.remove();
    const got = fitHeader(head, null);
    expect(got.compact).toBeTrue();
    expect(got.fit).toBe(1);
  });
});
