// Fake Hyprland IPC socket + checks for src/platform-hyprland.js.
// node test/hyprland.test.js   (Linux or macOS: needs Unix sockets)
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');

const repo = path.join(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-'));
process.env.XDG_RUNTIME_DIR = runtime;
process.env.HYPRLAND_INSTANCE_SIGNATURE = 'testsig';
const dir = path.join(runtime, 'hypr', 'testsig');
fs.mkdirSync(dir, { recursive: true });
const sockPath = path.join(dir, '.socket.sock');

// Two monitors: DP-1 1920x1080 @1 at 0,0 with a 30px bar at the bottom; HDMI 2560x1440 @1.25 at 1920,0
const monitors = [
  { id: 0, name: 'DP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, transform: 0, reserved: [0, 0, 0, 30], activeWorkspace: { id: 1 }, specialWorkspace: { id: 0 } },
  { id: 1, name: 'HDMI-A-1', width: 2560, height: 1440, x: 1920, y: 0, scale: 1.25, transform: 0, reserved: [0, 40, 0, 0], activeWorkspace: { id: 5 }, specialWorkspace: { id: 0 } },
];
const OWN = 4242;
let own = { address: '0xown', pid: OWN, class: 'claudetop', xwayland: true, mapped: true, hidden: false, floating: false, pinned: false, at: [500, 500], size: [800, 600], workspace: { id: 1 }, fullscreen: 0, focusHistoryID: 9 };
const clients = () => [
  { address: '0xa', pid: 100, class: 'kitty', mapped: true, hidden: false, floating: false, at: [10, 400], size: [940, 640], workspace: { id: 1 }, fullscreen: 0, focusHistoryID: 1 },
  { address: '0xb', pid: 101, class: 'firefox', mapped: true, hidden: false, floating: true, at: [300, 300], size: [600, 400], workspace: { id: 1 }, fullscreen: 0, focusHistoryID: 0 },
  { address: '0xc', pid: 102, class: 'other-ws', mapped: true, hidden: false, floating: false, at: [10, 10], size: [500, 500], workspace: { id: 2 }, fullscreen: 0, focusHistoryID: 2 },
  { address: '0xd', pid: 103, class: 'mpv', mapped: true, hidden: false, floating: false, at: [1920, 0], size: [2048, 1152], workspace: { id: 5 }, fullscreen: 2, focusHistoryID: 3 },
  { address: '0xe', pid: 104, class: 'foot', mapped: true, hidden: false, floating: true, at: [2200, 600], size: [400, 300], workspace: { id: 5 }, fullscreen: 0, focusHistoryID: 4 },
  own,
];
const received = [];
const server = net.createServer((c) => {
  c.on('data', (d) => {
    const cmd = d.toString();
    received.push(cmd);
    let out = 'ok';
    if (cmd === 'j/monitors') out = JSON.stringify(monitors);
    else if (cmd === 'j/clients') out = JSON.stringify(clients());
    else if (cmd === 'j/activewindow') out = JSON.stringify({ ...clients()[3], monitor: 1, title: 'video' });
    else if (cmd.startsWith('[[BATCH]]')) {
      for (const part of cmd.slice(9).split(';')) {
        if (part.startsWith('dispatch setfloating')) own.floating = true;
        if (part.startsWith('dispatch pin')) own.pinned = !own.pinned;
        let m = /resizewindowpixel exact (\d+) (\d+)/.exec(part);
        if (m) own.size = [+m[1], +m[2]];
        m = /movewindowpixel exact (-?\d+) (-?\d+)/.exec(part);
        if (m) own.at = [+m[1], +m[2]];
      }
    }
    c.end(out);
  });
});

// Electron's view: XWayland without force_zero_scaling reports layout-sized screens.
const displays = [
  { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 22, bounds: { x: 1920, y: 0, width: 2048, height: 1152 }, workArea: { x: 1920, y: 0, width: 2048, height: 1152 }, scaleFactor: 1 },
];

server.listen(sockPath, async () => {
  try {
    const hypr = require(path.join(repo, 'src', 'platform-hyprland.js'));
    assert.strictEqual(hypr.isHyprland, true);

    // bars
    await hypr.refreshReserved(displays);
    assert.deepStrictEqual(hypr.reservedFor(11), { l: 0, t: 0, r: 0, b: 30 });
    assert.deepStrictEqual(hypr.reservedFor(22), { l: 0, t: 40, r: 0, b: 0 });
    console.log('ok  bars: bottom bar on DP-1, top bar on HDMI');

    // windows: front to back, floating first, other workspace + fullscreen + own left out
    const list = await hypr.listWindows(displays, OWN);
    assert.deepStrictEqual(list.map((w) => w.id), ['0xb', '0xe', '0xa']);
    assert.deepStrictEqual(list[1], { id: '0xe', x: 2200, y: 600, width: 400, height: 300 });
    console.log('ok  windows:', list.map((w) => `${w.id}@${w.x},${w.y}`).join(' '));

    // with force_zero_scaling, Electron sees HDMI at full pixels: coordinates must scale
    const zero = [displays[0], { id: 22, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 }];
    const scaled = await hypr.listWindows(zero, OWN);
    const foot = scaled.find((w) => w.id === '0xe');
    assert.deepStrictEqual([foot.x, foot.y, foot.width, foot.height], [1920 + 280 * 1.25, 750, 500, 375]);
    console.log('ok  scaled monitor maps to Electron pixels:', foot);

    // active window: fullscreen reports the whole monitor (game mode)
    const a = await hypr.activeWindow(displays);
    assert.strictEqual(a.rect, '1920,0,3968,1152');
    console.log('ok  active fullscreen window covers its monitor:', a.rect);

    // own window: float, pin once, resize and move exactly, style once
    const bounds = { x: 0, y: 0, width: 1920, height: 1050 };
    assert.strictEqual(await hypr.placeOwnWindow(bounds, displays, OWN), true);
    assert.ok(own.floating && own.pinned, 'floating and pinned');
    assert.deepStrictEqual([own.at, own.size], [[0, 0], [1920, 1050]]);
    const styleBatches = received.filter((r) => r.includes('noborder'));
    assert.strictEqual(styleBatches.length, 1);
    received.length = 0;
    await hypr.placeOwnWindow(bounds, displays, OWN);
    assert.ok(own.pinned, 'second call must not unpin (pin toggles)');
    assert.ok(!received.some((r) => r.startsWith('[[BATCH]]')), 'nothing to change -> no batch: ' + received.join(' | '));
    console.log('ok  own window floated, pinned once, placed at', own.at, own.size);

    // moved to the HDMI screen (scaled): layout coords
    await hypr.placeOwnWindow({ x: 1920, y: 0, width: 2048, height: 1152 }, zero, OWN);
    assert.deepStrictEqual([own.at, own.size], [[1920, 0], [1638, 922]]);
    console.log('ok  placement converts back to layout pixels:', own.at, own.size);
    console.log('ALL PASSED');
  } catch (e) {
    console.error('FAIL', e);
    process.exitCode = 1;
  }
  server.close();
});
