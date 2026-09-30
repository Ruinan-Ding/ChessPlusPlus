// The game room at every window size it is meant to hold, measured in a real
// headless Chrome: is anything scaled, cut short, past the window's edge,
// too small to read or too small to hit - and no two controls on top of each
// other, and no words run out of their button. Before the match as well as
// in it; every tab, the right-hand rail's Lobby tab with two dozen online,
// and what the board lays over itself on a phone ("Tap again to strike",
// "Whole board"). The numbers drawn on the board are reported at the size
// they come out, not failed: they are the board's scale, and a pinch is
// what reads them on a phone.
//
//   ng serve --port 4201                                  # in another shell
//   LAYOUT_URL=http://localhost:4201 node scripts/layout-sweep.mjs
//
// Then the other screens - the login, the lobby, the setup - at desktop,
// tablet and phone sizes: nothing past the screen's edge or scrolling
// sideways, no text under 12px and no control under 24px. They are pages of
// prose and forms, and may scroll down.
//
// CHROME overrides where Chrome is looked for. Exits non-zero if any size the
// room is meant to hold fails a check: the three columns from 1180x730 up,
// and on a computer's window short of that, scaled down to 72% (their type's
// floor reported, not failed); the board and one column of tabs (roomLayout
// 'tabbed') on a landscape touch screen, or a computer window smaller still,
// every tab of it; and the board over the tabs (roomLayout 'stacked') on an
// upright tablet, every tab of it, with touch emulated - before the match, in
// it, and with an offer of a draw waiting. No unit's numbers on another's.
// Phones either way up, whose tallest tab may scroll, and the sizes still
// scaled - a little short of the columns - are measured and printed (' -- '),
// and failed only for what cannot be reached at all: Ready, Start or an
// offer's answer out of sight, or any control cut off by a box that does not
// scroll.
//
// Why a sweep and not a spec: the room's layout is CSS - clamp()s on the
// window, a unit every size is written in, flex columns - and none of that
// exists in a spec's detached fixture. The way to know it holds is to draw it
// at the sizes people play at and look, which is what this does. Modelled on
// the layout sweeps of the timer app on ruinan-ding.com.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_BASE = (process.env.LAYOUT_URL ?? 'http://localhost:4200').replace(/\/$/, '');
const CHROME = process.env.CHROME ?? (
  process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome'
);
const PORT = Number(process.env.LAYOUT_DEBUG_PORT ?? 9333);

// The smallest window the room lays out in three columns unscaled:
// ROOM_MIN_WIDTH x ROOM_MIN_HEIGHT in game-room.component.ts. Kept in step by
// hand - if the two disagree, the sizes between them are either failed for
// being scaled or never asserted at all.
const FLOOR = { w: 1180, h: 730 };

// Desktop and laptop windows, by the viewport a browser leaves rather than
// the screen: a 1920x1080 screen is about 1920x950 inside Chrome, and a
// 1366x768 laptop about 1366x650. (1280x720, 1280x705, 1200x720 and 1180x705
// were here until the floor went from 705 to 730 - their ability panel back in
// the left column, 29 Sep 2026 - and are reported now, scaled a little.)
const ASSERTED = [
  [3440, 1440], [2560, 1440], [1920, 1200], [1920, 1080], [1920, 950], [1904, 946],
  [1680, 1050], [1600, 900], [1536, 864], [1536, 740], [1440, 900], [1440, 780],
  [1366, 768], [1280, 800], [1180, 820], [1180, 730],
];
// The board and one column of tabs: touch screens on their side, from
// 1024x768 (an iPad, Unit pinned) down to 505px tall; under 560 the tallest
// tabs may scroll a little (recordShort). Each size is measured on every
// tab, touch emulated.
const TABBED = [
  [1366, 620], [1280, 600], [1024, 768], [1024, 690], [1024, 600], [1000, 640], [960, 540],
  [900, 520], [800, 505],
];
// A computer's window short of the columns keeps them, scaled, down to 72%
// (ROOM_DESKTOP_ZOOM - the owner: "the game is unplayable with anything
// tucked away"): these are the columns, their type under 12px and reported,
// everything else held as ever. Smaller still, the tabs after all.
const SMALL_WINDOWS = [[1366, 620], [1280, 600], [1024, 768], [1024, 600], [960, 540]];
const TINY_WINDOWS = [[900, 520], [800, 505]];
// The board over the tabs, on an upright tablet: an iPad Pro, an iPad Air, a
// 10.2" iPad, an iPad mini, and the older 768x1024. Touch emulated, every tab.
const STACKED = [[1024, 1366], [820, 1180], [810, 1080], [744, 1133], [768, 1024]];
// Measured, not failed: the columns scaled a little (a laptop just short of
// 730), and phones either way up, whose tallest tab may scroll - though on
// a phone too, what the Room tab's cue leads to has to be in sight, and no
// control may be cut off, and those are failed. A phone's by what its
// browser leaves, not its screen: an
// iPhone's Safari with both its bars, an Android's Chrome, a small Android.
// (Its screen's own size was what the sweep had measured, and at that
// height nothing scrolled that scrolls in the hand.)
const REPORTED = [[1366, 690], [1366, 650], [1280, 720], [1280, 705], [1200, 720], [1180, 705], [1100, 700]];
const PHONES = [[932, 370], [844, 340], [740, 330]];
const PHONES_UPRIGHT = [[430, 739], [412, 804], [390, 664], [360, 640]];
// The room before a match, at a few of each: the columns, the tabs, the
// board over the tabs, and a phone each way up (reported only - `want` null).
const PREGAME = [
  [1920, 1080, 'columns', false], [1180, 730, 'columns', false],
  [1024, 768, 'tabbed', true], [1024, 600, 'tabbed', true], [800, 505, 'tabbed', false],
  [820, 1180, 'stacked', true], [768, 1024, 'stacked', true],
  [844, 340, null, true], [390, 664, null, true],
];
// An offer of a draw waiting, at the least size of each layout and on a
// phone each way up: a strip over the board, which gives up the height.
const DRAW_OFFER = [
  [1180, 730, 'columns', false], [1366, 768, 'columns', false], [1920, 950, 'columns', false],
  [1024, 768, 'tabbed', true], [800, 505, 'tabbed', false], [768, 1024, 'stacked', true],
  [844, 340, null, true], [390, 664, null, true], [360, 640, null, true],
];
// The other screens, at a desktop, a laptop, tablets and phones either way up.
const SCREENS = ['login', 'lobby', 'setup'];
const SCREEN_SIZES = [
  [1920, 1080, false], [1366, 768, false], [1024, 768, true], [820, 1180, true],
  [844, 390, true], [390, 844, true], [360, 740, true],
];

