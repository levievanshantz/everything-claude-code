const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-end.js');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runStopHook({ lines, seedDebt: seed }) {
  const home = mkTmp('decision-debt-home-');
  const worktree = path.join(home, 'repo');
  const transcriptPath = path.join(home, 'transcript.jsonl');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(transcriptPath, lines.join('\n'));
  // process.cwd() resolves symlinks (macOS /var → /private/var); use the
  // realpath of the worktree to match the key the hook will write.
  const realWorktree = fs.realpathSync(worktree);
  if (seed) seedDebt(home, realWorktree, seed.count || 1);

  const res = spawnSync('node', [HOOK], {
    cwd: worktree,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_SESSION_ID: 'decisiondebt01'
    },
    input: JSON.stringify({ transcript_path: transcriptPath }),
    encoding: 'utf8'
  });

  assert.strictEqual(res.status, 0, `hook exited non-zero: ${res.stderr}`);

  return {
    home,
    worktree: realWorktree,
    debtPath: path.join(home, '.claude', 'session-data', '.tag-debt.json')
  };
}

function seedDebt(home, worktree, count) {
  const debtDir = path.join(home, '.claude', 'session-data');
  fs.mkdirSync(debtDir, { recursive: true });
  fs.writeFileSync(
    path.join(debtDir, '.tag-debt.json'),
    JSON.stringify({
      version: 1,
      entries: {
        [worktree]: {
          count,
          decision_count: 0,
          commits: ['feat: prior session work'],
          session_id: 'priorSession',
          updated_at: '2026-04-27T00:00:00.000Z'
        }
      }
    }, null, 2)
  );
}

(function main() {
  let case1, case2, case3, case4;
  try {
    // Case 1: 3 commits, 0 tags → debt MUST be written
    case1 = runStopHook({
      lines: [
        '{"type":"user","content":"ship the feature"}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"feat: add parser\\""}}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"fix: handle empty transcript\\""}}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"chore: wire stop hook\\""}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Committed the work."}]}}'
      ]
    });

    assert.ok(fs.existsSync(case1.debtPath), 'debt file should be written for non-compliant session');
    const debt = JSON.parse(fs.readFileSync(case1.debtPath, 'utf8'));
    const entry = debt.entries[case1.worktree];
    assert.ok(entry, 'debt entry should be keyed by cwd');
    assert.strictEqual(entry.count, 3, 'count should equal commits');
    assert.strictEqual(entry.decision_count, 0, 'decision_count should be 0');
    assert.strictEqual(entry.commits.length, 3, 'commits list should preserve all 3');
    assert.ok(entry.commits[0].includes('feat: add parser'), 'first commit message captured');

    // Case 2: 3 commits, 3 tags → NO debt file
    case2 = runStopHook({
      lines: [
        '{"type":"user","content":"ship the feature"}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"feat: add parser\\""}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"<decision impact=\\"medium\\" confidence=\\"high\\" layer=\\"implementation\\">Parser shape is now transcript-first.</decision>"}]}}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"fix: handle empty transcript\\""}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"<decision impact=\\"low\\" confidence=\\"high\\" layer=\\"implementation\\">Empty transcripts should no-op instead of error.</decision>"}]}}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"chore: wire stop hook\\""}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"<decision impact=\\"medium\\" confidence=\\"high\\" layer=\\"tooling\\">Stop hook owns compliance auditing.</decision>"}]}}'
      ]
    });

    assert.ok(!fs.existsSync(case2.debtPath), 'no debt file should be written for compliant session');

    // Case 3 (sticky): pre-existing debt + 0 commits this session → debt persists.
    case3 = runStopHook({
      seedDebt: { count: 4 },
      lines: [
        '{"type":"user","content":"just exploring, no commits"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Looked around, nothing to commit."}]}}'
      ]
    });
    assert.ok(fs.existsSync(case3.debtPath), 'debt file should remain when no commits this session');
    const debt3 = JSON.parse(fs.readFileSync(case3.debtPath, 'utf8'));
    assert.ok(debt3.entries[case3.worktree], 'debt entry should still exist');
    assert.strictEqual(debt3.entries[case3.worktree].count, 4, 'pre-existing count untouched');

    // Case 4 (clear-on-comply): pre-existing debt + 1 commit + 1 tag → debt cleared.
    case4 = runStopHook({
      seedDebt: { count: 4 },
      lines: [
        '{"type":"user","content":"clear it"}',
        '{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"git commit -m \\"feat: tagged commit\\""}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"<decision impact=\\"medium\\" confidence=\\"high\\" layer=\\"tooling\\">Cleared the prior debt by emitting a tag.</decision>"}]}}'
      ]
    });
    assert.ok(!fs.existsSync(case4.debtPath), 'debt file should be cleared when this session is compliant');

    console.log('ok — all 4 decision-debt cases pass (record / compliant / sticky / clear-on-comply)');
  } finally {
    if (case1) cleanup(case1.home);
    if (case2) cleanup(case2.home);
    if (case3) cleanup(case3.home);
    if (case4) cleanup(case4.home);
  }
})();
