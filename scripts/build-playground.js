// Puts the app's own Claude on the website: copies src/index.html, renderer.js and style.css into
// website/claude-frame/, with web-shim.js standing in for Electron's preload and play-hooks.js
// after the renderer so the playground (website/play.html) can set up scenes.
// The pages workflow runs this before every deploy, so the site always shows the current app.
// Locally: node scripts/build-playground.js, then serve website/ over http (not file://).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'website', 'claude-frame');

fs.copyFileSync(path.join(root, 'src', 'renderer.js'), path.join(out, 'renderer.js'));
fs.copyFileSync(path.join(root, 'src', 'style.css'), path.join(out, 'style.css'));

const page = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const tag = '<script src="renderer.js"></script>';
if (!page.includes(tag)) throw new Error(`src/index.html no longer loads renderer.js with ${tag}`);
fs.writeFileSync(
  path.join(out, 'index.html'),
  page.replace(tag, `<script src="web-shim.js"></script>${tag}<script src="play-hooks.js"></script>`)
);
console.log('website/claude-frame/ is up to date with src/');
