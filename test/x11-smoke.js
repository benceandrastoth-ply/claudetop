// Walking on windows under X11, end to end: run claudetop (dev build) on a virtual X server
// that already has a window manager and some xterms (see .github/workflows/test.yml), then
// check over the DevTools protocol that the page got their top edges, make Claude jump onto
// one, and take screenshots into test-output/.
// node test/x11-smoke.js   (needs DISPLAY, xprop, xwininfo and ImageMagick's import)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A clean home whose config already has the setting on and the first-launch question answered.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetop-home-'));
const configDir = path.join(home, '.config', 'claudetop');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ walkOnWindows: true, setupDone: true, tv: false, sounds: false }));

const electron = require('electron'); // the binary's path
const app = spawn(electron, [root, '--no-sandbox', '--remote-debugging-port=9333'], {
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
  stdio: 'inherit',
});

async function evaluate(expression) {
  const list = await (await fetch('http://127.0.0.1:9333/json')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return new Promise((resolve, reject) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== 1) return;
      ws.close();
      if (d.result.exceptionDetails) reject(new Error(JSON.stringify(d.result.exceptionDetails)));
      else resolve(d.result.result.value);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

const shot = (name) => execFileSync('import', ['-window', 'root', path.join(out, `${name}.png`)]);

(async () => {
  try {
    // The page loads, then main starts sending window edges.
    let state = null;
    for (let i = 0; i < 60; i++) {
      await wait(500);
      try {
        state = await evaluate('({ platforms, walls, layout, inner: [innerWidth, innerHeight], entered })');
        if (state && state.entered && state.platforms.length >= 2) break;
      } catch {}
    }
    console.log(JSON.stringify(state, null, 1));
    assert.ok(state, 'page never answered');
    assert.strictEqual(state.inner[1], 1080, 'the window should cover the whole screen (no panel here)');
    assert.ok(state.platforms.length >= 2, 'both xterms should be platforms');

    // xterm "left" was placed at y=520, "right" at y=300 (the window manager's frame starts
    // there): their top edges stand 560 and 780 px above the screen's bottom edge.
    const grounds = state.platforms.map((p) => p.ground).sort((a, b) => a - b);
    assert.ok(Math.abs(grounds[0] - 560) <= 40, `left xterm's top: ${grounds[0]}`);
    assert.ok(Math.abs(grounds[grounds.length - 1] - 780) <= 40, `right xterm's top: ${grounds[grounds.length - 1]}`);
    shot('1-floor');

    // Jump onto the higher one.
    const landed = await evaluate(`(async () => {
      while (puppet || walker.airBottom !== null) await new Promise((r) => setTimeout(r, 100));
      const p = platforms.reduce((a, b) => (b.ground > a.ground ? b : a));
      await jumpOnto({ p, x: (p.left + p.right) / 2 - WIDTH / 2 });
      config.mode = 'fixed'; // stand still for the photo
      await new Promise((r) => setTimeout(r, 300));
      return { on: walker.on, level: walker.level, want: p.id, ground: p.ground, bottom: el.style.bottom };
    })()`);
    console.log('after the jump:', landed);
    assert.strictEqual(landed.on, landed.want);
    assert.strictEqual(landed.level, landed.ground);
    shot('2-on-window');

    // Take that window away: Claude falls back to the floor.
    execFileSync('sh', ['-c', 'xdotool search --name "^right$" windowunmap || xkill -id $(xwininfo -name right | sed -n "s/.*Window id: \\(0x[0-9a-f]*\\).*/\\1/p")'], { stdio: 'inherit' });
    await wait(2500);
    const after = await evaluate('({ on: walker.on, level: walker.level, platforms: platforms.length })');
    console.log('after closing it:', after);
    assert.strictEqual(after.on, null);
    assert.strictEqual(after.level, 0);
    shot('3-fell');
    console.log('X11 SMOKE TEST PASSED');
  } catch (e) {
    console.error('FAIL', e);
    try { shot('failure'); } catch {}
    process.exitCode = 1;
  }
  app.kill();
})();
