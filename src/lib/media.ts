import * as fs from 'fs';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

const MB = 1024 * 1024;

export const MAX_IMAGE_DOWNLOAD_BYTES = 50 * MB;
export const MAX_VIDEO_DOWNLOAD_BYTES = 1024 * MB;
export const MAX_UPSCALE_IMAGE_BYTES = 25 * MB;
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 200 * MB;
export const MAX_VIDEO_REFERENCE_IMAGE_BYTES = 20 * MB;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;

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

  if (stats.size > maxBytes) {
    throw new Error(
      `${label} is too large (${formatBytes(stats.size)}). ` +
      `Maximum allowed size is ${formatBytes(maxBytes)}.`
    );
  }

  return stats.size;
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
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.opus': 'audio/opus',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
  };

  return mimeByExtension[ext] || fallback;
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

export async function downloadToFile(
  url: string,
  outputPath: string,
  options: {
    maxBytes: number;
    expectedContentTypePrefixes: string[];
    timeoutMs?: number;
  }
): Promise<{ bytesWritten: number; contentType: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let tempPath: string | null = null;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

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
    if (contentLength !== null && contentLength > options.maxBytes) {
      throw new Error(
        `Refusing to download ${formatBytes(contentLength)}. ` +
        `Maximum allowed size is ${formatBytes(options.maxBytes)}.`
      );
    }

    if (!response.body) {
      throw new Error('Download response has no body.');
    }

    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    tempPath = path.join(
      outputDir,
      `.${path.basename(outputPath)}.${Date.now()}.${Math.random().toString(16).slice(2)}.part`
    );

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
      fs.createWriteStream(tempPath)
    );

    fs.renameSync(tempPath, outputPath);
    tempPath = null;

    return { bytesWritten, contentType };
  } catch (error) {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Download timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
