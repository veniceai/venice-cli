import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';

const MAX_LINES = 2000;
const MAX_BYTES = 1024 * 1024; // 1MB

export const fileReadTool: CodingTool = {
  name: 'file_read',
  description:
    'Read a file from the filesystem. Returns file contents with line numbers. ' +
    'Use offset and limit to read specific sections of large files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or relative path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based, default 0)',
      },
      limit: {
        type: 'number',
        description: `Max number of lines to read (default ${MAX_LINES})`,
      },
    },
    required: ['file_path'],
  },
  isReadOnly: true,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = resolvePath(args.file_path as string, context.cwd);
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : MAX_LINES;

    try {
      const stat = await fs.stat(filePath);

      if (!stat.isFile()) {
        return { output: `Error: "${filePath}" is not a regular file`, error: true };
      }

      if (stat.size > MAX_BYTES) {
        return {
          output: `Error: File is ${(stat.size / 1024 / 1024).toFixed(1)}MB, exceeds 1MB limit. Use offset/limit to read sections.`,
          error: true,
        };
      }

      const raw = await fs.readFile(filePath);

      // Binary detection: check first 8KB for null bytes
      const sample = raw.subarray(0, 8192);
      if (sample.includes(0)) {
        return { output: `Binary file detected: ${filePath} (${stat.size} bytes)`, error: false };
      }

      const content = raw.toString('utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;
      const sliced = allLines.slice(offset, offset + limit);

      const numbered = sliced
        .map((line, i) => `${(offset + i + 1).toString().padStart(6)}\t${line}`)
        .join('\n');

      let result = numbered;
      if (offset + limit < totalLines) {
        result += `\n\n[Showing lines ${offset + 1}-${offset + sliced.length} of ${totalLines} total. Use offset/limit to read more.]`;
      }

      return { output: result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error reading file: ${msg}`, error: true };
    }
  },
};

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}
