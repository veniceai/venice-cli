import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeBufferToFile } from './media.js';

process.umask(0o022);

const limits = { maxBytes: 1024, label: 'Generated image' };

test('writeBufferToFile replaces a symlink at the output path instead of following it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-media-write-'));
  try {
    const target = join(dir, 'target.png');
    const link = join(dir, 'link.png');
    const danglingTarget = join(dir, 'created-elsewhere.png');
    const danglingLink = join(dir, 'dangling.png');
    writeFileSync(target, 'TARGET');
    symlinkSync(target, link);
    symlinkSync(danglingTarget, danglingLink);

    writeBufferToFile(Buffer.from('image-bytes'), link, limits);
    writeBufferToFile(Buffer.from('image-bytes'), danglingLink, limits);

    assert.equal(readFileSync(target, 'utf8'), 'TARGET');
    assert.equal(existsSync(danglingTarget), false);
    for (const written of [link, danglingLink]) {
      assert.equal(lstatSync(written).isSymbolicLink(), false);
      assert.equal(readFileSync(written, 'utf8'), 'image-bytes');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBufferToFile uses umask permissions for new files and keeps those of a replaced file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-media-write-'));
  try {
    const fresh = join(dir, 'fresh.png');
    const existing = join(dir, 'existing.png');
    writeFileSync(existing, 'old', { mode: 0o600 });

    writeBufferToFile(Buffer.from('new-image'), fresh, limits);
    const result = writeBufferToFile(Buffer.from('new-image'), existing, limits);

    assert.equal(result.bytesWritten, 9);
    assert.equal(readFileSync(existing, 'utf8'), 'new-image');
    assert.equal(statSync(fresh).mode & 0o777, 0o644);
    assert.equal(statSync(existing).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), ['existing.png', 'fresh.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
