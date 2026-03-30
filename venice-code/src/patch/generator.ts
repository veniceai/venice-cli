/**
 * Diff generator using longest common subsequence (LCS)
 */

import type { Patch, PatchHunk, PatchLine } from '../types/index.js';

/**
 * Generate a unified diff between two strings
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  oldPath: string,
  newPath: string = oldPath,
  context: number = 3
): Patch {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const hunks = generateHunks(oldLines, newLines, context);

  return {
    oldPath,
    newPath,
    hunks,
  };
}

/**
 * Generate hunks using LCS algorithm
 */
function generateHunks(
  oldLines: string[],
  newLines: string[],
  context: number
): PatchHunk[] {
  const changes = computeChanges(oldLines, newLines);
  const hunks: PatchHunk[] = [];

  let i = 0;
  while (i < changes.length) {
    const hunkStart = Math.max(0, changes[i].oldLine - context);
    let hunkEnd = changes[i].oldLine;

    // Extend hunk to include nearby changes
    while (
      i < changes.length - 1 &&
      changes[i + 1].oldLine - changes[i].oldLine <= context * 2
    ) {
      i++;
      hunkEnd = changes[i].oldLine;
    }
    hunkEnd = Math.min(oldLines.length, hunkEnd + context);

    // Build hunk
    const hunk = buildHunk(oldLines, newLines, changes, hunkStart, hunkEnd);
    if (hunk) {
      hunks.push(hunk);
    }

    i++;
  }

  return hunks;
}

/**
 * Build a single hunk
 */
function buildHunk(
  oldLines: string[],
  _newLines: string[],
  changes: Change[],
  start: number,
  end: number
): PatchHunk | null {
  const lines: PatchLine[] = [];
  let oldLine = start;
  let newLine = start;

  const hunkChanges = changes.filter(c => c.oldLine >= start && c.oldLine <= end);

  // Calculate the offset for new lines based on changes before this hunk
  const changesBefore = changes.filter(c => c.oldLine < start);
  let newLineOffset = 0;
  for (const change of changesBefore) {
    if (change.type === 'add') {
      newLineOffset++;
    } else if (change.type === 'remove') {
      newLineOffset--;
    }
  }

  for (let i = start; i <= end; i++) {
    const change = hunkChanges.find(c => c.oldLine === i);

    if (change) {
      if (change.type === 'remove') {
        lines.push({
          type: 'remove',
          content: oldLines[i],
          oldLineNo: oldLine,
        });
        oldLine++;
      } else if (change.type === 'add') {
        lines.push({
          type: 'add',
          content: change.newContent!,
          newLineNo: newLine,
        });
        newLine++;
      }
    } else if (i < oldLines.length) {
      lines.push({
        type: 'context',
        content: oldLines[i],
        oldLineNo: oldLine,
        newLineNo: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  if (lines.length === 0) {
    return null;
  }

  const oldCount = lines.filter(l => l.type !== 'add').length;
  const newCount = lines.filter(l => l.type !== 'remove').length;

  return {
    oldStart: start + 1,
    oldLines: oldCount,
    newStart: start + 1 + newLineOffset,
    newLines: newCount,
    lines,
  };
}

/**
 * Compute changes between two arrays of lines
 */
interface Change {
  type: 'add' | 'remove';
  oldLine: number;
  newLine: number;
  newContent?: string;
}

function computeChanges(oldLines: string[], newLines: string[]): Change[] {
  const lcs = longestCommonSubsequence(oldLines, newLines);
  const changes: Change[] = [];

  let oldIndex = 0;
  let newIndex = 0;

  for (const match of lcs) {
    // Add removes before this match
    while (oldIndex < match.oldIndex) {
      changes.push({
        type: 'remove',
        oldLine: oldIndex,
        newLine: newIndex,
      });
      oldIndex++;
    }

    // Add additions before this match
    while (newIndex < match.newIndex) {
      changes.push({
        type: 'add',
        oldLine: oldIndex,
        newLine: newIndex,
        newContent: newLines[newIndex],
      });
      newIndex++;
    }

    oldIndex++;
    newIndex++;
  }

  // Add remaining removes
  while (oldIndex < oldLines.length) {
    changes.push({
      type: 'remove',
      oldLine: oldIndex,
      newLine: newIndex,
    });
    oldIndex++;
  }

  // Add remaining additions
  while (newIndex < newLines.length) {
    changes.push({
      type: 'add',
      oldLine: oldIndex,
      newLine: newIndex,
      newContent: newLines[newIndex],
    });
    newIndex++;
  }

  return changes;
}

/**
 * Longest common subsequence algorithm
 */
interface LCSMatch {
  oldIndex: number;
  newIndex: number;
}

function longestCommonSubsequence(
  oldLines: string[],
  newLines: string[]
): LCSMatch[] {
  const m = oldLines.length;
  const n = newLines.length;
  const matrix: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array(n + 1).fill(0));

  // Build LCS matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
      }
    }
  }

  // Backtrack to find matches
  const matches: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.unshift({ oldIndex: i - 1, newIndex: j - 1 });
      i--;
      j--;
    } else if (matrix[i - 1][j] > matrix[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

/**
 * Format patch as unified diff string
 */
export function formatPatch(patch: Patch): string {
  const lines: string[] = [];

  lines.push(`--- ${patch.oldPath}`);
  lines.push(`+++ ${patch.newPath}`);

  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    );

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        lines.push(` ${line.content}`);
      } else if (line.type === 'add') {
        lines.push(`+${line.content}`);
      } else if (line.type === 'remove') {
        lines.push(`-${line.content}`);
      }
    }
  }

  return lines.join('\n');
}
