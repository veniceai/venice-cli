import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./index.js', import.meta.url));

interface InterruptedRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  files: string[];
}

function hasPartialFile(workDir: string, outputName: string): boolean {
  return readdirSync(workDir).some((name) => {
    if (!name.startsWith(`.${outputName}.`)) return false;
    try {
      return statSync(join(workDir, name)).size > 0;
    } catch {
      return false;
    }
  });
}

async function interruptCli(options: {
  args: string[];
  signal: NodeJS.Signals;
  respond: (request: IncomingMessage, response: ServerResponse) => void;
  ready: (requests: string[], workDir: string) => boolean;
}): Promise<InterruptedRun> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on('end', () => options.respond(request, response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const workDir = mkdtempSync(join(tmpdir(), 'venice-signals-'));

  try {
    const child = spawn(process.execPath, [cliPath, ...options.args], {
      cwd: workDir,
      env: {
        ...process.env,
        HOME: workDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        VENICE_API_KEY: 'test-key',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (status, signal) => resolve({ status, signal }));
    });

    const deadline = Date.now() + 10_000;
    while (!options.ready(requests, workDir)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        child.kill('SIGKILL');
        assert.fail(`the CLI never reached the interrupt point; stderr: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    child.kill(options.signal);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const { status, signal } = await exited;
    clearTimeout(killTimer);
    return {
      status,
      signal,
      stderr,
      files: readdirSync(workDir).filter((name) => name !== '.venice'),
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workDir, { recursive: true, force: true });
  }
}

test('SIGINT and SIGTERM during a request exit with 130 and 143', async () => {
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const result = await interruptCli({
      args: ['chat', '--model', 'test-model', 'hello'],
      signal,
      respond: (request, response) => {
        if (request.method === 'GET' && request.url?.startsWith('/api/v1/models')) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            data: [{ id: 'test-model', type: 'text', model_spec: { capabilities: {} } }],
          }));
        }
      },
      ready: (requests) => requests.includes('POST /api/v1/chat/completions'),
    });

    assert.equal(result.signal, null, signal);
    assert.equal(result.status, exitCode, `${signal}: ${result.stderr}`);
  }
});

test('an interrupted download exits non-zero and leaves no partial file behind', async () => {
  const music = await interruptCli({
    args: ['music', 'retrieve', 'q1', '--output', 'song.mp3'],
    signal: 'SIGINT',
    respond: (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.write(Buffer.alloc(4096, 0x41));
    },
    ready: (_requests, workDir) => hasPartialFile(workDir, 'song.mp3'),
  });
  const video = await interruptCli({
    args: ['video', 'retrieve', 'q1', '--model', 'test-model', '--output', 'clip.mp4'],
    signal: 'SIGTERM',
    respond: (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.write(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096, 1)]));
    },
    ready: (_requests, workDir) => hasPartialFile(workDir, 'clip.mp4'),
  });

  assert.equal(music.status, 130, music.stderr);
  assert.deepEqual(music.files, []);
  assert.equal(video.status, 143, video.stderr);
  assert.deepEqual(video.files, []);
});

test('an interrupted keys create removes its secret file and says the key may exist', async () => {
  const result = await interruptCli({
    args: ['keys', 'create', '--name', 'ci', '--output', 'ci.key'],
    signal: 'SIGINT',
    respond: () => undefined,
    ready: (requests) => requests.includes('POST /api/v1/api_keys'),
  });

  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stderr, /The API key "ci" may have been created, but its secret was not saved/);
  assert.match(result.stderr, /venice keys list/);
  assert.deepEqual(result.files, []);
});
