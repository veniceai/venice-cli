import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  MAX_CHAT_AUDIO_BYTES,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_VIDEO_BYTES,
  assertFileSizeWithinLimit,
  downloadToBuffer,
  formatBytes,
  mimeTypeFromPath,
  readFileAsBase64,
  readFileAsDataUrl,
} from './media.js';
import type {
  ContentPart,
  FileContentPart,
  ImageUrlContentPart,
  InputAudioContentPart,
  MessageContent,
  Model,
  VideoUrlContentPart,
} from '../types/index.js';
import {
  supportsAudioInput,
  supportsMultipleImages,
  supportsVideoInput,
  supportsVision,
} from '../types/index.js';

export interface ChatAttachments {
  images: string[];
  files: string[];
  audio: string[];
  videos: string[];
}

export const MAX_CHAT_ATTACHMENTS = 16;
export const MAX_CHAT_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_REMOTE_URL_LENGTH = 8192;

type AttachmentKind = 'image' | 'file' | 'audio' | 'video';

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/aiff',
  'audio/x-aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/opus',
]);
const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
]);
const SUPPORTED_FILE_MIME_TYPES = new Set([
  'application/pdf',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/json',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/javascript',
  'text/x-python',
  'text/x-c',
  'text/x-c++',
  'text/x-java-source',
  'text/x-go',
  'text/x-rust',
  'text/x-shellscript',
  'text/yaml',
]);

