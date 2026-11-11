import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

test('parse downloads a document URL and uploads it with its name and media type', async () => {
  await withApiServer((request, response) => {
    if (request.url === '/files/Annual%20Report.pdf') {
      response.writeHead(200, { 'Content-Type': 'application/pdf' });
      response.end('%PDF-1.4 remote document');
      return;
    }
    if (request.url === '/augment/text-parser') {
      sendJson(response, { text: 'parsed\u001b]0;pwned\u0007 text\u202e', tokens: 2 });
      return;
    }
    response.writeHead(404).end();
  }, async ({ run, baseUrl, requests, tempDir }) => {
    const result = await run(['parse', `${baseUrl}/files/Annual%20Report.pdf`, '-f', 'pretty']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^parsed text\n/);
    assert.doesNotMatch(result.stdout, /[\u001b\u0007\u202e]/);

    assert.deepEqual(requests.map((request) => request.url), ['/files/Annual%20Report.pdf', '/augment/text-parser']);
    assert.equal(requests[0].headers.authorization, undefined);
    const upload = requests[1].body.toString('utf8');
    assert.match(upload, /filename="Annual Report\.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF-1\.4 remote document\r\n/);
    assert.deepEqual(readdirSync(tempDir), []);
  });
});

test('parse refuses document URLs that are not https to a public address', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, {});
  }, async ({ run, requests }) => {
    const plainHttp = await run(['parse', 'http://example.com/report.pdf']);
    assert.equal(plainHttp.status, 1);
    assert.match(plainHttp.stderr, /only https URLs are allowed/);

    const loopback = await run(['parse', 'https://127.0.0.1/report.pdf']);
    assert.equal(loopback.status, 1);
    assert.match(loopback.stderr, /127\.0\.0\.1 is not a public address/);

    const metadata = await run(['parse', 'https://169.254.169.254/latest/meta-data']);
    assert.equal(metadata.status, 1);
    assert.match(metadata.stderr, /is not a public address/);

    assert.equal(requests.length, 0);
  });
});

test('parse rejects a downloaded document with the wrong type or size before uploading', async () => {
  await withApiServer((request, response) => {
    if (request.url === '/image.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end('png');
      return;
    }
    if (request.url === '/huge.pdf') {
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(26 * 1024 * 1024) });
      response.write('%PDF');
      return;
    }
    sendJson(response, { text: 'unexpected', tokens: 1 });
  }, async ({ run, baseUrl, requests, tempDir }) => {
    const image = await run(['parse', `${baseUrl}/image.png`]);
    assert.equal(image.status, 1);
    assert.match(image.stderr, /Unexpected content type "image\/png"/);

    const huge = await run(['parse', `${baseUrl}/huge.pdf`]);
    assert.equal(huge.status, 1);
    assert.match(huge.stderr, /Maximum allowed size is 25\.0 MB/);

    assert.equal(requests.some((request) => request.url === '/augment/text-parser'), false);
    assert.deepEqual(readdirSync(tempDir), []);
  });
});
