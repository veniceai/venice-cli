import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const PLAIN_MODEL = { id: 'test-model', type: 'text', model_spec: { capabilities: {} } };
const E2EE_MODEL = {
  id: 'e2ee-test-model',
  type: 'text',
  model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
};

interface ChatRequest {
  messages: Array<{ role: string; content: unknown }>;
}

interface Stub {
  origin: string;
  seen: string[];
  chats: ChatRequest[];
  close: () => Promise<void>;
}

async function startStub(catalog: () => unknown[]): Promise<Stub> {
  const seen: string[] = [];
  const chats: ChatRequest[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push(`${request.method} ${url.pathname}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && url.pathname === '/api/v1/models') {
      const type = url.searchParams.get('type');
      response.end(JSON.stringify({ data: !type || type === 'text' ? catalog() : [] }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      chats.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest);
      response.end(JSON.stringify({ choices: [{ message: { content: 'Hello Ada' }, finish_reason: 'stop' }] }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    chats,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

// spawnSync would block the event loop the stub server runs on.
function runChat(homeDir: string, origin: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'chat', '--no-stream', ...args], {
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: `${origin}/api/v1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

function writeHistory(homeDir: string, entries: unknown[]): void {
  const dir = join(homeDir, '.venice');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'history.json'), JSON.stringify(entries), { mode: 0o600 });
}

async function withScratch(catalog: () => unknown[], run: (homeDir: string, stub: Stub) => Promise<void>): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-continue-'));
  const stub = await startStub(catalog);
  try {
    await run(homeDir, stub);
  } finally {
    await stub.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
}

const PRIOR_MESSAGES = [
  { role: 'user', content: 'My private notes' },
  { role: 'assistant', content: 'Noted' },
];

test('a plain chat is saved as plain and can be continued while the catalog is empty', { timeout: 40_000 }, async () => {
  let catalog: unknown[] = [PLAIN_MODEL];
  await withScratch(() => catalog, async (homeDir, stub) => {
    const first = await runChat(homeDir, stub.origin, ['--model', 'test-model', 'My name is Ada']);
    assert.equal(first.status, 0, first.stderr);
    const [saved] = JSON.parse(readFileSync(join(homeDir, '.venice', 'history.json'), 'utf8'));
    assert.equal(saved.privacy, 'plain');

    catalog = [];
    const second = await runChat(homeDir, stub.origin, ['--model', 'test-model', '--continue', 'What is my name?']);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      stub.chats.at(-1)?.messages.map((message) => [message.role, message.content]),
      [
        ['user', 'My name is Ada'],
        ['assistant', 'Hello Ada'],
        ['user', 'What is my name?'],
      ]
    );
  });
});

test('chat --continue refuses untagged history it cannot classify and sends nothing', { timeout: 20_000 }, async () => {
  await withScratch(() => [], async (homeDir, stub) => {
    writeHistory(homeDir, [{ id: 'c1', timestamp: '2026-01-01T00:00:00.000Z', model: 'test-model', messages: PRIOR_MESSAGES }]);

    const result = await runChat(homeDir, stub.origin, ['--model', 'test-model', '--continue', 'Summarise them']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /model capabilities could not be confirmed/);
    assert.deepEqual(stub.chats, []);
  });
});

test('chat --continue refuses to carry plain history into an E2EE session and sends nothing', { timeout: 20_000 }, async () => {
  await withScratch(() => [PLAIN_MODEL, E2EE_MODEL], async (homeDir, stub) => {
    writeHistory(homeDir, [{
      id: 'c1',
      timestamp: '2026-01-01T00:00:00.000Z',
      model: 'test-model',
      privacy: 'plain',
      messages: PRIOR_MESSAGES,
    }]);

    const result = await runChat(homeDir, stub.origin, ['--model', 'e2ee-test-model', '--continue', 'Summarise them']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /across plaintext and E2EE\/TEE sessions/);
    assert.deepEqual(stub.chats, []);
    assert.ok(!stub.seen.includes('GET /api/v1/tee/attestation'), stub.seen.join(', '));
  });
});
