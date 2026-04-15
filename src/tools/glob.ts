import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';

const MAX_RESULTS = 200;

export const globTool: CodingTool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Supports *, **, and ? wildcards. ' +
    'Returns matching file paths sorted alphabetically, limited to 200 results.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g., "src/**/*.ts", "*.json", "lib/**/test.*")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: working directory)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = resolvePath((args.path as string) || '.', context.cwd);

    try {
      const entries = await walkDir(searchPath);
      const regex = globToRegex(pattern);
      const matches = entries
        .filter((entry) => {
          const rel = path.relative(searchPath, entry);
          return regex.test(rel);
        })
        .slice(0, MAX_RESULTS)
        .sort();

      if (matches.length === 0) {
        return { output: `No files matching "${pattern}" in ${searchPath}` };
      }

      const relPaths = matches.map((m) => path.relative(context.cwd, m));
      let output = relPaths.join('\n');
      if (entries.length > MAX_RESULTS) {
        output += `\n\n[Results capped at ${MAX_RESULTS}. Narrow your pattern for more specific results.]`;
      }
      return { output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Error searching files: ${msg}`, error: true };
    }
  },
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache', 'coverage',
]);

async function walkDir(dir: string, maxDepth = 20): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length > 10000) return;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }

  await walk(dir, 0);
  return results;
}

function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.+/)?';
        i += 3;
      } else {
        regex += '.*';
        i += 2;
      }
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end !== -1) {
        const alternatives = pattern.slice(i + 1, end).split(',').map(escapeRegex).join('|');
        regex += `(?:${alternatives})`;
        i = end + 1;
      } else {
        regex += escapeRegex(c);
        i++;
      }
    } else {
      regex += escapeRegex(c);
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}
