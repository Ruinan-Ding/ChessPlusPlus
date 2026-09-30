import { NEWEST_SLACK, afterDraw, atNewest, scrollerMoving } from './scrolling';

describe('where a scroll stands', () => {
  it('counts a log at its newest within a few pixels of its foot - or not drawn yet', () => {
    const log = (scrollTop: number, clientHeight = 100) => ({ scrollHeight: 500, scrollTop, clientHeight }) as HTMLElement;
    expect(atNewest(log(400))).toBeTrue();
    // The room's rule and the lobby's are one now: 10px up is still at the foot.
    expect(atNewest(log(390))).toBeTrue();
    expect(atNewest(log(400 - NEWEST_SLACK))).toBeFalse();
    expect(atNewest(log(0))).toBeFalse();
    expect(atNewest(log(0, 0))).toBeTrue();
    expect(atNewest(null)).toBeTrue();
  });

  it('waits for the frame after the next - after the change detection that draws', () => {
    // Coalesced change detection is put off to a frame scheduled after
    // whoever asks; one frame on, the line it waited for could be undrawn.
    const frames: FrameRequestCallback[] = [];
    spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => frames.push(cb));
    const ran = jasmine.createSpy('after');
    afterDraw(ran);
    frames.shift()!(0);
    expect(ran).not.toHaveBeenCalled();
    frames.shift()!(0);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('names the scroller only when the scroll moved the anchor', () => {
    const panel = document.createElement('div');
    const log = document.createElement('div');
    const anchor = document.createElement('button');
    panel.appendChild(anchor);
    const at = (target: EventTarget) => {
      const e = new Event('scroll');
      Object.defineProperty(e, 'target', { value: target });
      return scrollerMoving(e, anchor);
    };
    expect(at(panel)).toBe(panel);
    expect(at(log)).toBeNull();
    // The page's own scroll moves everything on it.
    document.body.appendChild(panel);
    try {
      expect(at(document)).toBe(document.documentElement);
    } finally {
      panel.remove();
    }
    expect(scrollerMoving(new Event('scroll'), null)).toBeNull();
  });
});
