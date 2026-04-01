#!/usr/bin/env node

/**
 * Weekly Maintenance Script
 * Runs via launchd every Sunday at 3am.
 *
 * 1. Pattern Consolidation — deduplicates learned patterns into consolidated.md
 * 2. Delta Archive Rotation — monthly rotation of .jsonl delta files
 * 3. Stale Artifact Detection — flags stale config files in maintenance-report.txt
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getClaudeDir, getLearnedSkillsDir } = require('./lib/utils');

const CLAUDE_DIR = getClaudeDir();
const LEARNED_DIR = getLearnedSkillsDir();
const DELTAS_DIR = path.join(CLAUDE_DIR, 'deltas');
const DAILY_REVIEW_DIR = path.join(CLAUDE_DIR, 'daily-review');
const INSTANCE_REGISTRY = path.join(DAILY_REVIEW_DIR, 'instance-registry.json');
const STRATEGY_FILE = '/Users/levishantz/intelligence-ledger-prototype/STRATEGY.md';
const MAX_CONSOLIDATED_SIZE = 5 * 1024; // 5KB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[weekly-maintenance] ${new Date().toISOString()} ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function daysSinceModified(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch {
    return Infinity;
  }
}

// ---------------------------------------------------------------------------
// 1. Pattern Consolidation
// ---------------------------------------------------------------------------

function consolidatePatterns() {
  log('Starting pattern consolidation...');

  if (!fs.existsSync(LEARNED_DIR)) {
    log('No learned skills directory found. Skipping consolidation.');
    return;
  }

  const files = fs.readdirSync(LEARNED_DIR).filter(
    f => f.endsWith('.md') && f !== 'consolidated.md'
  );

  if (files.length === 0) {
    log('No pattern files to consolidate.');
    return;
  }

  log(`Found ${files.length} pattern files to process.`);

  // Pattern buckets aligned with CL-v2 categories
  const buckets = {
    'Tool Patterns': {},
    'File Patterns': {},
    'Preference Patterns': {},
    'Workflow Patterns': {},
  };

  // Map section headers from pattern files to our buckets
  const sectionMap = {
    'tool usage': 'Tool Patterns',
    'mcp integration': 'Tool Patterns',
    'file types': 'File Patterns',
    'project areas': 'File Patterns',
    'user preferences': 'Preference Patterns',
    'session intensity': 'Workflow Patterns',
    'multi file edit': 'Workflow Patterns',
    'delegation workflow': 'Workflow Patterns',
  };

  for (const file of files) {
    const filePath = path.join(LEARNED_DIR, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Extract everything under "## Extracted Patterns"
    const patternsMatch = content.match(/## Extracted Patterns\s*\n([\s\S]*?)(?=\n## Session Tasks|\n## Session Summary|$)/);
    if (!patternsMatch) continue;

    const patternsBlock = patternsMatch[1];

    // Parse subsections (### Header) and their bullet items
    let currentBucket = 'Workflow Patterns';
    for (const line of patternsBlock.split('\n')) {
      const headerMatch = line.match(/^###\s+(.+)/);
      if (headerMatch) {
        const key = headerMatch[1].trim().toLowerCase();
        currentBucket = sectionMap[key] || 'Workflow Patterns';
        continue;
      }

      const bulletMatch = line.match(/^- (.+)/);
      if (bulletMatch) {
        const desc = bulletMatch[1].trim();
        // Skip noisy/non-actionable items (task notifications, raw user quotes)
        if (desc.startsWith('"<task-notification>') || desc.startsWith('"<') || desc.length > 200) {
          continue;
        }
        if (!buckets[currentBucket][desc]) {
          buckets[currentBucket][desc] = 0;
        }
        buckets[currentBucket][desc]++;
      }
    }
  }

  // Build consolidated output
  const now = new Date().toISOString().slice(0, 10);
  let uniqueCount = 0;
  const sections = [];

  for (const [section, patterns] of Object.entries(buckets)) {
    const entries = Object.entries(patterns)
      .sort((a, b) => b[1] - a[1]); // most frequent first

    if (entries.length === 0) continue;

    // Deduplicate: keep all, but mark count. For items seen <3 times, still include
    // but prioritize high-frequency ones if we need to truncate for size.
    const lines = entries.map(([desc, count]) => {
      uniqueCount++;
      return count >= 3
        ? `- ${desc} (seen ${count} times)`
        : `- ${desc}`;
    });

    sections.push(`## ${section}\n${lines.join('\n')}`);
  }

  let output = `# Consolidated Patterns
**Last consolidated:** ${now}
**Source files:** ${files.length}
**Unique patterns:** ${uniqueCount}

${sections.join('\n\n')}
`;

  // Enforce 5KB limit by trimming low-frequency patterns from the bottom
  while (Buffer.byteLength(output, 'utf-8') > MAX_CONSOLIDATED_SIZE) {
    // Find the last single-occurrence pattern line and remove it
    const lines = output.split('\n');
    let removed = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('- ') && !lines[i].includes('(seen ')) {
        lines.splice(i, 1);
        uniqueCount--;
        removed = true;
        break;
      }
    }
    if (!removed) {
      // If all remaining are high-frequency, trim from end
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('- ')) {
          lines.splice(i, 1);
          uniqueCount--;
          removed = true;
          break;
        }
      }
    }
    if (!removed) break;
    // Update the count in header
    output = lines.join('\n').replace(
      /\*\*Unique patterns:\*\* \d+/,
      `**Unique patterns:** ${uniqueCount}`
    );
  }

  const consolidatedPath = path.join(LEARNED_DIR, 'consolidated.md');
  fs.writeFileSync(consolidatedPath, output, 'utf-8');
  log(`Wrote consolidated.md (${Buffer.byteLength(output, 'utf-8')} bytes, ${uniqueCount} unique patterns).`);

  // Archive raw files
  const archiveDir = path.join(LEARNED_DIR, 'archive');
  ensureDir(archiveDir);

  let archived = 0;
  for (const file of files) {
    const src = path.join(LEARNED_DIR, file);
    const dst = path.join(archiveDir, file);
    try {
      fs.renameSync(src, dst);
      archived++;
    } catch (err) {
      log(`Warning: could not archive ${file}: ${err.message}`);
    }
  }
  log(`Archived ${archived} pattern files to ${archiveDir}`);
}

// ---------------------------------------------------------------------------
// 2. Delta Archive Rotation
// ---------------------------------------------------------------------------

function rotateDeltaArchives() {
  const now = new Date();
  // Check if today is the 1st of the month (or close — launchd runs Sundays,
  // so we check if we're within the first 7 days and haven't rotated yet this month)
  if (now.getDate() > 7) {
    log('Not first week of month. Skipping delta rotation.');
    return;
  }

  if (!fs.existsSync(DELTAS_DIR)) {
    log('No deltas directory found. Skipping rotation.');
    return;
  }

  const archiveDir = path.join(DELTAS_DIR, 'archive');
  ensureDir(archiveDir);

  // Check if we already rotated this month
  const monthTag = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const existingArchives = fs.readdirSync(archiveDir);
  const alreadyRotated = existingArchives.some(f => f.startsWith(monthTag));
  if (alreadyRotated) {
    log(`Delta archives already rotated for ${monthTag}. Skipping.`);
    return;
  }

  // Use previous month for archive naming
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevTag = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

  const jsonlFiles = fs.readdirSync(DELTAS_DIR).filter(f => f.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) {
    log('No .jsonl delta files to rotate.');
    return;
  }

  log(`Rotating ${jsonlFiles.length} delta files for ${prevTag}...`);

  for (const file of jsonlFiles) {
    const src = path.join(DELTAS_DIR, file);
    const baseName = path.basename(file, '.jsonl');
    const dst = path.join(archiveDir, `${prevTag}-${baseName}.jsonl`);

    try {
      fs.copyFileSync(src, dst);
      fs.writeFileSync(src, '', 'utf-8'); // truncate
      log(`  Rotated ${file} -> archive/${path.basename(dst)}`);
    } catch (err) {
      log(`  Warning: could not rotate ${file}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Stale Artifact Detection
// ---------------------------------------------------------------------------

function detectStaleArtifacts() {
  log('Checking for stale artifacts...');

  const STALE_DAYS = 7;
  const report = [];
  const now = new Date();

  report.push(`# Maintenance Report`);
  report.push(`**Generated:** ${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`);
  report.push('');

  // Check instance registry
  const staleFiles = [];

  if (fs.existsSync(INSTANCE_REGISTRY)) {
    const days = daysSinceModified(INSTANCE_REGISTRY);
    if (days > STALE_DAYS) {
      staleFiles.push(`- instance-registry.json (${Math.floor(days)} days old)`);
    }
  } else {
    staleFiles.push('- instance-registry.json (MISSING)');
  }

  // Check CLAUDE.md files from instance registry
  if (fs.existsSync(INSTANCE_REGISTRY)) {
    try {
      const registry = JSON.parse(fs.readFileSync(INSTANCE_REGISTRY, 'utf-8'));
      const instances = registry.instances || [];
      for (const inst of instances) {
        if (inst.claude_md) {
          if (!fs.existsSync(inst.claude_md)) {
            staleFiles.push(`- ${inst.name} CLAUDE.md (MISSING: ${inst.claude_md})`);
          } else {
            const days = daysSinceModified(inst.claude_md);
            if (days > STALE_DAYS) {
              staleFiles.push(`- ${inst.name} CLAUDE.md (${Math.floor(days)} days old)`);
            }
          }
        }
      }
    } catch (err) {
      staleFiles.push(`- instance-registry.json (PARSE ERROR: ${err.message})`);
    }
  }

  // Check STRATEGY.md
  if (fs.existsSync(STRATEGY_FILE)) {
    const days = daysSinceModified(STRATEGY_FILE);
    if (days > STALE_DAYS) {
      staleFiles.push(`- STRATEGY.md (${Math.floor(days)} days old)`);
    }
  } else {
    staleFiles.push('- STRATEGY.md (MISSING)');
  }

  if (staleFiles.length > 0) {
    report.push('## Stale Artifacts (>7 days)');
    report.push(...staleFiles);
  } else {
    report.push('## Stale Artifacts');
    report.push('All monitored files are fresh.');
  }

  report.push('');
  report.push('## Pattern Consolidation');
  const consolidatedPath = path.join(LEARNED_DIR, 'consolidated.md');
  if (fs.existsSync(consolidatedPath)) {
    const size = fs.statSync(consolidatedPath).size;
    report.push(`- consolidated.md exists (${size} bytes)`);
  } else {
    report.push('- consolidated.md not found');
  }

  const archiveDir = path.join(LEARNED_DIR, 'archive');
  if (fs.existsSync(archiveDir)) {
    const count = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md')).length;
    report.push(`- ${count} archived pattern files`);
  }

  report.push('');
  report.push('## Delta Archives');
  const deltaArchiveDir = path.join(DELTAS_DIR, 'archive');
  if (fs.existsSync(deltaArchiveDir)) {
    const archives = fs.readdirSync(deltaArchiveDir);
    report.push(`- ${archives.length} archived delta files`);
  } else {
    report.push('- No delta archives yet');
  }

  const reportPath = path.join(DAILY_REVIEW_DIR, 'maintenance-report.txt');
  ensureDir(DAILY_REVIEW_DIR);
  fs.writeFileSync(reportPath, report.join('\n') + '\n', 'utf-8');
  log(`Wrote maintenance report to ${reportPath}`);
}

// ---------------------------------------------------------------------------
// 4. Skill Health Report
// ---------------------------------------------------------------------------

function appendSkillHealthReport() {
  log('Running skill health report...');

  try {
    const { collectSkillHealth, formatHealthReport, summarizeHealthReport } = require('./lib/skill-evolution/health');
    const report = collectSkillHealth({ now: new Date().toISOString(), homeDir: os.homedir() });
    const summary = summarizeHealthReport(report);

    const reportPath = path.join(DAILY_REVIEW_DIR, 'maintenance-report.txt');
    const lines = [];
    lines.push('');
    lines.push('## Skill Health');
    lines.push(`- Total skills: ${summary.total_skills || summary.total || 0}`);
    lines.push(`- Healthy: ${summary.healthy_skills || summary.healthy || 0}`);
    lines.push(`- Declining: ${summary.declining_skills || summary.declining || 0}`);

    if (summary.declining > 0 && Array.isArray(summary.decliningSkills)) {
      lines.push('- Declining skills:');
      for (const name of summary.decliningSkills) {
        lines.push(`  - ${name}`);
      }
    } else if (summary.declining > 0 && Array.isArray(report.skills)) {
      // Fallback: extract declining skill names from the full report
      const declining = report.skills.filter(s => s.status === 'declining');
      if (declining.length > 0) {
        lines.push('- Declining skills:');
        for (const s of declining) {
          lines.push(`  - ${s.name || s.id || 'unknown'}`);
        }
      }
    }

    ensureDir(DAILY_REVIEW_DIR);
    fs.appendFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
    log(`Appended skill health to ${reportPath}`);
  } catch (err) {
    log(`ERROR in skill health report (non-fatal): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Harness Audit
// ---------------------------------------------------------------------------

function appendHarnessAudit() {
  log('Running harness audit...');

  try {
    const { buildReport } = require('./harness-audit');
    const auditReport = buildReport('repo');

    const reportPath = path.join(DAILY_REVIEW_DIR, 'maintenance-report.txt');
    const lines = [];
    lines.push('');
    lines.push('## Harness Audit');
    lines.push(`- Overall score: ${auditReport.overall_score != null ? auditReport.overall_score : 'N/A'}`);

    if (Array.isArray(auditReport.top_actions) && auditReport.top_actions.length > 0) {
      lines.push('- Top actions:');
      for (const action of auditReport.top_actions) {
        lines.push(`  - ${action.action || JSON.stringify(action)}`);
      }
    }

    ensureDir(DAILY_REVIEW_DIR);
    fs.appendFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
    log(`Appended harness audit to ${reportPath}`);
  } catch (err) {
    log(`ERROR in harness audit (non-fatal): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Obsidian Vault Rebuild
// ---------------------------------------------------------------------------

const VAULT_DIR = path.join(os.homedir(), 'Documents', 'assay-memory-vault');
const MEMORY_DIR = path.join(CLAUDE_DIR, 'projects', '-Users', 'memory');

function rebuildObsidianVault() {
  log('Rebuilding Obsidian vault...');
  const now = new Date().toISOString().slice(0, 10);

  // Ensure dirs
  for (const sub of ['memories', 'instances', 'systems', 'deltas']) {
    ensureDir(path.join(VAULT_DIR, sub));
  }

  // --- 1. Memory files ---
  const memoryFiles = [];
  if (fs.existsSync(MEMORY_DIR)) {
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      const src = path.join(MEMORY_DIR, file);
      let content;
      try { content = fs.readFileSync(src, 'utf-8'); } catch { continue; }

      // Parse frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const name = file.replace('.md', '');
      let type = 'memory';
      let description = '';
      if (fmMatch) {
        const fm = fmMatch[1];
        const typeMatch = fm.match(/type:\s*(.+)/);
        const descMatch = fm.match(/description:\s*(.+)/);
        if (typeMatch) type = typeMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
      }

      // Build cross-links from content
      const body = fmMatch ? fmMatch[2] : content;
      const crossLinks = [];

      // Link to instances mentioned
      if (body.includes('intelligence-ledger') || body.includes('ILP')) crossLinks.push('[[ilp]]');
      if (body.includes('everything-claude-code') || body.includes('ECC')) crossLinks.push('[[ecc]]');
      if (body.includes('sam-assistant')) crossLinks.push('[[sam-assistant]]');
      if (body.includes('assay-mcp')) crossLinks.push('[[assay-mcp]]');

      // Link to systems mentioned
      if (body.includes('delta') || body.includes('JSONL')) crossLinks.push('[[Delta Protocol]]');
      if (body.includes('extraction') || body.includes('corpus')) crossLinks.push('[[Extraction Pipeline]]');
      if (body.includes('agent') || body.includes('subagent')) crossLinks.push('[[Agent Orchestration]]');
      if (body.includes('CLAUDE.md')) crossLinks.push('[[CLAUDE.md System]]');
      if (body.includes('Notion')) crossLinks.push('[[Notion Integration]]');
      if (body.includes('daily-review') || body.includes('brief')) crossLinks.push('[[Daily Review System]]');
      if (body.includes('pattern') || body.includes('skill')) crossLinks.push('[[Learning Pipeline]]');

      const uniqueLinks = [...new Set(crossLinks)];

      const obsidianContent = `---
tags: [memory, ${type}]
type: ${type}
source: ${file}
updated: ${now}
---

# ${name}

${description ? `> ${description}\n` : ''}
${body.trim()}

## Connections
${uniqueLinks.length > 0 ? uniqueLinks.join('\n') : '*No cross-links detected*'}
`;
      fs.writeFileSync(path.join(VAULT_DIR, 'memories', `${name}.md`), obsidianContent, 'utf-8');
      memoryFiles.push(name);
    }
  }

  // --- 2. Instance nodes ---
  const instanceNodes = [];
  if (fs.existsSync(INSTANCE_REGISTRY)) {
    try {
      const registry = JSON.parse(fs.readFileSync(INSTANCE_REGISTRY, 'utf-8'));
      for (const inst of (registry.instances || [])) {
        const isAssay = ['ilp', 'assay-mcp', 'assaylabs-site'].includes(inst.name);
        const links = ['[[Instance Map]]'];
        if (isAssay) links.push('[[Delta Protocol]]', '[[Extraction Pipeline]]');
        links.push('[[Daily Review System]]');
        if (inst.has_git) links.push('[[CLAUDE.md System]]');

        // Check CLAUDE.md freshness
        let freshness = 'unknown';
        if (inst.claude_md && fs.existsSync(inst.claude_md)) {
          const days = Math.floor(daysSinceModified(inst.claude_md));
          freshness = days <= 7 ? `fresh (${days}d)` : `stale (${days}d)`;
        }

        const instContent = `---
tags: [instance, ${inst.type}]
type: ${inst.type}
path: ${inst.path}
updated: ${now}
---

# ${inst.label}

**ID:** \`${inst.name}\`
**Type:** ${inst.type}
**Path:** \`${inst.path}\`
**Git:** ${inst.has_git ? 'Yes' : 'No'}
**CLAUDE.md:** ${freshness}
${inst.notes ? `\n> ${inst.notes}` : ''}

## Connections
${links.join('\n')}
`;
        fs.writeFileSync(path.join(VAULT_DIR, 'instances', `${inst.name}.md`), instContent, 'utf-8');
        instanceNodes.push(inst.name);
      }
    } catch (err) {
      log(`Warning: could not parse instance registry: ${err.message}`);
    }
  }

  // --- 3. System concept nodes ---
  const systems = {
    'Delta Protocol': {
      desc: 'Append-only JSONL logs written by session-end, read by session-start. Cross-instance awareness.',
      links: () => {
        const l = ['[[session-end.js]]', '[[session-start.js]]', '[[Memory Map]]'];
        // Link to instances that produce deltas
        if (fs.existsSync(DELTAS_DIR)) {
          const files = fs.readdirSync(DELTAS_DIR).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            const name = f.replace('.jsonl', '');
            if (name === 'assay') l.push('[[ilp]]', '[[assay-mcp]]', '[[assaylabs-site]]', '[[ecc]]');
            else if (instanceNodes.includes(name)) l.push(`[[${name}]]`);
          }
        }
        return [...new Set(l)];
      }
    },
    'Daily Review System': {
      desc: 'Morning brief (7am) + EOD wrap-up (5:15pm) via launchd. Synthesizes cross-instance activity.',
      links: () => ['[[Instance Map]]', '[[Delta Protocol]]', ...instanceNodes.map(n => `[[${n}]]`)]
    },
    'Learning Pipeline': {
      desc: 'Observe patterns per session → consolidate weekly → surface as skills. 226→1 consolidated.md.',
      links: () => {
        const l = ['[[session-end.js]]', '[[Weekly Maintenance]]'];
        const consolidated = path.join(LEARNED_DIR, 'consolidated.md');
        if (fs.existsSync(consolidated)) {
          const size = fs.statSync(consolidated).size;
          l.push(`Consolidated: ${size} bytes`);
        }
        return l;
      }
    },
    'Extraction Pipeline': {
      desc: 'Stateless claim extraction from Notion corpus. Each section = fresh subagent, no context accumulation.',
      links: () => ['[[feedback_context_isolation]]', '[[feedback_velocity_block]]', '[[ilp]]', '[[Agent Orchestration]]']
    },
    'Agent Orchestration': {
      desc: 'Multi-agent deployment patterns. Test 1 first, then scale. Never change architecture mid-run.',
      links: () => ['[[feedback_agent_discipline]]', '[[Extraction Pipeline]]', '[[ilp]]']
    },
    'Notion Integration': {
      desc: 'MCP-connected Notion workspace. Nightly sync (4am), evidence retrieval, PRD management.',
      links: () => ['[[ilp]]', '[[Daily Review System]]', '[[feedback_eval_include_urls]]']
    },
    'CLAUDE.md System': {
      desc: 'Per-project instruction files. Must be updated whenever work ships. Orchestrator-managed marker.',
      links: () => {
        const l = ['[[feedback_claudemd_update]]', '[[Memory Map]]'];
        for (const inst of instanceNodes) l.push(`[[${inst}]]`);
        return l;
      }
    },
    'Weekly Maintenance': {
      desc: 'Sunday 3am via launchd. Pattern consolidation, delta rotation, stale detection, skill health, harness audit, vault rebuild.',
      links: () => ['[[Learning Pipeline]]', '[[Delta Protocol]]', '[[CLAUDE.md System]]']
    },
    'Scoped Feedback Injection': {
      desc: 'Universal rules (3 files) for ALL sessions. ILP-scoped rules (3 files) for Assay paths only.',
      links: () => {
        const l = ['[[session-start.js]]', '[[Memory Map]]'];
        for (const m of memoryFiles) {
          if (m.startsWith('feedback_')) l.push(`[[${m}]]`);
        }
        return l;
      }
    }
  };

  // Hook nodes
  const hooks = {
    'session-start.js': {
      desc: 'Fires once on conversation open. Injects feedback rules + recent deltas.',
      links: ['[[Delta Protocol]]', '[[Scoped Feedback Injection]]', '[[ecc]]']
    },
    'session-end.js': {
      desc: 'Fires after each assistant turn (Stop hook). Writes delta, records skill observations.',
      links: ['[[Delta Protocol]]', '[[Learning Pipeline]]', '[[ecc]]']
    }
  };

  for (const [name, info] of Object.entries(systems)) {
    const resolvedLinks = typeof info.links === 'function' ? info.links() : info.links;
    const uniqueLinks = [...new Set(resolvedLinks)];
    const content = `---
tags: [system]
updated: ${now}
---

# ${name}

> ${info.desc}

## Connections
${uniqueLinks.join('\n')}
`;
    fs.writeFileSync(path.join(VAULT_DIR, 'systems', `${name}.md`), content, 'utf-8');
  }

  for (const [name, info] of Object.entries(hooks)) {
    const content = `---
tags: [hook]
updated: ${now}
---

# ${name}

> ${info.desc}

## Connections
${info.links.join('\n')}
`;
    fs.writeFileSync(path.join(VAULT_DIR, 'systems', `${name}.md`), content, 'utf-8');
  }

  // --- 4. Delta activity summary ---
  if (fs.existsSync(DELTAS_DIR)) {
    const jsonlFiles = fs.readdirSync(DELTAS_DIR).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = path.join(DELTAS_DIR, file);
      const deltaName = file.replace('.jsonl', '');
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
        const deltas = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        // Last 10 deltas
        const recent = deltas.slice(-10);
        const entries = recent.map(d => {
          const time = new Date(d.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          const flag = d.review_flag ? ' ⚠' : '';
          return `- **${time}** [${d.workstream}] ${d.summary || d.type}${flag}`;
        });

        // Workstream breakdown
        const wsCounts = {};
        for (const d of deltas) {
          wsCounts[d.workstream] = (wsCounts[d.workstream] || 0) + 1;
        }
        const wsBreakdown = Object.entries(wsCounts).map(([ws, c]) => `- [[${ws === 'ecc' ? 'ecc' : ws}]]: ${c} sessions`);

        const content = `---
tags: [delta-log]
updated: ${now}
---

# Deltas: ${deltaName}

**Total entries:** ${deltas.length}
**File:** \`~/.claude/deltas/${file}\`

## Workstream Breakdown
${wsBreakdown.join('\n')}

## Recent Activity (last 10)
${entries.join('\n')}

## Connections
[[Delta Protocol]]
`;
        fs.writeFileSync(path.join(VAULT_DIR, 'deltas', `${deltaName}.md`), content, 'utf-8');
      } catch (err) {
        log(`Warning: could not process ${file}: ${err.message}`);
      }
    }
  }

  // --- 5. Hub pages ---
  // Memory Map
  const memoryMapLinks = memoryFiles.map(m => {
    const type = m.startsWith('feedback_') ? 'feedback' : m.startsWith('project_') ? 'project' : m.startsWith('architecture') ? 'architecture' : 'memory';
    return `- [[${m}]] (${type})`;
  });
  const memoryMap = `---
tags: [hub]
updated: ${now}
---

# Memory Map

## Memory Files
${memoryMapLinks.join('\n')}

## Systems
${Object.keys(systems).map(s => `- [[${s}]]`).join('\n')}

## Hooks
${Object.keys(hooks).map(h => `- [[${h}]]`).join('\n')}
`;
  fs.writeFileSync(path.join(VAULT_DIR, 'Memory Map.md'), memoryMap, 'utf-8');

  // Instance Map
  const instanceMap = `---
tags: [hub]
updated: ${now}
---

# Instance Map

## Active Instances
${instanceNodes.map(n => `- [[${n}]]`).join('\n')}

## Coordination
- [[Delta Protocol]]
- [[Daily Review System]]
- [[Scoped Feedback Injection]]
- [[CLAUDE.md System]]
`;
  fs.writeFileSync(path.join(VAULT_DIR, 'Instance Map.md'), instanceMap, 'utf-8');

  // Clean up old top-level stubs that are now in subdirs
  const stubs = ['Agent Orchestration.md', 'CLAUDE.md.md', 'Daily Review System.md',
    'Extraction Pipeline.md', 'MCP Server.md', 'Notion Integration.md',
    'Operating Protocol.md', 'PRD Process.md', 'V3 Extraction.md'];
  for (const stub of stubs) {
    const p = path.join(VAULT_DIR, stub);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }

  log(`Vault rebuilt: ${memoryFiles.length} memories, ${instanceNodes.length} instances, ${Object.keys(systems).length + Object.keys(hooks).length} system nodes.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log('=== Weekly Maintenance Starting ===');

  try {
    consolidatePatterns();
  } catch (err) {
    log(`ERROR in pattern consolidation: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  try {
    rotateDeltaArchives();
  } catch (err) {
    log(`ERROR in delta rotation: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  try {
    detectStaleArtifacts();
  } catch (err) {
    log(`ERROR in stale artifact detection: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  // Skill health and harness audit — each wrapped in try/catch so one failing
  // does not block the other or the rest of maintenance.
  try {
    appendSkillHealthReport();
  } catch (err) {
    log(`ERROR in skill health report (non-fatal): ${err.message}`);
  }

  try {
    appendHarnessAudit();
  } catch (err) {
    log(`ERROR in harness audit (non-fatal): ${err.message}`);
  }

  try {
    rebuildObsidianVault();
  } catch (err) {
    log(`ERROR in Obsidian vault rebuild (non-fatal): ${err.message}`);
  }

  log('=== Weekly Maintenance Complete ===');
  process.exit(0);
}

main();