const MIN_TEXT = 12;
const MIN_TARGET = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port = PORT) {
  const profile = mkdtempSync(join(tmpdir(), 'cpp-layout-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  // The profile goes once Chrome has let it go. Removed the moment it was
  // killed, Chrome still held it, and every run left one in the temp folder;
  // the retries wait up to a second on the busy files a Windows exit leaves.
  const kill = () => {
    chrome.kill();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* Chrome still has it */ }
  };
  // Until close() is handed back, the caller has nothing to shut it with: a
  // Chrome slow to start, or a port already taken, left a headless Chrome
  // listening on it and its profile in the temp folder.
  let ws;
  try {
    let wsUrl;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!wsUrl) await sleep(100);
    }
    if (!wsUrl) throw new Error(`no Chrome on ${port} (CHROME=${CHROME})`);
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  } catch (e) {
    try { ws?.close(); } catch { /* gone */ }
    kill();
    throw e;
  }
  let id = 1;
  const pending = new Map();
  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    if (pending.has(x.id)) { pending.get(x.id)(x.result ?? x.error); pending.delete(x.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };
  const close = () => {
    try { ws.close(); } catch { /* gone */ }
    kill();
  };
  try {
    await send('Page.enable');
    await send('Runtime.enable');
  } catch (e) {
    close();
    throw e;
  }
  return { send, ev, close };
}

