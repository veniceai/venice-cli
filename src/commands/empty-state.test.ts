import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

function withFreshHome(callback: (run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-empty-state-test-'));
  try {
    callback((args) => spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, NO_COLOR: '1' },
    }));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('history and usage print empty JSON results on a fresh install', () => {
  withFreshHome((run) => {
    const list = run(['history', 'list', '-f', 'json']);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), []);

    const show = run(['history', 'show', '-f', 'json']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout), null);

    for (const args of [['usage', '-f', 'json'], ['usage', '--today', '-f', 'json']]) {
      const usage = run(args);
      assert.equal(usage.status, 0, usage.stderr);
      assert.deepEqual(JSON.parse(usage.stdout), {
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_calls: 0,
        by_command: {},
        by_model: {},
      });
    }
  });
});

test('history and usage keep their empty-state messages in pretty output', () => {
  withFreshHome((run) => {
    for (const args of [['history', 'list', '-f', 'pretty'], ['history', 'show', '-f', 'pretty']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'No conversation history found.\n', args.join(' '));
    }

    const usage = run(['usage', '-f', 'pretty']);
    assert.equal(usage.status, 0, usage.stderr);
    assert.equal(usage.stdout, 'No usage data recorded yet.\n');
  });
});

test('history show reports an unknown id even when there is no history', () => {
  withFreshHome((run) => {
    for (const args of [['history', 'show', 'abc123'], ['history', 'show', 'abc123', '-f', 'json']]) {
      const result = run(args);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Conversation not found: abc123/);
    }
  });
});
