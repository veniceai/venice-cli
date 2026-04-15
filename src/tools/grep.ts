import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';

const MAX_FILES = 50;
const MAX_LINES = 250;

export const grepTool: CodingTool = {
  name: 'grep',
  description:
    'Search file contents using a regular expression pattern. ' +
    'Returns matching lines with file paths and line numbers. ' +
    'Uses ripgrep (rg) when available, falls back to Node regex.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in (default: working directory)',
      },
      include: {
        type: 'string',
        description: 'File glob filter (e.g., "*.ts", "*.py")',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = resolvePath((args.path as string) || '.', context.cwd);
    const include = args.include as string | undefined;

    // Try ripgrep first
    const rgResult = await tryRipgrep(pattern, searchPath, include);
    if (rgResult !== null) {
      return { output: rgResult || `No matches for pattern "${pattern}"` };
    }

    // Fallback to Node-native search
    try {
      const result = await nodeGrep(pattern, searchPath, include, context.cwd);
      return { output: result || `No matches for pattern "${pattern}"` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error searching: ${msg}`, error: true };
    }
  },
};

function tryRipgrep(pattern: string, searchPath: string, include?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rgArgs = [
      '--no-heading',
      '--line-number',
      '--color', 'never',
      '--max-count', '50',
      '--max-filesize', '1M',
    ];

    if (include) {
      rgArgs.push('--glob', include);
    }

    rgArgs.push('--', pattern, searchPath);

    execFile('rg', rgArgs, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        // rg not found or other error -- signal fallback
        if (stderr?.includes('not found') || (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve(null);
          return;
        }
        // rg ran but found nothing (exit code 1)
        if ((error as { code?: number }).code === 1) {
          resolve('');
          return;
        }
        resolve(null);
        return;
      }

      const lines = stdout.split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) {
        resolve(
          lines.slice(0, MAX_LINES).join('\n') +
          `\n\n[${lines.length - MAX_LINES} more matches truncated]`
        );
      } else {
        resolve(lines.join('\n'));
      }
    });
  });
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', 'dist', 'build', '.next',
  '__pycache__', '.venv', 'coverage', '.mypy_cache',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2',
  '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz',
  '.pdf', '.exe', '.dll', '.so', '.dylib', '.bin',
]);

async function nodeGrep(
  pattern: string,
  searchPath: string,
  include: string | undefined,
  cwd: string
): Promise<string> {
  const regex = new RegExp(pattern, 'g');
  const includeRegex = include ? globToRegex(include) : null;
  const results: string[] = [];
  let fileCount = 0;
  let lineCount = 0;

  async function search(dir: string): Promise<void> {
    if (fileCount >= MAX_FILES || lineCount >= MAX_LINES) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount >= MAX_FILES || lineCount >= MAX_LINES) return;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await search(full);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      if (includeRegex && !includeRegex.test(entry.name)) continue;

      try {
        const stat = await fs.stat(full);
        if (stat.size > 1024 * 1024) continue; // Skip files > 1MB

        const content = await fs.readFile(full, 'utf-8');
        const lines = content.split('\n');
        const relPath = path.relative(cwd, full);
        let fileHasMatch = false;

        for (let i = 0; i < lines.length && lineCount < MAX_LINES; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            if (!fileHasMatch) {
              fileCount++;
              fileHasMatch = true;
            }
            results.push(`${relPath}:${i + 1}:${lines[i]}`);
            lineCount++;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // If searchPath is a file, search just that file
  const stat = await fs.stat(searchPath);
  if (stat.isFile()) {
    const content = await fs.readFile(searchPath, 'utf-8');
    const lines = content.split('\n');
    const relPath = path.relative(cwd, searchPath);
    for (let i = 0; i < lines.length && lineCount < MAX_LINES; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        results.push(`${relPath}:${i + 1}:${lines[i]}`);
        lineCount++;
      }
    }
  } else {
    await search(searchPath);
  }

  let output = results.join('\n');
  if (fileCount >= MAX_FILES) {
    output += `\n\n[Search stopped after ${MAX_FILES} matching files]`;
  }
  if (lineCount >= MAX_LINES) {
    output += `\n\n[Search stopped after ${MAX_LINES} matching lines]`;
  }
  return output;
}

function globToRegex(pattern: string): RegExp {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`);
}

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}
