import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyVideoRetrieveContentType,
  getVideoStatus,
  queueVideoGeneration,
  retrieveVideo,
} from './api.js';
import { readWithInactivityTimeout, streamResponseToFile } from './media.js';

function mp4Bytes(tail = ''): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(header.length, 0);
  header.write('ftypisom', 4, 'latin1');
  header.write('isommp41', 16, 'latin1');
  return Buffer.concat([header, Buffer.from(tail)]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('classifyVideoRetrieveContentType branches on JSON vs video', () => {
  assert.equal(classifyVideoRetrieveContentType('application/json'), 'json');
  assert.equal(classifyVideoRetrieveContentType('application/json; charset=utf-8'), 'json');
  assert.equal(classifyVideoRetrieveContentType('video/mp4'), 'video');
  assert.equal(classifyVideoRetrieveContentType('application/octet-stream'), 'video');
  assert.equal(classifyVideoRetrieveContentType('text/plain'), 'unknown');
});

test('stream inactivity deadline resets as chunks continue arriving', async () => {
  const chunkIntervalMs = 30;
  const inactivityTimeoutMs = 70;
  const chunks = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk, index) => {
        setTimeout(() => controller.enqueue(chunk), chunkIntervalMs * (index + 1));
      });
      setTimeout(() => controller.close(), chunkIntervalMs * (chunks.length + 1));
    },
  });
  const reader = stream.getReader();
  const received: Buffer[] = [];
  const startedAt = Date.now();

  try {
    while (true) {
      const { done, value } = await readWithInactivityTimeout(
        reader,
        inactivityTimeoutMs
      );
      if (done) break;
      received.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  assert.equal(Buffer.concat(received).toString(), 'onetwothree');
  assert.ok(Date.now() - startedAt > inactivityTimeoutMs);
});

