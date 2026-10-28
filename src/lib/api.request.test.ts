import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  at: number;
}

const requests: RecordedRequest[] = [];
const outsideRequests: string[] = [];
let handler: Handler = notFound;

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({
    method: request.method ?? '',
    path: request.url ?? '',
    headers: request.headers,
    body: Buffer.concat(chunks).toString('utf8'),
    at: Date.now(),
  });
  response.on('error', () => undefined);
  handler(request, response);
});
await listen(server);
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// Requests that leave the stub are answered as if the network were up, and recorded.
const realFetch = globalThis.fetch;
const guardedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`${origin}/`)) return realFetch(input, init);
  outsideRequests.push(url);
  return new Response(null, { status: 200 });
}) as typeof fetch;
globalThis.fetch = guardedFetch;

process.env.NODE_ENV = 'test';
process.env.VENICE_API_BASE_URL = `${origin}/api/v1`;
process.env.VENICE_API_KEY = 'test-key';
const api = await import('./api.js');

beforeEach(() => {
  requests.length = 0;
  outsideRequests.length = 0;
  handler = notFound;
  globalThis.fetch = guardedFetch;
});

after(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  server.close();
});

function notFound(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(404).end();
}

function listen(target: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Holds a response open; the timer only ends it if the client never gives up.
function stall(response: ServerResponse, ms = 3000): void {
  const timer = setTimeout(() => response.destroy(), ms);
  response.on('close', () => clearTimeout(timer));
}

function count(method: string, path: string): number {
  return requests.filter((request) => request.method === method && request.path === `/api/v1${path}`).length;
}

test('the request deadline covers a JSON body that stalls', { timeout: 10_000 }, async () => {
  handler = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"data":');
    stall(response);
  };

  const started = Date.now();
  await assert.rejects(
    api.apiRequest('/billing/balance', { showSpinner: false, timeoutMs: 200 }),
    /Request timed out after 0\.2 seconds/
  );
  assert.ok(Date.now() - started < 2000);
});

test('the request deadline covers an error body that stalls', { timeout: 10_000 }, async () => {
  handler = (_request, response) => {
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.write('upstream partial');
    stall(response);
  };

  await assert.rejects(
    api.apiRequest('/billing/balance', { showSpinner: false, timeoutMs: 200, retries: 0 }),
    (error: Error) => {
      assert.equal(error.message, 'upstream partial');
      return true;
    }
  );
});

test('transcribe keeps its deadline while the JSON result arrives', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'venice-transcribe-deadline-'));
  const audioPath = join(directory, 'clip.wav');
  writeFileSync(audioPath, Buffer.alloc(64, 1));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, delay === 120000 ? 200 : delay, ...args)) as typeof setTimeout;
  handler = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"text":"slow');
    stall(response);
  };

  try {
    await assert.rejects(api.transcribe(audioPath), /Transcription request timed out/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('JSON responses are read within a per-request size limit', async () => {
  handler = (_request, response) => sendJson(response, 200, { data: 'x'.repeat(4096) });

  await assert.rejects(
    api.apiRequest('/characters', { showSpinner: false, maxResponseBytes: 1024 }),
    /Response from \/characters (is too large \(4\.0 KB\)|exceeded the limit of 1\.0 KB)/
  );
  assert.equal(count('GET', '/characters'), 1);
});

test('a response that declares more than 16 MiB is refused before it is read', { timeout: 10_000 }, async () => {
  handler = (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(17 * 1024 * 1024),
    });
    response.write('{');
    stall(response);
  };

  await assert.rejects(api.apiRequest('/billing/balance', { showSpinner: false }), (error: Error) => {
    assert.equal(
      error.message,
      'Response from /billing/balance is too large (17.0 MB). Maximum allowed size is 16.0 MB.'
    );
    return true;
  });
});

test('error bodies are read up to 64 KiB and long messages are truncated', async () => {
  let bytesPulled = 0;
  let bodyCancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesPulled >= 8 * 1024 * 1024) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(16 * 1024).fill(0x41);
      bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      bodyCancelled = true;
    },
  }), { status: 400, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;

  await assert.rejects(
    api.apiRequest('/chat/completions', { method: 'POST', body: {}, showSpinner: false }),
    (error: Error) => {
      assert.equal(error.message, `${'A'.repeat(1000)}… (truncated)`);
      return true;
    }
  );
  assert.ok(bytesPulled <= 128 * 1024, `pulled ${bytesPulled} bytes`);
  assert.equal(bodyCancelled, true);

  globalThis.fetch = guardedFetch;
  handler = (_request, response) =>
    sendJson(response, 400, { error: { message: 'm'.repeat(5000) } });
  await assert.rejects(
    api.apiRequest('/chat/completions', { method: 'POST', body: {}, showSpinner: false }),
    (error: Error) => {
      assert.equal(error.message, `${'m'.repeat(1000)}… (truncated)`);
      return true;
    }
  );
});
