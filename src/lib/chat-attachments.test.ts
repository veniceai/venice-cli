import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertAttachmentCapabilities,
  assertAttachmentsAllowedForPrivacy,
  assertLocalAttachmentFiles,
  buildUserMessageContent,
  hasChatAttachments,
  MAX_CHAT_ATTACHMENT_BYTES,
  parseChatAttachments,
} from './chat-attachments.js';
import { MAX_CHAT_IMAGE_BYTES } from './media.js';
import { messageContentToText } from '../types/index.js';
import type { Model } from '../types/index.js';

async function withAttachmentServer(
  handler: (path: string, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    handler(request.url || '/', response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

const MP4_HEADER = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(12),
]);

const visionModel: Model = {
  id: 'qwen3-vl-235b-a22b',
  type: 'text',
  model_spec: {
    capabilities: {
      supportsVision: true,
      supportsMultipleImages: true,
      maxImages: 4,
      supportsAudioInput: true,
      supportsVideoInput: true,
      maxVideos: 3,
    },
  },
};

test('parseChatAttachments and hasChatAttachments handle missing and present flags', () => {
  assert.equal(hasChatAttachments(parseChatAttachments({})), false);
  assert.equal(
    hasChatAttachments(parseChatAttachments({ image: ['photo.jpg'] })),
    true
  );
});

test('assertLocalAttachmentFiles rejects missing local files before any API call', () => {
  assert.throws(
    () => assertLocalAttachmentFiles({
      images: [join(tmpdir(), 'venice-missing-image.jpg')],
      files: [],
      audio: [],
      videos: [],
    }),
    /Image not found/
  );
});

test('attachment preflight rejects per-file and aggregate limits before encoding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-attach-limits-'));
  try {
    const oversizedImage = join(dir, 'oversized.png');
    writeFileSync(oversizedImage, '');
    truncateSync(oversizedImage, MAX_CHAT_IMAGE_BYTES + 1);
    assert.throws(
      () => assertLocalAttachmentFiles({
        images: [oversizedImage],
        files: [],
        audio: [],
        videos: [],
      }),
      /too large/i
    );

    const videoPaths = [0, 1, 2].map((index) => join(dir, `${index}.mp4`));
    for (const videoPath of videoPaths) {
      writeFileSync(videoPath, '');
      truncateSync(videoPath, Math.floor(MAX_CHAT_ATTACHMENT_BYTES / 3) + 1);
    }
    assert.throws(
      () => assertLocalAttachmentFiles({
        images: [],
        files: [],
        audio: [],
        videos: videoPaths,
      }),
      /aggregate|combined size/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attachment preflight rejects unsupported and mismatched MIME types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-attach-mime-'));
  try {
    const executable = join(dir, 'payload.exe');
    writeFileSync(executable, 'not an attachment');
    assert.throws(
      () => assertLocalAttachmentFiles({
        images: [],
        files: [executable],
        audio: [],
        videos: [],
      }),
      /unsupported.*MIME type/i
    );

    assert.throws(
      () => assertLocalAttachmentFiles({
        images: ['data:text/plain;base64,aGVsbG8='],
        files: [],
        audio: [],
        videos: [],
      }),
      /unsupported image MIME type/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertAttachmentCapabilities requires advertised vision/audio/video support', () => {
  assert.throws(
    () => assertAttachmentCapabilities(
      { id: 'kimi-k2-5' },
      { images: ['photo.jpg'], files: [], audio: [], videos: [] }
    ),
    /supportsVision/
  );

  assert.doesNotThrow(() => assertAttachmentCapabilities(
    visionModel,
    { images: ['a.jpg', 'b.jpg'], files: [], audio: [], videos: [] }
  ));

  assert.throws(
    () => assertAttachmentCapabilities(
      { id: 'single-image', model_spec: { capabilities: { supportsVision: true } } },
      { images: ['a.jpg', 'b.jpg'], files: [], audio: [], videos: [] }
    ),
    /supportsMultipleImages/
  );
});

test('assertAttachmentsAllowedForPrivacy rejects E2EE and TEE', () => {
  assert.throws(() => assertAttachmentsAllowedForPrivacy(true, false), /E2EE or TEE/);
  assert.throws(() => assertAttachmentsAllowedForPrivacy(false, true), /E2EE or TEE/);
  assert.doesNotThrow(() => assertAttachmentsAllowedForPrivacy(false, false));
});

test('buildUserMessageContent keeps text-only prompts as strings', async () => {
  const content = await buildUserMessageContent('hello', {
    images: [],
    files: [],
    audio: [],
    videos: [],
  });
  assert.equal(content, 'hello');
});

test('buildUserMessageContent encodes local images as data URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-attach-'));
  const imagePath = join(dir, 'dot.png');
  writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));

  try {
    const content = await buildUserMessageContent('what is in this picture?', {
      images: [imagePath],
      files: [],
      audio: [],
      videos: [],
    });
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image_url');
    if (content[1].type === 'image_url') {
      assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildUserMessageContent downloads remote inputs and never passes server-fetch URLs', async () => {
  await withAttachmentServer((path, response) => {
    if (path === '/report%20name.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('%PDF');
      return;
    }
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end(MP4_HEADER);
  }, async (baseUrl) => {
    const content = await buildUserMessageContent('describe this clip', {
      images: [],
      files: [`${baseUrl}/report%20name.pdf`],
      audio: [],
      videos: [`${baseUrl}/clip.mp4`],
    });
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[1], {
      type: 'file',
      file: {
        file_data: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`,
        filename: 'report name.pdf',
      },
    });
    assert.deepEqual(content[2], {
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${MP4_HEADER.toString('base64')}` },
    });
    assert.doesNotMatch(JSON.stringify(content), /https?:\/\//);
  });
});

