import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function runStructuredChat(reply: string, args: string[], schema?: unknown): Promise<CliResult> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url?.startsWith('/api/v1/models')) {
        response.end(JSON.stringify({
          data: [{
            id: 'test-model',
            type: 'text',
            model_spec: { capabilities: { supportsResponseSchema: true } },
          }],
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
      }));
    });
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-structured-'));

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const schemaArgs: string[] = [];
    if (schema !== undefined) {
      const schemaPath = join(homeDir, 'schema.json');
      writeFileSync(schemaPath, JSON.stringify(schema));
      schemaArgs.push('--json-schema', schemaPath);
    }

    const started = performance.now();
    return await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, 'chat', '-m', 'test-model', ...schemaArgs, ...args, 'hi'],
        {
          cwd: homeDir,
          env: {
            ...process.env,
            HOME: homeDir,
            NODE_ENV: 'test',
            NO_COLOR: '1',
            VENICE_API_KEY: 'test-key',
            VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({
        status,
        stdout,
        stderr,
        durationMs: performance.now() - started,
      }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('chat --json fails promptly on a reply with an unclosed code fence', { timeout: 30_000 }, async () => {
  const result = await runStructuredChat(`\`\`\`json${' '.repeat(300 * 1024)}{}`, ['--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Model response was not valid JSON/);
  assert.ok(result.durationMs < 3000, `took ${result.durationMs.toFixed(0)} ms`);
});

test('chat --json rejects a structured reply over 1 MiB', { timeout: 30_000 }, async () => {
  const result = await runStructuredChat(JSON.stringify('a'.repeat(1024 * 1024)), ['--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds the 1048576-byte \(1 MiB\) structured output limit/);
});

test('chat --json-schema reports a short, escaped error list for a failing reply', { timeout: 30_000 }, async () => {
  const anyOfFive = {
    type: 'array',
    items: {
      anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'object' }, { type: 'array' }, { type: 'null' }],
    },
  };
  const failing = await runStructuredChat(`[${Array(50_000).fill('1').join(',')}]`, [], anyOfFive);
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, '');
  assert.equal(failing.stderr.split('\n').filter((line) => line.startsWith('  - ')).length, 6);
  assert.match(failing.stderr, /\$\/0: must match a schema in anyOf/);
  assert.ok(failing.durationMs < 3000, `took ${failing.durationMs.toFixed(0)} ms`);

  const closed = { type: 'object', properties: {}, additionalProperties: false };
  const escaped = await runStructuredChat(JSON.stringify({ '\u001b]0;title\u0007': 1 }), [], closed);
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /unexpected property "\\u001b\]0;title\\u0007"/);
  assert.doesNotMatch(escaped.stderr, /\u001b/);
});
