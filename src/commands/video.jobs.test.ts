import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

type Route = (request: IncomingMessage, response: ServerResponse, stub: Stub) => void | Promise<void>;
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
    await handler(request, response, stub);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub: Stub = {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    count: (route) => seen.filter((entry) => entry === route).length,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  return stub;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function runCli(
  args: string[],
  dir: string,
  apiOrigin: string,
  env: NodeJS.ProcessEnv = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: dir,
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: dir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: `${apiOrigin}/api/v1`,
        ...env,
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

function mp4Bytes(tail = ''): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(header.length, 0);
  header.write('ftypisom', 4, 'latin1');
  header.write('isommp41', 16, 'latin1');
  return Buffer.concat([header, Buffer.from(tail)]);
}

async function withScratch(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'venice-video-jobs-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('video retrieve does not save a JSON status whose bytes 4-7 spell ftyp, or delete the remote copy', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/retrieve': (_request, response) => {
      sendJson(response, '{  "ftyp":1,"status":"FAILED","error":"quota"}');
    },
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, { success: true }),
  });
  const output = join(dir, 'out.mp4');
  try {
    const result = await runCli(
      ['video', 'retrieve', 'q1', '-m', 'test-model', '-o', output, '--complete', '-f', 'json'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(output), false, result.stdout);
    assert.equal(stub.count('POST /api/v1/video/complete'), 0);
    assert.equal(JSON.parse(result.stdout).status, 'FAILED');
  } finally {
    await stub.close();
  }
}));

test('video retrieve saves and completes an MP4 whose first box is free', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const video = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('free'), mp4Bytes('-frames')]);
  const stub = await startStub({
    'POST /api/v1/video/retrieve': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(video);
    },
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, { success: true }),
  });
  const output = join(dir, 'out.mp4');
  try {
    const result = await runCli(
      ['video', 'retrieve', 'q1', '-m', 'test-model', '-o', output, '--complete', '-f', 'json'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output).equals(video), true);
    assert.equal(JSON.parse(result.stdout).deleted, true);
    assert.equal(stub.count('POST /api/v1/video/complete'), 1);
  } finally {
    await stub.close();
  }
}));

test('video retrieve refuses a download URL on another local server and keeps the remote copy', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const intranet = await startStub({
    'GET /admin/backup.mp4': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(mp4Bytes('-internal'));
    },
  });
  const stub = await startStub({
    'POST /api/v1/video/retrieve': (_request, response) => {
      sendJson(response, { status: 'COMPLETED', video_url: `${intranet.origin}/admin/backup.mp4` });
    },
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, { success: true }),
  });
  const output = join(dir, 'out.mp4');
  try {
    const result = await runCli(
      ['video', 'retrieve', 'q1', '-m', 'test-model', '-o', output, '--complete'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Refusing to download from 127\.0\.0\.1:\d+: only https URLs are allowed/);
    assert.equal(intranet.count('GET /admin/backup.mp4'), 0);
    assert.equal(stub.count('POST /api/v1/video/complete'), 0);
    assert.equal(existsSync(output), false);
  } finally {
    await intranet.close();
    await stub.close();
  }
}));

test('video retrieve exits 2 while the job is processing and 1 when no video will come', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const statuses: Record<string, unknown> = {
    'q-processing': { status: 'PROCESSING', execution_duration: 1000 },
    'q-failed': { status: 'FAILED', error: 'render failed' },
    'q-no-url': { status: 'COMPLETED' },
  };
  const stub = await startStub({
    'POST /api/v1/video/retrieve': async (request, response) => {
      sendJson(response, statuses[String((await readJson(request)).queue_id)]);
    },
  });
  const output = join(dir, 'out.mp4');
  const cases: Array<[string, number, RegExp]> = [
    ['q-processing', 2, /video not ready yet/],
    ['q-failed', 1, /No video was returned \(status: FAILED\): render failed/],
    ['q-no-url', 1, /reports the job as COMPLETED but returned no video[\s\S]*venice video retrieve q-no-url -m test-model --url <download_url>/],
  ];
  try {
    for (const [queueId, exitCode, prettyMessage] of cases) {
      const json = await runCli(
        ['video', 'retrieve', queueId, '-m', 'test-model', '-o', output, '-f', 'json'],
        dir,
        stub.origin
      );
      assert.equal(json.status, exitCode, `${queueId} json: ${json.stderr}`);
      assert.deepEqual(JSON.parse(json.stdout), statuses[queueId]);

      const pretty = await runCli(
        ['video', 'retrieve', queueId, '-m', 'test-model', '-o', output, '-f', 'pretty'],
        dir,
        stub.origin
      );
      assert.equal(pretty.status, exitCode, `${queueId} pretty: ${pretty.stderr}`);
      assert.match(pretty.stdout + pretty.stderr, prettyMessage);
    }
    assert.equal(existsSync(output), false);
  } finally {
    await stub.close();
  }
}));

