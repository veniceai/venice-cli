/**
 * File writes that never follow a symlink at the destination and never
 * expose a partially written file. Command output sent to a pipe, terminal,
 * or device is written in place instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Writable } from 'stream';
import { onInterrupt } from './interrupt.js';

const MAX_UNIQUE_NAME_ATTEMPTS = 1000;
const COPY_CHUNK_BYTES = 1024 * 1024;

// This process's own descriptors, such as /dev/stdout or bash's >(…). On Linux
// they are links into /proc, so a rename would replace the link instead of
// writing to the pipe or terminal behind it.
const DESCRIPTOR_PATH = /^\/(?:dev\/std(?:out|err)|(?:dev|proc\/self)\/fd\/\d+)$/;

// O_CREAT keeps the kernel's protected_fifos check for pipes in shared
// directories. O_NOFOLLOW refuses a link swapped in after the destination was checked.
const IN_PLACE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;

export interface WriteOptions {
  /**
   * Exact permissions for a created or replaced file, set before anything is
   * written. Otherwise the umask applies. Pipes and devices keep their own.
   */
  mode?: number;
}

export interface OutputFile {
  write: (data: string | Uint8Array) => void;
  createWriteStream: () => Writable;
  /** Finishes the write, leaving the data at the destination. */
  commit: () => void;
  /** Abandons the write unless it was committed. Safe to call more than once. */
  discard: () => void;
}

/**
 * An output file whose commit flushes it to disk and renames it over the
 * destination, and whose discard closes and removes it.
 */
export interface TemporaryFile extends OutputFile {
  path: string;
}

/**
 * Creates an exclusive temporary file next to `destination`, so the final
 * rename replaces whatever is at the destination instead of writing through it.
 */
export function createTemporaryFile(
  destination: string,
  options: WriteOptions = {}
): TemporaryFile {
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination).slice(0, 64)}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined = fs.openSync(
    temporaryPath,
    'wx',
    options.mode ?? replacedFileMode(destination)
  );
  let finished = false;
  const stopInterruptCleanup = onInterrupt(() => discard());

  function requireDescriptor(): number {
    if (descriptor === undefined) {
      throw new Error(`Temporary file is closed: ${temporaryPath}`);
    }
    return descriptor;
  }

  function discard(): void {
    if (finished) return;
    finished = true;
    stopInterruptCleanup();
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Removing the file below matters more than reporting the close.
      }
      descriptor = undefined;
    }
    fs.rmSync(temporaryPath, { force: true });
  }

  if (options.mode !== undefined) {
    try {
      fs.fchmodSync(descriptor, options.mode);
    } catch (error) {
      discard();
      throw error;
    }
  }

  return {
    path: temporaryPath,
    write(data) {
      fs.writeFileSync(requireDescriptor(), data);
    },
    createWriteStream() {
      return descriptorStream(requireDescriptor);
    },
    commit() {
      const fd = requireDescriptor();
      fs.fsyncSync(fd);
      descriptor = undefined;
      fs.closeSync(fd);
      fs.renameSync(temporaryPath, destination);
      finished = true;
      stopInterruptCleanup();
    },
    discard,
  };
}

/**
 * Opens a command's output destination, creating missing parent directories.
 * Files and links are replaced through a temporary file. Pipes, terminals,
 * and devices are written in place, because a rename would replace them.
 */
export function openOutputFile(destination: string, options: WriteOptions = {}): OutputFile {
  if (DESCRIPTOR_PATH.test(path.resolve(destination))) {
    return openInPlace(destination, 'w', options.mode);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing?.isFIFO() || existing?.isCharacterDevice()) {
    return openInPlace(destination, IN_PLACE_FLAGS, options.mode);
  }
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    const kind = existing.isDirectory() ? 'a directory' : 'not a file, pipe, or character device';
    throw new Error(`Cannot write to ${destination}: it is ${kind}.`);
  }

  const temporaryFile = createTemporaryFile(destination, options);
  return {
    write: temporaryFile.write,
    createWriteStream: temporaryFile.createWriteStream,
    discard: temporaryFile.discard,
    commit() {
      try {
        temporaryFile.commit();
      } catch (error) {
        // A bind-mounted file cannot be renamed over, only rewritten.
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
        copyInPlace(temporaryFile.path, destination);
        temporaryFile.discard();
      }
    },
  };
}

function openInPlace(destination: string, flags: string | number, mode = 0o666): OutputFile {
  let descriptor: number | undefined = fs.openSync(destination, flags, mode);

  function requireDescriptor(): number {
    if (descriptor === undefined) {
      throw new Error(`Output is closed: ${destination}`);
    }
    return descriptor;
  }

  return {
    write(data) {
      fs.writeFileSync(requireDescriptor(), data);
    },
    createWriteStream() {
      return descriptorStream(requireDescriptor);
    },
    commit() {
      const fd = requireDescriptor();
      descriptor = undefined;
      fs.closeSync(fd);
    },
    discard() {
      if (descriptor === undefined) return;
      const fd = descriptor;
      descriptor = undefined;
      try {
        fs.closeSync(fd);
      } catch {
        // discard() runs while another error is being reported, and there is no file to remove.
      }
    },
  };
}

// Synchronous writes keep the descriptor owned by the caller: a destroyed
// fs.WriteStream would close it on its own schedule.
function descriptorStream(requireDescriptor: () => number): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        fs.writeFileSync(requireDescriptor(), chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

function copyInPlace(source: string, destination: string): void {
  const input = fs.openSync(source, 'r');
  try {
    const output = fs.openSync(destination, IN_PLACE_FLAGS);
    try {
      const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
      while (true) {
        const count = fs.readSync(input, buffer, 0, buffer.length, null);
        if (count === 0) break;
        fs.writeFileSync(output, buffer.subarray(0, count));
      }
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}

// Replacing a file must not loosen its permissions; open() still applies the umask.
function replacedFileMode(destination: string): number {
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isFile()) return stat.mode & 0o666;
  } catch {
    // Nothing to inherit from a missing destination.
  }
  return 0o666;
}

/** Replaces `filePath` with `data` through a temporary file in the same directory. */
export function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: WriteOptions = {}
): void {
  writeAndCommit(createTemporaryFile(filePath, options), data);
}

/** Writes a command's output to `filePath`, as described for openOutputFile. */
export function writeOutputFile(
  filePath: string,
  data: string | Uint8Array,
  options: WriteOptions = {}
): void {
  writeAndCommit(openOutputFile(filePath, options), data);
}

function writeAndCommit(file: OutputFile, data: string | Uint8Array): void {
  try {
    file.write(data);
    file.commit();
  } catch (error) {
    file.discard();
    throw error;
  }
}

/**
 * Writes `data` to `preferredPath`, or to `name-1.ext`, `name-2.ext`, … when
 * that path is taken, without ever replacing an existing file or link.
 * Returns the path written.
 */
export function writeNewFile(
  preferredPath: string,
  data: string | Uint8Array,
  options: WriteOptions = {}
): string {
  const extension = path.extname(preferredPath);
  const stem = preferredPath.slice(0, preferredPath.length - extension.length);

  for (let attempt = 0; attempt < MAX_UNIQUE_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? preferredPath : `${stem}-${attempt}${extension}`;
    let placeholder: number;
    try {
      placeholder = fs.openSync(candidate, 'wx', options.mode ?? 0o666);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    fs.closeSync(placeholder);

    try {
      writeFileAtomic(candidate, data, options);
    } catch (error) {
      fs.rmSync(candidate, { force: true });
      throw error;
    }
    return candidate;
  }

  throw new Error(`Could not find an unused file name for ${preferredPath}`);
}
