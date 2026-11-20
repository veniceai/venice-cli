import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyModelFilters } from './models.js';
import type { Model } from '../types/index.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const readmePath = fileURLToPath(new URL('../../README.md', import.meta.url));

const models: Model[] = [
  {
    id: 'kimi-k2-5',
    type: 'text',
    model_spec: { capabilities: { privacy: true } },
  },
  {
    id: 'e2ee-qwen3-5-122b-a10b',
    type: 'text',
    model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
  },
  {
    id: 'tee-qwen3-5-122b-a10b',
    type: 'text',
    model_spec: { capabilities: { supportsTeeAttestation: true } },
  },
  {
    id: 'flux-2-pro',
    type: 'image',
  },
];

test('applyModelFilters --tee lists only TEE-attestable models', () => {
  const filtered = applyModelFilters(models, { tee: true });
  assert.deepEqual(filtered.map((m) => m.id), [
    'e2ee-qwen3-5-122b-a10b',
    'tee-qwen3-5-122b-a10b',
  ]);
});

test('applyModelFilters --e2ee lists only E2EE-capable models', () => {
  const filtered = applyModelFilters(models, { e2ee: true });
  assert.deepEqual(filtered.map((m) => m.id), ['e2ee-qwen3-5-122b-a10b']);
});

test('applyModelFilters --tee --e2ee lists the intersection', () => {
  const withE2EEOnly: Model[] = [
    ...models,
    { id: 'e2ee-only', type: 'text', model_spec: { capabilities: { supportsE2EE: true } } },
  ];
  assert.deepEqual(applyModelFilters(withE2EEOnly, { e2ee: true }).map((m) => m.id), [
    'e2ee-qwen3-5-122b-a10b',
    'e2ee-only',
  ]);
  assert.deepEqual(applyModelFilters(withE2EEOnly, { tee: true, e2ee: true }).map((m) => m.id), [
    'e2ee-qwen3-5-122b-a10b',
  ]);
});

test('applyModelFilters --tee composes with --type and --search', () => {
  assert.deepEqual(applyModelFilters(models, { tee: true, type: 'image' }), []);
  assert.deepEqual(applyModelFilters(models, { tee: true, search: 'tee-' }).map((m) => m.id), [
    'tee-qwen3-5-122b-a10b',
  ]);
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runModels(args: string[]): Promise<CliResult> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/models') {
      res.writeHead(404).end();
      return;
    }
    const data = url.searchParams.has('type') ? [] : models;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-models-'));

  try {
    return await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'models', ...args], {
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('models --tee filters json, pretty, and piped output', async () => {
  const json = await runModels(['--tee', '-f', 'json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).map((m: Model) => m.id), [
    'e2ee-qwen3-5-122b-a10b',
    'tee-qwen3-5-122b-a10b',
  ]);

  for (const args of [['--tee', '-f', 'pretty'], ['--tee']]) {
    const result = await runModels(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Available Models \(2\)/);
    assert.match(result.stdout, /🔐 e2ee-qwen3-5-122b-a10b/);
    assert.match(result.stdout, /🛡️ tee-qwen3-5-122b-a10b/);
    assert.doesNotMatch(result.stdout, /kimi-k2-5|flux-2-pro/);
  }
});

test('models --help documents every flag the README uses', async () => {
  const readme = readFileSync(readmePath, 'utf8');
  const readmeFlags = new Set(
    [...readme.matchAll(/^venice models\b(.*)$/gm)].flatMap(([, rest]) => rest.match(/--[a-z0-9-]+/g) ?? [])
  );
  assert.ok(readmeFlags.has('--tee'));
  assert.ok(readmeFlags.has('--e2ee'));

  const help = await runModels(['--help']);
  assert.equal(help.status, 0, help.stderr);
  for (const flag of readmeFlags) {
    assert.match(help.stdout, new RegExp(`${flag}\\b`), `${flag} missing from venice models --help`);
  }
});
