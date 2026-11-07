// The playground: runs the app's own Claude (claude-frame/, built from src/ by
// scripts/build-playground.js) and plays the part of everything around it: Claude Code's sessions,
// the window in front, media, games, the settings. The buttons change those, and Claude reacts the
// way it does in the app.

const $ = (id) => document.getElementById(id);
const screens = $('screens');
const frame = $('frame');
const note = $('note');

const HAT_ORDER = ['none', 'hard', 'propeller', 'miner', 'cowboy', 'wizard', 'pirate', 'astronaut', 'ninja', 'crown', 'chef', 'agent47'];
const HAT_NAMES = {
  none: 'No hat', hard: 'Hard hat', propeller: 'Propeller', miner: 'Miner', cowboy: 'Cowboy', wizard: 'Wizard',
  pirate: 'Pirate', astronaut: 'Astronaut', ninja: 'Ninja', crown: 'Crown', chef: 'Chef', agent47: 'Agent 47',
};
const HAT_NOTES = {
  none: 'No hat: walks everywhere. Try a tab you shouldn’t.',
  hard: 'Hard hat: try Done with “Panic when done” on, then go back to Claude Code.',
  propeller: 'Propeller: try a tab you shouldn’t.',
  miner: 'Miner: long trips go underground. Watch it work for a bit.',
  cowboy: 'Cowboy: rides a horse while it works. Idle a while for a lasso.',
  wizard: 'Wizard: teleports on long trips.',
  pirate: 'Pirate: sails while it works.',
  astronaut: 'Astronaut: low gravity. Try a tab you shouldn’t.',
  ninja: 'Ninja: dashes on long trips.',
  crown: 'Crown: walks slowly, in a cape. Has people for tabs.',
  chef: 'Chef: rolls along on a meatball.',
  agent47: 'Agent 47: 47 px per second. Every job gets a rating, every permission prompt is a witness.',
};
const MINUTE = 60000;

// ---------- the world claudetop sees ----------
const config = {
  mode: 'walk', fixedX: null, lastX: null, preview: null, displayId: 1,
  hat: 'none', panicWhenDone: true, roam: false, sounds: true, dnd: false, dndCalls: true, micInUse: false,
  dance: 'apps', tv: true, jealous: true, seasonal: true, gameMode: true, birthday: null,
  hitmanRunning: false, hitmanSince: 0,
};
let hitmanHat = null; // the hat to go back to when Hitman closes

const PROJECTS = ['website', 'api', 'docs', 'mobile-app'];
const main = {
  id: 'main', state: 'working', at: Date.now(), taskStart: Date.now(), tool: 'Edit',
  cwd: 'C:\\code\\my-app', chain: ['200:WindowsTerminal.exe'], prompts: 0,
};
const extra = []; // more sessions: a smaller Claude each

const FOCUS = {
  desktop: { pid: 100, name: 'explorer.exe', title: '' },
  claude: { pid: 200, name: 'WindowsTerminal.exe', title: '✳ my-app' },
};
let focus = FOCUS.desktop;
let media = { playing: false };
let browserTab = { title: 'New tab', address: 'Search or type a web address', page: '', html: 'Search the web' };

let ready = false;
const play = () => frame.contentWindow && frame.contentWindow.__play;
const emit = (name, value) => {
  const w = frame.contentWindow;
  if (ready && w && w.__claudetop) w.__claudetop.emit(name, JSON.parse(JSON.stringify(value)));
};

function shownConfig() {
  return { ...config, hat: config.hitmanRunning ? 'agent47' : config.hat };
}
const pushConfig = () => emit('config', shownConfig());
function pushSessions() {
  const now = Date.now();
  // Hooks report in all the time while Claude Code works; the main session stays the freshest so
  // it keeps being the big Claude.
  if (['working', 'waiting'].includes(main.state)) main.at = now;
  // The other sessions work while the main one does and rest otherwise: any session at work
  // keeps the big Claude working, so they'd hide "done" or "idle".
  extra.forEach((s, i) => {
    s.state = main.state === 'working' ? 'working' : 'idle';
    s.at = now - 1000 * (i + 1);
  });
  emit('sessions', [main, ...extra]);
  renderTerminal();
}
setInterval(pushSessions, 30 * 1000);

