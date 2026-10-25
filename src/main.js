// Claude Code runs this exe as a hook; do just that and get out, before any app setup.
if (process.argv.includes('--claudetop-hook')) {
  require('../hooks/report.js');
  return;
}

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hooksSetup = require('./hooks-setup');

const isLinux = process.platform === 'linux';
const linux = isLinux ? require('./platform-linux') : null;
if (isLinux) app.commandLine.appendSwitch('enable-transparent-visuals');

const REPORT_JS = path.join(__dirname, '..', 'hooks', 'report.js');

// How to launch this app from outside: the installed exe/AppImage, or electron + this folder.
function appCommand(...args) {
  const extra = args.length ? ` ${args.join(' ')}` : '';
  if (!app.isPackaged) return `"${process.execPath}" "${app.getAppPath()}"${extra}`;
  if (isLinux) return `"${process.env.APPIMAGE || process.execPath}" --no-sandbox${extra}`;
  return `"${process.execPath.replace(/\\/g, '/')}"${extra}`;
}

// The installed app's hooks call back into this exe (or plain node on Linux, if it's there);
// a dev checkout uses node.
function hookCommand() {
  if (!app.isPackaged) return `node "${REPORT_JS.replace(/\\/g, '/')}"`;
  if (isLinux) return linux.hookCommand(appCommand(), REPORT_JS);
  return appCommand();
}

function startsAtLogin() {
  if (isLinux) return linux.startAtLogin();
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}

function setStartsAtLogin(on) {
  if (isLinux) linux.setStartAtLogin(on, appCommand());
  else app.setLoginItemSettings({ ...loginItem(), openAtLogin: on });
}

// Setup flags used by the installer and uninstaller.
const SETUP_FLAGS = ['--install-hooks', '--uninstall-hooks', '--start-with-windows', '--no-start-with-windows'];
const hatArg = process.argv.find((a) => a.startsWith('--set-hat='));
if (SETUP_FLAGS.some((f) => process.argv.includes(f)) || hatArg) {
  const has = (f) => process.argv.includes(f);
  try {
    if (hatArg) {
      // e.g. the installer's "Turn Claude into Agent 47" box: --set-hat=agent47
      const file = path.join(app.getPath('userData'), 'config.json');
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      saved.hat = hatArg.slice('--set-hat='.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    }
    if (has('--install-hooks')) hooksSetup.installHooks(hookCommand());
    if (has('--uninstall-hooks')) hooksSetup.uninstallHooks();
    if (has('--start-with-windows')) setStartsAtLogin(true);
    if (has('--no-start-with-windows')) setStartsAtLogin(false);
  } catch {}
  app.exit(0);
  return;
}

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'claudetop', 'sessions');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const STRIP_HEIGHT = 230;
const STALE_MS = 24 * 60 * 60 * 1000;

let win = null;
let tray = null;
let config = {
  mode: 'walk',
  fixedX: null,
  displayId: null,
  lockIn: false,
  panicWhenDone: false,
  roam: false, // wander over every monitor instead of staying on the chosen one
  hat: 'none', // 'none' | 'hard' | 'propeller' | 'miner' | 'agent47'
  dance: 'apps', // 'off' | 'apps' (music apps only) | 'any' (anything playing, browsers too)
  tv: true, // sit down and watch a little TV while you watch videos
  jealous: true, // cry when you open another AI
  hitmanAuto: true, // turn into Agent 47 while a Hitman game is running
  gameMode: true, // hide on a fullscreen game's screen, play along on the others
  seasonal: true, // snow in winter, a pumpkin at Halloween...
  setupDone: false, // Linux: the first-launch question has been asked (Windows asks in the installer)
  preview: null,
};
let focus = { pid: 0, name: '', title: '' };
let media = { playing: false, app: '', artist: '', title: '' };
let focusWatcher = null;
let spanAll = false; // window stretched along every monitor's floor (panic run)
let fullScreen = false; // window covering every monitor entirely (lock-in moves)
let lockInJob = null; // { hwnd, fallback } while a lock-in animation plays
const CMD_FILE = path.join(os.tmpdir(), 'claudetop-cmd.txt');

// Lock-in mode: browser tabs whose title matches this get closed.
const BLOCKLIST =
  '\\b(porn\\w*|xxx|nsfw|hentai|nhentai|e-hentai|rule ?34|onlyfans|fansly|xvideos|xnxx|xhamster|redtube|' +
  'youporn|spankbang|eporner|hqporner|brazzers|motherless|chaturbate|stripchat|bongacams|livejasmin|' +
  'camsoda|myfreecams|cam4)(?![a-z0-9])'; // not \b, so "NSFW_GIF" still counts
