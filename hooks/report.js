#!/usr/bin/env node
// Claude Code hook: records what a session is doing so claudetop can show it.
// Reads the hook payload from stdin and writes ~/.claude/claudetop/sessions/<id>.json.
// Never prints anything and always exits 0 so it can't disturb Claude Code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(os.homedir(), '.claude', 'claudetop', 'sessions');
const CREDIT_RE = /credit balance|billing|usage limit|limit reached|rate.?limit|out of (extra )?usage|quota/i;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// When does the limit lift? Claude Code says so in the error: "...limit reached|1748278800"
// (seconds), "resets 3pm", "reset at 3:30pm (Europe/Budapest)", "resets Oct 27, 9am" or
// "resets in 2h 30m". Returns ms since the epoch, or null.
function resetTime(text, now = Date.now()) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = text.match(/resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (rel && (rel[1] || rel[2])) return now + ((Number(rel[1]) || 0) * 60 + (Number(rel[2]) || 0)) * 60 * 1000;
  const at = text.match(/resets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!at) return null;
  let hour = Number(at[3]) % (at[5] ? 12 : 24);
  if (at[5] && at[5].toLowerCase() === 'pm') hour += 12;
  const d = new Date(now);
  d.setHours(hour, Number(at[4]) || 0, 0, 0);
  const month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : -1;
  if (month >= 0) {
    d.setMonth(month, Number(at[2]));
    if (d.getTime() <= now - 24 * 60 * 60 * 1000) d.setFullYear(d.getFullYear() + 1);
  } else if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

// Look at the tail of the transcript for an API error about credits / limits. Returns the
// error's text, or null.
function transcriptNoCreditError(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n').slice(-6);
    for (const line of lines.reverse()) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'user') return null; // a newer user turn came after
      if (entry.isApiErrorMessage || entry.error) {
        const text = JSON.stringify(entry);
        return CREDIT_RE.test(text) ? text : null;
      }
    }
  } catch {}
  return null;
}

// The text of the limit error behind a "nocredit", if there is one (for its reset time).
let creditError = null;

// The processes this hook runs inside (hook -> shell -> claude -> shell -> terminal ...),
// as "pid:name" strings. claudetop matches the foreground window against these to tell
// whether you're looking at this session. Costs ~0.5s, so it runs once per session.
function processChain() {
  if (process.platform === 'linux') return linuxProcessChain();
  if (process.platform !== 'win32') return [];
  const script =
    '$m=@{}; Get-CimInstance Win32_Process | ForEach-Object { $m[[int]$_.ProcessId]=$_ };' +
    `$p=${process.pid}; $out=@();` +
    'for($i=0; $i -lt 25 -and $m.ContainsKey($p); $i++){ $x=$m[$p]; $out+="$($x.ProcessId):$($x.Name)";' +
    ' $p=[int]$x.ParentProcessId; if($p -eq 0){break} }; $out -join ","';
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    return (r.stdout || '').trim().split(',').filter(Boolean);
  } catch {
    return [];
  }
}

// Linux: walk /proc/<pid>/stat up to init. Cheap enough to do directly.
function linuxProcessChain() {
  const chain = [];
  let pid = process.pid;
  for (let i = 0; i < 25 && pid > 1; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) state ppid ...": comm may contain spaces, so split after the last ")".
      const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      chain.push(`${pid}:${name}`);
      pid = ppid;
    } catch {
      break;
    }
  }
  return chain;
}

function stateFor(input) {
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'SubagentStart':
      return 'working';
    case 'Notification':
      // Idle reminders aren't "needs you" moments; permission prompts are.
      return input.notification_type === 'idle_prompt' ? null : 'waiting';
    case 'Stop':
      creditError = transcriptNoCreditError(input.transcript_path);
      return creditError ? 'nocredit' : 'done';
    case 'StopFailure':
      creditError = JSON.stringify(input);
      return CREDIT_RE.test(creditError) ? 'nocredit' : 'error';
    case 'SessionStart':
      return 'idle';
    default:
      return null;
  }
}

// A command that runs a test suite.
const TEST_RE = /\b(test|tests|jest|vitest|pytest|mocha|ava|tap|rspec|phpunit|ctest|unittest)\b|\bgo test\b|\bcargo test\b|\bnpm t\b/i;

// Per-task bookkeeping for the little Claude's extras: when the task started (long-task timer),
// how many permission prompts it needed (Agent 47's rating), failed tool calls in a row (rage
// quit) and whether the last test run failed (47's mechanic disguise).
function taskStats(input, previous, now) {
  const event = input.hook_event_name;
  const newTask = event === 'UserPromptSubmit';
  const stats = {
    taskStart: newTask ? now : previous.taskStart || now,
    prompts: newTask ? 0 : previous.prompts || 0,
    errorStreak: newTask ? 0 : previous.errorStreak || 0,
    testsFailed: newTask ? false : !!previous.testsFailed,
  };
  if (previous.rageAt && !newTask) stats.rageAt = previous.rageAt;
  if (event === 'Notification' && input.notification_type === 'permission_prompt') stats.prompts++;
  const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
  const isTest = /^(Bash|PowerShell)$/.test(input.tool_name || '') && TEST_RE.test(command);
  if (event === 'PostToolUse') {
    stats.errorStreak = 0;
    if (isTest) stats.testsFailed = false;
  }
  if (event === 'PostToolUseFailure' && !input.is_interrupt) {
    stats.errorStreak++;
    if (stats.errorStreak % 3 === 0) stats.rageAt = now; // three in a row: flip the table
    if (isTest) stats.testsFailed = true;
  }
  return stats;
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin().replace(/^﻿/, '').trim() || '{}');
  } catch {
    return;
  }
  const id = String(input.session_id || 'unknown').replace(/[^\w-]/g, '');
  const file = path.join(DIR, id + '.json');
  fs.mkdirSync(DIR, { recursive: true });

  if (input.hook_event_name === 'SessionEnd') {
    fs.rmSync(file, { force: true });
    return;
  }

  const state = stateFor(input);
  if (!state) return;

  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  const record = {
    state,
    event: input.hook_event_name,
    cwd: input.cwd || '',
    tool: input.tool_name || '',
    at: Date.now(),
    chain: previous.chain && previous.chain.length ? previous.chain : processChain(),
  };
  if (state === 'nocredit') {
    const resetAt = resetTime(creditError || '');
    if (resetAt) record.resetAt = resetAt;
  }
  Object.assign(record, taskStats(input, previous, record.at));
  writeRecord(file, JSON.stringify(record));
}

// Write via a temp file so claudetop never reads half a record. On Windows the rename fails
// while claudetop has the file open for reading, so retry for a moment, then write in place.
function writeRecord(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(file, text);
}

// (claudetop's own exe runs this file with require(), so a test switch, not require.main.)
if (!process.env.CLAUDETOP_HOOK_TEST) {
  try { main(); } catch (e) { if (process.env.CLAUDETOP_DEBUG) console.error(e); }
  process.exit(0);
}

module.exports = { resetTime };
