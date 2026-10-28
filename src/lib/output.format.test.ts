import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { OutputFormat } from '../types/index.js';
import { detectOutputFormat } from './output.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const KEY_ID = 'e28e82dc-9df2-4b47-b726-d0a222ef2ab5';
const INVALID_FORMAT = /^Error: Invalid --format "jsno"\. Use one of: pretty, json, markdown, raw$/m;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: string[];
}

async function runCli(args: (homeDir: string) => string[]): Promise<CliResult & { homeDir: string }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [], success: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-format-test-'));

  try {
    const result = await new Promise<Omit<CliResult, 'requests'>>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args(homeDir)], {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
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
    return { ...result, requests, homeDir };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('detectOutputFormat accepts the documented formats', () => {
  for (const format of ['pretty', 'json', 'markdown', 'raw'] as const) {
    assert.equal(detectOutputFormat(format), format);
  }
  assert.equal(detectOutputFormat(), process.stdout.isTTY ? 'pretty' : 'raw');
});

test('detectOutputFormat rejects other values and lists the valid formats', () => {
  for (const format of ['jsno', 'JSON', 'xml', '']) {
    assert.throws(() => detectOutputFormat(format as OutputFormat), {
      message: `Invalid --format "${format}". Use one of: pretty, json, markdown, raw`,
    });
  }
});

test('commands exit 1 on an unknown --format instead of printing pretty output', async () => {
  const commands = [
    ['models', '-f', 'jsno'],
    ['billing', 'balance', '-f', 'jsno'],
    ['characters', 'show', 'alan-watts', '-f', 'jsno'],
    ['history', 'list', '-f', 'jsno'],
    ['usage', '-f', 'jsno'],
    ['config', 'show', '--format', 'jsno'],
  ];
  for (const args of commands) {
    const result = await runCli(() => args);
    try {
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, INVALID_FORMAT, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
      if (args[0] !== 'billing') {
        assert.deepEqual(result.requests, [], args.join(' '));
      }
    } finally {
      rmSync(result.homeDir, { recursive: true, force: true });
    }
  }
});

test('keys create and delete reject an unknown --format before contacting Venice', async () => {
  const create = await runCli((homeDir) => [
    'keys', 'create', '--name', 'ci', '--output', join(homeDir, 'ci.key'), '-f', 'jsno',
  ]);
  try {
    assert.equal(create.status, 1, create.stdout);
    assert.match(create.stderr, INVALID_FORMAT);
    assert.deepEqual(create.requests, []);
    assert.equal(existsSync(join(create.homeDir, 'ci.key')), false);
  } finally {
    rmSync(create.homeDir, { recursive: true, force: true });
  }

  const remove = await runCli(() => ['keys', 'delete', KEY_ID, '--force', '-f', 'jsno']);
  try {
    assert.equal(remove.status, 1, remove.stdout);
    assert.match(remove.stderr, INVALID_FORMAT);
    assert.deepEqual(remove.requests, []);
  } finally {
    rmSync(remove.homeDir, { recursive: true, force: true });
  }
});
