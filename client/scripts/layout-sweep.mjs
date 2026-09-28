// The game room at every window size it is meant to hold, measured in a real
// headless Chrome: is anything scaled, cut short, past the window's edge,
// too small to read or too small to hit.
//
//   ng serve --port 4201                                  # in another shell
//   LAYOUT_URL=http://localhost:4201 node scripts/layout-sweep.mjs
//
// CHROME overrides where Chrome is looked for. Exits non-zero if any size the
// room is meant to hold unscaled fails a check: the three columns from
// 1180x705 up, and the board and one column of tabs (roomLayout 'tabbed') on
// a landscape window below that, every tab of it. Sizes still scaled - a
// little short of the columns, or portrait (phase C) - and landscape phones,
// where a tab may scroll, are measured and printed but not failed.
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
const FLOOR = { w: 1180, h: 705 };

// Desktop and laptop windows, by the viewport a browser leaves rather than
// the screen: a 1920x1080 screen is about 1920x950 inside Chrome, and a
// 1366x768 laptop about 1366x650.
const ASSERTED = [
  [3440, 1440], [2560, 1440], [1920, 1200], [1920, 1080], [1920, 950], [1904, 946],
  [1680, 1050], [1600, 900], [1536, 864], [1536, 740], [1440, 900], [1440, 780],
  [1366, 768], [1280, 800], [1280, 720], [1280, 705], [1200, 720], [1180, 820], [1180, 705],
];
// The board and one column of tabs: tablets on their side and small windows,
// from 1024x768 (an iPad, Unit pinned) down to 505px tall, about the least
// at which no tab scrolls. Each size is measured on every tab.
const TABBED = [
  [1366, 620], [1280, 600], [1024, 768], [1024, 690], [1024, 600], [1000, 640], [960, 540],
  [900, 520], [800, 505],
];
// Measured, not failed: the columns scaled a little (a laptop just short of
// 705), portrait (phase C), and phones on their side, whose tabs may scroll.
const REPORTED = [[1366, 690], [1366, 650], [1100, 700], [820, 1180], [390, 844]];
const PHONES = [[932, 430], [844, 390], [740, 360]];

const MIN_TEXT = 12;
const MIN_TARGET = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'cpp-layout-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) throw new Error(`no Chrome on ${PORT} (CHROME=${CHROME})`);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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
  await send('Page.enable');
  await send('Runtime.enable');
  const close = () => {
    try { ws.close(); } catch { /* gone */ }
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still has it */ }
  };
  return { send, ev, close };
}

