import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/test-env.js';
import {
  MAX_RPC_BATCH,
  MAX_RPC_BATCH_BYTES,
  buildJsonRpcRequest,
  jsonRpcHasError,
  parseRpcParam,
  readBatchFile,
} from './rpc.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

type RecordedRequest = {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
};

function runCli(
  args: string[],
  homeDir: string,
  apiBaseUrl: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: childEnv({
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_KEY: 'test-key',
        VENICE_API_BASE_URL: apiBaseUrl,
      }),
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('rpc CLI sends idempotency keys that survive retries and honors --idempotency-key', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-rpc-idempotency-'));
  const requests: RecordedRequest[] = [];
  let failNextRpc = true;

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });

    if (request.url === '/api/v1/crypto/rpc/networks') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ networks: ['ethereum-mainnet'] }));
      return;
    }

    if (failNextRpc) {
      failNextRpc = false;
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end('upstream unavailable');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const apiBaseUrl = `http://127.0.0.1:${port}/api/v1`;

  try {
    const retried = await runCli(['rpc', 'ethereum-mainnet', 'eth_blockNumber', '-f', 'json'], homeDir, apiBaseUrl);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(requests.length, 2);
    const firstKey = requests[0].headers['idempotency-key'];
    assert.equal(typeof firstKey, 'string');
    assert.match(firstKey as string, /^[A-Za-z0-9_-]{1,255}$/);
    assert.equal(requests[1].headers['idempotency-key'], firstKey);
    assert.equal(requests[1].body, requests[0].body);

    const second = await runCli(['rpc', 'ethereum-mainnet', 'eth_blockNumber'], homeDir, apiBaseUrl);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(requests.length, 3);
    assert.notEqual(requests[2].headers['idempotency-key'], firstKey);

    const batchPath = join(homeDir, 'reqs.json');
    writeFileSync(batchPath, JSON.stringify([
      { jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 },
      { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 2 },
    ]));
    const supplied = await runCli(
      ['rpc', 'ethereum-mainnet', '--batch', batchPath, '--idempotency-key', 'batch_42-a'],
      homeDir,
      apiBaseUrl
    );
    assert.equal(supplied.status, 0, supplied.stderr);
    assert.equal(requests.length, 4);
    assert.equal(requests[3].headers['idempotency-key'], 'batch_42-a');
    assert.equal(JSON.parse(requests[3].body).length, 2);

    const invalid = await runCli(
      ['rpc', 'ethereum-mainnet', 'eth_blockNumber', '--idempotency-key', 'not valid!'],
      homeDir,
      apiBaseUrl
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid idempotency key/);
    assert.equal(requests.length, 4);

    const networksWithKey = await runCli(
      ['rpc', 'networks', '--idempotency-key', 'abc'],
      homeDir,
      apiBaseUrl
    );
    assert.equal(networksWithKey.status, 1);
    assert.match(networksWithKey.stderr, /applies only to RPC calls/);
    assert.equal(requests.length, 4);

    const networks = await runCli(['rpc', 'networks', '-f', 'json'], homeDir, apiBaseUrl);
    assert.equal(networks.status, 0, networks.stderr);
    assert.equal(requests.length, 5);
    assert.equal(requests[4].method, 'GET');
    assert.equal(requests[4].headers['idempotency-key'], undefined);
    assert.equal(requests[4].headers.authorization, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('parseRpcParam keeps hex and tags as strings and parses JSON tokens', () => {
  assert.equal(parseRpcParam('0xabc'), '0xabc');
  assert.equal(parseRpcParam('latest'), 'latest');
  assert.equal(parseRpcParam('true'), true);
  assert.equal(parseRpcParam('false'), false);
  assert.equal(parseRpcParam('null'), null);
  assert.equal(parseRpcParam('42'), 42);
  assert.equal(parseRpcParam('0'), 0);
  assert.equal(parseRpcParam('01'), '01');
  assert.equal(parseRpcParam('"quoted"'), 'quoted');
  assert.deepEqual(parseRpcParam('{"to":"0x1"}'), { to: '0x1' });
  assert.deepEqual(parseRpcParam('[1,2]'), [1, 2]);
  assert.throws(() => parseRpcParam('{not-json'), /Invalid JSON parameter/);
  assert.throws(() => parseRpcParam('9007199254740993'), /Unsafe numeric literal/);
  assert.throws(() => parseRpcParam('1e400'), /Unsafe numeric literal/);
});

test('parseRpcParam rejects unsafe numeric literals at every JSON depth', () => {
  const unsafeLiterals = [
    '9007199254740992',
    '-9007199254740992',
    '9007199254740992.0',
    '9.007199254740992e15',
    '-9.007199254740992E+15',
    '9007199254740991.1',
    '-9007199254740991.1',
    '9.0071992547409911e15',
    '-90071992547409911e-1',
    '9007199254740990.999',
    '1e400',
    '{"amount":9007199254740993}',
    '{"nested":{"amount":-9007199254740992}}',
    '[0,{"amounts":[1,9.007199254740992e15]}]',
    '{"amount":1e400}',
  ];

  for (const literal of unsafeLiterals) {
    assert.throws(
      () => parseRpcParam(literal),
      /Unsafe numeric literal.*Quote it as a string.*chain-native hex/
    );
  }
});

test('parseRpcParam preserves safe decimals and ignores numbers in JSON strings', () => {
  assert.deepEqual(
    parseRpcParam(
      '{"decimal":1.25,"exponent":1.25e3,"max":9007199254740991,' +
      '"maxDecimal":9007199254740991.0,"maxExponent":9.007199254740991e15,' +
      '"values":["9007199254740991.1","1e400","escaped: \\"-9007199254740992\\""]}'
    ),
    {
      decimal: 1.25,
      exponent: 1250,
      max: Number.MAX_SAFE_INTEGER,
      maxDecimal: Number.MAX_SAFE_INTEGER,
      maxExponent: Number.MAX_SAFE_INTEGER,
      values: ['9007199254740991.1', '1e400', 'escaped: "-9007199254740992"'],
    }
  );
});

test('buildJsonRpcRequest maps CLI args into a single JSON-RPC body', () => {
  assert.deepEqual(buildJsonRpcRequest('eth_blockNumber'), {
    jsonrpc: '2.0',
    method: 'eth_blockNumber',
    params: [],
    id: 1,
  });
  assert.deepEqual(
    buildJsonRpcRequest('eth_getBalance', ['0xabc', 'latest']),
    {
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: ['0xabc', 'latest'],
      id: 1,
    }
  );
  assert.throws(() => buildJsonRpcRequest('../eth_blockNumber'), /Invalid JSON-RPC method/);
});

test('readBatchFile validates a JSON-RPC array and enforces the 100-item cap', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-rpc-batch-'));

  try {
    const batchPath = join(tempDir, 'reqs.json');
    writeFileSync(
      batchPath,
      JSON.stringify([
        { jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 },
        { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 2 },
      ])
    );
    assert.equal(readBatchFile(batchPath).length, 2);

    const tooManyPath = join(tempDir, 'too-many.json');
    writeFileSync(
      tooManyPath,
      JSON.stringify(
        Array.from({ length: MAX_RPC_BATCH + 1 }, (_, id) => ({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id,
        }))
      )
    );
    assert.throws(() => readBatchFile(tooManyPath), /limited to 100/);

    const objectPath = join(tempDir, 'object.json');
    writeFileSync(objectPath, JSON.stringify({ method: 'eth_chainId' }));
    assert.throws(() => readBatchFile(objectPath), /JSON array/);

    const invalidEnvelopePath = join(tempDir, 'invalid-envelope.json');
    writeFileSync(invalidEnvelopePath, JSON.stringify([{ method: 'eth_chainId', id: 1 }]));
    assert.throws(() => readBatchFile(invalidEnvelopePath), /jsonrpc/);

    const invalidParamsPath = join(tempDir, 'invalid-params.json');
    writeFileSync(
      invalidParamsPath,
      JSON.stringify([{ jsonrpc: '2.0', method: 'eth_chainId', params: 'bad', id: 1 }])
    );
    assert.throws(() => readBatchFile(invalidParamsPath), /params must be an array or object/);

    assert.throws(() => readBatchFile(join(tempDir, 'missing.json')), /not found/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readBatchFile validates raw numeric literals in ids and nested params', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-rpc-batch-numbers-'));

  try {
    const cases = [
      ['unsafe-id.json', '[{"jsonrpc":"2.0","method":"eth_chainId","id":9007199254740993}]'],
      [
        'unsafe-param.json',
        '[{"jsonrpc":"2.0","method":"eth_call",' +
        '"params":[{"nested":[-9007199254740992]}],"id":1}]',
      ],
      [
        'unsafe-exponent.json',
        '[{"jsonrpc":"2.0","method":"eth_call",' +
        '"params":{"amount":9.007199254740992e15},"id":1}]',
      ],
      [
        'rounds-to-safe.json',
        '[{"jsonrpc":"2.0","method":"eth_call",' +
        '"params":{"amount":9007199254740991.1},"id":1}]',
      ],
      [
        'non-finite.json',
        '[{"jsonrpc":"2.0","method":"eth_call","params":[1e400],"id":1}]',
      ],
    ] as const;

    for (const [name, contents] of cases) {
      const filePath = join(tempDir, name);
      writeFileSync(filePath, contents);
      assert.throws(() => readBatchFile(filePath), /Unsafe numeric literal in JSON batch file/);
    }

    const safePath = join(tempDir, 'safe.json');
    writeFileSync(
      safePath,
      '[{"jsonrpc":"2.0","method":"eth_call",' +
      '"params":{"decimal":1.25,"values":["9007199254740993","escaped: \\"1e400\\""]},' +
      '"id":9007199254740991}]'
    );
    assert.deepEqual(readBatchFile(safePath), [{
      jsonrpc: '2.0',
      method: 'eth_call',
      params: {
        decimal: 1.25,
        values: ['9007199254740993', 'escaped: "1e400"'],
      },
      id: Number.MAX_SAFE_INTEGER,
    }]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('readBatchFile rejects files over the byte cap before parsing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-rpc-batch-size-'));

  try {
    const exactLimitPath = join(tempDir, 'exact-limit.json');
    const validBatch = '[{"jsonrpc":"2.0","method":"eth_chainId","id":1}]';
    writeFileSync(
      exactLimitPath,
      validBatch + ' '.repeat(MAX_RPC_BATCH_BYTES - Buffer.byteLength(validBatch))
    );
    assert.equal(readBatchFile(exactLimitPath).length, 1);

    const oversizedPath = join(tempDir, 'oversized.json');
    writeFileSync(oversizedPath, Buffer.alloc(MAX_RPC_BATCH_BYTES + 1, 0x20));
    assert.throws(
      () => readBatchFile(oversizedPath),
      new RegExp(`${MAX_RPC_BATCH_BYTES}-byte \\(1 MiB\\) limit.*${MAX_RPC_BATCH_BYTES + 1}`)
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('jsonRpcHasError detects single and batch RPC errors', () => {
  assert.equal(jsonRpcHasError({ jsonrpc: '2.0', id: 1, result: '0x1' }), false);
  assert.equal(
    jsonRpcHasError({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'invalid params' },
    }),
    true
  );
  assert.equal(
    jsonRpcHasError([
      { jsonrpc: '2.0', id: 1, result: '0x1' },
      { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'invalid params' } },
    ]),
    true
  );
});
