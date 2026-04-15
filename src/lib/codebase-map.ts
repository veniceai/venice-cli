/**
 * Codebase Map Generator
 *
 * Generates a tree structure with file summaries for the system prompt.
 * Helps the model understand the project structure before starting work.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_DEPTH = 4;
const MAX_FILES = 200;
const MAX_MAP_SIZE = 8000; // chars

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'coverage', '.cache', '.parcel-cache', '.turbo', 'target',
  '.svn', '.idea', '.vscode', '.venice',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.kt',
  '.scala', '.sh', '.sql', '.yaml', '.yml', '.toml', '.json',
  '.md', '.html', '.css', '.scss', '.vue', '.svelte',
]);

interface TreeEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeEntry[];
}

export async function generateCodebaseMap(cwd: string): Promise<string> {
  const tree = await buildTree(cwd, 0);
  if (!tree.children || tree.children.length === 0) return '';

  const lines: string[] = ['## Codebase Structure\n```'];
  let fileCount = 0;

  function renderTree(entries: TreeEntry[], prefix: string, depth: number): void {
    if (fileCount >= MAX_FILES) return;

    const sorted = entries.sort((a, b) => {
      // Directories first
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < sorted.length; i++) {
      if (fileCount >= MAX_FILES) break;

      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');

      if (entry.type === 'dir') {
        const count = countFiles(entry);
        lines.push(`${prefix}${connector}${entry.name}/ (${count} files)`);
        if (entry.children && depth < MAX_DEPTH) {
          renderTree(entry.children, childPrefix, depth + 1);
        }
      } else {
        const sizeStr = entry.size ? formatSize(entry.size) : '';
        lines.push(`${prefix}${connector}${entry.name}${sizeStr ? ' ' + sizeStr : ''}`);
        fileCount++;
      }
    }
  }

  renderTree(tree.children, '', 0);
  lines.push('```');

  let result = lines.join('\n');
  if (result.length > MAX_MAP_SIZE) {
    result = result.slice(0, MAX_MAP_SIZE) + '\n... (truncated)\n```';
  }

  return result;
}

async function buildTree(dir: string, depth: number): Promise<TreeEntry> {
  const name = path.basename(dir);
  const entry: TreeEntry = { name, type: 'dir', children: [] };

  if (depth > MAX_DEPTH) return entry;

  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return entry;
  }

  for (const item of items) {
    if (item.name.startsWith('.') && SKIP_DIRS.has(item.name)) continue;
    if (SKIP_DIRS.has(item.name)) continue;

    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      const child = await buildTree(fullPath, depth + 1);
      if (child.children && child.children.length > 0) {
        entry.children!.push(child);
      }
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      // Include code files and common config files
      if (CODE_EXTS.has(ext) || isConfigFile(item.name)) {
        try {
          const stat = await fs.stat(fullPath);
          entry.children!.push({ name: item.name, type: 'file', size: stat.size });
        } catch {
          entry.children!.push({ name: item.name, type: 'file' });
        }
      }
    }
  }

  return entry;
}

function countFiles(entry: TreeEntry): number {
  if (entry.type === 'file') return 1;
  return (entry.children || []).reduce((sum, c) => sum + countFiles(c), 0);
}

function isConfigFile(name: string): boolean {
  const configs = [
    'package.json', 'tsconfig.json', 'Makefile', 'Dockerfile',
    'docker-compose.yml', 'docker-compose.yaml', '.env.example',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'go.sum',
    'Cargo.toml', 'Gemfile', 'requirements.txt', 'pom.xml',
    'build.gradle', 'CMakeLists.txt', 'README.md', 'CHANGELOG.md',
  ];
  return configs.includes(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `(${bytes}B)`;
  if (bytes < 1024 * 1024) return `(${(bytes / 1024).toFixed(0)}KB)`;
  return `(${(bytes / 1024 / 1024).toFixed(1)}MB)`;
}
