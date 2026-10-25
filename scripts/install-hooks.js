// Dev helper: points Claude Code's hooks at this checkout (`node hooks/report.js`).
// The installed app does the same thing with its own exe instead of node.

const path = require('path');
const { SETTINGS, installHooks, uninstallHooks } = require('../src/hooks-setup');

const script = path.resolve(__dirname, '..', 'hooks', 'report.js').replace(/\\/g, '/');

if (process.argv.includes('--uninstall')) {
  uninstallHooks();
  console.log(`Removed claudetop hooks from ${SETTINGS}`);
} else {
  installHooks(`node "${script}"`);
  console.log(`Installed claudetop hooks in ${SETTINGS}`);
}
console.log(`Backup: ${SETTINGS}.claudetop-backup`);
