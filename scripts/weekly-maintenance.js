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

  log('=== Weekly Maintenance Complete ===');
  process.exit(0);
}

main();
