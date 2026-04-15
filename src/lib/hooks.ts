/**
 * Tool Execution Hooks
 *
 * User-configurable shell commands that run before/after tool executions.
 * Configured in .venice/hooks.json:
 *
 * {
 *   "pre": {
 *     "file_write": "echo 'About to write: ${FILE_PATH}'",
 *     "bash": "echo 'Running: ${COMMAND}'"
 *   },
 *   "post": {
 *     "file_write": "git add ${FILE_PATH}",
 *     "test": "echo 'Tests completed with exit code ${EXIT_CODE}'"
 *   }
 * }
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';

interface HooksConfig {
  pre?: Record<string, string>;
  post?: Record<string, string>;
}

let loadedHooks: HooksConfig | null = null;
let hooksDir: string | null = null;

export async function loadHooks(cwd: string): Promise<void> {
  hooksDir = cwd;
  const hooksPath = path.join(cwd, '.venice', 'hooks.json');
  try {
    const content = await fs.readFile(hooksPath, 'utf-8');
    loadedHooks = JSON.parse(content) as HooksConfig;
  } catch {
    loadedHooks = null;
  }
}

export async function runPreHook(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; output?: string }> {
  return runHook('pre', toolName, args);
}

export async function runPostHook(
  toolName: string,
  args: Record<string, unknown>,
  result?: { output: string; exitCode?: number }
): Promise<{ ok: boolean; output?: string }> {
  const extraEnv: Record<string, string> = {};
  if (result) {
    extraEnv.TOOL_OUTPUT = result.output.slice(0, 1000);
    if (result.exitCode !== undefined) {
      extraEnv.EXIT_CODE = String(result.exitCode);
    }
  }
  return runHook('post', toolName, args, extraEnv);
}

async function runHook(
  phase: 'pre' | 'post',
  toolName: string,
  args: Record<string, unknown>,
  extraEnv?: Record<string, string>
): Promise<{ ok: boolean; output?: string }> {
  if (!loadedHooks) return { ok: true };

  const hooks = phase === 'pre' ? loadedHooks.pre : loadedHooks.post;
  if (!hooks || !hooks[toolName]) return { ok: true };

  const command = hooks[toolName];

  // Build environment with tool args
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(args)) {
    env[key.toUpperCase()] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  // Common aliases
  if (args.file_path) env.FILE_PATH = args.file_path as string;
  if (args.command) env.COMMAND = args.command as string;
  if (extraEnv) Object.assign(env, extraEnv);

  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      {
        cwd: hooksDir || process.cwd(),
        timeout: 10_000,
        env,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;
        if (exitCode !== 0) {
          resolve({
            ok: false,
            output: `Hook ${phase}:${toolName} failed (exit ${exitCode}): ${stderr || stdout}`.trim(),
          });
        } else {
          resolve({ ok: true, output: stdout.trim() || undefined });
        }
      }
    );
  });
}

export function hasHooks(): boolean {
  return loadedHooks !== null &&
    (Object.keys(loadedHooks.pre || {}).length > 0 ||
     Object.keys(loadedHooks.post || {}).length > 0);
}