// A solo game, started: the room with both columns full and a board.
async function openSoloRoom(send, ev) {
  const click = (label) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);
  await send('Page.navigate', { url: `${URL_BASE}/login` });
  await sleep(2500);
  await ev(`localStorage.setItem('username', 'Sweep'); sessionStorage.setItem('cpp.offline', '1'); 1`);
  await send('Page.navigate', { url: `${URL_BASE}/lobby` });
  await sleep(2500);
  if (!(await click('Single Player'))) throw new Error('no Single Player button in the lobby');
  await sleep(2500);
  if (!(await click('Start Game'))) throw new Error('no Start Game button in the room');
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

  // A log may scroll, but it has to have room for its newest entry whole:
  // History that shows half a line, or a chat that shows its heading and
  // its input and no message, is a panel nobody can read.
  for (const [log, entry, name] of [
    ['.history-panel .panel-body', '.history-item', 'History'],
    ['.game-room-messages', '.message-item', 'the chat'],
    ['.effects-list', '.effect-row, .effect-empty', 'the effects list'],
  ]) {
    const box = room.querySelector(log);
    const last = box && [...box.querySelectorAll(entry)].pop();
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
  let smallest = null;
  for (const b of buttons) {
    const r = b.getBoundingClientRect();
    const label = b.textContent.trim().slice(0, 18) || b.title || '?';
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) faults.push('off screen: ' + label);
    const side = Math.min(r.width, r.height);
    if (!smallest || side < smallest.side) smallest = { side: r1(side), label };
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

  return {
    scaled, zoom: r1(zoom), unit: r1(u), faults,
    textMin: r1(texts[0]?.px ?? 0), textMinWhat: texts[0]?.t ?? '', textUnder: small.length, textCount: texts.length,
    smallest,
    targetsUnder: buttons.filter((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height) * 1 < ${MIN_TARGET} - 0.5; }).length,
    boardShare: Math.round(100 * area.width * area.height / (innerWidth * innerHeight)),
    hex: r1(Math.max(0, ...hexes)),
    bannerFit: banner ? r1(parseFloat(banner.style.getPropertyValue('--banner-fit') || '1')) : null,
    tabbed: room.classList.contains('tabbed'),
    pinned: room.classList.contains('unit-pinned'),
    tabs: [...room.querySelectorAll('.room-tabs button')].map((b) => b.textContent.trim()),
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

async function measure(send, ev, w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  return ev(PROBE);
}

const { send, ev, close } = await launch();
let failed = 0;
let held = 0;
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await openSoloRoom(send, ev);

  const row = (label, w, h, m, bad) =>
    console.log(`${bad ? 'FAIL' : ' ok '} ${label.padEnd(9)} ${`${w}x${h}`.padEnd(10)} zoom ${String(m.zoom).padEnd(4)} unit ${String(m.unit).padEnd(5)}`
      + ` text ${String(m.textMin).padEnd(5)} (<12: ${String(m.textUnder).padStart(2)}) target ${String(m.smallest?.side ?? '-').padEnd(5)}`
      + ` hex ${String(m.hex).padEnd(5)} board ${m.boardShare}%` + (m.bannerFit !== null ? ` banner ${m.bannerFit}` : '')
      + (bad ? `\n       ${bad.join('\n       ')}` : ''));

  // The same checks for both layouts, plus that each size got the layout it
  // is meant to: the columns unscaled from the floor up, the tabs below it.
  const judge = (m, w, h, want) => {
    const bad = [...m.faults];
    if (want === 'columns' && m.tabbed) bad.push('the tabs, at a size the three columns should hold');
    if (want === 'tabbed' && !m.tabbed) bad.push('the columns, at a size that should be the tabs');
    if (m.scaled) bad.push(`scaled to ${m.zoom} at a size the room should lay out unscaled`);
    if (m.textUnder) bad.push(`${m.textUnder} text runs under ${MIN_TEXT}px, smallest ${m.textMin}px ("${m.textMinWhat}")`);
    if (m.targetsUnder) bad.push(`${m.targetsUnder} controls under ${MIN_TARGET}px, smallest ${m.smallest.side}px ("${m.smallest.label}")`);
    return bad.length ? bad : null;
  };
  const record = (label, w, h, m, bad) => {
    if (bad) failed++; else held++;
    row(label, w, h, m, bad);
  };
  const clickTab = (label) => ev(`(() => {
    const b = [...document.querySelectorAll('.room-tabs button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);
  // Every tab at one size, each measured as it shows.
  const eachTab = async (w, h, judgeIt) => {
    const first = await measure(send, ev, w, h);
    for (const tab of first.tabs.length ? first.tabs : ['-']) {
      if (tab !== '-') await clickTab(tab);
      await sleep(250);
      const m = await ev(PROBE);
      judgeIt(`${tab.toLowerCase()}`.slice(0, 9), m);
    }
    if (first.tabs.length) await clickTab(first.tabs[0]);
  };

  console.log(`The three columns, at the start of a solo game (${URL_BASE}):`);
  for (const [w, h] of ASSERTED) {
    const m = await measure(send, ev, w, h);
    record('opening', w, h, m, judge(m, w, h, 'columns'));
  }
  console.log('\nThe board and one column of tabs, every tab:');
  for (const [w, h] of TABBED) {
    await eachTab(w, h, (tab, m) => record(tab, w, h, m, judge(m, w, h, 'tabbed')));
  }
  console.log('\nThe longest banner the match can show:');
  for (const [w, h] of [...ASSERTED, ...TABBED]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    if (!(await ev(LONG_BANNER))) throw new Error('no turn banner to lengthen');
    await sleep(300);
    const m = await ev(PROBE);
    record('banner', w, h, m, judge(m, w, h, w >= FLOOR.w && h >= FLOOR.h ? 'columns' : 'tabbed'));
    await send('Page.reload', {});
    await sleep(3500);
  }
  console.log('\nPhones on their side - the tabs, where a tab may scroll; reported only:');
  for (const [w, h] of PHONES) {
    await eachTab(w, h, (tab, m) => row(tab, w, h, m, m.faults.length ? m.faults : null));
  }
  console.log('\nStill scaled - a little short of the columns, or portrait; reported only:');
  for (const [w, h] of REPORTED) {
    const m = await measure(send, ev, w, h);
    row('scaled', w, h, m, m.faults.length ? m.faults : null);
  }
} catch (e) {
  console.error(`\n${e.message}`);
  failed++;
} finally {
  close();
}
console.log(failed ? `\n${failed} check(s) failed, ${held} held` : `\nall ${held} checks hold`);
process.exit(failed ? 1 : 0);
