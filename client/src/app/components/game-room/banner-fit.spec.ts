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

  // Where on the ladder an answer is: full, compact, a smaller banner, two lines.
  const rung = (r: { compact: boolean; fit: number; lines: number }) =>
    r.lines === 2 ? 3 : r.fit < 1 ? 2 : r.compact ? 1 : 0;

  function sweep(score: string) {
    const seen: number[] = [];
    for (let width = 1600; width >= 260; width -= 20) {
      const { head, banner } = header(width, score);
      const got = fitHeader(head, banner);
      seen.push(rung(got));
      // It never goes further than it has to, and what it claims fits, fits.
      expect(head.classList.contains('header-compact')).withContext(`${width}px`).toBe(got.compact);
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

  it('comes all the way back when the room returns', () => {
    const { head, banner } = header(300, LONG_SCORE);
    expect(fitHeader(head, banner).fit).toBeLessThan(1);
    head.style.width = '3000px';
    expect(fitHeader(head, banner)).toEqual({ compact: false, fit: 1, lines: 1 });
    expect(head.classList.contains('header-compact')).toBeFalse();
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
