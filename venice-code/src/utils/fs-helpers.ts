/**
 * Filesystem helper utilities
 */

import { readFile, writeFile, readdir, stat, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import micromatch from 'micromatch';

/**
 * Read file content
 */
export async function readFileContent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write file content
 */
export async function writeFileContent(path: string, content: string): Promise<void> {
  try {
    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    
    await writeFile(path, content, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if file exists
 */
export function fileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Get file size in bytes
 */
export async function getFileSize(path: string): Promise<number> {
  const stats = await stat(path);
  return stats.size;
}

/**
 * List files in directory recursively
 */
export async function listFiles(
  dir: string,
  options: {
    pattern?: string;
    ignorePatterns?: string[];
    maxDepth?: number;
    currentDepth?: number;
  } = {}
): Promise<string[]> {
  const {
    pattern,
    ignorePatterns = [],
    maxDepth = Infinity,
    currentDepth = 0,
  } = options;

  if (currentDepth >= maxDepth) {
    return [];
  }

  const results: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(process.cwd(), fullPath);

      // Check if path matches ignore patterns
      if (ignorePatterns.length > 0) {
        const shouldIgnore = micromatch.isMatch(relativePath, ignorePatterns, {
          dot: true,
          matchBase: true,
        });
        if (shouldIgnore) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        const subFiles = await listFiles(fullPath, {
          pattern,
          ignorePatterns,
          maxDepth,
          currentDepth: currentDepth + 1,
        });
        results.push(...subFiles);
      } else if (entry.isFile()) {
        // Check if file matches pattern (using matchBase for patterns like "*.ts")
        if (!pattern || micromatch.isMatch(relativePath, pattern, { dot: true, matchBase: true })) {
          results.push(fullPath);
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to list files in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return results;
}

/**
 * Search for text in files
 */
export async function searchInFiles(
  dir: string,
  regex: RegExp,
  options: {
    ignorePatterns?: string[];
    filePattern?: string;
  } = {}
): Promise<Array<{ file: string; line: number; content: string; match: string }>> {
  const { ignorePatterns = [], filePattern } = options;

  const files = await listFiles(dir, {
    pattern: filePattern,
    ignorePatterns,
  });

  const results: Array<{ file: string; line: number; content: string; match: string }> = [];

  for (const file of files) {
    try {
      const content = await readFileContent(file);
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(regex);

        if (match) {
          results.push({
            file: relative(process.cwd(), file),
            line: i + 1,
            content: line.trim(),
            match: match[0],
          });
        }
      }
    } catch {
      // Skip files that can't be read
      continue;
    }
  }

  return results;
}

/**
 * Create backup of file
 */
export async function backupFile(path: string, backupDir: string): Promise<string> {
  if (!existsSync(path)) {
    throw new Error(`File does not exist: ${path}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = relative(process.cwd(), path).replace(/[/\\]/g, '_');
  const backupPath = join(backupDir, `${filename}.${timestamp}.backup`);

  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(path, backupPath);

  return backupPath;
}

/**
 * Normalize path to absolute and validate it's within project directory
 */
export function normalizePath(path: string, allowOutside = false): string {
  const absolutePath = resolve(path);
  
  // Security: Ensure path is within project directory unless explicitly allowed
  if (!allowOutside) {
    const projectRoot = process.cwd();
    const relativePath = relative(projectRoot, absolutePath);
    
    if (relativePath.startsWith('..') || resolve(relativePath) !== absolutePath) {
      throw new Error(`Path outside project directory not allowed: ${path}`);
    }
  }
  
  return absolutePath;
}

/**
 * Get relative path from cwd
 */
export function getRelativePath(path: string): string {
  return relative(process.cwd(), path);
}
