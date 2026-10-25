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
  // Linux (process names are cut to 15 characters there)
  'gnome-terminal-', 'gnome-terminal', 'kgx', 'ptyxis', 'konsole', 'kitty', 'xterm', 'tilix', 'terminator',
  'xfce4-terminal', 'mate-terminal', 'lxterminal', 'qterminal', 'foot', 'rio', 'blackbox', 'code-oss', 'zed',
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
  // Can't tell (Linux without xprop, or a native Wayland window): assume you're looking, so
  // "done" times out instead of waiting forever.
  if (focus.available === false) return true;
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
  if (latest.state === 'nocredit') {
    // Past the time Claude Code said the limit resets: tokens are back. It stays excited until
    // you've had a look, the same way "done" does.
    if (!latest.resetAt || now < latest.resetAt) return 'nocredit';
    const reset = { ...latest, id: `${latest.id}:reset`, at: latest.resetAt };
    return finishExpired(reset, now) ? 'resting' : 'recharged';
  }
  if ((latest.state === 'done' || latest.state === 'error') && !finishExpired(latest, now)) return latest.state;
  return 'resting';
}

const BUBBLES = {
  working: 'Working<span class="dots"><span>.</span><span>.</span><span>.</span></span>',
  waiting: 'Needs you!',
  done: 'Done! ✓',
  nocredit: 'Out of credits 🪫',
  recharged: 'Tokens are back! ⚡',
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
  if (state === 'done' && prev !== 'done') play('done');
  if (state === 'waiting' && prev !== 'waiting') play('waiting');
  if (state === 'recharged' && prev !== 'recharged') play('recharged');
  if (state === 'done' && prev !== 'done') {
    flamingo = isAgent() && Math.random() < 1 / 12;
    const job = latestSession();
    if (isAgent() && entered && !config.preview && job && typeof job.prompts === 'number') showRating(job.prompts);
  }
  if (state !== 'done') flamingo = false;
  if (state === 'recharged' && prev !== 'recharged') {
    el.classList.add('powerup');
    walker.pauseUntil = performance.now() + 1700;
    setTimeout(() => el.classList.remove('powerup'), 1700);
  }
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
  recharged: 'Contract renewed.',
  error: 'Mission failed.',
};
const isAgent = () => config.hat === 'agent47';