function setFocus(next) {
  focus = next;
  emit('focus', focus);
  $('terminal').classList.toggle('focused', focus === FOCUS.claude);
  $('browser').classList.toggle('focused', focus.name === 'chrome.exe');
}

function say(text) {
  note.textContent = text || '';
}

// ---------- the screens ----------
let layout = null;
let two = true;

function measure() {
  const r = screens.getBoundingClientRect();
  const W = Math.round(r.width);
  const H = Math.round(r.height);
  two = W >= 820;
  screens.classList.toggle('one', !two);
  // The browser lives on the other screen, or next to the terminal when there's only one.
  const home = two ? $('m2') : $('m1');
  if ($('browser').parentElement !== home) home.insertBefore($('browser'), home.querySelector('.taskbar-strip'));
  $('game-there').hidden = !two;

  const cs = getComputedStyle(screens);
  const bar = parseFloat(cs.getPropertyValue('--bar')) || 40;
  const lower = parseFloat(cs.getPropertyValue('--lower')) || 28;
  const half = Math.round(W / 2);
  const m1 = { left: 0, right: two ? half : W, ground: bar + 3 };
  const segments = [m1];
  if (two) segments.push({ left: half, right: W, ground: bar + lower + 3 });
  layout = { winX: 0, winY: 0, home: m1, segments, desktop: { left: 0, right: W }, W, H };
  emit('layout', layout);
  if (game) startGame(game.where); // the screen it covers has moved
}
new ResizeObserver(measure).observe(screens);

// Rect of an element on the screens, in the frame's page coordinates (= "screen" coordinates).
function rectOf(node) {
  const s = frame.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, width: r.width, height: r.height };
}

// ---------- what the terminal and browser show ----------
const TOOL_LINES = {
  Grep: 'Searching for "sad"…', Edit: 'Editing src/login.js…', Bash: 'Running npm test…', Read: 'Reading src/login.js…', '': 'Thinking…',
};
let resetTimer = null;

function renderTerminal() {
  const line = $('term-line');
  const now = Date.now();
  let text = '';
  let cls = '';
  let glyph = '✳';
  if (main.state === 'working') {
    const min = Math.floor((now - main.taskStart) / MINUTE);
    text = `${TOOL_LINES[main.tool || '']}${min ? `  (${min} min)` : ''}`;
    glyph = '◐';
  } else if (main.state === 'waiting') {
    text = 'Allow Bash: npm install?  [y/n]';
    cls = 'ask';
    glyph = '?';
  } else if (main.state === 'done') {
    text = '✓ Done. 3 files changed.';
    cls = 'ok';
  } else if (main.state === 'error') {
    text = '✗ API error. Something went wrong.';
    cls = 'bad';
  } else if (main.state === 'nocredit') {
    const left = Math.ceil((main.resetAt - now) / 1000);
    text = left > 0 ? `Usage limit reached. Resets in ${left}s.` : 'Your limit has reset.';
    cls = left > 0 ? 'bad' : 'ok';
  } else {
    text = '> _';
  }
  line.textContent = text;
  line.className = cls;
  $('term-glyph').textContent = glyph;
}

function renderBrowser() {
  $('tab').classList.remove('closing');
  $('tab-title').textContent = browserTab.title;
  $('address').textContent = browserTab.address;
  const page = $('page');
  page.className = `page ${browserTab.page}`;
  page.textContent = browserTab.html;
}
const NEW_TAB = { title: 'New tab', address: 'Search or type a web address', page: '', html: 'Search the web' };