test('remote attachments reject disallowed MIME, empty, oversized, and timed-out responses', async () => {
  await withAttachmentServer((path, response) => {
    if (path === '/wrong.png') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not an image');
    } else if (path === '/empty.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end();
    } else if (path === '/large.png') {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(MAX_CHAT_IMAGE_BYTES + 1),
      });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'image/png' });
    }
  }, async (baseUrl) => {
    const empty = { images: [], files: [], audio: [], videos: [] };
    await assert.rejects(
      buildUserMessageContent('', { ...empty, images: [`${baseUrl}/wrong.png`] }),
      /unsupported image MIME type/i
    );
    await assert.rejects(
      buildUserMessageContent('', { ...empty, files: [`${baseUrl}/empty.pdf`] }),
      /empty/i
    );
    await assert.rejects(
      buildUserMessageContent('', { ...empty, images: [`${baseUrl}/large.png`] }),
      /maximum allowed size|limit/i
    );
    await assert.rejects(
      buildUserMessageContent(
        '',
        { ...empty, images: [`${baseUrl}/stall.png`] },
        { downloadTimeoutMs: 20 }
      ),
      /timed out/i
    );
  });
});

test('mixed remote and local attachments enforce the actual aggregate byte budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-attach-aggregate-'));
  const localVideo = join(dir, 'local.mp4');
  writeFileSync(localVideo, MP4_HEADER);
  truncateSync(localVideo, 50 * 1024 * 1024);
  try {
    await withAttachmentServer((_path, response) => {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(50 * 1024 * 1024 + 1),
      });
      response.end();
    }, async (baseUrl) => {
      await assert.rejects(
        buildUserMessageContent('', {
          images: [],
          files: [],
          audio: [],
          videos: [localVideo, `${baseUrl}/remote.mp4`],
        }),
        /maximum allowed size|limit|combined size/i
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('actual local growth after remote preflight is charged to aggregate budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-attach-growth-'));
  const first = join(dir, 'first.mp4');
  const growing = join(dir, 'growing.mp4');
  writeFileSync(first, MP4_HEADER);
  writeFileSync(growing, MP4_HEADER);
  truncateSync(first, 50 * 1024 * 1024);
  truncateSync(growing, 25 * 1024 * 1024);
  try {
    await withAttachmentServer((_path, response) => {
      truncateSync(growing, 50 * 1024 * 1024);
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('%PDF');
    }, async (baseUrl) => {
      await assert.rejects(
        buildUserMessageContent('', {
          images: [],
          files: [`${baseUrl}/trigger.pdf`],
          audio: [],
          videos: [first, growing],
        }),
        /aggregate|combined size|maximum allowed size/i
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('messageContentToText summarizes multimodal parts', () => {
  assert.equal(
    messageContentToText([
      { type: 'text', text: 'summarize' },
      { type: 'file', file: { file_data: 'https://example.com/a.pdf', filename: 'a.pdf' } },
    ]),
    'summarize [file: a.pdf]'
  );
});