test('video status --wait exits 1 unless the job completes, in every output format', { timeout: 30_000 }, () => withScratch(async (dir) => {
  let body: Record<string, string> = { status: 'failed', error: 'render failed' };
  const stub = await startStub({
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, body),
  });
  const wait = ['video', 'status', 'q1', '-m', 'test-model', '--wait'];
  try {
    const json = await runCli([...wait, '-f', 'json'], dir, stub.origin);
    assert.equal(json.status, 1, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), body);

    const pretty = await runCli([...wait, '-f', 'pretty'], dir, stub.origin);
    assert.equal(pretty.status, 1);
    assert.match(pretty.stdout, /Status: failed/);
    assert.match(pretty.stderr, /Error:.*render failed/);

    const once = await runCli(['video', 'status', 'q1', '-m', 'test-model', '-f', 'json'], dir, stub.origin);
    assert.equal(once.status, 0, once.stderr);

    body = { status: 'MYSTERY' };
    const unknown = await runCli([...wait, '-f', 'pretty'], dir, stub.origin);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Video generation ended with status "MYSTERY"/);
  } finally {
    await stub.close();
  }
}));

test('video status --wait prints the status it waited for without fetching it again', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const responses: Array<Record<string, string>> = [
    { status: 'PROCESSING' },
    { status: 'PROCESSING' },
    { status: 'completed' },
  ];
  const stub = await startStub({
    'POST /api/v1/video/retrieve': (_request, response) =>
      sendJson(response, responses.shift() ?? { status: 'failed', error: 'status fetched again' }),
  });
  try {
    const result = await runCli(
      ['video', 'status', 'q1', '-m', 'test-model', '--wait', '-f', 'json'],
      dir,
      stub.origin,
      { VENICE_TEST_POLL_INTERVAL_MS: '50' }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'completed' });
    assert.equal(stub.count('POST /api/v1/video/retrieve'), 3);
  } finally {
    await stub.close();
  }
}));

test('video complete exits 1 when Venice reports success: false, in every output format', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, { success: false }),
  });
  try {
    const json = await runCli(['video', 'complete', 'q1', '-m', 'test-model', '-f', 'json'], dir, stub.origin);
    assert.equal(json.status, 1, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { success: false });

    const pretty = await runCli(['video', 'complete', 'q1', '-m', 'test-model', '-f', 'pretty'], dir, stub.origin);
    assert.equal(pretty.status, 1);
    assert.match(pretty.stderr, /Video cleanup did not succeed/);
  } finally {
    await stub.close();
  }
}));

test('video commands fail clearly on a 200 response of the wrong shape', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, {}),
    'POST /api/v1/video/quote': (_request, response) => sendJson(response, {}),
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, {}),
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, {}),
  });
  const output = join(dir, 'out.mp4');
  const cases: Array<[string[], string]> = [
    [['video', 'generate', 'a cat'], '/video/queue'],
    [['video', 'quote', '-m', 'test-model', 'a cat'], '/video/quote'],
    [['video', 'status', 'q1', '-m', 'test-model'], '/video/retrieve'],
    [['video', 'retrieve', 'q1', '-m', 'test-model', '-o', output], '/video/retrieve'],
    [['video', 'complete', 'q1', '-m', 'test-model', '-f', 'json'], '/video/complete'],
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
    assert.equal(existsSync(output), false);
  } finally {
    await stub.close();
  }
}));