export function collectOptionValue(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

export function parseChatAttachments(options: {
  image?: string[];
  file?: string[];
  audio?: string[];
  video?: string[];
}): ChatAttachments {
  return {
    images: options.image ?? [],
    files: options.file ?? [],
    audio: options.audio ?? [],
    videos: options.video ?? [],
  };
}

export function hasChatAttachments(attachments: ChatAttachments): boolean {
  return (
    attachments.images.length +
    attachments.files.length +
    attachments.audio.length +
    attachments.videos.length
  ) > 0;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isRemoteOrDataUrl(value: string): boolean {
  return isHttpUrl(value) || value.startsWith('data:');
}

export function assertLocalAttachmentFiles(attachments: ChatAttachments): void {
  inspectAttachmentSources(attachments);
}

function inspectAttachmentSources(attachments: ChatAttachments): number {
  const entries: Array<{
    source: string;
    kind: AttachmentKind;
    maxBytes: number;
    label: string;
  }> = [
    ...attachments.images.map((source) => ({
      source, kind: 'image' as const, maxBytes: MAX_CHAT_IMAGE_BYTES, label: 'Image',
    })),
    ...attachments.files.map((source) => ({
      source, kind: 'file' as const, maxBytes: MAX_CHAT_FILE_BYTES, label: 'File',
    })),
    ...attachments.audio.map((source) => ({
      source, kind: 'audio' as const, maxBytes: MAX_CHAT_AUDIO_BYTES, label: 'Audio',
    })),
    ...attachments.videos.map((source) => ({
      source, kind: 'video' as const, maxBytes: MAX_CHAT_VIDEO_BYTES, label: 'Video',
    })),
  ];

  if (entries.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`At most ${MAX_CHAT_ATTACHMENTS} attachments may be sent per request.`);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += inspectAttachmentSource(
      entry.source,
      entry.kind,
      entry.maxBytes,
      entry.label
    );
    if (totalBytes > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments are too large in aggregate (${formatBytes(totalBytes)}). ` +
        `Maximum combined size is ${formatBytes(MAX_CHAT_ATTACHMENT_BYTES)}.`
      );
    }
  }
  return totalBytes;
}

function inspectAttachmentSource(
  source: string,
  kind: AttachmentKind,
  maxBytes: number,
  label: string
): number {
  if (source.startsWith('data:')) {
    const parsed = parseDataUrl(source, label);
    assertSupportedMimeType(kind, parsed.mimeType, source);
    const size = decodedBase64Length(parsed.base64, label);
    assertSizeWithinLimit(size, maxBytes, label);
    return size;
  }

  if (isHttpUrl(source)) {
    if (source.length > MAX_REMOTE_URL_LENGTH) {
      throw new Error(`${label} URL exceeds ${MAX_REMOTE_URL_LENGTH} characters.`);
    }
    const pathname = new URL(source).pathname;
    const extension = extname(pathname);
    if (extension) {
      const mimeType = mimeTypeFromPath(pathname);
      if (mimeType === 'application/octet-stream') {
        throw new Error(`Unsupported ${label.toLowerCase()} file type: ${extension}`);
      }
      assertSupportedMimeType(kind, mimeType, source);
    }
    return 0;
  }

  if (!existsSync(source)) {
    throw new Error(`${label} not found: ${source}`);
  }
  const size = assertFileSizeWithinLimit(source, maxBytes, label);
  if (size === 0) {
    throw new Error(`${label} is empty: ${source}`);
  }
  assertSupportedMimeType(kind, mimeTypeFromPath(source), source);
  return size;
}

export function assertAttachmentCapabilities(model: Model, attachments: ChatAttachments): void {
  const modelId = model.id;
  const imageCount = attachments.images.length;
  const audioCount = attachments.audio.length;
  const videoCount = attachments.videos.length;

  if (imageCount > 0 && !supportsVision(model)) {
    throw new Error(`Model "${modelId}" does not support image inputs (supportsVision).`);
  }

  if (imageCount > 1) {
    if (!supportsMultipleImages(model)) {
      throw new Error(`Model "${modelId}" does not support multiple images (supportsMultipleImages).`);
    }
    const maxImages = model.model_spec?.capabilities?.maxImages;
    if (typeof maxImages === 'number' && imageCount > maxImages) {
      throw new Error(`Model "${modelId}" accepts at most ${maxImages} images per request.`);
    }
  }

  if (audioCount > 0 && !supportsAudioInput(model)) {
    throw new Error(`Model "${modelId}" does not support audio inputs (supportsAudioInput).`);
  }

  if (videoCount > 0 && !supportsVideoInput(model)) {
    throw new Error(`Model "${modelId}" does not support video inputs (supportsVideoInput).`);
  }

  if (videoCount > 0) {
    const maxVideos = model.model_spec?.capabilities?.maxVideos;
    const limit = typeof maxVideos === 'number' ? maxVideos : 3;
    if (videoCount > limit) {
      throw new Error(`At most ${limit} videos may be attached per request.`);
    }
  }
}

export function assertAttachmentsAllowedForPrivacy(useE2EE: boolean, useTEE: boolean): void {
  if (useE2EE || useTEE) {
    throw new Error(
      'Multimodal attachments are not supported with E2EE or TEE. ' +
      'Use a standard chat model, or omit --image/--file/--audio/--video.'
    );
  }
}

export async function buildUserMessageContent(
  prompt: string,
  attachments: ChatAttachments,
  options: { downloadTimeoutMs?: number } = {}
): Promise<MessageContent> {
  inspectAttachmentSources(attachments);
  let totalBytes = 0;
  const parts: ContentPart[] = [];
  if (prompt.trim()) {
    parts.push({ type: 'text', text: prompt });
  }

  for (const image of attachments.images) {
    const built = await buildAttachmentPart(
      'image', image, remainingAttachmentBytes(totalBytes), options.downloadTimeoutMs
    );
    totalBytes = addAttachmentBytes(totalBytes, built.bytes);
    parts.push(built.part);
  }
  for (const file of attachments.files) {
    const built = await buildAttachmentPart(
      'file', file, remainingAttachmentBytes(totalBytes), options.downloadTimeoutMs
    );
    totalBytes = addAttachmentBytes(totalBytes, built.bytes);
    parts.push(built.part);
  }
  for (const audio of attachments.audio) {
    const built = await buildAttachmentPart(
      'audio', audio, remainingAttachmentBytes(totalBytes), options.downloadTimeoutMs
    );
    totalBytes = addAttachmentBytes(totalBytes, built.bytes);
    parts.push(built.part);
  }
  for (const video of attachments.videos) {
    const built = await buildAttachmentPart(
      'video', video, remainingAttachmentBytes(totalBytes), options.downloadTimeoutMs
    );
    totalBytes = addAttachmentBytes(totalBytes, built.bytes);
    parts.push(built.part);
  }

  if (parts.length === 0) {
    throw new Error('No prompt or attachments provided.');
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return parts[0].text;
  }
  return parts;
}

type BuiltAttachment = {
  part: ImageUrlContentPart | FileContentPart | InputAudioContentPart | VideoUrlContentPart;
  bytes: number;
};

function maxBytesForKind(kind: AttachmentKind): number {
  return kind === 'image' ? MAX_CHAT_IMAGE_BYTES :
    kind === 'file' ? MAX_CHAT_FILE_BYTES :
    kind === 'audio' ? MAX_CHAT_AUDIO_BYTES :
    MAX_CHAT_VIDEO_BYTES;
}

function labelForKind(kind: AttachmentKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function remainingAttachmentBytes(totalBytes: number): number {
  const remaining = MAX_CHAT_ATTACHMENT_BYTES - totalBytes;
  if (remaining <= 0) {
    throw new Error(
      `Attachments exceed the maximum combined size of ${formatBytes(MAX_CHAT_ATTACHMENT_BYTES)}.`
    );
  }
  return remaining;
}

function addAttachmentBytes(totalBytes: number, bytes: number): number {
  const nextTotal = totalBytes + bytes;
  if (nextTotal > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments are too large in aggregate (${formatBytes(nextTotal)}). ` +
      `Maximum combined size is ${formatBytes(MAX_CHAT_ATTACHMENT_BYTES)}.`
    );
  }
  return nextTotal;
}

async function buildAttachmentPart(
  kind: AttachmentKind,
  source: string,
  aggregateRemainingBytes: number,
  downloadTimeoutMs: number | undefined
): Promise<BuiltAttachment> {
  const label = labelForKind(kind);
  const maxBytes = Math.min(maxBytesForKind(kind), aggregateRemainingBytes);

  if (isHttpUrl(source)) {
    const downloaded = await downloadToBuffer(source, {
      maxBytes,
      timeoutMs: downloadTimeoutMs,
    });
    const mimeType = normalizeMimeType(downloaded.contentType);
    assertSupportedMimeType(kind, mimeType, source);
    assertSizeWithinLimit(downloaded.buffer.length, maxBytes, label);
    assertContentMatchesMimeType(downloaded.buffer, mimeType, label, source);
    return buildPart(
      kind,
      downloaded.buffer.toString('base64'),
      mimeType,
      filenameFromSource(source),
      downloaded.buffer.length
    );
  }

  if (source.startsWith('data:')) {
    const parsed = parseDataUrl(source, label);
    assertSupportedMimeType(kind, parsed.mimeType, source);
    const bytes = decodedBase64Length(parsed.base64, label);
    assertSizeWithinLimit(bytes, maxBytes, label);
    assertContentMatchesMimeType(leadingBytes(parsed.base64), parsed.mimeType, label, 'data URL');
    return buildPart(kind, parsed.base64, parsed.mimeType, undefined, bytes);
  }

  if (kind === 'audio') {
    const file = readFileAsBase64(source, maxBytes, label);
    const bytes = decodedBase64Length(file.base64, label);
    assertSizeWithinLimit(bytes, maxBytes, label);
    assertContentMatchesMimeType(leadingBytes(file.base64), file.mimeType, label, source);
    return buildPart(kind, file.base64, file.mimeType, file.filename, bytes);
  }

  const file = readFileAsDataUrl(source, maxBytes, label);
  const parsed = parseDataUrl(file.dataUrl, label);
  const bytes = decodedBase64Length(parsed.base64, label);
  assertSizeWithinLimit(bytes, maxBytes, label);
  assertContentMatchesMimeType(leadingBytes(parsed.base64), file.mimeType, label, source);
  return buildPart(kind, parsed.base64, file.mimeType, file.filename, bytes);
}

// 8192 base64 characters decode to the first 6 KiB, enough for every check.
function leadingBytes(base64: string): Buffer {
  return Buffer.from(base64.slice(0, 8192), 'base64');
}

function hasAscii(bytes: Buffer, offset: number, text: string): boolean {
  return bytes.subarray(offset, offset + text.length).toString('latin1') === text;
}

function isWave(bytes: Buffer): boolean {
  return ['RIFF', 'RF64', 'BW64'].some((tag) => hasAscii(bytes, 0, tag)) && hasAscii(bytes, 8, 'WAVE');
}

function isAiff(bytes: Buffer): boolean {
  return hasAscii(bytes, 0, 'FORM') && (hasAscii(bytes, 8, 'AIFF') || hasAscii(bytes, 8, 'AIFC'));
}

function isMpegAudioFrame(bytes: Buffer): boolean {
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0;
}

function isAdtsFrame(bytes: Buffer): boolean {
  return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
}

function isIsoMedia(bytes: Buffer): boolean {
  return ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].some((box) => hasAscii(bytes, 4, box));
}