// ---------- the clock on the taskbars ----------
let pretendDate = null; // ISO string, or null for now
function renderClock() {
  const d = pretendDate ? new Date(pretendDate) : new Date();
  const text = d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  $('clock1').textContent = text;
  $('clock2').textContent = text;
}
setInterval(renderClock, 10 * 1000);

// ---------- what the page asks of us (src/preload.js's job in the app) ----------
let mouseThrough = true;
window.playHost = {
  setIgnoreMouse(ignore) {
    mouseThrough = ignore && !touchOnly;
    frame.style.pointerEvents = mouseThrough ? 'none' : 'auto';
  },
  setHidden(hidden) {
    frame.style.visibility = hidden ? 'hidden' : '';
  },
  setFixedX(x) {
    config.fixedX = x;
  },
  jumpTo() {
    goToClaudeCode();
  },
  cycleHat(step) {
    const shown = shownConfig().hat;
    const i = Math.max(0, HAT_ORDER.indexOf(shown));
    setHat(HAT_ORDER[(i + (step > 0 ? 1 : -1) + HAT_ORDER.length) % HAT_ORDER.length]);
  },
  showMenu() {
    const s = $('settings');
    s.scrollIntoView({ behavior: 'smooth', block: 'center' });
    s.classList.add('flash');
    setTimeout(() => s.classList.remove('flash'), 1400);
  },
  lockInClose() {
    if (!lockInOpen) return;
    lockInOpen = false;
    $('tab').classList.add('closing');
    setTimeout(() => {
      browserTab = NEW_TAB;
      renderBrowser();
      setFocus(FOCUS.desktop);
    }, 450);
  },
  lockInDone() {},
};

// The app's window lets clicks through except over Claude. Do the same: only take the mouse
// while it's over a Claude (the page itself says when it's left again).
const touchOnly = matchMedia('(hover: none)').matches;
screens.addEventListener('mousemove', (e) => {
  if (!mouseThrough || !ready) return;
  const r = frame.getBoundingClientRect();
  const doc = frame.contentDocument;
  const hit = doc && doc.elementFromPoint(e.clientX - r.left, e.clientY - r.top);
  if (hit && hit.closest('#claude, .buddy')) window.playHost.setIgnoreMouse(false);
});

