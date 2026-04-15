import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';
import { backupFile } from '../lib/undo.js';

export const fileEditTool: CodingTool = {
  name: 'file_edit',
  description:
    'Edit a file by replacing a specific string with a new string. ' +
    'The old_string must be unique within the file. ' +
    'Provide enough surrounding context in old_string to ensure uniqueness.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or relative path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find and replace (must be unique in the file)',
      },
      new_string: {
        type: 'string',
        description: 'The string to replace old_string with',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = resolvePath(args.file_path as string, context.cwd);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;

    if (oldString === newString) {
      return { output: 'Error: old_string and new_string are identical', error: true };
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Count occurrences
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = content.indexOf(oldString, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + 1;
      }

      if (count === 0) {
        return { output: 'Error: old_string not found in file', error: true };
      }
      if (count > 1) {
        return {
          output: `Error: old_string found ${count} times in file. Provide more surrounding context to make it unique.`,
          error: true,
        };
      }

      const summary = `Edit ${filePath}: replace ${oldString.length} chars with ${newString.length} chars`;
      const approved = await context.approve('file_edit', summary);
      if (!approved) {
        return { output: 'File edit cancelled by user.', error: true };
      }

      // Backup before editing
      await backupFile(filePath, content);

      const updated = content.replace(oldString, newString);
      await fs.writeFile(filePath, updated, 'utf-8');

      // Build a simple diff preview
      const oldLines = oldString.split('\n');
      const newLines = newString.split('\n');
      const diffLines: string[] = [];
      for (const line of oldLines) {
        diffLines.push(`- ${line}`);
      }
      for (const line of newLines) {
        diffLines.push(`+ ${line}`);
      }
      const diff = diffLines.join('\n');

      return { output: `Edited ${filePath}\n\n${diff}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error editing file: ${msg}`, error: true };
    }
  },
};

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}
