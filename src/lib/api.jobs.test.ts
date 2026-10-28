import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { retrieveVideo } from './api.js';

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
