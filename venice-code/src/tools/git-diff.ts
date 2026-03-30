/**
 * Git diff tool
 */

import type { Tool } from '../types/index.js';
import { getGitDiff, isGitRepository } from '../utils/git.js';

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description: 'Get git diff showing changes in files. Can show unstaged or staged changes.',
  parameters: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged changes instead of unstaged (default: false)',
      },
      files: {
        type: 'array',
        description: 'Optional list of specific files to diff',
      },
    },
    required: [],
  },
  execute: async (args: { staged?: boolean; files?: string[] }): Promise<string> => {
    const { staged = false, files = [] } = args;

    try {
      const isRepo = await isGitRepository();
      
      if (!isRepo) {
        return JSON.stringify({
          success: false,
          error: 'Not a git repository',
        });
      }

      const diff = await getGitDiff({ staged, files });

      return JSON.stringify({
        success: true,
        staged,
        diff: diff || 'No changes',
      });
    } catch (error) {
      return `Error getting git diff: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
