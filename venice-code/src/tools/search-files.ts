/**
 * Search in files tool
 */

import type { Tool } from '../types/index.js';
import { searchInFiles, normalizePath } from '../utils/fs-helpers.js';
import { getConfigValue } from '../config/config.js';

export const searchFilesTool: Tool = {
  name: 'search_files',
  description: 'Search for text matching a regex pattern in files. Returns matching lines with file paths and line numbers.',
  parameters: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Directory to search in (defaults to current directory)',
      },
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for',
      },
      file_pattern: {
        type: 'string',
        description: 'Optional glob pattern to filter which files to search',
      },
    },
    required: ['pattern'],
  },
  execute: async (args: { directory?: string; pattern: string; file_pattern?: string }): Promise<string> => {
    const { directory = '.', pattern, file_pattern } = args;

    if (!pattern) {
      return 'Error: pattern is required';
    }

    const normalizedDir = normalizePath(directory);

    try {
      const ignorePatterns = await getConfigValue('ignore_patterns');
      const regex = new RegExp(pattern, 'gi');

      const results = await searchInFiles(normalizedDir, regex, {
        ignorePatterns,
        filePattern: file_pattern,
      });

      return JSON.stringify({
        success: true,
        directory,
        pattern,
        count: results.length,
        matches: results.slice(0, 100), // Limit to first 100 matches
      });
    } catch (error) {
      return `Error searching files: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
