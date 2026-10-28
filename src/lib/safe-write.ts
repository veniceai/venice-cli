/**
 * File writes that never follow a symlink at the destination and never
 * expose a partially written file
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Writable } from 'stream';
import { onInterrupt } from './interrupt.js';

const MAX_UNIQUE_NAME_ATTEMPTS = 1000;

export interface WriteOptions {
  /** Exact permissions, set on the descriptor before anything is written. Otherwise the umask applies. */
  mode?: number;
}

export interface TemporaryFile {
  path: string;
  write: (data: string | Uint8Array) => void;
  createWriteStream: () => Writable;
  /** Flushes the file to disk and renames it over the destination. */
  commit: () => void;
  /** Closes and removes the file unless it was committed. Safe to call more than once. */
  discard: () => void;
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
    // Synchronous writes keep the descriptor owned here: a destroyed
    // fs.WriteStream would close it on its own schedule.
    createWriteStream() {
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
  const temporaryFile = createTemporaryFile(filePath, options);
  try {
    temporaryFile.write(data);
    temporaryFile.commit();
  } catch (error) {
    temporaryFile.discard();
    throw error;
  }
}

/** Like writeFileAtomic, but creates missing parent directories first. */
export function writeOutputFile(
  filePath: string,
  data: string | Uint8Array,
  options: WriteOptions = {}
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, data, options);
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
