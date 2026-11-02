import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeResponseToFile } from './media.js';

test('writeResponseToFile preserves destinations and removes temp files for empty bodies', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-media-empty-'));
  const outputPath = join(tempDir, 'video.mp4');
  const existingBytes = Buffer.from('existing-video');
  const cases = [
    {
      name: 'declared',
      response: () => new Response(null, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '0',
        },
      }),
    },
    {
      name: 'chunked',
      response: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }), {
        headers: { 'Content-Type': 'video/mp4' },
      }),
    },
  ];

  try {
    for (const testCase of cases) {
      writeFileSync(outputPath, existingBytes);

      await assert.rejects(
        writeResponseToFile(testCase.response(), outputPath, {
          maxBytes: 1024,
          expectedContentTypePrefixes: ['video/'],
        }),
        /Download response was empty/,
        testCase.name
      );

      assert.equal(readFileSync(outputPath).equals(existingBytes), true, testCase.name);
      assert.deepEqual(readdirSync(tempDir), ['video.mp4'], testCase.name);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  'writeResponseToFile streams into a pipe in place',
  { skip: process.platform === 'win32' },
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'venice-media-pipe-'));
    const fifo = join(tempDir, 'song.mp3');

    try {
      execFileSync('mkfifo', [fifo]);
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const result = await writeResponseToFile(
          new Response('ID3-audio', { headers: { 'Content-Type': 'audio/mpeg' } }),
          fifo,
          { maxBytes: 1024, expectedContentTypePrefixes: ['audio/'] }
        );

        assert.equal(result.bytesWritten, 9);
        assert.equal(readFileSync(reader, 'utf8'), 'ID3-audio');
      } finally {
        closeSync(reader);
      }

      assert.equal(lstatSync(fifo).isFIFO(), true);
      assert.deepEqual(readdirSync(tempDir), ['song.mp3']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
);
