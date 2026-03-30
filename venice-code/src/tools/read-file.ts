/**
 * Read file tool
 */

import type { Tool } from '../types/index.js';
import { readFileContent, fileExists, getFileSize, normalizePath } from '../utils/fs-helpers.js';
import { getConfigValue } from '../config/config.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file. Returns the file content as a string.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read (relative or absolute)',
      },
    },
    required: ['path'],
  },
  execute: async (args: { path: string }): Promise<string> => {
    const { path } = args;

    if (!path) {
      return 'Error: path is required';
    }

    const normalizedPath = normalizePath(path);

    if (!fileExists(normalizedPath)) {
      return `Error: File not found: ${path}`;
    }

    try {
      // Check file size
      const maxSize = await getConfigValue('max_file_size');
      const size = await getFileSize(normalizedPath);

      if (size > maxSize) {
        return `Error: File too large (${size} bytes, max ${maxSize} bytes)`;
      }

      const content = await readFileContent(normalizedPath);
      
      return JSON.stringify({
        success: true,
        path,
        content,
        size,
      });
    } catch (error) {
      return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
