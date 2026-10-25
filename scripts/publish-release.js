// Publishes the installer from the last `npm run dist`, everywhere, in one go:
//   npm run release -- --notes "First change; Second change"
// 1. Creates the GitHub Release (v<version>) with the Windows installer attached. Publishing it
//    starts .github/workflows/linux.yml, which builds the AppImage and .deb and attaches them.
// 2. Puts the version at the top of website/releases.json with all download links.
// 3. Commits and pushes the release list, which redeploys the website.
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
let linux = null;
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
    // The release's tag (and the Linux build) must be this code, so push it first and pin the
    // tag to this exact commit; otherwise the tag lands on whatever main was before.
    execFileSync('git', ['push'], { cwd: root, stdio: 'inherit' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync(gh, ['release', 'create', tag, staged, '--repo', repo, '--target', head, '--title', `claudetop ${version}`, '--notes', body], {
      stdio: 'inherit',
    });
  }
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  file = `${base}/${fileName}`;
  // Built and attached by the Linux workflow a few minutes after the release is published
  // (names follow "artifactName" in package.json).
  linux = { appimage: `${base}/claudetop-${version}-x86_64.AppImage`, deb: `${base}/claudetop-${version}-amd64.deb` };
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const entry = {
  version,
  date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, // local date
  file,
  ...(linux ? { linux } : {}),
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
if (!entry.notes.length) console.log('No release notes yet: add them with --notes "First; Second".');

// Put it on the website: commit and push the release list (the Pages workflow deploys it).
if (!local) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' });
  git('add', 'website/releases.json', 'website/releases.js');
  git('commit', '-m', `Release ${version}`);
  git('push');
  console.log(`Website updated. The Linux build is now running: https://github.com/${repo}/actions`);
}
