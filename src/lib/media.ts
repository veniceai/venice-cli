import * as fs from 'fs';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStreamReadResult } from 'stream/web';
import { fetchDownload } from './download-guard.js';
import {
  createTemporaryFile,
  type TemporaryFile,
  writeNewFile,
  writeOutputFile,
} from './safe-write.js';

const MB = 1024 * 1024;

export const MAX_IMAGE_DOWNLOAD_BYTES = 50 * MB;
export const MAX_IMAGE_EDIT_BYTES = 25 * MB;
export const MAX_AUDIO_DOWNLOAD_BYTES = 500 * MB;
export const MAX_VIDEO_DOWNLOAD_BYTES = 1024 * MB;
export const MAX_UPSCALE_IMAGE_BYTES = 25 * MB;
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 200 * MB;
export const MAX_VOICE_SAMPLE_BYTES = 25 * MB;
export const MAX_VIDEO_REFERENCE_IMAGE_BYTES = 20 * MB;
export const MAX_CHAT_IMAGE_BYTES = 20 * MB;
export const MAX_CHAT_FILE_BYTES = 25 * MB;
export const MAX_CHAT_AUDIO_BYTES = 25 * MB;
export const MAX_CHAT_VIDEO_BYTES = 50 * MB;
export const MAX_DOCUMENT_PARSE_BYTES = 25 * MB;
export const MAX_VIDEO_UPSCALE_BYTES = 200 * MB;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;
const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 120000;

export async function readWithInactivityTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Download stalled for ${Math.ceil(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function assertFileSizeWithinLimit(
  filePath: string,
  maxBytes: number,
  label: string
): number {
  const stats = fs.statSync(filePath);

  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `${label} is too large (${formatBytes(stats.size)}). ` +
      `Maximum allowed size is ${formatBytes(maxBytes)}.`
    );
  }

  return stats.size;
}

