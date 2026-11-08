// Walking on windows: which window tops Claude can stand on, and which windows are walls.
// Pure, so it can be tested without Electron (test/platforms.test.js).
//
// windows: every window you can see, front to back: { id, x, y, width, height, stand }.
//   stand: false for maximized and fullscreen windows. Nothing stands on those, but they still
//   hide whatever is behind them.
// win: claudetop's window ({ x, y, width, height }); the results are relative to it, heights
//   measured up from its bottom edge (like the page's ground).
// screenAt(x, y): { area, floor } of the monitor there: the part without taskbar/bars and the
//   y Claude stands on.
// Both lists carry z (0 = front): a window only blocks Claude's way if it's in front of the one
// Claude stands on.

const HEADROOM = 120; // a window this close to the top of the screen has no room above it
const MIN_WIDTH = 100; // narrower ledges aren't worth standing on
const BAND = 40; // a window in front this close above a ledge leaves no room to stand there

function computePlatforms(windows, win, screenAt) {
  const bottom = win.y + win.height;
  const platforms = [];
  const walls = [];
  const cut = (pieces, from, to) =>
    pieces.flatMap(([l, r]) => (to <= l || from >= r ? [[l, r]] : [[l, from], [to, r]].filter(([a, b]) => b - a > 0)));
  windows.forEach((w, i) => {
    if (w.stand === false) return;
    const { area, floor } = screenAt(w.x + w.width / 2, w.y);
    if (w.y - area.y < HEADROOM || w.y > floor - 40) return; // no room above it, or down at the floor
    // Whatever is in front of its top edge (or just above it) hides that part.
    let pieces = [[Math.max(w.x, area.x), Math.min(w.x + w.width, area.x + area.width)]];
    for (const front of windows.slice(0, i)) {
      if (front.y <= w.y + 2 && front.y + front.height > w.y - BAND) pieces = cut(pieces, front.x, front.x + front.width);
    }
    for (const [l, r] of pieces) {
      if (r - l >= MIN_WIDTH) {
        platforms.push({ id: w.id, z: i, left: Math.round(l - win.x), right: Math.round(r - win.x), ground: Math.round(bottom - w.y) });
      }
    }
    walls.push({
      id: w.id,
      z: i,
      left: Math.round(w.x - win.x),
      right: Math.round(w.x + w.width - win.x),
      top: Math.round(bottom - w.y),
      bottom: Math.round(bottom - w.y - w.height),
    });
  });
  return { platforms, walls };
}

module.exports = { computePlatforms };
