#!/usr/bin/env node
/**
 * SessionStart Hook - Load previous context on new session
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs when a new Claude session starts. Loads the most recent session
 * summary into Claude's context via stdout, and reports available
 * sessions and learned skills.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getSessionsDir,
  getSessionSearchDirs,
  getLearnedSkillsDir,
  findFiles,
  ensureDir,
  readFile,
  writeFile,
  stripAnsi,
  log,
  output,
  runCommand,
  getHomeDir
} = require('../lib/utils');
const { getPackageManager, getSelectionPrompt } = require('../lib/package-manager');
const { listAliases } = require('../lib/session-aliases');
const { detectProjectType } = require('../lib/project-detect');

function dedupeRecentSessions(searchDirs) {
  const recentSessionsByName = new Map();

  for (const [dirIndex, dir] of searchDirs.entries()) {
    const matches = findFiles(dir, '*-session.tmp', { maxAge: 7 });

    for (const match of matches) {
      const basename = path.basename(match.path);
      const current = {
        ...match,
        basename,
        dirIndex,
      };
      const existing = recentSessionsByName.get(basename);

      if (
        !existing
        || current.mtime > existing.mtime
        || (current.mtime === existing.mtime && current.dirIndex < existing.dirIndex)
      ) {
        recentSessionsByName.set(basename, current);
      }
    }
  }

  return Array.from(recentSessionsByName.values())
    .sort((left, right) => right.mtime - left.mtime || left.dirIndex - right.dirIndex);
}

async function main() {
  const sessionsDir = getSessionsDir();
  const learnedDir = getLearnedSkillsDir();
  const additionalContextParts = [];

  // Ensure directories exist
  ensureDir(sessionsDir);
  ensureDir(learnedDir);

  // Check for recent session files (last 7 days)
  const recentSessions = dedupeRecentSessions(getSessionSearchDirs());

  if (recentSessions.length > 0) {
    const latest = recentSessions[0];
    log(`[SessionStart] Found ${recentSessions.length} recent session(s)`);
    log(`[SessionStart] Latest: ${latest.path}`);

    // Read and inject the latest session content into Claude's context
    const content = stripAnsi(readFile(latest.path));
    if (content && !content.includes('[Session context goes here]')) {
      // Only inject if the session has actual content (not the blank template)
      additionalContextParts.push(`Previous session summary:\n${content}`);
    }
  }

  // --- Assay capability self-model injection ---
  // Reads ~/.assay/CAPABILITIES.md (written atomically by assaylabs/scripts/install-bundle.sh)
  // and prepends it to opening context. Graceful no-op if Assay isn't installed.
  // Defense in depth (per codex review 2026-04-27):
  //  - 8KB hard byte cap (skip injection if file is larger — defense vs prompt-injection growth)
  //  - SHA-256 integrity check against ~/.assay/CAPABILITIES.md.sha256 sidecar (defense vs tampering)
  //  - Version-stamp staleness warn (>30d since install → log warn, still inject)
  //  - Counts against the 25KB BUDGET_LIMIT below (no bypass)
  const CAPABILITIES_BYTE_CAP = 8192;
  const CAPABILITIES_STALE_DAYS = 30;
  let capabilitiesInjection = '';
  let capabilitiesSize = 0;
  try {
    // Honor ASSAY_HOME env var so per-project silos can point at a separate
    // capability self-model (e.g. workdirectory-live/.assay/CAPABILITIES.md).
    const assayHome = process.env.ASSAY_HOME || path.join(getHomeDir(), '.assay');
    const capabilitiesPath = path.join(assayHome, 'CAPABILITIES.md');
    if (fs.existsSync(capabilitiesPath)) {
      const stat = fs.statSync(capabilitiesPath);
      if (stat.size > CAPABILITIES_BYTE_CAP) {
        log(`[SessionStart] CAPABILITIES.md exceeds ${CAPABILITIES_BYTE_CAP}B cap (${stat.size}B) — skipping injection`);
      } else {
        const capabilitiesContent = readFile(capabilitiesPath);
        if (capabilitiesContent && capabilitiesContent.trim().length > 0) {
          // Integrity check: verify against sidecar SHA-256 if present.
          const sidecarPath = `${capabilitiesPath}.sha256`;
          let integrityOk = true;
          if (fs.existsSync(sidecarPath)) {
            try {
              const expected = stripAnsi(readFile(sidecarPath)).trim().split(/\s+/)[0];
              const crypto = require('crypto');
              const actual = crypto.createHash('sha256').update(capabilitiesContent).digest('hex');
              if (expected && expected !== actual) {
                integrityOk = false;
                log(`[SessionStart] CAPABILITIES.md sha256 mismatch (expected ${expected.slice(0,12)}, got ${actual.slice(0,12)}) — skipping injection. Re-run install-bundle.sh to fix.`);
              }
            } catch (e) {
              log(`[SessionStart] CAPABILITIES.md integrity check failed: ${e.message} — skipping injection`);
              integrityOk = false;
            }
          } else {
            log(`[SessionStart] CAPABILITIES.md.sha256 sidecar missing — proceeding without integrity check`);
          }
          if (integrityOk) {
            // Staleness check via VERSION line in front-matter.
            const versionMatch = capabilitiesContent.match(/<!--\s*VERSION:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
            if (versionMatch) {
              const versionDate = new Date(versionMatch[1]);
              const ageDays = (Date.now() - versionDate.getTime()) / 86400000;
              if (ageDays > CAPABILITIES_STALE_DAYS) {
                log(`[SessionStart] CAPABILITIES.md is ${Math.round(ageDays)}d old (>${CAPABILITIES_STALE_DAYS}d threshold) — re-run install-bundle.sh to refresh`);
              }
            }
            capabilitiesInjection = `Assay memory capability self-model (authoritative — read before answering questions about what your memory does):\n\n${capabilitiesContent.trim()}`;
            capabilitiesSize = Buffer.byteLength(capabilitiesInjection, 'utf8');
          }
        }
      }
    }
  } catch (err) {
    log(`[SessionStart] Capabilities self-model not available: ${err.message}`);
  }

  // --- Memory & feedback rule injection ---
  const BUDGET_LIMIT = 25600; // 25KB
  let injectionSize = 0;

  const memoryDir = path.join(getHomeDir(), '.claude', 'projects', '-Users', 'memory');
  const cwd = process.cwd();

  // Determine if CWD is an Assay/ILP project
  const assayPaths = [
    '/Users/levishantz/intelligence-ledger-prototype',
    '/Users/levishantz/assay-mcp-server',
    '/Users/levishantz/assaylabs-docs-site'
  ];
  const architectPaths = ['/Users/levishantz', '/Users'];

  let isAssayProject = assayPaths.some(p => cwd.startsWith(p));

  // Also check if CWD is the architect path (exactly /Users/levishantz or /Users)
  if (!isAssayProject && architectPaths.includes(cwd)) {
    isAssayProject = true;
  }

  // If not matched by hardcoded paths, check the instance registry
  if (!isAssayProject) {
    try {
      const registryPath = path.join(getHomeDir(), '.claude', 'daily-review', 'instance-registry.json');
      const registryContent = readFile(registryPath);
      if (registryContent) {
        const registry = JSON.parse(registryContent);
        const matchedInstance = (registry.instances || []).find(inst => cwd.startsWith(inst.path));
        if (matchedInstance) {
          if (matchedInstance.name === 'ilp' ||
              matchedInstance.path.includes('assay') ||
              matchedInstance.path.includes('intelligence-ledger')) {
            isAssayProject = true;
          }
        }
      }
    } catch (err) {
      log(`[SessionStart] Warning: could not read instance registry: ${err.message}`);
    }
  }

  // Universal feedback rules (always injected)
  const universalFiles = [
    'feedback_agent_discipline.md',
    'feedback_claudemd_update.md',
    'feedback_verify_before_done.md'
  ];

  // ILP/Assay-scoped feedback rules
  const scopedFiles = [
    'feedback_context_isolation.md',
    'feedback_eval_include_urls.md',
    'feedback_velocity_block.md'
  ];

  function readFeedbackFiles(fileNames) {
    const parts = [];
    for (const fileName of fileNames) {
      const filePath = path.join(memoryDir, fileName);
      const content = readFile(filePath);
      if (content) {
        parts.push(content.trim());
      } else {
        log(`[SessionStart] Warning: could not read ${fileName}`);
      }
    }
    return parts.join('\n\n');
  }

  const universalContent = readFeedbackFiles(universalFiles);
  let injectionBlock = '';

  // Capabilities self-model is highest-priority — counts against the 25KB budget.
  if (capabilitiesInjection) {
    injectionBlock += capabilitiesInjection;
    injectionSize += capabilitiesSize;
  }

  if (universalContent) {
    const sep = injectionBlock ? '\n\n' : '';
    const universalBlock = `${sep}Global rules (always active):\n${universalContent}`;
    injectionBlock += universalBlock;
    injectionSize += Buffer.byteLength(universalBlock, 'utf8');
  }

  if (isAssayProject) {
    const scopedContent = readFeedbackFiles(scopedFiles);
    if (scopedContent) {
      const scopedBlock = `\n\nProject rules (Assay/ILP):\n${scopedContent}`;
      const scopedSize = Buffer.byteLength(scopedBlock, 'utf8');

      if (injectionSize + scopedSize > BUDGET_LIMIT) {
        log(`[SessionStart] Warning: injection would exceed 25KB budget (${injectionSize + scopedSize} bytes). Truncating scoped rules.`);
        const remaining = BUDGET_LIMIT - injectionSize;
        if (remaining > 100) {
          injectionBlock += scopedBlock.slice(0, remaining);
        }
      } else {
        injectionBlock += scopedBlock;
        injectionSize += scopedSize;
      }
    }
  }

  if (injectionBlock) {
    if (injectionSize > BUDGET_LIMIT) {
      log(`[SessionStart] Warning: total injection ${injectionSize} bytes exceeds 25KB budget. Truncating.`);
      injectionBlock = injectionBlock.slice(0, BUDGET_LIMIT);
    }
    output(injectionBlock);
    log(`[SessionStart] Injected feedback rules (${injectionSize} bytes, assay=${isAssayProject})`);
  }

  // --- Morning brief injection (architect instance only) ---
  if (architectPaths.includes(cwd)) {
    try {
      const briefsDir = path.join(getHomeDir(), '.claude', 'daily-review', 'briefs');
      const today = new Date().toISOString().slice(0, 10);
      const briefPath = path.join(briefsDir, `${today}.md`);
      const briefContent = readFile(briefPath);
      if (briefContent) {
        const briefSize = Buffer.byteLength(briefContent, 'utf8');
        const remaining = BUDGET_LIMIT - injectionSize;
        if (briefSize <= remaining) {
          output(`\n📋 Morning Brief (${today}):\n${briefContent}`);
          injectionSize += briefSize;
          log(`[SessionStart] Injected morning brief (${briefSize} bytes)`);
        } else {
          log(`[SessionStart] Morning brief too large (${briefSize} bytes, ${remaining} remaining). Skipping.`);
        }
      }
    } catch (err) {
      log(`[SessionStart] Morning brief injection failed (non-fatal): ${err.message}`);
    }
  }

  // --- Delta injection: recent cross-workstream activity ---
  try {
    const deltasDir = path.join(getHomeDir(), '.claude', 'deltas');
    const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
    const cutoff = Date.now() - FORTY_EIGHT_HOURS;

    // Determine which JSONL files to read based on CWD
    let deltaFiles = [];
    if (architectPaths.includes(cwd)) {
      // Architect sees everything
      try {
        const allFiles = fs.readdirSync(deltasDir).filter(f => f.endsWith('.jsonl'));
        deltaFiles = allFiles.map(f => path.join(deltasDir, f));
      } catch (err) {
        log(`[SessionStart] Delta dir not found, skipping: ${err.message}`);
      }
    } else if (cwd.includes('intelligence-ledger') || cwd.includes('assay')) {
      deltaFiles = [path.join(deltasDir, 'assay.jsonl')];
    } else if (cwd === '/Users/levishantz/sam-assistant' || cwd.startsWith('/Users/levishantz/sam-assistant/')) {
      deltaFiles = [path.join(deltasDir, 'sam-assistant.jsonl')];
    } else if (cwd.includes('Work:Resume') || cwd.includes('Outeach')) {
      deltaFiles = [path.join(deltasDir, 'rw-outreach.jsonl')];
    } else if (cwd.includes('workdirectory-legacy')) {
      deltaFiles = [path.join(deltasDir, 'workdirectory.jsonl')];
    }

    if (deltaFiles.length > 0) {
      // Read and parse all deltas from matched files
      let allDeltas = [];
      for (const filePath of deltaFiles) {
        const content = readFile(filePath);
        if (!content) {
          log(`[SessionStart] Delta file not found or empty: ${filePath}`);
          continue;
        }
        const lines = content.trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const delta = JSON.parse(line);
            const deltaTime = new Date(delta.ts).getTime();
            if (deltaTime && deltaTime >= cutoff) {
              delta._time = deltaTime;
              allDeltas.push(delta);
            }
          } catch (parseErr) {
            log(`[SessionStart] Warning: malformed delta line in ${path.basename(filePath)}`);
          }
        }
      }

      // Sort newest first and cap at 50
      allDeltas.sort((a, b) => (b._time || 0) - (a._time || 0));
      if (allDeltas.length > 50) {
        allDeltas = allDeltas.slice(0, 50);
      }

      // Format time ago
      function formatTimeAgo(tsOrMs) {
        const ms = typeof tsOrMs === 'number' ? tsOrMs : new Date(tsOrMs).getTime();
        const diffMs = Date.now() - ms;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.floor(diffHr / 24);
        return `${diffDay}d ago`;
      }

      let deltaBlock = '';
      if (allDeltas.length === 0) {
        deltaBlock = 'What happened while you were away (last 48h):\n\nNo recent activity from other workstreams.';
      } else {
        // Group by workstream for logging
        const groups = {};
        for (const d of allDeltas) {
          const ws = d.workstream || 'unknown';
          groups[ws] = (groups[ws] || 0) + 1;
        }
        const groupSummary = Object.entries(groups).map(([k, v]) => `${k}: ${v}`).join(', ');
        log(`[SessionStart] Delta groups: ${groupSummary}`);

        // Format lines
        const deltaLines = allDeltas.map(d => {
          const ws = d.workstream || 'unknown';
          const summary = d.summary || 'no summary';
          const impact = d.impact || 'unknown';
          const timeAgo = formatTimeAgo(d._time || d.ts);
          const flag = d.review_flag ? ' ⚠ NEEDS REVIEW' : '';
          return `[${ws}] ${summary} (${impact} impact, ${timeAgo})${flag}`;
        });

        deltaBlock = 'What happened while you were away (last 48h):\n\n' + deltaLines.join('\n');
      }

      // Budget guard: check remaining bytes from 25KB budget
      const remaining = BUDGET_LIMIT - injectionSize;
      const deltaSize = Buffer.byteLength(deltaBlock, 'utf8');
      if (deltaSize <= remaining) {
        output(deltaBlock);
        injectionSize += deltaSize;
        log(`[SessionStart] Injected ${allDeltas.length} delta(s) (${deltaSize} bytes)`);
      } else if (remaining > 100) {
        // Truncate to fit: keep most recent deltas that fit
        const truncated = deltaBlock.slice(0, remaining);
        output(truncated);
        injectionSize += remaining;
        log(`[SessionStart] Injected deltas truncated to ${remaining} bytes (budget limit)`);
      } else {
        log(`[SessionStart] Skipping delta injection: only ${remaining} bytes remaining in budget`);
      }
    } else {
      log('[SessionStart] No delta files matched for CWD, skipping delta injection');
    }
  } catch (deltaErr) {
    log(`[SessionStart] Warning: delta injection failed: ${deltaErr.message}`);
  }

  // --- Architect context ledger injection (architect instance only) ---
  if (architectPaths.includes(cwd)) {
    try {
      const ledgerPath = path.join(getHomeDir(), '.claude', 'sessions', 'architect-ledger.md');
      const ledgerContent = readFile(ledgerPath);
      if (ledgerContent) {
        const ledgerSize = Buffer.byteLength(ledgerContent, 'utf8');
        const remaining = BUDGET_LIMIT - injectionSize;
        if (ledgerSize <= remaining) {
          output(`\n📋 Architect Context (from previous session):\n${ledgerContent}`);
          injectionSize += ledgerSize;
          log(`[SessionStart] Injected architect ledger (${ledgerSize} bytes)`);
        } else if (remaining > 200) {
          // Truncate to fit budget
          const truncated = ledgerContent.slice(0, remaining - 50) + '\n\n_[Truncated to fit budget]_';
          output(`\n📋 Architect Context (from previous session):\n${truncated}`);
          injectionSize += Buffer.byteLength(truncated, 'utf8');
          log(`[SessionStart] Injected architect ledger truncated to ${remaining} bytes (budget limit)`);
        } else {
          log(`[SessionStart] Skipping architect ledger: only ${remaining} bytes remaining in budget`);
        }
      }
    } catch (err) {
      log(`[SessionStart] Architect ledger injection failed (non-fatal): ${err.message}`);
    }
  }

  // --- Skill health warning (from weekly maintenance report) ---
  try {
    const maintenanceReportPath = path.join(getHomeDir(), '.claude', 'daily-review', 'maintenance-report.txt');
    if (fs.existsSync(maintenanceReportPath)) {
      const reportStat = fs.statSync(maintenanceReportPath);
      const daysSinceModified = (Date.now() - reportStat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (daysSinceModified <= 7) {
        const reportContent = readFile(maintenanceReportPath);
        if (reportContent && /declining/i.test(reportContent)) {
          // Extract declining skill names from the report
          const decliningNames = [];
          const lines = reportContent.split('\n');
          let inDeclining = false;
          for (const line of lines) {
            if (/declining skills:/i.test(line)) {
              inDeclining = true;
              continue;
            }
            if (inDeclining) {
              const match = line.match(/^\s+-\s+(.+)/);
              if (match) {
                decliningNames.push(match[1].trim());
              } else {
                inDeclining = false;
              }
            }
          }
          if (decliningNames.length > 0) {
            output(`\u26A0 Declining skills detected: ${decliningNames.join(', ')}. Run /skills-health for details.`);
          }
        }
      }
    }
  } catch (err) {
    log(`[SessionStart] Skill health check failed (non-fatal): ${err.message}`);
  }

  // --- Record git HEAD for delta protocol ---
  const gitHeadResult = runCommand('git rev-parse HEAD');
  if (gitHeadResult.success) {
    const sessionsDir2 = getSessionsDir();
    const headFile = path.join(sessionsDir2, '.git-head-start');
    try {
      writeFile(headFile, gitHeadResult.output);
      log(`[SessionStart] Recorded git HEAD: ${gitHeadResult.output.slice(0, 8)}...`);
    } catch (err) {
      log(`[SessionStart] Warning: could not write git HEAD: ${err.message}`);
    }
  }

  // Check for learned skills
  const learnedSkills = findFiles(learnedDir, '*.md');

  if (learnedSkills.length > 0) {
    log(`[SessionStart] ${learnedSkills.length} learned skill(s) available in ${learnedDir}`);
  }

  // Check for available session aliases
  const aliases = listAliases({ limit: 5 });

  if (aliases.length > 0) {
    const aliasNames = aliases.map(a => a.name).join(', ');
    log(`[SessionStart] ${aliases.length} session alias(es) available: ${aliasNames}`);
    log(`[SessionStart] Use /sessions load <alias> to continue a previous session`);
  }

  // Detect and report package manager
  const pm = getPackageManager();
  log(`[SessionStart] Package manager: ${pm.name} (${pm.source})`);

  // If no explicit package manager config was found, show selection prompt
  if (pm.source === 'default') {
    log('[SessionStart] No package manager preference found.');
    log(getSelectionPrompt());
  }

  // Detect project type and frameworks (#293)
  const projectInfo = detectProjectType();
  if (projectInfo.languages.length > 0 || projectInfo.frameworks.length > 0) {
    const parts = [];
    if (projectInfo.languages.length > 0) {
      parts.push(`languages: ${projectInfo.languages.join(', ')}`);
    }
    if (projectInfo.frameworks.length > 0) {
      parts.push(`frameworks: ${projectInfo.frameworks.join(', ')}`);
    }
    log(`[SessionStart] Project detected — ${parts.join('; ')}`);
    additionalContextParts.push(`Project type: ${JSON.stringify(projectInfo)}`);
  } else {
    log('[SessionStart] No specific project type detected');
  }

  // Tier 2 — cheap local semantic recall over ECC session history.
  // Fires once per SessionStart. Zero remote calls (bge-large local).
  // Failure is silent; this hook must never block session boot.
  const tier2Digest = tryTier2Recall(cwd, projectInfo);
  if (tier2Digest) additionalContextParts.push(tier2Digest);

  const visibleBanner = buildVisibleBanner({
    recentSessions,
    aliases,
    projectInfo,
    pm,
    cwd
  });

  await writeSessionStartPayload(additionalContextParts.join('\n\n'), visibleBanner);
}

/**
 * Tier 2 session memory recall. Calls `npm run assay -- memory recall`
 * against the assaylabs repo if present; formats the top hits into a
 * compact block (≤~150 tokens) for injection into SessionStart context.
 *
 * Returns null if the CLI isn't available, the query produces no hits,
 * or anything errors. Never throws.
 */
