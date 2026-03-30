/**
 * Patch applier - safely apply patches to files
 */

import type { Patch, PatchResult, PatchHunk } from '../types/index.js';
import { readFileContent, writeFileContent, backupFile, fileExists } from '../utils/fs-helpers.js';
import { BACKUP_DIR } from '../config/defaults.js';
import { validatePatch } from './parser.js';

/**
 * Apply a patch to a file
 */
export async function applyPatch(
  patch: Patch,
  options: {
    dryRun?: boolean;
    backup?: boolean;
  } = {}
): Promise<PatchResult> {
  const { dryRun = false, backup = true } = options;

  // Validate patch
  const validation = validatePatch(patch);
  if (!validation.valid) {
    return {
      success: false,
      file: patch.newPath,
      error: validation.error,
    };
  }

  // Check if file exists
  if (!fileExists(patch.oldPath)) {
    return {
      success: false,
      file: patch.oldPath,
      error: 'File not found',
    };
  }

  try {
    // Read current file content
    const currentContent = await readFileContent(patch.oldPath);
    const currentLines = currentContent.split('\n');

    // Apply hunks
    const newLines = applyHunks(currentLines, patch);
    const newContent = newLines.join('\n');

    // Dry run - just validate
    if (dryRun) {
      return {
        success: true,
        file: patch.newPath,
      };
    }

    // Backup original file
    let backupPath: string | undefined;
    if (backup) {
      backupPath = await backupFile(patch.oldPath, BACKUP_DIR);
    }

    // Write patched content
    await writeFileContent(patch.newPath, newContent);

    return {
      success: true,
      file: patch.newPath,
      backup: backupPath,
    };
  } catch (error) {
    return {
      success: false,
      file: patch.newPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Apply all hunks to file lines
 */
function applyHunks(lines: string[], patch: Patch): string[] {
  const result = [...lines];

  // Apply hunks in reverse order to maintain line numbers
  for (let i = patch.hunks.length - 1; i >= 0; i--) {
    const hunk = patch.hunks[i];
    
    // Find the starting position by matching context
    const position = findHunkPosition(result, hunk);
    if (position === -1) {
      throw new Error(`Cannot find position for hunk starting at line ${hunk.oldStart}`);
    }

    // Apply the hunk
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === 'add' || line.type === 'context') {
        newLines.push(line.content);
      }
      // 'remove' lines are simply not added
    }

    // Calculate how many lines to remove
    const oldLinesCount = hunk.lines.filter(l => l.type !== 'add').length;

    // Replace old lines with new lines
    result.splice(position, oldLinesCount, ...newLines);
  }

  return result;
}

/**
 * Find the position where a hunk should be applied
 */
function findHunkPosition(lines: string[], hunk: PatchHunk): number {
  const contextLines = hunk.lines.filter(l => l.type === 'context');
  
  if (contextLines.length === 0) {
    // No context, use hunk position directly (adjusted for 0-indexing)
    return hunk.oldStart - 1;
  }

  // Try to find matching context
  const firstContext = contextLines[0].content;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === firstContext) {
      // Check if subsequent context lines match
      let matches = true;
      for (let j = 1; j < contextLines.length && matches; j++) {
        if (i + j >= lines.length || lines[i + j] !== contextLines[j].content) {
          matches = false;
        }
      }
      
      if (matches) {
        // Found position, account for any add/remove lines before first context
        let offset = 0;
        for (const line of hunk.lines) {
          if (line.type === 'context') break;
          if (line.type === 'remove') offset++;
        }
        return Math.max(0, i - offset);
      }
    }
  }

  // Fallback to hunk position
  return hunk.oldStart - 1;
}

/**
 * Apply multiple patches
 */
export async function applyPatches(
  patches: Patch[],
  options: {
    dryRun?: boolean;
    backup?: boolean;
  } = {}
): Promise<PatchResult[]> {
  const results: PatchResult[] = [];

  for (const patch of patches) {
    const result = await applyPatch(patch, options);
    results.push(result);
  }

  return results;
}