// A solo game, started: the room with both columns full and a board.
// `beforeStart` is run on the room while it waits for Start Game.
async function openSoloRoom(send, ev, beforeStart = async () => {}) {
  const click = (label) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);
  await send('Page.navigate', { url: `${URL_BASE}/login` });
  await sleep(2500);
  await ev(`localStorage.setItem('username', 'Sweep'); sessionStorage.setItem('cpp.offline', '1'); 1`);
  await send('Page.navigate', { url: `${URL_BASE}/lobby` });
  // Waited for rather than slept on: a dev server still compiling, or a slow
  // machine, takes longer than any fixed pause chosen on a fast one.
  const waitToClick = async (label, where) => {
    for (let i = 0; i < 40; i++) {
      if (await click(label)) return;
      await sleep(250);
    }
    throw new Error(`no ${label} button in the ${where}`);
  };
  await waitToClick('Single Player', 'lobby');
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('.start-game-btn')`)); i++) await sleep(250);
  await sleep(1000);
  await beforeStart();
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 });
  await waitToClick('Start Game', 'room');
  await sleep(5000);
  if (!(await ev(`!!document.querySelector('app-game-board svg')`))) throw new Error('the board never drew');
  // One line of chat, so the chat has an entry to be judged by below. A solo
  // game answers its own messages.
  await ev(`(() => {
    const box = document.querySelector('.chat-input input');
    box.value = 'Sweep: one line of chat';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.chat-input button').click();
    return 1;
  })()`);
  await sleep(800);
}

// Everything measured on the page, in on-screen pixels. Only what a player
// can see counts: a hidden element, or one scrolled out of sight inside a log
// that scrolls (History, the chats, the rosters, the effects list), is not
// judged for where it sits.
const PROBE = `(() => {
  const room = document.querySelector('.game-room-container');
  const zoom = parseFloat(room.style.zoom || '1') || 1;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const LOGS = '.history-panel .panel-body, .game-room-messages, .lobby-messages, .users-list, .player-list, .effects-list';
  const inLog = (el) => !!el.parentElement?.closest(LOGS);
  const r1 = (n) => Math.round(n * 10) / 10;
  const faults = [];

  // Scaled at all?
  const scaled = zoom < 0.999;

  // The page itself never scrolls.
  const de = document.scrollingElement;
  if (de.scrollWidth > de.clientWidth + 1) faults.push('the page scrolls sideways');
  if (de.scrollHeight > de.clientHeight + 1) faults.push('the page scrolls down');

  // Each column holds its contents without scrolling, and the header its
  // row without the banner overrunning.
  for (const [sel, name] of [['.match-panels', 'left column'], ['.side-rail', 'right column']]) {
    const el = room.querySelector(sel);
    if (el && el.scrollHeight > el.clientHeight + 1) faults.push(name + ' needs ' + (el.scrollHeight - el.clientHeight) + 'px more height');
  }
  const header = room.querySelector(':scope > header');
  if (header.scrollWidth > header.clientWidth + 1) faults.push('header overruns by ' + (header.scrollWidth - header.clientWidth) + 'px');
  const banner = header.querySelector('.turn-indicator');
  if (banner && banner.scrollWidth > banner.clientWidth + 1) faults.push('turn banner overruns its row');
  // Any other box that is shorter than what it holds: one whose overflow is
  // hidden has cut something off, and one that scrolls has put it out of
  // sight. Only the logs are meant to scroll (LOGS, above), and the board
  // draws itself to fit.
  for (const el of room.querySelectorAll('*')) {
    if (!shown(el) || el.closest('app-game-board') || el.matches(LOGS + ', .match-panels, .side-rail')) continue;
    const s = getComputedStyle(el);
    if (!/(auto|scroll|hidden)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
    const what = String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.') || el.tagName.toLowerCase();
    faults.push(what + (s.overflowY === 'hidden' ? ' clips ' : ' scrolls away ') + (el.scrollHeight - el.clientHeight) + 'px');
  }

  // A log may scroll, but it has to have room for an entry whole - its
  // newest, or for the roster its first, which is you: History that shows
  // half a line, a chat that shows its heading and its input and no
  // message, or "Online Users" over nobody, is a panel nobody can read.
  for (const [log, entry, name, first] of [
    ['.history-panel .panel-body', '.history-item', 'History'],
    ['.game-room-messages', '.message-item', 'the chat'],
    ['.effects-list', '.effect-row, .effect-empty', 'the effects list'],
    ['.users-list', '.user-item', 'the online users', true],
    ['.lobby-messages', '.message-item', 'the lobby chat'],
  ]) {
    const box = room.querySelector(log);
    const all = box ? [...box.querySelectorAll(entry)] : [];
    const last = first ? all[0] : all.pop();
    if (!box || !last || !shown(box)) continue;
    const s = getComputedStyle(box);
    const room_ = box.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    if (room_ + 1 < last.offsetHeight) faults.push(name + ' has room for ' + Math.round(room_) + 'px of a ' + last.offsetHeight + 'px entry');
  }

  // Nothing cut short with an ellipsis.
  for (const el of room.querySelectorAll('*')) {
    if (!shown(el) || inLog(el)) continue;
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) faults.push('cut short: "' + el.textContent.trim().slice(0, 40) + '"');
  }

  // Every control on screen, whole, and big enough to hit.
  const buttons = [...room.querySelectorAll('button')].filter((b) => shown(b) && !inLog(b) && !b.closest('app-game-board'));
  const nameOf = (el) => (el.textContent.trim().slice(0, 18) || el.title || el.className || el.tagName).toString().slice(0, 18);
  let smallest = null;
  for (const b of buttons) {
    const r = b.getBoundingClientRect();
    const label = nameOf(b) || '?';
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) faults.push('off screen: ' + label);
    const side = Math.min(r.width, r.height);
    if (!smallest || side < smallest.side) smallest = { side: r1(side), label };
    // Its words inside it, not out past its edge over whatever is beside it.
    // The words themselves, by a range over them: a button's scrollWidth
    // counts its decorations too - the paired abilities' connector reaches
    // past the edge on purpose.
    const words = document.createRange();
    words.selectNodeContents(b);
    const wr = words.getBoundingClientRect();
    const out = Math.max(wr.right - r.right, r.left - wr.left);
    if (wr.width > 0 && out > 1) faults.push('"' + label + '" runs ' + Math.round(out) + 'px out of its button');
  }

  // No two things to press - or read, over the board - on top of each other.
  // A column can hold every control and still have one pushed across the
  // next: "End Turn (TAB)" wider than its half of a row ran over Show Hex.
  // Each by the part of it in sight: one a scrolling box has put out of view
  // is that box's fault, reported above, not an overlap.
  // A box that is not drawn (display: contents - the columns, under the
  // tabs) clips nothing, whatever its overflow says; and each axis is
  // clipped only where its own overflow is.
  const inSight = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'contents') continue;
      const c = a.getBoundingClientRect();
      if (s.overflowX !== 'visible') [left, right] = [Math.max(left, c.left), Math.min(right, c.right)];
      if (s.overflowY !== 'visible') [top, bottom] = [Math.max(top, c.top), Math.min(bottom, c.bottom)];
    }
    return { left, top, right, bottom };
  };
  // What the Room tab's cue sends a player there for - Ready, Start, an
  // offer's Accept and Decline - whole in sight wherever it is drawn, on a
  // phone as much as anywhere: a cue that leads to a tab where the button
  // is below the fold of its box is no cue.
  const wanted = [...room.querySelectorAll('.ready-section button, .draw-offer-banner button')]
    .filter((b) => shown(b) && !b.disabled)
    .filter((b) => {
      const r = b.getBoundingClientRect();
      const v = inSight(b);
      return v.right - v.left < r.width - 1 || v.bottom - v.top < r.height - 1;
    })
    .map((b) => 'out of sight: ' + nameOf(b));
  // And no control cut off by a box that does not scroll: one that scrolls
  // can be scrolled to, one that hides what does not fit has put it out of
  // reach - the turn timer's 30s and 10m past both edges of a phone's board.
  // Per axis, as far as the first box that really scrolls: what is past its
  // edge is scrolled to, and whatever clips above it clips the box, not the
  // control. A box set to scroll that has nothing to scroll (the timer's row,
  // as wide as its choices) is no refuge.
  const clipped = (el) => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    let [doneX, doneY] = [false, false];
    for (let a = el.parentElement; a && a !== document.body && !(doneX && doneY); a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'contents') continue;
      const c = a.getBoundingClientRect();
      if (!doneX && /auto|scroll/.test(s.overflowX) && a.scrollWidth > a.clientWidth + 1) doneX = true;
      else if (!doneX && /hidden|clip/.test(s.overflowX)) [left, right] = [Math.max(left, c.left), Math.min(right, c.right)];
      if (!doneY && /auto|scroll/.test(s.overflowY) && a.scrollHeight > a.clientHeight + 1) doneY = true;
      else if (!doneY && /hidden|clip/.test(s.overflowY)) [top, bottom] = [Math.max(top, c.top), Math.min(bottom, c.bottom)];
    }
    return { left, top, right, bottom };
  };
  const cutOff = [...room.querySelectorAll('button, input, select, textarea')]
    .filter((el) => shown(el) && !inLog(el))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const v = clipped(el);
      return v.right - v.left < r.width - 1 || v.bottom - v.top < r.height - 1;
    })
    .map((el) => 'cut off: ' + (nameOf(el) || el.value || el.type));
  faults.push(...wanted, ...cutOff);
  // What fails on a phone too, where the rest is only reported: whatever
  // the player cannot reach at all.
  const unreachable = [...wanted, ...cutOff];
  const pressable = [...room.querySelectorAll('button, input, select, textarea, .armed-hint')]
    .filter((el) => shown(el) && !inLog(el));
  const boxes = pressable.map((el) => [el, inSight(el)]).filter(([, r]) => r.right - r.left > 1 && r.bottom - r.top > 1);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, ra] = boxes[i];
      const [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 1 && h > 1) faults.push('"' + nameOf(a) + '" over "' + nameOf(b) + '" by ' + Math.round(w) + 'x' + Math.round(h) + 'px');
    }
  }

  // Text: the smallest a player has to read, and how much sits under 12px.
  const texts = [];
  const walker = document.createTreeWalker(room, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el || el.closest('svg') || !shown(el)) continue;
    texts.push({ px: parseFloat(getComputedStyle(el).fontSize) * zoom, t: n.textContent.trim().slice(0, 24) });
  }
  texts.sort((a, b) => a.px - b.px);
  const small = texts.filter((t) => t.px < ${MIN_TEXT} - 0.05);

  // The board: how much of the window it has, and how big a hex comes out.
  const area = room.querySelector('.game-area').getBoundingClientRect();
  const hexes = [...room.querySelectorAll('app-game-board polygon')].slice(0, 300).map((p) => p.getBoundingClientRect().width);
  const u = parseFloat(getComputedStyle(room).getPropertyValue('font-size'));
  // And what is written on it - the numbers on the units and the hexes -
  // at the size it comes out on screen. Drawn to the board's scale, so a
  // phone's are small; a pinch is what makes them readable, and this is
  // reported, not failed. Anything the board says to the player that has to
  // be read at once is laid over it instead, and held to 12px above.
  const boardTexts = [...room.querySelectorAll('app-game-board svg text')].slice(0, 400)
    .map((t) => t.getBoundingClientRect().height).filter((hgt) => hgt > 0);
  // And no unit's numbers, arrows or pips on another unit's: each face is its
  // own hex's (FACE_SCALE). By the ink - a digit is about 0.72em of the line
  // box's 1.15 - and on screen, which is the board's own scale at any size.
  const faces = [...room.querySelectorAll('app-game-board svg text.stat, app-game-board svg text.effect-arrow, app-game-board svg text.vet-star')]
    .map((t) => {
      const r = t.getBoundingClientRect();
      const mid = (r.top + r.bottom) / 2, half = r.height * 0.72 / 1.15 / 2;
      return { g: t.closest('g'), l: r.left, r: r.right, t: mid - half, b: mid + half, w: r.width };
    }).filter((f) => f.w > 0.5);
  let touching = 0;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const [p, q] = [faces[i], faces[j]];
      if (p.g === q.g) continue;
      if (Math.min(p.r, q.r) - Math.max(p.l, q.l) > 0.3 && Math.min(p.b, q.b) - Math.max(p.t, q.t) > 0.3) touching++;
    }
  }
  if (touching) faults.push(touching + " labels on a unit's face touch another unit's");

  return {
    // The zoom to the hundredth: to the tenth, a 960x540 window's 0.74 read
    // 0.7 and failed a floor of 0.72 it clears.
    scaled, zoom: Math.round(zoom * 100) / 100, unit: r1(u), faults,
    textMin: r1(texts[0]?.px ?? 0), textMinWhat: texts[0]?.t ?? '', textUnder: small.length, textCount: texts.length,
    smallest,
    targetsUnder: buttons.filter((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height) * 1 < ${MIN_TARGET} - 0.5; }).length,
    boardShare: Math.round(100 * area.width * area.height / (innerWidth * innerHeight)),
    hex: r1(Math.max(0, ...hexes)),
    boardText: r1(boardTexts.length ? Math.min(...boardTexts) : 0),
    bannerFit: banner ? r1(parseFloat(banner.style.getPropertyValue('--banner-fit') || '1')) : null,
    tabbed: room.classList.contains('tabbed'),
    stacked: room.classList.contains('stacked'),
    pinned: room.classList.contains('unit-pinned'),
    // Each tab by its name alone, without what its cue says (roomCue).
    tabs: [...room.querySelectorAll('.room-tabs button')].map((b) => b.firstChild.textContent.trim()),
    unreachable,
  };
})()`;

// The longest the banner gets: a clock, the last stage name, and both scores
// carrying a multiplier and three banked phases. Written straight into the
// DOM - the banner re-fits on any change to its text - then measured, and
// the page reloaded before the next size so Angular's own text comes back.
const LONG_BANNER = `(() => {
  const b = document.querySelector('.turn-indicator');
  if (!b) return false;
  const score = '(🚩 99 − 💀 99) ×3 = 297 (+ 297 + 297 = 891)';
  const [theirs, text, ours] = [b.querySelector('.phase-score.theirs'), b.querySelector('.turn-text'), b.querySelector('.phase-score.ours')];
  if (theirs) theirs.textContent = score;
  if (ours) ours.textContent = score;
  text.textContent = "OPPONENT'S TURN - 10:00 - PHASE 3 POSTMATCH";
  // And the connection status at its longest, beside the buttons: a solo
  // game says "Offline", a dropped socket a good deal more.
  const status = document.querySelector('app-connection-status span');
  if (status?.firstChild) status.firstChild.textContent = 'Disconnected';
  const rest = status?.querySelector('.status-rest');
  if (rest) rest.textContent = ' from Game Server';
  return true;
})()`;

// A roster of two dozen, through Angular's development hooks (ng serve): a
// solo game is offline and its Lobby tab lists nobody but you, and the
// roster is the one list whose length is anyone's guess.
// And a line of chat from somebody else, last, in both chats - one line, as
// the floor is for one: their lines carry a ⋮ button yours do not, and a
// solo game's own line was all the sweep had judged the chat's floor by.
const LONG_ROSTER = `(() => {
  const c = ng.getComponent(document.querySelector('app-game-room'));
  c.serverOnline = true;
  c.lobbyUsers = [{ username: 'Sweep', status: 'online' },
    ...Array.from({ length: 23 }, (_, i) => ({ username: 'Player ' + (i + 1), status: i % 3 ? 'online' : 'in-game' }))];
  const now = new Date().toISOString();
  c.gameRoomMessages = [...c.gameRoomMessages,
    { username: 'Opponent', content: 'Good luck', timestamp: now }];
  c.lobbyMessages = [...c.lobbyMessages,
    { username: 'Player 1', content: 'Hello all', timestamp: now, room: 'lobby' }];
  ng.applyChanges(c);
  return true;
})()`;

// An offer of a draw from the other side, put up and taken down.
const DRAW = (on) => `(() => {
  const c = ng.getComponent(document.querySelector('app-game-room'));
  if (${on}) c.gameState.applyDrawOffered('Opponent'); else c.gameState.clearDrawOffer();
  ng.applyChanges(c);
  return !!document.querySelector('.draw-offer-banner') === ${on};
})()`;

// What the board lays over itself on a phone: "Tap again to strike" over an
// armed target, and "Whole board" once a pinch has zoomed in. Both put up
// by hand - neither is a thing a sweep can pinch or tap its way to - and
// taken down again after.
const BOARD_OVERLAYS = (on) => `(() => {
  const b = ng.getComponent(document.querySelector('app-game-board'));
  if (${on}) {
    b.armedAttack = b.cells.find((c) => !c.panel && c.piece)?.key ?? null;
    b.boardZoom = 2;
    b.applyZoom();
  } else {
    b.armedAttack = null;
    b.fitBoard();
  }
  ng.applyChanges(b);
  return !!b.armedAttack === ${on};
})()`;

// A window of w x h - a phone's or a tablet's when `touch`: a touch screen,
// so the room's coarse-pointer rules apply (no keys named on its buttons).
// (A run is one or the other throughout - see the two runs below - so this
// never turns touch off in a tab it was on in.)
async function resize(send, w, h, touch = false) {
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
}

// A page other than the room: what runs past the screen's edge, and what
// text is under 12px.
const SCREEN_PROBE = `(() => {
  const de = document.scrollingElement;
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const faults = [];
  if (de.scrollWidth > de.clientWidth + 1) faults.push('the page scrolls sideways');
  const past = [...document.querySelectorAll('body *')].filter((el) => {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    return r.right > innerWidth + 1 || r.left < -1;
  }).map((el) => (el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]).slice(0, 30));
  if (past.length) faults.push("past the screen's edge: " + [...new Set(past)].slice(0, 5).join(', '));
  const small = [...document.querySelectorAll('body *')].filter((el) => shown(el)
    && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    && parseFloat(getComputedStyle(el).fontSize) < ${MIN_TEXT} - 0.05)
    .map((el) => el.textContent.trim().slice(0, 20));
  if (small.length) faults.push(small.length + ' text runs under ${MIN_TEXT}px: ' + small.slice(0, 3).join(' | '));
  // Every control big enough to hit, as in the room. A checkbox or a radio
  // is its label's too, and a link in a sentence is the sentence's size.
  const tiny = [...document.querySelectorAll('button, select, textarea, input')]
    .filter((el) => shown(el) && !['checkbox', 'radio', 'hidden'].includes(el.type))
    .filter((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) < ${MIN_TARGET} - 0.5; })
    .map((el) => (el.textContent.trim() || el.placeholder || el.tagName.toLowerCase()).slice(0, 18));
  if (tiny.length) faults.push(tiny.length + ' controls under ${MIN_TARGET}px: ' + tiny.slice(0, 4).join(' | '));
  return faults;
})()`;

async function measure(send, ev, w, h, touch = false) {
  await resize(send, w, h, touch);
  await sleep(700);
  return ev(PROBE);
}

let failed = 0;
let held = 0;
// Two runs, each in a Chrome of its own: a computer's sizes, then a touch
// screen's. Headless Chrome keeps a tab a touch screen once touch has been
// emulated in it - pointer: coarse and hover: none stay, turned off or
// reloaded - so a computer's window measured after a phone's was measured as
// a touch screen: no keys named on its buttons, and the tabs where a
// computer keeps the columns.
for (const touchPhase of [false, true]) {
const { send, ev, close } = await launch(PORT + (touchPhase ? 1 : 0));
const mine = (touch) => !!touch === touchPhase;
try {
  console.log(touchPhase ? '\n======== On a touch screen ========' : '======== On a computer ========');
  if (touchPhase) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const row = (label, w, h, m, bad, status = bad ? 'FAIL' : ' ok ') =>
    console.log(`${status} ${label.padEnd(9)} ${`${w}x${h}`.padEnd(10)} zoom ${String(m.zoom).padEnd(4)} unit ${String(m.unit).padEnd(5)}`
      + ` text ${String(m.textMin).padEnd(5)} (<12: ${String(m.textUnder).padStart(2)}) target ${String(m.smallest?.side ?? '-').padEnd(5)}`
      + ` hex ${String(m.hex).padEnd(5)} on it ${String(m.boardText).padEnd(4)} board ${m.boardShare}%`
      + (m.bannerFit !== null ? ` banner ${m.bannerFit}` : '')
      + (bad ? `\n       ${bad.join('\n       ')}` : ''));

  // The same checks for every layout, plus that each size got the layout it
  // is meant to: the columns unscaled from the floor up, the tabs below it
  // on a landscape window, the board over the tabs on a portrait one.
  const layoutOf = (m) => (m.stacked ? 'stacked' : m.tabbed ? 'tabbed' : 'columns');
  const judge = (m, w, h, want) => {
    const bad = [...m.faults];
    if (layoutOf(m) !== want) bad.push(`the ${layoutOf(m)} layout, at a size that should be the ${want}`);
    if (m.scaled) bad.push(`scaled to ${m.zoom} at a size the room should lay out unscaled`);
    if (m.textUnder) bad.push(`${m.textUnder} text runs under ${MIN_TEXT}px, smallest ${m.textMin}px ("${m.textMinWhat}")`);
    if (m.targetsUnder) bad.push(`${m.targetsUnder} controls under ${MIN_TARGET}px, smallest ${m.smallest.side}px ("${m.smallest.label}")`);
    return bad.length ? bad : null;
  };
  // The columns scaled on a computer's window: the layout and every fault
  // held; the type and the targets under their floors only reported, being
  // the trade the owner chose over tucking panels away.
  const judgeScaled = (m, w, h) => {
    const bad = [...m.faults];
    if (layoutOf(m) !== 'columns') bad.push(`the ${layoutOf(m)} layout, at a size that should be the columns, scaled`);
    if (!m.scaled || m.zoom < 0.72) bad.push(`scaled to ${m.zoom}, where it should be 0.72 or more and under 1`);
    return bad.length ? bad : null;
  };
  const record = (label, w, h, m, bad) => {
    if (bad) failed++; else held++;
    row(label, w, h, m, bad);
  };
  // Under 560px tall the tabs' column is at the unit's floor and has the Unit
  // panel's strip to hold as well - its two lines are what keep a unit's
  // numbers in sight while its panel is a tab - so the tallest tabs may
  // scroll a little there. That is reported (' -- '); all else is held.
  const SHORT = 560;
  const recordShort = (label, w, h, m, want) => {
    if (h >= SHORT) return record(label, w, h, m, judge(m, w, h, want));
    const scroll = m.faults.filter((f) => /scrolls away/.test(f));
    const bad = judge({ ...m, faults: m.faults.filter((f) => !/scrolls away/.test(f)) }, w, h, want);
    if (bad) { failed++; row(label, w, h, m, [...bad, ...scroll]); return; }
    held++;
    row(label, w, h, m, scroll.length ? scroll : null, scroll.length ? ' -- ' : ' ok ');
  };
  // A size that is reported: its faults printed (' -- '), and failed only for
  // what the player cannot reach - Ready, Start or an offer's answer out of
  // sight, or a control cut off by its box.
  const report = (label, w, h, m) => {
    if (m.unreachable.length) failed++; else held++;
    row(label, w, h, m, m.faults.length ? m.faults : null,
      m.unreachable.length ? 'FAIL' : m.faults.length ? ' -- ' : ' ok ');
  };
  // A tab, by its name - the strip's, or the right-hand rail's Game and
  // Lobby - whatever cue it is wearing.
  const clickIn = (strip, label) => ev(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(strip)})]
      .find((x) => x.firstChild?.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);
  const clickTab = (label) => clickIn('.room-tabs button', label);
  // The rail's Lobby tab - the roster and the lobby's chat - measured, and
  // back to Game.
  const lobbyTab = async (judgeIt) => {
    if (!(await clickIn('.rail-tabs button', 'Lobby'))) throw new Error('no Lobby tab in the rail');
    await sleep(250);
    judgeIt('lobby', await ev(PROBE));
    await clickIn('.rail-tabs button', 'Game');
  };
  // What the board lays over itself, measured with both up.
  const overlays = async (judgeIt) => {
    if (!(await ev(BOARD_OVERLAYS(true)))) throw new Error('nothing on the board to arm');
    await sleep(250);
    judgeIt('overlays', await ev(PROBE));
    await ev(BOARD_OVERLAYS(false));
  };
  // Every tab at one size, each measured as it shows - the Room tab's Lobby
  // as well - then the board's overlays.
  const eachTab = async (w, h, judgeIt, touch = false, withOverlays = true) => {
    const first = await measure(send, ev, w, h, touch);
    for (const tab of first.tabs.length ? first.tabs : ['-']) {
      if (tab !== '-') await clickTab(tab);
      await sleep(250);
      const m = await ev(PROBE);
      judgeIt(`${tab.toLowerCase()}`.slice(0, 9), m);
      if (tab === 'Room' || tab === '-') await lobbyTab(judgeIt);
    }
    if (withOverlays) await overlays(judgeIt);
    if (first.tabs.length) await clickTab(first.tabs[0]);
  };

  // Before the match: the mode picker where the board will be, Ready and
  // Start on the Room tab.
  const beforeStart = async () => {
    console.log(`The room before the game starts (${URL_BASE}):`);
    for (const [w, h, want, touch] of PREGAME.filter(([, , , t]) => mine(t))) {
      await eachTab(w, h, (tab, m) => (want ? record(tab, w, h, m, judge(m, w, h, want)) : report(tab, w, h, m)),
        touch, false);
    }
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: touchPhase });
  await openSoloRoom(send, ev, beforeStart);
  await ev(LONG_ROSTER);

  if (!touchPhase) {
  console.log(`\nThe three columns, at the start of a solo game, the rail's Lobby tab too:`);
  for (const [w, h] of ASSERTED) {
    await eachTab(w, h, (tab, m) => record(tab === '-' ? 'opening' : tab, w, h, m, judge(m, w, h, 'columns')));
  }
  console.log('\nA computer window short of the columns - the columns, scaled; floors reported:');
  for (const [w, h] of SMALL_WINDOWS) {
    await eachTab(w, h, (tab, m) => record(tab === '-' ? 'scaled' : tab, w, h, m, judgeScaled(m, w, h)));
  }
  console.log('\nA computer window smaller still - the board and one column of tabs, every tab:');
  for (const [w, h] of TINY_WINDOWS) {
    await eachTab(w, h, (tab, m) => recordShort(tab, w, h, m, 'tabbed'));
  }
  } else {
  console.log('\nThe board and one column of tabs on a touch screen, every tab:');
  for (const [w, h] of TABBED) {
    await eachTab(w, h, (tab, m) => recordShort(tab, w, h, m, 'tabbed'), true);
  }
  console.log('\nThe board over the tabs, on an upright tablet, every tab:');
  for (const [w, h] of STACKED) {
    await eachTab(w, h, (tab, m) => record(tab, w, h, m, judge(m, w, h, 'stacked')), true);
  }
  }
  console.log('\nAn offer of a draw waiting, over the board:');
  if (!(await ev(DRAW(true)))) throw new Error('the offer of a draw never showed');
  for (const [w, h, want, touch] of DRAW_OFFER.filter(([, , , t]) => mine(t))) {
    const m = await measure(send, ev, w, h, touch);
    if (want) record('offer', w, h, m, judge(m, w, h, want)); else report('offer', w, h, m);
  }
  await ev(DRAW(false));
  console.log('\nThe longest banner the match can show:');
  const everySize = [
    ...ASSERTED.map(([w, h]) => [w, h, 'columns', false]),
    ...TINY_WINDOWS.map(([w, h]) => [w, h, 'tabbed', false]),
    ...TABBED.map(([w, h]) => [w, h, 'tabbed', true]),
    ...STACKED.map(([w, h]) => [w, h, 'stacked', true]),
  ];
  for (const [w, h, want, touch] of everySize.filter(([, , , t]) => mine(t))) {
    await resize(send, w, h, touch);
    await sleep(500);
    if (!(await ev(LONG_BANNER))) throw new Error('no turn banner to lengthen');
    await sleep(300);
    const m = await ev(PROBE);
    recordShort('banner', w, h, m, want);
    await send('Page.reload', {});
    await sleep(3500);
  }
  await ev(LONG_ROSTER);
  if (touchPhase) {
  console.log('\nPhones on their side - the tabs, where a tab may scroll; reported only:');
  for (const [w, h] of PHONES) {
    await eachTab(w, h, (tab, m) => report(tab, w, h, m), true);
  }
  console.log('\nPhones upright - the board over the tabs, where a tab may scroll; reported only:');
  for (const [w, h] of PHONES_UPRIGHT) {
    await eachTab(w, h, (tab, m) => report(tab, w, h, m), true);
  }
  } else {
  console.log('\nStill scaled - a little short of the columns; reported only:');
  for (const [w, h] of REPORTED) {
    const m = await measure(send, ev, w, h);
    report('scaled', w, h, m);
  }
  }
  console.log('\nThe other screens:');
  for (const page of SCREENS) {
    for (const [w, h, touch] of SCREEN_SIZES.filter(([, , t]) => mine(t))) {
      await resize(send, w, h, touch);
      await send('Page.navigate', { url: `${URL_BASE}/${page}` });
      await sleep(2000);
      const faults = await ev(SCREEN_PROBE);
      if (faults.length) failed++; else held++;
      console.log(`${faults.length ? 'FAIL' : ' ok '} ${page.padEnd(9)} ${`${w}x${h}`.padEnd(10)}`
        + (faults.length ? `\n       ${faults.join('\n       ')}` : ''));
    }
  }
} catch (e) {
  console.error(`\n${e.message}`);
  failed++;
} finally {
  close();
}
}
console.log(failed ? `\n${failed} check(s) failed, ${held} held` : `\nall ${held} checks hold`);
process.exit(failed ? 1 : 0);
