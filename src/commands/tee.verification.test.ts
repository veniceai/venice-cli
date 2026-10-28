import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { deriveSigningAddressFromKey, generateEphemeralKeyPair, recoverSignerAddress } from '../lib/e2ee.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const MODEL = 'e2ee-test-model';
const REQUEST_ID = 'cmpl-1';
const REPLY = 'The enclave reply.\n';

type KeyPair = ReturnType<typeof generateEphemeralKeyPair>;

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

// secp256k1 arithmetic for signing test payloads without a curve library.
const CURVE_P = 2n ** 256n - 2n ** 32n - 977n;
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GENERATOR = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

function invert(a: bigint, m: bigint): bigint {
  let [low, high, lm, hm] = [mod(a, m), m, 1n, 0n];
  while (low > 1n) {
    const ratio = high / low;
    [lm, low, hm, high] = [hm - lm * ratio, high - low * ratio, lm, low];
  }
  return mod(lm, m);
}

function addPoints(a: Point, b: Point): Point {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x && mod(a.y + b.y, CURVE_P) === 0n) return null;
  const slope = a.x === b.x
    ? mod(3n * a.x * a.x * invert(2n * a.y, CURVE_P), CURVE_P)
    : mod((b.y - a.y) * invert(b.x - a.x, CURVE_P), CURVE_P);
  const x = mod(slope * slope - a.x - b.x, CURVE_P);
  return { x, y: mod(slope * (a.x - x) - a.y, CURVE_P) };
}

function multiply(scalar: bigint, point: Point): Point {
  let result: Point = null;
  for (let addend = point, k = scalar; k > 0n; k >>= 1n, addend = addPoints(addend, addend)) {
    if (k & 1n) result = addPoints(result, addend);
  }
  return result;
}

function signEip191(text: string, key: KeyPair): string {
  const message = Buffer.from(text, 'utf8');
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), message]));
  const z = BigInt(`0x${Buffer.from(digest).toString('hex')}`);
  const d = BigInt(`0x${Buffer.from(key.privateKey).toString('hex')}`);
  for (;;) {
    const k = mod(BigInt(`0x${randomBytes(32).toString('hex')}`), CURVE_N);
    const point = k === 0n ? null : multiply(k, GENERATOR);
    if (!point) continue;
    const r = mod(point.x, CURVE_N);
    let s = mod(invert(k, CURVE_N) * (z + r * d), CURVE_N);
    if (r === 0n || s === 0n) continue;
    let recovery = Number(point.y & 1n);
    if (s > CURVE_N / 2n) {
      s = CURVE_N - s;
      recovery ^= 1;
    }
    const signature = `0x${r.toString(16).padStart(64, '0')}${s.toString(16).padStart(64, '0')}${(27 + recovery).toString(16)}`;
    assert.equal(recoverSignerAddress(text, signature), deriveSigningAddressFromKey(key.publicKeyHex));
    return signature;
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const PAIR_TEXT = `${sha256('the request')}:${sha256(REPLY)}`;

function signatureRoute(text: string, key: KeyPair = enclave, change: Record<string, unknown> = {}) {
  const payload = {
    model: MODEL,
    request_id: REQUEST_ID,
    text,
    signature: signEip191(text, key),
    signing_address: `0x${deriveSigningAddressFromKey(key.publicKeyHex)}`,
    tee_provider: 'test',
    ...change,
  };
  return (url: URL) =>
    url.searchParams.get('request_id') === REQUEST_ID && url.searchParams.get('model') === MODEL ? payload : undefined;
}

const signatureArgs = (...extra: string[]) => ['signature', MODEL, REQUEST_ID, ...extra];
const withReplyFile = (...extra: string[]) => (dir: string) =>
  signatureArgs('--expect-content', join(dir, 'reply.txt'), ...extra);

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

test('tee verify says a pass rests on the server report and is not verified client-side', async () => {
  const routes = { '/tee/attestation': attestationRoute() };

  const pretty = await runTee(['verify', MODEL], routes);
  assert.equal(pretty.status, 0, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /PASSED - The server's attestation report passed the E2EE policy checks/);
  assert.match(pretty.stdout, /the CLI checks it for internal consistency only/);
  assert.match(pretty.stdout, /quote signature and enclave measurements are not verified client-side/);
  assert.doesNotMatch(pretty.stdout, /valid for E2EE/);

  const json = await runTee(['verify', MODEL, '-f', 'json'], routes);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.passed, true);
  assert.match(report.note, /not verified client-side/);
});

test('tee attestation labels the server verdict and says what is not verified client-side', async () => {
  const result = await runTee(['attestation', MODEL], { '/tee/attestation': attestationRoute() });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Server Verified: ✓ Yes/);
  assert.match(result.stdout, /quote signature and enclave measurements are not verified client-side/);
});

test('tee signature fails when the response is for another request ID', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT, enclave, { request_id: 'cmpl-other' }) };

  for (const extra of [[], ['-f', 'json'], ['--verify-signer', enclaveAddress]]) {
    const result = await runTee(signatureArgs(...extra), routes);
    assert.equal(result.status, 1, extra.join(' '));
    assert.equal(result.stdout, '', extra.join(' '));
    assert.match(result.stderr, /signature response is for request cmpl-other, not cmpl-1/, extra.join(' '));
  }
});

