#!/usr/bin/env node
/**
 * pre-bash-decision-reminder.js — fires once per session on the first
 * `git commit` to remind Claude about the inline `<decision>` capture rule.
 *
 * Only fires once per session_id (state file at
 * ~/.claude/session-data/.commit-reminder-state.json). Skips `--amend`
 * because amends do not add new decisions to the corpus.
 *
 * Wraps via scripts/hooks/run-with-flags.js. Always exits 0 — never blocks
 * commits. Pass-through stdout (PreToolUse contract).
 */

const fs = require('fs');
const path = require('path');
const { getSessionsDir, ensureDir, readFile, writeFile } = require('../lib/utils');

const STATE_FILENAME = '.commit-reminder-state.json';
const REMINDER = [
  '[DecisionTagReminder] First git commit of this session detected.',
  'If this commit reflects a *material, made, specific* decision, emit a',
  '<decision impact="..." confidence="..." layer="..."> tag inline in your',
  'next response — the drain captures it. Skip if the commit is mechanical',
  '(typo fix, dep bump, formatting). Reminder fires once per session.',
].join('\n');

function loadState(statePath) {
  try {
    const raw = readFile(statePath);
    if (!raw) return { sessions: {} };
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function evaluate(rawInput) {
  try {
    const input = JSON.parse(rawInput || '{}');
    const command = input.tool_input?.command || '';

    if (!/git\s+commit\b/.test(command)) {
      return { output: rawInput, exitCode: 0 };
    }
    if (/--amend\b/.test(command)) {
      return { output: rawInput, exitCode: 0 };
    }

    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'unknown-session';
    const stateDir = getSessionsDir();
    const statePath = path.join(stateDir, STATE_FILENAME);
    ensureDir(stateDir);

    const state = loadState(statePath);
    if (!state.sessions) state.sessions = {};

    if (state.sessions[sessionId]?.first_commit_fired) {
      return { output: rawInput, exitCode: 0 };
    }

    state.sessions[sessionId] = {
      first_commit_fired: true,
      fired_at: new Date().toISOString(),
    };

    // GC: drop session entries older than 7 days so the file doesn't grow.
    const cutoff = Date.now() - 7 * 86400 * 1000;
    for (const [sid, meta] of Object.entries(state.sessions)) {
      const t = meta?.fired_at ? Date.parse(meta.fired_at) : 0;
      if (t && t < cutoff) delete state.sessions[sid];
    }

    writeFile(statePath, JSON.stringify(state, null, 2));
    console.error(REMINDER);

    return { output: rawInput, exitCode: 0 };
  } catch {
    return { output: rawInput || '', exitCode: 0 };
  }
}

function run(rawInput) {
  return evaluate(rawInput);
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    const result = evaluate(data);
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  });
}

module.exports = { run, evaluate };
