import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { decodeGeneratedImage, registerImageCommand } from './image.js';
import { generateImage, upscaleImage } from '../lib/api.js';
import { MAX_IMAGE_DOWNLOAD_BYTES } from '../lib/media.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);

async function withFetch(respond: () => Response, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => respond()) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
}

test('generated images must be base64 strings', async () => {
  for (const images of [[{ length: 1500 }], [], [PNG.toString('base64'), 7], 'not-an-array', undefined]) {
    await withFetch(() => Response.json({ id: 'img', images }), async () => {
      await assert.rejects(
        generateImage('a painting'),
        /Image generation response did not contain any base64 image strings/,
        JSON.stringify(images)
      );
    });
  }
});

test('generated images are size-checked before decoding and must be images', () => {
  assert.equal(decodeGeneratedImage(PNG.toString('base64')).equals(PNG), true);
  assert.equal(decodeGeneratedImage(JPEG.toString('base64')).equals(JPEG), true);
  assert.equal(decodeGeneratedImage(WEBP.toString('base64')).equals(WEBP), true);

  assert.throws(() => decodeGeneratedImage(''), /Generated image response was empty/);
  assert.throws(
    () => decodeGeneratedImage(Buffer.from('{"error":"quota"}').toString('base64')),
    /Generated image did not contain a supported PNG, JPEG, or WebP image/
  );
  // Decoding these would give zero bytes that fail the image check; the size
  // check must reject them first.
  const oversized = 'A'.repeat(Math.ceil(((MAX_IMAGE_DOWNLOAD_BYTES + 1) * 4) / 3) + 4);
  assert.throws(() => decodeGeneratedImage(oversized), /Generated image is too large \(50\.0 MB\)/);
});

test('image generation does not save a response that is not an image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-generate-bytes-'));
  const output = join(dir, 'out.png');
  const originalError = console.error;
  const originalExit = process.exit;
  const errors: string[] = [];
  console.error = (...values: unknown[]) => errors.push(values.join(' '));
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit;
  try {
    await withFetch(
      () => Response.json({ id: 'img', images: [Buffer.alloc(1500).toString('base64')] }),
      async () => {
        const program = new Command();
        registerImageCommand(program);
        await assert.rejects(program.parseAsync(['node', 'venice', 'image', '-o', output, 'a painting']), /exit 1/);
      }
    );
    assert.match(errors.join('\n'), /did not contain a supported PNG, JPEG, or WebP image/);
    assert.equal(existsSync(output), false);
  } finally {
    console.error = originalError;
    process.exit = originalExit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upscale requires both an image Content-Type and image bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-upscale-bytes-'));
  const input = join(dir, 'in.png');
  writeFileSync(input, PNG);
  try {
    await withFetch(
      () => new Response('{"error":"quota exceeded"}', { headers: { 'Content-Type': 'image/png' } }),
      async () => {
        await assert.rejects(upscaleImage(input), /Upscale did not return an image/);
      }
    );
    await withFetch(
      () => new Response(PNG, { headers: { 'Content-Type': 'application/octet-stream' } }),
      async () => {
        await assert.rejects(upscaleImage(input), /Upscale did not return an image/);
      }
    );
    await withFetch(
      () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
      async () => {
        assert.equal((await upscaleImage(input)).bytes.equals(PNG), true);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
