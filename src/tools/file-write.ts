import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';
import { backupFile } from '../lib/undo.js';

export const fileWriteTool: CodingTool = {
  name: 'file_write',
  description:
    'Write content to a file. Creates the file and parent directories if they do not exist. ' +
    'Overwrites existing file content entirely. Shows a diff for existing files before writing.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or relative path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = resolvePath(args.file_path as string, context.cwd);
    const content = args.content as string;

    let existing: string | null = null;
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch {
      // File does not exist
    }

    // Build approval summary with diff for existing files
    let summary: string;
    if (existing !== null) {
      const diff = unifiedDiff(existing, content, filePath);
      summary = `Overwrite ${filePath}\n${diff}`;
    } else {
      summary = `Create ${filePath} (${content.length} chars)`;
    }

    const approved = await context.approve('file_write', summary);
    if (!approved) {
      return { output: 'File write cancelled by user.', error: true };
    }

    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Backup existing file before overwriting
      if (existing !== null) {
        await backupFile(filePath, existing);
      }

      await fs.writeFile(filePath, content, 'utf-8');
      const bytes = Buffer.byteLength(content, 'utf-8');
      const action = existing !== null ? 'Updated' : 'Created';

      let result = `${action} ${filePath} (${bytes} bytes)`;
      if (existing !== null) {
        const diff = unifiedDiff(existing, content, filePath);
        result += `\n\n${diff}`;
      }
      return { output: result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error writing file: ${msg}`, error: true };
    }
  },
};

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}

function unifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diffLines: string[] = [`--- a/${path.basename(filePath)}`, `+++ b/${path.basename(filePath)}`];

  // Simple line-by-line diff (not a full LCS, but good enough for display)
  const maxLen = Math.max(oldLines.length, newLines.length);
  let contextStart = -1;
  const hunks: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      if (contextStart >= 0 && i - contextStart < 3) {
        hunks.push(` ${oldLine}`);
      } else if (contextStart >= 0) {
        contextStart = -1;
      }
    } else {
      if (contextStart < 0) {
        contextStart = i;
        // Add up to 3 lines of leading context
        for (let j = Math.max(0, i - 3); j < i; j++) {
          if (j < oldLines.length) hunks.push(` ${oldLines[j]}`);
        }
      }
      if (oldLine !== undefined) hunks.push(`-${oldLine}`);
      if (newLine !== undefined) hunks.push(`+${newLine}`);
    }
  }

  if (hunks.length === 0) return '(no changes)';
  if (hunks.length > 60) {
    return diffLines.join('\n') + '\n' + hunks.slice(0, 60).join('\n') + `\n... (${hunks.length - 60} more lines)`;
  }
  return diffLines.join('\n') + '\n' + hunks.join('\n');
}
