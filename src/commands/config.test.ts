import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const configModuleUrl = new URL('../lib/config.js', import.meta.url).href;

function runCli(args: string[], homeDir: string, input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input,
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

test('config init does not print API key input', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const apiKey = 'sk-init-1234567890';

  try {
    const result = runCli(['config', 'init'], homeDir, `${apiKey}\n\n\n\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(apiKey));
    assert.ok(!result.stderr.includes(apiKey));
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('config is read from disk only once per process', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-config-test-'));
  const configDir = join(homeDir, '.venice');
  const script = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(import.meta.url);
    const fs = require('node:fs');
    const originalReadFileSync = fs.readFileSync;
    let configReads = 0;
    fs.readFileSync = function (...args) {
      if (String(args[0]).endsWith('config.json')) configReads++;
      return originalReadFileSync.apply(this, args);
    };
    syncBuiltinESMExports();
    const { loadConfig, saveConfig } = await import(${JSON.stringify(configModuleUrl)});
    loadConfig();
    loadConfig();
    saveConfig({ default_model: 'updated-model' });
    const updatedConfig = loadConfig();
    console.log(JSON.stringify({ configReads, updatedConfig }));
  `;

  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), '{"default_model":"test-model"}');

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      configReads: 1,
      updatedConfig: { default_model: 'updated-model' },
    });
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