// Process names (on Linux, matched as prefixes: "firefox-bin", "vivaldi-bin", "chromium-browse").
const BROWSERS = [
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'librewolf', 'waterfox',
  'zen', 'floorp', 'chromium', 'thorium', 'yandex', 'iexplore',
];
const LOCK_IN_LINES = [
  'Lock in.',
  'Bro. Lock in.',
  'Not today. Lock in.',
  'Eyes on the code.',
  'Closed that for you. Lock in.',
  "We're shipping today. Lock in.",
  'Nope. Back to work.',
  'I saw that. Lock in.',
  'Focus mode: ON.',
  'Your future self says thanks.',
  'Touch grass later. Lock in now.',
  'That tab is gone. You are welcome.',
];

// ---------- config ----------
function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {}
  config.preview = null; // previews never survive a restart
  if (typeof config.hat === 'boolean') config.hat = config.hat ? 'hard' : 'none'; // 0.1.3 had an on/off hat
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const { preview, ...saved } = config;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
  } catch {}
}

// While Hitman runs, Claude is Agent 47, whatever hat is saved; it changes back afterwards.
let hitmanRunning = false;
function shownConfig() {
  const hitman = config.hitmanAuto && hitmanRunning && config.hat !== 'agent47';
  return { ...config, hat: hitman ? 'agent47' : config.hat, hitmanActive: hitman };
}

function setHitman(running) {
  if (running === hitmanRunning) return;
  hitmanRunning = running;
  pushConfig();
}

function pushConfig() {
  if (win) win.webContents.send('config', shownConfig());
  rebuildMenus();
}

// ---------- session files ----------
function readSessions() {
  const sessions = [];
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return sessions;
  }
  const now = Date.now();
  for (const f of files) {
    const full = path.join(SESSIONS_DIR, f);
    try {
      const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (now - rec.at > STALE_MS) {
        fs.rmSync(full, { force: true });
        continue;
      }
      sessions.push({ id: f.slice(0, -5), ...rec });
    } catch {}
  }
  return sessions;
}

function pushSessions() {
  if (win) win.webContents.send('sessions', readSessions());
}

function watchSessions() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  let pending = null;
  try {
    fs.watch(SESSIONS_DIR, () => {
      clearTimeout(pending);
      pending = setTimeout(pushSessions, 60);
    });
  } catch {}
  setInterval(pushSessions, 3000); // fallback in case a watch event is missed
}

// ---------- foreground window ----------
// Linux: xprop/playerctl polling in-process (platform-linux.js).
function watchFocusLinux() {
  focusWatcher = linux.startWatcher({
    lockIn: config.lockIn,
    blocklist: BLOCKLIST,
    browsers: BROWSERS,
    onFocus: (f) => {
      focus = f;
      if (win) win.webContents.send('focus', focus);
      updateGame();
    },
    onMedia: (m) => {
      media = m;
      if (win) win.webContents.send('media', media);
    },
    onLockIn: (id, windowRect, tabRect) => startLockIn(id, parseRect(windowRect), parseRect(tabRect)),
    onHitman: setHitman,
  });
}

// Windows: a long-lived PowerShell helper reports which window is in front.
function watchFocus() {
  if (app.isQuitting) return;
  if (isLinux) return watchFocusLinux();
  if (process.platform !== 'win32') return;
  // Passed inline so it works from inside the packaged app archive.
  const script = fs
    .readFileSync(path.join(__dirname, 'focus-watch.ps1'), 'utf8')
    .replace('__LOCKIN__', config.lockIn ? '1' : '0')
    .replace('__BLOCKLIST__', BLOCKLIST)
    .replace('__BROWSERS__', BROWSERS.join(','))
    .replace('__CMDFILE__', CMD_FILE);
  const watcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true }
  );
  focusWatcher = watcher;
  let buffered = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('LOCKIN\t')) {
        const [, hwnd, windowRect, tabRect] = line.split('\t');
        startLockIn(hwnd, parseRect(windowRect), parseRect(tabRect));
        continue;
      }
      if (line.startsWith('HITMAN\t')) {
        setHitman(line.split('\t')[1] === '1');
        continue;
      }
      if (line.startsWith('MEDIA\t')) {
        const [, playing, app, artist, title, album] = line.split('\t');
        media = { playing: playing === '1', app: app || '', artist: artist || '', title: title || '', album: album || '' };
        if (win) win.webContents.send('media', media);
        continue;
      }
      const [pid, name, title, rect] = line.split('\t');
      focus = { pid: Number(pid), name: name || '', title: title || '', rect: rect || '' };
    }
    if (win) win.webContents.send('focus', focus);
    updateGame();
  });
  watcher.on('exit', () => {
    if (focusWatcher !== watcher) return; // replaced on purpose
    focusWatcher = null;
    setTimeout(watchFocus, 2000);
  });
}