// ---------- buttons ----------
function press(group, button) {
  document.querySelectorAll(`[data-group="${group}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
}
function pressValue(group, attr, value) {
  const b = document.querySelector(`[data-group="${group}"] [data-${attr}="${value}"]`);
  if (b) press(group, b);
}
const toggle = (button, on) => button.setAttribute('aria-pressed', String(on));
const on = (id, fn) => $(id).addEventListener('click', fn);

// Claude Code's state
const STATE_NOTES = {
  working: 'Working: it walks around holding whatever fits the job. Try the tools below.',
  waiting: 'Waiting for you: it waves until you answer. Go back to Claude Code to answer.',
  done: 'Done, and you’re not looking at Claude Code, so it panics. Go back to Claude Code (or click Claude) to calm it down.',
  error: 'Stopped with an error.',
  nocredit: 'Out of credits. Hover over Claude to see when the limit lifts: on the playground, in 12 seconds.',
  resting: 'Idle: it sits down and snoozes. Try the resting moments under Little things.',
};

function setMainState(state, { quietNote = false } = {}) {
  const now = Date.now();
  clearInterval(resetTimer);
  main.state = state === 'resting' ? 'idle' : state;
  main.at = now;
  delete main.resetAt;
  if (state === 'working' && main.taskStart > now - 1000) main.taskStart = now;
  if (state === 'done') main.prompts = [0, 0, 1, 2, 4][Math.floor(Math.random() * 5)]; // 47 rates every job
  if (state === 'nocredit') {
    main.resetAt = now + 12 * 1000;
    resetTimer = setInterval(renderTerminal, 1000);
    setTimeout(() => clearInterval(resetTimer), 14 * 1000);
  }
  // You're somewhere else: that's when "done" and "tokens are back" wait for you.
  if (['done', 'nocredit', 'waiting'].includes(state)) setFocus(FOCUS.desktop);
  pressValue('state', 'state', state);
  pushSessions();
  if (!quietNote) {
    let text = STATE_NOTES[state];
    if (state === 'done' && !config.panicWhenDone) text = 'Done: it hops and says so, and settles down once you go back to Claude Code.';
    if (state === 'done' && shownConfig().hat === 'agent47') text = 'Mission accomplished. He doesn’t panic; he runs a silent op. Check his rating.';
    say(text);
  }
}
document.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => setMainState(b.dataset.state)));

function goToClaudeCode() {
  setFocus(FOCUS.claude);
  if (main.state === 'waiting') {
    // You answered: back to work.
    setTimeout(() => setMainState('working', { quietNote: true }), 900);
    say('Answered. Back to work.');
  } else if (main.state === 'done') say('You looked. Phew.');
  else say('Back in Claude Code.');
}
on('go-claude', goToClaudeCode);
$('terminal').addEventListener('click', goToClaudeCode);
$('terminal').addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), goToClaudeCode()));
$('browser').addEventListener('click', () => setFocus({ pid: 300, name: 'chrome.exe', title: `${browserTab.title} - Google Chrome` }));

function ensureWorking() {
  if (main.state !== 'working') setMainState('working', { quietNote: true });
}

// While it works
const TOOL_NOTES = {
  Grep: 'Searching: a magnifying glass.', Edit: 'Editing: a pencil. (Agent 47 dresses as a chef for this.)',
  Bash: 'Running commands: a little terminal.', Read: 'Reading: a book.', '': 'Thinking: hands free.',
};
document.querySelectorAll('[data-tool]').forEach((b) =>
  b.addEventListener('click', () => {
    main.tool = b.dataset.tool;
    press('tool', b);
    ensureWorking();
    pushSessions();
    say(TOOL_NOTES[main.tool]);
  })
);
const LENGTH_NOTES = { 0: 'A fresh task.', 11: 'Ten minutes on one task: time for a coffee (and slower walking, no spilling).', 31: 'Half an hour: out comes the sleeping bag.' };
document.querySelectorAll('[data-minutes]').forEach((b) =>
  b.addEventListener('click', () => {
    main.taskStart = Date.now() - Number(b.dataset.minutes) * MINUTE;
    press('length', b);
    ensureWorking();
    pushSessions();
    say(LENGTH_NOTES[b.dataset.minutes]);
  })
);
on('rage', () => {
  ensureWorking();
  main.rageAt = Date.now();
  pushSessions();
  say(shownConfig().hat === 'agent47' ? 'Complications. He handles them.' : 'Three failed tool calls in a row. Everybody has a limit.');
});
on('add-session', () => {
  if (extra.length >= 4) return;
  const name = PROJECTS.find((p) => !extra.some((s) => s.cwd.endsWith(p)));
  extra.push({ id: `s-${name}`, state: 'working', at: Date.now(), taskStart: Date.now(), tool: 'Bash', cwd: `C:\\code\\${name}`, chain: [] });
  pushSessions();
  $('remove-session').disabled = false;
  $('add-session').disabled = extra.length >= 4;
  say('Another session: another Claude, in its own colour and hat. Hover over it to see which; scroll over it for another hat.');
});
on('remove-session', () => {
  extra.pop();
  pushSessions();
  $('remove-session').disabled = !extra.length;
  $('add-session').disabled = false;
  say('');
});

// Hats
function setHat(hat) {
  if (config.hitmanRunning && hat !== 'agent47') {
    // Picking another hat ends the Hitman session here.
    config.hitmanRunning = false;
    toggle($('hitman'), false);
  }
  config.hat = hat;
  pressValue('hat', 'hat', hat);
  pushConfig();
  say(HAT_NOTES[hat]);
}
$('hats').innerHTML = HAT_ORDER.map((h) => `<button type="button" data-hat="${h}">${HAT_NAMES[h]}</button>`).join('');
$('hats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hat]');
  if (b) setHat(b.dataset.hat);
});
pressValue('hat', 'hat', 'none');

// Agent 47
const OUTFIT_NOTES = {
  '': 'The job decides: a chef while editing, a mechanic when tests fail, and something rare, now and then, when a job is done.',
  chef: 'Chef. Other Claudes in chef hats notice: start another session or two.',
  mechanic: 'Mechanic: for when the tests fail.',
  flamingo: 'The rare one. About one finished job in twelve.',
};
document.querySelectorAll('[data-outfit]').forEach((b) =>
  b.addEventListener('click', () => {
    if (shownConfig().hat !== 'agent47') setHat('agent47');
    press('outfit', b);
    setTimeout(() => play() && play().disguise(b.dataset.outfit || null), 50);
    say(OUTFIT_NOTES[b.dataset.outfit]);
  })
);
on('hitman', () => {
  const running = !config.hitmanRunning;
  config.hitmanRunning = running;
  config.hitmanSince = running ? Date.now() : 0;
  if (running) hitmanHat = config.hat;
  else if (hitmanHat !== null) config.hat = hitmanHat;
  toggle($('hitman'), running);
  pressValue('hat', 'hat', shownConfig().hat);
  pushConfig();
  say(running ? 'Start Hitman and Claude suits up on its own.' : 'Hitman closed: he takes a bow and changes back.');
});

// On your computer
function setMedia(kind) {
  const music = kind === 'music';
  const video = kind === 'video';
  toggle($('music'), music);
  toggle($('video'), video);
  if (music) media = { playing: true, app: 'Spotify.exe', artist: 'The Tokens', title: 'Taskbar Blues', album: 'Idle Hands' };
  else if (video) media = { playing: true, app: 'chrome.exe', artist: '', title: 'Ten hours of rain on a tin roof' };
  else media = { playing: false, app: '', artist: '', title: '' };
  $('tray-media').textContent = music ? '♪ The Tokens – Taskbar Blues' : '';
  if (video) browserTab = { title: 'Ten hours of rain on a tin roof', address: 'videos.example/watch?v=rain', page: 'video', html: '' };
  else if (browserTab.page === 'video') browserTab = NEW_TAB;
  renderBrowser();
  emit('media', media);
}
on('music', () => {
  const now = $('music').getAttribute('aria-pressed') !== 'true';
  setMedia(now ? 'music' : null);
  say(now ? 'Music: headphones on. Hover over Claude to see the song.' : '');
});
on('video', () => {
  const now = $('video').getAttribute('aria-pressed') !== 'true';
  setMedia(now ? 'video' : null);
  say(now ? 'A video: Claude sits down in front of a little TV. Now press Done.' : '');
});

const AIS = ['ChatGPT', 'Gemini', 'Copilot', 'Perplexity', 'Grok', 'DeepSeek', 'Le Chat'];
let aiTurn = 0;
on('other-ai', () => {
  const ai = AIS[aiTurn++ % AIS.length];
  if (play()) play().allowCrying();
  setFocus(FOCUS.desktop); // a new AI each time, so it counts as news
  browserTab = { title: ai, address: `${ai.toLowerCase().replace(/\s/g, '')}.example`, page: 'chat', html: `How can I help you today?` };
  renderBrowser();
  setTimeout(() => setFocus({ pid: 300, name: 'chrome.exe', title: `${ai} - Google Chrome` }), 50);
  say(`You opened ${ai}. Claude saw that.`);
});

let lockInOpen = false;
on('lockin', () => {
  if (lockInOpen || (play() && play().busy())) return;
  lockInOpen = true;
  browserTab = { title: 'Something you shouldn’t be looking at', address: 'definitely-not-work.example', page: 'nope', html: '🙈' };
  renderBrowser();
  setFocus({ pid: 300, name: 'chrome.exe', title: `${browserTab.title} - Google Chrome` });
  // In the app, lock-in mode has to be switched on, and notices a tab like this by itself.
  setTimeout(() => {
    const message = ['Lock in.', 'Bro. Lock in.', 'Not today. Lock in.', 'Eyes on the code.', "We're shipping today. Lock in."][Math.floor(Math.random() * 5)];
    emit('lockin', { message, windowRect: rectOf($('browser')), tabRect: rectOf($('tab')) });
    setTimeout(() => window.playHost.lockInClose(), 9000); // the app's safety net
  }, 500);
  say('Lock-in mode: every hat deals with the tab its own way. Try them all.');
});

let game = null; // { where: 'here' | 'there' }
function startGame(where) {
  const screen = where === 'here' ? $('m1') : $('m2');
  game = { where };
  $('game1').hidden = where !== 'here';
  $('game2').hidden = where !== 'there';
  const r = rectOf(screen);
  emit('game', { active: true, name: 'pixelkart.exe', title: 'Pixel Kart', browser: false, bounds: r });
}
function stopGame() {
  game = null;
  $('game1').hidden = true;
  $('game2').hidden = true;
  emit('game', { active: false });
}
on('game-here', () => {
  const now = !(game && game.where === 'here');
  toggle($('game-here'), now);
  toggle($('game-there'), false);
  if (now) startGame('here');
  else stopGame();
  say(now ? 'A fullscreen game on Claude’s screen: Claude gets out of the way.' : '');
});
on('game-there', () => {
  const now = !(game && game.where === 'there');
  toggle($('game-there'), now);
  toggle($('game-here'), false);
  if (now) startGame('there');
  else stopGame();
  say(now ? 'A game on the other screen: Claude grabs a controller and plays along.' : '');
});
on('call', () => {
  config.micInUse = !config.micInUse;
  toggle($('call'), config.micInUse);
  pushConfig();
  say(config.micInUse ? 'An app is using your microphone: no sounds, no scenes, no chatter until the call ends. Try Done now.' : 'Call over.');
});

// The calendar
const year = new Date().getFullYear();
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const todayAt = (h) => `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T${pad(h)}:00`;
const DATES = [
  ['today', 'Today', null, ''],
  ['night', '2 a.m.', todayAt(2), 'Still up at 2 a.m.? A nightcap, a yawn, and a word about bedtime.'],
  ['halloween', 'Halloween', `${year}-10-31T17:00`, 'Halloween week: a pumpkin (if Claude isn’t wearing a hat of its own).'],
  ['christmas', 'Christmas', `${year}-12-24T17:00`, 'Christmas: snow, and a Santa hat (take yours off to see it).'],
  ['newyear', 'New Year’s Eve', `${year}-12-31T22:30`, 'New Year’s Eve: a party hat, snow and fireworks.'],
  ['winter', 'A January day', `${year + 1}-01-15T14:00`, 'All winter long: snow.'],
  ['march15', '15 March', `${year + 1}-03-15T12:00`, '15 March, a Hungarian national day: a cockade.'],
  ['aug20', '20 August', `${year + 1}-08-20T21:30`, '20 August, evening in Hungary: a cockade and fireworks.'],
  ['birthday', 'Your birthday', null, 'Tell Claude your birthday and it remembers: party hat, confetti, wishes.'],
];
$('dates').innerHTML = DATES.map(([id, label]) => `<button type="button" data-date="${id}">${label}</button>`).join('');
$('dates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-date]');
  if (!b) return;
  const [id, , iso, text] = DATES.find((d) => d[0] === b.dataset.date);
  pretendDate = iso;
  const d = iso ? new Date(iso) : new Date();
  config.birthday = id === 'birthday' ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
  press('date', b);
  pushConfig();
  if (play()) play().setDate(iso);
  renderClock();
  say(text);
});
pressValue('date', 'date', 'today');

// Little things
on('pet', () => {
  if (play()) play().pet();
  say('Double-click Claude to pet it yourself.');
});
on('annoy', () => {
  if (play()) play().annoyed();
  say('Ten clicks in a row is too many.');
});
on('throw', () => {
  if (play()) play().fling();
  say('Grab Claude and throw it yourself: it bounces off the edges.');
});
const IDLE_NOTES = { newspaper: 'Every few minutes of rest, it finds something to do.', juggle: 'Every few minutes of rest, it finds something to do.', snore: 'Every few minutes of rest, it finds something to do.', lasso: 'Cowboys pass the time with a lasso.' };
document.querySelectorAll('[data-idle]').forEach((b) =>
  b.addEventListener('click', () => {
    const move = b.dataset.idle;
    if (move === 'lasso' && shownConfig().hat !== 'cowboy') setHat('cowboy');
    if (main.state !== 'idle') setMainState('resting', { quietNote: true });
    if (media.playing) setMedia(null);
    // Give a new hat a moment to land, and let Claude finish whatever it's doing (walking back
    // to its spot, landing...).
    let tries = 0;
    const attempt = () => {
      if (play() && play().idle(move)) return;
      if (++tries < 20) setTimeout(attempt, 400);
    };
    setTimeout(attempt, move === 'lasso' ? 700 : 100);
    say(IDLE_NOTES[move]);
  })
);
const ACHIEVEMENTS = [
  ['First contract', 'Claude Code finished its first task.'],
  ['No witnesses', 'A task finished without a single permission prompt.'],
  ['Marathon', null],
  ['Night owl', null],
  ['Furniture abuser', null],
  ["It's not what it looks like", null],
  ['Locked in', null],
  ['Cardio', null],
  ['Not now, TV', null],
  ['Pink is the new black', null],
  ['Frequent flyer', null],
  ['Claude is not a toy', null],
];
let achievementTurn = 0;
on('achievement', () => {
  const [name, description] = ACHIEVEMENTS[achievementTurn++ % ACHIEVEMENTS.length];
  emit('achievement', { name, description });
  say(description ? 'There are a few achievements. Some say what they’re for.' : 'Some achievements don’t say what they’re for until you get them.');
});

// Settings
document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    config.mode = b.dataset.mode;
    if (config.mode === 'walk') config.fixedX = null;
    press('mode', b);
    pushConfig();
    say(config.mode === 'fixed' ? 'Stay in place: Claude keeps to its spot. Drag it somewhere else to move the spot.' : 'Walk around.');
  })
);
const FLAG_NOTES = {
  panicWhenDone: (v) => (v ? 'Panic when done: if you’re not looking when it finishes, it makes sure you notice.' : 'No more panicking.'),
  roam: (v) => (v ? 'Claude has the run of every screen now.' : 'Back to its own screen.'),
  sounds: (v) => (v ? 'A jingle when it’s done, another when it needs you.' : 'Quiet.'),
  dnd: (v) => (v ? 'Do not disturb: no sounds, no scenes.' : 'Disturb away.'),
};
document.querySelectorAll('[data-flag]').forEach((b) =>
  b.addEventListener('click', () => {
    const key = b.dataset.flag;
    config[key] = !config[key];
    toggle(b, config[key]);
    pushConfig();
    say(FLAG_NOTES[key](config[key]));
  })
);

// ---------- start ----------
frame.addEventListener('load', () => {
  ready = true;
  measure();
  pushConfig();
  emit('focus', focus);
  emit('media', media);
  pushSessions();
  renderBrowser();
  renderClock();
});
renderTerminal();
renderBrowser();
renderClock();
if (touchOnly) frame.style.pointerEvents = 'auto';
