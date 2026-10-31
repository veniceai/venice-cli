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