// ---------- game mode ----------
// A window covering a whole monitor is a game (or a fullscreen video). The page decides what to
// do: hide if Claude is on that monitor, otherwise grab a controller and play along.
const NOT_GAMES = /^(explorer|claudetop|electron|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|lockapp|textinputhost|gnome-shell|plasmashell|xfdesktop|nautilus|desktop)$/i;
let lastGame = '';

function updateGame() {
  let game = { active: false };
  const rect = parseRect(focus.rect);
  if (config.gameMode && rect && !NOT_GAMES.test(focus.name || '')) {
    const d = screen.getDisplayMatching(rect);
    const b = d.bounds;
    const covers = rect.x <= b.x + 2 && rect.y <= b.y + 2 && rect.x + rect.width >= b.x + b.width - 2 && rect.y + rect.height >= b.y + b.height - 2;
    if (covers) {
      const browser = BROWSERS.some((n) => (focus.name || '').toLowerCase().startsWith(n));
      game = { active: true, name: focus.name, title: focus.title, browser, bounds: b };
    }
  }
  const key = JSON.stringify(game);
  if (key === lastGame) return;
  lastGame = key;
  if (win) win.webContents.send('game', game);
}

// Click on Claude: bring up the terminal (or editor) that session runs in. The hook recorded
// the session's process chain; the first of those processes with a window is the one.
const NOT_HOSTS = /^(explorer|svchost|services|wininit|winlogon|sihost|systemd|init|login|sshd|gnome-session-b|gnome-shell|kdeinit5|plasmashell)(\.exe)?$/i;
ipcMain.on('jump-to', (_e, chain) => {
  const pids = (chain || [])
    .map((entry) => {
      const [pid, ...name] = String(entry).split(':');
      return { pid: Number(pid), name: name.join(':') };
    })
    .filter((p) => p.pid > 0 && !NOT_HOSTS.test(p.name))
    .map((p) => p.pid);
  if (isLinux) {
    if (focusWatcher) focusWatcher.focusPids(pids);
    return;
  }
  try { fs.writeFileSync(CMD_FILE, `focus ${pids.join(',')}`); } catch {}
});

// Game mode on Claude's screen: get out of the way entirely.
let hiddenForGame = false;
ipcMain.on('set-hidden', (_e, hidden) => {
  if (!win || hidden === hiddenForGame) return;
  hiddenForGame = hidden;
  if (hidden) win.hide();
  else {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
});

// ---------- lock-in ----------
// "l,t,r,b" in physical pixels -> a DIP rect in screen coordinates (or null).
function parseRect(s) {
  const n = String(s || '').split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2] <= n[0] || n[3] <= n[1]) return null;
  const rect = { x: n[0], y: n[1], width: n[2] - n[0], height: n[3] - n[1] };
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}

// The helper found an NSFW tab: cover every screen so Claude can get to it, and let the
// page play its move. The page says when to close the tab and when it's finished.
function startLockIn(hwnd, windowRect, tabRect) {
  if (lockInJob || !win) return;
  const message = LOCK_IN_LINES[Math.floor(Math.random() * LOCK_IN_LINES.length)];
  // Safety nets: the tab closes within 8s even if the animation never asks; the window only
  // goes back to normal if the page never reports back (fetching a hat can take a while).
  lockInJob = {
    hwnd,
    closed: false,
    closeFallback: setTimeout(closeLockedTab, 8000),
    fallback: setTimeout(finishLockIn, 45000),
  };
  fullScreen = true;
  placeWindow();
  win.webContents.send('lockin', { message, windowRect, tabRect });
}

function closeLockedTab() {
  if (!lockInJob || lockInJob.closed) return;
  lockInJob.closed = true;
  if (isLinux) {
    if (focusWatcher) focusWatcher.closeTab(lockInJob.hwnd);
    return;
  }
  try { fs.writeFileSync(CMD_FILE, `close ${lockInJob.hwnd}`); } catch {}
}