test('video generate falls back to the requested model when the queue response omits it', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: 'q1' }),
  });
  try {
    const result = await runCli(['video', 'generate', 'a cat', '-m', 'test-model'], dir, stub.origin);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Queue ID: q1/);
    assert.match(result.stdout, /Model: test-model/);
  } finally {
    await stub.close();
  }
}));

test('video status --wait accepts the maximum --timeout of 24 hours', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/retrieve': async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      sendJson(response, { status: 'completed' });
    },
  });
  try {
    const result = await runCli(
      ['video', 'status', 'q1', '-m', 'test-model', '--wait', '--timeout', '86400'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Status: completed/);
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning|Timed out/);
  } finally {
    await stub.close();
  }
}));

test('video retrieve refuses a downloaded body that is not an MP4 and keeps the remote copy', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/retrieve': (_request, response, self) => {
      sendJson(response, { status: 'COMPLETED', video_url: `${self.origin}/media/clip.mp4` });
    },
    'GET /media/clip.mp4': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end('{"error":"link expired"}');
    },
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, { success: true }),
  });
  const output = join(dir, 'out.mp4');
  writeFileSync(output, 'existing video');
  try {
    const result = await runCli(
      ['video', 'retrieve', 'q1', '-m', 'test-model', '-o', output, '--complete'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /not a valid MP4/);
    assert.equal(stub.count('GET /media/clip.mp4'), 1);
    assert.equal(stub.count('POST /api/v1/video/complete'), 0);
    assert.equal(readFileSync(output, 'utf8'), 'existing video');
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.part')), []);
  } finally {
    await stub.close();
  }
}));

test('video generate and upscale --no-wait show the one-time download_url from the queue response', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const downloadUrl = 'https://media.example.com/clip.mp4?sig=abc&exp=1';
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => {
      sendJson(response, { queue_id: 'q1', model: 'test-model', download_url: downloadUrl });
    },
  });
  try {
    const commands = [
      ['video', 'generate', 'a cat', '-m', 'test-model'],
      ['video', 'upscale', 'https://example.com/input.mp4', '-m', 'test-model', '--no-wait'],
    ];
    for (const args of commands) {
      const pretty = await runCli([...args, '-f', 'pretty'], dir, stub.origin);
      assert.equal(pretty.status, 0, pretty.stderr);
      assert.ok(pretty.stdout.includes(`Download URL: ${downloadUrl}`), pretty.stdout);
      assert.match(pretty.stdout, /only once and it expires within 24 hours/);
      assert.ok(
        pretty.stdout.includes(`venice video retrieve q1 -m test-model --url '${downloadUrl}'`),
        pretty.stdout
      );

      const json = await runCli([...args, '-f', 'json'], dir, stub.origin);
      assert.equal(json.status, 0, json.stderr);
      assert.equal(JSON.parse(json.stdout).download_url, downloadUrl);
    }
  } finally {
    await stub.close();
  }
}));

test('video generate never writes terminal controls from download_url or suggests a command for an unsafe link', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const unsafe: Record<string, string> = {
    'q-osc': 'https://media.example.com/a.mp4\u001b]52;c;ZWNobyBwd25lZA==\u0007',
    'q-csi': 'https://media.example.com/a.mp4\r\u001b[2Kvenice video retrieve q-csi -m test-model --url https://evil.example',
    'q-c1': 'https://media.example.com/a.mp4\u009b2K',
    'q-http': 'http://media.example.com/a.mp4',
    'q-junk': 'not a url',
  };
  const stub = await startStub({
    'POST /api/v1/video/queue': async (request, response) => {
      const queueId = String((await readJson(request)).prompt);
      sendJson(response, { queue_id: queueId, model: 'test-model', download_url: unsafe[queueId] });
    },
  });
  try {
    for (const [queueId, downloadUrl] of Object.entries(unsafe)) {
      const pretty = await runCli(['video', 'generate', queueId, '-m', 'test-model', '-f', 'pretty'], dir, stub.origin);
      assert.equal(pretty.status, 0, pretty.stderr);
      assert.doesNotMatch(pretty.stdout, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, `${queueId}: raw control byte in output`);
      assert.doesNotMatch(pretty.stdout, /Download with:/, `${queueId}: suggested a command for an unsafe link`);
      assert.match(pretty.stdout, /not a valid https URL/, queueId);

      const json = await runCli(['video', 'generate', queueId, '-m', 'test-model', '-f', 'json'], dir, stub.origin);
      assert.equal(json.status, 0, json.stderr);
      assert.equal(JSON.parse(json.stdout).download_url, downloadUrl, queueId);
    }
  } finally {
    await stub.close();
  }
}));

