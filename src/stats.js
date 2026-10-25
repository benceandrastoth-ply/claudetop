// Little numbers for the daily recap and the achievements. Stored next to the settings, never
// sent anywhere.

const fs = require('fs');

// id, name, description (null = hidden until unlocked), unlocked when check(totals) is true.
const ACHIEVEMENTS = [
  ['first-task', 'First contract', 'Claude Code finished its first task.', (t) => t.tasks >= 1],
  ['tasks-100', 'Centurion', 'A hundred finished tasks.', (t) => t.tasks >= 100],
  ['tasks-1000', 'Veteran', 'A thousand finished tasks.', (t) => t.tasks >= 1000],
  ['silent', 'No witnesses', 'A task finished without a single permission prompt.', (t) => t.silent >= 1],
  ['silent-25', 'Ghost', '25 tasks without a permission prompt.', (t) => t.silent >= 25],
  ['work-10h', 'Overtime', 'Ten hours of Claude Code at work.', (t) => t.workMs >= 10 * 3600 * 1000],
  ['marathon', 'Marathon', null, (t) => t.marathon >= 1],
  ['night', 'Night owl', null, (t) => t.night >= 1],
  ['tables-10', 'Furniture abuser', null, (t) => t.tables >= 10],
  ['cheater-5', "It's not what it looks like", null, (t) => t.cries >= 5],
  ['lockin', 'Locked in', null, (t) => t.lockins >= 1],
  ['panic-10', 'Cardio', null, (t) => t.panics >= 10],
  ['tv', 'Not now, TV', null, (t) => t.tvKicks >= 1],
  ['flamingo', 'Pink is the new black', null, (t) => t.flamingos >= 1],
  ['hitman', 'Suit up', null, (t) => t.hitman >= 1],
  ['fling', 'Frequent flyer', null, (t) => t.flings >= 1],
  ['fling-25', 'Claude is not a toy', null, (t) => t.flings >= 25],
];

function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function createStats(file) {
  let data = { days: {}, totals: {}, achievements: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {}
  let saveTimer = null;

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        // Keep the last 60 days.
        const keys = Object.keys(data.days).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete data.days[k];
        fs.writeFileSync(file, JSON.stringify(data));
      } catch {}
    }, 2000);
  }

  // Count something; returns the achievements this unlocked.
  function add(key, amount = 1) {
    const day = (data.days[today()] = data.days[today()] || {});
    day[key] = (day[key] || 0) + amount;
    data.totals[key] = (data.totals[key] || 0) + amount;
    if (key === 'tasks' && day.tasks > (data.totals.bestTasks || 0)) data.totals.bestTasks = day.tasks; // the record day
    const t = new Proxy(data.totals, { get: (o, k) => o[k] || 0 });
    const unlocked = [];
    for (const [id, name, description, check] of ACHIEVEMENTS) {
      if (data.achievements[id] || !check(t)) continue;
      data.achievements[id] = Date.now();
      unlocked.push({ id, name, description });
    }
    save();
    return unlocked;
  }

  function todayStats() {
    const d = data.days[today()] || {};
    return { tasks: d.tasks || 0, workMs: d.workMs || 0, silent: d.silent || 0 };
  }

  // For the menu: every achievement, hidden ones without their name until unlocked.
  function achievements() {
    return ACHIEVEMENTS.map(([id, name, description]) => ({
      id,
      name,
      description,
      unlocked: !!data.achievements[id],
    }));
  }

  // The most tasks finished in a single day.
  const record = () => data.totals.bestTasks || 0;

  return { add, todayStats, achievements, record };
}

// "2h 10m", "35m", "under a minute"
function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under a minute';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

module.exports = { createStats, duration };
