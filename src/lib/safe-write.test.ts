import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { runInterruptCleanups } from './interrupt.js';
import {
  createTemporaryFile,
  writeFileAtomic,
  writeNewFile,
  writeOutputFile,
} from './safe-write.js';

process.umask(0o022);

const mode = (filePath: string) => statSync(filePath).mode & 0o777;

async function withTempDir(callback: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'venice-safe-write-'));
  try {
    await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeFileAtomic replaces a symlink at the destination instead of writing through it', () =>
  withTempDir((dir) => {
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.txt');
    const danglingTarget = join(dir, 'missing.txt');
    const danglingLink = join(dir, 'dangling.txt');
    writeFileSync(target, 'TARGET');
    symlinkSync(target, link);
    symlinkSync(danglingTarget, danglingLink);

    writeFileAtomic(link, 'new contents');
    writeFileAtomic(danglingLink, 'new contents');

    assert.equal(readFileSync(target, 'utf8'), 'TARGET');
    assert.equal(existsSync(danglingTarget), false);
    for (const written of [link, danglingLink]) {
      assert.equal(lstatSync(written).isFile(), true);
      assert.equal(readFileSync(written, 'utf8'), 'new contents');
    }
  }));

test('writeFileAtomic sets an explicit mode on a replaced file and leaves no temporary files', () =>
  withTempDir((dir) => {
    const file = join(dir, 'private.json');
    writeFileSync(file, 'old');
    chmodSync(file, 0o644);

    writeFileAtomic(file, '{"private":true}', { mode: 0o600 });

    assert.equal(readFileSync(file, 'utf8'), '{"private":true}');
    assert.equal(mode(file), 0o600);
    assert.deepEqual(readdirSync(dir), ['private.json']);
  }));

test('writeOutputFile creates parent directories and keeps umask permissions', () =>
  withTempDir((dir) => {
    const file = join(dir, 'nested', 'deeper', 'out.json');

    writeOutputFile(file, '[]');

    assert.equal(readFileSync(file, 'utf8'), '[]');
    assert.equal(mode(file), 0o644);
  }));

test('writeFileAtomic keeps the destination and removes its temporary file when the rename fails', () =>
  withTempDir((dir) => {
    const destination = join(dir, 'occupied');
    mkdirSync(destination);
    writeFileSync(join(destination, 'keep.txt'), 'keep');

    assert.throws(() => writeFileAtomic(destination, 'data'));

    assert.equal(readFileSync(join(destination, 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual(readdirSync(dir), ['occupied']);
  }));

test('writeNewFile picks a numbered name instead of replacing a file or a link', () =>
  withTempDir((dir) => {
    const preferred = join(dir, 'speech.mp3');
    const firstAlternative = join(dir, 'speech-1.mp3');
    const linkTarget = join(dir, 'elsewhere.mp3');
    writeFileSync(preferred, 'EXISTING');
    symlinkSync(linkTarget, firstAlternative);

    const written = writeNewFile(preferred, 'audio');

    assert.equal(written, join(dir, 'speech-2.mp3'));
    assert.equal(readFileSync(written, 'utf8'), 'audio');
    assert.equal(readFileSync(preferred, 'utf8'), 'EXISTING');
    assert.equal(lstatSync(firstAlternative).isSymbolicLink(), true);
    assert.equal(existsSync(linkTarget), false);
    assert.deepEqual(
      readdirSync(dir).sort(),
      ['speech-1.mp3', 'speech-2.mp3', 'speech.mp3']
    );
  }));

test('createTemporaryFile streams into a hidden file that replaces the destination on commit', () =>
  withTempDir(async (dir) => {
    const destination = join(dir, 'video.mp4');
    writeFileSync(destination, 'old video');
    const temporaryFile = createTemporaryFile(destination);

    await pipeline(
      Readable.from([Buffer.from('new '), Buffer.from('video')]),
      temporaryFile.createWriteStream()
    );
    assert.equal(readFileSync(destination, 'utf8'), 'old video');
    assert.equal(readFileSync(temporaryFile.path, 'utf8'), 'new video');

    temporaryFile.commit();
    temporaryFile.discard();

    assert.equal(readFileSync(destination, 'utf8'), 'new video');
    assert.deepEqual(readdirSync(dir), ['video.mp4']);
  }));

test('an interrupt removes temporary files that are still open but not committed ones', () =>
  withTempDir((dir) => {
    const committed = createTemporaryFile(join(dir, 'done.mp3'));
    committed.write('complete');
    committed.commit();
    const pending = createTemporaryFile(join(dir, 'pending.mp3'));
    pending.write('partial');

    runInterruptCleanups();

    assert.deepEqual(readdirSync(dir), ['done.mp3']);
    assert.equal(readFileSync(join(dir, 'done.mp3'), 'utf8'), 'complete');
    assert.throws(() => pending.commit(), /closed/);
  }));

test('createTemporaryFile discard removes the file and leaves the destination alone', () =>
  withTempDir((dir) => {
    const destination = join(dir, 'song.mp3');
    writeFileSync(destination, 'keep');
    const temporaryFile = createTemporaryFile(destination);
    temporaryFile.write('partial');

    temporaryFile.discard();
    temporaryFile.discard();

    assert.equal(readFileSync(destination, 'utf8'), 'keep');
    assert.deepEqual(readdirSync(dir), ['song.mp3']);
    assert.throws(() => temporaryFile.commit(), /closed/);
  }));