function isOgg(bytes: Buffer): boolean {
  return hasAscii(bytes, 0, 'OggS');
}

function isEbml(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function isZip(bytes: Buffer): boolean {
  return hasAscii(bytes, 0, 'PK\u0003\u0004');
}

const CONTENT_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ),
  'image/jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': (bytes) => hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP'),
  'image/gif': (bytes) => hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a'),
  'audio/wav': isWave,
  'audio/x-wav': isWave,
  'audio/mpeg': (bytes) => hasAscii(bytes, 0, 'ID3') || isMpegAudioFrame(bytes),
  'audio/aiff': isAiff,
  'audio/x-aiff': isAiff,
  'audio/aac': (bytes) => hasAscii(bytes, 0, 'ID3') || hasAscii(bytes, 0, 'ADIF') || isAdtsFrame(bytes),
  'audio/ogg': isOgg,
  'audio/opus': isOgg,
  'audio/flac': (bytes) => hasAscii(bytes, 0, 'fLaC') || hasAscii(bytes, 0, 'ID3'),
  'audio/mp4': isIsoMedia,
  'video/mp4': isIsoMedia,
  'video/quicktime': isIsoMedia,
  'video/mpeg': (bytes) =>
    bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && (bytes[3] === 0xba || bytes[3] === 0xb3),
  'video/webm': isEbml,
  'video/x-matroska': isEbml,
  'application/pdf': (bytes) => bytes.subarray(0, 1024).includes('%PDF'),
  'application/epub+zip': isZip,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'application/vnd.ms-excel': (bytes) => bytes.subarray(0, 8).equals(
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  ),
};