function finishLockIn() {
  if (!lockInJob) return;
  closeLockedTab(); // never leave the tab open, even if the animation broke
  clearTimeout(lockInJob.closeFallback);
  clearTimeout(lockInJob.fallback);
  lockInJob = null;
  fullScreen = false;
  if (win) placeWindow();
}

// The helper bakes in the lock-in setting, so swap it for a fresh one.
function restartFocusWatcher() {
  const old = focusWatcher;
  focusWatcher = null;
  if (old) (isLinux ? old.stop() : old.kill());
  watchFocus();
}

// ---------- window ----------
// The chosen monitor, or the primary one if it's unplugged or none was chosen.
function targetDisplay() {
  return screen.getAllDisplays().find((d) => d.id === config.displayId) || screen.getPrimaryDisplay();
}

// A strip along the bottom of the chosen monitor, or across all of them during a panic run.
// The renderer gets each monitor's floor so Claude stands on the right taskbar everywhere.
// Under WSL, Linux sees the whole screen but the Windows taskbar is drawn on top of it,
// so stand on the taskbar instead of behind it.
const WSL_TASKBAR = isLinux && /microsoft/i.test(os.release()) ? 48 : 0;
const floorOf = (d) => d.workArea.y + d.workArea.height - WSL_TASKBAR;

function placeWindow() {
  const home = targetDisplay();
  const displays = spanAll || fullScreen ? screen.getAllDisplays() : [home];
  const left = Math.min(...displays.map((d) => d.workArea.x));
  const right = Math.max(...displays.map((d) => d.workArea.x + d.workArea.width));
  const floors = displays.map(floorOf);
  const bottom = Math.max(...floors);
  const top = fullScreen ? Math.min(...displays.map((d) => d.bounds.y)) : Math.min(...floors) - STRIP_HEIGHT;
  win.setBounds({ x: left, y: top, width: right - left, height: bottom - top });

  const segment = (d) => ({
    left: d.workArea.x - left,
    right: d.workArea.x + d.workArea.width - left,
    ground: bottom - floorOf(d),
  });
  const all = screen.getAllDisplays();
  win.webContents.send('layout', {
    winX: left,
    winY: top,
    home: segment(home),
    segments: displays.map(segment),
    // the whole desktop, even when the window covers only one monitor
    desktop: {
      left: Math.min(...all.map((d) => d.workArea.x)) - left,
      right: Math.max(...all.map((d) => d.workArea.x + d.workArea.width)) - left,
    },
  });
}

function createWindow() {
  win = new BrowserWindow({
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  if (IS_WSL) win.setShape([{ x: 0, y: 0, width: 1, height: 1 }]); // until the page reports its shapes
  else win.setIgnoreMouseEvents(true, { forward: true });
  placeWindow();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    placeWindow(); // resend the layout now that the page can hear it
    pushConfig();
    win.webContents.send('focus', focus);
    win.webContents.send('media', media);
    lastGame = '';
    if (hiddenForGame) {
      hiddenForGame = false; // the page starts out visible and will say if it wants hiding
      win.showInactive();
    }
    updateGame();
    pushSessions();
  });

  const onDisplaysChanged = () => {
    placeWindow();
    rebuildMenus();
  };
  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
}

// ---------- menus ----------
const PREVIEWS = [
  ['working', 'Working'],
  ['waiting', 'Needs you'],
  ['done', 'Done'],
  ['nocredit', 'Out of credits'],
  ['recharged', 'Tokens are back'],
  ['resting', 'Resting'],
];

