import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

function runCli(args: string[], homeDir: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      NO_COLOR: '1',
    },
  });
}

test('config show --format json masks api_key', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));

  try {
    const setResult = runCli(['config', 'set', 'api_key', 'sk-test-1234567890'], homeDir);
    assert.equal(setResult.status, 0, setResult.stderr);

    const showResult = runCli(['config', 'show', '--format', 'json'], homeDir);
    assert.equal(showResult.status, 0, showResult.stderr);

    const parsed = JSON.parse(showResult.stdout);
    assert.equal(parsed.api_key, 'sk-t...7890');
    assert.ok(!showResult.stdout.includes('sk-test-1234567890'));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
