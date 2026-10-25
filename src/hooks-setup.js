// Adds or removes the claudetop hooks in ~/.claude/settings.json.
// Existing settings and other hooks are preserved; a backup is written before each change.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARKER = '--claudetop-hook';
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
];

// Older installs pointed `node` straight at hooks/report.js without the marker.
const isOurs = (h) =>
  typeof h.command === 'string' &&
  (h.command.includes(MARKER) || (h.command.includes('claudetop') && h.command.includes('hooks/report.js')));

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.claudetop-backup');
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

// command: the hook command without the marker, e.g. `node "C:/x/report.js"`.
function installHooks(command) {
  apply(`${command} ${MARKER}`);
}

function uninstallHooks() {
  apply(null);
}

function apply(command) {
  const settings = readSettings();
  settings.hooks = settings.hooks || {};
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (command) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settings);
}

// The command our hooks currently run (null if not installed).
function installedCommand() {
  try {
    const hooks = readSettings().hooks || {};
    for (const g of hooks.Stop || []) for (const h of g.hooks || []) if (isOurs(h)) return h.command;
  } catch {}
  return null;
}

// Re-point the hooks at the app if it moved (e.g. an AppImage in a new folder), without
// rewriting settings.json when nothing changed.
// Also adds any events a newer version listens to.
function refreshHooks(command) {
  const current = installedCommand();
  if (!current) return;
  let missing = false;
  try {
    const hooks = readSettings().hooks || {};
    missing = EVENTS.some((e) => !(hooks[e] || []).some((g) => (g.hooks || []).some(isOurs)));
  } catch {}
  if (missing || current !== `${command} ${MARKER}`) installHooks(command);
}

function hooksInstalled() {
  try {
    const hooks = readSettings().hooks || {};
    return (hooks.Stop || []).some((g) => (g.hooks || []).some(isOurs));
  } catch {
    return false;
  }
}

module.exports = { SETTINGS, MARKER, installHooks, uninstallHooks, hooksInstalled, refreshHooks };
