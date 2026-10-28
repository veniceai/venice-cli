import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { jsonRpcHasError } from './rpc.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

async function runRpc(
  responseBody: string,
  args: (homeDir: string) => string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(responseBody);
    });
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-rpc-exit-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'rpc', 'ethereum-mainnet', ...args(homeDir)], {
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
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('jsonRpcHasError treats any non-null error and any missing result as a failure', () => {
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, result: '0x1' }), false);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, result: null }), false);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, result: '0x1', error: null }), false);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, error: 'upstream node unavailable' }), true);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, error: 42 }), true);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, error: {} }), true);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1 }), true);
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, error: null }), true);
  assert.equal(jsonRpcHasError('ok'), true);
  assert.equal(jsonRpcHasError(null), true);
  assert.equal(jsonRpcHasError([]), true);
  assert.equal(jsonRpcHasError([{ id: 1, result: 1 }, 'ok']), true);
  assert.equal(jsonRpcHasError([{ id: 1, result: 1 }, { id: 2, result: 2 }]), false);
});

test('rpc prints a string error and exits non-zero', async () => {
  const result = await runRpc(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: `upstream node unavailable\u001b]0;x\u0007${'!'.repeat(2000)}` }),
    () => ['eth_blockNumber', '-f', 'pretty']
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^error: upstream node unavailable[^\n]*!…\n$/);
  assert.doesNotMatch(result.stderr, /\u001b|\u0007/);
  assert.ok(result.stderr.length < 700, `${result.stderr.length} characters of stderr`);
});

test('rpc exits non-zero when a response has neither a result nor an error', async () => {
  const result = await runRpc(JSON.stringify({ jsonrpc: '2.0', id: 1 }), () => ['eth_blockNumber', '-f', 'pretty']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /neither a result nor an error/);
  assert.equal(result.stdout, '');
});

test('rpc --batch -f json writes every result to a pipe before exiting non-zero', async () => {
  const requests = Array.from({ length: 100 }, (_, i) => ({
    jsonrpc: '2.0',
    method: 'eth_getCode',
    params: [`0x${i}`, 'latest'],
    id: i + 1,
  }));
  const answers = requests.map((request) => request.id === 100
    ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'execution reverted' } }
    : { jsonrpc: '2.0', id: request.id, result: `0x${'60'.repeat(5 * 1024)}` });

  const result = await runRpc(JSON.stringify(answers), (homeDir) => {
    const batchPath = join(homeDir, 'batch.json');
    writeFileSync(batchPath, JSON.stringify(requests));
    return ['--batch', batchPath, '-f', 'json'];
  });

  assert.equal(result.status, 1);
  assert.ok(result.stdout.length > 1_000_000, `${result.stdout.length} bytes of stdout`);
  assert.deepEqual(JSON.parse(result.stdout), answers);
});
