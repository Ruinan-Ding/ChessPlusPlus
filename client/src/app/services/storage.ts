/**
 * Browser storage a browser is allowed to refuse.
 *
 * `localStorage` and `sessionStorage` *throw* in Safari private browsing and
 * in Chrome with site data blocked - not on a missing key, but on the access
 * itself. Unguarded in the constructor of a `providedIn: 'root'` service that
 * throw takes the whole app down: every component injecting it fails to
 * instantiate and nothing renders. A remembered preference is never worth
 * that, so a refusal reads as "nothing stored" and a write is dropped.
 */

type Kind = 'local' | 'session';

function store(kind: Kind): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

export function readStore(kind: Kind, key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStore(kind: Kind, key: string, value: string): void {
  try {
    store(kind)?.setItem(key, value);
  } catch {
    /* full, or refused - the value was a convenience either way */
  }
}

export function removeStore(kind: Kind, key: string): void {
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* nothing was stored to begin with */
  }
}
