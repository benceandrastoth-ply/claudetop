// Hyprland: talks to the compositor over its IPC socket (what hyprctl does), so claudetop can
//   - float and pin its own window over every workspace, borderless, exactly where it wants it
//     (Hyprland would otherwise tile it like any other window)
//   - see which window is in front and where every window is (xprop can't see Wayland apps)
//   - stand on a bar at the bottom (waybar etc.) or on the screen's edge when there's none
//   - focus a window and send it Ctrl+W (lock-in mode) without xdotool
// Coordinates: Hyprland works in its own layout pixels; claudetop's window lives in XWayland,
// whose screens Electron reports. Each monitor maps onto the Electron display at the same
// place, which keeps this right with and without xwayland:force_zero_scaling.

const fs = require('fs');
const net = require('net');
const path = require('path');

const SIGNATURE = process.env.HYPRLAND_INSTANCE_SIGNATURE || '';
const isHyprland = !!SIGNATURE;

function socketPath() {
  const dirs = [process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'hypr'), '/tmp/hypr'].filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, SIGNATURE, '.socket.sock');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// One request, one answer (the socket closes after replying).
function request(command, timeout = 1000) {
  return new Promise((resolve) => {
    const p = socketPath();
    if (!p) return resolve('');
    let out = '';
    const sock = net.createConnection(p);
    const done = () => {
      sock.destroy();
      resolve(out);
    };
    sock.setTimeout(timeout, done);
    sock.on('connect', () => sock.write(command));
    sock.on('data', (d) => (out += d));
    sock.on('end', done);
    sock.on('error', done);
  });
}

async function json(command) {
  try {
    return JSON.parse(await request(`j/${command}`));
  } catch {
    return null;
  }
}

const batch = (commands) => request(`[[BATCH]]${commands.join(';')}`);

// ---------- coordinates ----------
// A monitor's size in layout pixels (Hyprland reports pixels before scaling and rotation).
function logicalSize(m) {
  const rotated = m.transform % 2 === 1;
  const w = (rotated ? m.height : m.width) / (m.scale || 1);
  const h = (rotated ? m.width : m.height) / (m.scale || 1);
  return { w, h };
}

// Pair Hyprland's monitors with Electron's displays: both sorted by position, left to right.
function pairUp(monitors, displays) {
  const ms = [...monitors].filter((m) => !m.disabled).sort((a, b) => a.x - b.x || a.y - b.y);
  const ds = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return ms.slice(0, ds.length).map((m, i) => ({ m, d: ds[i], ...logicalSize(m) }));
}

function makeMapper(monitors, displays) {
  const pairs = pairUp(monitors, displays);
  const pairAt = (x, y) =>
    pairs.find((p) => x >= p.m.x && x < p.m.x + p.w && y >= p.m.y && y < p.m.y + p.h) ||
    pairs.reduce((best, p) => {
      const dist = Math.hypot(x - (p.m.x + p.w / 2), y - (p.m.y + p.h / 2));
      return !best || dist < best.dist ? { ...p, dist } : best;
    }, null);
  return {
    pairs,
    // layout rect -> Electron (DIP) rect, using the monitor its top-left corner is on
    toDip(x, y, w, h) {
      const p = pairAt(x, y);
      if (!p) return { x, y, width: w, height: h };
      const sx = p.d.bounds.width / p.w;
      const sy = p.d.bounds.height / p.h;
      return { x: p.d.bounds.x + (x - p.m.x) * sx, y: p.d.bounds.y + (y - p.m.y) * sy, width: w * sx, height: h * sy };
    },
    // Electron (DIP) rect -> layout rect
    toLayout(r) {
      const p = pairs.find((q) => r.x >= q.d.bounds.x && r.x < q.d.bounds.x + q.d.bounds.width && r.y >= q.d.bounds.y && r.y < q.d.bounds.y + q.d.bounds.height) || pairs[0];
      if (!p) return r;
      const sx = p.w / p.d.bounds.width;
      const sy = p.h / p.d.bounds.height;
      return { x: p.m.x + (r.x - p.d.bounds.x) * sx, y: p.m.y + (r.y - p.d.bounds.y) * sy, width: r.width * sx, height: r.height * sy };
    },
  };
}

// ---------- the screen's edges ----------
// What bars (waybar, eww...) take off each Electron display, in DIP: { [displayId]: {l,t,r,b} }.
// Electron can't see them under Hyprland, so without this Claude would stand behind the bar.
let reserved = {};
async function refreshReserved(displays) {
  const monitors = await json('monitors');
  if (!Array.isArray(monitors)) return reserved;
  const next = {};
  for (const p of pairUp(monitors, displays)) {
    const [l = 0, t = 0, r = 0, b = 0] = p.m.reserved || [];
    const sx = p.d.bounds.width / p.w;
    const sy = p.d.bounds.height / p.h;
    next[p.d.id] = { l: l * sx, t: t * sy, r: r * sx, b: b * sy };
  }
  reserved = next;
  return reserved;
}
const reservedFor = (displayId) => reserved[displayId] || { l: 0, t: 0, r: 0, b: 0 };