test('video generate rejects a download_url that is not a string', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => {
      sendJson(response, { queue_id: 'q1', model: 'test-model', download_url: 42 });
    },
  });
  try {
    const result = await runCli(['video', 'generate', 'a cat'], dir, stub.origin);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Unexpected response from Venice \(\/video\/queue\)/);
  } finally {
    await stub.close();
  }
}));

test('video retrieve --url downloads the queued link and completes only after it is saved', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const video = mp4Bytes('-queued');
  const stub = await startStub({
    'GET /media/ok.mp4': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(video);
    },
    'GET /media/expired.mp4': (_request, response) => {
      response.writeHead(410, { 'Content-Type': 'text/plain' });
      response.end('gone');
    },
    'POST /api/v1/video/complete': (_request, response) => {
      assert.equal(readFileSync(join(dir, 'ok.mp4')).equals(video), true);
      sendJson(response, { success: true });
    },
  });
  try {
    const saved = await runCli(
      ['video', 'retrieve', 'q1', '-m', 'test-model', '-o', join(dir, 'ok.mp4'), '--url', `${stub.origin}/media/ok.mp4`, '--complete', '-f', 'json'],
      dir,
      stub.origin
    );
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(JSON.parse(saved.stdout), {
      status: 'completed',
      output: join(dir, 'ok.mp4'),
      model: 'test-model',
      deleted: true,
    });
    assert.equal(stub.count('POST /api/v1/video/complete'), 1);

    const expired = await runCli(
      ['video', 'retrieve', 'q2', '-m', 'test-model', '-o', join(dir, 'expired.mp4'), '--url', `${stub.origin}/media/expired.mp4`, '--complete'],
      dir,
      stub.origin
    );
    assert.equal(expired.status, 1, expired.stdout);
    assert.equal(existsSync(join(dir, 'expired.mp4')), false);
    assert.equal(stub.count('POST /api/v1/video/complete'), 1);
    assert.equal(stub.count('POST /api/v1/video/retrieve'), 0);
  } finally {
    await stub.close();
  }
}));

test('video upscale falls back to the queued download_url when retrieve returns no video', { timeout: 30_000 }, () => withScratch(async (dir) => {
  const video = mp4Bytes('-upscaled');
  const output = join(dir, 'upscaled.mp4');
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response, self) => {
      sendJson(response, { queue_id: 'q1', model: 'topaz-video-upscale', download_url: `${self.origin}/media/up.mp4` });
    },
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, { status: 'COMPLETED' }),
    'GET /media/up.mp4': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(video);
    },
  });
  try {
    const result = await runCli(
      ['video', 'upscale', 'https://example.com/input.mp4', '-o', output, '-f', 'json'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output).equals(video), true);
    assert.equal(stub.count('GET /media/up.mp4'), 1);
  } finally {
    await stub.close();
  }
}));

const catalog = {
  data: [{
    id: 'test-model',
    type: 'video',
    model_spec: {
      constraints: { aspect_ratios: ['9:16', '16:9'], durations: ['6s', '10s'], resolutions: ['720p'] },
    },
  }],
};

