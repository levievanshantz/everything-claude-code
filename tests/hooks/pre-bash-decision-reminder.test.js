const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-hook-'));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Bust the utils require cache so getSessionsDir() uses the new HOME.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/scripts/lib/') || key.includes('/scripts/hooks/pre-bash-decision-reminder')) {
      delete require.cache[key];
    }
  }
  try {
    return fn(home);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserprofile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function captureStderr(fn) {
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, encoding, cb) => {
    captured += String(chunk);
    if (typeof cb === 'function') cb();
    return true;
  };
  try {
    fn();
    return captured;
  } finally {
    process.stderr.write = origWrite;
  }
}

function makeInput(command, sessionId) {
  return JSON.stringify({
    session_id: sessionId,
    tool_input: { command },
  });
}

(function main() {
  // Case 1: first git commit fires reminder; state file written.
  withTempHome(home => {
    const { evaluate } = require('../../scripts/hooks/pre-bash-decision-reminder');
    const stderr1 = captureStderr(() => {
      const r = evaluate(makeInput('git commit -m "feat: thing"', 'sess-A'));
      assert.strictEqual(r.exitCode, 0, 'must exit 0 (warning, not gate)');
    });
    assert.ok(stderr1.includes('[DecisionTagReminder]'), 'reminder should print on first commit');

    const statePath = path.join(home, '.claude', 'session-data', '.commit-reminder-state.json');
    assert.ok(fs.existsSync(statePath), 'state file should be written');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(state.sessions['sess-A'].first_commit_fired, true);

    // Case 2: second git commit in SAME session is silent.
    const stderr2 = captureStderr(() => {
      evaluate(makeInput('git commit -m "fix: another"', 'sess-A'));
    });
    assert.ok(!stderr2.includes('[DecisionTagReminder]'), 'reminder should NOT re-fire in same session');

    // Case 3: a different session_id fires its own reminder.
    const stderr3 = captureStderr(() => {
      evaluate(makeInput('git commit -m "feat: other session"', 'sess-B'));
    });
    assert.ok(stderr3.includes('[DecisionTagReminder]'), 'new session should get its own reminder');

    // Case 4: --amend is ignored entirely (no fire, no state write).
    withTempHome(home2 => {
      const { evaluate: ev2 } = require('../../scripts/hooks/pre-bash-decision-reminder');
      const stderr4 = captureStderr(() => {
        ev2(makeInput('git commit --amend --no-edit', 'sess-C'));
      });
      assert.ok(!stderr4.includes('[DecisionTagReminder]'), 'amend must not trigger reminder');
      const sp = path.join(home2, '.claude', 'session-data', '.commit-reminder-state.json');
      assert.ok(!fs.existsSync(sp), 'amend must not write session state');
    });

    // Case 5: non-commit Bash command is ignored.
    withTempHome(home3 => {
      const { evaluate: ev3 } = require('../../scripts/hooks/pre-bash-decision-reminder');
      const stderr5 = captureStderr(() => {
        ev3(makeInput('git status', 'sess-D'));
      });
      assert.ok(!stderr5.includes('[DecisionTagReminder]'), 'git status must not trigger');
    });

    console.log('ok — all 5 decision-reminder cases pass (fire / re-fire-suppressed / new-session / amend-skip / non-commit-skip)');
  });
})();
