/**
 * Project scanner for indexing
 */

import { listFiles, readFileContent } from '../utils/fs-helpers.js';
import { chunkFile, getOptimalChunkSize } from './chunker.js';
import micromatch from 'micromatch';
import type { FileChunk } from '../types/index.js';

/**
 * Scan project directory and create chunks for embedding
 */
export async function scanProject(
  directory: string,
  options: {
    ignorePatterns?: string[];
    filePatterns?: string[];
    maxFileSize?: number;
  } = {}
): Promise<FileChunk[]> {
  const {
    ignorePatterns = [],
    filePatterns = ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.java', '**/*.go', '**/*.rs', '**/*.c', '**/*.cpp', '**/*.h'],
    maxFileSize = 1048576, // 1MB
  } = options;

  const allChunks: FileChunk[] = [];

  // Get all matching files
  const files = await listFiles(directory, {
    ignorePatterns,
  });

  // Filter by file patterns using micromatch
  const matchedFiles = files.filter(file => {
    return filePatterns.some(pattern => {
      return micromatch.isMatch(file, pattern, { dot: true, matchBase: true });
    });
  });

  for (const file of matchedFiles) {
    try {
      const content = await readFileContent(file);

      // Skip if file is too large
      if (content.length > maxFileSize) {
        continue;
      }

      // Chunk the file
      const lines = content.split('\n');
      const chunkSize = getOptimalChunkSize(lines.length);
      const chunks = chunkFile(file, content, { chunkSize });

      allChunks.push(...chunks);
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return allChunks;
}

/**
 * Get project statistics
 */
export async function getProjectStats(
  directory: string,
  ignorePatterns: string[] = []
): Promise<{
  totalFiles: number;
  totalLines: number;
  fileTypes: Record<string, number>;
}> {
  const files = await listFiles(directory, { ignorePatterns });

  let totalLines = 0;
  const fileTypes: Record<string, number> = {};

  for (const file of files) {
    try {
      const content = await readFileContent(file);
      const lines = content.split('\n').length;
      totalLines += lines;

      // Count file type
      const ext = file.split('.').pop() || 'unknown';
      fileTypes[ext] = (fileTypes[ext] || 0) + 1;
    } catch {
      continue;
    }
  }

  return {
    totalFiles: files.length,
    totalLines,
    fileTypes,
  };
}
