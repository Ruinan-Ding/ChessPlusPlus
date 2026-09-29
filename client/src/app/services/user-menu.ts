/**
 * The ⋮ menu beside a player, in the lobby and the game room: one entry -
 * Invite, or the reason there is none - under the ⋮, or where a right-click
 * landed.
 *
 * It is built on the page's body, outside every component, so its look is in
 * the global stylesheet (styles.scss). The lobby's own stylesheet had it, and
 * Angular scopes a component's styles to the elements of its own template: the
 * menu drew as a bare browser button, no panel and 21px tall, and the room's
 * had no style anywhere. The two were one function written twice; this is it
 * once. It stays inside the window whatever the length of its words (a phone's
 * ⋮ is at the right-hand edge, and "Invite pending. Wait for response or
 * timeout." ran off it), and shuts on a press anywhere else, Escape, a scroll
 * or a resize - it is fixed where the ⋮ was, and would be left behind.
 */
const GUTTER = 8;

let shutOpen: (() => void) | null = null;
let openFor: Element | null = null;

export function openUserMenu(event: MouseEvent, label: string, enabled: boolean, pick: () => void): void {
  event.preventDefault();
  const anchor = ((event.target as Element | null)?.closest?.('.action-button') ?? null) as HTMLElement | null;
  // The ⋮ that opened it, pressed again: shut, not opened afresh.
  const again = !!anchor && openFor === anchor && !!shutOpen;
  closeUserMenu();
  if (again) return;

  const menu = document.createElement('div');
  menu.className = 'user-context-menu';
  menu.setAttribute('role', 'menu');
  const item = document.createElement('button');
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  // Words, not markup.
  item.textContent = label;
  item.disabled = !enabled;
  menu.appendChild(item);
  document.body.appendChild(menu);

  // Placed once it has a size: under the ⋮ (over it when there is no room
  // below), or at the click; then drawn in to the window's gutter.
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let x: number;
  let y: number;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4 + height > window.innerHeight - GUTTER ? r.top - 4 - height : r.bottom + 4;
  } else {
    x = event.clientX;
    y = event.clientY + height > window.innerHeight - GUTTER ? event.clientY - height : event.clientY;
  }
  menu.style.left = `${Math.max(GUTTER, Math.min(x, window.innerWidth - GUTTER - width))}px`;
  menu.style.top = `${Math.max(GUTTER, Math.min(y, window.innerHeight - GUTTER - height))}px`;

  const onPress = (e: Event) => {
    const target = e.target as Node | null;
    // Its own ⋮ answers on its click, above.
    if (target && (menu.contains(target) || anchor?.contains(target))) return;
    shut();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    shut();
    anchor?.focus();
  };
  const shut = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onPress, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', shut);
    window.removeEventListener('scroll', shut, true);
    shutOpen = null;
    openFor = null;
  };
  item.addEventListener('click', () => {
    shut();
    if (enabled) pick();
  });
  document.addEventListener('pointerdown', onPress, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', shut);
  window.addEventListener('scroll', shut, true);
  shutOpen = shut;
  openFor = anchor;
  if (enabled) item.focus({ preventScroll: true });
}

/** Shut the menu if one is open - and on leaving the screen that opened it. */
export function closeUserMenu(): void {
  shutOpen?.();
}
