// Loaded right after the app's renderer.js on the website's playground. It shares the renderer's
// global scope, so it can start the scenes that normally take minutes, a calendar date or a real
// mouse to happen. play.js (in the parent page) calls these.
window.__play = {
  ready: () => typeof entered !== 'undefined' && entered,
  busy: () => puppet || !!scene || panicking,

  pet: () => pet(),
  annoyed: () => annoyed(),
  fling() {
    if (puppet || !entered) return;
    const { min, max } = walkRange();
    const dir = walker.x - min < (max - min) / 2 ? 1 : -1; // towards the open side
    fling(dir * (1300 + Math.random() * 500), 900 + Math.random() * 300);
  },

  // Resting moments come every few minutes, picked at random. Pick one now. Returns whether it
  // started (not while Claude is busy with something else, or not resting).
  idle(move) {
    const moves = ['newspaper', 'juggle', 'snore'];
    if (config.hat === 'cowboy') moves.push('lasso', 'lasso');
    const i = moves.indexOf(move);
    if (i < 0 || puppet) return false;
    const real = Math.random;
    const queue = [0.5, (i + 0.5) / moves.length]; // the next wait, then the move
    Math.random = () => (queue.length ? queue.shift() : real());
    try {
      nextIdle = 0;
      idleMoment();
    } finally {
      Math.random = real;
    }
    return puppet; // the moment has Claude now
  },

  // Pretend it's another day or time (seasons, night owl, birthdays). null = now.
  setDate(iso) {
    if (iso) debug.date = iso;
    else delete debug.date;
    nextYawn = 1; // yawn and nag right away instead of in a few minutes
    nextNag = 1;
    nextWish = 0;
    lastActive = Date.now();
    applySeason();
  },

  // Agent 47's outfits: 'chef' | 'mechanic' | 'flamingo', or null to let the job decide.
  disguise(d) {
    if (d) debug.disguise = d;
    else delete debug.disguise;
    updateDoing();
  },

  // Crying has a cooldown of a minute; on the playground you may want it again sooner.
  allowCrying() {
    lastCry = -Infinity;
  },
};
