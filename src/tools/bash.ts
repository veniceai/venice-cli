import { execFile } from 'child_process';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';
import { buildSandboxedCommand, type SandboxMode } from '../lib/sandbox.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 32 * 1024;

// Module-level sandbox mode, set by code command
let sandboxMode: SandboxMode = 'none';

export function setSandboxMode(mode: SandboxMode): void {
  sandboxMode = mode;
}

export const bashTool: CodingTool = {
  name: 'bash',
  description:
    'Execute a shell command using bash. Returns stdout, stderr, and exit code. ' +
    'Commands run in the project working directory. Use for running tests, builds, git commands, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      timeout: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT})`,
      },
    },
    required: ['command'],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    const timeout = typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT;

    const summary = `Execute: ${command.length > 100 ? command.slice(0, 100) + '...' : command}`;
    const approved = await context.approve('bash', summary);
    if (!approved) {
      return { output: 'Command execution cancelled by user.', error: true };
    }

    const sandboxed = buildSandboxedCommand(command, context.cwd, sandboxMode);

    return new Promise((resolve) => {
      execFile(
        sandboxed.command,
        sandboxed.args,
        {
          cwd: context.cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: sandboxed.env,
        },
        (error, stdout, stderr) => {
          const killed = error && 'killed' in error && (error as { killed: boolean }).killed;
          if (killed) {
            const partial = truncate((stdout || '') + (stderr || ''), MAX_OUTPUT);
            resolve({
              output: `Command timed out after ${timeout}ms\n${partial}`.trim(),
              error: true,
            });
            return;
          }

          const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;

          let out = '';
          if (sandboxed.warning) {
            out += `[Sandbox: ${sandboxed.warning}]\n`;
          }
          if (stdout) {
            out += truncate(stdout, MAX_OUTPUT);
          }
          if (stderr) {
            if (out) out += '\n';
            out += `STDERR:\n${truncate(stderr, MAX_OUTPUT)}`;
          }
          if (!out || out.trim() === `[Sandbox: ${sandboxed.warning}]`) {
            out += '(no output)';
          }

          out += `\n\nExit code: ${exitCode ?? (error ? 1 : 0)}`;

          resolve({
            output: out,
            error: exitCode !== 0 && exitCode !== undefined,
          });
        }
      );
    });
  },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) +
    `\n\n[... ${text.length - max} characters truncated ...]\n\n` +
    text.slice(-half)
  );
}
