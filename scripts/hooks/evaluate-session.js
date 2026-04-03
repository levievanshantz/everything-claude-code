#!/usr/bin/env node
/**
 * Continuous Learning - Session Evaluator
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs on Stop hook to extract reusable patterns from Claude Code sessions.
 * Reads transcript_path from stdin JSON (Claude Code hook input).
 *
 * Supports two invocation modes:
 *   1. module.exports.run(rawInput) — called by run-with-flags.js (preferred)
 *   2. stdin piped JSON — legacy standalone execution
 *
 * Pattern extraction is purely heuristic (no LLM calls).
 */

const path = require('path');
const fs = require('fs');
const {
  getLearnedSkillsDir,
  getSessionsDir,
  getDateString,
  getTimeString,
  getSessionIdShort,
  ensureDir,
  readFile,
  writeFile,
  findFiles,
  countInFile,
  stripAnsi,
  log
} = require('../lib/utils');

// ---------------------------------------------------------------------------
// Heuristic pattern extractors
// ---------------------------------------------------------------------------

/**
 * Parse a session .tmp file and extract structured data from its markdown.
 */
function parseSessionFile(content) {
  const result = {
    date: null,
    project: null,
    branch: null,
    tasks: [],
    filesModified: [],
    toolsUsed: [],
    totalMessages: 0
  };

  // Header fields
  const dateMatch = content.match(/\*\*Date:\*\*\s*(.+)/);
  if (dateMatch) result.date = dateMatch[1].trim();

  const projectMatch = content.match(/\*\*Project:\*\*\s*(.+)/);
  if (projectMatch) result.project = projectMatch[1].trim();

  const branchMatch = content.match(/\*\*Branch:\*\*\s*(.+)/);
  if (branchMatch) result.branch = branchMatch[1].trim();

  // Tasks section (lines starting with "- " under ### Tasks)
  const tasksBlock = content.match(/### Tasks\n([\s\S]*?)(?=\n###|\n<!-- )/);
  if (tasksBlock) {
    result.tasks = tasksBlock[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim())
      .filter(Boolean);
  }

  // Files modified
  const filesBlock = content.match(/### Files Modified\n([\s\S]*?)(?=\n###|\n<!-- )/);
  if (filesBlock) {
    result.filesModified = filesBlock[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim())
      .filter(Boolean);
  }

  // Tools used
  const toolsMatch = content.match(/### Tools Used\n(.+)/);
  if (toolsMatch) {
    result.toolsUsed = toolsMatch[1]
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
  }

  // Total messages
  const msgMatch = content.match(/Total user messages:\s*(\d+)/);
  if (msgMatch) result.totalMessages = parseInt(msgMatch[1], 10);

  return result;
}

/**
 * Extract tool frequency patterns.
 * Tools used more than once, or MCP tools, are noteworthy.
 */
function extractToolPatterns(toolsUsed) {
  const patterns = [];
  const mcpTools = toolsUsed.filter(t => t.startsWith('mcp__'));
  const coreTools = toolsUsed.filter(t => !t.startsWith('mcp__'));

  if (coreTools.length > 0) {
    patterns.push({
      type: 'tool-usage',
      description: `Core tools used: ${coreTools.join(', ')}`,
      tools: coreTools
    });
  }

  if (mcpTools.length > 0) {
    // Group MCP tools by service
    const services = {};
    for (const t of mcpTools) {
      // mcp__<id>__<method> — extract method name
      const parts = t.split('__');
      const method = parts.length >= 3 ? parts.slice(2).join('__') : t;
      const serviceId = parts.length >= 2 ? parts[1].slice(0, 8) : 'unknown';
      if (!services[serviceId]) services[serviceId] = [];
      services[serviceId].push(method);
    }

    for (const [serviceId, methods] of Object.entries(services)) {
      patterns.push({
        type: 'mcp-integration',
        description: `MCP service ${serviceId}... used: ${methods.join(', ')}`,
        methods
      });
    }
  }

  return patterns;
}

/**
 * Extract domain patterns from modified file paths.
 */
function extractFilePatterns(filesModified) {
  const patterns = [];
  if (filesModified.length === 0) return patterns;

  // Group by extension
  const extCounts = {};
  const dirCounts = {};

  for (const f of filesModified) {
    const ext = path.extname(f) || '(no ext)';
    extCounts[ext] = (extCounts[ext] || 0) + 1;

    // Top-level project directory (2nd or 3rd path segment usually)
    const parts = f.split('/').filter(Boolean);
    // Find a meaningful directory — skip user/home segments
    const meaningful = parts.find((p, i) =>
      i >= 2 && !p.startsWith('.') && !['Users', 'home', 'levishantz'].includes(p)
    );
    if (meaningful) {
      dirCounts[meaningful] = (dirCounts[meaningful] || 0) + 1;
    }
  }

  // File type patterns
  const sortedExts = Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1]);

  if (sortedExts.length > 0) {
    patterns.push({
      type: 'file-types',
      description: `File types modified: ${sortedExts.map(([ext, n]) => `${ext} (${n})`).join(', ')}`,
      extensions: Object.fromEntries(sortedExts)
    });
  }

  // Project area patterns
  const sortedDirs = Object.entries(dirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (sortedDirs.length > 0) {
    patterns.push({
      type: 'project-areas',
      description: `Project areas: ${sortedDirs.map(([d, n]) => `${d} (${n} files)`).join(', ')}`,
      areas: Object.fromEntries(sortedDirs)
    });
  }

  return patterns;
}

/**
 * Extract preference patterns from task descriptions.
 * Looks for directive language suggesting user preferences.
 */
function extractPreferencePatterns(tasks) {
  const patterns = [];
  const preferenceKeywords = [
    'always', 'never', 'don\'t', 'do not', 'make sure', 'please',
    'prefer', 'use', 'should', 'must', 'stop', 'instead'
  ];

  const preferenceHints = tasks.filter(task => {
    const lower = task.toLowerCase();
    return preferenceKeywords.some(kw => lower.includes(kw));
  });

  if (preferenceHints.length > 0) {
    patterns.push({
      type: 'user-preferences',
      description: 'Potential user preferences detected in task directives',
      directives: preferenceHints.slice(0, 5)
    });
  }

  return patterns;
}

/**
 * Detect session complexity and workflow type from all signals.
 */
function extractWorkflowPatterns(session) {
  const patterns = [];

  // Session intensity
  if (session.totalMessages >= 50) {
    patterns.push({
      type: 'session-intensity',
      description: `High-intensity session (${session.totalMessages} messages)`,
      messageCount: session.totalMessages
    });
  }

  // Multi-file editing sessions
  if (session.filesModified.length >= 5) {
    patterns.push({
      type: 'multi-file-edit',
      description: `Broad editing session (${session.filesModified.length} files modified)`,
      fileCount: session.filesModified.length
    });
  }

  // Agent/delegation usage
  if (session.toolsUsed.includes('Agent') || session.toolsUsed.includes('TodoWrite')) {
    patterns.push({
      type: 'delegation-workflow',
      description: 'Session used agent delegation (Agent/TodoWrite tools)',
      tools: session.toolsUsed.filter(t => t === 'Agent' || t === 'TodoWrite')
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Session file discovery
// ---------------------------------------------------------------------------

/**
 * Find the most recent session file.
 */
function findLatestSessionFile() {
  const sessionsDir = getSessionsDir();
  const files = findFiles(sessionsDir, '*.tmp');
  if (files.length === 0) return null;
  // findFiles already sorts by mtime descending
  return files[0].path;
}

// ---------------------------------------------------------------------------
// Output generation
// ---------------------------------------------------------------------------

/**
 * Generate a markdown skill file from extracted patterns.
 */
function generateSkillFile(session, allPatterns) {
  const today = getDateString();
  const time = getTimeString();

  let md = `# Session Patterns: ${today}\n\n`;
  md += `**Extracted:** ${today} ${time}\n`;
  md += `**Project:** ${session.project || 'unknown'}\n`;
  md += `**Branch:** ${session.branch || 'unknown'}\n`;
  md += `**Messages:** ${session.totalMessages}\n`;
  md += `**Files Modified:** ${session.filesModified.length}\n`;
  md += `**Tools Used:** ${session.toolsUsed.length}\n\n`;

  if (allPatterns.length === 0) {
    md += `> No significant patterns extracted from this session.\n`;
    return md;
  }

  md += `## Extracted Patterns\n\n`;

  // Group by type
  const grouped = {};
  for (const p of allPatterns) {
    if (!grouped[p.type]) grouped[p.type] = [];
    grouped[p.type].push(p);
  }

  for (const [type, patterns] of Object.entries(grouped)) {
    const heading = type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    md += `### ${heading}\n\n`;
    for (const p of patterns) {
      md += `- ${p.description}\n`;
      // Add sub-details for certain types
      if (p.directives) {
        for (const d of p.directives) {
          md += `  - "${d.slice(0, 150)}"\n`;
        }
      }
    }
    md += '\n';
  }

  // Summary of tasks for context
  if (session.tasks.length > 0) {
    md += `## Session Tasks (for context)\n\n`;
    for (const task of session.tasks.slice(0, 10)) {
      md += `- ${task.slice(0, 200)}\n`;
    }
    md += '\n';
  }

  return md;
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

function evaluateSession(rawInput) {
  // Parse input to check for transcript_path
  let transcriptPath = null;
  try {
    const input = JSON.parse(rawInput || '{}');
    transcriptPath = input.transcript_path;
  } catch {
    // Fallback: try env var for backwards compatibility
    transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
  }

  // Load config
  const scriptDir = __dirname;
  const configFile = path.join(scriptDir, '..', '..', 'skills', 'continuous-learning', 'config.json');
  let minSessionLength = 10;
  let learnedSkillsPath = getLearnedSkillsDir();

  const configContent = readFile(configFile);
  if (configContent) {
    try {
      const config = JSON.parse(configContent);
      minSessionLength = config.min_session_length ?? 10;
      if (config.learned_skills_path) {
        learnedSkillsPath = config.learned_skills_path.replace(/^~/, require('os').homedir());
      }
    } catch (err) {
      log(`[ContinuousLearning] Failed to parse config: ${err.message}, using defaults`);
    }
  }

  ensureDir(learnedSkillsPath);

  // Check transcript message count if available
  let messageCount = 0;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    messageCount = countInFile(transcriptPath, /"type"\s*:\s*"user"/g);
    if (messageCount < minSessionLength) {
      log(`[ContinuousLearning] Session too short (${messageCount} messages), skipping`);
      return null;
    }
  }

  // Log that we're proceeding with evaluation (tests and other hooks depend on this)
  if (messageCount > 0) {
    log(`[ContinuousLearning] Session has ${messageCount} messages - evaluate for extractable patterns`);
  }
  log(`[ContinuousLearning] Save learned skills to: ${learnedSkillsPath}`);

  // Find latest session file (written by session-end.js)
  const sessionFilePath = findLatestSessionFile();
  if (!sessionFilePath) {
    log('[ContinuousLearning] No session files found, skipping');
    return null;
  }

  const sessionContent = readFile(sessionFilePath);
  if (!sessionContent) {
    log('[ContinuousLearning] Session file empty, skipping');
    return null;
  }

  // Parse the session file
  const session = parseSessionFile(sessionContent);

  // Skip if no meaningful content
  if (session.tasks.length === 0 && session.filesModified.length === 0 && session.toolsUsed.length === 0) {
    log('[ContinuousLearning] Session has no meaningful content, skipping');
    return null;
  }

  // Run all heuristic extractors
  const allPatterns = [
    ...extractToolPatterns(session.toolsUsed),
    ...extractFilePatterns(session.filesModified),
    ...extractPreferencePatterns(session.tasks),
    ...extractWorkflowPatterns(session)
  ];

  // Generate and write the skill file — one file per session, overwritten each turn
  const today = getDateString();
  const shortId = getSessionIdShort();
  const filename = `${today}-${shortId}-patterns.md`;
  const outputPath = path.join(learnedSkillsPath, filename);

  const skillContent = generateSkillFile(session, allPatterns);
  writeFile(outputPath, skillContent);
  log(`[ContinuousLearning] Wrote learned patterns: ${outputPath}`);

  return null; // async hook, stdout is discarded
}

// ---------------------------------------------------------------------------
// Exports for run-with-flags.js (preferred path)
// ---------------------------------------------------------------------------

module.exports = {
  run(rawInput) {
    evaluateSession(rawInput);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Legacy standalone execution (stdin piped)
// ---------------------------------------------------------------------------

if (require.main === module) {
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
    try {
      evaluateSession(stdinData);
    } catch (err) {
      console.error('[ContinuousLearning] Error:', err.message);
    }
    process.exit(0);
  });
}
