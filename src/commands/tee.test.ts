import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import elliptic from 'elliptic';
import { deriveSigningAddressFromKey } from '../lib/e2ee.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const MODEL = 'test-model';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type AttestationBuilder = (nonce: string) => Record<string, unknown>;

async function runTeeVerify(buildAttestation: AttestationBuilder, extraArgs: string[] = []): Promise<CliResult> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/tee/attestation') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildAttestation(url.searchParams.get('nonce') ?? '')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-tee-'));

  try {
    return await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'tee', 'verify', MODEL, ...extraArgs], {
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function buildTdxQuote(signingAddress: string): string {
  const quote = Buffer.alloc(632);
  quote.writeUInt32LE(0x81, 4);
  Buffer.from(signingAddress, 'hex').copy(quote, 48 + 520);
  return quote.toString('hex');
}

function passingAttestation(): AttestationBuilder {
  const signingKey = new elliptic.ec('secp256k1').genKeyPair().getPublic(false, 'hex');
  const signingAddress = deriveSigningAddressFromKey(signingKey);
  assert.ok(signingAddress);

  return (nonce) => ({
    model: MODEL,
    nonce,
    verified: true,
    signing_key: signingKey,
    signing_address: signingAddress,
    intel_quote: buildTdxQuote(signingAddress),
    server_verification: {
      tdx: { valid: true },
      nonceBinding: { bound: true },
      verifiedAt: new Date().toISOString(),
      verificationDurationMs: 1,
    },
  });
}

const failingAttestation: AttestationBuilder = (nonce) => ({
  model: 'wrong-model',
  nonce,
  verified: false,
});

test('tee verify -f json exits 1 when the attestation policy fails', async () => {
  const result = await runTeeVerify(failingAttestation, ['-f', 'json']);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  assert.ok(report.failures.length > 0);
  assert.equal(report.attestation.signingKey, null);
});

test('tee verify pretty output exits 1 when the attestation policy fails', async () => {
  const result = await runTeeVerify(failingAttestation);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAILED/);
});

test('tee verify exits 0 when the attestation policy passes', async () => {
  const attestation = passingAttestation();

  const json = await runTeeVerify(attestation, ['-f', 'json']);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.equal(JSON.parse(json.stdout).passed, true);

  const pretty = await runTeeVerify(attestation);
  assert.equal(pretty.status, 0, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /PASSED/);
});

test('tee verify exits 1 on nonce mismatch in both formats', async () => {
  const attestation = passingAttestation();
  const mismatched: AttestationBuilder = (nonce) => ({ ...attestation(nonce), nonce: 'not-the-client-nonce' });

  const json = await runTeeVerify(mismatched, ['-f', 'json']);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).attestation.nonceMatch, false);

  const pretty = await runTeeVerify(mismatched);
  assert.equal(pretty.status, 1);
  assert.match(pretty.stderr, /nonce mismatch/);
});
