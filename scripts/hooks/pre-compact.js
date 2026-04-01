#!/usr/bin/env node
/**
 * PreCompact Hook - Save state before context compaction
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs before Claude compacts context, giving you a chance to
 * preserve important state that might get lost in summarization.
 *
 * For the architect instance (/Users or /Users/<user>), writes a rich
 * context ledger to ~/.claude/sessions/architect-ledger.md extracted
 * from the session transcript.
 */

const fs = require('fs');
const path = require('path');
const {
  getSessionsDir,
  getHomeDir,
  getDateTimeString,
  getTimeString,
  findFiles,
  ensureDir,
  readFile,
  writeFile,
  appendFile,
  stripAnsi,
  log,
  output
} = require('../lib/utils');

const ARCHITECT_PATHS = ['/Users/levishantz', '/Users'];
const MAX_LEDGER_BYTES = 10 * 1024; // 10KB cap

const DECISION_PATTERNS = [
  /\bdecided\b/i,
  /\bconfirmed\b/i,
  /\bapproved\b/i,
  /\brejected\b/i,
  /\bdeferred\b/i,
  /\bshipping\b/i,
  /\bwon't\b/i,
  /\bdon't need\b/i
];

/**
 * Check if CWD is the architect instance
 */
function isArchitectInstance() {
  const cwd = process.cwd();
  return ARCHITECT_PATHS.includes(cwd);
}

/**
 * Parse transcript JSONL and extract architect context
 */
function extractArchitectContext(transcriptPath) {
  const content = readFile(transcriptPath);
  if (!content) return null;

  const lines = content.split('\n').filter(l => l.trim());
  const userMessages = [];
  const assistantMessages = [];
  const filesModified = new Set();
  let parseErrors = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Collect user messages
      if (entry.type === 'user' || entry.role === 'user' || entry.message?.role === 'user') {
        const rawContent = entry.message?.content ?? entry.content;
        const text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.map(c => (c && c.text) || '').join(' ')
            : '';
        const cleaned = stripAnsi(text).trim();
        if (cleaned) {
          userMessages.push(cleaned);
        }
      }

      // Collect assistant messages for decision extraction
      if (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant') {
        const rawContent = entry.message?.content ?? entry.content;
        const text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ')
            : '';
        const cleaned = stripAnsi(text).trim();
        if (cleaned) {
          assistantMessages.push(cleaned);
        }
      }

      // Collect modified files from tool_use entries
      if (entry.type === 'tool_use' || entry.tool_name) {
        const toolName = entry.tool_name || entry.name || '';
        const filePath = entry.tool_input?.file_path || entry.input?.file_path || '';
        if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
          filesModified.add(filePath);
        }
      }

      // Extract tool uses from assistant message content blocks
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name || '';
            const filePath = block.input?.file_path || '';
            if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
              filesModified.add(filePath);
            }
          }
        }
      }
    } catch {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    log(`[PreCompact] Skipped ${parseErrors}/${lines.length} unparseable transcript lines`);
  }

  // Extract decisions from both user and assistant messages
  const allMessages = [...userMessages, ...assistantMessages];
  const decisions = [];
  for (const msg of allMessages) {
    // Split into sentences and check each
    const sentences = msg.split(/[.!?\n]+/).filter(s => s.trim().length > 10);
    for (const sentence of sentences) {
      if (DECISION_PATTERNS.some(p => p.test(sentence))) {
        const trimmed = sentence.trim().slice(0, 200);
        if (!decisions.includes(trimmed)) {
          decisions.push(trimmed);
        }
      }
    }
  }

  // Extract active topics from recent user messages (last 20)
  const recentUserMsgs = userMessages.slice(-20);
  const topics = new Set();
  for (const msg of recentUserMsgs) {
    // First line of each user message is usually the topic
    const firstLine = msg.split('\n')[0].trim().slice(0, 150);
    if (firstLine.length > 5) {
      topics.add(firstLine);
    }
  }

  // Extract handoffs/delegations
  const handoffPatterns = [
    /\bhandoff\b/i, /\bdelegate[ds]?\b/i, /\bhand(?:ing)?\s+off\b/i,
    /\bsubagent\b/i, /\binstance\b/i, /\blaunch(?:ed|ing)?\s+(?:an?\s+)?agent/i,
    /\bspawn(?:ed|ing)?\b/i, /\bassign(?:ed|ing)?\s+to\b/i
  ];
  const handoffs = [];
  for (const msg of allMessages) {
    const sentences = msg.split(/[.!?\n]+/).filter(s => s.trim().length > 10);
    for (const sentence of sentences) {
      if (handoffPatterns.some(p => p.test(sentence))) {
        const trimmed = sentence.trim().slice(0, 200);
        if (!handoffs.includes(trimmed)) {
          handoffs.push(trimmed);
        }
      }
    }
  }

  return {
    recentUserMessages: recentUserMsgs,
    decisions: decisions.slice(0, 30),
    topics: Array.from(topics).slice(0, 15),
    handoffs: handoffs.slice(0, 15),
    filesModified: Array.from(filesModified)
  };
}