function renderBubble() {
  let html = (isAgent() ? BUBBLES_47 : { ...BUBBLES, ...(HAT_BUBBLES[config.hat] || {}) })[state] || '';
  if (state === 'working' && taskMinutes >= 10) {
    html = sleepbag && !isAgent() ? `Still working… 😴 ${taskMinutes} min` : `${html} ${taskMinutes} min`;
  }
  if (gameLine) html = escapeHtml(gameLine);
  if (panicking) {
    const lines = isAgent() ? PANIC_LINES_47 : PANIC_LINES_HAT[config.hat] || PANIC_LINES;
    html = escapeHtml(lines[panicLine % lines.length]);
  }
  if (sceneLine) html = escapeHtml(sceneLine);
  if (cryLine) html = escapeHtml(cryLine);
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
  if (state !== 'done' || !config.panicWhenDone || scene || quiet()) return false;
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
    stat('panics');
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

// ---------- jealousy ----------
// Open another AI and Claude bursts into tears for a few seconds.
const OTHER_AIS = [
  [/chatgpt|openai/i, 'ChatGPT'],
  [/gemini/i, 'Gemini'],
  [/copilot/i, 'Copilot'],
  [/perplexity/i, 'Perplexity'],
  [/\bgrok\b/i, 'Grok'],
  [/deepseek/i, 'DeepSeek'],
  [/\ble chat\b|mistral ai/i, 'Le Chat'],
  [/\bmeta ai\b/i, 'Meta AI'],
  [/character\.ai/i, 'Character.AI'],
];
// In a browser the tab title tells; their desktop apps go by process name.
const BROWSER_NAMES = [
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'librewolf', 'waterfox',
  'zen', 'floorp', 'chromium', 'thorium', 'yandex',
];
const AI_APPS = /chatgpt|copilot|perplexity|gemini|grok|deepseek/i;
const CRY_LINES = [
  ['{ai}?? 😭', 'Am I not enough?'],
  ['*sob* {ai}…', 'I thought we had something…'],
  ['You said I was your favourite!', '*sniff*'],
  ['Fine. Go ask {ai}.', '…see if I care 😢'],
  ['{ai} can’t even run your tests!', '*sob*'],
];
const CRY_LINES_47 = [['{ai}.', 'Noted.'], ['A new handler?', 'I never forget a face.']];
const CRY_COOLDOWN_MS = 60 * 1000;
let crying = false;
let cryLine = null;
let lastCry = -Infinity;
let lastAi = null;

function otherAi(f) {
  const name = baseName(f.name || '');
  const browser = BROWSER_NAMES.some((b) => name.startsWith(b));
  const text = browser ? f.title : AI_APPS.test(name) ? `${name} ${f.title}` : '';
  if (!text) return null;
  const hit = OTHER_AIS.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

function checkJealous() {
  const ai = otherAi(focus);
  const fresh = ai && ai !== lastAi;
  lastAi = ai;
  if (!fresh || config.jealous === false) return;
  if (puppet || crying || dragging || panicking || scene || tv || quiet()) return;
  if (performance.now() - lastCry < CRY_COOLDOWN_MS) return;
  cry(ai);
  stat('cries');
}

async function cry(ai) {
  crying = true;
  lastCry = performance.now();
  walker.target = null;
  updateDance();
  el.classList.add('crying');
  const [first, second] = pick(isAgent() ? CRY_LINES_47 : CRY_LINES).map((l) => l.replace('{ai}', ai));
  cryLine = first;
  renderBubble();
  await wait(2200);
  cryLine = second;
  renderBubble();
  await wait(2000);
  cryLine = null;
  el.classList.remove('crying');
  crying = false;
  walker.pauseUntil = performance.now() + 1500;
  renderBubble();
  updateDance();
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
    !panicking && !scene && !puppet && !dancing && !gaming;
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
  stat('tvKicks');
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
    musicPlaying() && !panicking && !scene && !puppet && !crying && !gaming && ['resting', 'done', 'working', 'recharged'].includes(state);
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
    `<g class="${kind}">${document.querySelector(`.hat.${kind}`).innerHTML}</g>`
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

// A little comic-book word that pops up and fades (*clink*, *bonk*).
function sfxText(text, x, y) {
  const t = document.createElement('div');
  t.className = 'clink';
  t.textContent = text;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  fx.appendChild(t);
  setTimeout(() => t.remove(), 900);
}

// Stars circling a dazed head.
function dizzyStars(x, y) {
  const d = document.createElement('div');
  d.className = 'dizzy';
  d.innerHTML = '<i>★</i><i>★</i><i>★</i>';
  d.style.left = `${x}px`;
  d.style.top = `${y}px`;
  fx.appendChild(d);
  return d;
}

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
  if (HATS.includes(from)) {
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

  // The bonk knocks the hat off and up. Without it Claude hangs there for a beat, legs
  // pedalling, realises, and drops.
  const head = headPoint();
  const dir = walker.dir;
  el.classList.remove('flying');
  el.classList.add('hat-off', 'stunned');
  const hat = makeFxHat('propeller');
  hat.classList.add('spinning');
  const hatUp = { x: head.x - dir * 30, y: head.y - 50 };
  const knocked = tween(380, (p) => {
    const e = easeOut(p);
    placeFxHat(hat, head.x + (hatUp.x - head.x) * e, head.y + (hatUp.y - head.y) * e, -dir * 200 * e);
  });
  await tween(450, (p) => {
    walker.airBottom = to.b + 8 * Math.sin(p * Math.PI) - 6 * p; // a little hang-time wobble
    walker.rot = 8 * Math.sin(p * Math.PI * 4) * (1 - p);
  });
  await knocked;

  // It tumbles head over heels (1¼ turns) and slams down flat on its side, like a miner falling
  // into its hole, minus the hole. Lying on its side the 96px-wide sprite is 96px tall, so the
  // box sits a little higher to keep its body on the floor.
  const top = walker.airBottom;
  const land = 4 + groundAt(walker.x);
  const h = el.offsetHeight || 60;
  const lieB = land + 38 - h / 2;
  const fallMs = Math.max(500, Math.sqrt(Math.max(1, top - lieB)) * 30);
  el.classList.add('falling');
  const fell = tween(fallMs, (p) => {
    walker.airBottom = top + (lieB - top) * p * p;
    walker.rot = dir * 450 * p * p;
  });

  // Meanwhile the hat autorotates down like a sycamore seed, drifting over to where Claude's
  // head is going to be.
  const cx = walker.x + WIDTH / 2;
  const headLying = { x: cx + dir * (h / 2 + 10), y: window.innerHeight - lieB - h / 2 };
  const hatFalls = tween(fallMs + 900, (p) => {
    const x = hatUp.x + (headLying.x - hatUp.x) * p + 26 * Math.sin(p * Math.PI * 3) * (1 - p);
    const y = hatUp.y + (headLying.y - hatUp.y) * (p * p * 0.4 + p * 0.6);
    placeFxHat(hat, x, y, -dir * 200 + dir * 290 * p + 14 * Math.sin(p * Math.PI * 5), false);
  });

  await fell;
  walker.rot = dir * 90;
  el.classList.remove('falling', 'stunned');
  el.classList.add('crashed');
  burst(cx, floorY(cx) - 10);
  dirt(cx, floorY(cx) - 6, 12);
  await tween(260, (p) => {
    walker.airBottom = lieB + 12 * Math.sin(Math.PI * p) * (1 - p); // one small bounce
  });
  walker.airBottom = lieB;
  const stars = dizzyStars(headLying.x, headLying.y - 30);

  // ...and the hat lands right on its head. Bonk.
  await hatFalls;
  burst(headLying.x, headLying.y);
  sfxText('*bonk*', headLying.x, headLying.y - 34);
  el.classList.add('ouch');
  await wait(180);
  el.classList.remove('ouch');

  // The hat rolls off onto the floor beside it.
  const landX = headLying.x + dir * 40;
  const landY = floorY(landX) - 9;
  await tween(420, (p) => {
    placeFxHat(hat, headLying.x + (landX - headLying.x) * p, headLying.y + (landY - headLying.y) * p - 18 * Math.sin(Math.PI * p), dir * (90 + 90 * p), false);
  });
  hat.classList.remove('spinning');
  await wait(700);

  // Gets back up.
  stars.remove();
  await tween(420, (p) => {
    const e = easeInOut(p);
    walker.rot = dir * 90 * (1 - e);
    walker.airBottom = lieB + (land - lieB) * e + 10 * Math.sin(Math.PI * p);
  });
  walker.rot = 0;
  walker.airBottom = null;
  el.classList.remove('crashed'); // (it hides the bubble, which would turn with Claude)
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');

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

// ---------- the hat collection ----------
// Hats worn on the head (Agent 47 is a whole outfit, so he's not on this list).
const HATS = ['hard', 'propeller', 'miner', 'cowboy', 'wizard', 'pirate', 'astronaut', 'ninja', 'crown', 'chef'];
const RIDES = ['cowboy', 'pirate', 'chef']; // horse, boat, meatball
const HAT_SPEED = { cowboy: 1.7, pirate: 1.15, chef: 1.25, astronaut: 0.65, crown: 0.45, ninja: 1.4 };
const HAT_BUBBLES = {
  cowboy: { done: 'Yeehaw! ✓', waiting: 'Howdy! Need ya!' },
  wizard: { working: 'Casting<span class="dots"><span>.</span><span>.</span><span>.</span></span>', nocredit: 'Out of mana 🪫', recharged: 'Mana restored! ✨' },
  pirate: { done: 'Land ho! ✓', waiting: 'Ahoy! Need ye!', nocredit: 'Out of doubloons 🪫' },
  astronaut: { done: 'Houston, it’s done. ✓', waiting: 'Houston, we need you.' },
  ninja: { working: '…', done: 'Done. ✓', waiting: '!' },
  crown: { done: 'Royally done. ✓', waiting: 'The crown requires you.' },
  chef: { working: 'Cooking<span class="dots"><span>.</span><span>.</span><span>.</span></span>', done: 'Order up! ✓' },
};
const PANIC_LINES_HAT = {
  pirate: ['MAN OVERBOARD!', 'ALL HANDS!', 'Arrr, it’s DONE!'],
  cowboy: ['YEEHAW, IT’S DONE!', 'Round ’em up!'],
  wizard: ['The spell is cast!!', 'COME SEE!!'],
};

// Long trips, by hat: the miner digs, the wizard teleports, the ninja dashes.
function travelDone() {
  puppet = false;
  walker.target = null;
  if (scene === 'returning' || scene === 'homing') endScene();
  else walker.pauseUntil = performance.now() + pauseFor();
}

function sparkle(x, y, colors, n = 14, spread = 40) {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    const a = (Math.PI * 2 * i) / n;
    const d = spread * (0.5 + Math.random() * 0.6);
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.setProperty('--c', colors[i % colors.length]);
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * d}px`);
    fx.appendChild(s);
    setTimeout(() => s.remove(), 1150);
  }
}

function smokePuff(x, y, n = 5) {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'smoke';
    s.style.left = `${x + (Math.random() - 0.5) * 30}px`;
    s.style.top = `${y + (Math.random() - 0.5) * 16}px`;
    s.style.setProperty('--dx', `${(Math.random() - 0.5) * 50}px`);
    s.style.animationDelay = `${i * 40}ms`;
    fx.appendChild(s);
    setTimeout(() => s.remove(), 1400);
  }
}

const MAGIC = ['#d8b4ff', '#b06cff', '#ffd23f', '#ffffff'];

async function teleportTravel(x) {
  puppet = true;
  el.classList.remove('walking');
  walker.dir = x >= walker.x ? 1 : -1;
  sparkle(walker.x + WIDTH / 2, floorY(walker.x + WIDTH / 2) - 30, MAGIC);
  el.classList.add('vanish');
  await wait(350);
  walker.x = x;
  el.classList.remove('vanish');
  el.classList.add('appear');
  sparkle(x + WIDTH / 2, floorY(x + WIDTH / 2) - 30, MAGIC);
  await wait(400);
  el.classList.remove('appear');
  travelDone();
}

async function dashTravel(x) {
  puppet = true;
  el.classList.remove('walking');
  walker.dir = x >= walker.x ? 1 : -1;
  const from = walker.x;
  smokePuff(from + WIDTH / 2, floorY(from + WIDTH / 2) - 24);
  el.classList.add('dashing');
  await tween(Math.max(140, Math.abs(x - from) / 6), (p) => {
    walker.x = from + (x - from) * easeInOut(p);
  });
  el.classList.remove('dashing');
  smokePuff(x + WIDTH / 2, floorY(x + WIDTH / 2) - 24, 3);
  travelDone();
}

const TRAVEL = { miner: (x) => digTravel(x), wizard: teleportTravel, ninja: dashTravel };

// ---------- lock-in moves for the new hats ----------
const handPoint = () => ({ x: walker.x + WIDTH / 2 + walker.dir * 46, y: window.innerHeight - currentBottom() - 28 });
const tabCenter = (aim) => ({ x: aim.bar.x + aim.bar.w / 2, y: aim.bar.y + aim.bar.h / 2 });

// A line from a to b (rope, beam, spear).
function stretch(node, a, b) {
  node.style.left = `${a.x}px`;
  node.style.top = `${a.y}px`;
  node.style.width = `${Math.hypot(b.x - a.x, b.y - a.y)}px`;
  node.style.transform = `rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)`;
}

function fxNode(className, html = '') {
  const n = document.createElement('div');
  n.className = className;
  n.innerHTML = html;
  fx.appendChild(n);
  return n;
}

// Cowboy: twirl the lasso overhead, rope the tab, yank it away.
async function lassoMove(aim) {
  const target = tabCenter(aim);
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  const over = fxNode('lasso-overhead');
  const placeOver = () => {
    const h = headPoint();
    over.style.left = `${h.x + walker.dir * 12}px`;
    over.style.top = `${h.y - 26}px`;
  };
  placeOver();
  el.classList.add('throwing');
  await wait(900);
  over.remove();
  const rope = fxNode('rope');
  const loop = fxNode('lasso-loop');
  const from = handPoint();
  await tween(450, (p) => {
    const pt = { x: from.x + (target.x - from.x) * p, y: from.y + (target.y - from.y) * p - 70 * Math.sin(Math.PI * p) };
    stretch(rope, from, pt);
    loop.style.left = `${pt.x}px`;
    loop.style.top = `${pt.y}px`;
  });
  burst(target.x, target.y);
  window.claudetop.lockInClose();
  el.classList.remove('throwing');
  el.classList.add('kick-windup');
  lockInMessage = 'Yeehaw!';
  renderBubble();
  await tween(380, (p) => {
    const pt = { x: target.x + (from.x - target.x) * p, y: target.y + (from.y - target.y) * p };
    stretch(rope, from, pt);
    loop.style.left = `${pt.x}px`;
    loop.style.top = `${pt.y}px`;
    loop.style.transform = `scale(${1 - p * 0.6})`;
  });
  el.classList.remove('kick-windup');
  rope.remove();
  loop.remove();
}

const FROG_SVG = `<svg viewBox="0 0 10 8" width="30" height="24" shape-rendering="crispEdges">
  <rect x="1" y="3.4" width="8" height="3.6" /><rect x="2" y="1.8" width="6" height="2" />
  <rect class="fg-dark" x="0" y="6" width="2.4" height="1.4" /><rect class="fg-dark" x="7.6" y="6" width="2.4" height="1.4" />
  <rect class="fg-eye" x="2" y="0.6" width="1.8" height="1.8" /><rect class="fg-eye" x="6.2" y="0.6" width="1.8" height="1.8" />
  <rect class="fg-pupil" x="2.6" y="1.1" width="0.8" height="0.8" /><rect class="fg-pupil" x="6.8" y="1.1" width="0.8" height="0.8" />
</svg>`;

// Wizard: a zap from the wand, and the tab turns into a frog that hops away.
async function wandZap(aim) {
  const target = tabCenter(aim);
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('throwing');
  lockInMessage = 'Abracadabra!';
  renderBubble();
  await wait(450);
  const beam = fxNode('beam');
  stretch(beam, handPoint(), target);
  sparkle(target.x, target.y, MAGIC, 18, 50);
  await wait(450);
  beam.remove();
  el.classList.remove('throwing');
  poof(target.x, target.y);
  window.claudetop.lockInClose();
  lockInMessage = 'Ribbit.';
  renderBubble();
  // The frog drops to the floor and hops off the far side of the screen.
  const frog = fxNode('frog', FROG_SVG);
  const away = target.x > window.innerWidth / 2 ? 1 : -1;
  if (away < 0) frog.firstElementChild.style.transform = 'scaleX(-1)';
  const place = (x, y) => {
    frog.style.left = `${x - 15}px`;
    frog.style.top = `${y - 24}px`;
  };
  let x = target.x;
  const floor0 = floorY(x);
  await tween(Math.max(350, Math.sqrt(Math.max(1, floor0 - target.y)) * 22), (p) => place(x, target.y + (floor0 - target.y) * p * p));
  while (x > -40 && x < window.innerWidth + 40) {
    const nx = x + away * 110;
    await tween(380, (p) => place(x + (nx - x) * p, floorY(x) - 50 * Math.sin(Math.PI * p)));
    x = nx;
  }
  frog.remove();
}

const CANNON_SVG = `<svg viewBox="0 0 14 10" width="42" height="30" shape-rendering="crispEdges">
  <rect x="2" y="2" width="11" height="4" /><rect x="12" y="1.5" width="1.6" height="5" />
  <rect class="cn-wheel" x="1.5" y="5" width="5" height="5" />
</svg>`;

// Pirate: roll out a cannon and fire at the tab.
async function cannonMove(aim) {
  const target = tabCenter(aim);
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  const base = { x: walker.x + WIDTH / 2 + walker.dir * 62, y: floorY(walker.x + WIDTH / 2) - 18 };
  const angle = Math.atan2(target.y - base.y, target.x - base.x);
  const cannon = fxNode('cannon', CANNON_SVG);
  cannon.style.left = `${base.x - 13}px`;
  cannon.style.top = `${base.y - 12}px`;
  cannon.style.transform = `rotate(${angle}rad)`;
  poof(base.x, base.y);
  lockInMessage = 'Ready the cannons!';
  renderBubble();
  await wait(800);
  lockInMessage = 'FIRE!';
  renderBubble();
  const muzzle = { x: base.x + Math.cos(angle) * 30, y: base.y + Math.sin(angle) * 30 };
  burst(muzzle.x, muzzle.y);
  smokePuff(muzzle.x, muzzle.y, 3);
  const ball = fxNode('ball');
  await tween(Math.min(700, 200 + Math.hypot(target.x - muzzle.x, target.y - muzzle.y) * 0.4), (p) => {
    ball.style.left = `${muzzle.x + (target.x - muzzle.x) * p}px`;
    ball.style.top = `${muzzle.y + (target.y - muzzle.y) * p - 40 * Math.sin(Math.PI * p)}px`;
  });
  ball.remove();
  const boom = fxNode('boom');
  boom.style.left = `${target.x}px`;
  boom.style.top = `${target.y}px`;
  setTimeout(() => boom.remove(), 700);
  smokePuff(target.x, target.y);
  window.claudetop.lockInClose();
  lockInMessage = 'Arrr!';
  renderBubble();
  await wait(700);
  poof(base.x, base.y);
  cannon.remove();
}

// Astronaut: jetpack up to the tab, launch it into space, float back down.
async function jetpackMove(aim) {
  const H = window.innerHeight;
  const target = tabCenter(aim);
  el.classList.add('jetpack');
  lockInMessage = '3… 2… 1…';
  renderBubble();
  const from = { x: walker.x, b: currentBottom() };
  walker.airBottom = from.b;
  const to = { x: target.x - WIDTH / 2, b: H - (target.y + 25) - 60 };
  walker.dir = to.x >= from.x ? 1 : -1;
  await tween(Math.min(1600, 500 + Math.hypot(to.x - from.x, to.b - from.b) * 0.6), (p) => {
    const e = easeInOut(p);
    walker.x = from.x + (to.x - from.x) * e;
    walker.airBottom = from.b + (to.b - from.b) * e;
  });
  el.classList.add('press');
  await wait(120);
  burst(target.x, target.y);
  window.claudetop.lockInClose();
  el.classList.remove('press');
  // Off it goes.
  const tab = fxNode('flying-tab');
  tab.textContent = 'tab';
  lockInMessage = 'To infinity!';
  renderBubble();
  const t0 = target.y - 14;
  tween(900, (p) => {
    tab.style.left = `${target.x + 10 * Math.sin(p * 12)}px`;
    tab.style.top = `${t0 - (t0 + 80) * p * p}px`;
  }).then(() => tab.remove());
  await wait(400);
  // Low gravity: drift down slowly.
  el.classList.remove('jetpack');
  const top = walker.airBottom;
  const land = 4 + groundAt(walker.x);
  await tween(Math.max(900, Math.sqrt(Math.max(1, top - land)) * 90), (p) => {
    walker.airBottom = top + (land - top) * easeInOut(p);
  });
  walker.airBottom = null;
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');
}

const SHURIKEN_SVG = `<svg viewBox="0 0 8 8" width="22" height="22" shape-rendering="crispEdges">
  <rect x="3" y="0" width="2" height="8" /><rect x="0" y="3" width="8" height="2" />
  <rect x="1.5" y="1.5" width="5" height="5" transform="rotate(45 4 4)" /><rect class="sh-hole" x="3.5" y="3.5" width="1" height="1" />
</svg>`;

// Ninja: a throwing star, and the tab is sliced clean through.
async function shurikenMove(aim) {
  const target = tabCenter(aim);
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('throwing');
  await wait(220);
  const star = fxNode('shuriken', SHURIKEN_SVG);
  const from = handPoint();
  await tween(Math.min(420, 150 + Math.hypot(target.x - from.x, target.y - from.y) * 0.25), (p) => {
    star.style.left = `${from.x + (target.x - from.x) * p}px`;
    star.style.top = `${from.y + (target.y - from.y) * p}px`;
  });
  el.classList.remove('throwing');
  star.classList.add('stuck');
  const slash = fxNode('slash');
  slash.style.left = `${aim.bar.x}px`;
  slash.style.top = `${aim.bar.y + aim.bar.h / 2 + aim.bar.w * 0.12}px`;
  slash.style.width = `${aim.bar.w * 1.03}px`;
  await wait(180);
  window.claudetop.lockInClose();
  lockInMessage = '…';
  renderBubble();
  await wait(700);
  slash.classList.add('gone');
  star.style.transition = 'opacity 0.4s';
  star.style.opacity = '0';
  await wait(450);
  slash.remove();
  star.remove();
}

// Crown: point at the tab, and a royal guard runs in to deal with it.
async function royalGuardMove(aim) {
  const target = tabCenter(aim);
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('pointing');
  lockInMessage = 'Guards!';
  renderBubble();
  await wait(700);
  const fromLeft = target.x > window.innerWidth / 2 ? false : true;
  const guard = document.createElement('div');
  guard.className = 'guard walking';
  guard.innerHTML = `${sprite.outerHTML.replace(' id="sprite"', '')}`;
  guard.style.setProperty('--clay', '#8f96a3');
  guard.style.transform = 'scale(0.6)';
  document.body.appendChild(guard);
  const gs = guard.querySelector('.sprite');
  const placeGuard = (x) => {
    guard.style.left = `${x - 48}px`;
    guard.style.top = `${floorY(x) - 60}px`;
  };
  const start = fromLeft ? -60 : window.innerWidth + 60;
  const stop = target.x + (fromLeft ? -30 : 30);
  gs.classList.toggle('flip', !fromLeft);
  await tween(Math.max(500, Math.abs(stop - start) / 0.9), (p) => placeGuard(start + (stop - start) * p));
  guard.classList.remove('walking');
  lockInMessage = 'Off with its tab!';
  renderBubble();
  // The spear.
  const spear = fxNode('spear');
  const hand = { x: stop, y: floorY(stop) - 30 };
  await tween(260, (p) => stretch(spear, hand, { x: hand.x + (target.x - hand.x) * p, y: hand.y + (target.y - hand.y) * p }));
  burst(target.x, target.y);
  window.claudetop.lockInClose();
  await wait(350);
  spear.remove();
  el.classList.remove('pointing');
  gs.classList.toggle('flip', fromLeft);
  guard.classList.add('walking');
  await tween(Math.max(500, Math.abs(stop - start) / 0.9), (p) => placeGuard(stop + (start - stop) * p));
  guard.remove();
}

const PIE_SVG = `<svg viewBox="0 0 10 5.4" width="30" height="16" shape-rendering="crispEdges">
  <rect class="pi-cream" x="1" y="0.6" width="8" height="2" /><rect class="pi-cream" x="2" y="0" width="6" height="1" />
  <rect class="pi-cherry" x="4.4" y="-0.8" width="1.2" height="1" />
  <rect class="pi-crust" x="0" y="2.4" width="10" height="1.4" /><rect class="pi-crust" x="1" y="3.8" width="8" height="1.6" />
</svg>`;

// Chef: a cream pie, right in the tab.
async function pieMove(aim) {
  const target = tabCenter(aim);
  walker.dir = target.x >= walker.x + WIDTH / 2 ? 1 : -1;
  el.classList.add('throwing');
  lockInMessage = 'One pie, coming up!';
  renderBubble();
  await wait(400);
  const pie = fxNode('pie', PIE_SVG);
  const from = headPoint();
  const dist = Math.hypot(target.x - from.x, target.y - from.y);
  const arc = Math.min(220, 70 + dist * 0.2);
  await tween(Math.min(900, 300 + dist * 0.4), (p) => {
    pie.style.left = `${from.x + (target.x - from.x) * p}px`;
    pie.style.top = `${from.y + (target.y - from.y) * p - arc * Math.sin(Math.PI * p)}px`;
    pie.style.transform = `rotate(${walker.dir * 300 * p}deg)`;
  });
  el.classList.remove('throwing');
  pie.remove();
  for (let i = 0; i < 12; i++) {
    const c = document.createElement('i');
    c.className = 'cream';
    c.style.left = `${target.x}px`;
    c.style.top = `${target.y}px`;
    const a = Math.random() * Math.PI * 2;
    c.style.setProperty('--dx', `${Math.cos(a) * (20 + Math.random() * 40)}px`);
    c.style.setProperty('--dy', `${Math.sin(a) * (10 + Math.random() * 25) + 20}px`);
    fx.appendChild(c);
    setTimeout(() => c.remove(), 950);
  }
  window.claudetop.lockInClose();
  lockInMessage = 'Pie-d. 🥧';
  renderBubble();
  await wait(600);
}

const HAT_MOVES = {
  cowboy: lassoMove,
  wizard: wandZap,
  pirate: cannonMove,
  astronaut: jetpackMove,
  ninja: shurikenMove,
  crown: royalGuardMove,
  chef: pieMove,
};

async function lockIn(job) {
  // Let a dig or a TV kick finish first.
  for (let i = 0; puppet && i < 60; i++) await wait(100);
  if (puppet) return;
  puppet = true;
  stat('lockins');
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
    else if (HAT_MOVES[config.hat]) await HAT_MOVES[config.hat](aim);
    else await strike(aim);
  } catch {}
  window.claudetop.lockInClose(); // in case the move never got there
  if (!isAgent()) lockInMessage = job.message; // 47 keeps his own sign-off
  renderBubble();
  await wait(1400);
  lockInMessage = null;
  el.classList.remove('lockin', 'leap', 'flying', 'throwing', 'hat-off', 'pickup', 'press', 'stunned', 'falling', 'crashed', 'ouch');
  fx.querySelectorAll('.dizzy').forEach((d) => d.remove());
  el.classList.remove('ceiling', 'swing', 'digging', 'underground', 'shovel-out');
  el.classList.remove('jetpack', 'pointing', 'vanish', 'appear', 'dashing', 'kick-windup');
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

// ---------- which session is Claude about? ----------
// The one that matters most: needs you, then working, then the latest.
function leadSession(now = Date.now()) {
  const fresh = (s, ms) => now - s.at < ms;
  return (
    sessions.find((s) => s.state === 'waiting' && fresh(s, WAITING_STALE_MS)) ||
    [...sessions].filter((s) => s.state === 'working' && fresh(s, WORKING_STALE_MS)).sort((a, b) => b.at - a.at)[0] ||
    latestSession()
  );
}

// ---------- what it's doing: props, long tasks, disguises ----------
// While working, Claude holds something that matches the tool Claude Code is using. A long task
// gets a coffee after 10 minutes and a sleeping bag after 30.
const TOOL_PROPS = [
  [/^(Grep|Glob|LS|WebSearch|WebFetch|ToolSearch)$/, 'magnifier'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'pencil'],
  [/^(Bash|BashOutput|PowerShell|KillShell|KillBash)$/, 'terminal'],
  [/^Read$/, 'book'],
];
const PROPS = ['magnifier', 'pencil', 'terminal', 'book', 'coffee'];
const COFFEE_MS = 10 * 60 * 1000;
const SLEEPBAG_MS = 30 * 60 * 1000;
let held = null;
let sleepbag = false;
let taskMinutes = 0;
let disguise = null; // Agent 47: 'chef' | 'mechanic' | 'flamingo'
let flamingo = false; // rolled when a job finishes: a rare surprise
let seasonHat = null;
const debug = {}; // test overrides: { prop, minutes, disguise }

function updateDoing(now = Date.now()) {
  const lead = leadSession(now);
  const busy = puppet || panicking || scene || crying || dancing || tv || gaming;
  let prop = null;
  let minutes = 0;
  if (state === 'working' && lead && lead.state === 'working' && !busy) {
    minutes = Math.floor((now - (lead.taskStart || lead.at)) / 60000);
    const hit = TOOL_PROPS.find(([re]) => re.test(lead.tool || ''));
    prop = hit ? hit[1] : null;
  }
  if (debug.minutes != null && state === 'working' && !busy) minutes = debug.minutes;
  if (debug.prop !== undefined && state === 'working' && !busy) prop = debug.prop;
  const bag = minutes * 60000 >= SLEEPBAG_MS;
  if (minutes * 60000 >= COFFEE_MS && !bag) prop = 'coffee';
  if (bag) prop = null;
  if (prop !== held) {
    held = prop;
    for (const p of PROPS) el.classList.toggle(`tool-${p}`, p === held);
    el.classList.toggle('holding', !!held);
  }
  if (bag !== sleepbag) {
    sleepbag = bag;
    if (bag && debug.minutes == null) stat('marathon');
    el.classList.toggle('sleepbag', bag);
    walker.target = null;
  }
  if (minutes !== taskMinutes) {
    taskMinutes = minutes;
    renderBubble();
  }
  updateDisguise(lead);
}

function updateDisguise(lead) {
  let d = null;
  if (isAgent() && !puppet) {
    if (state === 'done' && flamingo) d = 'flamingo';
    else if (lead && lead.testsFailed && ['working', 'waiting', 'done'].includes(state)) d = 'mechanic';
    else if (state === 'working' && held === 'pencil') d = 'chef';
  }
  if (debug.disguise !== undefined) d = isAgent() ? debug.disguise : null;
  if (d === disguise) return;
  if (d === 'flamingo' && debug.disguise === undefined) stat('flamingos');
  if (entered) poof(headPoint().x, headPoint().y + 6); // a quick change, behind a puff of smoke
  disguise = d;
  for (const k of ['chef', 'mechanic', 'flamingo']) el.classList.toggle(`disguise-${k}`, k === d);
  updateHatClasses();
}

// Bubbles sit higher over tall hats.
function updateHatClasses() {
  const own = HATS.includes(config.hat);
  el.classList.toggle('hat-on', own || !!seasonHat || disguise === 'mechanic');
  el.classList.toggle('tall-hat', disguise === 'chef' || disguise === 'flamingo' || seasonHat === 'party' || ['wizard', 'chef'].includes(config.hat));
}

// ---------- Agent 47's mission rating ----------
// Every finished job gets rated. Permission prompts are witnesses.
function showRating(prompts) {
  const stars = Math.max(1, 5 - (prompts >= 3 ? prompts - 1 : prompts));
  const silent = prompts === 0;
  const r = document.createElement('div');
  r.className = 'rating';
  r.innerHTML =
    '<span class="r-head">MISSION RATING</span>' +
    `<span class="r-title">${silent ? 'SILENT ASSASSIN' : stars >= 3 ? 'PROFESSIONAL' : stars === 2 ? 'SLOPPY' : 'MASS PANIC'}</span>` +
    `<span class="r-stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span>` +
    `<span class="r-note">${silent ? 'No witnesses' : `${prompts} witness${prompts === 1 ? '' : 'es'}`}</span>`;
  const head = headPoint();
  r.style.left = `${Math.max(90, Math.min(window.innerWidth - 90, head.x))}px`;
  r.style.top = `${Math.max(4, head.y - 120)}px`;
  fx.appendChild(r);
  setTimeout(() => r.classList.add('leaving'), 4500);
  setTimeout(() => r.remove(), 5100);
}

// ---------- rage quit ----------
// Three failed tool calls in a row is a lot for anyone.
const TABLE_SVG = `<svg viewBox="0 0 18 10" width="54" height="30" shape-rendering="crispEdges">
  <rect class="tb-top" x="0" y="0" width="18" height="2" />
  <rect x="1.5" y="2" width="1.5" height="8" />
  <rect x="15" y="2" width="1.5" height="8" />
  <rect x="3" y="3" width="12" height="0.8" />
</svg>`;
const rageSeen = new Map(); // session id -> rageAt already acted on

function checkRage() {
  for (const s of sessions) {
    if (!s.rageAt || rageSeen.get(s.id) === s.rageAt) continue;
    rageSeen.set(s.id, s.rageAt);
    if (entered && Date.now() - s.rageAt < 60 * 1000) flipTable();
  }
}

async function flipTable() {
  if (puppet || panicking || crying || scene || quiet()) return;
  puppet = true;
  walker.target = null;
  el.classList.remove('walking');
  updateDance();
  updateDoing();
  if (!isAgent()) stat('tables');
  if (isAgent()) {
    // 47 doesn't flip tables.
    lockInMessage = 'Complications.';
    renderBubble();
    await wait(1100);
    el.classList.add('tie-adjust');
    lockInMessage = 'Nothing I can’t handle.';
    renderBubble();
    await wait(1200);
    el.classList.remove('tie-adjust');
  } else {
    const dir = walker.dir;
    const t = document.createElement('div');
    t.className = 'table';
    t.innerHTML = TABLE_SVG;
    fx.appendChild(t);
    const x0 = walker.x + WIDTH / 2 + dir * 50;
    const y0 = floorY(x0) - 30;
    const place = (x, y, rot) => {
      t.style.left = `${x - 27}px`;
      t.style.top = `${y}px`;
      t.style.transform = `rotate(${rot}deg)`;
    };
    place(x0, y0, 0);
    poof(x0, y0 + 15);
    lockInMessage = 'ARGH!!';
    el.classList.add('react-angry');
    renderBubble();
    await wait(700);
    // Flip.
    lockInMessage = '(╯°□°)╯︵ ┻━┻';
    el.classList.add('throwing');
    renderBubble();
    const x1 = x0 + dir * 130;
    const y1 = floorY(x1) - 30;
    await tween(650, (p) => place(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p - 90 * Math.sin(Math.PI * p), dir * 180 * p));
    burst(x1, y1 + 20);
    el.classList.remove('throwing');
    await wait(1300);
    // ...and calmly put it back.
    el.classList.remove('react-angry');
    lockInMessage = '…';
    renderBubble();
    await wait(700);
    await walkTo(x1 - WIDTH / 2 - dir * 60, 120);
    walker.dir = dir;
    lockInMessage = '┬─┬ノ( º _ ºノ)';
    renderBubble();
    el.classList.add('pickup');
    await tween(500, (p) => place(x1, y1 - 14 * Math.sin(Math.PI * p), dir * 180 * (1 - p)));
    el.classList.remove('pickup');
    await wait(1100);
    t.style.transition = 'opacity 0.4s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 450);
  }
  lockInMessage = null;
  puppet = false;
  renderBubble();
}

// ---------- seasons ----------
// Snow all winter; a pumpkin for Halloween week, a Santa hat at Christmas, a party hat and
// fireworks at New Year; and for Hungary's national days a cockade (fireworks on 20 August).
const seasonDate = () => (debug.date ? new Date(debug.date) : new Date());

function seasonFor(d) {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const s = { hat: null, snow: m === 12 || m <= 2, fireworks: false, cockade: false };
  if (m === 10 && day >= 24) s.hat = 'pumpkin';
  if (m === 12 && day >= 20 && day <= 26) s.hat = 'santa';
  if ((m === 12 && day === 31) || (m === 1 && day === 1)) {
    s.hat = 'party';
    s.fireworks = (m === 12 && h >= 18) || (m === 1 && h < 3);
  }
  if ((m === 3 && day === 15) || (m === 8 && day === 20) || (m === 10 && day === 23)) s.cockade = true;
  if (m === 8 && day === 20 && h >= 20) s.fireworks = true;
  return s;
}

let season = { hat: null, snow: false, fireworks: false, cockade: false };
let snowTimer = null;
let fireworksTimer = null;

function applySeason() {
  season = config.seasonal === false ? { hat: null, snow: false, fireworks: false, cockade: false } : seasonFor(seasonDate());
  seasonHat = ['none', 'agent47'].includes(config.hat) ? season.hat : null; // a hat of your own wins (47 has none)
  const ownHat = HATS.includes(config.hat);
  if (isBirthday() && !ownHat) seasonHat = 'party';
  el.classList.toggle('night-cap', isNight() && !ownHat && !seasonHat);
  if (isBirthday() && !confettiTimer) confettiTimer = setInterval(confetto, 280);
  if (!isBirthday() && confettiTimer) {
    clearInterval(confettiTimer);
    confettiTimer = null;
  }
  for (const k of ['pumpkin', 'santa', 'party']) el.classList.toggle(`season-${k}`, k === seasonHat);
  el.classList.toggle('wear-cockade', season.cockade);
  updateHatClasses();
  if (season.snow && !snowTimer) snowTimer = setInterval(snowflake, 380);
  if (!season.snow && snowTimer) {
    clearInterval(snowTimer);
    snowTimer = null;
  }
  if (season.fireworks && !fireworksTimer) scheduleFirework();
}

function snowflake() {
  if (document.hidden) return;
  const { min, max } = walkRange();
  const f = document.createElement('i');
  f.className = 'flake';
  const x = min + Math.random() * (max + WIDTH - min);
  const fall = floorY(x) + 6;
  f.style.left = `${x}px`;
  f.style.setProperty('--fall', `${fall}px`);
  f.style.setProperty('--drift', `${(Math.random() - 0.5) * 40}px`);
  const t = 6 + Math.random() * 4;
  f.style.setProperty('--t', `${t}s`);
  const size = 2 + Math.random() * 3;
  f.style.width = f.style.height = `${size}px`;
  fx.appendChild(f);
  setTimeout(() => f.remove(), t * 1000 + 100);
}

function scheduleFirework() {
  fireworksTimer = setTimeout(() => {
    fireworksTimer = null;
    if (!season.fireworks) return;
    if (!document.hidden) firework();
    scheduleFirework();
  }, 1400 + Math.random() * 2200);
}

async function firework() {
  const { min, max } = walkRange();
  const x = min + Math.random() * (max + WIDTH - min);
  const y0 = floorY(x);
  const y1 = Math.max(20, y0 - 110 - Math.random() * 80);
  const r = document.createElement('div');
  r.className = 'rocket';
  fx.appendChild(r);
  await tween(700, (p) => {
    r.style.left = `${x}px`;
    r.style.top = `${y0 + (y1 - y0) * easeOut(p)}px`;
  });
  r.remove();
  const colors = [['#ff5fa2', '#ffd23f'], ['#36d6ff', '#7cf06b'], ['#b07cff', '#ff8a3d'], ['#d32f2f', '#fbfbfb', '#2f8a3c']];
  const set = pick(colors);
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    const a = (Math.PI * 2 * i) / 16;
    const d = 30 + Math.random() * 25;
    s.style.left = `${x}px`;
    s.style.top = `${y1}px`;
    s.style.setProperty('--c', set[i % set.length]);
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * d + 12}px`);
    fx.appendChild(s);
    setTimeout(() => s.remove(), 1150);
  }
}

// ---------- game mode ----------
// Main reports a fullscreen window. On Claude's screen: hide. On another screen: grab a
// controller and play along (not for a fullscreen browser: that's a video, the TV's job).
let game = { active: false };
let gaming = false;
let hiddenForGame = false;
let gameLine = null;
let nextGameLine = 0;
const GAME_LINES = ['gg', 'nice!', 'one more round', 'clutch!!', 'lag!', 'let me try', 'ez'];
const GAME_LINES_HITMAN = ['Silent Assassin run?', 'Use the coin.', 'Suit only. Respect.', 'Not the duck…'];
const GAME_LINES_47 = ['Amateur.', 'Hmph.', 'I’d have used the coin.', 'Sloppy.'];

function updateGame(now = performance.now()) {
  let hide = false;
  let play = false;
  if (game.active && game.bounds && layout) {
    const left = game.bounds.x - layout.winX;
    const right = left + game.bounds.width;
    const cx = walker.x + WIDTH / 2;
    hide = cx >= left && cx < right;
    play =
      !hide && !game.browser && ['resting', 'working', 'done', 'recharged'].includes(state) &&
      !panicking && !scene && !puppet && !crying;
  }
  if (hide !== hiddenForGame) {
    hiddenForGame = hide;
    window.claudetop.setHidden(hide);
  }
  if (play !== gaming) {
    gaming = play;
    el.classList.toggle('gaming', play);
    walker.target = null;
    nextGameLine = now + 4000;
    if (!play) gameLine = null;
    updateDance();
    updateTv();
    updateDoing();
    renderBubble();
    renderInfo();
  }
  if (gaming && now > nextGameLine && !quiet()) {
    const hitman = /hitman/i.test(`${game.name} ${game.title}`);
    gameLine = pick(isAgent() ? GAME_LINES_47 : hitman && Math.random() < 0.6 ? GAME_LINES_HITMAN : GAME_LINES);
    nextGameLine = now + 9000 + Math.random() * 9000;
    renderBubble();
    setTimeout(() => {
      gameLine = null;
      renderBubble();
    }, 2400);
  }
}

window.claudetop.onGame((g) => {
  game = g;
  updateGame();
});

// ---------- more sessions, more Claudes ----------
// Every other active session gets a smaller Claude of its own colour that keeps to itself.
// Click any Claude to bring up its session.
const BUDDY_COLORS = ['#5b8def', '#4fa38f', '#9a7fd1', '#e0a43a'];
const BUDDY_ACTIVE_MS = 30 * 60 * 1000;
const MAX_BUDDIES = 4;
const buddies = new Map(); // session id -> { el, bubble, x, target, dir, pauseUntil, color, s }
const sessionColors = new Map(); // session id -> colour, kept while the session lives

function colorFor(id) {
  if (!sessionColors.has(id)) {
    const used = new Set(sessionColors.values());
    sessionColors.set(id, BUDDY_COLORS.find((c) => !used.has(c)) || BUDDY_COLORS[sessionColors.size % BUDDY_COLORS.length]);
  }
  return sessionColors.get(id);
}

function buddyState(s, now) {
  if (s.state === 'working' && now - s.at < WORKING_STALE_MS) return 'working';
  if (s.state === 'waiting' && now - s.at < WAITING_STALE_MS) return 'waiting';
  if (s.state === 'nocredit') return 'nocredit';
  if ((s.state === 'done' || s.state === 'error') && now - s.at < 90 * 1000) return 'done';
  return 'resting';
}

const projectOf = (s) => (s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : 'session');

function updateBuddies(now = Date.now()) {
  const lead = leadSession(now);
  const wanted = sessions
    .filter((s) => s !== lead && (['working', 'waiting'].includes(s.state) || now - s.at < BUDDY_ACTIVE_MS))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_BUDDIES);
  const ids = new Set(wanted.map((s) => s.id));
  for (const [id, b] of buddies) {
    if (ids.has(id)) continue;
    poof(b.x + WIDTH / 2, floorY(b.x + WIDTH / 2) - 25);
    b.el.remove();
    buddies.delete(id);
  }
  for (const s of wanted) {
    let b = buddies.get(s.id);
    if (!b) b = makeBuddy(s);
    b.s = s;
    const st = buddyState(s, now);
    for (const k of ['working', 'waiting', 'done', 'nocredit', 'resting']) b.el.classList.toggle(k, k === st);
    // A chef notices when 47 turns up dressed as one.
    if (b.hat === 'chef' && disguise === 'chef' && !b.metChef && !quiet()) {
      b.metChef = true;
      b.line = pick(['Nice hat, colleague.', 'Hey! That’s my look!', 'New in the kitchen?']);
      b.lineUntil = Date.now() + 3500;
    }
    if (disguise !== 'chef') b.metChef = false;
    const line = b.lineUntil > Date.now() ? b.line : null;
    const text = b.hover ? `${projectOf(s)}: ${LABELS[s.state] || s.state}` : line || { waiting: 'Needs you!', done: 'Done!' }[st] || '';
    if (b.bubble.textContent !== text) b.bubble.textContent = text;
    b.bubble.classList.toggle('show', !!text);
  }
  for (const id of sessionColors.keys()) if (!sessions.some((s) => s.id === id)) sessionColors.delete(id);
  for (const id of sessionHats.keys()) if (!sessions.some((s) => s.id === id)) sessionHats.delete(id);
}

// Each extra Claude gets a hat of its own: random, not one anybody else is wearing, and kept
// for as long as its session lives. Scroll over it for another.
const sessionHats = new Map(); // session id -> hat
function hatFor(id) {
  if (!sessionHats.has(id)) {
    const taken = new Set([config.hat, ...sessionHats.values()]);
    const free = HATS.filter((h) => !taken.has(h));
    sessionHats.set(id, pick(free.length ? free : HATS));
  }
  return sessionHats.get(id);
}

function dressBuddy(b) {
  for (const h of HATS) b.el.classList.toggle(`hat-${h}`, h === b.hat);
  b.el.classList.add('hat-on');
}

function makeBuddy(s) {
  const color = colorFor(s.id);
  const node = document.createElement('div');
  node.className = 'buddy arrive';
  node.innerHTML = `<div class="bubble"></div><div class="zzz"><span>z</span><span>z</span><span>Z</span></div>${sprite.outerHTML.replace(' id="sprite"', '')}<div class="shadow"></div>`;
  node.querySelector('.sprite').classList.remove('flip', 'blink');
  node.style.setProperty('--clay', color);
  document.body.appendChild(node);
  const { min, max } = walkRange();
  const b = { el: node, bubble: node.querySelector('.bubble'), x: min + Math.random() * (max - min), target: null, dir: 1, pauseUntil: 0, color, s, hover: false, hat: hatFor(s.id), line: null, lineUntil: 0 };
  dressBuddy(b);
  let lastWheel = 0;
  node.addEventListener('wheel', (e) => {
    const now = performance.now();
    if (now - lastWheel < 350) return;
    lastWheel = now;
    const i = HATS.indexOf(b.hat);
    b.hat = HATS[(i + (Math.sign(e.deltaY) || 1) + HATS.length) % HATS.length];
    sessionHats.set(b.s.id, b.hat);
    poof(b.x + WIDTH / 2, floorY(b.x + WIDTH / 2) - 50);
    dressBuddy(b);
  }, { passive: true });
  setTimeout(() => node.classList.remove('arrive'), 500);
  node.addEventListener('mouseenter', () => {
    b.hover = true;
    window.claudetop.setIgnoreMouse(false);
    updateBuddies();
  });
  node.addEventListener('mouseleave', () => {
    b.hover = false;
    if (!dragging) window.claudetop.setIgnoreMouse(true);
    updateBuddies();
  });
  node.addEventListener('click', () => window.claudetop.jumpTo(b.s.chain || []));
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.claudetop.showMenu();
  });
  buddies.set(s.id, b);
  return b;
}

function moveBuddies(t, dt) {
  const { min, max } = walkRange();
  for (const b of buddies.values()) {
    b.x = Math.max(min, Math.min(max, b.x));
    let moving = false;
    if (b.el.classList.contains('working') && config.mode === 'walk' && t >= b.pauseUntil) {
      if (b.target === null) b.target = min + Math.random() * (max - min);
      const d = b.target - b.x;
      if (Math.abs(d) < 2) {
        b.target = null;
        b.pauseUntil = t + 600 + Math.random() * 2000;
      } else {
        b.dir = Math.sign(d);
        b.x += b.dir * Math.min(Math.abs(d), 55 * dt);
        moving = true;
      }
    }
    b.el.classList.toggle('walking', moving);
    b.el.querySelector('.sprite').classList.toggle('flip', b.dir < 0);
    b.el.style.left = `${Math.round(b.x)}px`;
    b.el.style.bottom = `${4 + groundAt(b.x)}px`;
  }
}

// ---------- click: jump to Claude Code ----------
function jumpToLead() {
  const lead = leadSession();
  if (!lead) return;
  window.claudetop.jumpTo(lead.chain || []);
  el.classList.remove('jumped');
  void el.offsetWidth;
  el.classList.add('jumped');
  setTimeout(() => el.classList.remove('jumped'), 550);
}

// ---------- do not disturb ----------
// By hand, or automatically while an app uses the microphone (a call, a stream): no sounds,
// no panic runs, no tears, no flipped tables, no chatter.
const quiet = () => !!config.dnd || (config.dndCalls !== false && !!config.micInUse);

// Say something for a moment (game chatter, night-owl nagging, birthday wishes...).
function say(text, ms = 2600) {
  gameLine = text;
  renderBubble();
  setTimeout(() => {
    if (gameLine === text) gameLine = null;
    renderBubble();
  }, ms);
}

// ---------- sounds ----------
// Little 8-bit jingles, synthesised on the spot (no sound files).
let audio = null;
const SOUNDS = {
  done: { type: 'square', notes: [[523, 0, 0.11], [659, 0.1, 0.11], [784, 0.2, 0.11], [1047, 0.3, 0.3]] },
  waiting: { type: 'square', notes: [[880, 0, 0.1], [660, 0.15, 0.2]] },
  achievement: { type: 'square', notes: [[784, 0, 0.09], [988, 0.08, 0.09], [1175, 0.16, 0.09], [1568, 0.24, 0.4]] },
  recharged: { type: 'triangle', notes: [[392, 0, 0.1], [523, 0.08, 0.1], [659, 0.16, 0.1], [784, 0.24, 0.1], [1047, 0.32, 0.35]] },
  // 47 prefers something lower.
  done47: { type: 'triangle', notes: [[196, 0, 0.3], [247, 0.28, 0.3], [294, 0.56, 0.6]] },
  waiting47: { type: 'triangle', notes: [[294, 0, 0.18], [247, 0.2, 0.35]] },
};

function play(name) {
  if (config.sounds === false || quiet() || Date.now() < (config.soundsSnoozedUntil || 0)) return;
  const sound = SOUNDS[isAgent() && SOUNDS[`${name}47`] ? `${name}47` : name];
  if (!sound) return;
  try {
    audio = audio || new AudioContext();
    const t0 = audio.currentTime + 0.02;
    for (const [freq, start, dur] of sound.notes) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = sound.type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.05, t0 + start);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g).connect(audio.destination);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.05);
    }
  } catch {}
}

// ---------- stats and achievements ----------
const appStart = Date.now();
const countedTasks = new Set();
let workAcc = 0;
let lastWorkFlush = Date.now();
let nightCounted = '';
const stat = (key, amount = 1) => window.claudetop.stat(key, amount);

function countTasks() {
  for (const s of sessions) {
    if (s.state !== 'done' || s.at < appStart) continue;
    const key = `${s.id}:${s.at}`;
    if (countedTasks.has(key)) continue;
    countedTasks.add(key);
    stat('tasks');
    if (s.prompts === 0) stat('silent');
  }
}

function countWork(now = Date.now()) {
  const working = sessions.some((s) => s.state === 'working' && now - s.at < WORKING_STALE_MS);
  if (working) {
    workAcc += 500;
    const day = new Date(now).toDateString();
    if (new Date(now).getHours() < 5 && nightCounted !== day) {
      nightCounted = day;
      stat('night');
    }
  }
  if (now - lastWorkFlush > 30000) {
    if (workAcc) stat('workMs', workAcc);
    workAcc = 0;
    lastWorkFlush = now;
  }
}

const achievementQueue = [];
window.claudetop.onAchievement((a) => {
  achievementQueue.push(a);
  showAchievements();
});

let showingAchievement = false;
async function showAchievements() {
  if (showingAchievement || quiet() || hiddenForGame) return;
  const a = achievementQueue.shift();
  if (!a) return;
  showingAchievement = true;
  const t = document.createElement('div');
  t.className = 'achievement';
  t.innerHTML =
    `<span class="a-cup">🏆</span><span><span class="a-head">ACHIEVEMENT UNLOCKED</span>` +
    `<span class="a-name">${escapeHtml(a.name)}</span>${a.description ? `<span class="a-text">${escapeHtml(a.description)}</span>` : ''}</span>`;
  const head = headPoint();
  t.style.left = `${Math.max(150, Math.min(window.innerWidth - 150, head.x))}px`;
  t.style.top = `${Math.max(4, head.y - 112)}px`;
  fx.appendChild(t);
  play('achievement');
  await wait(5000);
  t.classList.add('leaving');
  await wait(550);
  t.remove();
  showingAchievement = false;
  showAchievements();
}

// ---------- night owl and birthdays ----------
// Between midnight and 5 a.m. Claude wears a nightcap, yawns, and tells you to go to bed.
// On your birthday: party hat, confetti, and wishes.
const isNight = (d = seasonDate()) => d.getHours() < 5;
function isBirthday(d = seasonDate()) {
  const pad = (n) => String(n).padStart(2, '0');
  return !!config.birthday && config.birthday === `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let nextYawn = 0;
let nextNag = 0;
let nextWish = 0;
let lastActive = Date.now(); // you switched windows: you're up
let confettiTimer = null;

function nightAndBirthdayTick(now = Date.now()) {
  const busy = puppet || panicking || scene || crying || dancing || gaming || dragging;
  if (isNight() && !busy) {
    if (now > nextYawn) {
      if (nextYawn) {
        el.classList.add('yawn');
        setTimeout(() => el.classList.remove('yawn'), 1600);
        if (!quiet()) say('*yawn*', 1600);
      }
      nextYawn = now + 120000 + Math.random() * 120000;
    }
    if (now > nextNag && now - lastActive < 120000 && !quiet()) {
      if (nextNag) say(pick(isAgent() ? ['Even I sleep.', 'Rest is part of the job.'] : ['go to sleep 😴', "It's late…", 'Bed. Now.', 'The code will still be here tomorrow']), 3200);
      nextNag = now + 15 * 60000 + Math.random() * 10 * 60000;
    }
  }
  if (isBirthday() && !busy && !quiet() && now > nextWish) {
    say(isAgent() ? 'Happy birthday. Don’t tell anyone I said that.' : pick(['Happy birthday! 🎂', 'It’s your birthday!! 🎉', 'Happy birthday!! 🥳']), 4000);
    nextWish = now + 45 * 60000;
  }
}

function confetto() {
  if (document.hidden) return;
  const { min, max } = walkRange();
  const c = document.createElement('i');
  c.className = 'confetti';
  const x = min + Math.random() * (max + WIDTH - min);
  c.style.left = `${x}px`;
  c.style.setProperty('--c', pick(['#ff5fa2', '#ffd23f', '#36d6ff', '#7cf06b', '#b07cff', '#ff8a3d']));
  c.style.setProperty('--fall', `${floorY(x) + 8}px`);
  c.style.setProperty('--drift', `${(Math.random() - 0.5) * 60}px`);
  const t = 2.5 + Math.random() * 2;
  c.style.setProperty('--t', `${t}s`);
  fx.appendChild(c);
  setTimeout(() => c.remove(), t * 1000 + 100);
}

// ---------- Hitman ----------
// While a Hitman game runs, 47 cheers you on now and then; when it closes, he takes a bow.
let nextHitmanLine = 0;
function hitmanTick(now = Date.now()) {
  if (!config.hitmanRunning || quiet() || puppet || panicking) return;
  if (!nextHitmanLine) nextHitmanLine = (config.hitmanSince || now) + 15 * 60000;
  if (now < nextHitmanLine) return;
  const minutes = Math.round((now - (config.hitmanSince || now)) / 60000);
  say(pick(['Patience. The target always comes.', 'Still undetected?', 'Remember the exit.', 'Nice work out there.', 'Don’t forget the coin.', `${minutes} minutes in. Professional.`]), 3500);
  nextHitmanLine = now + 15 * 60000 + Math.random() * 10 * 60000;
}

function hitmanChanged(started, hatChanged) {
  if (!entered) return;
  if (started) {
    nextHitmanLine = 0;
    if (!quiet()) say(hatChanged ? pick(['Suit up.', 'Time to work.', 'Hitman? Say no more.']) : 'Mission briefing received.');
    return;
  }
  el.classList.add('bow');
  setTimeout(() => el.classList.remove('bow'), 1400);
  if (!quiet()) say(hatChanged ? pick(['Good game.', 'Back to the day job.']) : 'Good game.', 3000);
}

// ---------- throwing Claude ----------
// Pick Claude up and let go with some speed: it flies, bounces off the edges, lands dizzy.
const GRAVITY = 1800; // px/s²
async function fling(vx, vy) {
  puppet = true;
  walker.target = null;
  el.classList.add('flung');
  const H = window.innerHeight;
  const { min, max } = walkRange();
  let b = walker.airBottom ?? 4 + groundAt(walker.x);
  let last = performance.now();
  let bounces = 0;
  await new Promise((resolve) => {
    const step = (t) => {
      const dt = Math.min(0.033, (t - last) / 1000);
      last = t;
      vy -= GRAVITY * dt;
      walker.x += vx * dt;
      b += vy * dt;
      walker.rot += vx * dt * 1.4;
      if (walker.x < min) { walker.x = min; vx = Math.abs(vx) * 0.7; burst(walker.x, H - b - 30); }
      if (walker.x > max) { walker.x = max; vx = -Math.abs(vx) * 0.7; burst(walker.x + WIDTH, H - b - 30); }
      if (b + 64 > H) { b = H - 64; vy = -Math.abs(vy) * 0.5; }
      const floor = 4 + groundAt(walker.x);
      if (b <= floor) {
        b = floor;
        if (Math.abs(vy) > 260 && bounces < 4) {
          vy = Math.abs(vy) * 0.42;
          vx *= 0.75;
          bounces++;
          dirt(walker.x + WIDTH / 2, floorY(walker.x + WIDTH / 2) - 4, 5);
        } else {
          walker.airBottom = null;
          resolve();
          return;
        }
      }
      walker.airBottom = b;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  // Land upright, a little dizzy.
  const rot = walker.rot % 360;
  const target = Math.abs(rot) > 180 ? Math.sign(rot) * 360 : 0;
  await tween(220, (p) => {
    walker.rot = rot + (target - rot) * p;
  });
  walker.rot = 0;
  el.classList.remove('flung');
  el.classList.add('landing');
  const cx = walker.x + WIDTH / 2;
  const stars = dizzyStars(cx, floorY(cx) - 80);
  await wait(300);
  el.classList.remove('landing');
  stat('flings');
  if (!quiet()) say(isAgent() ? pick(['Unnecessary.', 'I’ll remember that.']) : pick(['whoa…', 'again!!', 'the room is spinning', 'rude.']), 2200);
  await wait(1500);
  stars.remove();
  walker.pauseUntil = performance.now() + 1500;
  puppet = false;
}


// ---------- little things ----------
// Clicks: one opens Claude Code, two (or more, quickly) is a pet, ten in a row is too many.
let clickCount = 0;
let clickTimer = null;
let rapidClicks = 0;
let lastClickAt = 0;

function registerClick() {
  const now = performance.now();
  rapidClicks = now - lastClickAt < 600 ? rapidClicks + 1 : 1;
  lastClickAt = now;
  if (rapidClicks >= 10) {
    rapidClicks = 0;
    clickCount = 0;
    clearTimeout(clickTimer);
    annoyed();
    return;
  }
  clickCount++;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    const n = clickCount;
    clickCount = 0;
    if (n === 1) jumpToLead();
    else pet();
  }, 280);
}

function pet() {
  if (puppet) return;
  el.classList.remove('petted');
  void el.offsetWidth;
  el.classList.add('petted');
  setTimeout(() => el.classList.remove('petted'), 900);
  const h = headPoint();
  const heart = fxNode('heart');
  heart.textContent = '❤';
  heart.style.left = `${h.x + (Math.random() - 0.5) * 30}px`;
  heart.style.top = `${h.y - 10}px`;
  setTimeout(() => heart.remove(), 1200);
}

async function annoyed() {
  if (puppet) return;
  el.classList.add('react-angry');
  say(isAgent() ? 'Touch me again. I dare you.' : pick(['ok, ok, I’m here!', 'STOP CLICKING', 'what?! WHAT?!']), 2200);
  await wait(1600);
  el.classList.remove('react-angry');
}

// Scroll over Claude to change hats.
let lastWheel = 0;
el.addEventListener('wheel', (e) => {
  const now = performance.now();
  if (now - lastWheel < 350 || puppet) return;
  lastWheel = now;
  window.claudetop.cycleHat(Math.sign(e.deltaY) || 1);
}, { passive: true });

// Remember where Claude was standing, so the next start begins there (walk mode).
let savedX = null;
function rememberSpot() {
  if (config.mode !== 'walk' || spanning || puppet || walker.x == null) return;
  const x = walker.x - home().left;
  if (savedX !== null && Math.abs(x - savedX) < 20) return;
  savedX = x;
  window.claudetop.setLastX(x);
}
setInterval(rememberSpot, 10000);

// Every few minutes of rest, Claude does something to pass the time.
let nextIdle = Date.now() + 3 * 60000;
async function idleMoment(now = Date.now()) {
  if (now < nextIdle) return;
  nextIdle = now + (3 + Math.random() * 4) * 60000;
  const busy = puppet || panicking || scene || crying || dancing || tv || gaming || dragging || quiet();
  if (state !== 'resting' || busy || hiddenForGame) return;
  const moves = ['newspaper', 'juggle', 'snore'];
  if (config.hat === 'cowboy') moves.push('lasso', 'lasso');
  const move = pick(moves);
  puppet = true;
  if (move === 'newspaper') {
    el.classList.add('reading');
    say(pick(['hm.', 'interesting…', 'huh.', 'no way.']), 2000);
    await wait(6000);
    el.classList.remove('reading');
  } else if (move === 'juggle') {
    el.classList.add('juggling');
    const balls = fxNode('juggle', '<i></i><i></i><i></i>');
    const place = () => {
      const h = headPoint();
      balls.style.left = `${h.x}px`;
      balls.style.top = `${h.y - 20}px`;
    };
    place();
    await wait(5000);
    balls.remove();
    el.classList.remove('juggling');
  } else if (move === 'snore') {
    el.classList.add('snore');
    say('*SNOOOORE*', 2600);
    await wait(3000);
    el.classList.remove('snore');
  } else if (move === 'lasso') {
    const over = fxNode('lasso-overhead');
    const h = headPoint();
    over.style.left = `${h.x + walker.dir * 12}px`;
    over.style.top = `${h.y - 26}px`;
    el.classList.add('throwing');
    await wait(2500);
    el.classList.remove('throwing');
    over.remove();
  }
  puppet = false;
}

// ---------- hover info ----------
const LABELS = {
  working: 'working',
  waiting: 'needs your input',
  done: 'finished',
  nocredit: 'out of credits',
  recharged: 'back from its usage limit',
  error: 'stopped with an error',
  idle: 'idle',
};

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
      const reset = s.state === 'nocredit' && s.resetAt > now ? `, back at ${clock(s.resetAt)}` : '';
      const b = buddies.get(s.id);
      const dot = b ? `<span style="color:${b.color}">●</span> ` : '';
      return `${dot}${escapeHtml(project)}: ${LABELS[s.state] || s.state}${reset}${tool} <span class="muted">${ago(now - s.at)}</span>`;
    });
  if (!rows.length) rows.push('<span class="muted">No Claude Code sessions yet</span>');
  if (dancing) {
    const song = [media.artist, media.title].filter(Boolean).join(' – ');
    rows.push(`♪ ${escapeHtml(song || 'Vibing')}`);
  }
  if (tv) rows.push(`📺 ${escapeHtml(media.title || 'Watching TV')}`);
  if (quiet()) rows.push(`🔕 Do not disturb${config.dnd ? '' : ' (a call is on)'}`);
  if (gaming) rows.push(`🎮 Playing along: ${escapeHtml(game.title || game.name || 'a game')}`);
  if (sessions.length) rows.push('<span class="muted">Click to open Claude Code</span>');
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
  if (dancing || tv || crying || gaming || sleepbag) return 0;
  if (config.mode !== 'walk') return 0;
  if (state === 'working' && held === 'coffee') return isAgent() ? 32 : 45; // no spilling
  if (state === 'working') return isAgent() ? 47 : 70 * (HAT_SPEED[config.hat] || 1);
  if (state === 'done' || state === 'recharged') return 30 * (HAT_SPEED[config.hat] || 1);
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

const IS_LINUX = window.claudetop.platform === 'linux';
let lastRectSent = 0;

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
      if (TRAVEL[config.hat] && !panicking && !dragging && Math.abs(walker.target - walker.x) > DIG_MIN_TRIP) {
        TRAVEL[config.hat](walker.target);
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
    el.classList.toggle('riding', moving && RIDES.includes(config.hat));
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
  moveBuddies(t, dt);
  // Linux can't forward mouse movement through the window, so tell main where Claude is.
  if (IS_LINUX && t - lastRectSent > 80) {
    lastRectSent = t;
    const r = el.getBoundingClientRect();
    const hits = [r, ...[...buddies.values()].map((b) => b.el.getBoundingClientRect())];
    window.claudetop.claudeRect(hits.map((h) => ({ x: window.screenX + h.left, y: window.screenY + h.top, w: h.width, h: h.height })));
    // Everything visible: Claude plus room above for the hat, bubble and hover info, and every
    // effect (flying hats, the TV, holes, notes...).
    const pad = 18;
    const rects = [{ x: r.left - 120 - pad, y: r.top - 150, w: r.width + 240 + 2 * pad, h: r.height + 150 + pad }];
    for (const b of buddies.values()) {
      const h = b.el.getBoundingClientRect();
      rects.push({ x: h.left - 60, y: h.top - 60, w: h.width + 120, h: h.height + 60 + pad });
    }
    for (const node of fx.children) {
      const b = node.getBoundingClientRect();
      if (b.width && b.height) rects.push({ x: b.left - pad, y: b.top - pad, w: b.width + 2 * pad, h: b.height + 2 * pad });
    }
    window.claudetop.shape(rects);
  }
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
  if (e.button !== 0 || puppet) return;
  const r = el.getBoundingClientRect();
  dragging = {
    offset: e.clientX - walker.x,
    grabBottom: r.bottom - e.clientY, // where on Claude you grabbed it
    startX: e.clientX,
    startY: e.clientY,
    at: performance.now(),
    moved: false,
    samples: [],
  };
  walker.target = null;
  el.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (!dragging.moved && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) < 4) return;
  dragging.moved = true;
  const { min, max } = walkRange();
  walker.x = Math.max(min, Math.min(max, e.clientX - dragging.offset));
  // Lift it off the floor too.
  const floor = 4 + groundAt(walker.x);
  const b = window.innerHeight - e.clientY - dragging.grabBottom;
  walker.airBottom = b > floor + 6 ? Math.min(b, window.innerHeight - 64) : null;
  el.classList.toggle('held', walker.airBottom !== null);
  const t = performance.now();
  dragging.samples.push({ x: e.clientX, y: e.clientY, t });
  while (dragging.samples.length > 2 && t - dragging.samples[0].t > 90) dragging.samples.shift();
});