function menuTemplate() {
  return [
    { label: 'claudetop', enabled: false },
    { type: 'separator' },
    {
      label: 'Walk around',
      type: 'radio',
      checked: config.mode === 'walk',
      click: () => setMode('walk'),
    },
    {
      label: 'Stay in place (drag to move)',
      type: 'radio',
      checked: config.mode === 'fixed',
      click: () => setMode('fixed'),
    },
    {
      label: 'Show on screen',
      submenu: displayMenu(),
    },
    {
      label: 'Roam across all screens',
      type: 'checkbox',
      checked: config.roam,
      enabled: screen.getAllDisplays().length > 1,
      click: (item) => setFlag('roam', item.checked),
    },
    { type: 'separator' },
    {
      label: 'Panic when done (runs across all screens)',
      type: 'checkbox',
      checked: config.panicWhenDone,
      click: (item) => setFlag('panicWhenDone', item.checked),
    },
    {
      label: 'Hat',
      submenu: [
        ['none', 'No hat'],
        ['hard', 'Hard hat'],
        ['propeller', 'Propeller beanie'],
        ['miner', 'Miner hat (digs instead of walking)'],
        ['agent47', 'Agent 47 (suit, red tie, barcode)'],
      ].map(([id, label]) => ({
        label,
        type: 'radio',
        checked: config.hat === id,
        click: () => setFlag('hat', id),
      })),
    },
    {
      label: 'Dance to music',
      submenu: [
        ['off', 'Off'],
        ['apps', 'Music apps only (Spotify, etc.)'],
        ['any', 'Anything playing (incl. browser videos)'],
      ].map(([id, label]) => ({
        label,
        type: 'radio',
        checked: config.dance === id,
        click: () => setFlag('dance', id),
      })),
    },
    {
      label: 'Watch TV when you watch videos',
      type: 'checkbox',
      checked: config.tv,
      click: (item) => setFlag('tv', item.checked),
    },
    {
      label: 'Become Agent 47 while Hitman runs',
      type: 'checkbox',
      checked: config.hitmanAuto,
      click: (item) => setFlag('hitmanAuto', item.checked),
    },
    {
      label: 'Game mode (hide during fullscreen games)',
      type: 'checkbox',
      checked: config.gameMode,
      click: (item) => {
        setFlag('gameMode', item.checked);
        updateGame();
      },
    },
    {
      label: 'Seasonal surprises',
      type: 'checkbox',
      checked: config.seasonal,
      click: (item) => setFlag('seasonal', item.checked),
    },
    {
      label: 'Cry when you open another AI',
      type: 'checkbox',
      checked: config.jealous,
      click: (item) => setFlag('jealous', item.checked),
    },
    { type: 'separator' },
    {
      label: 'Preview state',
      submenu: [
        {
          label: 'Live (follow Claude Code)',
          type: 'radio',
          checked: !config.preview,
          click: () => setPreview(null),
        },
        ...PREVIEWS.map(([id, label]) => ({
          label,
          type: 'radio',
          checked: config.preview === id,
          click: () => setPreview(id),
        })),
      ],
    },
    {
      label: 'Lock-in mode (closes NSFW tabs)',
      type: 'checkbox',
      checked: config.lockIn,
      click: (item) => {
        config.lockIn = item.checked;
        saveConfig();
        restartFocusWatcher();
        pushConfig();
      },
    },
    {
      label: 'Connected to Claude Code',
      type: 'checkbox',
      checked: hooksSetup.hooksInstalled(),
      click: (item) => {
        try {
          if (item.checked) hooksSetup.installHooks(hookCommand());
          else hooksSetup.uninstallHooks();
        } catch {}
        rebuildMenus();
      },
    },
    {
      label: isLinux ? 'Start at login' : 'Start with Windows',
      type: 'checkbox',
      checked: startsAtLogin(),
      click: (item) => setStartsAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
}

// Unpackaged, the login item must launch electron.exe *with* this app's folder.
function loginItem() {
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}

function rebuildMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function setMode(mode) {
  config.mode = mode;
  saveConfig();
  pushConfig();
}

function setFlag(key, value) {
  config[key] = value;
  saveConfig();
  pushConfig();
}

function displayMenu() {
  const primaryId = screen.getPrimaryDisplay().id;
  const current = targetDisplay().id;
  // Number monitors left to right, like Windows does visually.
  const displays = [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return displays.map((d, i) => ({
    label: `Screen ${i + 1} (${d.size.width}×${d.size.height}${d.id === primaryId ? ', main' : ''})`,
    type: 'radio',
    checked: d.id === current,
    click: () => setDisplay(d.id),
  }));
}

// Claude walks over to the new screen: the page widens its window across all screens, walks,
// then narrows it to the new one. If it's already wide (panic run), just update the layout.
function setDisplay(id) {
  config.displayId = id;
  config.fixedX = null; // a spot on one screen means nothing on another
  saveConfig();
  pushConfig();
  if (spanAll || fullScreen) placeWindow();
}

function setPreview(state) {
  config.preview = state;
  pushConfig();
}

// 16x16 pixel-art Claude for the tray.
function trayIcon() {
  const art = [
    '................',
    '................',
    '................',
    '...##########...',
    '...##########...',
    '...##k####k##...',
    '...##k####k##...',
    '.##############.',
    '.##############.',
    '...##########...',
    '...##########...',
    '....#.#..#.#....',
    '....#.#..#.#....',
    '................',
    '................',
    '................',
  ];
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  art.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      const c = row[x];
      const i = (y * size + x) * 4;
      if (c === '#') buf.set([0x57, 0x77, 0xd9, 0xff], i); // BGRA of #D97757
      else if (c === 'k') buf.set([0x1a, 0x1a, 0x1a, 0xff], i);
    }
  });
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ---------- ipc ----------
// Clicks pass through the window except on Claude. Windows forwards mouse movement to the page
// so it can tell when the pointer reaches Claude; Linux can't, so there the main process
// watches the cursor and compares it with where the page says Claude is.
let claudeRect = null; // screen coordinates, Linux only
let pageWantsMouse = false; // hovering or dragging
let mouseEnabled = false;

ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  pageWantsMouse = !ignore;
  if (win && !isLinux) win.setIgnoreMouseEvents(ignore, { forward: true });
});

