// Fills the page from brand.js and releases.js, and runs the live taskbar demo.

const brand = window.BRAND || {};
const releases = window.RELEASES || [];

// ---------- branding ----------
const cssVars = {
  desk: '--desk', deskDeep: '--desk-deep', taskbar: '--taskbar', paper: '--paper',
  muted: '--muted', accent: '--accent', accentShade: '--accent-shade',
};
for (const [key, value] of Object.entries(brand.colors || {})) {
  if (cssVars[key]) document.documentElement.style.setProperty(cssVars[key], value);
}
const fill = (attr, text) => text && document.querySelectorAll(`[${attr}]`).forEach((n) => (n.textContent = text));
fill('data-brand-name', brand.name);
fill('data-brand-tagline', brand.tagline);
fill('data-brand-description', brand.description);
if (brand.name && brand.tagline) document.title = `${brand.name}: ${brand.tagline.replace(/\.$/, '').toLowerCase()}`;

const made = document.getElementById('made');
made.textContent = brand.maker ? `Made by ${brand.maker}.` : '';
const linkNames = { github: 'GitHub', discord: 'Discord', x: 'X' };
const links = document.getElementById('links');
for (const [key, url] of Object.entries(brand.links || {})) {
  if (!url) continue;
  const a = document.createElement('a');
  a.href = url;
  a.textContent = linkNames[key] || key;
  a.rel = 'noopener';
  links.appendChild(a);
}

// ---------- releases ----------
const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const niceDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const latest = releases.find((r) => r.file);

if (latest) {
  for (const id of ['download-main', 'download-setup']) {
    const a = document.getElementById(id);
    a.href = latest.file;
    a.setAttribute('download', '');
  }
  document.getElementById('download-meta').textContent =
    `Version ${latest.version} for 64-bit Windows 10 and 11. ${mb(latest.size)}, released ${niceDate(latest.date)}. Free.`;
}

