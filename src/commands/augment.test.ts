import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/test-env.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

async function withApiServer(
  handler: (request: Recorded, response: ServerResponse) => void,
  callback: (context: {
    run: (args: string[]) => Promise<CliResult>;
    baseUrl: string;
    requests: Recorded[];
    tempDir: string;
  }) => Promise<void>
): Promise<void> {
  const requests: Recorded[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const recorded = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(recorded);
    handler(recorded, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-augment-test-'));
  const tempDir = join(homeDir, 'tmp');
  mkdirSync(tempDir);

  const run = (args: string[]) => new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: childEnv({
        HOME: homeDir,
        TMPDIR: tempDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: baseUrl,
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

  try {
    await callback({ run, baseUrl, requests, tempDir });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('scrape --content-format sends format, and omits it by default', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, { url: 'https://example.com/', content: '<p>hi</p>', format: 'html' });
  }, async ({ run, requests }) => {
    const html = await run(['scrape', 'https://example.com/', '--content-format', 'html']);
    assert.equal(html.status, 0, html.stderr);
    assert.equal(html.stdout, '<p>hi</p>\n');

    const plain = await run(['scrape', 'https://example.com/']);
    assert.equal(plain.status, 0, plain.stderr);

    assert.deepEqual(JSON.parse(requests[0].body.toString()), { url: 'https://example.com/', format: 'html' });
    assert.deepEqual(JSON.parse(requests[1].body.toString()), { url: 'https://example.com/' });
  });
});

test('scrape rejects an unknown --content-format before any request', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, {});
  }, async ({ run, requests }) => {
    const result = await run(['scrape', 'https://example.com/', '--content-format', 'pdf']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--content-format must be one of: markdown, html, text/);
    assert.equal(requests.length, 0);
  });
});