// WSL (WSLg) hides click-through windows completely. There, the window is instead cut down to
// the shapes the page reports (Claude, its bubble, flying hats, the TV...), so the rest of the
// screen stays clickable.
const IS_WSL = isLinux && /microsoft/i.test(os.release());
let lastShape = '';
ipcMain.on('shape', (_e, rects) => {
  if (!win || !IS_WSL) return;
  const shape = rects.map((r) => ({
    x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)),
    width: Math.ceil(r.w), height: Math.ceil(r.h),
  })).filter((r) => r.width > 0 && r.height > 0);
  const key = JSON.stringify(shape);
  if (key === lastShape) return;
  lastShape = key;
  win.setShape(shape.length ? shape : [{ x: 0, y: 0, width: 1, height: 1 }]);
});

ipcMain.on('claude-rect', (_e, rect) => {
  claudeRect = rect;
});

function watchCursorLinux() {
  if (IS_WSL) return; // the window shape does the job there
  setInterval(() => {
    if (!win || !claudeRect) return;
    const p = screen.getCursorScreenPoint();
    // Claude plus any extra Claudes for other sessions.
    const rects = Array.isArray(claudeRect) ? claudeRect : [claudeRect];
    const over = rects.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
    const want = over || pageWantsMouse;
    if (want !== mouseEnabled) {
      mouseEnabled = want;
      win.setIgnoreMouseEvents(!want);
    }
  }, 50);
}

// Linux has no installer wizard, so the first launch asks what the Windows installer asks.
async function firstRunLinux() {
  if (!isLinux || config.setupDone) return;
  const missing = linux.missingTools();
  const detail = [
    'claudetop adds a few hooks to ~/.claude/settings.json so it can see what Claude Code is doing. ' +
      'You can change this later from its right-click menu.',
    missing.length
      ? `\nSome features need tools that aren't installed. On Ubuntu or Debian:\nsudo apt install ${missing.join(' ')}`
      : '',
  ].join('');
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    title: 'claudetop',
    message: 'Connect claudetop to Claude Code?',
    detail,
    buttons: ['Connect', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Turn Claude into Agent 47 (suit, red tie, barcode)',
  });
  if (response === 0) {
    try { hooksSetup.installHooks(hookCommand()); } catch {}
  }
  if (checkboxChecked) config.hat = 'agent47';
  config.setupDone = true;
  saveConfig();
  pushConfig();
}

ipcMain.on('lockin-close', closeLockedTab);
ipcMain.on('lockin-done', finishLockIn);

ipcMain.on('set-span', (_e, span) => {
  spanAll = !!span;
  if (win) placeWindow();
});

ipcMain.on('set-fixed-x', (_e, x) => {
  config.fixedX = Math.round(x);
  saveConfig();
});

ipcMain.on('show-menu', () => {
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
});

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    loadConfig();
    if (app.isPackaged) {
      try { hooksSetup.refreshHooks(hookCommand()); } catch {}
    }
    createWindow();
    watchSessions();
    watchFocus();
    tray = new Tray(trayIcon());
    tray.setToolTip('claudetop');
    tray.on('click', () => tray.popUpContextMenu());
    rebuildMenus();
    if (isLinux) {
      watchCursorLinux();
      firstRunLinux();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    app.isQuitting = true;
    if (focusWatcher) (isLinux ? focusWatcher.stop() : focusWatcher.kill());
  });
}
