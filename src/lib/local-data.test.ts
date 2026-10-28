import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const REPLY = 'stub reply';

// config.js resolves ~/.venice when it is first imported.
const inProcessHome = mkdtempSync(join(tmpdir(), 'venice-local-data-home-'));
process.env.HOME = inProcessHome;
const config = await import('./config.js');
after(() => rmSync(inProcessHome, { recursive: true, force: true }));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const conversation = (text: string) => ({
  id: `id-${text}`,
  timestamp: '2026-10-01T00:00:00.000Z',
  model: 'test-model',
  privacy: 'plain',
  messages: [{ role: 'user', content: text }, { role: 'assistant', content: `re ${text}` }],
});

const usageRecord = () => ({
  timestamp: new Date().toISOString(),
  command: 'chat',
  model: 'earlier-model',
  total_tokens: 5,
});

function makeHome(files: Record<string, string> = {}): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-local-data-'));
  mkdirSync(join(homeDir, '.venice'), { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(homeDir, '.venice', name), content, { mode: 0o600 });
  }
  return homeDir;
}

async function withChatApi(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url?.startsWith('/api/v1/models')) {
        response.end(JSON.stringify({
          data: [{ id: 'test-model', type: 'text', model_spec: { capabilities: {} } }],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/v1/chat/completions') {
        response.end(JSON.stringify({
          choices: [{ message: { content: REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${port}/api/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runCli(
  args: string[],
  homeDir: string,
  options: { baseUrl?: string; cwd?: string } = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? homeDir,
      env: {
        ...process.env,
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: options.baseUrl ?? 'http://127.0.0.1:9/api/v1',
        VENICE_API_KEY: 'test-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const chat = (homeDir: string, baseUrl: string) =>
  runCli(['chat', '--model', 'test-model', 'hello'], homeDir, { baseUrl });

const mode = (filePath: string) => statSync(filePath).mode & 0o777;

test('a chat leaves an unreadable history.json untouched and says the conversation was not saved', () =>
  withChatApi(async (baseUrl) => {
    const full = JSON.stringify([conversation('one'), conversation('two')]);
    const contents = [
      full.slice(0, -3),
      JSON.stringify({ conversations: [conversation('one')] }),
      '',
      JSON.stringify([{ id: 'no-messages', model: 'test-model' }]),
    ];
    for (const content of contents) {
      const homeDir = makeHome({ 'history.json': content });
      const historyFile = join(homeDir, '.venice', 'history.json');
      try {
        const result = await chat(homeDir, baseUrl);

        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(REPLY), result.stdout);
        assert.match(result.stderr, /the conversation was not saved to history/);
        assert.ok(result.stderr.includes(historyFile), result.stderr);
        assert.equal(readFileSync(historyFile, 'utf8'), content);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    }
  }));

test('history export refuses an unreadable history file and writes nothing', async () => {
  const content = JSON.stringify([conversation('one')]).slice(0, -1);
  const homeDir = makeHome({ 'history.json': content });
  const exportPath = join(homeDir, 'export.json');
  try {
    const result = await runCli(['history', 'export', exportPath], homeDir);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(join(homeDir, '.venice', 'history.json')), result.stderr);
    assert.match(result.stderr, /is not valid JSON/);
    assert.equal(existsSync(exportPath), false);
    assert.equal(readFileSync(join(homeDir, '.venice', 'history.json'), 'utf8'), content);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('history and usage files are rewritten with mode 0600 whatever their previous mode', () =>
  withChatApi(async (baseUrl) => {
    const homeDir = makeHome({
      'history.json': JSON.stringify([conversation('earlier')]),
      'usage.json': JSON.stringify([usageRecord()]),
    });
    const historyFile = join(homeDir, '.venice', 'history.json');
    const usageFile = join(homeDir, '.venice', 'usage.json');
    chmodSync(historyFile, 0o644);
    chmodSync(usageFile, 0o644);
    try {
      const result = await chat(homeDir, baseUrl);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(mode(historyFile), 0o600);
      assert.equal(mode(usageFile), 0o600);
      const history = JSON.parse(readFileSync(historyFile, 'utf8'));
      assert.deepEqual(history.map((entry: { messages: Array<{ content: string }> }) =>
        entry.messages[0].content), ['earlier', 'hello']);
      assert.equal(JSON.parse(readFileSync(usageFile, 'utf8')).length, 2);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }));

test('history and usage symlinks in ~/.venice are neither read nor written through', () =>
  withChatApi(async (baseUrl) => {
    const homeDir = makeHome();
    const elsewhereHistory = join(homeDir, 'elsewhere-history.json');
    const elsewhereUsage = join(homeDir, 'elsewhere-usage.json');
    const linkedHistory = JSON.stringify([conversation('from elsewhere')]);
    writeFileSync(elsewhereHistory, linkedHistory);
    writeFileSync(elsewhereUsage, '[]');
    symlinkSync(elsewhereHistory, join(homeDir, '.venice', 'history.json'));
    symlinkSync(elsewhereUsage, join(homeDir, '.venice', 'usage.json'));
    try {
      const result = await chat(homeDir, baseUrl);
      const exported = await runCli(['history', 'export', join(homeDir, 'out.json')], homeDir);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /conversation was not saved[\s\S]*is not a regular file/);
      assert.match(result.stderr, /usage was not recorded[\s\S]*is not a regular file/);
      assert.equal(readFileSync(elsewhereHistory, 'utf8'), linkedHistory);
      assert.equal(readFileSync(elsewhereUsage, 'utf8'), '[]');
      assert.equal(exported.status, 1);
      assert.equal(existsSync(join(homeDir, 'out.json')), false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }));

test('history export writes a 0600 file and replaces a link at the destination instead of following it', async () => {
  const homeDir = makeHome({ 'history.json': JSON.stringify([conversation('private question')]) });
  const workDir = mkdtempSync(join(tmpdir(), 'venice-local-data-cwd-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'venice-local-data-elsewhere-'));
  const linkTarget = join(elsewhere, 'copy.json');
  symlinkSync(linkTarget, join(workDir, 'history.json'));
  try {
    const viaLink = await runCli(['history', 'export', 'history.json'], homeDir, { cwd: workDir });
    const fresh = await runCli(['history', 'export', 'fresh.json'], homeDir, { cwd: workDir });

    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(existsSync(linkTarget), false);
    for (const name of ['history.json', 'fresh.json']) {
      const exported = join(workDir, name);
      assert.equal(lstatSync(exported).isFile(), true);
      assert.equal(mode(exported), 0o600);
      assert.match(readFileSync(exported, 'utf8'), /private question/);
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a usage.json that is not a list of usage records does not fail a paid command', () =>
  withChatApi(async (baseUrl) => {
    const contents = [
      '{}',
      'null',
      '42',
      '[1]',
      '[{"command":"chat"}]',
      JSON.stringify([usageRecord()]).slice(0, -2),
    ];
    for (const content of contents) {
      const homeDir = makeHome({ 'usage.json': content });
      const usageFile = join(homeDir, '.venice', 'usage.json');
      try {
        const result = await chat(homeDir, baseUrl);

        assert.equal(result.status, 0, `${content}: ${result.stderr}`);
        assert.ok(result.stdout.includes(REPLY), result.stdout);
        assert.equal(result.stderr.match(/usage was not recorded/g)?.length, 1, result.stderr);
        assert.ok(result.stderr.includes(usageFile), result.stderr);
        assert.equal(readFileSync(usageFile, 'utf8'), content);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    }
  }));

test('loadHistory and loadUsage return [] for a missing file and throw DataFileError for an unusable one', () => {
  const veniceDir = join(inProcessHome, '.venice');
  rmSync(veniceDir, { recursive: true, force: true });

  assert.deepEqual(config.loadHistory(), []);
  assert.deepEqual(config.loadUsage(), []);

  writeFileSync(join(veniceDir, 'history.json'), '{');
  writeFileSync(join(veniceDir, 'usage.json'), '{"not":"a list"}');
  for (const [load, file] of [
    [config.loadHistory, 'history.json'],
    [config.loadUsage, 'usage.json'],
  ] as const) {
    assert.throws(load, (error: unknown) => {
      assert.ok(error instanceof config.DataFileError);
      assert.equal(error.filePath, join(veniceDir, file));
      return true;
    });
  }
});

test('trackUsage warns once per process and leaves an unusable usage.json untouched', () => {
  const veniceDir = join(inProcessHome, '.venice');
  rmSync(veniceDir, { recursive: true, force: true });
  mkdirSync(veniceDir, { mode: 0o700 });
  writeFileSync(join(veniceDir, 'usage.json'), '{}');
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { warnings.push(values.join(' ')); };
  try {
    config.trackUsage({ command: 'chat', model: 'test-model', total_tokens: 2 });
    config.trackUsage({ command: 'chat', model: 'test-model', total_tokens: 2 });
  } finally {
    console.error = originalError;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /usage was not recorded/);
  assert.ok(warnings[0].includes(join(veniceDir, 'usage.json')));
  assert.equal(readFileSync(join(veniceDir, 'usage.json'), 'utf8'), '{}');
});