const list = document.getElementById('release-list');
for (const r of releases) {
  const li = document.createElement('li');
  li.className = 'release';
  const isLatest = r === latest;
  const notes = (r.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  const action = r.file
    ? `<a href="${escapeHtml(r.file)}" download>Download ${escapeHtml(r.version)}</a> <span class="gone">(${mb(r.size)})</span>`
    : '<span class="gone">Installer not archived</span>';
  li.innerHTML = `
    <div><span class="ver">${escapeHtml(r.version)}</span>
      ${isLatest ? '<span class="latest">Newest</span>' : ''}
      <time datetime="${escapeHtml(r.date)}">${niceDate(r.date)}</time></div>
    <ul>${notes}</ul>
    <div class="get-old">${action}</div>
    ${r.sha256 ? `<div class="hash">SHA-256 ${escapeHtml(r.sha256)}</div>` : ''}`;
  list.appendChild(li);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------- the pixel Claude ----------
const SPRITE = `
  <div class="bubble"></div>
  <div class="zzz" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></div>
  <div class="sprite"><div class="bob">
    <svg viewBox="0 0 16 10" width="96" height="60" shape-rendering="crispEdges" aria-hidden="true">
      <g class="legs-a"><rect x="3" y="7" width="1" height="3" /><rect x="10" y="7" width="1" height="3" /></g>
      <g class="legs-b"><rect x="5" y="7" width="1" height="3" /><rect x="12" y="7" width="1" height="3" /></g>
      <rect class="body" x="2" y="0" width="12" height="7.01" />
      <g class="suit">
        <rect class="jacket" x="2" y="4.4" width="12" height="2.61" />
        <rect class="shirt" x="6.8" y="4.4" width="2.4" height="1.4" />
        <rect class="tie" x="7.6" y="4.4" width="0.8" height="2.4" />
        <rect class="tie" x="7.4" y="4.4" width="1.2" height="0.6" />
        <rect class="barcode" x="2.4" y="0.6" width="0.2" height="1.3" />
        <rect class="barcode" x="2.8" y="0.6" width="0.35" height="1.3" />
        <rect class="barcode" x="3.3" y="0.6" width="0.15" height="1.3" />
        <rect class="barcode" x="3.6" y="0.6" width="0.3" height="1.3" />
        <rect class="brow47" x="4.4" y="1.4" width="2.2" height="0.5" />
        <rect class="brow47" x="9.4" y="1.4" width="2.2" height="0.5" />
      </g>
      <rect class="arm arm-l" x="0" y="3" width="2" height="2" />
      <rect class="arm arm-r" x="14" y="3" width="2" height="2" />
      <g class="eyes-open"><rect x="5" y="2" width="1" height="2" /><rect x="10" y="2" width="1" height="2" /></g>
      <g class="eyes-closed"><rect x="4.5" y="3" width="2" height="0.6" /><rect x="9.5" y="3" width="2" height="0.6" /></g>
      <g class="hat hard">
        <rect class="hat-shell" x="4" y="-4" width="8" height="1" />
        <rect class="hat-shell" x="3" y="-3" width="10" height="2" />
        <rect class="hat-ridge" x="7.5" y="-4" width="1" height="3" />
        <rect class="hat-shine" x="4" y="-3" width="1" height="1" />
        <rect class="hat-brim" x="1" y="-1" width="14" height="1" />
      </g>
      <g class="hat miner">
        <polygon class="beam" points="13.4,-2.6 23,-5.5 23,1.2 13.4,-1.6" />
        <rect class="hat-shell" x="4" y="-4" width="8" height="1" />
        <rect class="hat-shell" x="3" y="-3" width="10" height="2" />
        <rect class="hat-ridge" x="7.5" y="-4" width="1" height="3" />
        <rect class="hat-brim" x="1" y="-1" width="14" height="1" />
        <rect class="lamp-base" x="11.2" y="-2.9" width="1.8" height="1.6" />
        <rect class="lamp" x="12.6" y="-2.7" width="0.9" height="1.2" />
      </g>
      <g class="hat propeller">
        <rect class="pc-red" x="5" y="-2.6" width="1" height="0.6" />
        <rect class="pc-yellow" x="6" y="-2.6" width="2" height="0.6" />
        <rect class="pc-blue" x="8" y="-2.6" width="2" height="0.6" />
        <rect class="pc-green" x="10" y="-2.6" width="1" height="0.6" />
        <rect class="pc-red" x="4" y="-2" width="2" height="2" />
        <rect class="pc-yellow" x="6" y="-2" width="2" height="2" />
        <rect class="pc-blue" x="8" y="-2" width="2" height="2" />
        <rect class="pc-green" x="10" y="-2" width="2" height="2" />
        <rect class="pc-visor" x="11" y="-0.6" width="3.5" height="0.6" />
        <rect class="pc-stem" x="7.75" y="-3.6" width="0.5" height="1" />
        <g class="prop">
          <rect class="pc-red" x="4.5" y="-4.1" width="3.5" height="0.6" />
          <rect class="pc-blue" x="8" y="-4.1" width="3.5" height="0.6" />
          <rect class="pc-hub" x="7.55" y="-4.25" width="0.9" height="0.9" />
        </g>
      </g>
    </svg>
  </div></div>
  <div class="shadow"></div>`;

function makeClaude(classes) {
  const c = document.createElement('div');
  c.className = `claude ${classes}`;
  c.innerHTML = SPRITE;
  return c;
}

// The "what it shows" list, each with a little Claude in that state.
const STATES = [
  ['working', 'Working', 'Walks around while Claude Code works, with a "Working…" bubble.'],
  ['waiting', 'Waiting for you', 'Bounces and waves when Claude Code needs your permission or an answer.'],
  ['done', 'Done', 'Hops and says so. It settles down once you go back to Claude Code.'],
  ['nocredit', 'Out of credits', 'Turns grey and deflates when you hit a usage or billing limit.'],
  ['resting', 'Idle', 'Sits down and snoozes until there is work again.'],
];
const stateList = document.getElementById('state-list');
for (const [id, title, text] of STATES) {
  const li = document.createElement('li');
  const mini = document.createElement('div');
  mini.className = 'mini';
  mini.appendChild(makeClaude(id));
  li.appendChild(mini);
  li.insertAdjacentHTML('beforeend', `<div><h3>${title}</h3><p>${text}</p></div>`);
  stateList.appendChild(li);
}

// ---------- Agent 47 ----------
const DUCK_SVG = `<svg viewBox="0 0 12 10" width="36" height="30" shape-rendering="crispEdges" aria-hidden="true">
  <rect class="d-body" x="1" y="5" width="9" height="4" />
  <rect class="d-body" x="0" y="6" width="2" height="2" />
  <rect class="d-body" x="5" y="1" width="4" height="4" />
  <rect class="d-beak" x="9" y="3" width="2.5" height="1.2" />
  <rect class="d-eye" x="7" y="2" width="0.9" height="0.9" />
  <rect class="d-led" x="3" y="4.2" width="1" height="0.8" />
</svg>`;

const POSES = {
  working: 'hat-agent47 working',
  sneak: 'hat-agent47 working walking',
  resting: 'hat-agent47 resting',
};
document.querySelectorAll('.portrait').forEach((p) => {
  const pose = p.dataset.pose;
  if (pose === 'duck') {
    const duck = document.createElement('div');
    duck.className = 'duck';
    duck.innerHTML = DUCK_SVG;
    p.appendChild(duck);
  } else {
    p.appendChild(makeClaude(POSES[pose]));
  }
});

// Scroll into his section and the whole page goes red; scroll on and it fades back.
const agentSection = document.getElementById('agent');
if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    ([entry]) => document.body.classList.toggle('agent-mode', entry.isIntersecting),
    { rootMargin: '-35% 0px -35% 0px' }
  ).observe(agentSection);
}

