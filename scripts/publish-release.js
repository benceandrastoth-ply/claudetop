// Publishes the installer from the last `npm run dist`.
//   npm run release -- --notes "First change; Second change"
// Creates a GitHub Release (v<version>) with the installer attached, then adds (or updates) the
// version at the top of website/releases.json so the site's download buttons point to it.
// Commit and push afterwards to update the website.
// --local skips GitHub and serves the installer from website/downloads/ instead.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const site = path.join(root, 'website');
const pkg = require(path.join(root, 'package.json'));
const { version } = pkg;
const repo = String(pkg.repository || '').replace(/^github:/, '');
const local = process.argv.includes('--local');

const notesArg = process.argv.indexOf('--notes');
const notes =
  notesArg > -1 ? process.argv[notesArg + 1].split(';').map((s) => s.trim()).filter(Boolean) : null;

const installer = path.join(root, 'dist', `claudetop Setup ${version}.exe`);
if (!fs.existsSync(installer)) {
  console.error(`No installer for ${version}. Run "npm run dist" first.`);
  process.exit(1);
}

const listFile = path.join(site, 'releases.json');
const releases = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : [];
const existing = releases.find((r) => r.version === version);
const releaseNotes = notes || (existing && existing.notes) || [];

const fileName = `claudetop-Setup-${version}.exe`;
const staged = path.join(site, 'downloads', fileName); // also the upload's file name on GitHub
fs.mkdirSync(path.dirname(staged), { recursive: true });
fs.copyFileSync(installer, staged);
const data = fs.readFileSync(installer);

let file = `downloads/${fileName}`;
if (!local) {
  if (!repo) throw new Error('Set "repository" in package.json (github:owner/name).');
  const gh = fs.existsSync('C:/Program Files/GitHub CLI/gh.exe') ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh';
  const tag = `v${version}`;
  const body = releaseNotes.map((n) => `- ${n}`).join('\n') || `claudetop ${version}`;
  let exists = true;
  try {
    execFileSync(gh, ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' });
  } catch {
    exists = false;
  }
  if (exists) {
    execFileSync(gh, ['release', 'upload', tag, staged, '--clobber', '--repo', repo], { stdio: 'inherit' });
  } else {
    execFileSync(gh, ['release', 'create', tag, staged, '--repo', repo, '--title', `claudetop ${version}`, '--notes', body], {
      stdio: 'inherit',
    });
  }
  file = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const entry = {
  version,
  date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, // local date
  file,
  size: data.length,
  sha256: crypto.createHash('sha256').update(data).digest('hex'),
  notes: releaseNotes,
};
const updated = [entry, ...releases.filter((r) => r.version !== version)].sort((a, b) =>
  b.version.localeCompare(a.version, undefined, { numeric: true })
);

fs.writeFileSync(listFile, JSON.stringify(updated, null, 2) + '\n');
// The page loads this copy, so it also works when opened straight from disk.
fs.writeFileSync(path.join(site, 'releases.js'), `window.RELEASES = ${JSON.stringify(updated, null, 2)};\n`);

console.log(`Published ${version} (${(data.length / 1048576).toFixed(1)} MB): ${file}`);
if (!local) console.log('Now commit and push website/releases.* to update the site.');
if (!entry.notes.length) console.log('No release notes yet: add them with --notes "First; Second".');
