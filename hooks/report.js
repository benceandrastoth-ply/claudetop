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

// Look at the tail of the transcript for an API error about credits / limits.
function transcriptSaysNoCredit(transcriptPath) {
  if (!transcriptPath) return false;
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
      if (entry.type === 'user') return false; // a newer user turn came after
      if (entry.isApiErrorMessage || entry.error) {
        return CREDIT_RE.test(JSON.stringify(entry));
      }
    }
  } catch {}
  return false;
}

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
    case 'SubagentStart':
      return 'working';
    case 'Notification':
      // Idle reminders aren't "needs you" moments; permission prompts are.
      return input.notification_type === 'idle_prompt' ? null : 'waiting';
    case 'Stop':
      return transcriptSaysNoCredit(input.transcript_path) ? 'nocredit' : 'done';
    case 'StopFailure':
      return CREDIT_RE.test(JSON.stringify(input)) ? 'nocredit' : 'error';
    case 'SessionStart':
      return 'idle';
    default:
      return null;
  }
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
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

try { main(); } catch {}
process.exit(0);
