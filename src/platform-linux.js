// Linux versions of the Windows-only pieces:
//   - which window is in front (xprop), what's playing (playerctl), closing a tab (xdotool)
//   - start at login (~/.config/autostart)
//   - where every window is, so Claude can walk on top of them
// Works on X11 sessions and on Wayland for apps running through XWayland. On Hyprland the
// compositor itself answers instead (platform-hyprland.js), and sees Wayland apps too. Missing
// tools just switch the matching feature off; installHint() says how to get them.

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hypr = require('./platform-hyprland');

const TOOLS = ['xprop', 'xwininfo', 'xdotool', 'playerctl'];

// Which package gives each tool, per package manager (a tool not listed is its own package).
const PACKAGES = {
  apt: { distro: 'Ubuntu or Debian', install: 'sudo apt install', xprop: 'x11-utils', xwininfo: 'x11-utils' },
  pacman: { distro: 'Arch', install: 'sudo pacman -S --needed', xprop: 'xorg-xprop', xwininfo: 'xorg-xwininfo' },
  dnf: { distro: 'Fedora', install: 'sudo dnf install' },
};

function has(tool) {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = Object.fromEntries(TOOLS.map((t) => [t, has(t)]));

// How to install whatever is missing on this distribution ("On Arch:\nsudo pacman -S ..."),
// or '' when nothing is.
function installHint() {
  // On Hyprland the compositor answers what xprop, xwininfo and xdotool are for.
  const needed = hypr.isHyprland ? ['playerctl'] : TOOLS;
  const missing = needed.filter((t) => !available[t]);
  if (!missing.length) return '';
  const pm = PACKAGES[Object.keys(PACKAGES).find(has) || 'apt'];
  const pkgs = [...new Set(missing.map((t) => pm[t] || t))];
  return `On ${pm.distro}:\n${pm.install} ${pkgs.join(' ')}`;
}

const run = (cmd, args, timeout = 1500) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout));
  });

const processName = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
};

// xprop prints e.g.  _NET_WM_NAME(UTF8_STRING) = "Some \"title\""
function propString(out, prop) {
  const m = new RegExp(`^${prop}\\([^)]*\\) = "(.*)"$`, 'm').exec(out);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}
const propNumber = (out, prop) => {
  const m = new RegExp(`^${prop}\\([^)]*\\) = (\\d+)`, 'm').exec(out);
  return m ? Number(m[1]) : 0;
};

async function activeWindow(getDisplays) {
  if (hypr.isHyprland) {
    const w = await hypr.activeWindow(getDisplays());
    return w && { ...w, name: w.pid > 0 ? processName(w.pid) : w.className };
  }
  const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
  const id = /window id # (0x[0-9a-f]+)/i.exec(root);
  if (!id || id[1] === '0x0') return null;
  const props = await run('xprop', ['-id', id[1], '_NET_WM_PID', '_NET_WM_NAME', 'WM_NAME']);
  const pid = propNumber(props, '_NET_WM_PID');
  return {
    id: id[1],
    pid,
    name: pid ? processName(pid) : '',
    title: propString(props, '_NET_WM_NAME') || propString(props, 'WM_NAME'),
  };
}

async function windowRect(id) {
  const out = await run('xwininfo', ['-id', id]);
  const n = (label) => Number((new RegExp(`${label}:\\s+(-?\\d+)`).exec(out) || [])[1]);
  const x = n('Absolute upper-left X');
  const y = n('Absolute upper-left Y');
  const w = n('Width');
  const h = n('Height');
  return [x, y, w, h].every(Number.isFinite) ? `${x},${y},${x + w},${y + h}` : '';
}

