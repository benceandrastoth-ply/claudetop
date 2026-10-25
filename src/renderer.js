// The little Claude: figures out what Claude Code is doing and acts it out.

const WIDTH = 96;
// "Done" goes idle 10s after finishing if you were already in Claude Code,
// otherwise it waits for you to switch to Claude Code and goes idle 5s after that.
const DONE_FOCUSED_MS = 10 * 1000;
const DONE_AFTER_SEEN_MS = 5 * 1000;
const DONE_MAX_MS = 60 * 60 * 1000; // never keep shouting "done" about something from hours ago
const WORKING_STALE_MS = 20 * 60 * 1000; // no hook activity for this long = probably dead
const WAITING_STALE_MS = 30 * 60 * 1000;

// Programs that can host a Claude Code session window.
const HOSTS = new Set([
  'windowsterminal', 'openconsole', 'conhost', 'cmd', 'powershell', 'pwsh', 'code', 'code - insiders',
  'cursor', 'windsurf', 'wezterm-gui', 'alacritty', 'hyper', 'tabby', 'mintty', 'warp', 'ghostty',
  'idea64', 'pycharm64', 'webstorm64', 'rider64', 'goland64', 'claude',
]);
// Claude Code titles its tab "<status glyph> <topic>", e.g. "✳ Fix login" or "◑ Refactor".
const CLAUDE_TITLE = /^[^\p{L}\p{N}\s]\s|claude/iu;

const el = document.getElementById('claude');
const sprite = document.getElementById('sprite');
const bubble = document.getElementById('bubble');
const info = document.getElementById('info');

let config = { mode: 'walk', fixedX: null, preview: null, panicWhenDone: false, hat: 'none', dance: 'apps' };
let sessions = [];
let state = 'resting';
let focus = { pid: 0, name: '', title: '' };
let media = { playing: false, app: '', artist: '', title: '' };

// Apps whose playback counts as music in "Music apps only" mode (matched on Windows' app id).
// (cinhimbnkkaeohfgghhklpknlkffjgod is the YouTube Music app installed from Chrome/Edge.)
const MUSIC_APPS =
  /spotify|applemusic|itunes|zunemusic|deezer|tidal|amazonmusic|youtube-?music|cinhimbnkkaeohfgghhklpknlkffjgod|soundcloud|pandora|qobuz|foobar|musicbee|aimp|winamp|vlc|audacious|plexamp|tauon/i;
const finished = new Map(); // session id -> { at, since, focusedAtFinish, seenAt }

const walker = {
  x: null,
  dir: 1,
  target: null,
  pauseUntil: 0,
  airBottom: null, // set while flying: absolute height instead of standing on a floor
  sink: 0, // px below the floor while digging (miner hat)
  rot: 0, // degrees: upside down from the ceiling, spinning while falling
};
let burrowing = false; // clip Claude at the floor line, so it disappears into the ground

let dragging = null;
let hovering = false;

// ---------- focus ----------
const baseName = (n) => String(n).toLowerCase().replace(/\.exe$/, '');

// Is the window in front the one this session runs in?
function isFocused(s) {
  const chain = (s.chain || []).map((entry) => {
    const [pid, ...name] = entry.split(':');
    return { pid: Number(pid), name: baseName(name.join(':')) };
  });
  if (chain.some((p) => p.pid === focus.pid)) return true;
  // The terminal window often isn't an ancestor (e.g. Windows Terminal adopting a console
  // started from Explorer), so fall back to "a terminal showing a Claude Code tab".
  return HOSTS.has(baseName(focus.name)) && CLAUDE_TITLE.test(focus.title);
}

// Has the user had their look at this finished session?
function finishExpired(s, now) {
  if (now - s.at > DONE_MAX_MS) return true;
  let f = finished.get(s.id);
  if (!f || f.at !== s.at) {
    f = { at: s.at, since: now, focusedAtFinish: isFocused(s), seenAt: null };
    finished.set(s.id, f);
  }
  if (f.focusedAtFinish) return now - f.since > DONE_FOCUSED_MS;
  if (f.seenAt === null && isFocused(s)) f.seenAt = now;
  return f.seenAt !== null && now - f.seenAt > DONE_AFTER_SEEN_MS;
}

// ---------- state ----------
function computeState(now) {
  if (config.preview) return config.preview;
  if (scene && scene !== 'homing') return 'done'; // finish the relief scene before moving on
  const fresh = (s, ms) => now - s.at < ms;
  if (sessions.some((s) => s.state === 'waiting' && fresh(s, WAITING_STALE_MS))) return 'waiting';
  if (sessions.some((s) => s.state === 'working' && fresh(s, WORKING_STALE_MS))) return 'working';

  const latest = [...sessions].sort((a, b) => b.at - a.at)[0];
  if (!latest) return 'resting';
  if (latest.state === 'nocredit') return 'nocredit';
  if ((latest.state === 'done' || latest.state === 'error') && !finishExpired(latest, now)) return latest.state;
  return 'resting';
}

const BUBBLES = {
  working: 'Working<span class="dots"><span>.</span><span>.</span><span>.</span></span>',
  waiting: 'Needs you!',
  done: 'Done! ✓',
  nocredit: 'Out of credits 🪫',
  error: 'Something went wrong',
};

function setState(next) {
  if (next === state) return;
  const prev = state;
  el.classList.remove(state);
  state = next;
  el.classList.add(state);

  renderBubble();
  updatePanic();

  if (state === 'done' && prev !== 'done' && tv) kickTv();
  else if (state === 'done' && prev !== 'done' && !scene) {
    el.classList.add('celebrate');
    walker.pauseUntil = performance.now() + 1600;
    setTimeout(() => el.classList.remove('celebrate'), 1600);
  }
  if (state === 'working') walker.pauseUntil = 0;
  renderInfo();
}

// A lock-in message temporarily takes over the bubble.
let lockInMessage = null;

// Agent 47 talks like one.
const BUBBLES_47 = {
  working: 'On a contract<span class="dots"><span>.</span><span>.</span><span>.</span></span>',
  waiting: 'Awaiting orders.',
  done: 'Mission accomplished.',
  nocredit: 'Contract terminated.',
  error: 'Mission failed.',
};
const isAgent = () => config.hat === 'agent47';

function renderBubble() {
  let html = (isAgent() ? BUBBLES_47 : BUBBLES)[state] || '';
  if (panicking) {
    const lines = isAgent() ? PANIC_LINES_47 : PANIC_LINES;
    html = escapeHtml(lines[panicLine % lines.length]);
  }
  if (sceneLine) html = escapeHtml(sceneLine);
  if (lockInMessage) html = escapeHtml(lockInMessage);
  bubble.innerHTML = html;
  bubble.classList.toggle('show', !!html);
}

