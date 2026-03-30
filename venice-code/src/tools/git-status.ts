/**
 * Git status tool
 */

import type { Tool } from '../types/index.js';
import { getGitStatus, isGitRepository } from '../utils/git.js';

export const gitStatusTool: Tool = {
  name: 'git_status',
  description: 'Get the current git status showing modified, added, and deleted files.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (): Promise<string> => {
    try {
      const isRepo = await isGitRepository();
      
      if (!isRepo) {
        return JSON.stringify({
          success: false,
          error: 'Not a git repository',
        });
      }

      const status = await getGitStatus();

      return JSON.stringify({
        success: true,
        status: status || 'No changes',
      });
    } catch (error) {
      return `Error getting git status: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
