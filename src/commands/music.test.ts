import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/test-env.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: childEnv({
      NO_COLOR: '1',
      VENICE_API_KEY: 'test-key',
    }),
  });
}

test('music help lists the asynchronous audio workflow', () => {
  const result = runCli(['music', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /generate/);
  assert.match(result.stdout, /quote/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /retrieve/);
  assert.match(result.stdout, /complete/);
  assert.match(result.stdout, /models/);
});

test('music generate rejects invalid duration before sending a request', () => {
  const result = runCli(['music', 'generate', '--duration', '1.5', 'rain sounds']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--duration must be a positive integer/);
});

test('models help includes the music model type', () => {
  const result = runCli(['models', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /music/);
});