// ---------- panic run ----------
// With "Panic when done" on, a finished Claude sprints back and forth across every monitor
// until you open Claude Code. Then it sighs with relief (dropping and picking up its hard
// hat, if it wears one) and walks back to its own screen.
const PANIC_LINES = ['DONE!!', "It's done!!", 'Come look!!', 'Hellooo?!', 'Done done done!', 'Are you there?!'];
const RELIEF_LINES = ['Phew…', 'Oh thank god…', '*sigh of relief*', 'Finally…'];
// Agent 47 doesn't panic. He runs a silent op: an objective banner, a calm sneak-run across the
// screens, a coin tossed to get your attention, and a tie straightened when you show up.
const PANIC_LINES_47 = ['Mission accomplished.', 'Extraction point: Claude Code.', 'Your move.', "I don't wait long."];
const RELIEF_LINES_47 = ['Acceptable.', 'Hmph. About time.', 'Good. Now get to work.'];
let banner = null;
let lastCoin = 0;
let panicking = false;
let panicLine = 0;
let panicTimer = null;
let spanning = false; // window stretched over every monitor
let scene = null; // null | 'relief' | 'returning'
let sceneLine = null;
const sceneTimers = [];

function latestSession() {
  return [...sessions].sort((a, b) => b.at - a.at)[0];
}

// Panic only while nobody has looked yet. If you were in Claude Code when it finished,
// there's nothing to panic about.
function shouldPanic() {
  if (state !== 'done' || !config.panicWhenDone || scene) return false;
  if (config.preview) return true;
  const latest = latestSession();
  const f = latest && finished.get(latest.id);
  return !!f && !f.focusedAtFinish && f.seenAt === null;
}

// The window covers every monitor while something needs it (panic run, walking to another
// screen) or permanently with "Roam across all screens".
let spanWanted = false;

function setSpanning(on) {
  spanWanted = on;
  applySpan();
}

function applySpan() {
  const on = spanWanted || !!config.roam;
  if (on === spanning) return;
  spanning = on;
  window.claudetop.setSpan(on);
}

function updatePanic() {
  const want = shouldPanic();
  if (want === panicking) return;
  panicking = want;
  el.classList.toggle('panic', want);
  walker.target = null;
  clearInterval(panicTimer);
  if (want) {
    setSpanning(true);
    panicLine = Math.floor(Math.random() * PANIC_LINES.length);
    panicTimer = setInterval(() => {
      panicLine++;
      renderBubble();
    }, isAgent() ? 2600 : 1400);
    if (isAgent()) showBanner();
  } else {
    hideBanner();
    startRelief();
  }
  renderBubble();
}

// Hitman-style objective banner above the home screen's taskbar.
function showBanner() {
  hideBanner();
  banner = document.createElement('div');
  banner.className = 'objective';
  banner.innerHTML = '<span class="obj-head">Objective complete</span><span class="obj-next">Return to Claude Code</span>';
  fx.appendChild(banner);
  placeBanner();
}

function placeBanner() {
  if (!banner) return;
  const h = home();
  banner.style.left = `${(h.left + h.right) / 2}px`;
  banner.style.top = `${floorY(h.left + 10) - 205}px`;
}

function hideBanner() {
  if (!banner) return;
  const b = banner;
  banner = null;
  b.classList.add('leaving');
  setTimeout(() => b.remove(), 400);
}

// The coin toss: a distraction, aimed at you this time.
function tossCoin() {
  const now = performance.now();
  if (now - lastCoin < 1800) return;
  lastCoin = now;
  const from = { x: walker.x + WIDTH / 2 + walker.dir * 40, y: window.innerHeight - currentBottom() - 40 };
  const toX = from.x + walker.dir * (120 + Math.random() * 160);
  const toY = floorY(toX) - 4;
  const coin = document.createElement('div');
  coin.className = 'coin';
  fx.appendChild(coin);
  tween(650, (p) => {
    coin.style.left = `${from.x + (toX - from.x) * p - 5}px`;
    coin.style.top = `${from.y + (toY - from.y) * p - 140 * Math.sin(Math.PI * p) - 5}px`;
  }).then(() => {
    const clink = document.createElement('div');
    clink.className = 'clink';
    clink.textContent = '*clink*';
    clink.style.left = `${toX}px`;
    clink.style.top = `${toY - 26}px`;
    fx.appendChild(clink);
    coin.classList.add('landed');
    setTimeout(() => clink.remove(), 900);
    setTimeout(() => coin.remove(), 1600);
  });
}

function later(ms, fn) {
  sceneTimers.push(setTimeout(fn, ms));
}

function startRelief() {
  scene = 'relief';
  walker.target = null;
  if (isAgent()) {
    // No sighing: he straightens his tie.
    sceneLine = pick(RELIEF_LINES_47);
    el.classList.add('tie-adjust');
    later(900, () => el.classList.remove('tie-adjust'));
    later(1800, () => {
      sceneLine = null;
      scene = 'returning';
      renderBubble();
    });
    renderBubble();
    return;
  }
  sceneLine = RELIEF_LINES[Math.floor(Math.random() * RELIEF_LINES.length)];
  el.classList.add('relief');
  const hardHat = config.hat === 'hard';
  if (hardHat) {
    // The sigh knocks the hat off; Claude looks at it, bends down, puts it back on.
    later(1200, () => el.classList.add('hatdrop'));
    later(1700, () => { sceneLine = 'Oops!'; renderBubble(); });
    later(3000, () => { sceneLine = 'Got it.'; renderBubble(); });
  }
  later(hardHat ? 3700 : 1900, () => {
    el.classList.remove('relief', 'hatdrop');
    sceneLine = null;
    scene = 'returning';
    renderBubble();
  });
  renderBubble();
}

function endScene() {
  sceneTimers.splice(0).forEach(clearTimeout);
  el.classList.remove('relief', 'hatdrop');
  scene = null;
  sceneLine = null;
  walker.target = null;
  if (!panicking) setSpanning(false);
  renderBubble();
}

// ---------- dancing ----------
// With music playing, Claude puts on headphones and dances (unless something more
// important is going on).
let dancing = false;

// YouTube Music in a browser looks like any video to Windows, except that it reports an album.
const isMusicMedia = () => MUSIC_APPS.test(media.app) || !!media.album;

function musicPlaying() {
  if (!media.playing || config.dance === 'off') return false;
  return config.dance === 'any' || isMusicMedia();
}

