/**
 * Run shell command tool
 */

import type { Tool } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getConfigValue } from '../config/config.js';

const execAsync = promisify(exec);

// Allowlist of safe command prefixes
const SAFE_COMMANDS = ['git ', 'npm ', 'node ', 'tsc', 'eslint', 'jest', 'test', 'build', 'yarn ', 'pnpm '];

export const runShellTool: Tool = {
  name: 'run_shell',
  description: 'Execute a shell command and return its output. Use for running tests, builds, git commands, etc. Command runs in the current working directory. Only safe commands are allowed (git, npm, node, test runners, build tools).',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['command'],
  },
  execute: async (args: { command: string; timeout?: number }): Promise<string> => {
    const { command, timeout = 30000 } = args;

    if (!command) {
      return 'Error: command is required';
    }

    // Security: Check if command is safe
    const autoApprove = await getConfigValue('auto_approve');
    const isSafe = SAFE_COMMANDS.some(prefix => command.trim().startsWith(prefix));
    
    if (!isSafe && !autoApprove) {
      return `Error: Command "${command}" is not in the safe command list. Set auto_approve: true in config to allow all commands.`;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        cwd: process.cwd(),
      });

      return JSON.stringify({
        success: true,
        command,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: 0,
      });
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        command,
        stdout: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message,
        exit_code: error.code || 1,
      });
    }
  },
};
