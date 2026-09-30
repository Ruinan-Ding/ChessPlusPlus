import { closeUserMenu, openUserMenu } from './user-menu';

/**
 * The ⋮ menu beside a player, drawn on the body in real Chrome: where it
 * stands, what shuts it, and that its words are words.
 */
describe('the ⋮ menu', () => {
  let dots: HTMLButtonElement;
  const menu = () => document.querySelector<HTMLElement>('.user-context-menu');
  // A ⋮ at (left, top), as the lobby and the room draw one.
  const place = (left: number, top: number) => {
    dots.style.cssText = `position: fixed; left: ${left}px; top: ${top}px; width: 24px; height: 24px`;
  };
  const press = () => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    dots.dispatchEvent(event);
    return event;
  };
  let open: (label: string, enabled?: boolean, pick?: () => void) => void;

  beforeEach(() => {
    dots = document.createElement('button');
    dots.className = 'action-button';
    dots.textContent = '⋮';
    document.body.appendChild(dots);
    open = (label, enabled = true, pick = () => {}) => {
      dots.onclick = (e) => openUserMenu(e, label, enabled, pick);
      press();
    };
  });
  afterEach(() => {
    closeUserMenu();
    dots.remove();
  });

  it('opens under its ⋮, drawn as a menu, 24px or more to press', () => {
    place(100, 100);
    open('Invite');
    const m = menu()!;
    const r = m.getBoundingClientRect();
    expect(r.left).toBeCloseTo(100, 0);
    expect(r.top).toBeCloseTo(128, 0);
    // The global stylesheet's look reaches it: a white panel with a border,
    // where the lobby's own stylesheet never could.
    const style = getComputedStyle(m);
    expect(style.position).toBe('fixed');
    expect(style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(style.borderTopStyle).toBe('solid');
    expect(m.querySelector('button')!.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
  });

  it('stays inside the window, however long its words, and goes over the ⋮ near the foot', () => {
    // A phone's ⋮, at the right-hand edge.
    place(window.innerWidth - 30, 100);
    open('Invite pending. Wait for response or timeout.', false);
    let r = menu()!.getBoundingClientRect();
    expect(r.right).toBeLessThanOrEqual(window.innerWidth - 8 + 0.5);
    expect(r.left).toBeGreaterThanOrEqual(8 - 0.5);
    closeUserMenu();

    place(100, window.innerHeight - 30);
    open('Invite');
    r = menu()!.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight - 30 + 0.5);
  });

  it('writes its words as words', () => {
    place(100, 100);
    open('<b>not markup</b>', false);
    expect(menu()!.querySelector('b')).toBeNull();
    expect(menu()!.textContent).toBe('<b>not markup</b>');
  });

  it('invites on its entry, and not from a reason there is none', () => {
    place(100, 100);
    const pick = jasmine.createSpy('pick');
    open('Invite', true, pick);
    menu()!.querySelector('button')!.click();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();

    const none = jasmine.createSpy('none');
    open("Can't invite while in a game room", false, none);
    menu()!.querySelector('button')!.click();
    expect(none).not.toHaveBeenCalled();
  });

  it('shuts on a press elsewhere, on Escape, and on its own ⋮ pressed again', () => {
    place(100, 100);
    open('Invite');
    // A press in the menu keeps it.
    menu()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu()).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu()).toBeNull();

    open('Invite');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu()).toBeNull();
    // Back where the keyboard was.
    expect(document.activeElement).toBe(dots);

    // Its own ⋮: a press on it is not "elsewhere", and its click shuts it.
    open('Invite');
    dots.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu()).not.toBeNull();
    press();
    expect(menu()).toBeNull();
    // Pressed once more, it opens again.
    press();
    expect(menu()).not.toBeNull();
  });

  it('stays through a scroll that leaves its ⋮ be, follows one that moves it, shuts once it is gone', () => {
    // A chat keeping to its newest line is a scroll, and any scroll shut it:
    // a busy lobby shut the menu before Invite could be pressed.
    const elsewhere = document.createElement('div');
    const log = document.createElement('div');
    log.style.cssText = 'position: fixed; left: 50px; top: 50px; width: 200px; height: 100px; overflow: auto';
    const lines = document.createElement('div');
    lines.style.cssText = 'height: 400px; padding-top: 20px';
    document.body.append(elsewhere, log);
    log.appendChild(lines);
    dots.style.cssText = 'display: block; width: 24px; height: 24px';
    lines.appendChild(dots);
    try {
      open('Invite');
      const under = () => dots.getBoundingClientRect().bottom + 4;
      expect(menu()!.getBoundingClientRect().top).toBeCloseTo(under(), 0);

      elsewhere.dispatchEvent(new Event('scroll'));
      expect(menu()).not.toBeNull();

      log.scrollTop = 30;
      log.dispatchEvent(new Event('scroll'));
      expect(menu()).not.toBeNull();
      expect(menu()!.getBoundingClientRect().top).toBeCloseTo(under(), 0);

      log.scrollTop = 200;
      log.dispatchEvent(new Event('scroll'));
      expect(menu()).toBeNull();
    } finally {
      elsewhere.remove();
      log.remove();
    }
  });

  it('is one menu at a time, and gone once shut from outside', () => {
    place(100, 100);
    open('Invite');
    open('Invite');
    // Its own ⋮ twice: shut.
    expect(document.querySelectorAll('.user-context-menu').length).toBe(0);
    open('Invite');
    const other = document.createElement('button');
    other.className = 'action-button';
    document.body.appendChild(other);
    try {
      other.onclick = (e) => openUserMenu(e, 'Invite', true, () => {});
      other.click();
      expect(document.querySelectorAll('.user-context-menu').length).toBe(1);
    } finally {
      other.remove();
    }
    closeUserMenu();
    expect(menu()).toBeNull();
  });
});