// Every normal window on the current desktop, front to back, in X11 pixels:
// [{ id, x, y, width, height }] with the window manager's title bar, without GTK's shadows.
async function listWindowsX11(ownPid) {
  const root = await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING', '_NET_CURRENT_DESKTOP']);
  const list = /_NET_CLIENT_LIST_STACKING\(WINDOW\): window id # (.*)$/m.exec(root);
  if (!list) return [];
  const ids = list[1].split(',').map((s) => s.trim()).filter(Boolean);
  const desktop = propNumber(root, '_NET_CURRENT_DESKTOP');
  const tree = await run('xwininfo', ['-root', '-tree'], 3000);
  const geometry = new Map();
  for (const line of tree.split('\n')) {
    // 0x3c00007 "title": ("xterm" "XTerm")  499x316+0+0  +10+40   (the last pair is absolute)
    const m = /^\s*(0x[0-9a-f]+)\s.*\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+?(-?\d+)\+?(-?\d+)\s*$/i.exec(line);
    if (m) geometry.set(parseInt(m[1], 16), { x: +m[4], y: +m[5], width: +m[2], height: +m[3] });
  }
  const numbers = (out, prop) => {
    const m = new RegExp('^' + prop + '\\([^)]*\\) = ([\\d, ]+)$', 'm').exec(out);
    return m ? m[1].split(',').map(Number) : null;
  };
  const windows = await Promise.all(
    ids.map(async (id) => {
      const g = geometry.get(parseInt(id, 16));
      if (!g) return null;
      const props = await run('xprop', [
        '-id', id, '_NET_WM_STATE', '_NET_WM_DESKTOP', '_NET_WM_WINDOW_TYPE', '_NET_WM_PID', '_NET_FRAME_EXTENTS', '_GTK_FRAME_EXTENTS',
      ]);
      if (/_NET_WM_STATE_(HIDDEN|FULLSCREEN)/.test(props)) return null;
      if (/_NET_WM_STATE_MAXIMIZED_VERT/.test(props) && /_NET_WM_STATE_MAXIMIZED_HORZ/.test(props)) return null;
      const type = /_NET_WM_WINDOW_TYPE\(ATOM\) = ([^,\n]+)/.exec(props);
      if (type && !/_(NORMAL|DIALOG)$/.test(type[1].trim())) return null;
      const d = numbers(props, '_NET_WM_DESKTOP');
      if (d && d[0] !== desktop && d[0] !== 0xffffffff) return null;
      if (ownPid && propNumber(props, '_NET_WM_PID') === ownPid) return null;
      const r = { id, ...g };
      const frame = numbers(props, '_NET_FRAME_EXTENTS'); // left, right, top, bottom
      if (frame && frame.length === 4) {
        r.x -= frame[0];
        r.y -= frame[2];
        r.width += frame[0] + frame[1];
        r.height += frame[2] + frame[3];
      }
      const shadow = numbers(props, '_GTK_FRAME_EXTENTS');
      if (shadow && shadow.length === 4) {
        r.x += shadow[0];
        r.y += shadow[2];
        r.width -= shadow[0] + shadow[1];
        r.height -= shadow[2] + shadow[3];
      }
      return r;
    })
  );
  return windows.filter(Boolean).reverse(); // the stacking list goes back to front
}

// Every window, front to back, in Electron's coordinates. X11 counts real pixels, Electron
// counts scaled ones.
async function listWindows(getDisplays, ownPid) {
  const displays = getDisplays();
  if (hypr.isHyprland) return hypr.listWindows(displays, ownPid);
  if (!available.xprop || !available.xwininfo) return [];
  const scale = (displays[0] && displays[0].scaleFactor) || 1;
  return (await listWindowsX11(ownPid)).map((r) => ({
    id: r.id, x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale,
  }));
}

async function nowPlaying() {
  if (!available.playerctl) return { playing: false };
  const out = await run('playerctl', [
    '--all-players', 'metadata', '--format', '{{status}}\t{{playerName}}\t{{artist}}\t{{title}}\t{{album}}',
  ]);
  const line = out.split('\n').find((l) => l.startsWith('Playing\t'));
  if (!line) return { playing: false, app: '', artist: '', title: '', album: '' };
  const [, app, artist, title, album] = line.split('\t');
  return { playing: true, app, artist, title, album };
}

