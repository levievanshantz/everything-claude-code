#!/usr/bin/env node
/**
 * Cost Tracker Hook
 *
 * Appends lightweight session usage metrics to ~/.claude/metrics/costs.jsonl.
 *
 * Since Claude Code's Stop hook stdin does not provide token usage data,
 * this script reads the latest session file from ~/.claude/sessions/ to
 * extract message counts, tool usage, and duration — then estimates cost
 * from a per-message heuristic.
 */

'use strict';

const path = require('path');
const {
  ensureDir,
  appendFile,
  readFile,
  findFiles,
  getClaudeDir,
  getSessionsDir,
} = require('../lib/utils');

const MAX_STDIN = 1024 * 1024;
let raw = '';

/**
 * Find the most recently modified session .tmp file.
 */
function getLatestSessionFile() {
  const sessionsDir = getSessionsDir();
  const files = findFiles(sessionsDir, '*.tmp', { maxAge: 1 }); // within last day
  return files.length > 0 ? files[0].path : null;
}

/**
 * Parse a session file and extract metrics.
 */
function parseSessionFile(filePath) {
  const content = readFile(filePath);
  if (!content) return null;

  const result = {
    session_id: null,
    project: null,
    started: null,
    last_updated: null,
    message_count: 0,
    tool_count: 0,
    tools_used: [],
    files_modified_count: 0,
    duration_minutes: 0,
  };

  // Extract session_id from filename: e.g. 2026-03-27-Users-session.tmp
  const basename = path.basename(filePath, '.tmp');
  result.session_id = basename.replace(/-session$/, '');

  // Parse header fields
  const projectMatch = content.match(/\*\*Project:\*\*\s*(.+)/);
  if (projectMatch) result.project = projectMatch[1].trim();

  const startedMatch = content.match(/\*\*Started:\*\*\s*(\d{1,2}:\d{2})/);
  const updatedMatch = content.match(/\*\*Last Updated:\*\*\s*(\d{1,2}:\d{2})/);
  const dateMatch = content.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);

  if (startedMatch) result.started = startedMatch[1];
  if (updatedMatch) result.last_updated = updatedMatch[1];

  // Calculate duration from Started and Last Updated
  if (dateMatch && startedMatch && updatedMatch) {
    try {
      const dateStr = dateMatch[1];
      const startTime = new Date(`${dateStr}T${startedMatch[1]}:00`);
      const endTime = new Date(`${dateStr}T${updatedMatch[1]}:00`);
      if (!isNaN(startTime) && !isNaN(endTime) && endTime >= startTime) {
        result.duration_minutes = Math.round((endTime - startTime) / 60000);
      }
    } catch {
      // Ignore date parsing errors
    }
  }

  // Parse total user messages from Stats section
  const msgMatch = content.match(/Total user messages:\s*(\d+)/);
  if (msgMatch) result.message_count = parseInt(msgMatch[1], 10);

  // Parse tools used
  const toolsMatch = content.match(/### Tools Used\n(.+)/);
  if (toolsMatch) {
    const tools = toolsMatch[1].split(',').map(t => t.trim()).filter(Boolean);
    result.tools_used = tools;
    result.tool_count = tools.length;
  }

  // Count files modified
  const filesSection = content.match(/### Files Modified\n([\s\S]*?)(?=\n###|\n<!-- |$)/);
  if (filesSection) {
    const fileLines = filesSection[1].split('\n').filter(l => l.startsWith('- '));
    result.files_modified_count = fileLines.length;
  }

  return result;
}

/**
 * Estimate cost based on message count and model.
 *
 * Rough heuristics based on typical Claude Code usage patterns:
 * - Each user message triggers ~1500 input tokens and ~2000 output tokens on average
 * - These are rough estimates; actual usage varies significantly
 */
function estimateCost(messageCount, model) {
  const normalized = String(model || '').toLowerCase();

  // Per-message token estimates (input + output)
  const avgInputTokensPerMsg = 1500;
  const avgOutputTokensPerMsg = 2000;

  // Per-1M-token rates
  let inputRate = 3.0;   // Sonnet default
  let outputRate = 15.0;

  if (normalized.includes('haiku')) {
    inputRate = 0.8;
    outputRate = 4.0;
  } else if (normalized.includes('opus')) {
    inputRate = 15.0;
    outputRate = 75.0;
  }

  const totalInput = messageCount * avgInputTokensPerMsg;
  const totalOutput = messageCount * avgOutputTokensPerMsg;

  const cost = (totalInput / 1_000_000) * inputRate + (totalOutput / 1_000_000) * outputRate;
  return Math.round(cost * 1e6) / 1e6;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
  }
});

process.stdin.on('end', () => {
  try {
    // Try to get model from stdin or environment
    let model = process.env.CLAUDE_MODEL || 'sonnet';
    try {
      const input = raw.trim() ? JSON.parse(raw) : {};
      if (input.model) model = String(input.model);
    } catch {
      // Use default model
    }

    // Find and parse the latest session file
    const sessionFilePath = getLatestSessionFile();
    if (!sessionFilePath) {
      // No session file found — write a minimal entry noting the gap
      const metricsDir = path.join(getClaudeDir(), 'metrics');
      ensureDir(metricsDir);
      const row = {
        timestamp: new Date().toISOString(),
        session_id: 'unknown',
        model,
        message_count: 0,
        tool_count: 0,
        files_modified_count: 0,
        duration_minutes: 0,
        estimated_cost_usd: 0,
        source: 'no-session-file',
      };
      appendFile(path.join(metricsDir, 'costs.jsonl'), `${JSON.stringify(row)}\n`);
      process.stdout.write(raw);
      return;
    }

    const metrics = parseSessionFile(sessionFilePath);

    const metricsDir = path.join(getClaudeDir(), 'metrics');
    ensureDir(metricsDir);

    const row = {
      timestamp: new Date().toISOString(),
      session_id: metrics ? metrics.session_id : path.basename(sessionFilePath, '.tmp'),
      model,
      project: metrics ? metrics.project : 'unknown',
      message_count: metrics ? metrics.message_count : 0,
      tool_count: metrics ? metrics.tool_count : 0,
      tools_used: metrics ? metrics.tools_used : [],
      files_modified_count: metrics ? metrics.files_modified_count : 0,
      duration_minutes: metrics ? metrics.duration_minutes : 0,
      estimated_cost_usd: estimateCost(metrics ? metrics.message_count : 0, model),
      source: 'session-file',
      session_file: sessionFilePath,
    };

    appendFile(path.join(metricsDir, 'costs.jsonl'), `${JSON.stringify(row)}\n`);
  } catch {
    // Keep hook non-blocking.
  }

  process.stdout.write(raw);
});
