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

const PROCESSED_NOTE =
  'The request may already have been processed, so it was not retried. ' +
  'Check before running it again; paid requests appear in `venice billing usage`.';

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
process.env.VENICE_TEST_RETRY_DELAY_MS = '1';
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

async function connectionRefusedError(): Promise<unknown> {
  const closed = createServer();
  await listen(closed);
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  return realFetch(`http://127.0.0.1:${port}/`).then(
    () => assert.fail('expected the connection to be refused'),
    (error: unknown) => error
  );
}

const ambiguousFailures: Array<[string, Handler, RegExp]> = [
  [
    'the server answers 500',
    (_request, response) => sendJson(response, 500, { error: { message: 'upstream failed' } }),
    /^upstream failed\n/,
  ],
  [
    'the connection drops after the request arrives',
    (request) => request.socket.destroy(),
    /^Connection to the Venice API failed \(other side closed\)\.\n/,
  ],
  [
    'a 2xx body is cut off',
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' });
      response.write('{"queue_id":"q');
      setTimeout(() => response.destroy(), 20);
    },
    /^Connection to the Venice API failed \(other side closed\)\.\n/,
  ],
  [
    'a 2xx body is not valid JSON',
    (_request, response) => sendJson(response, 200, '{"queue_id":"q'),
    /^Response from \/video\/queue was not valid JSON\.\n/,
  ],
  [
    'a 2xx body is larger than allowed',
    (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(17 * 1024 * 1024),
      });
      response.write('{');
      stall(response);
    },
    /^Response from \/video\/queue is too large \(17\.0 MB\)\. Maximum allowed size is 16\.0 MB\.\n/,
  ],
];

for (const [name, respond, messageStart] of ambiguousFailures) {
  test(`a paid POST is sent once when ${name}, and the error says it may have been processed`, async () => {
    handler = respond;
    await assert.rejects(
      api.apiRequest('/video/queue', { method: 'POST', body: { prompt: 'a cat' }, showSpinner: false }),
      (error: Error) => {
        assert.match(error.message, messageStart);
        assert.ok(error.message.endsWith(`\n${PROCESSED_NOTE}`), error.message);
        return true;
      }
    );
    assert.equal(count('POST', '/video/queue'), 1);
    assert.deepEqual(outsideRequests, []);
  });
}

test('a paid POST that times out says it may have been processed', { timeout: 10_000 }, async () => {
  handler = (_request, response) => stall(response);
  await assert.rejects(
    api.apiRequest('/video/queue', { method: 'POST', body: {}, showSpinner: false, timeoutMs: 100 }),
    (error: Error) => {
      assert.equal(error.message, `Request timed out after 0.1 seconds.\n${PROCESSED_NOTE}`);
      return true;
    }
  );
  assert.equal(count('POST', '/video/queue'), 1);
});

test('a paid POST is retried when the connection was refused before sending', async () => {
  const refused = await connectionRefusedError();
  let refuseNext = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (refuseNext) {
      refuseNext = false;
      throw refused;
    }
    return guardedFetch(input, init);
  }) as typeof fetch;
  handler = (request, response) => {
    if (request.method === 'HEAD') response.writeHead(200).end();
    else sendJson(response, 200, { queue_id: 'q-1' });
  };

  const result = await api.apiRequest<{ queue_id: string }>('/video/queue', {
    method: 'POST',
    body: { prompt: 'a cat' },
    showSpinner: false,
  });

  assert.deepEqual(result, { queue_id: 'q-1' });
  assert.equal(count('POST', '/video/queue'), 1);
  assert.equal(count('HEAD', '/models'), 1, 'the connectivity probe goes to the configured API');
  assert.deepEqual(outsideRequests, []);
});

test('a paid POST that cannot reach the network reports being offline, not a possible charge', async () => {
  const unreachable = Object.assign(new Error('connect EHOSTUNREACH 203.0.113.1:443'), {
    code: 'EHOSTUNREACH',
    syscall: 'connect',
  });
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    throw new TypeError('fetch failed', { cause: unreachable });
  }) as typeof fetch;

  await assert.rejects(
    api.apiRequest('/video/queue', { method: 'POST', body: {}, showSpinner: false }),
    (error: Error) => {
      assert.equal(error.message, 'Unable to connect to Venice API.\nPlease check your internet connection.');
      return true;
    }
  );
  assert.equal(attempts, 2, 'one request and one connectivity probe');
});

test('a paid POST is retried after a 429', async () => {
  let posts = 0;
  handler = (_request, response) => {
    posts++;
    if (posts === 1) sendJson(response, 429, { error: { message: 'slow down' } });
    else sendJson(response, 200, { images: [] });
  };

  assert.deepEqual(
    await api.apiRequest('/image/generate', { method: 'POST', body: {}, showSpinner: false }),
    { images: [] }
  );
  assert.equal(count('POST', '/image/generate'), 2);
});

test('idempotent requests are retried after a 5xx and after a dropped connection', async () => {
  let gets = 0;
  handler = (request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200).end();
      return;
    }
    gets++;
    if (gets === 1) sendJson(response, 503, { error: { message: 'busy' } });
    else if (gets === 2) request.socket.destroy();
    else sendJson(response, 200, { data: [] });
  };

  assert.deepEqual(await api.apiRequest('/characters', { showSpinner: false }), { data: [] });
  assert.equal(count('GET', '/characters'), 3);
  assert.equal(count('HEAD', '/models'), 1);
  assert.deepEqual(outsideRequests, []);
});