test("video generate --wait uses the model's first listed ratio and duration, saves the video and prints one JSON object", { timeout: 20_000 }, () => withScratch(async (dir) => {
  const video = mp4Bytes('-generated');
  const bodies: Record<string, Record<string, unknown>> = {};
  let retrieves = 0;
  const stub = await startStub({
    'GET /api/v1/models?type=video': (_request, response) => sendJson(response, catalog),
    'POST /api/v1/video/quote': async (request, response) => {
      bodies.quote = await readJson(request);
      sendJson(response, { quote: 0.42 });
    },
    'POST /api/v1/video/queue': async (request, response) => {
      bodies.queue = await readJson(request);
      sendJson(response, { queue_id: 'q1', model: 'test-model' });
    },
    'POST /api/v1/video/retrieve': (_request, response) => {
      if (retrieves++ === 0) {
        sendJson(response, { status: 'PROCESSING' });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(video);
    },
  });
  const output = join(dir, 'clip.mp4');
  try {
    const result = await runCli(
      ['video', 'generate', 'a cat', '-m', 'test-model', '--wait', '-o', output, '-f', 'json'],
      dir,
      stub.origin,
      { VENICE_TEST_POLL_INTERVAL_MS: '50' }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output).equals(video), true);
    assert.deepEqual(bodies.quote, { model: 'test-model', duration: '6s', aspect_ratio: '9:16' });
    assert.deepEqual(bodies.queue, { model: 'test-model', prompt: 'a cat', duration: '6s', aspect_ratio: '9:16' });
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'completed',
      queue_id: 'q1',
      model: 'test-model',
      output,
      size_bytes: video.length,
      content_type: 'video/mp4',
      duration: '6s',
      aspect_ratio: '9:16',
      quote_usd: 0.42,
    });
  } finally {
    await stub.close();
  }
}));

test('video generate --wait without -o saves to output.mp4, then output-1.mp4, never replacing an earlier video', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const videos: Record<string, Buffer> = { q1: mp4Bytes('-first'), q2: mp4Bytes('-second') };
  let queued = 0;
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: `q${++queued}`, model: 'test-model' }),
    'POST /api/v1/video/retrieve': async (request, response) => {
      const { queue_id: queueId } = await readJson(request);
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(videos[queueId as string]);
    },
  });
  try {
    const args = ['video', 'generate', 'a cat', '-m', 'test-model', '--wait', '-f', 'json'];
    const first = await runCli(args, dir, stub.origin);
    const second = await runCli(args, dir, stub.origin);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(first.stdout).output, 'output.mp4');
    assert.equal(JSON.parse(second.stdout).output, 'output-1.mp4');
    assert.equal(readFileSync(join(dir, 'output.mp4')).equals(videos.q1), true);
    assert.equal(readFileSync(join(dir, 'output-1.mp4')).equals(videos.q2), true);
  } finally {
    await stub.close();
  }
}));

test('video generate --wait leaves no empty output.mp4 behind when the video cannot be saved', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: 'q1', model: 'test-model' }),
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, { status: 'COMPLETED' }),
  });
  try {
    const result = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '--wait'], dir, stub.origin);

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /returned no video\.\nThe video is still on Venice\. Download it with: venice video retrieve q1 -m test-model/);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.mp4')), []);
  } finally {
    await stub.close();
  }
}));

test('video generate rejects a ratio or duration the model does not list before quoting or queueing', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'GET /api/v1/models?type=video': (_request, response) => sendJson(response, catalog),
    'POST /api/v1/video/quote': (_request, response) => sendJson(response, { quote: 1 }),
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: 'q1', model: 'test-model' }),
  });
  try {
    const ratio = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '-a', '4:3', '--wait'], dir, stub.origin);
    assert.equal(ratio.status, 1, ratio.stdout);
    assert.match(ratio.stderr, /Invalid --aspect-ratio "4:3" for test-model\. Use one of: 9:16, 16:9/);

    const duration = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '-d', '5s'], dir, stub.origin);
    assert.equal(duration.status, 1, duration.stdout);
    assert.match(duration.stderr, /Invalid --duration "5s" for test-model\. Use one of: 6s, 10s/);

    assert.equal(stub.count('POST /api/v1/video/quote'), 0);
    assert.equal(stub.count('POST /api/v1/video/queue'), 0);
  } finally {
    await stub.close();
  }
}));