test('stream inactivity timeout cancels a stalled body and cleans its temporary file', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
  const outputPath = join(outputDir, 'video.mp4');
  writeFileSync(outputPath, 'existing');
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('xxxxftyp'));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    headers: { 'Content-Type': 'video/mp4' },
  });
  const reader = response.body!.getReader();
  const firstRead = await reader.read();
  assert.equal(firstRead.done, false);

  try {
    await assert.rejects(
      streamResponseToFile(
        response,
        reader,
        [Buffer.from(firstRead.value!)],
        outputPath,
        {
          maxBytes: 1024,
          label: 'Video',
          inactivityTimeoutMs: 30,
        }
      ),
      /stalled/
    );
    assert.equal(cancelled, true);
    assert.equal(readFileSync(outputPath, 'utf8'), 'existing');
    assert.deepEqual(readdirSync(outputDir), ['video.mp4']);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('queueVideoGeneration omits aspect_ratio unless the user set it', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const bodies: unknown[] = [];

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({ queue_id: 'q1', model: 'wan-2.6-image-to-video' });
  }) as typeof fetch;

  try {
    await queueVideoGeneration('a man stands up', {
      model: 'wan-2.6-image-to-video',
      duration: '5s',
      imageUrl: 'data:image/jpeg;base64,abc',
    });
    await queueVideoGeneration('sunset', {
      model: 'wan-2.6-text-to-video',
      aspectRatio: '16:9',
    });

    assert.deepEqual(bodies[0], {
      model: 'wan-2.6-image-to-video',
      prompt: 'a man stands up',
      duration: '5s',
      image_url: 'data:image/jpeg;base64,abc',
    });
    assert.equal('aspect_ratio' in (bodies[0] as object), false);
    assert.deepEqual(bodies[1], {
      model: 'wan-2.6-text-to-video',
      prompt: 'sunset',
      duration: '5s',
      aspect_ratio: '16:9',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('video status cancels a completed MP4 body without buffering it', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const mp4 = mp4Bytes();
  let fetchCount = 0;
  let statusBodyCancelled = false;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => {
    fetchCount++;
    if (fetchCount === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(mp4);
        },
        cancel() {
          statusBodyCancelled = true;
        },
      }), {
        headers: { 'Content-Type': 'video/mp4' },
      });
    }

    return new Response(mp4, {
      headers: { 'Content-Type': 'video/mp4' },
    });
  }) as typeof fetch;

  try {
    const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
    const outputPath = join(outputDir, 'video.mp4');
    const status = await getVideoStatus('q1', 'kling-v3-pro-image-to-video');
    assert.equal(status.status, 'completed');
    assert.equal(statusBodyCancelled, true);

    const retrieved = await retrieveVideo('q1', 'kling-v3-pro-image-to-video', { outputPath });
    assert.equal(retrieved.kind, 'video');
    if (retrieved.kind === 'video') {
      assert.equal(retrieved.bytesWritten, mp4.length);
      assert.equal(readFileSync(outputPath).equals(mp4), true);
    }
    rmSync(outputDir, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('video status and retrieve recognize MP4 when its box size ends in JSON magic', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
  const outputPath = join(outputDir, 'video.mp4');
  const mp4 = Buffer.alloc(0x7b);
  mp4.writeUInt32BE(mp4.length, 0);
  mp4.write('ftyp', 4, 'ascii');
  mp4.write('isom', 8, 'ascii');
  mp4.writeUInt32BE(0, 12);
  mp4.write('isom', 16, 'ascii');

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(mp4, {
    headers: { 'Content-Type': 'application/octet-stream' },
  })) as typeof fetch;

  try {
    const status = await getVideoStatus('q1', 'test-model');
    assert.equal(status.status, 'completed');

    const retrieved = await retrieveVideo('q1', 'test-model', { outputPath });
    assert.equal(retrieved.kind, 'video');
    assert.equal(readFileSync(outputPath).equals(mp4), true);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video status parses JSON mislabeled as video or octet-stream', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const contentTypes = ['video/mp4', 'application/octet-stream'];
  let responseIndex = 0;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('  {"status":"FAILED","error":"generation failed"}'));
      controller.close();
    },
  }), {
    headers: { 'Content-Type': contentTypes[responseIndex++] },
  })) as typeof fetch;

  try {
    for (const queueId of ['q1', 'q2']) {
      const status = await getVideoStatus(queueId, 'test-model');
      assert.equal(status.status, 'FAILED');
      assert.equal(status.error, 'generation failed');
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video status waits through an all-whitespace chunk before JSON', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('        '));
      controller.enqueue(Buffer.from('{"status":"PROCESSING"}'));
      controller.close();
    },
  }), {
    headers: { 'Content-Type': 'application/octet-stream' },
  })) as typeof fetch;

  try {
    const status = await getVideoStatus('q1', 'test-model');
    assert.equal(status.status, 'PROCESSING');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video retrieve retries transient HTTP failures before streaming to disk', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
  const outputPath = join(outputDir, 'video.mp4');
  const mp4 = mp4Bytes('-streamed');
  let attempts = 0;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) {
      return new Response('temporarily unavailable', { status: 503 });
    }
    return new Response(mp4, { headers: { 'Content-Type': 'application/octet-stream' } });
  }) as typeof fetch;

  try {
    const result = await retrieveVideo('q1', 'test-model', { outputPath });
    assert.equal(result.kind, 'video');
    assert.equal(attempts, 2);
    assert.equal(readFileSync(outputPath).equals(mp4), true);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video retrieve retries a successful response body read failure before writing', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
  const outputPath = join(outputDir, 'video.mp4');
  const mp4 = mp4Bytes('-after-retry');
  let attempts = 0;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('{"status":'));
          controller.error(new Error('transient body reset'));
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
  }) as typeof fetch;

  try {
    const result = await retrieveVideo('q1', 'test-model', { outputPath });
    assert.equal(result.kind, 'video');
    assert.equal(attempts, 2);
    assert.equal(readFileSync(outputPath).equals(mp4), true);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video retrieve enforces streaming size limits and cleans temporary files', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
  const outputPath = join(outputDir, 'video.mp4');
  writeFileSync(outputPath, 'existing');
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(mp4Bytes());
      controller.enqueue(Buffer.alloc(32, 1));
      controller.close();
    },
  }), {
    headers: { 'Content-Type': 'video/mp4' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      retrieveVideo('q1', 'test-model', { outputPath, maxBytes: 16 }),
      /exceeded limit/
    );
    assert.equal(readFileSync(outputPath, 'utf8'), 'existing');
    assert.deepEqual(readdirSync(outputDir), ['video.mp4']);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video retrieve rejects invalid bodies even when classified as video', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const outputDir = mkdtempSync(join(tmpdir(), 'venice-api-video-'));
  const outputPath = join(outputDir, 'video.mp4');
  let attempts = 0;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => {
    attempts++;
    return new Response('not an mp4 payload', {
      headers: { 'Content-Type': 'video/mp4' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      retrieveVideo('q1', 'test-model', { outputPath }),
      /neither JSON nor a valid MP4/
    );
    assert.equal(attempts, 1);
    assert.equal(readdirSync(outputDir).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(outputDir, { recursive: true, force: true });
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

test('video status still parses JSON while a job is processing', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => jsonResponse({
    status: 'PROCESSING',
    average_execution_time: 10000,
    execution_duration: 1000,
  })) as typeof fetch;

  try {
    const status = await getVideoStatus('q1', 'kling-v3-pro-image-to-video');
    assert.equal(status.status, 'PROCESSING');
    assert.equal(status.execution_duration, 1000);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});
