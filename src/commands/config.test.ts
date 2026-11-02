import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/test-env.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const secretKey = 'sk-secret-should-not-be-lost';

function runCli(args: string[], homeDir: string, input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input,
    env: childEnv({ HOME: homeDir, NO_COLOR: '1' }),
  });
}

function writeRawConfig(homeDir: string, content: string): string {
  const configDir = join(homeDir, '.venice');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configFile = join(configDir, 'config.json');
  writeFileSync(configFile, content, { mode: 0o600 });
  return configFile;
}

function assertConfigError(
  result: ReturnType<typeof runCli>,
  configFile: string,
  reason: RegExp
) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(result.stderr.includes(configFile), result.stderr);
  assert.match(result.stderr, reason);
  assert.match(result.stderr, /Fix or remove the file/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'should not print a stack trace');
  assert.ok(!result.stdout.includes(secretKey));
  assert.ok(!result.stderr.includes(secretKey));
}

const corruptConfigs: Array<[string, string, RegExp]> = [
  ['truncated JSON', `{ "api_key": "${secretKey}",`, /is not valid JSON/],
  ['corrupt JSON', `{ "api_key": "${secretKey}" }}garbage`, /is not valid JSON/],
  ['empty file', '', /is not valid JSON/],
  ['null', 'null', /must contain a JSON object/],
  ['an array', `["${secretKey}"]`, /must contain a JSON object/],
  ['a number', '42', /must contain a JSON object/],
  ['a string', `"${secretKey}"`, /must contain a JSON object/],
];

for (const [label, content, reason] of corruptConfigs) {
  test(`config show fails closed on ${label}`, () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));

    try {
      const configFile = writeRawConfig(homeDir, content);
      assertConfigError(runCli(['config', 'show'], homeDir), configFile, reason);
      assertConfigError(runCli(['config', 'get', 'api_key'], homeDir), configFile, reason);
      assert.equal(readFileSync(configFile, 'utf8'), content);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
}

test('config writes leave a corrupt config file byte-for-byte unchanged', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const content = `{ "api_key": "${secretKey}",`;

  try {
    const configFile = writeRawConfig(homeDir, content);
    const before = readFileSync(configFile);

    const writes: Array<[string[], string?]> = [
      [['config', 'set', 'default_model', 'kimi-k2-5']],
      [['config', 'set', 'api_key', '--stdin'], 'sk-replacement-1234567890\n'],
      [['config', 'unset', 'default_model']],
      [['config', 'init'], 'sk-replacement-1234567890\n\n\n\n'],
    ];
    for (const [args, input] of writes) {
      const result = runCli(args, homeDir, input);
      assertConfigError(result, configFile, /is not valid JSON/);
      assert.ok(readFileSync(configFile).equals(before), `${args.join(' ')} changed the file`);
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('missing config file is treated as empty config', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const configFile = join(homeDir, '.venice', 'config.json');

  try {
    const showResult = runCli(['config', 'show', '--format', 'json'], homeDir);
    assert.equal(showResult.status, 0, showResult.stderr);
    assert.deepEqual(JSON.parse(showResult.stdout), {});
    assert.equal(existsSync(configFile), false);

    const setResult = runCli(['config', 'set', 'default_model', 'kimi-k2-5'], homeDir);
    assert.equal(setResult.status, 0, setResult.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), {
      default_model: 'kimi-k2-5',
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('VENICE_API_KEY still works when a corrupt config file is not needed', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const content = `{ "api_key": "${secretKey}",`;
  const authHeaders: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const configFile = writeRawConfig(homeDir, content);
    const { port } = server.address() as AddressInfo;
    const child = spawn(
      process.execPath,
      [cliPath, 'embeddings', 'hello', '--format', 'json'],
      {
        env: childEnv({
          HOME: homeDir,
          NO_COLOR: '1',
          NODE_ENV: 'test',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}`,
          VENICE_API_KEY: 'sk-env-1234567890',
        }),
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));

    assert.equal(status, 0, stderr);
    assert.deepEqual(authHeaders, ['Bearer sk-env-1234567890']);
    assert.equal(readFileSync(configFile, 'utf8'), content);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

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

test('config set api_key --stdin saves without printing the key', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const apiKey = 'sk-stdin-1234567890';

  try {
    const result = runCli(['config', 'set', 'api_key', '--stdin'], homeDir, `${apiKey}\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(apiKey));
    assert.ok(!result.stderr.includes(apiKey));

    const config = JSON.parse(
      readFileSync(join(homeDir, '.venice', 'config.json'), 'utf8')
    );
    assert.equal(config.api_key, apiKey);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('config set api_key warns when the key is passed as an argument', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const apiKey = 'sk-argv-1234567890';

  try {
    const result = runCli(['config', 'set', 'api_key', apiKey], homeDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /passing an API key as an argument may expose it/);
    assert.ok(!result.stdout.includes(apiKey));
    assert.ok(!result.stderr.includes(apiKey));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('config init does not print API key input', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const apiKey = 'sk-init-1234567890';

  try {
    const result = runCli(['config', 'init'], homeDir, `${apiKey}\n\n\n\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /venice config set api_key --stdin/);
    assert.ok(!result.stdout.includes(apiKey));
    assert.ok(!result.stderr.includes(apiKey));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test(
  'config writes repair directory and file permissions',
  { skip: process.platform === 'win32' },
  () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
    const configDir = join(homeDir, '.venice');
    const configFile = join(configDir, 'config.json');

    try {
      const initialResult = runCli(
        ['config', 'set', 'api_key', '--stdin'],
        homeDir,
        'sk-permissions-1234567890\n'
      );
      assert.equal(initialResult.status, 0, initialResult.stderr);

      chmodSync(configDir, 0o755);
      chmodSync(configFile, 0o644);

      const updateResult = runCli(
        ['config', 'set', 'default_model', 'kimi-k2-5'],
        homeDir
      );
      assert.equal(updateResult.status, 0, updateResult.stderr);
      assert.equal(statSync(configDir).mode & 0o777, 0o700);
      assert.equal(statSync(configFile).mode & 0o777, 0o600);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
);

test(
  'config writes reject a symbolic-link config file',
  { skip: process.platform === 'win32' },
  () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
    const configDir = join(homeDir, '.venice');
    const configFile = join(configDir, 'config.json');
    const targetFile = join(homeDir, 'target.json');

    try {
      const initialResult = runCli(
        ['config', 'set', 'api_key', '--stdin'],
        homeDir,
        'sk-initial-1234567890\n'
      );
      assert.equal(initialResult.status, 0, initialResult.stderr);

      rmSync(configFile);
      writeFileSync(targetFile, '{\"unchanged\":true}');
      symlinkSync(targetFile, configFile);

      const updateResult = runCli(
        ['config', 'set', 'default_model', 'kimi-k2-5'],
        homeDir
      );
      assert.notEqual(updateResult.status, 0);
      assert.equal(readFileSync(targetFile, 'utf8'), '{\"unchanged\":true}');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
);

test(
  'config commands refuse a symbolic-link ~/.venice directory',
  { skip: process.platform === 'win32' },
  () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
    const targetDir = join(homeDir, 'elsewhere');

    try {
      mkdirSync(targetDir, { mode: 0o700 });
      symlinkSync(targetDir, join(homeDir, '.venice'));

      for (const args of [['config', 'set', 'default_model', 'kimi-k2-5'], ['config', 'show']]) {
        const result = runCli(args, homeDir);
        assert.notEqual(result.status, 0, args.join(' '));
        assert.match(result.stderr, /Config path is not a directory/);
      }
      assert.deepEqual(readdirSync(targetDir), []);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
);