function assertContentMatchesMimeType(
  bytes: Buffer,
  mimeType: string,
  label: string,
  source: string
): void {
  const normalized = normalizeMimeType(mimeType);
  // The remaining supported types are text formats: reject binary content.
  const matches = Object.hasOwn(CONTENT_SIGNATURES, normalized)
    ? CONTENT_SIGNATURES[normalized](bytes)
    : !bytes.subarray(0, 8192).includes(0);
  if (!matches) {
    throw new Error(`${label} ${source} does not contain ${normalized} data.`);
  }
}

function buildPart(
  kind: AttachmentKind,
  base64: string,
  mimeType: string,
  filename: string | undefined,
  bytes: number
): BuiltAttachment {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  if (kind === 'image') {
    return { part: { type: 'image_url', image_url: { url: dataUrl } }, bytes };
  }
  if (kind === 'file') {
    return { part: { type: 'file', file: { file_data: dataUrl, filename } }, bytes };
  }
  if (kind === 'video') {
    return { part: { type: 'video_url', video_url: { url: dataUrl } }, bytes };
  }

  const format = audioFormatFromMime(mimeType);
  if (!format) {
    throw new Error(`Unsupported audio MIME type "${mimeType}".`);
  }
  return {
    part: {
      type: 'input_audio',
      input_audio: {
        data: base64,
        format,
      },
    },
    bytes,
  };
}

function filenameFromSource(source: string): string | undefined {
  if (source.startsWith('data:')) {
    return undefined;
  }
  try {
    const url = new URL(source);
    const name = basename(url.pathname);
    if (!name) return undefined;
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  } catch {
    return basename(source) || undefined;
  }
}

function parseDataUrl(dataUrl: string, label: string): { mimeType: string; base64: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match) {
    throw new Error(`${label} data URL must contain valid base64 data and an explicit MIME type.`);
  }
  return {
    mimeType: normalizeMimeType(match[1]),
    base64: match[2] || '',
  };
}

function audioFormatFromMime(mimeType: string): string | undefined {
  const normalized = normalizeMimeType(mimeType);
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('aiff')) return 'aiff';
  if (normalized.includes('aac')) return 'aac';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
  return undefined;
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

function assertSupportedMimeType(
  kind: AttachmentKind,
  mimeType: string,
  source: string
): void {
  const normalized = normalizeMimeType(mimeType);
  const supported =
    kind === 'image' ? SUPPORTED_IMAGE_MIME_TYPES :
    kind === 'audio' ? SUPPORTED_AUDIO_MIME_TYPES :
    kind === 'video' ? SUPPORTED_VIDEO_MIME_TYPES :
    SUPPORTED_FILE_MIME_TYPES;
  if (!supported.has(normalized)) {
    throw new Error(
      `Unsupported ${kind} MIME type "${normalized || 'unknown'}" for ${source}.`
    );
  }
}

function decodedBase64Length(base64: string, label: string): number {
  if (!base64 || base64.length % 4 !== 0) {
    throw new Error(`${label} data URL contains invalid base64 data.`);
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function assertSizeWithinLimit(size: number, maxBytes: number, label: string): void {
  if (size === 0) {
    throw new Error(`${label} attachment is empty.`);
  }
  if (size > maxBytes) {
    throw new Error(
      `${label} is too large (${formatBytes(size)}). ` +
      `Maximum allowed size is ${formatBytes(maxBytes)}.`
    );
  }
}
