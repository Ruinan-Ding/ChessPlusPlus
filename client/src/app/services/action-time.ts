let last = 0;

/** Preserve ordering between room actions and panel steps, even in the same millisecond. */
export function actionTime(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}
