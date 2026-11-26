import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reply, runCli, type FakeApi } from '../lib/test-cli.js';
import { childEnv } from '../lib/test-env.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const NO_USAGE = 'No usage data recorded yet.\n';

function runInHome(args: string[], homeDir: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: childEnv({ HOME: homeDir, NO_COLOR: '1', NODE_ENV: 'test' }),
  });
}

test('output_format from the config is the default format, piped or not, and -f still wins', async () => {
  const json = await runCli(['usage'], () => undefined, { config: { output_format: 'json' } });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(typeof JSON.parse(json.stdout), 'object');

  const explicit = await runCli(['usage', '-f', 'pretty'], () => undefined, { config: { output_format: 'json' } });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, NO_USAGE);

  const unset = await runCli(['usage'], () => undefined);
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(unset.stdout, NO_USAGE);

  const handEdited = await runCli(['usage'], () => undefined, { config: { output_format: 'xml' } });
  assert.equal(handEdited.status, 0, handEdited.stderr);
  assert.equal(handEdited.stdout, NO_USAGE);
});

test('errors and warnings printed outside a command follow output_format json from the config', { timeout: 20_000 }, async () => {
  const config = { output_format: 'json' };

  const refused = await runCli(['keys', 'list'], () => reply(401, { error: { message: 'bad key' } }), { config });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.deepEqual(JSON.parse(refused.stderr), {
    error: {
      message: 'Authentication failed. Please check your API key.\nUpdate with: venice config set api_key',
      status: 401,
    },
  });

  const failed = await runCli(['responses', 'hi'], () => reply(400, { error: { message: 'bad input' } }), { config });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.deepEqual(JSON.parse(failed.stderr), { error: { message: 'bad input', status: 400 } });

  const deprecated: FakeApi = (request) => request.path === '/video/quote'
    ? reply(200, { quote: 1 }, { 'x-venice-deprecated': 'true', 'x-venice-deprecated-replacement': 'new-model' })
    : undefined;
  const quote = await runCli(['video', 'quote', '-m', 'test-model'], deprecated, { config });
  assert.equal(quote.status, 0, quote.stderr);
  assert.equal(JSON.parse(quote.stdout).quote, 1);
  assert.deepEqual(JSON.parse(quote.stderr).warnings.map((warning: { replacement: string }) => warning.replacement), ['new-model']);
});

test('config set output_format accepts only formats the commands understand, and unset restores the default', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-output-format-'));
  const configFile = join(homeDir, '.venice', 'config.json');

  try {
    const invalid = runInHome(['config', 'set', 'output_format', 'xml'], homeDir);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /^Error: Invalid output_format "xml"\. Use one of: pretty, json, markdown, raw$/m);
    assert.equal(existsSync(configFile), false);

    const set = runInHome(['config', 'set', 'output_format', 'json'], homeDir);
    assert.equal(set.status, 0, set.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), { output_format: 'json' });
    assert.equal(typeof JSON.parse(runInHome(['usage'], homeDir).stdout), 'object');

    const unset = runInHome(['config', 'unset', 'output_format'], homeDir);
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(runInHome(['usage'], homeDir).stdout, NO_USAGE);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