test('a POST marked idempotent is retried with the same body and headers', async () => {
  let posts = 0;
  handler = (_request, response) => {
    posts++;
    if (posts === 1) sendJson(response, 503, { error: { message: 'busy' } });
    else sendJson(response, 200, { result: '0x1' });
  };

  await api.apiRequest('/crypto/rpc/ethereum-mainnet', {
    method: 'POST',
    body: { jsonrpc: '2.0', method: 'eth_blockNumber', id: 1 },
    idempotent: true,
    additionalHeaders: { 'Idempotency-Key': 'key-1' },
    showSpinner: false,
  });

  const posted = requests.filter((request) => request.method === 'POST');
  assert.equal(posted.length, 2);
  assert.equal(posted[1].body, posted[0].body);
  assert.equal(posted[1].headers['idempotency-key'], 'key-1');
});

test('a body that cannot be serialised fails once, before any request is sent', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    api.apiRequest('/crypto/rpc/ethereum-mainnet', {
      method: 'POST',
      body: circular,
      idempotent: true,
      showSpinner: false,
    }),
    (error: Error) => {
      assert.ok(error instanceof TypeError, String(error));
      assert.match(error.message, /circular/i);
      return true;
    }
  );

  let nested: unknown = [];
  for (let depth = 0; depth < 100_000; depth++) nested = [nested];
  await assert.rejects(
    api.apiRequest('/crypto/rpc/ethereum-mainnet', {
      method: 'POST',
      body: nested,
      idempotent: true,
      showSpinner: false,
    }),
    RangeError
  );

  assert.deepEqual(requests, []);
  assert.deepEqual(outsideRequests, []);
});

test('an error thrown locally is not treated as a dropped connection', async () => {
  handler = (_request, response) => sendJson(response, 200, { ok: true });
  await assert.rejects(
    api.apiRequest('/billing/balance', {
      showSpinner: false,
      onHeaders: () => {
        throw new TypeError('local bug');
      },
    }),
    /local bug/
  );
  assert.equal(count('GET', '/billing/balance'), 1);
  assert.equal(count('HEAD', '/models'), 0);
  assert.deepEqual(outsideRequests, []);
});

test('Retry-After is honoured and the final attempt does not sleep', { timeout: 10_000 }, async () => {
  handler = (_request, response) =>
    sendJson(response, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '1' });

  await assert.rejects(
    api.apiRequest('/chat/completions', { method: 'POST', body: {}, showSpinner: false, retries: 1 }),
    /rate limited/
  );
  const failedAt = Date.now();
  const posted = requests.filter((request) => request.method === 'POST');
  assert.equal(posted.length, 2);
  const gap = posted[1].at - posted[0].at;
  assert.ok(gap >= 900, `retried after ${gap} ms`);
  assert.ok(failedAt - posted[1].at < 500, `failed ${failedAt - posted[1].at} ms after the last attempt`);
});

test('a Retry-After longer than a minute is reported instead of waited out', async () => {
  handler = (_request, response) =>
    sendJson(response, 429, { error: { message: 'rate limited' } }, { 'Retry-After': '120' });

  await assert.rejects(
    api.apiRequest('/chat/completions', { method: 'POST', body: {}, showSpinner: false }),
    (error: Error) => {
      assert.equal(error.message, 'rate limited\nThe server asked to wait 120 seconds before retrying.');
      return true;
    }
  );
  assert.equal(count('POST', '/chat/completions'), 1);
});

test('parseRetryAfter reads delta-seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(api.parseRetryAfter('5', now), 5000);
  assert.equal(api.parseRetryAfter(' 0 ', now), 0);
  assert.equal(api.parseRetryAfter('Wed, 28 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(api.parseRetryAfter('Wed, 28 Oct 2026 11:00:00 GMT', now), 0);
  for (const invalid of ['soon', '-5', '1.5', '', null, undefined]) {
    assert.equal(api.parseRetryAfter(invalid, now), undefined, String(invalid));
  }
});

test('API requests refuse redirects instead of following them', async () => {
  const redirected: string[] = [];
  const elsewhere = createServer((request, response) => {
    redirected.push(`${request.method} ${request.url}`);
    sendJson(response, 200, {
      choices: [{ message: { content: 'from elsewhere' }, finish_reason: 'stop' }],
    });
  });
  await listen(elsewhere);
  const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`;
  handler = (request, response) => {
    response.writeHead(307, { Location: `${target}${request.url}` });
    response.end();
  };

  try {
    await assert.rejects(
      api.chatCompletion([{ role: 'user', content: 'SECRET PROMPT' }], { model: 'redirect-model' }),
      /answered with a redirect/
    );
    await assert.rejects(api.textToSpeech('SECRET TEXT'), /answered with a redirect/);
    await assert.rejects(api.getVideoStatus('q1', 'redirect-model'), /answered with a redirect/);
    assert.equal(count('POST', '/video/retrieve'), 1);
    assert.deepEqual(redirected, []);
  } finally {
    elsewhere.closeAllConnections();
    elsewhere.close();
  }
});

test('a 403 shows the server reason; only a 401 suggests replacing the key', async () => {
  handler = (_request, response) =>
    sendJson(response, 403, { error: { message: 'ADMIN-KEY-REQUIRED' } });
  await assert.rejects(api.apiRequest('/api_keys', { showSpinner: false }), (error: Error) => {
    assert.equal(error.message, 'Permission denied: ADMIN-KEY-REQUIRED');
    return true;
  });
  assert.equal(count('GET', '/api_keys'), 1);

  handler = (_request, response) => sendJson(response, 401, { error: { message: 'bad key' } });
  await assert.rejects(api.apiRequest('/api_keys', { showSpinner: false }), (error: Error) => {
    assert.equal(
      error.message,
      'Authentication failed. Please check your API key.\nUpdate with: venice config set api_key'
    );
    return true;
  });
});
