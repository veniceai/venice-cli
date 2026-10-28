import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