// ---------- watching TV ----------
// While you watch a video, Claude sits down in front of a little TV. If Claude Code finishes
// in the middle of it, the TV gets kicked across every screen.
const TV_W = 70;
const TV_H = 68;
const TV_SVG = `<svg viewBox="0 0 14 13.5" width="70" height="67.5" shape-rendering="crispEdges">
  <rect class="tv-ant" x="4" y="0" width="0.6" height="3.2" transform="rotate(-25 4.3 3.2)" />
  <rect class="tv-ant" x="9.4" y="0" width="0.6" height="3.2" transform="rotate(25 9.7 3.2)" />
  <rect class="tv-body" x="0" y="3" width="14" height="9" />
  <rect class="tv-bezel" x="1" y="4" width="9.6" height="7" />
  <rect class="tv-screen" x="1.6" y="4.6" width="8.4" height="5.8" />
  <rect class="tv-shine" x="2.2" y="5.1" width="1.2" height="0.6" />
  <rect class="tv-knob" x="11.4" y="5" width="1.6" height="1.6" />
  <rect class="tv-knob" x="11.4" y="7.6" width="1.6" height="1.6" />
  <rect class="tv-leg" x="1.5" y="12" width="1" height="1.5" />
  <rect class="tv-leg" x="11.5" y="12" width="1" height="1.5" />
</svg>`;
let tv = null; // { el, x, side, flying } — x in page coordinates
let tvKicking = false;
let tvBlockedFor = null; // the video the TV got kicked during: no TV again until it changes

const mediaKey = () => `${media.app}|${media.title}`;
const videoPlaying = () => media.playing && !isMusicMedia() && config.dance !== 'any';

function placeTv() {
  tv.el.style.left = `${tv.x}px`;
  tv.el.style.top = `${floorY(tv.x + TV_W / 2) - TV_H}px`;
}

function updateTv() {
  if (tvKicking) return;
  if (tvBlockedFor && (!media.playing || mediaKey() !== tvBlockedFor)) tvBlockedFor = null;
  const want =
    config.tv !== false && videoPlaying() && !tvBlockedFor && ['resting', 'working'].includes(state) &&
    !panicking && !scene && !puppet && !dancing;
  if (want && !tv) startTv();
  else if (!want && tv) stopTv();
}

function startTv() {
  // Put the TV beside Claude and sit down facing it. Prefer the side with more desktop
  // beyond it, so a kick sends it flying across every screen.
  const { min, max } = walkRange();
  const desk = layout && layout.desktop ? layout.desktop : { left: 0, right: window.innerWidth };
  const preferred = walker.x - desk.left > desk.right - (walker.x + WIDTH) ? -1 : 1;
  const fits = (s) => (s > 0 ? walker.x + WIDTH + 14 + TV_W <= max + WIDTH : walker.x - 14 - TV_W >= min);
  const side = fits(preferred) ? preferred : -preferred;
  const el2 = document.createElement('div');
  el2.className = 'tv tv-arrive';
  el2.innerHTML = TV_SVG;
  if (side < 0) el2.firstElementChild.style.transform = 'scaleX(-1)'; // knobs on the far side
  fx.appendChild(el2);
  tv = { el: el2, x: side > 0 ? walker.x + WIDTH + 14 : walker.x - 14 - TV_W, side, flying: false };
  placeTv();
  poof(tv.x + TV_W / 2, floorY(tv.x + TV_W / 2) - TV_H / 2);
  walker.dir = side;
  walker.target = null;
  el.classList.add('watching');
}

function stopTv() {
  const old = tv;
  tv = null;
  el.classList.remove('watching');
  poof(old.x + TV_W / 2, floorY(old.x + TV_W / 2) - TV_H / 2);
  old.el.classList.add('tv-leave');
  setTimeout(() => old.el.remove(), 350);
}

async function kickTv() {
  if (!tv || tvKicking) return;
  tvKicking = true;
  puppet = true;
  const t = tv;
  setSpanning(true); // it's going across every screen
  el.classList.remove('watching');
  el.classList.add('startled');
  lockInMessage = '!!';
  renderBubble();
  await wait(450);
  el.classList.remove('startled');
  lockInMessage = pick(["IT'S DONE!", 'Done?! TV off!', 'Back to work!']);
  renderBubble();

  // Step up to it, wind up, kick.
  await walkTo(t.side > 0 ? t.x - WIDTH + 16 : t.x + TV_W - 16, 160);
  walker.dir = t.side;
  el.classList.add('kick-windup');
  await wait(230);
  el.classList.remove('kick-windup');
  el.classList.add('kick');
  const fromX = t.x;
  const fromTop = parseFloat(t.el.style.top);
  burst(fromX + (t.side > 0 ? 8 : TV_W - 8), fromTop + TV_H - 18);
  t.flying = true;
  t.el.classList.remove('tv-arrive');
  const toX = t.side > 0 ? window.innerWidth + 60 : -TV_W - 60;
  await tween(Math.max(700, Math.abs(toX - fromX) / 1.7), (p) => {
    t.el.style.left = `${fromX + (toX - fromX) * p}px`;
    t.el.style.top = `${fromTop - 230 * Math.sin(Math.PI * Math.min(1, p * 1.15))}px`;
    t.el.style.transform = `rotate(${t.side * 1000 * p}deg)`;
  });
  burst(Math.max(12, Math.min(window.innerWidth - 12, toX)), fromTop);
  t.el.remove();
  tv = null;
  tvBlockedFor = mediaKey();
  el.classList.remove('kick');
  await wait(500);
  lockInMessage = null;
  renderBubble();
  if (!panicking) setSpanning(false);
  puppet = false;
  tvKicking = false;
}

function updateDance() {
  const want =
    musicPlaying() && !panicking && !scene && !puppet && ['resting', 'done', 'working'].includes(state);
  if (want === dancing) return;
  dancing = want;
  el.classList.toggle('dancing', want);
  walker.target = null;
}

// ---------- lock-in moves ----------
// Main found an NSFW tab and stretched our window over every screen. The move depends on
// the hat: no hat -> a red strike slashes through the tab; hard hat -> thrown at the tab,
// then fetched from the floor; propeller -> fly up and hit the tab's X. Main closes the tab
// when we say so (and on its own if we never do).
let puppet = false; // a lock-in move is steering Claude directly
const fx = document.getElementById('fx');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

function tween(ms, fn) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / ms);
      fn(p);
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// Screen rect (DIP) -> page rect.
function toPage(r) {
  if (!r || !layout) return null;
  return { x: r.x - layout.winX, y: r.y - layout.winY, w: r.width, h: r.height };
}

// Aim for the active tab if Windows told us where it is, else the browser's top-right corner.
function aimFor(job) {
  const tab = toPage(job.tabRect);
  if (tab) return { bar: tab, x: tab.x + tab.w - 14, y: tab.y + tab.h / 2 };
  const w = toPage(job.windowRect) || { x: 0, y: 0, w: window.innerWidth, h: 40 };
  return { bar: { x: w.x + 8, y: w.y + 2, w: Math.max(120, w.w - 16), h: 32 }, x: w.x + w.w - 24, y: w.y + 16 };
}

