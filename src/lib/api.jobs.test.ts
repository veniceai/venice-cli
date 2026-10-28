import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  completeAudioGeneration,
  completeVideo,
  getVideoStatus,
  queueAudioGeneration,
  queueVideoGeneration,
  quoteAudioGeneration,
  quoteVideoGeneration,
  retrieveGeneratedAudio,
  retrieveVideo,
} from './api.js';

function mp4Bytes(tail = ''): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(header.length, 0);
  header.write('ftypisom', 4, 'latin1');
  header.write('isommp41', 16, 'latin1');
  return Buffer.concat([header, Buffer.from(tail)]);
}

function chunkedResponse(chunks: Buffer[], contentType: string): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  }, { highWaterMark: 0 }), {
    headers: { 'Content-Type': contentType },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
}

test('retrieveVideo reports a JSON status whose bytes 4-7 spell ftyp instead of saving it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-api-jobs-'));
  const outputPath = join(dir, 'video.mp4');
  try {
    const result = await withFetch(
      () => chunkedResponse(
        [Buffer.from('{  "ftyp":1,"status":"FAILED","error":"quota"}')],
        'application/json'
      ),
      () => retrieveVideo('q1', 'test-model', { outputPath })
    );

    assert.equal(result.kind, 'status');
    assert.equal(result.kind === 'status' && result.status.status, 'FAILED');
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieveVideo saves an MP4 whose ftyp box follows a free box and arrives in pieces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-api-jobs-'));
  const outputPath = join(dir, 'video.mp4');
  const free = Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  const video = Buffer.concat([free, mp4Bytes('-frames')]);
  try {
    const result = await withFetch(
      () => chunkedResponse(
        [video.subarray(0, 3), video.subarray(3, 14), video.subarray(14)],
        'video/mp4'
      ),
      () => retrieveVideo('q1', 'test-model', { outputPath })
    );

    assert.equal(result.kind, 'video');
    assert.equal(readFileSync(outputPath).equals(video), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue responses need a queue_id and fall back to the requested model', async () => {
  const queues = [
    { endpoint: '/video/queue', queue: () => queueVideoGeneration('a cat', { model: 'test-video-model' }) },
    { endpoint: '/audio/queue', queue: () => queueAudioGeneration('a song', { model: 'test-audio-model' }) },
  ];

  for (const { endpoint, queue } of queues) {
    for (const body of [{}, [], 'null', { queue_id: '' }, { queue_id: 7 }, { queue_id: 'q1', model: 7 }]) {
      await assert.rejects(
        withFetch(() => jsonResponse(body), queue),
        (error: Error) => error.message.startsWith(`Unexpected response from Venice (${endpoint})`),
        `${endpoint} ${JSON.stringify(body)}`
      );
    }
  }

  assert.deepEqual(
    await withFetch(() => jsonResponse({ queue_id: 'q1' }), queues[0].queue),
    { queue_id: 'q1', model: 'test-video-model' }
  );
  assert.deepEqual(
    await withFetch(() => jsonResponse({ queue_id: 'q2', model: 'm2', status: 'QUEUED' }), queues[1].queue),
    { queue_id: 'q2', model: 'm2', status: 'QUEUED' }
  );
});

test('quote responses need a non-negative number', async () => {
  const quotes = [
    { endpoint: '/video/quote', quote: () => quoteVideoGeneration({ model: 'm', duration: '5s' }) },
    { endpoint: '/audio/quote', quote: () => quoteAudioGeneration('m') },
  ];

  for (const { endpoint, quote } of quotes) {
    for (const body of [{}, { quote: '0.5' }, { quote: -1 }, { quote: null }]) {
      await assert.rejects(
        withFetch(() => jsonResponse(body), quote),
        (error: Error) => error.message.startsWith(`Unexpected response from Venice (${endpoint})`),
        `${endpoint} ${JSON.stringify(body)}`
      );
    }
    assert.deepEqual(await withFetch(() => jsonResponse({ quote: 0.25 }), quote), { quote: 0.25 });
  }
});

test('complete responses need a boolean success flag', async () => {
  const completes = [
    { endpoint: '/video/complete', complete: () => completeVideo('q1', 'm') },
    { endpoint: '/audio/complete', complete: () => completeAudioGeneration('q1', 'm') },
  ];

  for (const { endpoint, complete } of completes) {
    for (const body of [{}, { success: 'true' }, { success: 1 }]) {
      await assert.rejects(
        withFetch(() => jsonResponse(body), complete),
        (error: Error) => error.message.startsWith(`Unexpected response from Venice (${endpoint})`),
        `${endpoint} ${JSON.stringify(body)}`
      );
    }
    assert.deepEqual(await withFetch(() => jsonResponse({ success: false }), complete), { success: false });
  }
});

test('video status responses need a status string and typed fields, and are not retried', async () => {
  const bodies = [
    {},
    { status: 5 },
    { status: '  ' },
    { status: 'COMPLETED', video_url: 5 },
    { status: 'FAILED', error: { message: 'nested' } },
    { status: 'PROCESSING', execution_duration: '10s' },
    '{"status": "PROCESSING"',
  ];

  for (const body of bodies) {
    let requests = 0;
    await assert.rejects(
      withFetch(() => {
        requests++;
        return jsonResponse(body);
      }, () => getVideoStatus('q1', 'm')),
      /^Error: Unexpected response from Venice \(\/video\/retrieve\)/,
      JSON.stringify(body)
    );
    assert.equal(requests, 1, JSON.stringify(body));
  }

  const status = await withFetch(
    () => jsonResponse({ status: 'PROCESSING', video_url: null, error: null }),
    () => getVideoStatus('q1', 'm')
  );
  assert.equal(status.status, 'PROCESSING');
});

test('music status responses need a status string and typed fields', async () => {
  for (const body of [{}, { status: 5 }, { status: 'PROCESSING', average_execution_time: 'soon' }, 'nope']) {
    await assert.rejects(
      withFetch(() => jsonResponse(body), () => retrieveGeneratedAudio('q1', 'm')),
      /^Error: Unexpected response from Venice \(\/audio\/retrieve\)/,
      JSON.stringify(body)
    );
  }

  const result = await withFetch(
    () => jsonResponse({ status: 'QUEUED', average_execution_time: 1000 }),
    () => retrieveGeneratedAudio('q1', 'm')
  );
  assert.equal(result.kind === 'processing' && result.status.status, 'QUEUED');
});