test('tee signature without a request ID can be shown but not checked', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT, enclave, { request_id: undefined }) };

  const shown = await runTee(signatureArgs(), routes);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /Not verified: pass --expect-content or --expect-sha256/);

  const checked = await runTee(signatureArgs('--expect-sha256', sha256(REPLY)), routes);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /has no request ID, so it cannot be matched to cmpl-1/);
});

test('tee signature --expect-content passes only for the signed reply, with the signer from a fresh attestation', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT), '/tee/attestation': attestationRoute() };

  const pretty = await runTee(withReplyFile(), routes, { 'reply.txt': REPLY });
  assert.equal(pretty.status, 0, pretty.stdout + pretty.stderr);
  assert.ok(pretty.requests.includes('/tee/attestation'));
  assert.match(pretty.stdout, new RegExp(`Expected Signer: ${enclaveAddress} \\(from a fresh attestation\\)`));
  assert.match(pretty.stdout, /Signer Match: Yes/);
  assert.match(pretty.stdout, /Response Match: Yes/);
  assert.match(pretty.stdout, /Verified: ✓ Yes\n/);

  const json = await runTee(withReplyFile('-f', 'json'), routes, { 'reply.txt': REPLY });
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).verification, {
    expectedSigner: enclaveAddress,
    recoveredSigner: enclaveAddress,
    attestation: { passed: true, failures: [] },
    expectedResponseSha256: sha256(REPLY),
    signedResponseSha256: sha256(REPLY),
    responseMatch: true,
    verified: true,
  });

  for (const shown of [REPLY.trimEnd(), 'A reply the enclave never signed.\n']) {
    const mismatch = await runTee(withReplyFile(), routes, { 'reply.txt': shown });
    assert.equal(mismatch.status, 1, JSON.stringify(shown));
    assert.match(mismatch.stdout, /Response Match: No/);
    assert.match(mismatch.stdout, /Verified: ✗ No/);
  }
});

test('tee signature --expect-sha256 accepts each signed-text format the API uses', async () => {
  const digest = sha256(REPLY);
  const signedTexts = { 'a hash pair': PAIR_TEXT, 'a bare hash': digest, 'the reply itself': REPLY };

  for (const [label, text] of Object.entries(signedTexts)) {
    const routes = { '/tee/signature': signatureRoute(text) };
    for (const expected of [digest, `0x${digest.toUpperCase()}`]) {
      const result = await runTee(signatureArgs('--expect-sha256', expected, '--verify-signer', enclaveAddress), routes);
      assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Response Match: Yes/, label);
    }

    const wrong = await runTee(signatureArgs('--expect-sha256', sha256('other'), '--verify-signer', enclaveAddress), routes);
    assert.equal(wrong.status, 1, label);
    assert.match(wrong.stdout, /Response Match: No/, label);
  }
});

test('tee signature rejects a signer other than the attested enclave key', async () => {
  const stranger = generateEphemeralKeyPair();
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT, stranger), '/tee/attestation': attestationRoute() };

  const result = await runTee(withReplyFile('-f', 'json'), routes, { 'reply.txt': REPLY });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { verification } = JSON.parse(result.stdout);
  assert.equal(verification.expectedSigner, enclaveAddress);
  assert.equal(verification.recoveredSigner, deriveSigningAddressFromKey(stranger.publicKeyHex));
  assert.equal(verification.responseMatch, true);
  assert.equal(verification.verified, false);
});

test('tee signature has no expected signer when the fresh attestation fails the policy', async () => {
  const routes = {
    '/tee/signature': signatureRoute(PAIR_TEXT),
    '/tee/attestation': attestationRoute({ verified: false }),
  };

  const pretty = await runTee(withReplyFile(), routes, { 'reply.txt': REPLY });
  assert.equal(pretty.status, 1, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /Expected Signer: unavailable: the attestation did not pass the E2EE policy/);
  assert.match(pretty.stdout, /did not report this attestation as verified/);
  assert.match(pretty.stdout, /Verified: ✗ No/);

  const json = await runTee(withReplyFile('-f', 'json'), routes, { 'reply.txt': REPLY });
  assert.equal(json.status, 1);
  const { verification } = JSON.parse(json.stdout);
  assert.equal(verification.expectedSigner, null);
  assert.equal(verification.attestation.passed, false);
  assert.equal(verification.verified, false);
});

test('tee signature --verify-signer with --expect-content skips the attestation', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT) };

  const result = await runTee(withReplyFile('--verify-signer', `0x${enclaveAddress}`), routes, { 'reply.txt': REPLY });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.requests.includes('/tee/attestation'));
  assert.match(result.stdout, /Expected Signer: .* \(from --verify-signer\)/);
  assert.match(result.stdout, /Verified: ✓ Yes\n/);
});

test('tee signature rejects unusable expectations before any request', async () => {
  const cases: Array<[string[] | ((dir: string) => string[]), RegExp]> = [
    [signatureArgs('--expect-sha256', 'abc'), /--expect-sha256 must be a 64-character hex SHA-256 digest/],
    [withReplyFile('--expect-sha256', sha256(REPLY)), /either --expect-content or --expect-sha256, not both/],
    [(dir) => signatureArgs('--expect-content', join(dir, 'missing.txt')), /Could not read --expect-content file/],
  ];

  for (const [args, failure] of cases) {
    const result = await runTee(args, { '/tee/signature': signatureRoute(PAIR_TEXT) }, { 'reply.txt': REPLY });
    assert.equal(result.status, 1, String(failure));
    assert.match(result.stderr, failure);
    assert.deepEqual(result.requests, []);
  }
});
