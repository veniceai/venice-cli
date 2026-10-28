import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

test('attestation requests send a fresh 32-byte nonce when the WebCrypto global is missing', async () => {
  const nonces: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/tee/attestation') {
      res.writeHead(404).end();
      return;
    }
    const nonce = url.searchParams.get('nonce') ?? '';
    nonces.push(nonce);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'test-model', nonce, verified: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-nonce-'));
  // Node 18 has no WebCrypto global unless it is enabled with a flag.
  const preload = join(homeDir, 'no-webcrypto.cjs');
  writeFileSync(preload, 'delete globalThis.crypto;\n');

  try {
    for (let run = 0; run < 2; run++) {
      const stderr = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--require', preload, cliPath, 'tee', 'attestation', 'test-model', '-f', 'json'],
          {
            env: {
              ...process.env,
              HOME: homeDir,
              NODE_ENV: 'test',
              NO_COLOR: '1',
              VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
              VENICE_API_KEY: 'test-key',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          }
        );
        let output = '';
        child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
        child.once('error', reject);
        child.once('close', () => resolve(output));
      });
      assert.doesNotMatch(stderr, /crypto is not defined/);
    }

    assert.equal(nonces.length, 2);
    for (const nonce of nonces) {
      assert.match(nonce, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(nonces[0], nonces[1]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
});
