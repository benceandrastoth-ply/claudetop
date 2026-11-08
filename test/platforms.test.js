// node test/platforms.test.js : which window tops Claude may stand on (src/platforms.js).
const assert = require('assert');
const path = require('path');
const { computePlatforms } = require(path.join(__dirname, '..', 'src', 'platforms.js'));

// One 1920x1080 screen with a 48px taskbar; claudetop's window covers it down to the taskbar.
const win = { x: 0, y: 0, width: 1920, height: 1032 };
const screenAt = () => ({ area: { x: 0, y: 0, width: 1920, height: 1032 }, floor: 1032 });
const run = (windows) => computePlatforms(windows, win, screenAt);
const test = (name, fn) => {
  fn();
  console.log('ok ', name);
};

test('a lone window: its whole top edge', () => {
  const { platforms } = run([{ id: 'a', x: 200, y: 400, width: 800, height: 500, stand: true }]);
  assert.deepStrictEqual(platforms, [{ id: 'a', z: 0, left: 200, right: 1000, ground: 632 }]);
});

test('a window hidden behind a maximized one is no ledge (the 0.10.0 bug)', () => {
  const { platforms, walls } = run([
    { id: 'max', x: 0, y: 0, width: 1920, height: 1032, stand: false },
    { id: 'behind', x: 525, y: 260, width: 863, height: 524, stand: true },
  ]);
  assert.deepStrictEqual(platforms, []);
  assert.deepStrictEqual(walls.map((w) => w.id), ['behind']); // nothing stands on a maximized one
});

test('a window in front covering part of the top edge cuts it', () => {
  const { platforms } = run([
    { id: 'front', x: 25, y: 26, width: 1115, height: 628, stand: true },
    { id: 'back', x: 525, y: 260, width: 863, height: 524, stand: true },
  ]);
  assert.deepStrictEqual(platforms.filter((p) => p.id === 'back'), [{ id: 'back', z: 1, left: 1140, right: 1388, ground: 772 }]);
});

test('a window in front just above the edge leaves no room to stand', () => {
  const { platforms } = run([
    { id: 'front', x: 0, y: 150, width: 700, height: 230, stand: true }, // bottom at 380
    { id: 'back', x: 100, y: 400, width: 1000, height: 400, stand: true }, // top at 400
  ]);
  assert.deepStrictEqual(platforms.filter((p) => p.id === 'back').map((p) => [p.left, p.right]), [[700, 1100]]);
});

test('a window behind does not hide the one in front', () => {
  const { platforms } = run([
    { id: 'front', x: 300, y: 500, width: 600, height: 300, stand: true },
    { id: 'back', x: 0, y: 200, width: 1920, height: 800, stand: true },
  ]);
  assert.deepStrictEqual(platforms.find((p) => p.id === 'front'), { id: 'front', z: 0, left: 300, right: 900, ground: 532 });
});

test('no room above it, or down at the floor: no ledge', () => {
  const { platforms } = run([
    { id: 'top', x: 0, y: 60, width: 900, height: 400, stand: true },
    { id: 'low', x: 1000, y: 1010, width: 400, height: 200, stand: true },
  ]);
  assert.deepStrictEqual(platforms, []);
});

console.log('ALL PASSED');
