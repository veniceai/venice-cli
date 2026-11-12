import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { deriveSigningAddressFromKey, generateEphemeralKeyPair, recoverSignerAddress } from '../lib/e2ee.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const MODEL = 'e2ee-test-model';
const REQUEST_ID = 'cmpl-1';
const REPLY = 'The enclave reply.\n';
const REQUEST = '{"messages":[{"role":"user","content":"Hello"}]}';

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

function signEip191(text: string, key: KeyPair): string {
  const message = Buffer.from(text, 'utf8');
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), message]));
  const sig = secp256k1.sign(digest, key.privateKey);
  const signature = `0x${Buffer.from(sig.toBytes('compact')).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  assert.equal(recoverSignerAddress(text, signature), deriveSigningAddressFromKey(key.publicKeyHex));
  return signature;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const PAIR_TEXT = `${sha256(REQUEST)}:${sha256(REPLY)}`;

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
const withRequestAndReplyFiles = (...extra: string[]) => (dir: string) =>
  signatureArgs('--expect-request', join(dir, 'request.txt'), '--expect-content', join(dir, 'reply.txt'), ...extra);
const SIGNED_FILES = { 'request.txt': REQUEST, 'reply.txt': REPLY };

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
  assert.match(shown.stdout, /Not verified: pass --verify-signer <address> with --expect-content or --expect-sha256/);

  const checked = await runTee(signatureArgs('--expect-sha256', sha256(REPLY), '--verify-signer', enclaveAddress), routes);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /has no request ID, so it cannot be matched to cmpl-1/);
});

test('tee signature passes only for the request and reply signed by the --verify-signer key', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT), '/tee/attestation': attestationRoute() };
  const check = (...extra: string[]) => withRequestAndReplyFiles('--verify-signer', `0x${enclaveAddress}`, ...extra);

  const pretty = await runTee(check(), routes, SIGNED_FILES);
  assert.equal(pretty.status, 0, pretty.stdout + pretty.stderr);
  assert.deepEqual(pretty.requests, ['/tee/signature']);
  assert.match(pretty.stdout, new RegExp(`Expected Signer: ${enclaveAddress} \\(from --verify-signer\\)`));
  assert.match(pretty.stdout, /Signer Match: Yes/);
  assert.match(pretty.stdout, /Response Match: Yes/);
  assert.match(pretty.stdout, /Request Match: Yes/);
  assert.match(pretty.stdout, /Verified: ✓ Yes\n/);

  const json = await runTee(check('-f', 'json'), routes, SIGNED_FILES);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.deepEqual(json.requests, ['/tee/signature']);
  assert.deepEqual(JSON.parse(json.stdout).verification, {
    expectedSigner: enclaveAddress,
    recoveredSigner: enclaveAddress,
    expectedResponseSha256: sha256(REPLY),
    signedResponseSha256: sha256(REPLY),
    responseMatch: true,
    expectedRequestSha256: sha256(REQUEST),
    signedRequestSha256: sha256(REQUEST),
    requestMatch: true,
    verified: true,
  });

  for (const shown of [REPLY.trimEnd(), 'A reply the enclave never signed.\n']) {
    const mismatch = await runTee(check(), routes, { ...SIGNED_FILES, 'reply.txt': shown });
    assert.equal(mismatch.status, 1, JSON.stringify(shown));
    assert.match(mismatch.stdout, /Response Match: No/);
    assert.match(mismatch.stdout, /Verified: ✗ No/);
  }

  for (const sent of [`${REQUEST}\n`, '{"messages":[{"role":"user","content":"Something else"}]}']) {
    const mismatch = await runTee(check(), routes, { ...SIGNED_FILES, 'request.txt': sent });
    assert.equal(mismatch.status, 1, JSON.stringify(sent));
    assert.match(mismatch.stdout, /Response Match: Yes/);
    assert.match(
      mismatch.stdout,
      new RegExp(`Request Match: No \\(signed request SHA-256 ${sha256(REQUEST)}, expected ${sha256(sent)}\\)`)
    );
    assert.match(mismatch.stdout, /Verified: ✗ No/);
  }
});

test('tee signature fails a hash-pair signature unless the request half is checked too', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT) };
  const requestDigest = sha256(REQUEST);

  const pretty = await runTee(withReplyFile('--verify-signer', enclaveAddress), routes, { 'reply.txt': REPLY });
  assert.equal(pretty.status, 1, pretty.stdout + pretty.stderr);
  assert.match(pretty.stdout, /Response Match: Yes/);
  assert.match(
    pretty.stdout,
    new RegExp(
      `Request Match: No \\(the signature covers request SHA-256 ${requestDigest}; pass --expect-request or --expect-request-sha256\\)`
    )
  );
  assert.match(pretty.stdout, /Verified: ✗ No/);

  const json = await runTee(withReplyFile('--verify-signer', enclaveAddress, '-f', 'json'), routes, { 'reply.txt': REPLY });
  assert.equal(json.status, 1, json.stdout + json.stderr);
  const { verification } = JSON.parse(json.stdout);
  assert.equal(verification.responseMatch, true);
  assert.equal(verification.expectedRequestSha256, null);
  assert.equal(verification.signedRequestSha256, requestDigest);
  assert.equal(verification.requestMatch, false);
  assert.equal(verification.verified, false);

  for (const expected of [requestDigest, `0x${requestDigest.toUpperCase()}`]) {
    const args = withReplyFile('--verify-signer', enclaveAddress, '--expect-request-sha256', expected);
    const result = await runTee(args, routes, { 'reply.txt': REPLY });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Request Match: Yes/);
  }
});

test('tee signature rejects a signature over another request even when the unsigned fields name this one', async () => {
  const anotherRequest = '{"messages":[{"role":"user","content":"Another prompt"}]}';
  const routes = {
    '/tee/signature': signatureRoute(`${sha256(anotherRequest)}:${sha256(REPLY)}`, enclave, {
      payload: { request_hash: sha256(REQUEST), response_hash: sha256(REPLY) },
    }),
  };

  const result = await runTee(withRequestAndReplyFiles('--verify-signer', enclaveAddress, '-f', 'json'), routes, SIGNED_FILES);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { request_id: requestId, verification } = JSON.parse(result.stdout);
  assert.equal(requestId, REQUEST_ID);
  assert.equal(verification.recoveredSigner, enclaveAddress);
  assert.equal(verification.responseMatch, true);
  assert.equal(verification.signedRequestSha256, sha256(anotherRequest));
  assert.equal(verification.requestMatch, false);
  assert.equal(verification.verified, false);
});

test('tee signature marks a pass over the reply alone as not covering a request', async () => {
  const digest = sha256(REPLY);

  for (const [label, text] of Object.entries({ 'a bare hash': digest, 'the reply itself': REPLY })) {
    const routes = { '/tee/signature': signatureRoute(text) };
    const replyOnly = (...extra: string[]) =>
      signatureArgs('--verify-signer', enclaveAddress, '--expect-sha256', digest, ...extra);

    const pretty = await runTee(replyOnly(), routes);
    assert.equal(pretty.status, 0, `${label}: ${pretty.stdout}${pretty.stderr}`);
    assert.match(pretty.stdout, /Request Match: not covered \(the signature covers the reply only\)/, label);
    assert.match(pretty.stdout, /Verified: ✓ Yes \(reply only; the signature does not cover a request\)/, label);

    const json = await runTee(replyOnly('-f', 'json'), routes);
    assert.equal(json.status, 0, `${label}: ${json.stdout}${json.stderr}`);
    const { verification } = JSON.parse(json.stdout);
    assert.equal(verification.signedRequestSha256, null, label);
    assert.equal(verification.requestMatch, null, label);
    assert.equal(verification.verified, true, label);

    const withRequest = await runTee(replyOnly('--expect-request-sha256', sha256(REQUEST)), routes);
    assert.equal(withRequest.status, 1, label);
    assert.match(withRequest.stdout, /Request Match: No \(the signature covers the reply only, not a request\)/, label);
    assert.match(withRequest.stdout, /Verified: ✗ No/, label);
  }
});

test('tee signature --expect-sha256 accepts each signed-text format the API uses', async () => {
  const digest = sha256(REPLY);
  const signedTexts = { 'a hash pair': PAIR_TEXT, 'a bare hash': digest, 'the reply itself': REPLY };

  for (const [label, text] of Object.entries(signedTexts)) {
    const routes = { '/tee/signature': signatureRoute(text) };
    const request = text === PAIR_TEXT ? ['--expect-request-sha256', sha256(REQUEST)] : [];
    for (const expected of [digest, `0x${digest.toUpperCase()}`]) {
      const args = signatureArgs('--expect-sha256', expected, '--verify-signer', enclaveAddress, ...request);
      const result = await runTee(args, routes);
      assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Response Match: Yes/, label);
    }

    const wrongArgs = signatureArgs('--expect-sha256', sha256('other'), '--verify-signer', enclaveAddress, ...request);
    const wrong = await runTee(wrongArgs, routes);
    assert.equal(wrong.status, 1, label);
    assert.match(wrong.stdout, /Response Match: No/, label);
  }
});

test('tee signature rejects a reply signed by a key other than --verify-signer', async () => {
  const stranger = generateEphemeralKeyPair();
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT, stranger) };

  const result = await runTee(withRequestAndReplyFiles('--verify-signer', enclaveAddress, '-f', 'json'), routes, SIGNED_FILES);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { verification } = JSON.parse(result.stdout);
  assert.equal(verification.expectedSigner, enclaveAddress);
  assert.equal(verification.recoveredSigner, deriveSigningAddressFromKey(stranger.publicKeyHex));
  assert.equal(verification.responseMatch, true);
  assert.equal(verification.requestMatch, true);
  assert.equal(verification.verified, false);
});

test('tee signature will not check a reply without --verify-signer or take the signer from an attestation', async () => {
  const routes = { '/tee/signature': signatureRoute(PAIR_TEXT), '/tee/attestation': attestationRoute() };
  const cases = [
    withReplyFile(),
    withReplyFile('-f', 'json'),
    withRequestAndReplyFiles(),
    signatureArgs('--expect-sha256', sha256(REPLY)),
  ];

  for (const args of cases) {
    const result = await runTee(args, routes, SIGNED_FILES);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--expect-content and --expect-sha256 need --verify-signer <address>/);
    assert.match(result.stderr, /does not take the signer from the server's attestation/);
    assert.deepEqual(result.requests, []);
  }
});

test('tee signature rejects unusable expectations before any request', async () => {
  const cases: Array<[string[] | ((dir: string) => string[]), RegExp]> = [
    [signatureArgs('--expect-sha256', 'abc'), /--expect-sha256 must be a 64-character hex SHA-256 digest/],
    [withReplyFile('--expect-sha256', sha256(REPLY)), /either --expect-content or --expect-sha256, not both/],
    [(dir) => signatureArgs('--expect-content', join(dir, 'missing.txt')), /Could not read --expect-content file/],
    [signatureArgs('--verify-signer', 'not-an-address'), /--verify-signer must be a 40-character hex address/],
    [
      signatureArgs('--verify-signer', `${enclaveAddress}00`, '--expect-sha256', sha256(REPLY)),
      /--verify-signer must be a 40-character hex address/,
    ],
    [
      signatureArgs('--verify-signer', enclaveAddress, '--expect-request-sha256', sha256(REQUEST)),
      /Use --expect-request or --expect-request-sha256 together with --expect-content or --expect-sha256/,
    ],
    [
      signatureArgs('--verify-signer', enclaveAddress, '--expect-sha256', sha256(REPLY), '--expect-request-sha256', 'abc'),
      /--expect-request-sha256 must be a 64-character hex SHA-256 digest/,
    ],
    [
      (dir) =>
        signatureArgs(
          '--expect-sha256',
          sha256(REPLY),
          '--expect-request',
          join(dir, 'reply.txt'),
          '--expect-request-sha256',
          sha256(REQUEST)
        ),
      /either --expect-request or --expect-request-sha256, not both/,
    ],
    [
      (dir) => signatureArgs('--expect-sha256', sha256(REPLY), '--expect-request', join(dir, 'missing.txt')),
      /Could not read --expect-request file/,
    ],
  ];

  for (const [args, failure] of cases) {
    const result = await runTee(args, { '/tee/signature': signatureRoute(PAIR_TEXT) }, { 'reply.txt': REPLY });
    assert.equal(result.status, 1, String(failure));
    assert.match(result.stderr, failure);
    assert.deepEqual(result.requests, []);
  }
});