const floorY = (pageX) => window.innerHeight - 4 - groundAt(pageX - WIDTH / 2);
const currentBottom = () => parseFloat(el.style.bottom) || 4;

function burst(x, y) {
  const b = document.createElement('div');
  b.className = 'burst';
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
  fx.appendChild(b);
  setTimeout(() => b.remove(), 600);
}

async function walkTo(x, speed = 190) {
  const from = walker.x;
  const d = x - from;
  if (Math.abs(d) < 2) return;
  walker.dir = Math.sign(d);
  el.classList.add('walking');
  await tween((Math.abs(d) / speed) * 1000, (p) => {
    walker.x = from + d * p;
  });
  el.classList.remove('walking');
}

// No hat: leap, and a red line slashes through the tab.
async function strike(aim) {
  el.classList.add('leap');
  await wait(350);
  const line = document.createElement('div');
  line.className = 'strike';
  line.style.left = `${aim.bar.x + 4}px`;
  line.style.top = `${aim.bar.y + aim.bar.h / 2 - 3}px`;
  line.style.width = `${Math.max(40, aim.bar.w - 8)}px`;
  fx.appendChild(line);
  await wait(380);
  window.claudetop.lockInClose();
  await wait(600);
  line.classList.add('gone');
  await wait(300);
  line.remove();
}

// A loose copy of a hat in the effects layer (thrown at a tab, popped off by a hat change).
// It's a 96x30 box centred on (x, y); the hat sits in its lower 24px.
function makeFxHat(kind) {
  const hat = document.createElement('div');
  hat.className = 'fxhat';
  hat.innerHTML = `<svg viewBox="0 -5 16 5" width="96" height="30" shape-rendering="crispEdges">${
    document.querySelector(`.hat.${kind}`).innerHTML
  }</svg>`;
  fx.appendChild(hat);
  return hat;
}

function placeFxHat(hat, x, y, rot, flip = walker.dir < 0) {
  hat.style.left = `${x - 48}px`;
  hat.style.top = `${y - 15}px`;
  hat.style.transform = `rotate(${rot}deg)${flip ? ' scaleX(-1)' : ''}`;
}

// Where the hat box sits when it's on Claude's head (page coordinates).
const headPoint = () => ({ x: walker.x + WIDTH / 2, y: window.innerHeight - currentBottom() - 60 - 15 });

function poof(x, y) {
  const p = document.createElement('div');
  p.className = 'poof';
  p.style.left = `${x}px`;
  p.style.top = `${y}px`;
  fx.appendChild(p);
  setTimeout(() => p.remove(), 700);
}

// Changing hats: the old one pops off and tumbles away, the new one drops onto the head.
function swapHat(from) {
  const head = headPoint();
  if (['hard', 'propeller', 'miner'].includes(from)) {
    const old = makeFxHat(from);
    const dir = Math.random() < 0.5 ? -1 : 1;
    tween(750, (p) => {
      placeFxHat(old, head.x + dir * 80 * p, head.y - 70 * p + 160 * p * p, dir * 420 * p);
      old.style.opacity = String(1 - p * p);
    }).then(() => old.remove());
  }
  poof(head.x, head.y + 6);
  el.classList.remove('hat-arrive');
  void el.offsetWidth; // restart the animation
  el.classList.add('hat-arrive');
  setTimeout(() => el.classList.remove('hat-arrive'), 1200);
}

// Hard hat: wind up, throw it at the tab, watch it drop, go and pick it up.
async function throwHat(aim) {
  walker.dir = aim.x >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('throwing');
  await wait(260);
  const start = headPoint();
  el.classList.add('hat-off');
  const hat = makeFxHat('hard');
  const place = (x, y, rot) => placeFxHat(hat, x, y, rot, false);

  const end = { x: aim.bar.x + aim.bar.w / 2, y: aim.y };
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const arc = Math.min(260, 80 + dist * 0.2);
  const spin = 720 * walker.dir;
  await tween(Math.min(1000, 320 + dist * 0.4), (p) => {
    place(start.x + (end.x - start.x) * p, start.y + (end.y - start.y) * p - arc * Math.sin(Math.PI * p), spin * p);
  });
  el.classList.remove('throwing');
  burst(end.x, end.y);
  window.claudetop.lockInClose();

  // Bounces off and drops to the floor, landing upside down (upside down, the hat's edge is
  // 9px below the box centre, so that's what rests on the floor).
  const drift = -walker.dir * (40 + Math.random() * 50);
  const landX = end.x + drift;
  const landY = floorY(landX) - 9;
  await tween(Math.max(450, Math.sqrt(Math.max(1, landY - end.y)) * 26), (p) => {
    place(end.x + drift * p, end.y + (landY - end.y) * p * p, spin + 180 * walker.dir * p);
  });
  await tween(260, (p) => place(landX, landY - 14 * Math.sin(Math.PI * p), spin + 180 * walker.dir));

  // Fetch it.
  lockInMessage = 'brb, getting my hat';
  renderBubble();
  await fetchHat(hat, landX);
}

