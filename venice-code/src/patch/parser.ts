/**
 * Unified diff parser
 */

import type { Patch, PatchHunk } from '../types/index.js';

/**
 * Parse a unified diff string into structured patches
 */
export function parsePatch(diffString: string): Patch[] {
  const patches: Patch[] = [];
  const lines = diffString.split('\n');
  
  let currentPatch: Patch | null = null;
  let currentHunk: PatchHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: --- a/file or --- file
    if (line.startsWith('--- ')) {
      if (currentPatch && currentHunk) {
        currentPatch.hunks.push(currentHunk);
      }
      if (currentPatch) {
        patches.push(currentPatch);
      }

      const oldPath = line.slice(4).replace(/^a\//, '');
      currentPatch = {
        oldPath,
        newPath: oldPath, // Will be updated by +++ line
        hunks: [],
      };
      currentHunk = null;
    }
    // File header: +++ b/file or +++ file
    else if (line.startsWith('+++ ') && currentPatch) {
      const newPath = line.slice(4).replace(/^b\//, '');
      currentPatch.newPath = newPath;
    }
    // Hunk header: @@ -1,5 +1,6 @@
    else if (line.startsWith('@@')) {
      if (currentPatch && currentHunk) {
        currentPatch.hunks.push(currentHunk);
      }

      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        oldLineNo = parseInt(match[1], 10);
        const oldLines = match[2] ? parseInt(match[2], 10) : 1;
        newLineNo = parseInt(match[3], 10);
        const newLines = match[4] ? parseInt(match[4], 10) : 1;

        currentHunk = {
          oldStart: oldLineNo,
          oldLines,
          newStart: newLineNo,
          newLines,
          lines: [],
        };
      }
    }
    // Context line
    else if (line.startsWith(' ') && currentHunk) {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNo: oldLineNo++,
        newLineNo: newLineNo++,
      });
    }
    // Removed line
    else if (line.startsWith('-') && currentHunk) {
      currentHunk.lines.push({
        type: 'remove',
        content: line.slice(1),
        oldLineNo: oldLineNo++,
      });
    }
    // Added line
    else if (line.startsWith('+') && currentHunk) {
      currentHunk.lines.push({
        type: 'add',
        content: line.slice(1),
        newLineNo: newLineNo++,
      });
    }
  }

  // Push final hunk and patch
  if (currentPatch && currentHunk) {
    currentPatch.hunks.push(currentHunk);
  }
  if (currentPatch) {
    patches.push(currentPatch);
  }

  return patches;
}

/**
 * Validate that a patch is well-formed
 */
export function validatePatch(patch: Patch): { valid: boolean; error?: string } {
  if (!patch.oldPath || !patch.newPath) {
    return { valid: false, error: 'Patch missing file paths' };
  }

  if (patch.hunks.length === 0) {
    return { valid: false, error: 'Patch has no hunks' };
  }

  for (const hunk of patch.hunks) {
    if (hunk.lines.length === 0) {
      return { valid: false, error: 'Hunk has no lines' };
    }

    // Count line types
    const removes = hunk.lines.filter(l => l.type === 'remove').length;
    const adds = hunk.lines.filter(l => l.type === 'add').length;
    const contexts = hunk.lines.filter(l => l.type === 'context').length;

    // Validate hunk line counts
    if (removes + contexts > hunk.oldLines + 3) { // Allow some tolerance
      return { valid: false, error: `Hunk old line count mismatch` };
    }

    if (adds + contexts > hunk.newLines + 3) { // Allow some tolerance
      return { valid: false, error: `Hunk new line count mismatch` };
    }
  }

  return { valid: true };
}
