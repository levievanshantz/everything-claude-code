/**
 * Tests for scripts/hooks/pre-compact.js
 *
 * Run with: node tests/hooks/pre-compact.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-compact.js');

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pre-compact-'));
}

function cleanupTempDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function runTests() {
  console.log('\n=== Testing pre-compact.js ===\n');

  let passed = 0;
  let failed = 0;

  if (await asyncTest('writes architect ledger when input.cwd is architect path despite different process.cwd', async () => {
    const tempHome = createTempDir();
    const sandboxDir = path.join(tempHome, 'sandbox');
    fs.mkdirSync(sandboxDir);

    const transcriptPath = path.join(tempHome, 'tx.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user',
      content: 'architect-mode regression test'
    }) + '\n');

    try {
      // Hook process cwd is sandbox (NOT architect), but input.cwd is /Users/levishantz
      // (architect path). Pre-fix: ledger skipped because isArchitectInstance() read
      // process.cwd(). Post-fix: ledger fires because input.cwd is honored.
      const result = spawnSync('node', [script], {
        input: JSON.stringify({
          transcript_path: transcriptPath,
          cwd: '/Users/levishantz',
          hook_event_name: 'PreCompact'
        }),
        cwd: sandboxDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          ECC_HOOK_PROFILE: 'standard',
          HOME: tempHome,
          USERPROFILE: tempHome
        },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      assert.strictEqual(result.status || 0, 0, `Expected exit 0, got ${result.status}`);
      assert.ok(
        /\[PreCompact\] Architect ledger written/.test(result.stderr),
        `Expected architect ledger to fire from input.cwd, got stderr: ${result.stderr}`
      );

      // Verify the ledger file actually exists
      const ledgerPath = path.join(tempHome, '.claude', 'sessions', 'architect-ledger.md');
      assert.ok(fs.existsSync(ledgerPath), `Expected ledger at ${ledgerPath}`);
    } finally {
      cleanupTempDir(tempHome);
    }
  })) passed++; else failed++;

  if (await asyncTest('does not write architect ledger when input.cwd is non-architect', async () => {
    const tempHome = createTempDir();
    const projectDir = path.join(tempHome, 'some-project');
    fs.mkdirSync(projectDir);

    const transcriptPath = path.join(tempHome, 'tx.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user',
      content: 'non-architect run'
    }) + '\n');

    try {
      const result = spawnSync('node', [script], {
        input: JSON.stringify({
          transcript_path: transcriptPath,
          cwd: projectDir,
          hook_event_name: 'PreCompact'
        }),
        cwd: '/Users/levishantz', // process.cwd is architect, but input.cwd is project
        encoding: 'utf8',
        env: {
          ...process.env,
          ECC_HOOK_PROFILE: 'standard',
          HOME: tempHome,
          USERPROFILE: tempHome
        },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      assert.strictEqual(result.status || 0, 0, `Expected exit 0, got ${result.status}`);
      assert.ok(
        !/Architect ledger written/.test(result.stderr),
        `Expected no architect ledger when input.cwd is non-architect, got stderr: ${result.stderr}`
      );
    } finally {
      cleanupTempDir(tempHome);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
