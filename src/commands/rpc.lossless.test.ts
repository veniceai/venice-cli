import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cryptoRpc } from '../lib/api.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const SUPPLY = '587345934858473829';
const BALANCE = '9007199254740993';
const getSupplyBody =
  `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":312345678},` +
  `"value":{"circulating":${SUPPLY},"nonCirculating":1234,"total":${SUPPLY},"ratio":0.25}}}`;

async function runRpc(responseBody: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(responseBody);
    });
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-rpc-lossless-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'rpc', 'solana-mainnet', ...args], {
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

test('rpc -f json and -f raw print the response text unchanged', async () => {
  for (const format of ['json', 'raw']) {
    const result = await runRpc(getSupplyBody, ['getSupply', '-f', format]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${getSupplyBody}\n`);
  }
});

test('rpc pretty output prints integers beyond 2^53 with their exact digits', async () => {
  const supply = await runRpc(getSupplyBody, ['getSupply', '-f', 'pretty']);
  assert.equal(supply.status, 0, supply.stderr);
  assert.deepEqual(JSON.parse(supply.stdout), {
    context: { slot: 312345678 },
    value: { circulating: SUPPLY, nonCirculating: 1234, total: SUPPLY, ratio: 0.25 },
  });

  const balance = await runRpc(
    `{"jsonrpc":"2.0","id":1,"result":${BALANCE}}`,
    ['getBalance', 'So11111111111111111111111111111111111111112', '-f', 'pretty']
  );
  assert.equal(balance.status, 0, balance.stderr);
  assert.equal(balance.stdout, `${BALANCE}\n`);
});

async function withStubbedFetch(
  respond: () => Response,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => respond()) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
}

const request = { jsonrpc: '2.0' as const, method: 'getSupply', id: 1 };

test('cryptoRpc returns the response text next to the parsed body', { timeout: 10_000 }, async () => {
  await withStubbedFetch(() => new Response(getSupplyBody), async () => {
    const result = await cryptoRpc('solana-mainnet', request);
    assert.equal(result.text, getSupplyBody);
    assert.equal((result.body as { id: number }).id, 1);
  });
});

test('cryptoRpc rejects oversized, non-JSON, and non-UTF-8 responses', { timeout: 10_000 }, async () => {
  await withStubbedFetch(
    () => new Response('{}', { headers: { 'Content-Length': String(64 * 1024 * 1024) } }),
    async () => {
      await assert.rejects(cryptoRpc('solana-mainnet', request), /RPC response is too large/);
    }
  );
  await withStubbedFetch(() => new Response('<html>busy</html>'), async () => {
    await assert.rejects(cryptoRpc('solana-mainnet', request), /RPC response was not valid JSON/);
  });
  await withStubbedFetch(() => new Response(Buffer.from([0x22, 0xff, 0x22])), async () => {
    await assert.rejects(cryptoRpc('solana-mainnet', request), /RPC response was not valid JSON/);
  });
});
