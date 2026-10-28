import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveSigningAddressFromKey, generateEphemeralKeyPair } from '../lib/e2ee.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const MODEL = 'e2ee-test-model';

const enclave = generateEphemeralKeyPair();
const enclaveAddress = deriveSigningAddressFromKey(enclave.publicKeyHex) ?? '';

interface TeeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: string[];
}

type Routes = Record<string, (url: URL) => unknown>;

async function runTee(
  args: string[] | ((dir: string) => string[]),
  routes: Routes,
  files: Record<string, string> = {}
): Promise<TeeRun> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    requests.push(path);
    const body = routes[path]?.(url);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-tee-verification-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(homeDir, name), content);
  }

  try {
    const cliArgs = typeof args === 'function' ? args(homeDir) : args;
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'tee', ...cliArgs], {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          VENICE_API_KEY: 'test-key',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function buildTdxQuote(reportData: string): string {
  const signatureData = Buffer.alloc(64);
  const quote = Buffer.alloc(636 + signatureData.length);
  quote.writeUInt16LE(4, 0);
  quote.writeUInt16LE(2, 2);
  quote.writeUInt32LE(0x81, 4);
  Buffer.from(reportData, 'hex').copy(quote, 568);
  quote.writeUInt32LE(signatureData.length, 632);
  signatureData.copy(quote, 636);
  return quote.toString('hex');
}

function attestationRoute(change: Record<string, unknown> = {}) {
  return (url: URL) => ({
    model: MODEL,
    nonce: url.searchParams.get('nonce'),
    verified: true,
    tee_provider: 'test',
    signing_key: enclave.publicKeyHex,
    signing_address: enclaveAddress,
    intel_quote: buildTdxQuote(enclaveAddress),
    server_verification: {
      tdx: { valid: true },
      nonceBinding: { bound: true },
      verifiedAt: '2026-01-01T00:00:00.000Z',
      verificationDurationMs: 1,
    },
    ...change,
  });
}

test('tee verify fails when the server reports verified: false', async () => {
  const routes = { '/tee/attestation': attestationRoute({ verified: false }) };

  const pretty = await runTee(['verify', MODEL], routes);
  assert.equal(pretty.status, 1, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /FAILED/);
  assert.match(pretty.stdout, /did not report this attestation as verified/);
  assert.doesNotMatch(pretty.stdout, /PASSED/);

  const json = await runTee(['verify', MODEL, '-f', 'json'], routes);
  assert.equal(json.status, 1, json.stdout + json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.passed, false);
  assert.equal(report.attestation.verified, false);
  assert.ok(report.failures.some((failure: string) => /did not report this attestation as verified/.test(failure)));
});

test('tee verify reports a malformed NVIDIA payload as a policy failure', async () => {
  const routes = { '/tee/attestation': attestationRoute({ nvidia_payload: '{not json' }) };

  const pretty = await runTee(['verify', MODEL], routes);
  assert.equal(pretty.status, 1, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /FAILED/);
  assert.match(pretty.stdout, /NVIDIA GPU attestation payload is not a valid JSON object/);

  const json = await runTee(['verify', MODEL, '-f', 'json'], routes);
  assert.equal(json.status, 1, json.stdout + json.stderr);
  assert.equal(JSON.parse(json.stdout).passed, false);
});
