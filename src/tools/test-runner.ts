/**
 * Test Runner Tool
 *
 * Auto-detects the project's test framework and runs tests.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool, ToolContext, ToolResult } from '../types/index.js';

const MAX_OUTPUT = 32 * 1024;

interface TestFramework {
  name: string;
  command: string;
  args: string[];
  marker: string; // file that indicates this framework
}

const FRAMEWORKS: TestFramework[] = [
  { name: 'jest', command: 'npx', args: ['jest', '--no-coverage'], marker: 'jest.config' },
  { name: 'vitest', command: 'npx', args: ['vitest', 'run'], marker: 'vitest.config' },
  { name: 'mocha', command: 'npx', args: ['mocha'], marker: '.mocharc' },
  { name: 'pytest', command: 'python', args: ['-m', 'pytest', '-v'], marker: 'pytest.ini' },
  { name: 'pytest', command: 'python', args: ['-m', 'pytest', '-v'], marker: 'pyproject.toml' },
  { name: 'go test', command: 'go', args: ['test', './...'], marker: 'go.mod' },
  { name: 'cargo test', command: 'cargo', args: ['test'], marker: 'Cargo.toml' },
  { name: 'npm test', command: 'npm', args: ['test'], marker: 'package.json' },
];

export const testRunnerTool: CodingTool = {
  name: 'test',
  description:
    'Run the project test suite. Auto-detects the test framework (jest, vitest, pytest, go test, cargo test, npm test). ' +
    'Optionally specify a file pattern or test name to run specific tests.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Optional file pattern or test name to run specific tests',
      },
      framework: {
        type: 'string',
        description: 'Override auto-detection: jest, vitest, pytest, go, cargo, npm',
      },
    },
    required: [],
  },
  isReadOnly: false,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = args.pattern as string | undefined;
    const frameworkOverride = args.framework as string | undefined;

    let framework: TestFramework | undefined;

    if (frameworkOverride) {
      framework = FRAMEWORKS.find((f) => f.name.includes(frameworkOverride));
      if (!framework) {
        return { output: `Unknown framework "${frameworkOverride}". Supported: jest, vitest, pytest, go, cargo, npm`, error: true };
      }
    } else {
      framework = await detectFramework(context.cwd);
    }

    if (!framework) {
      return { output: 'Could not detect test framework. No package.json, pyproject.toml, go.mod, or Cargo.toml found.', error: true };
    }

    const summary = `Run tests: ${framework.name}${pattern ? ` (${pattern})` : ''}`;
    const approved = await context.approve('test', summary);
    if (!approved) {
      return { output: 'Test execution cancelled by user.', error: true };
    }

    const testArgs = [...framework.args];
    if (pattern) {
      testArgs.push(pattern);
    }

    return new Promise((resolve) => {
      execFile(
        framework!.command,
        testArgs,
        {
          cwd: context.cwd,
          timeout: 300_000, // 5 minute timeout for tests
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
        },
        (error, stdout, stderr) => {
          const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;

          let out = `[${framework!.name}]`;
          if (stdout) out += '\n' + truncate(stdout, MAX_OUTPUT);
          if (stderr && exitCode !== 0) {
            out += '\nSTDERR:\n' + truncate(stderr, MAX_OUTPUT);
          }
          out += `\n\nExit code: ${exitCode ?? 0}`;

          resolve({
            output: out,
            error: exitCode !== 0,
          });
        }
      );
    });
  },
};

async function detectFramework(cwd: string): Promise<TestFramework | undefined> {
  for (const fw of FRAMEWORKS) {
    // Check for config files
    try {
      const files = await fs.readdir(cwd);
      for (const file of files) {
        if (file.startsWith(fw.marker) || file === fw.marker) {
          // For pyproject.toml, check if pytest is configured
          if (fw.marker === 'pyproject.toml') {
            const content = await fs.readFile(path.join(cwd, file), 'utf-8');
            if (!content.includes('pytest') && !content.includes('tool.pytest')) continue;
          }
          // For package.json, check if test script exists
          if (fw.marker === 'package.json') {
            const content = await fs.readFile(path.join(cwd, file), 'utf-8');
            try {
              const pkg = JSON.parse(content);
              if (!pkg.scripts?.test || pkg.scripts.test.includes('no test specified')) continue;
            } catch { continue; }
          }
          return fw;
        }
      }
    } catch { /* skip */ }
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return text.slice(0, half) + `\n\n[... ${text.length - max} chars truncated ...]\n\n` + text.slice(-half);
}