function tryTier2Recall(cwd, projectInfo) {
  const assaylabsRoot = path.join(getHomeDir(), 'assaylabs');
  const assayCli = path.join(assaylabsRoot, 'bin', 'assay.ts');
  const tsxBin = path.join(assaylabsRoot, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(assayCli) || !fs.existsSync(tsxBin)) return null;

  // Build a concise recall query from cwd + project languages.
  const cwdName = path.basename(cwd);
  const langs = Array.isArray(projectInfo && projectInfo.languages)
    ? projectInfo.languages.slice(0, 3).join(' ')
    : '';
  const query = [cwdName, langs].filter(Boolean).join(' ').slice(0, 160) ||
    'recent session work';

  try {
    const res = spawnSync(
      tsxBin,
      [assayCli, 'memory', 'recall', query],
      {
        cwd: assaylabsRoot,
        env: {
          ...process.env,
          // Force local provider so this never hits OpenAI from a hook.
          EMBEDDING_PROVIDER: 'local',
        },
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const out = stripAnsi(res.stdout || '');
    // Parse the CLI's "  0.624  [kind]  title" lines.
    const hitLines = out
      .split('\n')
      .filter((l) => /^\s+\d+\.\d+\s+\[/.test(l))
      .slice(0, 3);
    if (hitLines.length === 0) return null;

    const escalateLine =
      out.split('\n').find((l) => l.trim().startsWith('⚠')) || '';

    const block = [
      `Tier 2 session memory — prior work potentially relevant to this session:`,
      ...hitLines.map((l) => l.trim()),
    ];
    if (escalateLine) block.push(escalateLine.trim());
    block.push(
      `(From ~/.assay/session-memory.db. Escalate to /assay-retrieve for citation-grade context.)`
    );
    return block.join('\n');
  } catch {
    return null;
  }
}

/**
 * Build a compact, human-visible banner shown in the Claude Code UI
 * at session start via the systemMessage field.
 */
function buildVisibleBanner({ recentSessions, aliases, projectInfo, pm, cwd }) {
  const lines = [];
  lines.push('🧠 ECC Session Loaded');

  if (recentSessions && recentSessions.length > 0) {
    const latest = recentSessions[0];
    const basename = path.basename(latest.path).replace(/-session\.tmp$/, '');
    lines.push(`• Resumed context from ${recentSessions.length} session(s); latest: ${basename}`);
  }

  // Morning brief / architect context (architect instance only)
  const architectPaths = ['/Users/levishantz', '/Users'];
  if (architectPaths.includes(cwd)) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const briefPath = path.join(getHomeDir(), '.claude', 'daily-review', 'briefs', `${today}.md`);
      if (fs.existsSync(briefPath)) lines.push(`• Morning brief loaded: ${today}`);
    } catch { /* noop */ }
    try {
      const ledgerPath = path.join(getHomeDir(), '.claude', 'sessions', 'architect-ledger.md');
      if (fs.existsSync(ledgerPath)) lines.push('• Architect ledger loaded');
    } catch { /* noop */ }
  }

  if (aliases && aliases.length > 0) {
    lines.push(`• ${aliases.length} session alias(es) available`);
  }

  if (projectInfo && (projectInfo.languages.length > 0 || projectInfo.frameworks.length > 0)) {
    const parts = [];
    if (projectInfo.languages.length > 0) parts.push(projectInfo.languages.join(', '));
    if (projectInfo.frameworks.length > 0) parts.push(projectInfo.frameworks.join(', '));
    lines.push(`• Project: ${parts.join(' / ')}`);
  }

  if (pm && pm.name) {
    lines.push(`• Package manager: ${pm.name}`);
  }

  return lines.join('\n');
}

function writeSessionStartPayload(additionalContext, systemMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const payloadObj = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      }
    };
    if (systemMessage) payloadObj.systemMessage = systemMessage;
    const payload = JSON.stringify(payloadObj);

    const handleError = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        log(`[SessionStart] stdout write error: ${err.message}`);
      }
      reject(err || new Error('stdout stream error'));
    };

    process.stdout.once('error', handleError);
    process.stdout.write(payload, (err) => {
      process.stdout.removeListener('error', handleError);
      if (settled) return;
      settled = true;
      if (err) {
        log(`[SessionStart] stdout write error: ${err.message}`);
        reject(err);
        return;
      }
      resolve();
    });
  });
}

main().catch(err => {
  console.error('[SessionStart] Error:', err.message);
  process.exitCode = 0; // Don't block on errors
});