// ---------- the live demo on the hero's taskbar ----------
const WIDTH = 96;
const BUBBLES = {
  working: 'Working<span class="dots"><span>.</span><span>.</span><span>.</span></span>',
  waiting: 'Needs you!',
  done: 'Done! ✓',
  nocredit: 'Out of credits',
};
const BUBBLES_47 = {
  working: 'On a contract<span class="dots"><span>.</span><span>.</span><span>.</span></span>',
  waiting: 'Awaiting orders.',
  done: 'Mission accomplished.',
  nocredit: 'Contract terminated.',
};

const stage = document.getElementById('stage');
const demo = makeClaude('working');
stage.appendChild(demo);
const sprite = demo.querySelector('.sprite');
const bubble = demo.querySelector('.bubble');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = 'working';
let hat = 'none';
const walker = { x: Math.max(0, stage.clientWidth * 0.3), dir: 1, target: null, pauseUntil: 0 };

function renderBubble() {
  const html = (hat === 'agent47' ? BUBBLES_47 : BUBBLES)[state] || '';
  bubble.innerHTML = html;
  bubble.classList.toggle('show', !!html);
}

function setState(next) {
  demo.classList.remove(state);
  state = next;
  demo.classList.add(state);
  walker.target = null;
  walker.pauseUntil = 0;
  if (state === 'done') {
    demo.classList.add('celebrate');
    walker.pauseUntil = performance.now() + 1600;
    setTimeout(() => demo.classList.remove('celebrate'), 1600);
  }
  renderBubble();
}

function setHat(next) {
  for (const h of ['hard', 'propeller', 'miner', 'agent47']) demo.classList.toggle(`hat-${h}`, h === next);
  demo.classList.toggle('hat-on', ['hard', 'propeller', 'miner'].includes(next));
  if (['hard', 'propeller', 'miner'].includes(next)) {
    demo.classList.remove('hat-arrive');
    void demo.offsetWidth;
    demo.classList.add('hat-arrive');
  }
  hat = next;
  renderBubble();
}

document.getElementById('state-picker').addEventListener('change', (e) => setState(e.target.value));
document.getElementById('hat-picker').addEventListener('change', (e) => setHat(e.target.value));

function speed() {
  if (reduceMotion) return 0;
  if (state === 'working') return hat === 'agent47' ? 47 : 70;
  if (state === 'done') return 30;
  return 0;
}

let last = performance.now();
function tick(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  const max = Math.max(0, stage.clientWidth - WIDTH);
  walker.x = Math.min(walker.x, max);
  let moving = false;
  const v = speed();
  if (v > 0 && t >= walker.pauseUntil) {
    if (walker.target === null) {
      walker.target = state === 'working' ? Math.random() * max : Math.max(0, Math.min(max, walker.x - 160 + Math.random() * 320));
    }
    const delta = walker.target - walker.x;
    if (Math.abs(delta) < 2) {
      walker.target = null;
      walker.pauseUntil = t + (state === 'working' ? 400 + Math.random() * 1600 : 1500 + Math.random() * 3000);
    } else {
      walker.dir = Math.sign(delta);
      walker.x += walker.dir * Math.min(Math.abs(delta), v * dt);
      moving = true;
    }
  }
  demo.classList.toggle('walking', moving);
  sprite.classList.toggle('flip', walker.dir < 0);
  demo.style.left = `${Math.round(walker.x)}px`;
  requestAnimationFrame(tick);
}

setState('working');
requestAnimationFrame(tick);