// Walk to a hat lying on the floor at landX, bend down, put it back on.
async function fetchHat(hat, landX) {
  const standAt = landX - WIDTH / 2 - (landX > walker.x + WIDTH / 2 ? 30 : -30);
  await walkTo(standAt);
  walker.dir = landX >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('pickup');
  await wait(380);
  hat.remove();
  el.classList.remove('hat-off');
  await wait(320);
  el.classList.remove('pickup');
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// How Claude takes losing its hat: one of three moods, picked at random.
const REACTIONS = {
  embarrassed: ['…that was on purpose.', 'uh… nobody saw that', 'oops 😳'],
  angry: ['GRR! My hat!', 'Stupid tab!!', 'UGH!!'],
  sad: ['aw… my hat…', '*sniff*', 'that hurt…'],
};

async function react() {
  const mood = pick(Object.keys(REACTIONS));
  lockInMessage = pick(REACTIONS[mood]);
  renderBubble();
  el.classList.add(`react-${mood}`);
  await wait(1900);
  el.classList.remove(`react-${mood}`);
}

// ---------- digging (miner hat) ----------
// Long trips go underground: dig down, a dirt mound travels along the floor, pop up there.
const DIG_DEPTH = 100; // deep enough to hide the hat too
const DIG_MIN_TRIP = 300; // shorter trips are walked
const easeOut = (p) => 1 - (1 - p) * (1 - p);
const isMiner = () => config.hat === 'miner';

function dirt(x, y, count, up = true) {
  for (let i = 0; i < count; i++) {
    const d = document.createElement('i');
    d.className = 'dirt';
    d.style.left = `${x + (Math.random() - 0.5) * 30}px`;
    d.style.top = `${y}px`;
    d.style.setProperty('--dx', `${(Math.random() - 0.5) * 90}px`);
    d.style.setProperty('--dy', `${up ? -(30 + Math.random() * 50) : 40 + Math.random() * 60}px`);
    d.style.animationDelay = `${Math.random() * 120}ms`;
    fx.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }
}

function openHole(cx) {
  const h = document.createElement('div');
  h.className = 'hole';
  h.style.left = `${cx - 45}px`;
  h.style.top = `${floorY(cx) - 8}px`;
  fx.appendChild(h);
  return h;
}

function closeHole(h) {
  h.classList.add('closing');
  setTimeout(() => h.remove(), 400);
}

async function digDown() {
  burrowing = true;
  el.classList.add('shovel-out', 'digging');
  const cx = walker.x + WIDTH / 2;
  const hole = openHole(cx);
  const spray = setInterval(() => dirt(cx, floorY(cx) - 6, 3), 120);
  await tween(1000, (p) => {
    walker.sink = DIG_DEPTH * p * p + (p < 0.9 ? Math.sin(p * 40) * 2 : 0);
  });
  clearInterval(spray);
  el.classList.remove('digging');
  el.classList.add('underground');
  closeHole(hole);
}

async function digUp() {
  const cx = walker.x + WIDTH / 2;
  const hole = openHole(cx);
  dirt(cx, floorY(cx) - 6, 14);
  el.classList.remove('underground');
  await tween(450, (p) => {
    walker.sink = DIG_DEPTH - (DIG_DEPTH + 14) * easeOut(p); // overshoots: a little jump out
  });
  await tween(180, (p) => {
    walker.sink = -14 * (1 - p);
  });
  walker.sink = 0;
  closeHole(hole);
  el.classList.remove('shovel-out');
  burrowing = false;
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');
}

// While underground, a dirt mound shows where Claude is.
async function tunnel(toX) {
  const fromX = walker.x;
  const mound = document.createElement('div');
  mound.className = 'mound';
  fx.appendChild(mound);
  await tween(Math.max(400, (Math.abs(toX - fromX) / 650) * 1000), (p) => {
    walker.x = fromX + (toX - fromX) * p;
    const cx = walker.x + WIDTH / 2;
    mound.style.left = `${cx - 22}px`;
    mound.style.top = `${floorY(cx) - 10}px`;
  });
  mound.remove();
}

// A miner's long trip during normal life (wandering, going home, switching screens).
async function digTravel(x) {
  puppet = true;
  el.classList.remove('walking');
  walker.dir = x >= walker.x ? 1 : -1;
  await digDown();
  await tunnel(x);
  await digUp();
  puppet = false;
  walker.target = null;
  if (scene === 'returning' || scene === 'homing') endScene();
  else walker.pauseUntil = performance.now() + pauseFor();
}

// Fly in an arc to x and land there.
async function flyTo(x) {
  el.classList.add('flying');
  const fromX = walker.x;
  const fromB = currentBottom();
  const toB = 4 + groundAt(x);
  walker.dir = x >= fromX ? 1 : -1;
  await tween(Math.min(2400, 700 + Math.abs(x - fromX) * 0.8), (p) => {
    walker.x = fromX + (x - fromX) * easeInOut(p);
    walker.airBottom = fromB + (toB - fromB) * p + 110 * Math.sin(Math.PI * p);
  });
  walker.airBottom = null;
  el.classList.remove('flying');
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');
}

// Propeller: take off, fly up under the tab and bonk it with the propeller. The bonk knocks
// the hat off, and without it Claude can't fly: it drops, reacts, fetches the hat and flies
// back to where it started.
async function flyAndBonk(aim) {
  const H = window.innerHeight;
  const startX = walker.x;
  el.classList.add('flying');
  const b0 = currentBottom();
  walker.airBottom = b0;
  await tween(320, (p) => {
    walker.airBottom = b0 + 30 * p;
  });
  // The propeller's tip is 25px above the sprite's top, centred: put it in the tab.
  const tip = { x: aim.bar.x + aim.bar.w / 2, y: aim.bar.y + aim.bar.h * 0.65 };
  const from = { x: walker.x, b: walker.airBottom };
  const to = { x: tip.x - WIDTH / 2, b: H - (tip.y + 25) - 60 };
  walker.dir = to.x >= from.x ? 1 : -1;
  const dist = Math.hypot(to.x - from.x, to.b - from.b);
  await tween(Math.min(1800, 450 + dist * 0.7), (p) => {
    const e = easeInOut(p);
    walker.x = from.x + (to.x - from.x) * e;
    walker.airBottom = from.b + (to.b - from.b) * e + 6 * Math.sin(p * Math.PI * 6) * (1 - p);
  });
  walker.airBottom = to.b;
  el.classList.add('press');
  await wait(120);
  burst(tip.x, tip.y);
  window.claudetop.lockInClose();
  await wait(200);
  el.classList.remove('press');

  // Off comes the hat. It tumbles to the floor while Claude hangs there for a beat...
  const head = headPoint();
  const dir = walker.dir;
  el.classList.remove('flying');
  el.classList.add('hat-off', 'stunned');
  const hat = makeFxHat('propeller');
  const drift = dir * (30 + Math.random() * 60);
  const landX = head.x + drift;
  const landY = floorY(landX) - 10;
  const hatFalls = (async () => {
    await tween(Math.max(500, Math.sqrt(Math.max(1, landY - head.y)) * 28), (p) => {
      placeFxHat(hat, head.x + drift * p, head.y + (landY - head.y) * p * p, dir * 540 * p);
    });
    await tween(240, (p) => placeFxHat(hat, landX, landY - 12 * Math.sin(Math.PI * p), dir * 540));
  })();
  await wait(400);

  // ...then drops like a stone.
  const top = walker.airBottom;
  const land = 4 + groundAt(walker.x);
  el.classList.add('falling');
  await tween(Math.max(350, Math.sqrt(Math.max(1, top - land)) * 24), (p) => {
    walker.airBottom = top + (land - top) * p * p;
  });
  walker.airBottom = null;
  el.classList.remove('falling', 'stunned');
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');
  await hatFalls;

  await react();
  lockInMessage = 'getting my hat…';
  renderBubble();
  await fetchHat(hat, landX);
  lockInMessage = null;
  renderBubble();
  await flyTo(startX);
}

// ---------- Agent 47 ----------
// Stops to check nobody's following.
function lookOverShoulder() {
  const facing = walker.dir;
  setTimeout(() => {
    if (!puppet) walker.dir = -facing;
  }, 450);
  setTimeout(() => {
    if (!puppet) walker.dir = facing;
  }, 1100);
}

const DUCK_SVG = `<svg viewBox="0 0 12 10" width="36" height="30" shape-rendering="crispEdges">
  <rect class="d-body" x="1" y="5" width="9" height="4" />
  <rect class="d-body" x="0" y="6" width="2" height="2" />
  <rect class="d-body" x="5" y="1" width="4" height="4" />
  <rect class="d-beak" x="9" y="3" width="2.5" height="1.2" />
  <rect class="d-eye" x="7" y="2" width="0.9" height="0.9" />
  <rect class="d-led" x="3" y="4.2" width="1" height="0.8" />
</svg>`;

// Agent 47: "Target acquired." Lob the remote explosive rubber duck onto the tab, let it
// blink, click the remote, boom, tab gone. Then straighten the tie.
async function duckStrike(aim) {
  lockInMessage = 'Target acquired.';
  renderBubble();
  await wait(700);
  const target = { x: aim.bar.x + aim.bar.w / 2, y: aim.bar.y + aim.bar.h / 2 };
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('throwing');
  await wait(260);

  const duck = document.createElement('div');
  duck.className = 'duck';
  duck.innerHTML = DUCK_SVG;
  if (walker.dir < 0) duck.firstElementChild.style.transform = 'scaleX(-1)';
  fx.appendChild(duck);
  const place = (x, y, rot) => {
    duck.style.left = `${x - 18}px`;
    duck.style.top = `${y - 15}px`;
    duck.style.transform = `rotate(${rot}deg)`;
  };
  const start = headPoint();
  const dist = Math.hypot(target.x - start.x, target.y - start.y);
  const arc = Math.min(240, 80 + dist * 0.2);
  await tween(Math.min(1000, 320 + dist * 0.4), (p) => {
    place(start.x + (target.x - start.x) * p, start.y + (target.y - start.y) * p - arc * Math.sin(Math.PI * p), walker.dir * 360 * p);
  });
  el.classList.remove('throwing');
  duck.style.transform = '';
  duck.classList.add('armed');

  // Beep, beep, beep... *click*.
  await wait(900);
  lockInMessage = '*click*';
  renderBubble();
  el.classList.add('throwing'); // remote held up
  await wait(250);
  const boom = document.createElement('div');
  boom.className = 'boom';
  boom.style.left = `${target.x}px`;
  boom.style.top = `${target.y}px`;
  fx.appendChild(boom);
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('div');
    s.className = 'smoke';
    s.style.left = `${target.x + (Math.random() - 0.5) * 40}px`;
    s.style.top = `${target.y + (Math.random() - 0.5) * 20}px`;
    s.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
    s.style.animationDelay = `${i * 60}ms`;
    fx.appendChild(s);
    setTimeout(() => s.remove(), 1400);
  }
  duck.remove();
  setTimeout(() => boom.remove(), 700);
  window.claudetop.lockInClose();
  el.classList.remove('throwing');
  await wait(500);

  lockInMessage = pick(['Silent Assassin.', 'Contract complete.', 'Target eliminated.']);
  renderBubble();
  el.classList.add('tie-adjust');
  await wait(700);
  el.classList.remove('tie-adjust');
}

