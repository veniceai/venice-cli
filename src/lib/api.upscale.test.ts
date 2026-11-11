import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isImageContentType,
  looksLikeImageBytes,
  upscaleImage,
} from './api.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('isImageContentType and looksLikeImageBytes reject non-images', () => {
  assert.equal(isImageContentType('image/png'), true);
  assert.equal(isImageContentType('application/json'), false);
  assert.equal(looksLikeImageBytes(PNG_MAGIC), true);
  assert.equal(looksLikeImageBytes(Buffer.from('{"error":"nope"}')), false);
});

test('upscaleImage posts to /image/upscale and requires image bytes', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-upscale-test-'));
  const imagePath = join(tempDir, 'photo.png');
  writeFileSync(imagePath, PNG_MAGIC);

  const requests: Array<{ url: string; body: unknown }> = [];
  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(PNG_MAGIC, {
      headers: { 'Content-Type': 'image/png' },
    });
  }) as typeof fetch;

  try {
    const result = await upscaleImage(imagePath, { scale: 2 });
    assert.match(requests[0].url, /\/image\/upscale$/);
    assert.equal((requests[0].body as { scale: number }).scale, 2);
    assert.equal(typeof (requests[0].body as { image: string }).image, 'string');
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.bytes.equals(PNG_MAGIC), true);
    assert.equal('creativity' in (requests[0].body as Record<string, unknown>), false);

    await upscaleImage(imagePath, { scale: 4, creativity: 0 });
    assert.equal((requests[1].body as { creativity: number }).creativity, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('upscaleImage does not report success for JSON error bodies', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-upscale-test-'));
  const imagePath = join(tempDir, 'photo.png');
  writeFileSync(imagePath, PNG_MAGIC);

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'nope' }), {
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => upscaleImage(imagePath, { scale: 2 }),
      /did not return an image/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('upscaleImage rejects chunked responses that exceed the download limit', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-upscale-test-'));
  const imagePath = join(tempDir, 'photo.png');
  writeFileSync(imagePath, PNG_MAGIC);

  process.env.VENICE_API_KEY = 'test-key';
  const chunk = new Uint8Array(1024 * 1024);
  let bodyCancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      bodyCancelled = true;
    },
  }), {
    headers: { 'Content-Type': 'image/png' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => upscaleImage(imagePath),
      /Upscaled image response exceeded the limit of 50\.0 MB/
    );
    assert.equal(bodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('upscaleImage keeps its timeout active while reading the response body', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-upscale-test-'));
  const imagePath = join(tempDir, 'photo.png');
  writeFileSync(imagePath, PNG_MAGIC);

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, delay === 120000 ? 10 : delay, ...args)) as typeof setTimeout;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'image/png' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => upscaleImage(imagePath),
      /Image upscale request timed out/
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
