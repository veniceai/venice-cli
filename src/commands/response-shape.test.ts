import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const KEY_ID = 'e28e82dc-9df2-4b47-b726-d0a222ef2ab5';
const UNEXPECTED = /^Error: Unexpected response from Venice: /m;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(
  body: unknown,
  args: (homeDir: string) => string[]
): Promise<CliResult & { homeDir: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-response-shape-test-'));
  writeFileSync(join(homeDir, 'sample.wav'), 'sample-audio');

  try {
    const result = await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args(homeDir)], {
        cwd: homeDir,
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
    return { ...result, homeDir };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function assertRejected(
  body: unknown,
  args: (homeDir: string) => string[],
  afterRun: (homeDir: string) => void = () => {}
): Promise<void> {
  const result = await runCli(body, args);
  try {
    const label = `${args(result.homeDir).join(' ')} with ${JSON.stringify(body)}`;
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, UNEXPECTED, label);
    assert.doesNotMatch(result.stdout, /undefined/, label);
    afterRun(result.homeDir);
  } finally {
    rmSync(result.homeDir, { recursive: true, force: true });
  }
}

// Every format gets the empty body; the other malformed bodies use the first format only.
function* cases<T>(bodies: unknown[], variants: T[]): Generator<[unknown, T]> {
  for (const [index, body] of bodies.entries()) {
    for (const variant of index === 0 ? variants : variants.slice(0, 1)) {
      yield [body, variant];
    }
  }
}

test('voice clone fails on a response without a voice id and model', async () => {
  const bodies = [{}, { id: 'vv_handle' }, { id: 42, model: 'tts-chatterbox-hd' }];
  for (const [body, format] of cases(bodies, ['pretty', 'json'])) {
    await assertRejected(body, (home) => ['voice', 'clone', join(home, 'sample.wav'), '-f', format]);
  }
});

test('transcribe fails on a response without text or with malformed timing data', async () => {
  const bodies = [
    {},
    { text: null },
    { text: 'hello', duration: '1.2' },
    { text: 'hello', timestamps: { segment: [{ text: 'hello', start: '0' }] } },
  ];
  for (const [body, format] of cases(bodies, ['pretty', 'raw', 'json'])) {
    await assertRejected(body, (home) => ['transcribe', join(home, 'sample.wav'), '-t', '-f', format]);
  }
});

test('voices fails when the model list is missing or malformed', async () => {
  const bodies = [{}, { data: {} }, { data: [{ type: 'tts' }] }, { data: [{ id: 'tts', model_spec: { voices: 'af_sky' } }] }];
  for (const [body, format] of cases(bodies, ['pretty', 'json'])) {
    await assertRejected(body, () => ['voices', '-f', format]);
  }
});

test('embeddings fails without vectors and does not write the output file', async () => {
  const bodies = [{}, { data: [] }, { data: [{ index: 0 }] }, { data: [{ embedding: ['0.1'], index: 0 }] }];
  const variants = [
    (home: string) => ['-o', join(home, 'vectors.json')],
    () => ['-f', 'json'],
    () => ['-f', 'pretty'],
  ];
  for (const [body, variant] of cases(bodies, variants)) {
    await assertRejected(
      body,
      (home) => ['embeddings', 'hello', ...variant(home)],
      (home) => assert.equal(existsSync(join(home, 'vectors.json')), false)
    );
  }
});

test('keys list fails on a response without key metadata', async () => {
  const bodies = [{}, { data: {} }, { data: [{ id: KEY_ID }] }, { data: [{ id: KEY_ID, apiKeyType: 'INFERENCE', last6Chars: 1 }] }];
  for (const [body, format] of cases(bodies, ['pretty', 'json'])) {
    await assertRejected(body, () => ['keys', 'list', '-f', format]);
  }
});

test('keys rate-limits fails on a response without the expected fields', async () => {
  const valid = rateLimits();
  const bodies = [
    {},
    { data: {} },
    { data: { ...valid, apiTier: undefined } },
    { data: { ...valid, balances: { USD: 1 } } },
    { data: { ...valid, rateLimits: [{ apiModelId: 'model' }] } },
  ];
  for (const [body, format] of cases(bodies, ['pretty', 'json'])) {
    await assertRejected(body, () => ['keys', 'rate-limits', '-f', format]);
  }
});

test('keys delete fails when Venice does not confirm the deletion', async () => {
  for (const body of [{}, { success: false }]) {
    const result = await runCli(body, () => ['keys', 'delete', KEY_ID, '--force', '-f', 'json']);
    try {
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Venice did not confirm API key deletion/);
    } finally {
      rmSync(result.homeDir, { recursive: true, force: true });
    }
  }
});

test('keys list and rate-limits accept well-formed responses', async () => {
  const key = {
    id: KEY_ID,
    apiKeyType: 'INFERENCE',
    consumptionLimits: { usd: 25, diem: null },
    limitPeriod: 'MONTH',
    createdAt: '2026-08-01T00:00:00.000Z',
    description: 'ci',
    expiresAt: null,
    last6Chars: 'abc123',
    lastUsedAt: null,
  };
  const list = await runCli({ data: [key] }, () => ['keys', 'list', '-f', 'json']);
  try {
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).map((entry: { id: string }) => entry.id), [KEY_ID]);
  } finally {
    rmSync(list.homeDir, { recursive: true, force: true });
  }

  const limits = await runCli({ data: rateLimits() }, () => ['keys', 'rate-limits']);
  try {
    assert.equal(limits.status, 0, limits.stderr);
    assert.match(limits.stdout, /Tier: paid/);
    assert.match(limits.stdout, /RPM/);
  } finally {
    rmSync(limits.homeDir, { recursive: true, force: true });
  }
});

function rateLimits() {
  return {
    accessPermitted: true,
    apiTier: { id: 'paid', isCharged: true },
    balances: { USD: 12.5, DIEM: null },
    keyExpiration: null,
    nextEpochBegins: '2026-11-01T00:00:00.000Z',
    rateLimits: [{ apiModelId: 'model', rateLimits: [{ type: 'RPM', amount: 20 }] }],
  };
}