// Miner: dig down, poke its head out of the ceiling upside down right at the tab, look around,
// whack the tab with the shovel, fall spinning into a hole in the floor, tunnel back and pop up
// where it started.
async function digAndWhack(aim) {
  const H = window.innerHeight;
  const startX = walker.x;
  await digDown();

  // Dirt crumbles from the top edge above the tab...
  const tab = { x: aim.bar.x + aim.bar.w / 2, y: aim.bar.y + aim.bar.h / 2 };
  walker.x = tab.x - WIDTH / 2;
  dirt(tab.x, 2, 10, false);
  await wait(250);

  // ...and Claude's head pokes down through it, upside down (hat and lamp hanging down).
  // Upside down, the 60px sprite's box top sits 24px above the screen: head, eyes and hat show.
  const peek = H + 24 - 60;
  const above = H + 80;
  walker.airBottom = above;
  walker.rot = 180;
  burrowing = false;
  walker.sink = 0;
  el.classList.remove('underground');
  el.classList.add('ceiling');
  await tween(380, (p) => {
    walker.airBottom = above + (peek - above) * easeOut(p);
  });
  for (const d of [-1, 1, -1]) {
    walker.dir = d; // looks left, right, left
    await wait(300);
  }

  el.classList.add('swing');
  await wait(110);
  burst(tab.x, tab.y);
  dirt(tab.x, tab.y + 10, 6, false);
  window.claudetop.lockInClose();
  await wait(260);
  el.classList.remove('swing');
  await wait(200);

  // Down it goes, spinning, straight through a hole in the floor. 2.5 turns ends upright.
  const cx = walker.x + WIDTH / 2;
  const floor = 4 + groundAt(walker.x);
  const hole = openHole(cx);
  el.classList.add('falling');
  const fallTo = floor - DIG_DEPTH;
  const landsAt = (floor - peek) / (fallTo - peek); // fall progress when it reaches the floor
  await tween(Math.max(650, Math.sqrt(Math.max(1, peek - fallTo)) * 26), (p) => {
    walker.airBottom = peek + (fallTo - peek) * p * p;
    const q = Math.min(1, (p * p) / landsAt); // spin finishes as it hits the floor
    walker.rot = 180 + 900 * q;
    burrowing = q >= 0.98; // only cut off at the floor once it's going in
  });
  walker.rot = 0;
  dirt(cx, floorY(cx) - 6, 10);
  walker.airBottom = null;
  walker.sink = DIG_DEPTH;
  el.classList.remove('falling', 'ceiling');
  el.classList.add('underground');
  closeHole(hole);

  await wait(250);
  await tunnel(startX);
  await digUp();
}

