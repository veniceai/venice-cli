/**
 * Smart Context Retrieval
 *
 * Analyzes the user prompt and project structure to automatically include
 * relevant files in the conversation context before the model starts working.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_CONTEXT_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024; // 50KB per file
const MAX_TOTAL_CONTEXT = 200 * 1024; // 200KB total

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'coverage', '.mypy_cache', '.tox', '.cache',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
  '.kt', '.scala', '.sh', '.bash', '.yaml', '.yml', '.toml',
  '.json', '.md', '.sql', '.html', '.css', '.scss',
]);

interface RetrievedFile {
  path: string;
  content: string;
  reason: string;
}

/**
 * Given a user prompt, find relevant files to include in context.
 */
export async function retrieveContext(prompt: string, cwd: string): Promise<string> {
  const files: RetrievedFile[] = [];
  let totalSize = 0;

  // Strategy 1: Extract explicit file references from the prompt
  const fileRefs = extractFileReferences(prompt);
  for (const ref of fileRefs) {
    if (files.length >= MAX_CONTEXT_FILES) break;
    const resolved = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
    const content = await safeReadFile(resolved);
    if (content && content.length <= MAX_FILE_SIZE && totalSize + content.length <= MAX_TOTAL_CONTEXT) {
      files.push({ path: resolved, content, reason: 'mentioned in prompt' });
      totalSize += content.length;
    }
  }

  // Strategy 2: Find files matching keywords from the prompt
  const keywords = extractKeywords(prompt);
  if (keywords.length > 0 && files.length < MAX_CONTEXT_FILES) {
    const matches = await findFilesByKeywords(keywords, cwd);
    for (const match of matches) {
      if (files.length >= MAX_CONTEXT_FILES) break;
      if (files.some((f) => f.path === match.path)) continue;
      if (totalSize + match.content.length > MAX_TOTAL_CONTEXT) continue;
      files.push(match);
      totalSize += match.content.length;
    }
  }

  // Strategy 3: Include key project files if not already included
  const projectFiles = ['README.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Makefile'];
  for (const pf of projectFiles) {
    if (files.length >= MAX_CONTEXT_FILES) break;
    const resolved = path.resolve(cwd, pf);
    if (files.some((f) => f.path === resolved)) continue;
    const content = await safeReadFile(resolved);
    if (content && content.length <= MAX_FILE_SIZE && totalSize + content.length <= MAX_TOTAL_CONTEXT) {
      files.push({ path: resolved, content, reason: 'project metadata' });
      totalSize += content.length;
    }
  }

  if (files.length === 0) return '';

  const sections = files.map((f) => {
    const relPath = path.relative(cwd, f.path);
    return `### ${relPath} (${f.reason})\n\`\`\`\n${f.content}\n\`\`\``;
  });

  return `## Auto-retrieved Context (${files.length} files)\n\n${sections.join('\n\n')}`;
}

function extractFileReferences(prompt: string): string[] {
  const refs: string[] = [];

  // Match file paths with extensions
  const pathPattern = /(?:^|\s)((?:[\w./\\-]+\/)?[\w.-]+\.\w{1,10})(?:\s|$|[,;:])/g;
  let match;
  while ((match = pathPattern.exec(prompt)) !== null) {
    const ref = match[1];
    if (ref.includes('.') && !ref.startsWith('http') && !ref.startsWith('www.')) {
      refs.push(ref);
    }
  }

  // Match quoted paths
  const quotedPattern = /["'`]((?:[\w./\\-]+\/)?[\w.-]+\.\w{1,10})["'`]/g;
  while ((match = quotedPattern.exec(prompt)) !== null) {
    if (!refs.includes(match[1])) refs.push(match[1]);
  }

  return refs;
}

function extractKeywords(prompt: string): string[] {
  // Extract meaningful identifiers: function names, class names, variable names
  const words = prompt.split(/[\s,;:!?()[\]{}'"]+/);
  return words
    .filter((w) => w.length >= 3 && w.length <= 50)
    .filter((w) => /^[a-zA-Z_][\w]*$/.test(w))
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 5);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'been',
  'what', 'where', 'when', 'how', 'why', 'all', 'can', 'you', 'should',
  'would', 'could', 'will', 'use', 'make', 'create', 'add', 'remove',
  'fix', 'update', 'change', 'modify', 'delete', 'read', 'write',
  'file', 'code', 'function', 'class', 'method', 'variable', 'import',
  'export', 'return', 'error', 'test', 'run', 'build', 'help', 'find',
  'show', 'list', 'get', 'set', 'new', 'old', 'each', 'every',
]);

async function findFilesByKeywords(keywords: string[], cwd: string): Promise<RetrievedFile[]> {
  const results: RetrievedFile[] = [];
  const visited = new Set<string>();

  async function search(dir: string, depth: number): Promise<void> {
    if (depth > 5 || results.length >= MAX_CONTEXT_FILES) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= MAX_CONTEXT_FILES) return;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await search(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (visited.has(full)) continue;
      visited.add(full);

      // Check if filename contains any keyword
      const nameMatch = keywords.find((kw) =>
        entry.name.toLowerCase().includes(kw.toLowerCase())
      );
      if (nameMatch) {
        const content = await safeReadFile(full);
        if (content && content.length <= MAX_FILE_SIZE) {
          results.push({ path: full, content, reason: `filename matches "${nameMatch}"` });
          continue;
        }
      }

      // Check if file content contains keywords (only for small files)
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(full, 'utf-8');
        const contentLower = content.toLowerCase();
        const match = keywords.find((kw) => contentLower.includes(kw.toLowerCase()));
        if (match) {
          results.push({ path: full, content, reason: `contains "${match}"` });
        }
      } catch { /* skip */ }
    }
  }

  await search(cwd, 0);
  return results;
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
    const content = await fs.readFile(filePath, 'utf-8');
    // Check for binary
    if (content.includes('\0')) return null;
    return content;
  } catch {
    return null;
  }
}
