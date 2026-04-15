/**
 * Permission System for Codex Tool Execution
 *
 * Three modes:
 * - prompt (default): auto-approve read-only tools, prompt for writes/exec
 * - auto: approve everything
 * - read-only: auto-approve reads, deny writes
 */

import * as readline from 'readline';
import { getChalk } from './output.js';
import type { PermissionMode } from '../types/index.js';

export function createApprover(mode: PermissionMode): (toolName: string, summary: string) => Promise<boolean> {
  const alwaysAllowed = new Set<string>();

  return async (toolName: string, summary: string): Promise<boolean> => {
    if (mode === 'auto') return true;
    if (mode === 'read-only') return false;

    // prompt mode
    if (alwaysAllowed.has(toolName)) return true;

    const c = getChalk();
    const answer = await askUser(
      `${c.yellow('Tool:')} ${c.cyan(toolName)}\n` +
      `${c.yellow('Action:')} ${summary}\n` +
      `${c.dim('[y]es / [a]lways / [n]o')} `
    );

    const normalized = answer.trim().toLowerCase();
    if (normalized === 'a' || normalized === 'always') {
      alwaysAllowed.add(toolName);
      return true;
    }
    return normalized === 'y' || normalized === 'yes';
  };
}

function askUser(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve('y');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
