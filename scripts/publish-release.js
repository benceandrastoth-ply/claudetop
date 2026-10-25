// Puts the installer from the last `npm run dist` on the website.
//   npm run release -- --notes "First change; Second change"
// Copies dist/claudetop Setup <version>.exe to website/downloads/, records its size and
// SHA-256, and adds (or updates) the version at the top of website/releases.json.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const site = path.join(root, 'website');
const { version } = require(path.join(root, 'package.json'));

const notesArg = process.argv.indexOf('--notes');
const notes =
  notesArg > -1 ? process.argv[notesArg + 1].split(';').map((s) => s.trim()).filter(Boolean) : null;

const installer = path.join(root, 'dist', `claudetop Setup ${version}.exe`);
if (!fs.existsSync(installer)) {
  console.error(`No installer for ${version}. Run "npm run dist" first.`);
  process.exit(1);
}

const fileName = `claudetop-Setup-${version}.exe`;
fs.mkdirSync(path.join(site, 'downloads'), { recursive: true });
fs.copyFileSync(installer, path.join(site, 'downloads', fileName));
const data = fs.readFileSync(installer);

const listFile = path.join(site, 'releases.json');
const releases = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : [];
const existing = releases.find((r) => r.version === version);
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const entry = {
  version,
  date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, // local date
  file: `downloads/${fileName}`,
  size: data.length,
  sha256: crypto.createHash('sha256').update(data).digest('hex'),
  notes: notes || (existing && existing.notes) || [],
};
const rest = releases.filter((r) => r.version !== version);
const updated = [entry, ...rest].sort((a, b) =>
  b.version.localeCompare(a.version, undefined, { numeric: true })
);

fs.writeFileSync(listFile, JSON.stringify(updated, null, 2) + '\n');
// The page loads this copy, so it also works when opened straight from disk.
fs.writeFileSync(path.join(site, 'releases.js'), `window.RELEASES = ${JSON.stringify(updated, null, 2)};\n`);

console.log(`Published ${version} (${(data.length / 1048576).toFixed(1)} MB) to website/downloads/${fileName}`);
if (!entry.notes.length) console.log('No release notes yet: add them with --notes "First; Second".');
