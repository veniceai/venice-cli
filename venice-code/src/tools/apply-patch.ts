/**
 * Apply patch tool
 */

import type { Tool } from '../types/index.js';
import { parsePatch } from '../patch/parser.js';
import { applyPatch } from '../patch/applier.js';
import { getConfigValue } from '../config/config.js';

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a unified diff patch to files. The patch should be in standard unified diff format.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'Unified diff patch string to apply',
      },
      dry_run: {
        type: 'boolean',
        description: 'If true, validate patch without applying (default: false)',
      },
    },
    required: ['patch'],
  },
  execute: async (args: { patch: string; dry_run?: boolean }): Promise<string> => {
    const { patch: patchString, dry_run = false } = args;

    if (!patchString) {
      return 'Error: patch is required';
    }

    try {
      // Parse patch
      const patches = parsePatch(patchString);

      if (patches.length === 0) {
        return 'Error: No valid patches found in input';
      }

      // Get backup setting
      const backupEnabled = await getConfigValue('backup_enabled');

      // Apply patches
      const results = [];
      for (const patch of patches) {
        const result = await applyPatch(patch, {
          dryRun: dry_run,
          backup: backupEnabled,
        });
        results.push(result);
      }

      // Check for failures
      const failures = results.filter(r => !r.success);
      if (failures.length > 0) {
        return JSON.stringify({
          success: false,
          results,
          errors: failures.map(f => f.error),
        });
      }

      return JSON.stringify({
        success: true,
        dry_run,
        results,
        files_modified: results.length,
      });
    } catch (error) {
      return `Error applying patch: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
