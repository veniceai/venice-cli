/**
 * List files tool
 */

import type { Tool } from '../types/index.js';
import { listFiles, normalizePath, getRelativePath } from '../utils/fs-helpers.js';
import { getConfigValue } from '../config/config.js';

export const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files in a directory matching an optional glob pattern. Supports patterns like "*.ts", "src/**/*.js".',
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Directory to search in (defaults to current directory)',
      },
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., "*.ts", "**/*.js")',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum directory depth to search (default: unlimited)',
      },
    },
    required: [],
  },
  execute: async (args: { directory?: string; pattern?: string; max_depth?: number }): Promise<string> => {
    const { directory = '.', pattern, max_depth } = args;

    const normalizedDir = normalizePath(directory);

    try {
      const ignorePatterns = await getConfigValue('ignore_patterns');

      const files = await listFiles(normalizedDir, {
        pattern,
        ignorePatterns,
        maxDepth: max_depth,
      });

      const relativeFiles = files.map(f => getRelativePath(f));

      return JSON.stringify({
        success: true,
        directory,
        pattern: pattern || '*',
        count: files.length,
        files: relativeFiles,
      });
    } catch (error) {
      return `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
