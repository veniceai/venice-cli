/**
 * Git utilities
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Get git status
 */
export async function getGitStatus(): Promise<string> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: process.cwd(),
    });
    return stdout;
  } catch (error) {
    throw new Error(`Failed to get git status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get git diff
 */
export async function getGitDiff(options: {
  staged?: boolean;
  files?: string[];
} = {}): Promise<string> {
  const { staged = false, files = [] } = options;

  try {
    const args = ['diff'];
    
    if (staged) {
      args.push('--staged');
    }
    
    if (files.length > 0) {
      args.push('--', ...files);
    }

    // Use execFile instead of exec to avoid shell injection
    const { stdout } = await execFileAsync('git', args, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 10, // 10MB
    });
    
    return stdout;
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if directory is a git repository
 */
export async function isGitRepository(): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', {
      cwd: process.cwd(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git branch
 */
export async function getCurrentBranch(): Promise<string> {
  try {
    const { stdout } = await execAsync('git branch --show-current', {
      cwd: process.cwd(),
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current branch: ${error instanceof Error ? error.message : String(error)}`);
  }
}
