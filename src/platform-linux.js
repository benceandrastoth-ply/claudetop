// Linux versions of the Windows-only pieces:
//   - which window is in front (xprop), what's playing (playerctl), closing a tab (xdotool)
//   - start at login (~/.config/autostart)
// Works on X11 sessions and on Wayland for apps running through XWayland. Missing tools just
// switch the matching feature off; missingTools() lists them so the app can say so.

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS = { xprop: 'x11-utils', xwininfo: 'x11-utils', xdotool: 'xdotool', playerctl: 'playerctl' };

function has(tool) {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = Object.fromEntries(Object.keys(TOOLS).map((t) => [t, has(t)]));

// Debian/Ubuntu package names for whatever is missing.
function missingTools() {
  return [...new Set(Object.keys(TOOLS).filter((t) => !available[t]).map((t) => TOOLS[t]))];
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

async function activeWindow() {
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
function startWatcher({ lockIn, blocklist, browsers, onFocus, onMedia, onLockIn }) {
  const blockRe = new RegExp(blocklist, 'i');
  let stopped = false;
  let lastFocus = '';
  let lastRect = '';
  let lastWindow = '';
  let lastMedia = '';
  let cooldownUntil = 0;
  let tick = 0;

  async function loop() {
    if (stopped) return;
    tick++;
    if (available.xprop) {
      const w = await activeWindow();
      // No X11 window in front: a native Wayland app, or (under WSL) a Windows app. Say we
      // can't tell, so "done" times out instead of waiting for a window we'll never see.
      if (!w && lastFocus !== 'unknown') {
        lastFocus = 'unknown';
        onFocus({ pid: 0, name: '', title: '', available: false });
      }
      if (w) {
        // Its size and position (game mode spots fullscreen windows): on every switch, and
        // once a second in case it goes fullscreen.
        if (available.xwininfo && (w.id !== lastWindow || tick % 4 === 0)) lastRect = await windowRect(w.id);
        lastWindow = w.id;
        const key = `${w.pid}\t${w.name}\t${w.title}\t${lastRect}`;
        if (key !== lastFocus) {
          lastFocus = key;
          onFocus({ pid: w.pid, name: w.name, title: w.title, rect: lastRect, available: true });
        }
        const isBrowser = browsers.some((b) => w.name.toLowerCase().startsWith(b));
        if (lockIn && available.xdotool && isBrowser && Date.now() > cooldownUntil && blockRe.test(w.title)) {
          cooldownUntil = Date.now() + 12000; // claudetop is busy with its animation
          onLockIn(w.id, available.xwininfo ? await windowRect(w.id) : '', '');
        }
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
  if (!available.xprop) onFocus({ pid: 0, name: '', title: '', available: false });
  loop();

  return {
    stop() {
      stopped = true;
    },
    // Bring up the first of these processes that has a visible window.
    async focusPids(pids) {
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
      const w = available.xprop ? await activeWindow() : null;
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

module.exports = { available, missingTools, startWatcher, startAtLogin, setStartAtLogin, hookCommand };
