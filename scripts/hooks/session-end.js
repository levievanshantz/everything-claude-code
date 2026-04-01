#!/usr/bin/env node
/**
 * Stop Hook (Session End) - Persist learnings during active sessions
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs on Stop events (after each response). Extracts a meaningful summary
 * from the session transcript (via stdin JSON transcript_path) and updates a
 * session file for cross-session continuity.
 */

const path = require('path');
const fs = require('fs');
const {
  getSessionsDir,
  getClaudeDir,
  getHomeDir,
  getDateString,
  getTimeString,
  getSessionIdShort,
  getProjectName,
  ensureDir,
  readFile,
  writeFile,
  appendFile,
  runCommand,
  stripAnsi,
  log,
  output
} = require('../lib/utils');

const SUMMARY_START_MARKER = '<!-- ECC:SUMMARY:START -->';
const SUMMARY_END_MARKER = '<!-- ECC:SUMMARY:END -->';
const SESSION_SEPARATOR = '\n---\n';
const DELTA_OFFSETS_FILE = path.join(require('os').homedir(), '.claude', 'sessions', '.delta-watcher-offsets.json');

/**
 * Extract a meaningful summary from the session transcript.
 * Reads the JSONL transcript and pulls out key information:
 * - User messages (tasks requested)
 * - Tools used
 * - Files modified
 */
function extractSessionSummary(transcriptPath) {
  const content = readFile(transcriptPath);
  if (!content) return null;

  const lines = content.split('\n').filter(Boolean);
  const userMessages = [];
  const toolsUsed = new Set();
  const filesModified = new Set();
  let parseErrors = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Collect user messages (first 200 chars each)
      if (entry.type === 'user' || entry.role === 'user' || entry.message?.role === 'user') {
        // Support both direct content and nested message.content (Claude Code JSONL format)
        const rawContent = entry.message?.content ?? entry.content;
        const text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.map(c => (c && c.text) || '').join(' ')
            : '';
        const cleaned = stripAnsi(text).trim();
        if (cleaned) {
          userMessages.push(cleaned.slice(0, 200));
        }
      }

      // Collect tool names and modified files (direct tool_use entries)
      if (entry.type === 'tool_use' || entry.tool_name) {
        const toolName = entry.tool_name || entry.name || '';
        if (toolName) toolsUsed.add(toolName);

        const filePath = entry.tool_input?.file_path || entry.input?.file_path || '';
        if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
          filesModified.add(filePath);
        }
      }

      // Extract tool uses from assistant message content blocks (Claude Code JSONL format)
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name || '';
            if (toolName) toolsUsed.add(toolName);

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
    log(`[SessionEnd] Skipped ${parseErrors}/${lines.length} unparseable transcript lines`);
  }

  if (userMessages.length === 0) return null;

  return {
    userMessages: userMessages.slice(-10), // Last 10 user messages
    toolsUsed: Array.from(toolsUsed).slice(0, 20),
    filesModified: Array.from(filesModified).slice(0, 30),
    totalMessages: userMessages.length
  };
}

// Read hook input from stdin (Claude Code provides transcript_path via stdin JSON)
const MAX_STDIN = 1024 * 1024;
let stdinData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  if (stdinData.length < MAX_STDIN) {
    const remaining = MAX_STDIN - stdinData.length;
    stdinData += chunk.substring(0, remaining);
  }
});

process.stdin.on('end', () => {
  runMain();
});

function runMain() {
  main().catch(err => {
    console.error('[SessionEnd] Error:', err.message);
    process.exit(0);
  });
}

function getSessionMetadata() {
  const branchResult = runCommand('git rev-parse --abbrev-ref HEAD');

  return {
    project: getProjectName() || 'unknown',
    branch: branchResult.success ? branchResult.output : 'unknown',
    worktree: process.cwd()
  };
}