/**
 * Build the architect ledger markdown content
 */
function buildLedgerMarkdown(ctx) {
  const timestamp = getDateTimeString();
  const parts = [];

  parts.push(`# Architect Context Ledger`);
  parts.push(`_Last updated: ${timestamp}_\n`);

  // Active Context - last 20 user messages
  parts.push(`## Active Context`);
  if (ctx.recentUserMessages.length > 0) {
    for (const msg of ctx.recentUserMessages) {
      // Indent multi-line messages, cap each at 500 chars
      const capped = msg.slice(0, 500);
      parts.push(`- ${capped.replace(/\n/g, '\n  ')}`);
    }
  } else {
    parts.push('_No user messages captured._');
  }
  parts.push('');

  // Decisions
  parts.push(`## Decisions This Session`);
  if (ctx.decisions.length > 0) {
    for (const d of ctx.decisions) {
      parts.push(`- ${d}`);
    }
  } else {
    parts.push('_No decisions detected._');
  }
  parts.push('');

  // Open Threads (topics + handoffs)
  parts.push(`## Open Threads`);
  if (ctx.topics.length > 0) {
    parts.push('**Active topics:**');
    for (const t of ctx.topics) {
      parts.push(`- ${t}`);
    }
  }
  if (ctx.handoffs.length > 0) {
    parts.push('**Handoffs/delegations:**');
    for (const h of ctx.handoffs) {
      parts.push(`- ${h}`);
    }
  }
  if (ctx.topics.length === 0 && ctx.handoffs.length === 0) {
    parts.push('_No open threads detected._');
  }
  parts.push('');

  // Files Modified
  parts.push(`## Files Modified`);
  if (ctx.filesModified.length > 0) {
    for (const f of ctx.filesModified) {
      parts.push(`- ${f}`);
    }
  } else {
    parts.push('_No files modified._');
  }

  let result = parts.join('\n');

  // Enforce 10KB cap
  if (Buffer.byteLength(result, 'utf8') > MAX_LEDGER_BYTES) {
    // Truncate from the end, keeping the header
    while (Buffer.byteLength(result, 'utf8') > MAX_LEDGER_BYTES - 50) {
      result = result.slice(0, result.lastIndexOf('\n'));
    }
    result += '\n\n_[Truncated to 10KB limit]_';
  }

  return result;
}

/**
 * Write architect ledger from transcript
 */
function writeArchitectLedger(rawInput) {
  try {
    let transcriptPath = null;
    try {
      const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : (rawInput || {});
      transcriptPath = input.transcript_path;
    } catch {
      // No transcript path available
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('[PreCompact] No transcript_path available for architect ledger');
      return;
    }

    const ctx = extractArchitectContext(transcriptPath);
    if (!ctx) {
      log('[PreCompact] Could not extract context from transcript');
      return;
    }

    const ledgerPath = path.join(getHomeDir(), '.claude', 'sessions', 'architect-ledger.md');
    ensureDir(path.dirname(ledgerPath));
    const markdown = buildLedgerMarkdown(ctx);
    writeFile(ledgerPath, markdown);
    log(`[PreCompact] Architect ledger written (${Buffer.byteLength(markdown, 'utf8')} bytes) to ${ledgerPath}`);
  } catch (err) {
    log(`[PreCompact] Architect ledger failed (non-fatal): ${err.message}`);
  }
}

/**
 * Core pre-compact logic (runs for all instances)
 */
function corePreCompact() {
  const sessionsDir = getSessionsDir();
  const compactionLog = path.join(sessionsDir, 'compaction-log.txt');

  ensureDir(sessionsDir);

  // Log compaction event with timestamp
  const timestamp = getDateTimeString();
  appendFile(compactionLog, `[${timestamp}] Context compaction triggered\n`);

  // If there's an active session file, note the compaction
  const sessions = findFiles(sessionsDir, '*-session.tmp');

  if (sessions.length > 0) {
    const activeSession = sessions[0].path;
    const timeStr = getTimeString();
    appendFile(activeSession, `\n---\n**[Compaction occurred at ${timeStr}]** - Context was summarized\n`);
  }

  log('[PreCompact] State saved before compaction');
}

/**
 * Main entry point - exported as run() for run-with-flags.js wrapper
 */
function run(rawInput) {
  try {
    corePreCompact();

    // Architect-specific: write rich context ledger
    if (isArchitectInstance()) {
      writeArchitectLedger(rawInput);
    }
  } catch (err) {
    log(`[PreCompact] Error: ${err.message}`);
  }
  return { exitCode: 0 };
}

module.exports = { run };

// Legacy direct-execution support
if (require.main === module) {
  // Read stdin for direct execution
  let stdinData = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (stdinData.length < 1024 * 1024) {
      stdinData += chunk;
    }
  });
  process.stdin.on('end', () => {
    run(stdinData);
    process.exit(0);
  });
  process.stdin.on('error', () => {
    run('');
    process.exit(0);
  });
  // Timeout fallback
  setTimeout(() => {
    run(stdinData);
    process.exit(0);
  }, 3000);
}
