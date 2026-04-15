/**
 * Streaming Diff Display
 *
 * Renders colored unified diffs for file changes.
 */

export function colorDiff(diff: string, chalk: { red: (s: string) => string; green: (s: string) => string; cyan: (s: string) => string; dim: (s: string) => string }): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return chalk.dim(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      return line;
    })
    .join('\n');
}

/**
 * Generate a compact summary of changes for display.
 */
export function changeSummary(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n').length;
  const newLines = newContent.split('\n').length;
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  if (parts.length === 0) parts.push('modified');

  return parts.join(', ');
}