async function lockIn(job) {
  // Let a dig or a TV kick finish first.
  for (let i = 0; puppet && i < 60; i++) await wait(100);
  if (puppet) return;
  puppet = true;
  lockInMessage = job.message;
  el.classList.add('lockin');
  walker.target = null;
  updateDance();
  renderBubble();
  const aim = aimFor(job);
  try {
    if (config.hat === 'hard') await throwHat(aim);
    else if (config.hat === 'propeller') await flyAndBonk(aim);
    else if (config.hat === 'miner') await digAndWhack(aim);
    else if (config.hat === 'agent47') await duckStrike(aim);
    else await strike(aim);
  } catch {}
  window.claudetop.lockInClose(); // in case the move never got there
  if (!isAgent()) lockInMessage = job.message; // 47 keeps his own sign-off
  renderBubble();
  await wait(1400);
  lockInMessage = null;
  el.classList.remove('lockin', 'leap', 'flying', 'throwing', 'hat-off', 'pickup', 'press', 'stunned', 'falling');
  el.classList.remove('ceiling', 'swing', 'digging', 'underground', 'shovel-out');
  walker.airBottom = null;
  walker.sink = 0;
  walker.rot = 0;
  burrowing = false;
  // Ended up on another screen (fetching the hat)? Walk home instead of teleporting.
  const h = home();
  if (!spanning && (walker.x < h.left || walker.x > h.right - WIDTH)) {
    setSpanning(true);
    scene = 'homing';
  }
  puppet = false;
  renderBubble();
  window.claudetop.lockInDone();
}

// ---------- hover info ----------
const LABELS = {
  working: 'working',
  waiting: 'needs your input',
  done: 'finished',
  nocredit: 'out of credits',
  error: 'stopped with an error',
  idle: 'idle',
};

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderInfo() {
  const now = Date.now();
  const head = config.preview ? `<b>Preview:</b> ${state}` : `<b>Claude is ${state === 'resting' ? 'resting' : LABELS[state]}</b>`;
  const rows = [...sessions]
    .sort((a, b) => b.at - a.at)
    .slice(0, 4)
    .map((s) => {
      const project = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : 'session';
      const tool = s.state === 'working' && s.tool ? ` · ${escapeHtml(s.tool)}` : '';
      return `${escapeHtml(project)}: ${LABELS[s.state] || s.state}${tool} <span class="muted">${ago(now - s.at)}</span>`;
    });
  if (!rows.length) rows.push('<span class="muted">No Claude Code sessions yet</span>');
  if (dancing) {
    const song = [media.artist, media.title].filter(Boolean).join(' – ');
    rows.push(`♪ ${escapeHtml(song || 'Vibing')}`);
  }
  if (tv) rows.push(`📺 ${escapeHtml(media.title || 'Watching TV')}`);
  rows.push(`<span class="muted">${config.mode === 'walk' ? 'Walking around' : 'Staying put'} · right-click for options</span>`);
  info.innerHTML = [head, ...rows].join('<br>');
}

// ---------- layout ----------
// From main: where each monitor's floor is inside our window (window-relative CSS px).
// Normally the window covers just the chosen screen; while panicking it covers all of them.
let layout = null; // { winX, home: { left, right }, segments: [{ left, right, ground }] }
let lastGround = 0;

function home() {
  return layout ? layout.home : { left: 0, right: window.innerWidth };
}

function walkRange() {
  const segments = spanning && layout ? layout.segments : [home()];
  const min = Math.min(...segments.map((s) => s.left));
  const max = Math.max(...segments.map((s) => s.right)) - WIDTH;
  return { min, max: Math.max(min, max) };
}

function groundAt(x) {
  if (!layout) return 0;
  const center = x + WIDTH / 2;
  const seg = layout.segments.find((s) => center >= s.left && center < s.right);
  if (seg) lastGround = seg.ground; // in a gap between monitors, keep the last floor
  return lastGround;
}

// ---------- movement ----------
function pickTarget() {
  const { min, max } = walkRange();
  const clamp = (x) => Math.max(min, Math.min(max, x));
  if (scene === 'returning' || scene === 'homing') {
    // Walk back onto the home screen (or to the saved spot in "stay in place" mode).
    // A roaming Claude is at home anywhere after a relief scene.
    const h = home();
    const spot = config.mode === 'fixed' && config.fixedX != null ? h.left + config.fixedX : null;
    if (scene === 'returning' && config.roam && spot === null) {
      walker.target = walker.x;
      return;
    }
    const lo = h.left + 30;
    const hi = h.right - WIDTH - 30;
    walker.target = spot ?? Math.max(lo, Math.min(hi, walker.x));
    return;
  }
  if (panicking) {
    // Mostly frantic sprints anywhere, sometimes a short dash back the other way.
    if (Math.random() < 0.4) {
      const dash = (80 + Math.random() * 160) * (Math.random() < 0.5 ? -1 : 1);
      walker.target = clamp(walker.x + dash);
    } else {
      walker.target = min + Math.random() * (max - min);
    }
    return;
  }
  if (state === 'working') walker.target = min + Math.random() * (max - min);
  else walker.target = clamp(walker.x - 200 + Math.random() * 400);
}

function speedFor() {
  if (dragging) return 0;
  if (scene === 'relief') return 0;
  if (scene === 'returning' || scene === 'homing') return 140;
  if (panicking) return isAgent() ? 160 : 290; // even in "stay in place" mode: this is an emergency
  if (dancing || tv) return 0;
  if (config.mode !== 'walk') return 0;
  if (state === 'working') return isAgent() ? 47 : 70;
  if (state === 'done') return 30;
  return 0; // waiting, out of credits, resting: stand still
}

function pauseFor() {
  if (panicking && isAgent()) return 600 + Math.random() * 700; // deliberate, not frantic
  if (panicking) return 60 + Math.random() * 350;
  if (state === 'working') return 400 + Math.random() * 1600;
  return 1500 + Math.random() * 4000;
}

// Crossing onto another monitor is a hop, not a step (floors can sit at different heights).
const HOP_MS = 420;
let segIndex = -1;
let prevGround = 0;
let hop = null; // { t0, from, to }

function segmentIndex(x) {
  if (!layout) return -1;
  const center = x + WIDTH / 2;
  return layout.segments.findIndex((s) => center >= s.left && center < s.right);
}

