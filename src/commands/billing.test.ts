import { spawn } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/test-env.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], homeDir: string, apiBaseUrl: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: childEnv({
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: apiBaseUrl,
        VENICE_API_KEY: 'test-admin-key',
      }),
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

async function withApiServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (run: (args: string[]) => Promise<CliResult>) => Promise<void>
): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-billing-test-'));
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback((args) => runCli(args, homeDir, baseUrl));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function searchParams(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? '/', 'http://localhost').searchParams;
}

test('billing analytics sends startDate and endDate for --start/--end', async () => {
  const queries: URLSearchParams[] = [];
  await withApiServer((request, response) => {
    queries.push(searchParams(request));
    sendJson(response, { data: [] });
  }, async (run) => {
    const result = await run(['billing', 'analytics', '--start', '2026-10-01', '--end', '2026-10-31', '-f', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const defaults = await run(['billing', 'analytics', '-f', 'json']);
    assert.equal(defaults.status, 0, defaults.stderr);
  });

  assert.deepEqual([...queries[0].entries()], [['startDate', '2026-10-01'], ['endDate', '2026-10-31']]);
  assert.deepEqual([...queries[1].entries()], [['lookback', '30d']]);
});

test('billing analytics rejects invalid ranges before any request', async () => {
  let requests = 0;
  await withApiServer((_request, response) => {
    requests++;
    sendJson(response, {});
  }, async (run) => {
    const cases: Array<[string[], RegExp]> = [
      [['--lookback', '7d', '--start', '2026-10-01', '--end', '2026-10-31'], /either --lookback or --start\/--end/],
      [['--start', '2026-10-01'], /--start and --end must be given together/],
      [['--end', '2026-10-01'], /--start and --end must be given together/],
      [['--start', '2026-10-31', '--end', '2026-10-01'], /--start cannot be later than --end/],
      [['--start', '2026-02-30', '--end', '2026-03-01'], /--start must be a calendar date/],
      [['--start', '2026-10-01T00:00:00Z', '--end', '2026-10-02'], /--start must be a calendar date/],
      [['--lookback', '91d'], /lookback must be between 1d and 90d/],
    ];
    for (const [args, message] of cases) {
      const result = await run(['billing', 'analytics', ...args]);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
    }
  });
  assert.equal(requests, 0);
});

test('billing usage sends --start/--end timestamps as given', async () => {
  const queries: URLSearchParams[] = [];
  await withApiServer((request, response) => {
    queries.push(searchParams(request));
    sendJson(response, { data: [], nextCursor: null });
  }, async (run) => {
    const result = await run([
      'billing', 'usage',
      '--start', '2026-10-01T00:00:00Z',
      '--end', '2026-10-08T12:30:00.5Z',
      '--currency', 'diem',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Billed Usage - 2026-10-01T00:00:00Z to 2026-10-08T12:30:00\.5Z/);

    const startOnly = await run(['billing', 'usage', '--start', '2026-10-01T00:00:00Z', '-f', 'json']);
    assert.equal(startOnly.status, 0, startOnly.stderr);
  });

  assert.equal(queries[0].get('startTimestamp'), '2026-10-01T00:00:00Z');
  assert.equal(queries[0].get('endTimestamp'), '2026-10-08T12:30:00.5Z');
  assert.equal(queries[0].get('currency'), 'DIEM');
  assert.equal(queries[1].get('startTimestamp'), '2026-10-01T00:00:00Z');
  assert.equal(queries[1].has('endTimestamp'), false);
});

test('billing usage rejects invalid ranges before any request', async () => {
  let requests = 0;
  await withApiServer((_request, response) => {
    requests++;
    sendJson(response, { data: [], nextCursor: null });
  }, async (run) => {
    const cases: Array<[string[], RegExp]> = [
      [['--days', '3', '--start', '2026-10-01T00:00:00Z'], /either --days or --start\/--end/],
      [['--start', '2026-10-01T00:00:00+01:00'], /--start must be an ISO 8601 UTC timestamp/],
      [['--end', '2026-10-01'], /--end must be an ISO 8601 UTC timestamp/],
      [['--start', '2026-02-30T00:00:00Z'], /--start must be an ISO 8601 UTC timestamp/],
      [['--start', '2026-10-02T00:00:00Z', '--end', '2026-10-02T00:00:00Z'], /--end must be later than --start/],
      [['--start', '2026-10-01T00:00:00Z', '--page-size', '5'], /--page-size must be an integer between 10 and 1000/],
      [['--format', 'xml'], /Invalid --format "xml"/],
    ];
    for (const [args, message] of cases) {
      const result = await run(['billing', 'usage', ...args]);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
    }
  });
  assert.equal(requests, 0);
});

test('billing usage -f csv requests text/csv and prints one stitched document', async () => {
  const requests: Array<{ accept: string | undefined; query: URLSearchParams }> = [];
  await withApiServer((request, response) => {
    const query = searchParams(request);
    requests.push({ accept: request.headers.accept, query });
    if (query.has('cursor')) {
      response.writeHead(200, { 'Content-Type': 'text/csv' });
      response.end('timestamp,sku\n2026-10-02T00:00:00Z,evil\u001b]0;pwned\u0007-sku\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/csv', 'X-Next-Cursor': 'next_1' });
      response.end('timestamp,sku\n2026-10-01T00:00:00Z,image\n');
    }
  }, async (run) => {
    const result = await run(['billing', 'usage', '--days', '2', '-f', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'timestamp,sku\n2026-10-01T00:00:00Z,image\n2026-10-02T00:00:00Z,evil-sku\n'
    );
  });

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.accept === 'text/csv'));
  assert.ok(requests[0].query.has('startTimestamp'));
  assert.deepEqual([...requests[1].query.entries()], [['cursor', 'next_1']]);
});

test('billing usage pretty output sanitises server strings', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, {
      data: [{
        amount: 0.5,
        currency: 'USD\u001b[2J',
        inferenceDetails: null,
        notes: '',
        pricePerUnitUsd: 0.5,
        sku: 'chat\u001b]8;;https://evil.example\u0007link\u202e',
        timestamp: '2026-10-01T00:00:00Z',
        units: 1,
      }],
      nextCursor: null,
    });
  }, async (run) => {
    const result = await run(['billing', 'usage', '--start', '2026-10-01T00:00:00Z', '-f', 'pretty']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Billed Usage - Since 2026-10-01T00:00:00Z/);
    assert.match(result.stdout, /chatlink/);
    assert.doesNotMatch(result.stdout, /[\u001b\u0007\u202e]/);
  });
});