// ---------- windows ----------
const visibleWorkspaces = (monitors) =>
  new Set(monitors.flatMap((m) => [m.activeWorkspace && m.activeWorkspace.id, m.specialWorkspace && m.specialWorkspace.id]).filter(Boolean));

// Every window you can see, front to back, as Electron rects with stand: false for fullscreen
// ones (nothing stands on them, but they hide what's behind). Fullscreen windows are in front,
// then floating ones (the most recently focused on top), then tiled ones.
async function listWindows(displays, ownPid) {
  const [clients, monitors] = await Promise.all([json('clients'), json('monitors')]);
  if (!Array.isArray(clients) || !Array.isArray(monitors)) return [];
  const map = makeMapper(monitors, displays);
  const shown = visibleWorkspaces(monitors);
  return clients
    .filter((c) => c.mapped && !c.hidden && c.pid !== ownPid && !/^claudetop$/i.test(c.class || '') && shown.has(c.workspace && c.workspace.id))
    .sort((a, b) => Number(!!b.fullscreen) - Number(!!a.fullscreen) || Number(!!b.floating) - Number(!!a.floating) || a.focusHistoryID - b.focusHistoryID)
    .map((c) => ({ id: c.address, ...map.toDip(c.at[0], c.at[1], c.size[0], c.size[1]), stand: !c.fullscreen }));
}

async function activeWindow(displays) {
  const [w, monitors] = await Promise.all([json('activewindow'), json('monitors')]);
  if (!w || !w.address || !Array.isArray(monitors)) return null;
  const map = makeMapper(monitors, displays);
  let r = map.toDip(w.at[0], w.at[1], w.size[0], w.size[1]);
  // Fullscreen: report the whole monitor, so game mode recognises it whatever the gaps.
  if (w.fullscreen === true || w.fullscreen >= 2) {
    const p = map.pairs.find((q) => q.m.id === w.monitor);
    if (p) r = { ...p.d.bounds };
  }
  return {
    id: w.address,
    pid: w.pid,
    title: w.title || '',
    className: w.class || '',
    rect: `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.x + r.width)},${Math.round(r.y + r.height)}`,
  };
}

const focusPid = (pid) => request(`dispatch focuswindow pid:${pid}`);
const sendCtrlW = (address) => request(`dispatch sendshortcut CTRL, W, address:${address}`);

// ---------- claudetop's own window ----------
// Find it (it's an XWayland window of this process), then make it float, pin it to every
// workspace, take off the border, shadow, rounding, blur and animations, and put it exactly
// where Electron asked. Property names changed between Hyprland versions, so several spellings
// are sent; the ones this version doesn't know are just refused.
// (Not nofocus: on some versions that also keeps clicks away, and Electron already asks for no
// keyboard focus.)
const LOOKS = [
  'noborder 1', 'noshadow 1', 'noblur 1', 'rounding 0', 'noanim 1', 'nodim 1',
  'border_size 0', 'no_shadow 1', 'no_blur 1', 'no_anim 1', 'no_dim 1', 'decorate 0',
];
let ownAddress = null;
let styled = false;

async function placeOwnWindow(bounds, displays, ownPid) {
  const [clients, monitors] = await Promise.all([json('clients'), json('monitors')]);
  if (!Array.isArray(clients) || !Array.isArray(monitors)) return false;
  const own = clients.find((c) => c.pid === ownPid && c.mapped) || clients.find((c) => /^claudetop$/i.test(c.class || '') && c.xwayland);
  if (!own) return false;
  if (own.address !== ownAddress) {
    ownAddress = own.address;
    styled = false;
  }
  const at = `address:${own.address}`;
  const commands = [];
  if (!own.floating) commands.push(`dispatch setfloating ${at}`);
  if (!own.pinned) commands.push(`dispatch pin ${at}`); // pin toggles, so only when it isn't
  const r = makeMapper(monitors, displays).toLayout(bounds);
  const [x, y, w, h] = [r.x, r.y, r.width, r.height].map(Math.round);
  if (own.size[0] !== w || own.size[1] !== h) commands.push(`dispatch resizewindowpixel exact ${w} ${h},${at}`);
  if (own.at[0] !== x || own.at[1] !== y) commands.push(`dispatch movewindowpixel exact ${x} ${y},${at}`);
  if (commands.length) await batch(commands);
  if (!styled) {
    styled = true;
    await batch(LOOKS.flatMap((prop) => [`dispatch setprop ${at} ${prop}`, `setprop ${at} ${prop} lock`]));
  }
  return true;
}

module.exports = {
  isHyprland,
  request,
  json,
  makeMapper,
  refreshReserved,
  reservedFor,
  listWindows,
  activeWindow,
  focusPid,
  sendCtrlW,
  placeOwnWindow,
};
