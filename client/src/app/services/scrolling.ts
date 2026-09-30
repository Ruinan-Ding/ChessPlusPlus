/**
 * Where a scroll stands, for the room, the lobby and the ⋮ menu. Each had its
 * own copy of these, and the copies had drifted: a reader 10px from the foot
 * of a chat was followed in the lobby and left behind in the room.
 */

/** How near its foot a log may be and still count as at its newest line. */
export const NEWEST_SLACK = 24;

/**
 * Whether a log is at its newest line - or not drawn yet (no height), where
 * following it loses nothing.
 */
export function atNewest(log: HTMLElement | null | undefined): boolean {
  return !log || !log.clientHeight || log.scrollHeight - log.scrollTop - log.clientHeight < NEWEST_SLACK;
}

/**
 * `fn` once the frame after the next is under way: after the change detection
 * that draws what just changed. That detection is itself put off to a frame
 * (eventCoalescing, app.config.ts), scheduled after whoever asks - so a single
 * frame on could come first, and a log scrolled to its foot before the new
 * line was drawn under it.
 */
export function afterDraw(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * The element a scroll event scrolled, if it holds `anchor` - if the scroll
 * moved it. Null for a scroll anywhere else: History or a chat keeping to its
 * newest line is a scroll, and a menu or a bubble shut by any scroll at all
 * shut while it was being read.
 */
export function scrollerMoving(event: Event, anchor: Element | null | undefined): Element | null {
  const scroller = event.target === document ? document.documentElement : event.target as Element | null;
  return anchor && scroller?.contains?.(anchor) ? scroller : null;
}
