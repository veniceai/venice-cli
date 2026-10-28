import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { VideoStatusResult } from '../lib/api.js';
import { childEnv } from '../lib/test-env.js';
import {
  FALLBACK_VIDEO_MODELS,
  classifyVideoStatus,
  isPublicHttpUrl,
  parseUpscaleFactor,
  requirePublicVideoUrl,
  videoModelKind,
  waitForVideoStatus,
} from './video.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

function mp4Bytes(tail = ''): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(header.length, 0);
  header.write('ftypisom', 4, 'latin1');
  header.write('isommp41', 16, 'latin1');
  return Buffer.concat([header, Buffer.from(tail)]);
}

test('video URL and upscale helpers validate supported inputs', () => {
  assert.equal(isPublicHttpUrl('https://example.com/clip.mp4'), true);
  assert.equal(isPublicHttpUrl('file:///tmp/clip.mp4'), false);
  assert.equal(requirePublicVideoUrl('http://example.com/clip.mp4'), 'http://example.com/clip.mp4');
  assert.throws(() => requirePublicVideoUrl('clip.mp4'), /public HTTP\(S\) URL/);
  assert.equal(parseUpscaleFactor(undefined), 2);
  assert.equal(parseUpscaleFactor(4), 4);
  assert.throws(() => parseUpscaleFactor('3'), /1, 2, or 4/);
});

test('video model fallback stays small and covers model families', () => {
  assert.equal(videoModelKind('veo3-fast-text-to-video'), 'text-to-video');
  assert.equal(videoModelKind('wan-2.6-image-to-video'), 'image-to-video');
  assert.equal(videoModelKind('topaz-video-upscale'), 'upscale');
  assert.equal(videoModelKind('custom-live-model'), 'video');
  assert.ok(FALLBACK_VIDEO_MODELS.length <= 8);
  assert.ok(FALLBACK_VIDEO_MODELS.some((model) => model.id === 'topaz-video-upscale'));
});

