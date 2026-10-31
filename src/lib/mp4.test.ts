import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_MP4_HEADER_BYTES, checkMp4Header, fileHasMp4Header } from './mp4.js';

function box(type: string, payload = '', size?: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size ?? payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, Buffer.from(payload, 'latin1')]);
}

const ftyp = box('ftyp', 'isom\0\0\x02\0isommp41');
const jsonWithFtypAtOffsetFour = Buffer.from('{  "ftyp":1,"status":"FAILED","error":"quota"}');

test('checkMp4Header accepts an ftyp box at the start or after one padding box', () => {
  assert.equal(checkMp4Header(ftyp), 'valid');
  assert.equal(checkMp4Header(Buffer.concat([ftyp, box('mdat', 'frames')])), 'valid');
  for (const padding of ['free', 'skip', 'wide']) {
    assert.equal(checkMp4Header(Buffer.concat([box(padding), ftyp])), 'valid', padding);
    assert.equal(checkMp4Header(Buffer.concat([box(padding, 'pad'), ftyp])), 'valid', padding);
  }
  assert.equal(checkMp4Header(box('ftyp', 'qt  \0\0\0\0qt  ')), 'valid');
});

test('checkMp4Header rejects text and JSON even when bytes 4-7 spell ftyp', () => {
  assert.equal(jsonWithFtypAtOffsetFour.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.equal(checkMp4Header(jsonWithFtypAtOffsetFour), 'invalid');
  assert.equal(checkMp4Header(Buffer.from('xxxxftypisom-not-a-video')), 'invalid');
  assert.equal(checkMp4Header(Buffer.from('    {"status":"FAILED"}')), 'invalid');
  assert.equal(checkMp4Header(Buffer.from('<html>ftyp</html>')), 'invalid');
});

test('checkMp4Header rejects malformed ftyp and padding boxes', () => {
  assert.equal(checkMp4Header(box('ftyp', 'isom', 12)), 'invalid', 'ftyp smaller than 16 bytes');
  assert.equal(checkMp4Header(box('ftyp', 'isom\0\0\0\0', 0)), 'invalid', 'ftyp extending to end of file');
  assert.equal(
    checkMp4Header(box('ftyp', 'isom\0\0\0\0', MAX_MP4_HEADER_BYTES + 1)),
    'invalid',
    'ftyp larger than the header limit'
  );
  assert.equal(checkMp4Header(box('ftyp', '\0\x01\x02\x03\0\0\0\0')), 'invalid', 'non-printable brand');
  assert.equal(checkMp4Header(box('moov', 'isom\0\0\0\0')), 'invalid', 'no ftyp box');
  assert.equal(checkMp4Header(Buffer.concat([box('free'), box('free'), ftyp])), 'invalid', 'two padding boxes');
  assert.equal(checkMp4Header(Buffer.concat([box('free', '', 4), ftyp])), 'invalid', 'padding box under 8 bytes');
  assert.equal(
    checkMp4Header(Buffer.concat([box('free', '', MAX_MP4_HEADER_BYTES + 8), ftyp])),
    'invalid',
    'padding box larger than the header limit'
  );
});

test('checkMp4Header asks for more bytes until the ftyp box is complete', () => {
  assert.equal(checkMp4Header(Buffer.alloc(0)), 'incomplete');
  assert.equal(checkMp4Header(ftyp.subarray(0, 7)), 'incomplete');
  assert.equal(checkMp4Header(ftyp.subarray(0, 12)), 'incomplete');
  assert.equal(checkMp4Header(ftyp.subarray(0, ftyp.length - 1)), 'incomplete');
  assert.equal(checkMp4Header(Buffer.concat([box('free', 'pad'), ftyp.subarray(0, 4)])), 'incomplete');
});

test('fileHasMp4Header checks the bytes saved on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-mp4-'));
  try {
    const cases: Array<[string, Buffer, boolean]> = [
      ['video.mp4', Buffer.concat([ftyp, box('mdat', 'frames')]), true],
      ['padded.mp4', Buffer.concat([box('free'), ftyp]), true],
      ['json.mp4', jsonWithFtypAtOffsetFour, false],
      ['truncated.mp4', ftyp.subarray(0, 12), false],
      ['empty.mp4', Buffer.alloc(0), false],
    ];
    for (const [name, bytes, expected] of cases) {
      const filePath = join(dir, name);
      writeFileSync(filePath, bytes);
      assert.equal(fileHasMp4Header(filePath), expected, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
