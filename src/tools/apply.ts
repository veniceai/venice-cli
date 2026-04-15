/**
 * Multi-file Apply Tool
 *
 * Stages multiple file changes and applies them atomically.
 * If any file fails, all changes are rolled back.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';
import { backupFile } from '../lib/undo.js';

interface FileChange {
  path: string;
  content: string;
  action: 'create' | 'update';
}

export const applyTool: CodingTool = {
  name: 'apply',
  description:
    'Apply multiple file changes atomically. All changes succeed or all are rolled back. ' +
    'Provide an array of file changes, each with a path and new content.',
  parameters: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'Array of file changes: [{"path": "file.ts", "content": "new content"}, ...]',
      },
      message: {
        type: 'string',
        description: 'Description of what these changes accomplish',
      },
    },
    required: ['changes'],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawChanges = args.changes as Array<{ path: string; content: string }>;
    const message = (args.message as string) || 'Apply multiple file changes';

    if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
      return { output: 'Error: changes must be a non-empty array', error: true };
    }

    // Resolve paths and determine actions
    const changes: FileChange[] = [];
    for (const change of rawChanges) {
      if (!change.path || typeof change.content !== 'string') {
        return { output: `Error: each change must have "path" and "content" fields`, error: true };
      }
      const resolved = path.isAbsolute(change.path) ? change.path : path.resolve(context.cwd, change.path);
      let action: 'create' | 'update' = 'create';
      try {
        await fs.access(resolved);
        action = 'update';
      } catch { /* will create */ }
      changes.push({ path: resolved, content: change.content, action });
    }

    // Build summary
    const summary = `${message}\n` + changes.map((c) => {
      const rel = path.relative(context.cwd, c.path);
      return `  ${c.action === 'create' ? '+' : '~'} ${rel}`;
    }).join('\n');

    const approved = await context.approve('apply', summary);
    if (!approved) {
      return { output: 'Multi-file apply cancelled by user.', error: true };
    }

    // Backup existing files
    const backups = new Map<string, string>();
    for (const change of changes) {
      if (change.action === 'update') {
        try {
          const existing = await fs.readFile(change.path, 'utf-8');
          backups.set(change.path, existing);
          await backupFile(change.path, existing);
        } catch { /* file might not exist despite access check */ }
      }
    }

    // Apply all changes
    const applied: string[] = [];
    try {
      for (const change of changes) {
        const dir = path.dirname(change.path);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(change.path, change.content, 'utf-8');
        applied.push(change.path);
      }

      const result = changes.map((c) => {
        const rel = path.relative(context.cwd, c.path);
        const bytes = Buffer.byteLength(c.content, 'utf-8');
        return `${c.action === 'create' ? 'Created' : 'Updated'} ${rel} (${bytes} bytes)`;
      }).join('\n');

      return { output: `Applied ${changes.length} file changes:\n${result}` };
    } catch (err) {
      // Rollback all applied changes
      for (const appliedPath of applied) {
        const backup = backups.get(appliedPath);
        if (backup !== undefined) {
          try { await fs.writeFile(appliedPath, backup, 'utf-8'); } catch { /* best effort */ }
        } else {
          try { await fs.unlink(appliedPath); } catch { /* best effort */ }
        }
      }

      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error applying changes (all rolled back): ${msg}`, error: true };
    }
  },
};
