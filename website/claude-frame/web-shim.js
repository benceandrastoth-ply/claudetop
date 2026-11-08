// Stands in for Electron's preload (src/preload.js) on the website's playground: the page in the
// parent window (play.js) feeds events in through __claudetop.emit, and hears back through
// window.parent.playHost.
(() => {
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

  const host = (name) => (...args) => {
    const h = window.parent && window.parent !== window && window.parent.playHost;
    if (h && typeof h[name] === 'function') h[name](...args);
  };
  window.claudetop = {
    platform: 'web',
    claudeRect: () => {},
    shape: () => {},
    onConfig: on('config'),
    onSessions: on('sessions'),
    onFocus: on('focus'),
    onLockIn: on('lockin'),
    lockInClose: host('lockInClose'),
    lockInDone: host('lockInDone'),
    onLayout: on('layout'),
    onPlatforms: on('platforms'),
    onMedia: on('media'),
    setSpan: () => {},
    setIgnoreMouse: host('setIgnoreMouse'),
    setFixedX: host('setFixedX'),
    showMenu: host('showMenu'),
    jumpTo: host('jumpTo'),
    setHidden: host('setHidden'),
    onGame: on('game'),
    onAchievement: on('achievement'),
    stat: () => {},
    cycleHat: host('cycleHat'),
    setLastX: () => {},
  };
})();
