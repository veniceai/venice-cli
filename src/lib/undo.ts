/**
 * Undo/Rollback System
 *
 * Maintains in-memory file snapshots and on-disk backups for rollback.
 * The model can call the undo tool to revert file changes.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface FileSnapshot {
  filePath: string;
  content: string;
  timestamp: number;
}

// Session-scoped stack of file snapshots (most recent last)
const undoStack: FileSnapshot[] = [];
const MAX_SNAPSHOTS = 50;

export async function backupFile(filePath: string, content: string): Promise<void> {
  undoStack.push({
    filePath: path.resolve(filePath),
    content,
    timestamp: Date.now(),
  });

  // Cap the stack
  if (undoStack.length > MAX_SNAPSHOTS) {
    undoStack.shift();
  }
}

export async function undoLastEdit(filePath?: string): Promise<{ filePath: string; restored: boolean; message: string }> {
  if (undoStack.length === 0) {
    return { filePath: '', restored: false, message: 'Nothing to undo. No file changes recorded this session.' };
  }

  let snapshot: FileSnapshot | undefined;

  if (filePath) {
    const resolved = path.resolve(filePath);
    // Find the most recent snapshot for this file
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].filePath === resolved) {
        snapshot = undoStack.splice(i, 1)[0];
        break;
      }
    }
    if (!snapshot) {
      return { filePath: resolved, restored: false, message: `No undo history for ${filePath}` };
    }
  } else {
    // Undo the most recent change to any file
    snapshot = undoStack.pop()!;
  }

  try {
    await fs.writeFile(snapshot.filePath, snapshot.content, 'utf-8');
    return {
      filePath: snapshot.filePath,
      restored: true,
      message: `Restored ${snapshot.filePath} to state from ${new Date(snapshot.timestamp).toLocaleTimeString()}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { filePath: snapshot.filePath, restored: false, message: `Failed to restore: ${msg}` };
  }
}

export function getUndoHistory(): { filePath: string; timestamp: number }[] {
  return undoStack.map((s) => ({ filePath: s.filePath, timestamp: s.timestamp }));
}

export function clearUndoHistory(): void {
  undoStack.length = 0;
}
