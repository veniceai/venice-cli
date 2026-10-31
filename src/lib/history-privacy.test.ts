import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

// config.js resolves ~/.venice when it is first imported.
const inProcessHome = mkdtempSync(join(tmpdir(), 'venice-history-privacy-home-'));
process.env.HOME = inProcessHome;
const { loadHistory } = await import('./config.js');
after(() => rmSync(inProcessHome, { recursive: true, force: true }));

const entry = (id: string, model: string, privacy?: string) => ({
  id,
  timestamp: '2026-08-01T00:00:00.000Z',
  model,
  ...(privacy === undefined ? {} : { privacy }),
  messages: [{ role: 'user', content: `prompt for ${id}` }],
});

const SAVED = [
  entry('plain-tagged', 'kimi-k2-5', 'plain'),
  entry('plain-untagged', 'kimi-k2-5'),
  entry('plain-tagged-private-looking-model', 'e2ee-qwen3-5-122b-a10b', 'plain'),
  entry('e2ee-tagged', 'qwen3-5-122b-a10b', 'e2ee'),
  entry('tee-tagged', 'qwen3-5-122b-a10b', 'tee'),
  entry('e2ee-untagged', 'e2ee-qwen3-5-122b-a10b'),
  entry('tee-prefix-untagged', 'TEE-glm-4-7'),
  entry('tee-infix-untagged', 'deepseek-tee-r1'),
];
const KEPT = ['plain-tagged', 'plain-untagged', 'plain-tagged-private-looking-model'];

const ids = (entries: Array<{ id: string }>) => entries.map((saved) => saved.id);

function writeHistory(homeDir: string): string {
  const veniceDir = join(homeDir, '.venice');
  mkdirSync(veniceDir, { recursive: true, mode: 0o700 });
  const historyFile = join(veniceDir, 'history.json');
  writeFileSync(historyFile, JSON.stringify(SAVED), { mode: 0o644 });
  return historyFile;
}

function runCli(args: string[], homeDir: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: homeDir,
      env: { ...process.env, HOME: homeDir, NODE_ENV: 'test', NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr }));
  });
}

test('loading history removes private-mode conversations saved by older versions, once, with a notice', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-history-privacy-'));
  const historyFile = writeHistory(homeDir);
  try {
    const first = await runCli(['history', 'export', 'first.json'], homeDir);
    const second = await runCli(['history', 'export', 'second.json'], homeDir);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      first.stderr,
      `Removed 5 private-mode conversations saved by an older version from ${historyFile}\n`
    );
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, '');
    for (const name of ['first.json', 'second.json']) {
      assert.deepEqual(ids(JSON.parse(readFileSync(join(homeDir, name), 'utf8'))), KEPT);
    }
    const saved = readFileSync(historyFile, 'utf8');
    assert.deepEqual(ids(JSON.parse(saved)), KEPT);
    assert.doesNotMatch(saved, /prompt for (e2ee|tee)-/);
    assert.equal(statSync(historyFile).mode & 0o777, 0o600);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('private-mode conversations stay hidden when the cleaned history cannot be written', () => {
  const historyFile = writeHistory(inProcessHome);
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const originalOpenSync = fs.openSync;
  const originalError = console.error;
  const warnings: string[] = [];
  fs.openSync = ((filePath: string, ...rest: unknown[]) => {
    if (String(filePath).endsWith('.tmp')) {
      throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    }
    return (originalOpenSync as (...args: unknown[]) => number)(filePath, ...rest);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  console.error = (...values: unknown[]) => { warnings.push(values.join(' ')); };

  let history: Array<{ id: string }>;
  try {
    history = loadHistory();
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    console.error = originalError;
  }

  assert.deepEqual(ids(history), KEPT);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not remove 5 private-mode conversations saved by an older version/);
  assert.match(warnings[0], /venice history clear/);
  assert.equal(readFileSync(historyFile, 'utf8'), JSON.stringify(SAVED));
});
