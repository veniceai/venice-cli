import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ContentPart } from '../types/index.js';
import { buildUserMessageContent, type ChatAttachments } from './chat-attachments.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.from('GIF89a-not-a-png');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
const PADDED_MP3 = Buffer.concat([Buffer.alloc(16), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
const PDF = Buffer.from('%PDF-1.7\n');
const NONE: ChatAttachments = { images: [], files: [], audio: [], videos: [] };

const dataUrl = (mimeType: string, bytes: Buffer) => `data:${mimeType};base64,${bytes.toString('base64')}`;
const mimeTypeOf = (url: string) => url.slice('data:'.length, url.indexOf(';'));

function sentType(part: ContentPart): string {
  switch (part.type) {
    case 'image_url':
      return mimeTypeOf(part.image_url.url);
    case 'video_url':
      return mimeTypeOf(part.video_url.url);
    case 'file':
      return mimeTypeOf(part.file.file_data);
    case 'input_audio':
      return part.input_audio.format;
    default:
      return part.type;
  }
}

test('data URL attachments are sent as the type their content shows', async () => {
  await assert.rejects(
    buildUserMessageContent('what is this', { ...NONE, images: [dataUrl('image/png', Buffer.from('not an image'))] }),
    /Image data URL does not contain image\/png data/
  );
  await assert.rejects(
    buildUserMessageContent('what is this', { ...NONE, audio: [dataUrl('audio/wav', PNG)] }),
    /Audio data URL does not contain audio\/wav data/
  );

  const content = await buildUserMessageContent('what is this', {
    ...NONE,
    images: [dataUrl('image/gif', GIF), dataUrl('image/png', PNG), dataUrl('image/png', GIF)],
    audio: [dataUrl('audio/mpeg', MP3), dataUrl('audio/wav', MP3)],
  });
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.slice(1).map(sentType), ['image/gif', 'image/png', 'image/gif', 'mp3', 'mp3']);
});

test('local attachments are sent as the type their content shows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-attach-signatures-'));
  const file = (name: string, bytes: Buffer | string) => {
    const filePath = join(dir, name);
    writeFileSync(filePath, bytes);
    return filePath;
  };
  try {
    const rejected: Array<[Partial<ChatAttachments>, RegExp]> = [
      [{ images: [file('note.png', 'not a png')] }, /note\.png does not contain image\/png data/],
      [{ files: [file('report.pdf', 'plain text')] }, /report\.pdf does not contain application\/pdf data/],
      [
        { files: [file('notes.txt', Buffer.from([0x68, 0x00, 0x69]))] },
        /notes\.txt contains NUL bytes; text\/plain attachments must be UTF-8 text/,
      ],
      [{ audio: [file('song.mp3', PNG)] }, /song\.mp3 does not contain audio\/mpeg data/],
      [{ videos: [file('clip.mp4', 'video')] }, /clip\.mp4 does not contain video\/mp4 data/],
    ];
    for (const [attachments, message] of rejected) {
      await assert.rejects(buildUserMessageContent('describe', { ...NONE, ...attachments }), message);
    }

    const content = await buildUserMessageContent('describe', {
      images: [file('photo.jpg', JPEG), file('dot.png', PNG), file('photo.png', JPEG)],
      files: [file('report.pdf', PDF), file('notes.md', '# Notes\n'), file('data.json', '{"a":1}')],
      audio: [file('voice.wav', WAV), file('padded.mp3', PADDED_MP3), file('voice.mp3', WAV)],
      videos: [file('clip.mp4', MP4), file('recording.mp4', WEBM)],
    });
    assert.ok(Array.isArray(content));
    assert.deepEqual(content.slice(1).map(sentType), [
      'image/jpeg',
      'image/png',
      'image/jpeg',
      'application/pdf',
      'text/markdown',
      'application/json',
      'wav',
      'mp3',
      'wav',
      'video/mp4',
      'video/webm',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloaded attachments are sent as the type their content shows', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/fake.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end('<html>not an image</html>');
      return;
    }
    if (request.url === '/photo.jpg') {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(PNG);
      return;
    }
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      buildUserMessageContent('what is this', { ...NONE, images: [`http://127.0.0.1:${port}/fake.png`] }),
      /fake\.png does not contain image\/png data/
    );
    const content = await buildUserMessageContent('what is this', {
      ...NONE,
      images: [`http://127.0.0.1:${port}/real.png`, `http://127.0.0.1:${port}/photo.jpg`],
    });
    assert.ok(Array.isArray(content));
    assert.deepEqual(content.slice(1).map(sentType), ['image/png', 'image/png']);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