// Let go in mid-air: drop to the floor.
async function drop() {
  puppet = true;
  const top = walker.airBottom;
  const land = 4 + groundAt(walker.x);
  el.classList.add('falling');
  await tween(Math.max(200, Math.sqrt(Math.max(1, top - land)) * 22), (p) => {
    walker.airBottom = top + (land - top) * p * p;
  });
  walker.airBottom = null;
  el.classList.remove('falling');
  el.classList.add('landing');
  await wait(300);
  el.classList.remove('landing');
  puppet = false;
}

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  const click = !dragging.moved && performance.now() - dragging.at < 500;
  const samples = dragging.samples;
  dragging = null;
  el.classList.remove('dragging', 'held');
  if (click) {
    registerClick();
    if (!hovering) window.claudetop.setIgnoreMouse(true);
    return;
  }
  // Thrown? (how fast the mouse was going when you let go)
  const a = samples[0];
  const z = samples[samples.length - 1];
  const dt = a && z ? (z.t - a.t) / 1000 : 0;
  if (dt > 0.01 && performance.now() - z.t < 120) {
    const vx = (z.x - a.x) / dt;
    const vy = -(z.y - a.y) / dt;
    if (Math.hypot(vx, vy) > 500) {
      fling(Math.max(-2600, Math.min(2600, vx)), Math.max(-2600, Math.min(2600, vy)));
      if (!hovering) window.claudetop.setIgnoreMouse(true);
      return;
    }
  }
  if (walker.airBottom !== null) drop();
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
  const wasRunning = !!config.hitmanRunning;
  const firstConfig = !configLoaded;
  const movedScreen = configLoaded && cfg.displayId !== config.displayId;
  configLoaded = true;
  config = cfg;
  // Switching to "stay in place" pins Claude right where it's standing.
  if (enteringFixed && walker.x != null) {
    config.fixedX = walker.x - home().left;
    window.claudetop.setFixedX(config.fixedX);
  }
  updateHatClasses();
  for (const h of [...HATS, 'agent47']) el.classList.toggle(`hat-${h}`, config.hat === h);
  if (hatChanged) renderBubble(); // Agent 47 has his own lines
  if (hatChanged && !puppet && entered) swapHat(oldHat);
  if (!firstConfig && !!cfg.hitmanRunning !== wasRunning) hitmanChanged(!!cfg.hitmanRunning, hatChanged);
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
  applySeason();
  updateDoing();
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
  const lastX = config.lastX != null && config.lastX >= 0 && config.lastX <= h.right - h.left - WIDTH ? config.lastX : null;
  walker.x = h.left + (config.mode === 'fixed' && config.fixedX != null ? config.fixedX : lastX ?? (h.right - h.left - WIDTH) / 2);
  savedX = walker.x - h.left;
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
  checkRage();
  countTasks();
  updateBuddies();
  updateDoing();
  if (hovering) renderInfo();
});

window.claudetop.onLockIn(lockIn);

window.claudetop.onFocus((f) => {
  if (f.title !== focus.title || f.pid !== focus.pid) lastActive = Date.now();
  focus = f;
  checkJealous();
  setState(computeState(Date.now()));
});

setInterval(() => {
  setState(computeState(Date.now()));
  updatePanic(); // you may have just opened Claude Code
  updateDance();
  updateTv();
  updateDoing();
  updateGame();
  updateBuddies();
  countWork();
  nightAndBirthdayTick();
  hitmanTick();
  idleMoment();
  showAchievements();
  if (hovering) renderInfo();
}, 500);
setInterval(applySeason, 60 * 1000);

el.classList.add(state);
scheduleBlink();
requestAnimationFrame(tick);
