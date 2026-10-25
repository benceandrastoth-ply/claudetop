const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudetop', {
  platform: process.platform,
  claudeRect: (rect) => ipcRenderer.send('claude-rect', rect),
  shape: (rects) => ipcRenderer.send('shape', rects),
  onConfig: (fn) => ipcRenderer.on('config', (_e, cfg) => fn(cfg)),
  onSessions: (fn) => ipcRenderer.on('sessions', (_e, sessions) => fn(sessions)),
  onFocus: (fn) => ipcRenderer.on('focus', (_e, focus) => fn(focus)),
  onLockIn: (fn) => ipcRenderer.on('lockin', (_e, job) => fn(job)),
  lockInClose: () => ipcRenderer.send('lockin-close'),
  lockInDone: () => ipcRenderer.send('lockin-done'),
  onLayout: (fn) => ipcRenderer.on('layout', (_e, layout) => fn(layout)),
  onMedia: (fn) => ipcRenderer.on('media', (_e, media) => fn(media)),
  setSpan: (span) => ipcRenderer.send('set-span', span),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setFixedX: (x) => ipcRenderer.send('set-fixed-x', x),
  showMenu: () => ipcRenderer.send('show-menu'),
});
