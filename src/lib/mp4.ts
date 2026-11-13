/**
 * MP4 signature checks for retrieved and downloaded video
 */

import * as fs from 'fs';

export const MAX_MP4_HEADER_BYTES = 64 * 1024;
const LEADING_PADDING_BOXES = new Set(['free', 'skip', 'wide']);

export type Mp4HeaderCheck = 'valid' | 'invalid' | 'incomplete';

// A valid header is an ftyp box at offset 0, or right after one padding box.
export function checkMp4Header(bytes: Buffer): Mp4HeaderCheck {
  if (bytes.length < 8) return 'incomplete';

  let offset = 0;
  if (LEADING_PADDING_BOXES.has(bytes.toString('latin1', 4, 8))) {
    offset = bytes.readUInt32BE(0);
    if (offset < 8 || offset > MAX_MP4_HEADER_BYTES) return 'invalid';
    if (bytes.length < offset + 8) return 'incomplete';
  }

  const size = bytes.readUInt32BE(offset);
  if (bytes.toString('latin1', offset + 4, offset + 8) !== 'ftyp') return 'invalid';
  if (size < 16 || offset + size > MAX_MP4_HEADER_BYTES) return 'invalid';
  if (bytes.length < offset + size) return 'incomplete';

  const majorBrand = bytes.subarray(offset + 8, offset + 12);
  return majorBrand.every((byte) => byte >= 0x20 && byte <= 0x7e) ? 'valid' : 'invalid';
}

const MAX_BOXES_SCANNED = 10_000;

function findBox(fileDescriptor: number, start: number, end: number, type: string): { contentStart: number; end: number } | undefined {
  const header = Buffer.alloc(16);
  let offset = start;
  for (let scanned = 0; offset + 8 <= end && scanned < MAX_BOXES_SCANNED; scanned++) {
    const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, offset);
    if (bytesRead < 8) return undefined;
    let size = header.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1) {
      if (bytesRead < 16) return undefined;
      size = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return undefined;
    if (header.toString('latin1', 4, 8) === type) return { contentStart: offset + headerSize, end: offset + size };
    offset += size;
  }
  return undefined;
}

/** Seconds from the movie header of an MP4 or MOV file, or undefined when the file has no readable one. */
export function mp4DurationSeconds(filePath: string): number | undefined {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const moov = findBox(fileDescriptor, 0, fs.fstatSync(fileDescriptor).size, 'moov');
    const mvhd = moov && findBox(fileDescriptor, moov.contentStart, moov.end, 'mvhd');
    if (!mvhd) return undefined;
    const content = Buffer.alloc(32);
    const bytesRead = fs.readSync(fileDescriptor, content, 0, content.length, mvhd.contentStart);
    const version = content[0];
    if (version !== 0 && version !== 1) return undefined;
    if (bytesRead < (version === 1 ? 32 : 20)) return undefined;
    const timescale = content.readUInt32BE(version === 1 ? 20 : 12);
    const duration = version === 1 ? Number(content.readBigUInt64BE(24)) : content.readUInt32BE(16);
    return timescale > 0 ? duration / timescale : undefined;
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function fileHasMp4Header(filePath: string): boolean {
  const header = Buffer.alloc(MAX_MP4_HEADER_BYTES);
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
    return checkMp4Header(header.subarray(0, bytesRead)) === 'valid';
  } finally {
    fs.closeSync(fileDescriptor);
  }
}
