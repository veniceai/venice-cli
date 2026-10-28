import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

test('config show suggests setting the API key without putting it on the command line', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-show-test-'));
  try {
    const result = spawnSync(process.execPath, [cliPath, 'config', 'show'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Tip: Set the API key with "venice config set api_key" or pipe it to "venice config set api_key --stdin"\./
    );
    assert.match(result.stdout, /Use "venice config set <key> <value>" for other settings\./);
    assert.doesNotMatch(result.stdout, /to update settings/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
