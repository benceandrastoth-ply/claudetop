// Stands in for Electron's preload (src/preload.js) on Android: the page talks to the app
// through window.ClaudetopAndroid, and the app calls __claudetop.emit(event, value).
(() => {
  const native = window.ClaudetopAndroid;
  const handlers = {};
  const on = (name) => (fn) => {
    (handlers[name] = handlers[name] || []).push(fn);
  };
  const emit = (name, value) => {
    for (const fn of handlers[name] || []) {
      try { fn(value); } catch (e) { console.error(e); }
    }
  };
  window.__claudetop = { emit };

  const noop = () => {};
  window.claudetop = {
    platform: 'android',
    claudeRect: (rects) => native.claudeRect(JSON.stringify(rects)),
    shape: noop,
    onConfig: on('config'),
    onSessions: on('sessions'),
    onFocus: on('focus'),
    onLockIn: on('lockin'),
    lockInClose: noop,
    lockInDone: noop,
    onLayout: on('layout'),
    onMedia: on('media'),
    setSpan: noop,
    setIgnoreMouse: noop,
    setFixedX: noop,
    showMenu: () => native.showMenu(),
    jumpTo: () => native.jumpTo(),
    setHidden: noop,
    onGame: on('game'),
    onAchievement: on('achievement'),
    stat: noop,
    cycleHat: (step) => native.cycleHat(step),
    setLastX: (x) => native.setLastX(x),
  };

  // One "monitor": the width of the view, with the floor at the bottom.
  function layout() {
    const w = window.innerWidth;
    const seg = { left: 0, right: w, ground: 0 };
    emit('layout', { winX: 0, winY: 0, home: seg, segments: [seg], desktop: { left: 0, right: w } });
  }
  window.addEventListener('resize', layout);

  // ---- touch -> the mouse events the page understands ----
  // Hold to see the sessions, tap to say you've seen it (double-tap pets), drag or fling it,
  // long-press for the app.
  const LONG_PRESS_MS = 600;
  let touch = null; // { target, x, y, moved, longTimer, menu }
  let leaveTimer = null;
  const claude = () => document.getElementById('claude');
  const mouse = (type, target, t) =>
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: type !== 'mouseenter' && type !== 'mouseleave',
      cancelable: true,
      button: 0,
      clientX: t ? t.clientX : 0,
      clientY: t ? t.clientY : 0,
    }));

  document.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    const el = claude();
    if (touch || !el || !el.contains(e.target)) {
      // Not on Claude: an extra Claude still takes a tap.
      return;
    }
    e.preventDefault();
    clearTimeout(leaveTimer);
    mouse('mouseenter', el, t);
    touch = { id: t.identifier, target: e.target, x: t.clientX, y: t.clientY, moved: false, menu: false };
    touch.longTimer = setTimeout(() => {
      if (!touch || touch.moved) return;
      touch.menu = true;
      native.showMenu();
    }, LONG_PRESS_MS);
    mouse('mousedown', e.target, t);
  }, { passive: false });

  const find = (list) => [...list].find((t) => touch && t.identifier === touch.id);

  document.addEventListener('touchmove', (e) => {
    const t = find(e.changedTouches);
    if (!t) return;
    e.preventDefault();
    if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 8) touch.moved = true;
    mouse('mousemove', window, t);
  }, { passive: false });

  function end(e) {
    const t = find(e.changedTouches);
    if (!t) return;
    e.preventDefault();
    clearTimeout(touch.longTimer);
    mouse('mouseup', window, t);
    touch = null;
    const el = claude();
    // Keep the session list up for a moment after a tap.
    leaveTimer = setTimeout(() => el && mouse('mouseleave', el), 3000);
  }
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', end, { passive: false });

  window.addEventListener('DOMContentLoaded', () => {
    layout();
    native.ready();
  });
})();
