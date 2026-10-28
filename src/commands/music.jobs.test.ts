import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
type Stub = {
  origin: string;
  count: (route: string) => number;
  close: () => Promise<void>;
};

async function startStub(routes: Record<string, Route>): Promise<Stub> {
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    const route = `${request.method} ${request.url}`;
    seen.push(route);
    const handler = routes[route];
    if (!handler) {
      response.writeHead(404);
      response.end();
      return;
    }
    await handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    count: (route) => seen.filter((entry) => entry === route).length,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendAudio(response: ServerResponse, bytes: Buffer): void {
  response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length) });
  response.end(bytes);
}

function runCli(
  args: string[],
  dir: string,
  apiOrigin: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: `${apiOrigin}/api/v1`,
        VENICE_TEST_POLL_INTERVAL_MS: '50',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withScratch(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'venice-music-jobs-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RETRIEVE = 'POST /api/v1/audio/retrieve';

test('music status --wait stops at --timeout while the job stays PROCESSING', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    [RETRIEVE]: (_request, response) => sendJson(response, { status: 'PROCESSING' }),
  });
  try {
    const result = await runCli(['music', 'status', 'mq1', '--wait', '--timeout', '1'], dir, stub.origin);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Timed out waiting for audio generation after 1 seconds\./);
    assert.ok(stub.count(RETRIEVE) >= 2);
  } finally {
    await stub.close();
  }
}));

test('music status --wait keeps polling PENDING and IN_PROGRESS until the audio is ready', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const statuses = ['PENDING', 'IN_PROGRESS'];
  const audio = Buffer.alloc(64, 0xff);
  const stub = await startStub({
    [RETRIEVE]: (_request, response) => {
      const status = statuses.shift();
      if (status) sendJson(response, { status });
      else sendAudio(response, audio);
    },
  });
  try {
    const result = await runCli(['music', 'status', 'mq1', '--wait', '-f', 'json'], dir, stub.origin);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'COMPLETED',
      content_type: 'audio/mpeg',
      size_bytes: audio.length,
    });
    assert.equal(stub.count(RETRIEVE), 3);
  } finally {
    await stub.close();
  }
}));

test('music status --wait exits 1 when the job fails or ends in an unrecognised status', { timeout: 20_000 }, () => withScratch(async (dir) => {
  let body: Record<string, string> = { status: 'FAILED', error: 'generation failed' };
  const stub = await startStub({
    [RETRIEVE]: (_request, response) => sendJson(response, body),
  });
  try {
    const json = await runCli(['music', 'status', 'mq1', '--wait', '-f', 'json'], dir, stub.origin);
    assert.equal(json.status, 1, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), body);

    const pretty = await runCli(['music', 'status', 'mq1', '--wait', '-f', 'pretty'], dir, stub.origin);
    assert.equal(pretty.status, 1);
    assert.match(pretty.stdout, /Status: FAILED/);
    assert.match(pretty.stderr, /Error: generation failed/);

    body = { status: 'MYSTERY' };
    const unknown = await runCli(['music', 'status', 'mq1', '--wait', '-f', 'pretty'], dir, stub.origin);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Audio generation ended with status "MYSTERY"/);
    assert.equal(stub.count(RETRIEVE), 3);
  } finally {
    await stub.close();
  }
}));

test('music status --wait accepts a --timeout beyond the 32-bit timer limit', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const audio = Buffer.alloc(64, 0xff);
  const stub = await startStub({
    [RETRIEVE]: async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      sendAudio(response, audio);
    },
  });
  try {
    const result = await runCli(
      ['music', 'status', 'mq1', '--wait', '--timeout', '2147484', '-f', 'json'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'COMPLETED');
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning|Timed out/);
  } finally {
    await stub.close();
  }
}));

test('music retrieve exits 2 while the audio is processing and 1 when the job failed', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const statuses: Record<string, unknown> = {
    'mq-processing': { status: 'PROCESSING' },
    'mq-failed': { status: 'FAILED', error: 'generation failed' },
  };
  const stub = await startStub({
    [RETRIEVE]: async (request, response) => {
      sendJson(response, statuses[String((await readJson(request)).queue_id)]);
    },
    'POST /api/v1/audio/complete': (_request, response) => sendJson(response, { success: true }),
  });
  const output = join(dir, 'out.mp3');
  const cases: Array<[string, number, RegExp]> = [
    ['mq-processing', 2, /Audio is not ready yet/],
    ['mq-failed', 1, /Error: generation failed/],
  ];
  try {
    for (const [queueId, exitCode, prettyMessage] of cases) {
      const json = await runCli(['music', 'retrieve', queueId, '-o', output, '-f', 'json'], dir, stub.origin);
      assert.equal(json.status, exitCode, `${queueId} json: ${json.stderr}`);
      assert.deepEqual(JSON.parse(json.stdout), statuses[queueId]);

      const pretty = await runCli(['music', 'retrieve', queueId, '-o', output, '-f', 'pretty'], dir, stub.origin);
      assert.equal(pretty.status, exitCode, `${queueId} pretty: ${pretty.stderr}`);
      assert.match(pretty.stdout + pretty.stderr, prettyMessage);
    }
    assert.equal(existsSync(output), false);
    assert.equal(stub.count('POST /api/v1/audio/complete'), 0);
  } finally {
    await stub.close();
  }
}));

test('music complete exits 1 when Venice reports success: false, in every output format', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/audio/complete': (_request, response) => sendJson(response, { success: false }),
  });
  try {
    const json = await runCli(['music', 'complete', 'mq1', '-f', 'json'], dir, stub.origin);
    assert.equal(json.status, 1, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { success: false });

    const pretty = await runCli(['music', 'complete', 'mq1', '-f', 'pretty'], dir, stub.origin);
    assert.equal(pretty.status, 1);
    assert.match(pretty.stderr, /Remote audio cleanup did not complete/);
  } finally {
    await stub.close();
  }
}));

test('music commands fail clearly on a 200 response of the wrong shape', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/audio/queue': (_request, response) => sendJson(response, {}),
    'POST /api/v1/audio/quote': (_request, response) => sendJson(response, {}),
    [RETRIEVE]: (_request, response) => sendJson(response, {}),
    'POST /api/v1/audio/complete': (_request, response) => sendJson(response, {}),
  });
  const cases: Array<[string[], string]> = [
    [['music', 'generate', 'a song'], '/audio/queue'],
    [['music', 'quote'], '/audio/quote'],
    [['music', 'status', 'mq1'], '/audio/retrieve'],
    [['music', 'retrieve', 'mq1', '-o', join(dir, 'out.mp3')], '/audio/retrieve'],
    [['music', 'complete', 'mq1', '-f', 'json'], '/audio/complete'],
  ];
  try {
    for (const [args, endpoint] of cases) {
      const result = await runCli(args, dir, stub.origin);
      const label = args.join(' ');

      assert.equal(result.status, 1, `${label}: ${result.stdout}`);
      assert.ok(
        result.stderr.includes(`Unexpected response from Venice (${endpoint})`),
        `${label}: ${result.stderr}`
      );
      assert.doesNotMatch(result.stdout, /undefined|queued!/, label);
    }
  } finally {
    await stub.close();
  }
}));

test('music status without --wait reports a failed job and exits 0', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    [RETRIEVE]: (_request, response) => sendJson(response, { status: 'FAILED', error: 'generation failed' }),
  });
  try {
    const result = await runCli(['music', 'status', 'mq1', '-f', 'json'], dir, stub.origin);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'FAILED');
  } finally {
    await stub.close();
  }
}));