function readFileWithinLimit(
  filePath: string,
  maxBytes: number,
  label: string
): Buffer {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fileDescriptor);
    if (!stats.isFile()) {
      throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `${label} is too large (${formatBytes(stats.size)}). ` +
        `Maximum allowed size is ${formatBytes(maxBytes)}.`
      );
    }

    const buffer = Buffer.alloc(stats.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(
        fileDescriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > stats.size) {
      throw new Error(`${label} changed while it was being read; please retry.`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function assertWritableBuffer(
  bytes: Buffer,
  options: { maxBytes: number; label: string }
): void {
  if (bytes.length > options.maxBytes) {
    throw new Error(
      `${options.label} is too large (${formatBytes(bytes.length)}). ` +
      `Maximum allowed size is ${formatBytes(options.maxBytes)}.`
    );
  }

  if (bytes.length === 0) {
    throw new Error(`${options.label} response was empty.`);
  }
}

export function writeBufferToFile(
  bytes: Buffer,
  outputPath: string,
  options: { maxBytes: number; label: string }
): { bytesWritten: number } {
  assertWritableBuffer(bytes, options);
  writeOutputFile(outputPath, bytes);
  return { bytesWritten: bytes.length };
}

/** Writes to `preferredPath`, or a numbered variant of it, without replacing an existing file. */
export function writeBufferToNewFile(
  bytes: Buffer,
  preferredPath: string,
  options: { maxBytes: number; label: string }
): { bytesWritten: number; outputPath: string } {
  assertWritableBuffer(bytes, options);
  const outputPath = writeNewFile(preferredPath, bytes);
  return { bytesWritten: bytes.length, outputPath };
}

export function mimeTypeFromPath(filePath: string, fallback = 'application/octet-stream'): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.opus': 'audio/opus',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.pdf': 'application/pdf',
    '.epub': 'application/epub+zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.ts': 'text/plain',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.java': 'text/x-java-source',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.ps1': 'text/plain',
    '.sh': 'text/x-shellscript',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.sql': 'text/plain',
  };

  return mimeByExtension[ext] || fallback;
}

export async function fileToDataUrl(
  filePath: string,
  maxBytes: number,
  label: string
): Promise<string> {
  const data = readFileWithinLimit(filePath, maxBytes, label);
  const mimeType = mimeTypeFromPath(filePath, 'video/mp4');
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

type LeadingBytesCheck = {
  check: (bytes: Buffer) => 'valid' | 'invalid' | 'incomplete';
  invalidMessage: string;
};

function withLeadingBytesCheck(response: Response, leadingBytes: LeadingBytesCheck): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  let head: Buffer | undefined = Buffer.alloc(0);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (head === undefined) {
            if (done) controller.close();
            else controller.enqueue(value);
            return;
          }
          if (done) {
            if (head.length > 0) throw new Error(leadingBytes.invalidMessage);
            controller.close();
            return;
          }

          head = Buffer.concat([head, value]);
          const verdict = leadingBytes.check(head);
          if (verdict === 'invalid') throw new Error(leadingBytes.invalidMessage);
          if (verdict === 'valid') {
            controller.enqueue(head);
            head = undefined;
            return;
          }
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function downloadToFile(
  url: string,
  outputPath: string,
  options: {
    maxBytes: number;
    expectedContentTypePrefixes: string[];
    timeoutMs?: number;
    leadingBytes?: LeadingBytesCheck;
  }
): Promise<{ bytesWritten: number; contentType: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchDownload(url, controller.signal);

    return await writeResponseToFile(
      options.leadingBytes ? withLeadingBytesCheck(response, options.leadingBytes) : response,
      outputPath,
      options
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Download timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function writeResponseToFile(
  response: Response,
  outputPath: string,
  options: {
    maxBytes: number;
    expectedContentTypePrefixes: string[];
  }
): Promise<{ bytesWritten: number; contentType: string }> {
  const contentTypeHeader = response.headers.get('content-type');
  const contentType = contentTypeHeader?.split(';')[0].trim().toLowerCase() || '';
  const expectedPrefixes = options.expectedContentTypePrefixes.map((prefix) => prefix.toLowerCase());

  if (!contentType) {
    throw new Error('Download response missing Content-Type header.');
  }
  if (!expectedPrefixes.some((prefix) => contentType.startsWith(prefix))) {
    throw new Error(
      `Unexpected content type "${contentType}". ` +
      `Expected one of: ${options.expectedContentTypePrefixes.join(', ')}`
    );
  }

  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength === 0) {
    throw new Error('Download response was empty.');
  }
  if (contentLength !== null && contentLength > options.maxBytes) {
    throw new Error(
      `Refusing to download ${formatBytes(contentLength)}. ` +
      `Maximum allowed size is ${formatBytes(options.maxBytes)}.`
    );
  }
  if (!response.body) {
    throw new Error('Download response has no body.');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryFile = createTemporaryFile(outputPath);

  try {
    let bytesWritten = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        if (bytesWritten > options.maxBytes) {
          callback(
            new Error(
              `Download exceeded limit of ${formatBytes(options.maxBytes)}. ` +
              'The remote file may be unexpectedly large.'
            )
          );
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as unknown as globalThis.ReadableStream<Uint8Array>),
      limiter,
      temporaryFile.createWriteStream()
    );

    if (bytesWritten === 0) {
      throw new Error('Download response was empty.');
    }
    temporaryFile.commit();
    return { bytesWritten, contentType };
  } catch (error) {
    temporaryFile.discard();
    throw error;
  }
}

export async function streamResponseToFile(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialChunks: Buffer[],
  outputPath: string,
  options: {
    maxBytes: number;
    label: string;
    inactivityTimeoutMs?: number;
  }
): Promise<{ bytesWritten: number; contentType: string }> {
  let temporaryFile: TemporaryFile | undefined;
  let bytesWritten = 0;
  const inactivityTimeoutMs =
    options.inactivityTimeoutMs ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS;

  try {
    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > options.maxBytes) {
      throw new Error(
        `Refusing to download ${formatBytes(contentLength)}. ` +
        `Maximum allowed size is ${formatBytes(options.maxBytes)}.`
      );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    temporaryFile = createTemporaryFile(outputPath);

    const source = Readable.from((async function* () {
      for (const chunk of initialChunks) {
        yield chunk;
      }
      while (true) {
        const { done, value } = await readWithInactivityTimeout(
          reader,
          inactivityTimeoutMs
        );
        if (done) return;
        yield Buffer.from(value);
      }
    })());
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        if (bytesWritten > options.maxBytes) {
          callback(
            new Error(
              `${options.label} download exceeded limit of ${formatBytes(options.maxBytes)}. ` +
              'The response may be unexpectedly large.'
            )
          );
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(source, limiter, temporaryFile.createWriteStream());
    if (bytesWritten === 0) {
      throw new Error(`${options.label} response was empty.`);
    }
    temporaryFile.commit();
    return {
      bytesWritten,
      contentType: response.headers.get('content-type') || 'video/mp4',
    };
  } catch (error) {
    temporaryFile?.discard();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function readFileAsBase64(
  filePath: string,
  maxBytes: number,
  label: string
): { base64: string; mimeType: string; filename: string } {
  const buffer = readFileWithinLimit(filePath, maxBytes, label);
  return {
    base64: buffer.toString('base64'),
    mimeType: mimeTypeFromPath(filePath),
    filename: path.basename(filePath),
  };
}

export function readFileAsDataUrl(
  filePath: string,
  maxBytes: number,
  label: string
): { dataUrl: string; mimeType: string; filename: string } {
  const file = readFileAsBase64(filePath, maxBytes, label);
  return {
    dataUrl: `data:${file.mimeType};base64,${file.base64}`,
    mimeType: file.mimeType,
    filename: file.filename,
  };
}

export function audioFormatFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const formatByExtension: Record<string, string> = {
    '.wav': 'wav',
    '.mp3': 'mp3',
    '.aiff': 'aiff',
    '.aif': 'aiff',
    '.aac': 'aac',
    '.ogg': 'ogg',
    '.opus': 'opus',
    '.flac': 'flac',
    '.m4a': 'm4a',
  };
  return formatByExtension[ext] || 'wav';
}

export async function downloadToBuffer(
  url: string,
  options: {
    maxBytes: number;
    timeoutMs?: number;
  }
): Promise<{ buffer: Buffer; contentType: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const contentTypeHeader = response.headers.get('content-type');
    const contentType = contentTypeHeader?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > options.maxBytes) {
      throw new Error(
        `Refusing to download ${formatBytes(contentLength)}. ` +
        `Maximum allowed size is ${formatBytes(options.maxBytes)}.`
      );
    }

    if (!response.body) {
      throw new Error('Download response has no body.');
    }

    const chunks: Buffer[] = [];
    let bytesWritten = 0;
    for await (const chunk of Readable.fromWeb(
      response.body as unknown as globalThis.ReadableStream<Uint8Array>
    )) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesWritten += buffer.length;
      if (bytesWritten > options.maxBytes) {
        throw new Error(
          `Download exceeded limit of ${formatBytes(options.maxBytes)}. ` +
          'The remote file may be unexpectedly large.'
        );
      }
      chunks.push(buffer);
    }

    return { buffer: Buffer.concat(chunks), contentType };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Download timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
