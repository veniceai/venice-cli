/**
 * GitHub Integration Tool
 *
 * Wraps the gh CLI for common GitHub operations.
 */

import { execFile } from 'child_process';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';

const MAX_OUTPUT = 32 * 1024;

const ALLOWED_COMMANDS: Record<string, { readOnly: boolean; description: string }> = {
  'issue list': { readOnly: true, description: 'List issues' },
  'issue view': { readOnly: true, description: 'View issue details' },
  'issue create': { readOnly: false, description: 'Create a new issue' },
  'issue comment': { readOnly: false, description: 'Comment on an issue' },
  'pr list': { readOnly: true, description: 'List pull requests' },
  'pr view': { readOnly: true, description: 'View PR details' },
  'pr create': { readOnly: false, description: 'Create a pull request' },
  'pr checks': { readOnly: true, description: 'View PR check status' },
  'pr diff': { readOnly: true, description: 'View PR diff' },
  'pr comment': { readOnly: false, description: 'Comment on a PR' },
  'pr merge': { readOnly: false, description: 'Merge a pull request' },
  'repo view': { readOnly: true, description: 'View repository info' },
  'run list': { readOnly: true, description: 'List workflow runs' },
  'run view': { readOnly: true, description: 'View workflow run details' },
  'release list': { readOnly: true, description: 'List releases' },
};

export const githubTool: CodingTool = {
  name: 'github',
  description:
    'Interact with GitHub using the gh CLI. Supports issues, pull requests, CI checks, and releases. ' +
    'Requires gh CLI to be installed and authenticated.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'GitHub command (e.g., "issue list", "pr view 123", "pr create --title \\"Fix bug\\"")',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = (args.command as string).trim();

    // Validate the command starts with an allowed prefix
    const matchedCommand = Object.keys(ALLOWED_COMMANDS).find((prefix) =>
      command.startsWith(prefix)
    );

    if (!matchedCommand) {
      const allowed = Object.entries(ALLOWED_COMMANDS)
        .map(([cmd, info]) => `  ${cmd} - ${info.description}`)
        .join('\n');
      return { output: `Unknown GitHub command. Allowed commands:\n${allowed}`, error: true };
    }

    const cmdInfo = ALLOWED_COMMANDS[matchedCommand];

    // Only prompt for write operations
    if (!cmdInfo.readOnly) {
      const approved = await context.approve('github', `gh ${command}`);
      if (!approved) {
        return { output: 'GitHub command cancelled by user.', error: true };
      }
    }

    return new Promise((resolve) => {
      const ghArgs = command.split(/\s+/);

      execFile(
        'gh',
        ghArgs,
        {
          cwd: context.cwd,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
        },
        (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({
              output: 'Error: gh CLI is not installed. Install it from https://cli.github.com/',
              error: true,
            });
            return;
          }

          const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;

          let out = '';
          if (stdout) out += truncate(stdout.trimEnd(), MAX_OUTPUT);
          if (stderr && exitCode !== 0) {
            if (out) out += '\n';
            out += `Error: ${stderr.trimEnd()}`;
          }
          if (!out) out = '(no output)';

          resolve({
            output: out,
            error: exitCode !== 0,
          });
        }
      );
    });
  },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n[... truncated at ${max} chars]`;
}
