import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildJsonRpcRequest,
  MAX_RPC_JSON_DEPTH,
  parseRpcParam,
  readBatchFile,
} from './rpc.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const nested = (depth: number) => `${'['.repeat(depth)}1${']'.repeat(depth)}`;

test('parseRpcParam rejects numbers that JSON would send with a different value', () => {
  for (const literal of [
    '1e-400',
    '-1e-400',
    '1.0000000000000001',
    '12345678901234567e-1',
    '0.30000000000000001',
    '[0.1,{"amount":1e-400}]',
  ]) {
    assert.throws(
      () => parseRpcParam(literal),
      /Unsafe numeric literal in JSON parameter/,
      literal
    );
  }
});

test('parseRpcParam keeps numbers that JSON sends unchanged', () => {
  const sent = (literal: string) => JSON.stringify(parseRpcParam(literal));
  assert.equal(sent('0.1'), '0.1');
  assert.equal(sent('1.50'), '1.5');
  assert.equal(sent('1E3'), '1000');
  assert.equal(sent('1.5e-7'), '1.5e-7');
  assert.equal(sent('5e-324'), '5e-324');
  assert.equal(sent('0e99999'), '0');
  assert.equal(sent('-0'), '0');
  assert.equal(sent('[0.000001,{"a":-2.25}]'), '[0.000001,{"a":-2.25}]');
});

test('parseRpcParam trims every token', () => {
  assert.equal(parseRpcParam(' 0x10 '), '0x10');
  assert.equal(parseRpcParam('\tlatest\n'), 'latest');
  assert.equal(parseRpcParam(' 42 '), 42);
  assert.deepEqual(buildJsonRpcRequest('eth_call', ['  hi  ', ' 0xabc']).params, ['hi', '0xabc']);
});

test('parseRpcParam rejects parameters nested beyond the depth limit before parsing', () => {
  assert.equal(JSON.stringify(parseRpcParam(nested(MAX_RPC_JSON_DEPTH))), nested(MAX_RPC_JSON_DEPTH));
  assert.throws(
    () => parseRpcParam(nested(MAX_RPC_JSON_DEPTH + 1)),
    /JSON parameter is nested more than 32 levels deep/
  );
  assert.throws(() => parseRpcParam(nested(8000)), /nested more than 32 levels deep/);
  assert.throws(
    () => parseRpcParam(`{"a":${nested(MAX_RPC_JSON_DEPTH)}}`),
    /nested more than 32 levels deep/
  );
  assert.equal(parseRpcParam(`"${'['.repeat(100)}"`), '['.repeat(100));
});

test('readBatchFile applies the same depth and exactness limits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-rpc-batch-limits-'));
  try {
    const write = (name: string, params: string) => {
      const filePath = join(dir, name);
      writeFileSync(filePath, `[{"jsonrpc":"2.0","method":"eth_call","id":1,"params":${params}}]`);
      return filePath;
    };
    assert.equal(readBatchFile(write('ok.json', nested(MAX_RPC_JSON_DEPTH - 2))).length, 1);
    assert.throws(
      () => readBatchFile(write('deep.json', nested(MAX_RPC_JSON_DEPTH - 1))),
      /JSON batch file is nested more than 32 levels deep/
    );
    assert.throws(
      () => readBatchFile(write('inexact.json', '[1e-400]')),
      /Unsafe numeric literal in JSON batch file: 1e-400/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc rejects a deeply nested parameter before any request', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-rpc-depth-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, 'rpc', 'ethereum-mainnet', 'eth_call', nested(8000)],
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
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /JSON parameter is nested more than 32 levels deep/);
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
});