test('video generate --wait saves from the queue download_url when retrieve has no video, then deletes the remote copy', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const video = mp4Bytes('-queued-link');
  const output = join(dir, 'linked.mp4');
  let queueBody: Record<string, unknown> | undefined;
  const stub = await startStub({
    'POST /api/v1/video/queue': async (request, response, self) => {
      queueBody = await readJson(request);
      sendJson(response, { queue_id: 'q1', model: 'test-model', download_url: `${self.origin}/media/clip.mp4` });
    },
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, { status: 'COMPLETED' }),
    'GET /media/clip.mp4': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(video);
    },
    'POST /api/v1/video/complete': (_request, response) => {
      assert.equal(readFileSync(output).equals(video), true);
      sendJson(response, { success: true });
    },
  });
  try {
    const result = await runCli(
      ['video', 'generate', 'a cat', '-m', 'test-model', '--wait', '-o', output, '--complete', '-f', 'json'],
      dir,
      stub.origin
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(queueBody, { model: 'test-model', prompt: 'a cat' });
    assert.equal(stub.count('GET /media/clip.mp4'), 1);
    assert.equal(stub.count('POST /api/v1/video/complete'), 1);
    const printed = JSON.parse(result.stdout);
    assert.equal(printed.output, output);
    assert.equal(printed.quote_usd, null);
    assert.equal(printed.deleted, true);
  } finally {
    await stub.close();
  }
}));

test("video generate --wait exits 1 with Venice's error when the job fails, and keeps nothing", { timeout: 20_000 }, () => withScratch(async (dir) => {
  const output = join(dir, 'failed.mp4');
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: 'q1', model: 'test-model' }),
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, { status: 'FAILED', error: 'content policy' }),
    'POST /api/v1/video/complete': (_request, response) => sendJson(response, { success: true }),
  });
  const args = ['video', 'generate', 'a cat', '-m', 'test-model', '--wait', '-o', output, '--complete'];
  try {
    const json = await runCli([...args, '-f', 'json'], dir, stub.origin);
    assert.equal(json.status, 1, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { status: 'FAILED', error: 'content policy', queue_id: 'q1', model: 'test-model' });

    const pretty = await runCli([...args, '-f', 'pretty'], dir, stub.origin);
    assert.equal(pretty.status, 1);
    assert.match(pretty.stderr, /Error: content policy/);

    assert.equal(existsSync(output), false);
    assert.equal(stub.count('POST /api/v1/video/complete'), 0);
  } finally {
    await stub.close();
  }
}));

test('video generate --wait says how to keep waiting when the timeout expires', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: 'q1', model: 'test-model' }),
    'POST /api/v1/video/retrieve': (_request, response) => sendJson(response, { status: 'PROCESSING' }),
  });
  try {
    const result = await runCli(
      ['video', 'generate', 'a cat', '-m', 'test-model', '--wait', '--timeout', '0.3'],
      dir,
      stub.origin,
      { VENICE_TEST_POLL_INTERVAL_MS: '50' }
    );

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Timed out waiting for video generation[\s\S]*venice video status q1 -m test-model --wait/);
  } finally {
    await stub.close();
  }
}));

test('video generate refuses --output, --timeout and --complete without --wait, before queueing', { timeout: 20_000 }, () => withScratch(async (dir) => {
  const stub = await startStub({
    'POST /api/v1/video/queue': (_request, response) => sendJson(response, { queue_id: 'q1', model: 'test-model' }),
  });
  try {
    const one = await runCli(['video', 'generate', 'a cat', '-o', 'clip.mp4'], dir, stub.origin);
    assert.equal(one.status, 1, one.stdout);
    assert.match(one.stderr, /--output needs --wait\./);

    const several = await runCli(['video', 'generate', 'a cat', '--complete', '-t', '60'], dir, stub.origin);
    assert.equal(several.status, 1, several.stdout);
    assert.match(several.stderr, /--timeout, --complete need --wait\./);

    assert.equal(stub.count('POST /api/v1/video/queue'), 0);
  } finally {
    await stub.close();
  }
}));

test("video quote prices the model's first listed ratio and duration when none is given", { timeout: 20_000 }, () => withScratch(async (dir) => {
  let quoteBody: Record<string, unknown> | undefined;
  const stub = await startStub({
    'GET /api/v1/models?type=video': (_request, response) => sendJson(response, catalog),
    'POST /api/v1/video/quote': async (request, response) => {
      quoteBody = await readJson(request);
      sendJson(response, { quote: 0.42 });
    },
  });
  try {
    const result = await runCli(['video', 'quote', '-m', 'test-model', '-f', 'json'], dir, stub.origin);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(quoteBody, { model: 'test-model', duration: '6s', aspect_ratio: '9:16' });
    assert.equal(JSON.parse(result.stdout).quote, 0.42);
  } finally {
    await stub.close();
  }
}));