let last = performance.now();
function tick(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;

  const h = home();
  if (walker.x === null) walker.x = h.left + (config.fixedX ?? (h.right - h.left - WIDTH) / 2);

  // During a lock-in move the choreography steers; otherwise walk as usual.
  if (!puppet) {
    // "Stay in place": if something carried Claude off its spot, it walks back.
    const spot = config.mode === 'fixed' && config.fixedX != null ? h.left + config.fixedX : null;
    if (spot !== null && !dragging && !scene && !panicking && Math.abs(walker.x - spot) > 3) {
      scene = 'homing';
      walker.target = null;
    }
    const { min, max } = walkRange();
    walker.x = Math.max(min, Math.min(max, walker.x));

    const speed = speedFor();
    let moving = false;
    if (speed > 0 && t >= walker.pauseUntil) {
      if (walker.target === null) pickTarget();
      if (isMiner() && !panicking && !dragging && Math.abs(walker.target - walker.x) > DIG_MIN_TRIP) {
        digTravel(walker.target);
        requestAnimationFrame(tick);
        return;
      }
      const delta = walker.target - walker.x;
      if (Math.abs(delta) < 2) {
        walker.target = null;
        if (scene === 'returning' || scene === 'homing') endScene();
        else {
          walker.pauseUntil = t + pauseFor();
          if (isAgent() && panicking && Math.random() < 0.6) tossCoin();
          else if (isAgent()) lookOverShoulder();
        }
      } else {
        walker.dir = Math.sign(delta);
        walker.x += walker.dir * Math.min(Math.abs(delta), speed * dt);
        moving = true;
      }
    }
    el.classList.toggle('walking', moving);
  }

  const ground = groundAt(walker.x);
  const idx = segmentIndex(walker.x);
  if (walker.airBottom === null && !dragging && idx !== -1 && segIndex !== -1 && idx !== segIndex) {
    hop = { t0: t, from: prevGround, to: ground };
  }
  if (idx !== -1) segIndex = idx;
  prevGround = ground;
  let floor = ground;
  if (hop) {
    const p = (t - hop.t0) / HOP_MS;
    if (p >= 1) hop = null;
    else floor = hop.from + (hop.to - hop.from) * p + 44 * Math.sin(Math.PI * p);
  }
  el.classList.toggle('hopping', !!hop);

  if (tv && !tv.flying) placeTv();
  placeBanner();
  sprite.classList.toggle('flip', walker.dir < 0);
  el.style.left = `${Math.round(walker.x)}px`;
  const bottom = walker.airBottom ?? 4 + floor - walker.sink;
  el.style.bottom = `${bottom}px`;
  // Digging: whatever is below the floor line is underground, so cut it off.
  const below = burrowing ? Math.max(0, 4 + ground - bottom) : 0;
  el.style.clipPath = below > 0 ? `inset(-400px -400px ${below}px -400px)` : '';
  el.style.transform = walker.rot ? `rotate(${walker.rot}deg)` : '';
  requestAnimationFrame(tick);
}

// ---------- blinking ----------
function scheduleBlink() {
  setTimeout(() => {
    sprite.classList.add('blink');
    setTimeout(() => sprite.classList.remove('blink'), 140);
    scheduleBlink();
  }, 2500 + Math.random() * 4000);
}

// ---------- mouse: hover, drag, menu ----------
el.addEventListener('mouseenter', () => {
  hovering = true;
  el.classList.add('hover');
  renderInfo();
  window.claudetop.setIgnoreMouse(false);
});

el.addEventListener('mouseleave', () => {
  hovering = false;
  el.classList.remove('hover');
  if (!dragging) window.claudetop.setIgnoreMouse(true);
});

el.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = { offset: e.clientX - walker.x };
  walker.target = null;
  el.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const { min, max } = walkRange();
  walker.x = Math.max(min, Math.min(max, e.clientX - dragging.offset));
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = null;
  el.classList.remove('dragging');
  if (config.mode === 'fixed' && !spanning) {
    config.fixedX = walker.x - home().left;
    window.claudetop.setFixedX(config.fixedX);
  }
  walker.pauseUntil = performance.now() + 2000;
  if (!hovering) window.claudetop.setIgnoreMouse(true);
});

el.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.claudetop.showMenu();
});

// ---------- wiring ----------
let configLoaded = false;
let pendingMove = false; // switched monitors: walk over once the wider window is in place
window.claudetop.onConfig((cfg) => {
  const enteringFixed = configLoaded && cfg.mode === 'fixed' && config.mode !== 'fixed';
  const oldHat = config.hat;
  const hatChanged = configLoaded && cfg.hat !== config.hat;
  const movedScreen = configLoaded && cfg.displayId !== config.displayId;
  configLoaded = true;
  config = cfg;
  // Switching to "stay in place" pins Claude right where it's standing.
  if (enteringFixed && walker.x != null) {
    config.fixedX = walker.x - home().left;
    window.claudetop.setFixedX(config.fixedX);
  }
  el.classList.toggle('hat-on', ['hard', 'propeller', 'miner'].includes(config.hat));
  el.classList.toggle('hat-hard', config.hat === 'hard');
  el.classList.toggle('hat-propeller', config.hat === 'propeller');
  el.classList.toggle('hat-miner', config.hat === 'miner');
  el.classList.toggle('hat-agent47', config.hat === 'agent47');
  if (hatChanged) renderBubble(); // Agent 47 has his own lines
  if (hatChanged && !puppet && entered) swapHat(oldHat);
  // A panic run or relief walk already ends on the new home screen by itself.
  if (movedScreen && !panicking && !scene && !puppet) {
    pendingMove = true;
    setSpanning(true);
  }
  applySpan(); // "Roam across all screens" may have been switched
  setState(computeState(Date.now()));
  updatePanic();
  updateDance();
  updateTv();
  renderInfo();
  maybeEnter();
});

window.claudetop.onMedia((m) => {
  media = m;
  updateDance();
  updateTv();
});

window.claudetop.onLayout((next) => {
  // Keep Claude on the same spot of the screen while the window moves or resizes.
  if (layout && walker.x !== null) walker.x += layout.winX - next.winX;
  if (layout && walker.target !== null) walker.target += layout.winX - next.winX;
  if (layout && tv) tv.x += layout.winX - next.winX;
  layout = next;
  segIndex = -1; // segment numbering changes with the window; don't mistake that for a crossing
  hop = null;
  if (pendingMove) {
    pendingMove = false;
    scene = 'homing';
    walker.target = null;
  }
  maybeEnter();
});

// On start-up Claude drops in from above instead of just appearing.
let entered = false;
async function maybeEnter() {
  if (entered || !configLoaded || !layout) return;
  entered = true;
  el.classList.add('entered');
  const h = home();
  walker.x = h.left + (config.mode === 'fixed' && config.fixedX != null ? config.fixedX : (h.right - h.left - WIDTH) / 2);
  puppet = true;
  el.classList.add('falling');
  const top = window.innerHeight + 30;
  const floor = 4 + groundAt(walker.x);
  await tween(650, (p) => {
    walker.airBottom = top + (floor - top) * p * p;
  });
  walker.airBottom = null;
  el.classList.remove('falling');
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');
  puppet = false;
}

window.claudetop.onSessions((list) => {
  sessions = list;
  setState(computeState(Date.now()));
  if (hovering) renderInfo();
});

window.claudetop.onLockIn(lockIn);

window.claudetop.onFocus((f) => {
  focus = f;
  setState(computeState(Date.now()));
});

setInterval(() => {
  setState(computeState(Date.now()));
  updatePanic(); // you may have just opened Claude Code
  updateDance();
  updateTv();
  if (hovering) renderInfo();
}, 500);

el.classList.add(state);
scheduleBlink();
requestAnimationFrame(tick);
