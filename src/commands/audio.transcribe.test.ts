import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function withTranscriptionServer(
  respond: (response: ServerResponse) => void,
  callback: (run: (args: string[]) => Promise<CliResult>, bodies: string[]) => Promise<void>
): Promise<void> {
  const bodies: string[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    if (request.url !== '/audio/transcriptions') {
      response.writeHead(404).end();
      return;
    }
    respond(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-transcribe-format-test-'));
  const samplePath = join(homeDir, 'sample.wav');
  writeFileSync(samplePath, 'recording-audio');

  const run = (args: string[]) => new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'transcribe', samplePath, ...args], {
      env: childEnv({
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: `http://127.0.0.1:${port}`,
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
    await callback(run, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('transcribe --response-format text sends response_format=text and prints the plain transcript', async () => {
  await withTranscriptionServer((response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('hello\u001b]0;pwned\u0007 world\u202e');
  }, async (run, bodies) => {
    const pretty = await run(['--response-format', 'text', '-f', 'pretty']);
    assert.equal(pretty.status, 0, pretty.stderr);
    assert.equal(pretty.stdout, 'hello world\n');

    const json = await run(['--response-format', 'text', '-f', 'json']);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { text: 'hello\u001b]0;pwned\u0007 world\u202e' });

    assert.match(bodies[0], /name="response_format"\r\n\r\ntext\r\n/);
  });
});

test('transcribe --response-format text accepts a JSON-typed transcript', async () => {
  await withTranscriptionServer((response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify('quoted transcript'));
  }, async (run) => {
    const result = await run(['--response-format', 'text', '-f', 'raw']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'quoted transcript\n');
  });
});

test('transcribe still requests JSON by default', async () => {
  await withTranscriptionServer((response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ text: 'default' }));
  }, async (run, bodies) => {
    const result = await run(['-f', 'raw']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(bodies[0], /name="response_format"\r\n\r\njson\r\n/);
  });
});

test('transcribe rejects bad --response-format combinations before uploading', async () => {
  await withTranscriptionServer((response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ text: 'unused' }));
  }, async (run, bodies) => {
    const unknown = await run(['--response-format', 'srt']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /--response-format must be json or text/);

    const withTimestamps = await run(['--response-format', 'text', '-t']);
    assert.equal(withTimestamps.status, 1);
    assert.match(withTimestamps.stderr, /--timestamps needs --response-format json/);

    assert.equal(bodies.length, 0);
  });
});
