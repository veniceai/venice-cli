import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const OSC52 = `\x1b]52;c;${Buffer.from('echo copied').toString('base64')}\x07`;
const PAYLOAD = `${OSC52}\x1b[2K\u009d0;title\u009c\u009b2Jsafe\u202Etxt.exe\u202C`;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function runUsage(home: string, args: string[], terminal: boolean) {
  return spawnSync(process.execPath, [cliPath, 'usage', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      VENICE_TEST_TERMINAL_OUTPUT: terminal ? '1' : '',
    },
  });
}

test('usage prints stored command and model names through the terminal sanitiser', () => {
  const home = mkdtempSync(join(tmpdir(), 'venice-usage-'));
  const timestamp = new Date().toISOString();
  try {
    mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.venice', 'usage.json'), JSON.stringify([
      { timestamp, command: `chat${PAYLOAD}`, model: `model${PAYLOAD}`, prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      { timestamp, command: 'image', model: 'flux', prompt_tokens: `4${PAYLOAD}`, total_tokens: `9${PAYLOAD}` },
    ]));

    const terminal = runUsage(home, [], true);
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.doesNotMatch(terminal.stdout, UNSAFE, JSON.stringify(terminal.stdout));
    assert.match(terminal.stdout, /Total Tokens: 3\n/);
    assert.match(terminal.stdout, /Prompt: 1\n/);
    assert.match(terminal.stdout, /chatsafetxt\.exe\s+1 calls, 3 tokens/);
    assert.match(terminal.stdout, /modelsafetxt\.exe\s+1 calls, 3 tokens/);
    assert.match(terminal.stdout, /image\s+1 calls, 0 tokens/);

    const json = runUsage(home, ['-f', 'json'], true);
    assert.equal(json.status, 0, json.stderr);
    assert.doesNotMatch(json.stdout, UNSAFE);
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.total_tokens, 3);
    assert.deepEqual(summary.by_command[`chat${PAYLOAD}`], { calls: 1, tokens: 3 });

    const piped = runUsage(home, [], false);
    assert.equal(piped.status, 0, piped.stderr);
    assert.ok(piped.stdout.includes(`chat${PAYLOAD}`), 'piped output is unchanged');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('usage counts commands and models named after Object.prototype properties', () => {
  const home = mkdtempSync(join(tmpdir(), 'venice-usage-'));
  const timestamp = new Date().toISOString();
  try {
    mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.venice', 'usage.json'), JSON.stringify([
      { timestamp, command: '__proto__', model: 'constructor', total_tokens: 3 },
      { timestamp, command: 'toString', model: '__proto__', total_tokens: 4 },
    ]));

    const json = runUsage(home, ['-f', 'json'], false);
    assert.equal(json.status, 0, json.stderr);
    const summary = JSON.parse(json.stdout);
    assert.deepEqual(Object.entries(summary.by_command), [
      ['__proto__', { calls: 1, tokens: 3 }],
      ['toString', { calls: 1, tokens: 4 }],
    ]);
    assert.deepEqual(Object.entries(summary.by_model), [
      ['constructor', { calls: 1, tokens: 3 }],
      ['__proto__', { calls: 1, tokens: 4 }],
    ]);

    const pretty = runUsage(home, [], false);
    assert.equal(pretty.status, 0, pretty.stderr);
    assert.match(pretty.stdout, /__proto__\s+1 calls, 3 tokens/);
    assert.match(pretty.stdout, /constructor\s+1 calls, 3 tokens/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