function runCli(
  args: string[],
  homeDir: string,
  apiBaseUrl: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: childEnv({
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: apiBaseUrl,
      }),
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

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

test('classifyVideoStatus handles status casing and common terminal aliases', () => {
  assert.equal(classifyVideoStatus('PROCESSING'), 'processing');
  assert.equal(classifyVideoStatus('processing'), 'processing');
  assert.equal(classifyVideoStatus('in-progress'), 'processing');
  assert.equal(classifyVideoStatus('SUCCEEDED'), 'completed');
  assert.equal(classifyVideoStatus('cancelled'), 'failed');
  assert.equal(classifyVideoStatus('unknown'), 'other');
});

test('waitForVideoStatus polls lowercase processing and returns the final response', async () => {
  const responses: VideoStatusResult[] = [
    { status: 'processing', execution_duration: 1000 },
    { status: 'completed', video_url: 'https://example.com/video.mp4' },
  ];
  let fetchCount = 0;

  const result = await waitForVideoStatus(
    async () => {
      const response = responses[fetchCount];
      fetchCount += 1;
      assert.ok(response, 'status was fetched after receiving a terminal response');
      return response;
    },
    1000,
    1
  );

  assert.equal(fetchCount, 2);
  assert.deepEqual(result, responses[1]);
});

test('waitForVideoStatus times out even when a status request does not settle', async () => {
  await assert.rejects(
    waitForVideoStatus(
      () => new Promise<VideoStatusResult>(() => undefined),
      10,
      1
    ),
    /Timed out waiting for video generation/
  );
});

test('video retrieve keeps JSON stdout valid while downloading a status URL', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-video-test-'));
  const videoBytes = mp4Bytes();
  let origin = '';
  let retrieveRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/video/retrieve') {
      retrieveRequests++;
      if (retrieveRequests === 3) {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end(videoBytes);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        status: 'COMPLETED',
        video_url: `${origin}/video.mp4`,
      }));
      return;
    }

    if (request.url === '/video.mp4') {
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(videoBytes.length),
      });
      response.end(videoBytes);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  try {
    const jsonOutput = join(homeDir, 'json-output.mp4');
    const jsonResult = await runCli([
      'video',
      'retrieve',
      'q1',
      '--model',
      'test-video-model',
      '--output',
      jsonOutput,
      '--format',
      'json',
    ], homeDir, `${origin}/api/v1`);

    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.deepEqual(JSON.parse(jsonResult.stdout), {
      status: 'completed',
      output: jsonOutput,
      model: 'test-video-model',
    });
    assert.equal(readFileSync(jsonOutput).equals(videoBytes), true);

    const prettyOutput = join(homeDir, 'pretty-output.mp4');
    const prettyResult = await runCli([
      'video',
      'retrieve',
      'q2',
      '--model',
      'test-video-model',
      '--output',
      prettyOutput,
      '--format',
      'pretty',
    ], homeDir, `${origin}/api/v1`);

    assert.equal(prettyResult.status, 0, prettyResult.stderr);
    assert.match(prettyResult.stdout, /Downloading video\.\.\./);
    assert.match(prettyResult.stdout, /Video saved to/);

    const statusResult = await runCli([
      'video',
      'status',
      'q3',
      '--model',
      'test-video-model',
      '--format',
      'pretty',
    ], homeDir, `${origin}/api/v1`);

    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.match(statusResult.stdout, /Status: completed/i);
    assert.match(
      statusResult.stdout,
      /venice video retrieve q3 -m test-video-model/
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('video retrieve completes only after direct or URL downloads are safely written', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-video-cleanup-'));
  const videoBytes = mp4Bytes('-cleanup');
  const directOutput = join(homeDir, 'direct.mp4');
  const urlOutput = join(homeDir, 'url.mp4');
  const declaredEmptyOutput = join(homeDir, 'declared-empty.mp4');
  const chunkedEmptyOutput = join(homeDir, 'chunked-empty.mp4');
  const existingBytes = Buffer.from('existing-video');
  const events: string[] = [];
  const completed: string[] = [];
  let origin = '';

  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/video/retrieve') {
      const body = await readJsonRequest(request);
      const queueId = String(body.queue_id);
      events.push(`retrieve:${queueId}`);
      assert.equal(body.delete_media_on_completion, false);

      if (queueId.startsWith('url')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          status: 'COMPLETED',
          video_url: `${origin}/${queueId}.mp4`,
        }));
      } else {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end(videoBytes);
      }
      return;
    }

    if (request.url?.startsWith('/url-')) {
      const queueId = request.url.slice(1, -4);
      events.push(`download:${queueId}`);
      if (queueId === 'url-fail') {
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.end('unavailable');
      } else if (queueId === 'url-empty-declared') {
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': '0',
        });
        response.end();
      } else if (queueId === 'url-empty-chunked') {
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Transfer-Encoding': 'chunked',
        });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end(videoBytes);
      }
      return;
    }

    if (request.url === '/api/v1/video/complete') {
      const body = await readJsonRequest(request);
      const queueId = String(body.queue_id);
      const expectedOutput = queueId === 'direct-ok' ? directOutput : urlOutput;
      assert.equal(existsSync(expectedOutput), true, 'cleanup ran before the output was written');
      assert.equal(readFileSync(expectedOutput).equals(videoBytes), true);
      events.push(`complete:${queueId}`);
      completed.push(queueId);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true }));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  try {
    const direct = await runCli([
      'video', 'retrieve', 'direct-ok',
      '--model', 'test-model',
      '--output', directOutput,
      '--complete',
      '--format', 'json',
    ], homeDir, `${origin}/api/v1`);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(JSON.parse(direct.stdout).deleted, true);

    const url = await runCli([
      'video', 'retrieve', 'url-ok',
      '--model', 'test-model',
      '--output', urlOutput,
      '--delete',
      '--format', 'json',
    ], homeDir, `${origin}/api/v1`);
    assert.equal(url.status, 0, url.stderr);
    assert.deepEqual(JSON.parse(url.stdout), {
      status: 'completed',
      output: urlOutput,
      model: 'test-model',
      deleted: true,
    });

    const directFailure = await runCli([
      'video', 'retrieve', 'direct-fail',
      '--model', 'test-model',
      '--output', homeDir,
      '--complete',
    ], homeDir, `${origin}/api/v1`);
    assert.notEqual(directFailure.status, 0);

    const urlFailure = await runCli([
      'video', 'retrieve', 'url-fail',
      '--model', 'test-model',
      '--output', join(homeDir, 'failed-url.mp4'),
      '--complete',
    ], homeDir, `${origin}/api/v1`);
    assert.notEqual(urlFailure.status, 0);

    writeFileSync(declaredEmptyOutput, existingBytes);
    const declaredEmpty = await runCli([
      'video', 'retrieve', 'url-empty-declared',
      '--model', 'test-model',
      '--output', declaredEmptyOutput,
      '--complete',
    ], homeDir, `${origin}/api/v1`);
    assert.notEqual(declaredEmpty.status, 0);
    assert.match(declaredEmpty.stderr, /Download response was empty/);
    assert.equal(readFileSync(declaredEmptyOutput).equals(existingBytes), true);

    writeFileSync(chunkedEmptyOutput, existingBytes);
    const chunkedEmpty = await runCli([
      'video', 'retrieve', 'url-empty-chunked',
      '--model', 'test-model',
      '--output', chunkedEmptyOutput,
      '--complete',
    ], homeDir, `${origin}/api/v1`);
    assert.notEqual(chunkedEmpty.status, 0);
    assert.match(chunkedEmpty.stderr, /Download response was empty/);
    assert.equal(readFileSync(chunkedEmptyOutput).equals(existingBytes), true);

    assert.deepEqual(completed, ['direct-ok', 'url-ok']);
    assert.ok(events.indexOf('complete:direct-ok') > events.indexOf('retrieve:direct-ok'));
    assert.ok(events.indexOf('complete:url-ok') > events.indexOf('download:url-ok'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('video upscale completes only after the retrieved video is written', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-video-upscale-cleanup-'));
  const outputPath = join(homeDir, 'upscaled.mp4');
  const videoBytes = mp4Bytes('-upscaled');
  const events: string[] = [];
  let retrieveCount = 0;

  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/video/queue') {
      events.push('queue');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ queue_id: 'upscale-q', model: 'topaz-video-upscale' }));
      return;
    }

    if (request.url === '/api/v1/video/retrieve') {
      const body = await readJsonRequest(request);
      assert.equal(body.delete_media_on_completion, false);
      retrieveCount++;
      events.push(`retrieve:${retrieveCount}`);
      if (retrieveCount === 1) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'COMPLETED' }));
      } else {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end(videoBytes);
      }
      return;
    }

    if (request.url === '/api/v1/video/complete') {
      assert.equal(readFileSync(outputPath).equals(videoBytes), true);
      events.push('complete');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true }));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runCli([
      'video', 'upscale', 'https://example.com/input.mp4',
      '--output', outputPath,
      '--complete',
      '--format', 'json',
    ], homeDir, `${origin}/api/v1`);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).deleted, true);
    assert.deepEqual(events, ['queue', 'retrieve:1', 'retrieve:2', 'complete']);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('video models preserves an empty successful live catalog', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-video-models-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const json = await runCli(
      ['video', 'models', '--format', 'json'],
      homeDir,
      `${origin}/api/v1`
    );
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { models: [], source: 'api' });

    const pretty = await runCli(
      ['video', 'models', '--format', 'pretty'],
      homeDir,
      `${origin}/api/v1`
    );
    assert.equal(pretty.status, 0, pretty.stderr);
    assert.match(pretty.stdout, /No video models were returned by the live API\./);
    assert.doesNotMatch(pretty.stdout, /unavailable|fallback/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
