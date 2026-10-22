import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import elliptic from 'elliptic';
import { deriveSigningAddressFromKey } from '../lib/e2ee.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const MODEL = 'test-model';
const REQUEST_ID = 'req-1';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type AttestationBuilder = (nonce: string) => Record<string, unknown>;

type StubHandler = (url: URL) => unknown;

function runTeeVerify(buildAttestation: AttestationBuilder, extraArgs: string[] = []): Promise<CliResult> {
  return runTee(['verify', MODEL, ...extraArgs], (url) =>
    url.pathname === '/api/v1/tee/attestation' ? buildAttestation(url.searchParams.get('nonce') ?? '') : undefined
  );
}

function runTeeSignature(payload: Record<string, unknown>, extraArgs: string[] = []): Promise<CliResult> {
  return runTee(['signature', MODEL, REQUEST_ID, ...extraArgs], (url) =>
    url.pathname === '/api/v1/tee/signature' &&
    url.searchParams.get('model') === MODEL &&
    url.searchParams.get('request_id') === REQUEST_ID
      ? payload
      : undefined
  );
}

async function runTee(args: string[], handle: StubHandler): Promise<CliResult> {
  const server = createServer((req, res) => {
    const body = handle(new URL(req.url ?? '/', 'http://127.0.0.1'));
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-tee-'));

  try {
    return await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'tee', ...args], {
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

const SIGNED_TEXT = 'request-hash:response-hash';
const WRONG_SIGNER = '0000000000000000000000000000000000000000';

function signedPayload(): { payload: Record<string, unknown>; signer: string } {
  const key = new elliptic.ec('secp256k1').genKeyPair();
  const messageBytes = new TextEncoder().encode(SIGNED_TEXT);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const digest = keccak_256(Buffer.concat([prefix, messageBytes]));
  const sig = key.sign(Buffer.from(digest), { canonical: true });
  const v = 27 + (sig.recoveryParam ?? 0);
  const signature = `0x${sig.r.toString(16, 64)}${sig.s.toString(16, 64)}${v.toString(16)}`;
  const signer = deriveSigningAddressFromKey(key.getPublic(false, 'hex'));
  assert.ok(signer);

  return {
    signer,
    payload: {
      model: MODEL,
      request_id: REQUEST_ID,
      text: SIGNED_TEXT,
      signature,
      signing_address: `0x${signer}`,
      tee_provider: 'test',
    },
  };
}

test('tee signature --verify-signer exits 0 when the recovered signer matches', async () => {
  const { payload, signer } = signedPayload();
  const expected = `0x${signer.toUpperCase()}`;

  const pretty = await runTeeSignature(payload, ['--verify-signer', expected]);
  assert.equal(pretty.status, 0, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, new RegExp(`Recovered Signer: ${signer}`));
  assert.match(pretty.stdout, /Signer Verified: ✓ Yes/);

  const json = await runTeeSignature(payload, ['--verify-signer', expected, '-f', 'json']);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    ...payload,
    verification: { expectedSigner: signer, recoveredSigner: signer, verified: true },
  });
});

test('tee signature --verify-signer exits 1 when the recovered signer does not match', async () => {
  const { payload, signer } = signedPayload();

  const pretty = await runTeeSignature(payload, ['--verify-signer', WRONG_SIGNER]);
  assert.equal(pretty.status, 1, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, new RegExp(`Signer Verified: ✗ No \\(expected ${WRONG_SIGNER}\\)`));

  const json = await runTeeSignature(payload, ['--verify-signer', WRONG_SIGNER, '-f', 'json']);
  assert.equal(json.status, 1, json.stdout + json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).verification, {
    expectedSigner: WRONG_SIGNER,
    recoveredSigner: signer,
    verified: false,
  });
});

test('tee signature --verify-signer exits 1 when the signer cannot be recovered', async () => {
  const { payload, signer } = signedPayload();
  const cases: Record<string, unknown>[] = [
    { ...payload, text: undefined },
    { ...payload, signature: undefined },
    { ...payload, signature: '0xdeadbeef' },
  ];

  for (const unrecoverable of cases) {
    const pretty = await runTeeSignature(unrecoverable, ['--verify-signer', signer]);
    assert.equal(pretty.status, 1, pretty.stdout + pretty.stderr);
    assert.match(pretty.stdout, /Signer Verified: ✗ No \(could not recover signer\)/);

    const json = await runTeeSignature(unrecoverable, ['--verify-signer', signer, '-f', 'json']);
    assert.equal(json.status, 1, json.stdout + json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).verification, {
      expectedSigner: signer,
      recoveredSigner: null,
      verified: false,
    });
  }
});

test('tee signature without --verify-signer exits 0 and prints the raw payload as JSON', async () => {
  const { payload } = signedPayload();
  const mismatched = { ...payload, text: 'tampered' };

  const json = await runTeeSignature(mismatched, ['-f', 'json']);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), mismatched);

  const pretty = await runTeeSignature(mismatched);
  assert.equal(pretty.status, 0, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /TEE Response Signature/);
  assert.doesNotMatch(pretty.stdout, /Signer Verified/);
});
