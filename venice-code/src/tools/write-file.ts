/**
 * Write file tool
 */

import type { Tool } from '../types/index.js';
import { writeFileContent, normalizePath, backupFile } from '../utils/fs-helpers.js';
import { getConfigValue } from '../config/config.js';
import { BACKUP_DIR } from '../config/defaults.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write (relative or absolute)',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (args: { path: string; content: string }): Promise<string> => {
    const { path, content } = args;

    if (!path) {
      return 'Error: path is required';
    }

    if (content === undefined) {
      return 'Error: content is required';
    }

    const normalizedPath = normalizePath(path);

    try {
      // Create backup if file exists and backups are enabled
      const backupEnabled = await getConfigValue('backup_enabled');
      let backupPath: string | undefined;

      if (backupEnabled) {
        const { fileExists } = await import('../utils/fs-helpers.js');
        if (fileExists(normalizedPath)) {
          backupPath = await backupFile(normalizedPath, BACKUP_DIR);
        }
      }

      await writeFileContent(normalizedPath, content);

      return JSON.stringify({
        success: true,
        path,
        size: content.length,
        backup: backupPath,
      });
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
