import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';
import { undoLastEdit, getUndoHistory } from '../lib/undo.js';
import * as path from 'path';

export const undoTool: CodingTool = {
  name: 'undo',
  description:
    'Undo the most recent file edit or write. Restores the file to its state before ' +
    'the last modification. Optionally specify a file path to undo changes to a specific file. ' +
    'Use action "list" to see all available undo history.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '"undo" to revert (default), "list" to show undo history',
      },
      file_path: {
        type: 'string',
        description: 'Optional: specific file to undo. If omitted, undoes the most recent change.',
      },
    },
    required: [],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = (args.action as string) || 'undo';
    const filePath = args.file_path as string | undefined;

    if (action === 'list') {
      const history = getUndoHistory();
      if (history.length === 0) {
        return { output: 'No undo history available.' };
      }
      const lines = history.map((h, i) => {
        const relPath = path.relative(context.cwd, h.filePath);
        const time = new Date(h.timestamp).toLocaleTimeString();
        return `${i + 1}. ${relPath} (${time})`;
      });
      return { output: `Undo history (${history.length} entries):\n${lines.join('\n')}` };
    }

    const resolved = filePath ? (path.isAbsolute(filePath) ? filePath : path.resolve(context.cwd, filePath)) : undefined;

    const summary = resolved ? `Undo changes to ${resolved}` : 'Undo most recent file change';
    const approved = await context.approve('undo', summary);
    if (!approved) {
      return { output: 'Undo cancelled by user.', error: true };
    }

    const result = await undoLastEdit(resolved);
    return { output: result.message, error: !result.restored };
  },
};
