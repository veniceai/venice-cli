import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function runCli(
  args: string[],
  homeDir: string,
  apiBaseUrl: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: homeDir,
    env: {
      ...process.env,
      HOME: homeDir,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      VENICE_API_KEY: 'test-key',
      VENICE_API_BASE_URL: apiBaseUrl,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { status, stdout, stderr };
}

test('tts forwards speech controls to the API', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/speech') {
      receivedBody = JSON.parse((await readBody(request)).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'audio/wav' });
      response.end('test-audio');
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-audio-test-'));
  const outputPath = join(homeDir, 'speech.wav');

  try {
    const result = await runCli([
      'tts',
      '--model', 'tts-chatterbox-hd',
      '--voice', 'vv_test',
      '--format', 'wav',
      '--speed', '1.25',
      '--temperature', '0.8',
      '--streaming',
      '--output', outputPath,
      'Hello',
    ], homeDir, apiBaseUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(receivedBody, {
      model: 'tts-chatterbox-hd',
      input: 'Hello',
      voice: 'vv_test',
      response_format: 'wav',
      speed: 1.25,
      temperature: 0.8,
      streaming: true,
    });
    assert.equal(readFileSync(outputPath, 'utf8'), 'test-audio');
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('tts uses the model default format when no override is provided', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/speech') {
      receivedBody = JSON.parse((await readBody(request)).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'audio/wav' });
      response.end('default-format-audio');
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-default-audio-test-'));
  const outputPath = join(homeDir, 'output.wav');

  try {
    const result = await runCli([
      'tts',
      '--model', 'tts-chatterbox-hd',
      '--voice', 'vv_test',
      'Hello',
    ], homeDir, apiBaseUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receivedBody?.response_format, undefined);
    assert.equal(readFileSync(outputPath, 'utf8'), 'default-format-audio');
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('tts infers the requested format from an explicit output extension', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/speech') {
      receivedBody = JSON.parse((await readBody(request)).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.end('mp3-audio');
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-output-audio-test-'));
  const outputPath = join(homeDir, 'requested.mp3');

  try {
    const result = await runCli([
      'tts', '--output', outputPath, 'Hello',
    ], homeDir, apiBaseUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receivedBody?.response_format, 'mp3');
    assert.equal(readFileSync(outputPath, 'utf8'), 'mp3-audio');
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('tts appends the effective format when the output has no extension', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/speech') {
      receivedBody = JSON.parse((await readBody(request)).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'audio/flac' });
      response.end('flac-audio');
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-extensionless-audio-test-'));
  const requestedPath = join(homeDir, 'speech');
  const outputPath = `${requestedPath}.flac`;

  try {
    const result = await runCli([
      'tts', '--output', requestedPath, 'Hello',
    ], homeDir, apiBaseUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receivedBody?.response_format, undefined);
    assert.equal(readFileSync(outputPath, 'utf8'), 'flac-audio');
    assert.equal(existsSync(requestedPath), false);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('tts replaces a misleading output extension with the effective format', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/speech') {
      receivedBody = JSON.parse((await readBody(request)).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'audio/wav' });
      response.end('wav-audio');
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-misleading-audio-test-'));
  const requestedPath = join(homeDir, 'speech.download');
  const outputPath = join(homeDir, 'speech.wav');

  try {
    const result = await runCli([
      'tts', '--output', requestedPath, 'Hello',
    ], homeDir, apiBaseUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receivedBody?.response_format, undefined);
    assert.equal(readFileSync(outputPath, 'utf8'), 'wav-audio');
    assert.equal(existsSync(requestedPath), false);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('tts uses explicit format for the request and a mismatched output extension', async () => {
  let receivedBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/speech') {
      receivedBody = JSON.parse((await readBody(request)).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'audio/wav' });
      response.end('mp3-audio');
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-explicit-audio-test-'));
  const requestedPath = join(homeDir, 'speech.wav');
  const outputPath = join(homeDir, 'speech.mp3');

  try {
    const result = await runCli([
      'tts', '--format', 'mp3', '--output', requestedPath, 'Hello',
    ], homeDir, apiBaseUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receivedBody?.response_format, 'mp3');
    assert.equal(readFileSync(outputPath, 'utf8'), 'mp3-audio');
    assert.equal(existsSync(requestedPath), false);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('transcribe raw prints only the transcript while pretty keeps decorations', async () => {
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/transcriptions') {
      await readBody(request);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        text: 'hello from the recording',
        duration: 1.23,
        timestamps: { segment: [{ text: 'hello from the recording', start: 0, end: 1.23 }] },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-transcribe-test-'));
  const samplePath = join(homeDir, 'sample.wav');
  writeFileSync(samplePath, 'recording-audio');

  try {
    for (const args of [['-f', 'raw'], ['-t', '-f', 'raw']]) {
      const result = await runCli(['transcribe', samplePath, ...args], homeDir, apiBaseUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'hello from the recording\n');
    }

    const pretty = await runCli(['transcribe', samplePath, '-t', '-f', 'pretty'], homeDir, apiBaseUrl);
    assert.equal(pretty.status, 0, pretty.stderr);
    assert.match(pretty.stdout, /Segments:/);
    assert.match(pretty.stdout, /Duration: 1\.23s/);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('voices lists live model-specific voice data', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/models?type=tts') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        data: [{
          id: 'tts-live',
          type: 'tts',
          model_spec: { voices: ['LiveVoice'], default_voice: 'LiveVoice' },
        }],
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-voices-test-'));

  try {
    const result = await runCli(['voices', '--format', 'json'], homeDir, apiBaseUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{
      id: 'LiveVoice',
      model: 'tts-live',
      default: true,
    }]);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('voice clone uploads a multipart reference sample', async () => {
  let contentType = '';
  let requestBody = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/audio/voices') {
      contentType = String(request.headers['content-type']);
      requestBody = (await readBody(request)).toString('latin1');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'vv_test_handle', model: 'tts-chatterbox-hd' }));
      return;
    }
    response.writeHead(404).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-clone-test-'));
  const samplePath = join(homeDir, 'sample.wav');
  writeFileSync(samplePath, 'reference-audio');

  try {
    const result = await runCli([
      'voice', 'clone', samplePath, '--format', 'json',
    ], homeDir, apiBaseUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: 'vv_test_handle',
      model: 'tts-chatterbox-hd',
    });
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(requestBody, /name="model"\r\n\r\ntts-chatterbox-hd/);
    assert.match(requestBody, /name="file"; filename="sample.wav"/);
    assert.match(requestBody, /reference-audio/);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('voice clone rejects oversized samples before upload', async () => {
  let requestReceived = false;
  const server = createServer((_request, response) => {
    requestReceived = true;
    response.writeHead(500).end();
  });
  const apiBaseUrl = await listen(server);
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-clone-size-test-'));
  const samplePath = join(homeDir, 'large.wav');
  writeFileSync(samplePath, '');
  truncateSync(samplePath, 25 * 1024 * 1024 + 1);

  try {
    const result = await runCli([
      'voice', 'clone', samplePath,
    ], homeDir, apiBaseUrl);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Voice reference sample is too large/);
    assert.equal(requestReceived, false);
  } finally {
    server.close();
    rmSync(homeDir, { recursive: true, force: true });
  }
});
