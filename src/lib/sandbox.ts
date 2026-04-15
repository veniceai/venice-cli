/**
 * Sandbox for command execution
 *
 * Provides isolated execution environments for bash commands.
 * Tries multiple strategies in order:
 * 1. firejail (lightweight Linux sandbox)
 * 2. unshare (Linux namespace isolation - network only)
 * 3. Docker (container isolation)
 * 4. Bare execution (fallback with warning)
 */

import { execFileSync } from 'child_process';

export type SandboxMode = 'auto' | 'firejail' | 'docker' | 'none';

interface SandboxResult {
  command: string;
  args: string[];
  env: Record<string, string>;
  warning?: string;
}

let detectedSandbox: SandboxMode | null = null;

function detectAvailableSandbox(): SandboxMode {
  if (detectedSandbox !== null) return detectedSandbox;

  // Try firejail
  try {
    execFileSync('firejail', ['--version'], { stdio: 'pipe', timeout: 5000 });
    detectedSandbox = 'firejail';
    return 'firejail';
  } catch { /* not available */ }

  // Try docker
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe', timeout: 5000 });
    detectedSandbox = 'docker';
    return 'docker';
  } catch { /* not available */ }

  detectedSandbox = 'none';
  return 'none';
}

export function buildSandboxedCommand(
  command: string,
  cwd: string,
  mode: SandboxMode = 'auto'
): SandboxResult {
  const resolvedMode = mode === 'auto' ? detectAvailableSandbox() : mode;

  switch (resolvedMode) {
    case 'firejail':
      return {
        command: 'firejail',
        args: [
          '--quiet',
          '--noprofile',
          '--noroot',
          '--net=none',           // no network access
          '--nosound',
          '--no3d',
          '--nodvd',
          '--notv',
          '--novideo',
          `--whitelist=${cwd}`,   // only access project directory
          '--read-only=/etc',
          '--read-only=/usr',
          '--', '/bin/bash', '-c', command,
        ],
        env: { ...process.env, TERM: 'dumb' },
      };

    case 'docker':
      return {
        command: 'docker',
        args: [
          'run', '--rm',
          '--network=none',         // no network
          '--read-only',            // read-only root filesystem
          '-v', `${cwd}:/workspace`,
          '-w', '/workspace',
          '--memory=512m',          // memory limit
          '--cpus=1',               // CPU limit
          'node:18-slim',
          '/bin/bash', '-c', command,
        ],
        env: { ...process.env } as Record<string, string>,
      };

    case 'none':
    default:
      return {
        command: '/bin/bash',
        args: ['-c', command],
        env: { ...process.env, TERM: 'dumb' },
        warning: 'No sandbox available. Command will run without isolation.',
      };
  }
}

export function getSandboxMode(): SandboxMode {
  return detectAvailableSandbox();
}

export function getSandboxInfo(): string {
  const mode = detectAvailableSandbox();
  switch (mode) {
    case 'firejail': return 'firejail (network disabled, filesystem restricted)';
    case 'docker': return 'Docker (container isolated, network disabled)';
    case 'none': return 'none (commands run directly on host)';
    default: return 'unknown';
  }
}