function extractHeaderField(header, label) {
  const match = header.match(new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function buildSessionHeader(today, currentTime, metadata, existingContent = '') {
  const headingMatch = existingContent.match(/^#\s+.+$/m);
  const heading = headingMatch ? headingMatch[0] : `# Session: ${today}`;
  const date = extractHeaderField(existingContent, 'Date') || today;
  const started = extractHeaderField(existingContent, 'Started') || currentTime;

  return [
    heading,
    `**Date:** ${date}`,
    `**Started:** ${started}`,
    `**Last Updated:** ${currentTime}`,
    `**Project:** ${metadata.project}`,
    `**Branch:** ${metadata.branch}`,
    `**Worktree:** ${metadata.worktree}`,
    ''
  ].join('\n');
}

function mergeSessionHeader(content, today, currentTime, metadata) {
  const separatorIndex = content.indexOf(SESSION_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const existingHeader = content.slice(0, separatorIndex);
  const body = content.slice(separatorIndex + SESSION_SEPARATOR.length);
  const nextHeader = buildSessionHeader(today, currentTime, metadata, existingHeader);
  return `${nextHeader}${SESSION_SEPARATOR}${body}`;
}

/**
 * Turn-based delta watcher — checks if other workstreams wrote new deltas
 * since the last turn. Lightweight: stat() + byte offset comparison.
 * Only reads file content when something actually changed.
 * The 1-hour time filter prevents re-surfacing what SessionStart already covered.
 */
function checkForNewDeltas() {
  const deltasDir = path.join(getHomeDir(), '.claude', 'deltas');
  if (!fs.existsSync(deltasDir)) return;

  const cwd = process.cwd();
  const myWorkstream = resolveWorkstream(cwd);
  const myJsonlPath = resolveJsonlPath(cwd);

  // Load saved offsets
  let offsets = {};
  try {
    if (fs.existsSync(DELTA_OFFSETS_FILE)) {
      offsets = JSON.parse(fs.readFileSync(DELTA_OFFSETS_FILE, 'utf-8'));
    }
  } catch { offsets = {}; }

  // Find all JSONL files in deltas dir
  let deltaFiles;
  try {
    deltaFiles = fs.readdirSync(deltasDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(deltasDir, f));
  } catch { return; }

  const newDeltas = [];
  const updatedOffsets = { ...offsets };
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  for (const filePath of deltaFiles) {
    try {
      const stat = fs.statSync(filePath);
      const lastOffset = offsets[filePath] || 0;

      // Fast path: file hasn't grown
      if (stat.size <= lastOffset) {
        updatedOffsets[filePath] = stat.size;
        continue;
      }

      // Read only new bytes
      const fd = fs.openSync(filePath, 'r');
      const newBytes = Buffer.alloc(stat.size - lastOffset);
      fs.readSync(fd, newBytes, 0, newBytes.length, lastOffset);
      fs.closeSync(fd);

      updatedOffsets[filePath] = stat.size;

      // Parse new delta lines, keep only those from OTHER workstreams
      const lines = newBytes.toString('utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const delta = JSON.parse(line);
          if (delta.workstream === myWorkstream) continue;
          const deltaTime = new Date(delta.ts).getTime();
          if (deltaTime && deltaTime >= oneHourAgo) {
            newDeltas.push(delta);
          }
        } catch { /* malformed line, skip */ }
      }
    } catch { /* stat/read error, skip */ }
  }

  // Save updated offsets
  try {
    ensureDir(path.dirname(DELTA_OFFSETS_FILE));
    fs.writeFileSync(DELTA_OFFSETS_FILE, JSON.stringify(updatedOffsets), 'utf-8');
  } catch (err) {
    log(`[TurnDeltaWatcher] Failed to save offsets: ${err.message}`);
  }

  // Output new deltas if any
  if (newDeltas.length > 0) {
    const lines = newDeltas.map(d => {
      const age = Math.round((Date.now() - new Date(d.ts).getTime()) / 60000);
      return `- **${d.workstream}** (${age}m ago): ${d.summary}${d.review_flag ? ' [REVIEW]' : ''}`;
    });
    // Cap at 1KB to avoid context bloat
    let block = `\n--- Cross-Instance Update ---\n${lines.join('\n')}\n---`;
    if (block.length > 1024) {
      block = block.slice(0, 1020) + '...\n---';
    }
    output(block);
    log(`[TurnDeltaWatcher] Surfaced ${newDeltas.length} new delta(s) from other workstreams`);
  }
}

async function main() {
  // Parse stdin JSON to get transcript_path
  let transcriptPath = null;
  try {
    const input = JSON.parse(stdinData);
    transcriptPath = input.transcript_path;
  } catch {
    // Fallback: try env var for backwards compatibility
    transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
  }

  const sessionsDir = getSessionsDir();
  const today = getDateString();
  const shortId = getSessionIdShort();
  const sessionFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);
  const sessionMetadata = getSessionMetadata();

  ensureDir(sessionsDir);

  const currentTime = getTimeString();

  // Try to extract summary from transcript
  let summary = null;

  if (transcriptPath) {
    if (fs.existsSync(transcriptPath)) {
      summary = extractSessionSummary(transcriptPath);
    } else {
      log(`[SessionEnd] Transcript not found: ${transcriptPath}`);
    }
  }

  if (fs.existsSync(sessionFile)) {
    const existing = readFile(sessionFile);
    let updatedContent = existing;

    if (existing) {
      const merged = mergeSessionHeader(existing, today, currentTime, sessionMetadata);
      if (merged) {
        updatedContent = merged;
      } else {
        log(`[SessionEnd] Failed to normalize header in ${sessionFile}`);
      }
    }

    // If we have a new summary, update only the generated summary block.
    // This keeps repeated Stop invocations idempotent and preserves
    // user-authored sections in the same session file.
    if (summary && updatedContent) {
      const summaryBlock = buildSummaryBlock(summary);

      if (updatedContent.includes(SUMMARY_START_MARKER) && updatedContent.includes(SUMMARY_END_MARKER)) {
        updatedContent = updatedContent.replace(
          new RegExp(`${escapeRegExp(SUMMARY_START_MARKER)}[\\s\\S]*?${escapeRegExp(SUMMARY_END_MARKER)}`),
          summaryBlock
        );
      } else {
        // Migration path for files created before summary markers existed.
        updatedContent = updatedContent.replace(
          /## (?:Session Summary|Current State)[\s\S]*?$/,
          `${summaryBlock}\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\`\n`
        );
      }
    }

    if (updatedContent) {
      writeFile(sessionFile, updatedContent);
    }

    log(`[SessionEnd] Updated session file: ${sessionFile}`);
  } else {
    // Create new session file
    const summarySection = summary
      ? `${buildSummaryBlock(summary)}\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\``
      : `## Current State\n\n[Session context goes here]\n\n### Completed\n- [ ]\n\n### In Progress\n- [ ]\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\``;

    const template = `${buildSessionHeader(today, currentTime, sessionMetadata)}${SESSION_SEPARATOR}${summarySection}
`;

    writeFile(sessionFile, template);
    log(`[SessionEnd] Created session file: ${sessionFile}`);
  }

  // --- Delta write ---
  try {
    writeDelta(summary, shortId);
  } catch (err) {
    log(`[SessionEnd] Delta write failed (non-fatal): ${err.message}`);
  }

  // --- Skill observation ---
  try {
    const { createSkillObservation, appendSkillObservation } = require('../lib/skill-improvement/observations');
    const cwd = process.cwd();
    const workstream = resolveWorkstream(cwd);
    const filesModified = summary ? summary.filesModified : [];
    const hasFilesModified = filesModified.length > 0;
    const taskSummary = (summary && summary.userMessages && summary.userMessages.length > 0)
      ? summary.userMessages[0].replace(/\n/g, ' ').trim()
      : 'No task summary';

    const observation = createSkillObservation({
      task: taskSummary,
      skill: {
        id: workstream,
        path: cwd
      },
      success: hasFilesModified,
      error: hasFilesModified ? null : 'no files modified',
      sessionId: shortId
    });

    appendSkillObservation(observation);
    log(`[SessionEnd] Skill observation recorded for ${workstream} (success=${hasFilesModified})`);
  } catch (err) {
    log(`[SessionEnd] Skill observation failed (non-fatal): ${err.message}`);
  }

  // --- Mid-session delta watcher ---
  try {
    checkForNewDeltas();
  } catch (err) {
    log(`[TurnDeltaWatcher] Check failed (non-fatal): ${err.message}`);
  }

  process.exit(0);
}

/**
 * Determine the JSONL delta file path based on the current working directory.
 */
function resolveJsonlPath(cwd) {
  const deltasDir = path.join(getHomeDir(), '.claude', 'deltas');

  if (/intelligence-ledger|assay/i.test(cwd)) {
    return path.join(deltasDir, 'assay.jsonl');
  }
  if (cwd === path.join(getHomeDir(), 'sam-assistant') || cwd.startsWith(path.join(getHomeDir(), 'sam-assistant') + path.sep)) {
    return path.join(deltasDir, 'sam-assistant.jsonl');
  }
  if (/Work:Resume|Outeach/i.test(cwd)) {
    return path.join(deltasDir, 'rw-outreach.jsonl');
  }
  if (/workdirectory-legacy/i.test(cwd)) {
    return path.join(deltasDir, 'workdirectory.jsonl');
  }
  // Default
  return path.join(deltasDir, 'assay.jsonl');
}

/**
 * Detect files changed via git diff from session start HEAD to current HEAD.
 * Falls back to transcript-parsed filesModified set.
 */
function detectFilesChanged(filesModifiedFromTranscript) {
  const gitHeadStartFile = path.join(getSessionsDir(), '.git-head-start');
  const startHead = readFile(gitHeadStartFile);

  if (startHead && startHead.trim()) {
    const sha = startHead.trim().replace(/[^a-f0-9]/gi, '');
    if (sha.length >= 7) {
      const result = runCommand(`git diff --name-only "${sha}..HEAD"`);
      if (result.success && result.output.trim()) {
        return {
          files: result.output.split('\n').filter(Boolean),
          via: 'git_diff'
        };
      }
    }
  }

  return {
    files: filesModifiedFromTranscript ? Array.from(filesModifiedFromTranscript) : [],
    via: 'transcript'
  };
}

/**
 * Determine workstream identity from env or project path.
 */
function resolveWorkstream(cwd) {
  if (process.env.ILP_WORKSTREAM) {
    return process.env.ILP_WORKSTREAM;
  }
  if (/intelligence-ledger|assay/i.test(cwd)) return 'assay';
  if (/sam-assistant/i.test(cwd)) return 'sam-assistant';
  if (/Work:Resume|Outeach/i.test(cwd)) return 'rw-outreach';
  if (/workdirectory-legacy/i.test(cwd)) return 'workdirectory';
  if (/everything-claude-code/i.test(cwd)) return 'ecc';
  // Architect path or default — most instances operate on ILP/Assay
  const home = require('os').homedir();
  if (cwd === home || cwd === '/Users') return 'architect';
  return 'ilp';
}

/**
 * Classify the delta type and impact based on changed files.
 */
function classifyDelta(files) {
  let type = 'file_change';
  for (const f of files) {
    if (/migration|schema/i.test(f)) {
      type = 'schema_change';
      break;
    }
    if (/\.deploy|\.yml$|\.yaml$|vercel\.json/i.test(f)) {
      type = 'deploy';
      break;
    }
  }

  const hasSchemaOrMigration = files.some(f => /migration|schema/i.test(f));
  let impact = 'low';
  if (hasSchemaOrMigration || files.length > 5) {
    impact = 'high';
  } else if (files.length >= 2) {
    impact = 'medium';
  }

  return { type, impact, review_flag: impact === 'high' };
}

/**
 * Build a short summary string from session tasks and files.
 */
function buildDeltaSummary(summary, files) {
  let text = '';
  if (summary && summary.userMessages && summary.userMessages.length > 0) {
    text = summary.userMessages[0]
      .replace(/<[^>]+>/g, '')           // strip XML/HTML tags
      .replace(/\s+/g, ' ')             // collapse whitespace
      .replace(/^[\s\W]+/, '')           // trim leading non-word chars
      .trim();
    // Take first sentence or first 150 chars, whichever is shorter
    const sentenceEnd = text.search(/[.!?]\s/);
    if (sentenceEnd > 0 && sentenceEnd < 150) {
      text = text.slice(0, sentenceEnd + 1);
    }
  }
  const fileCount = files.length;
  const suffix = fileCount > 0 ? ` (${fileCount} file${fileCount === 1 ? '' : 's'} changed)` : '';
  const combined = text + suffix;
  return combined.slice(0, 200) || 'Session with no extractable summary';
}

/**
 * Write a delta entry to the appropriate JSONL file.
 */
function writeDelta(summary, shortId) {
  const totalMessages = summary ? summary.totalMessages : 0;
  const filesModified = summary ? new Set(summary.filesModified) : new Set();

  // Skip trivial sessions
  if (totalMessages < 3 && filesModified.size === 0) {
    log('[SessionEnd] Delta skip: trivial session (< 3 messages, 0 files)');
    return;
  }

  const cwd = process.cwd();
  const jsonlPath = resolveJsonlPath(cwd);
  const { files, via } = detectFilesChanged(filesModified);
  const workstream = resolveWorkstream(cwd);
  const { type, impact, review_flag } = classifyDelta(files);

  const delta = {
    ts: new Date().toISOString(),
    workstream,
    repo: path.basename(cwd),
    type,
    summary: buildDeltaSummary(summary, files),
    files: files.slice(0, 20),
    files_via: via,
    impact,
    review_flag,
    session_id: shortId
  };

  ensureDir(path.dirname(jsonlPath));
  appendFile(jsonlPath, JSON.stringify(delta) + '\n');
  log(`[SessionEnd] Delta written to ${jsonlPath} (${impact} impact, ${files.length} files via ${via})`);
}

function buildSummarySection(summary) {
  let section = '## Session Summary\n\n';

  // Tasks (from user messages — collapse newlines and escape backticks to prevent markdown breaks)
  section += '### Tasks\n';
  for (const msg of summary.userMessages) {
    section += `- ${msg.replace(/\n/g, ' ').replace(/`/g, '\\`')}\n`;
  }
  section += '\n';

  // Files modified
  if (summary.filesModified.length > 0) {
    section += '### Files Modified\n';
    for (const f of summary.filesModified) {
      section += `- ${f}\n`;
    }
    section += '\n';
  }

  // Tools used
  if (summary.toolsUsed.length > 0) {
    section += `### Tools Used\n${summary.toolsUsed.join(', ')}\n\n`;
  }

  section += `### Stats\n- Total user messages: ${summary.totalMessages}\n`;

  return section;
}

function buildSummaryBlock(summary) {
  return `${SUMMARY_START_MARKER}\n${buildSummarySection(summary).trim()}\n${SUMMARY_END_MARKER}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
