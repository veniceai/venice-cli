import { execFile } from 'child_process';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';

const ALLOWED_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'add', 'commit',
  'checkout', 'stash', 'tag', 'remote', 'fetch', 'pull', 'push',
  'merge', 'rebase', 'reset', 'rev-parse', 'blame', 'shortlog',
]);

const READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'tag', 'remote',
  'rev-parse', 'blame', 'shortlog', 'fetch',
]);

export const gitTool: CodingTool = {
  name: 'git',
  description:
    'Execute git commands in the project repository. Supports common operations like ' +
    'status, diff, log, add, commit, branch, checkout, stash, push, pull, merge, and more. ' +
    'Write operations (add, commit, push, etc.) require approval.',
  parameters: {
    type: 'object',
    properties: {
      subcommand: {
        type: 'string',
        description: 'Git subcommand (e.g., "status", "diff", "log", "add", "commit")',
      },
      args: {
        type: 'string',
        description: 'Additional arguments for the git command (e.g., "--oneline -20", "-m \\"commit msg\\"")',
      },
    },
    required: ['subcommand'],
  },
  isReadOnly: false, // determined per-call in execute

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const subcommand = (args.subcommand as string).trim();
    const extraArgs = (args.args as string | undefined)?.trim() || '';

    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return {
        output: `Git subcommand "${subcommand}" is not allowed. Allowed: ${[...ALLOWED_SUBCOMMANDS].join(', ')}`,
        error: true,
      };
    }

    // Only prompt for write operations
    const isWrite = !READ_ONLY_SUBCOMMANDS.has(subcommand);
    if (isWrite) {
      const summary = `git ${subcommand} ${extraArgs}`.trim();
      const approved = await context.approve('git', summary);
      if (!approved) {
        return { output: 'Git command cancelled by user.', error: true };
      }
    }

    const fullArgs = extraArgs ? `${subcommand} ${extraArgs}` : subcommand;

    return new Promise((resolve) => {
      execFile(
        'git',
        fullArgs.split(/\s+/),
        {
          cwd: context.cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout, stderr) => {
          const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;

          let out = '';
          if (stdout) out += stdout.trimEnd();
          if (stderr) {
            // Git writes progress/info to stderr even on success
            if (out) out += '\n';
            if (exitCode !== 0) {
              out += `STDERR: ${stderr.trimEnd()}`;
            }
          }
          if (!out) out = '(no output)';

          resolve({
            output: out,
            error: exitCode !== 0 && exitCode !== undefined,
          });
        }
      );
    });
  },
};