// Same job as focus-watch.ps1: report the window in front, what's playing, and NSFW tabs.
// Is a Hitman game running (natively or through Proton/Wine)?
const HITMAN_RE = /^(hitman\d?|hma|hitmanbloodmoney|hitmancontracts)(\.exe)?$/i;
function hitmanRunning() {
  try {
    return fs.readdirSync('/proc').some((pid) => {
      if (!/^\d+$/.test(pid)) return false;
      try {
        return HITMAN_RE.test(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim());
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// Is any app recording from a microphone (PulseAudio/PipeWire)? Needs pactl; unknown = no.
async function micInUse() {
  const out = await run('pactl', ['list', 'short', 'source-outputs']);
  return out.trim().length > 0;
}

// With onWindows, it also reports every window (Electron coordinates, front to back) twice a second.
function startWatcher({
  lockIn, blocklist, browsers, onFocus, onMedia, onLockIn, onHitman = () => {}, onMic = () => {},
  onWindows = null, getDisplays = () => [], ownPid = 0,
}) {
  const canSeeFocus = hypr.isHyprland || available.xprop;
  let lastHitman = null;
  let lastMic = null;
  const blockRe = new RegExp(blocklist, 'i');
  let stopped = false;
  let lastFocus = '';
  let lastRect = '';
  let lastWindow = '';
  let lastMedia = '';
  let lastWindows = '';
  let cooldownUntil = 0;
  let tick = 0;

  async function loop() {
    if (stopped) return;
    tick++;
    if (canSeeFocus) {
      const w = await activeWindow(getDisplays);
      // No X11 window in front: a native Wayland app, or (under WSL) a Windows app. Say we
      // can't tell, so "done" times out instead of waiting for a window we'll never see.
      if (!w && lastFocus !== 'unknown') {
        lastFocus = 'unknown';
        onFocus({ pid: 0, name: '', title: '', available: false });
      }
      if (w) {
        // Its size and position (game mode spots fullscreen windows): on every switch, and
        // once a second in case it goes fullscreen.
        if (w.rect !== undefined) lastRect = w.rect;
        else if (available.xwininfo && (w.id !== lastWindow || tick % 4 === 0)) lastRect = await windowRect(w.id);
        lastWindow = w.id;
        const key = `${w.pid}\t${w.name}\t${w.title}\t${lastRect}`;
        if (key !== lastFocus) {
          lastFocus = key;
          onFocus({ pid: w.pid, name: w.name, title: w.title, rect: lastRect, available: true });
        }
        const isBrowser = browsers.some((b) => w.name.toLowerCase().startsWith(b));
        const canClose = hypr.isHyprland || available.xdotool;
        if (lockIn && canClose && isBrowser && Date.now() > cooldownUntil && blockRe.test(w.title)) {
          cooldownUntil = Date.now() + 12000; // claudetop is busy with its animation
          onLockIn(w.id, w.rect !== undefined ? w.rect : available.xwininfo ? await windowRect(w.id) : '', '');
        }
      }
    }
    if (onWindows && tick % 2 === 0) {
      const list = await listWindows(getDisplays, ownPid);
      const key = JSON.stringify(list);
      if (key !== lastWindows && !stopped) {
        lastWindows = key;
        onWindows(list);
      }
    }
    if (tick % 20 === 1) {
      const h = hitmanRunning();
      if (h !== lastHitman) {
        lastHitman = h;
        onHitman(h);
      }
      const mic = await micInUse();
      if (mic !== lastMic) {
        lastMic = mic;
        onMic(mic);
      }
    }
    if (tick % 4 === 0) {
      const m = await nowPlaying();
      const key = JSON.stringify(m);
      if (key !== lastMedia) {
        lastMedia = key;
        onMedia(m);
      }
    }
    if (!stopped) setTimeout(loop, 250);
  }

  // Without xprop there's no way to tell where you're looking: say so, so "done" doesn't wait forever.
  if (!canSeeFocus) onFocus({ pid: 0, name: '', title: '', available: false });
  loop();

  return {
    stop() {
      stopped = true;
    },
    // Bring up the first of these processes that has a visible window.
    async focusPids(pids) {
      if (hypr.isHyprland) {
        const clients = (await hypr.json('clients')) || [];
        const pid = pids.find((p) => clients.some((c) => c.pid === p && c.mapped));
        if (pid) await hypr.focusPid(pid);
        return;
      }
      if (!available.xdotool) return;
      for (const pid of pids) {
        const ids = (await run('xdotool', ['search', '--onlyvisible', '--pid', String(pid)])).split('\n').filter(Boolean);
        if (ids.length) {
          await run('xdotool', ['windowactivate', ids[ids.length - 1]]);
          return;
        }
      }
    },
    // Ctrl+W, but only if that same window is still in front.
    async closeTab(id) {
      cooldownUntil = Date.now() + 1500;
      const w = canSeeFocus ? await activeWindow(getDisplays) : null;
      if (w && w.id === id && hypr.isHyprland) return hypr.sendCtrlW(id);
      if (w && w.id === id && available.xdotool) await run('xdotool', ['key', '--clearmodifiers', 'ctrl+w']);
    },
  };
}

// ---------- start at login ----------
const AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'claudetop.desktop');

function startAtLogin() {
  return fs.existsSync(AUTOSTART);
}

function setStartAtLogin(on, command) {
  if (!on) {
    fs.rmSync(AUTOSTART, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
  fs.writeFileSync(
    AUTOSTART,
    ['[Desktop Entry]', 'Type=Application', 'Name=claudetop', `Exec=${command}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n')
  );
}

// The hook command for Linux: plain node if it's installed (fast), otherwise the app itself.
// The hook script is copied out of the app first, since an AppImage's files move every launch.
function hookCommand(appCommand, reportSource) {
  let node = '';
  try {
    node = execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
  } catch {}
  if (!node) return appCommand;
  const target = path.join(os.homedir(), '.claude', 'claudetop', 'report.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(reportSource, target);
  return `"${node}" "${target}"`;
}

module.exports = { available, installHint, startWatcher, startAtLogin, setStartAtLogin, hookCommand };
