/**
 * File content chunking for embeddings
 */

import type { FileChunk } from '../types/index.js';

const DEFAULT_CHUNK_SIZE = 500; // lines per chunk
const DEFAULT_OVERLAP = 50; // overlap between chunks

/**
 * Chunk a file's content for embedding
 */
export function chunkFile(
  filePath: string,
  content: string,
  options: {
    chunkSize?: number;
    overlap?: number;
  } = {}
): FileChunk[] {
  const { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP } = options;

  const lines = content.split('\n');
  const chunks: FileChunk[] = [];

  let startLine = 0;
  let chunkIndex = 0;

  while (startLine < lines.length) {
    const endLine = Math.min(startLine + chunkSize, lines.length);
    const chunkLines = lines.slice(startLine, endLine);
    const chunkContent = chunkLines.join('\n');

    chunks.push({
      id: `${filePath}:${chunkIndex}`,
      file: filePath,
      content: chunkContent,
      start_line: startLine + 1, // 1-indexed
      end_line: endLine,
    });

    chunkIndex++;
    startLine = endLine - overlap;

    // Prevent infinite loop for small files
    if (startLine >= lines.length || (endLine === lines.length && startLine + overlap >= lines.length)) {
      break;
    }
  }

  return chunks;
}

/**
 * Determine optimal chunk size based on file size
 */
export function getOptimalChunkSize(lineCount: number): number {
  if (lineCount < 100) return lineCount; // Single chunk for small files
  if (lineCount < 500) return 200;
  if (lineCount < 1000) return 300;
  return DEFAULT_CHUNK_SIZE;
}
