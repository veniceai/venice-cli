import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeeAttestationResponse } from './api.js';
import { deriveSigningAddressFromKey, generateEphemeralKeyPair } from './e2ee.js';
import {
  buildTeeVerificationResult,
  evaluateE2EEAttestationPolicy,
  evaluateTEEAttestationPolicy,
} from './tee.js';

const MODEL = 'e2ee-test-model';
const CLIENT_NONCE = 'ab'.repeat(32);
const DEBUG_TD_ATTRIBUTES = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);
const NVIDIA_PAYLOAD = JSON.stringify({ nonce: CLIENT_NONCE, arch: 'HOPPER', evidence_list: [] });

const enclave = generateEphemeralKeyPair();
const signingAddress = deriveSigningAddressFromKey(enclave.publicKeyHex) ?? '';
const otherAddress = deriveSigningAddressFromKey(generateEphemeralKeyPair().publicKeyHex) ?? '';

function buildTdxQuote(
  options: { reportData?: string; teeType?: number; tdAttributes?: Buffer } = {}
): string {
  const signatureData = Buffer.alloc(64);
  const quote = Buffer.alloc(636 + signatureData.length);
  quote.writeUInt16LE(4, 0);
  quote.writeUInt16LE(2, 2);
  quote.writeUInt32LE(options.teeType ?? 0x81, 4);
  options.tdAttributes?.copy(quote, 168);
  if (options.reportData) Buffer.from(options.reportData, 'hex').copy(quote, 568);
  quote.writeUInt32LE(signatureData.length, 632);
  signatureData.copy(quote, 636);
  return quote.toString('hex');
}

const serverVerification = {
  tdx: { valid: true },
  nonceBinding: { bound: true },
  verifiedAt: '2026-01-01T00:00:00.000Z',
  verificationDurationMs: 1,
};

function passingResponse(): TeeAttestationResponse {
  return {
    model: MODEL,
    nonce: CLIENT_NONCE,
    verified: true,
    signing_key: enclave.publicKeyHex,
    signing_address: signingAddress,
    intel_quote: buildTdxQuote({ reportData: signingAddress }),
    server_verification: serverVerification,
  };
}

function evaluate(policy: 'E2EE' | 'TEE', response: TeeAttestationResponse) {
  const attestation = buildTeeVerificationResult(response, CLIENT_NONCE, MODEL);
  return policy === 'E2EE'
    ? evaluateE2EEAttestationPolicy(attestation, MODEL)
    : evaluateTEEAttestationPolicy(attestation, MODEL);
}

interface BrokenField {
  name: string;
  policies: Array<'E2EE' | 'TEE'>;
  change: Partial<Record<keyof TeeAttestationResponse, unknown>>;
  failure: RegExp;
}

const BOTH: Array<'E2EE' | 'TEE'> = ['E2EE', 'TEE'];

const brokenFields: BrokenField[] = [
  { name: 'a server verdict of verified: false', policies: BOTH, change: { verified: false }, failure: /did not report this attestation as verified/ },
  { name: 'a missing server verdict', policies: BOTH, change: { verified: undefined }, failure: /did not report this attestation as verified/ },
  { name: 'a nonce other than the client nonce', policies: BOTH, change: { nonce: 'cd'.repeat(32) }, failure: /nonce mismatch/ },
  { name: 'no attestation evidence', policies: BOTH, change: { intel_quote: undefined }, failure: /No attestation evidence/ },
  { name: 'another attested model', policies: BOTH, change: { model: 'other-model' }, failure: /does not match requested model/ },
  {
    name: 'NVIDIA evidence without an Intel TDX quote',
    policies: BOTH,
    change: { intel_quote: undefined, nvidia_payload: NVIDIA_PAYLOAD, server_verification: { ...serverVerification, nvidia: { valid: true } } },
    failure: /did not include an Intel TDX quote/,
  },
  { name: 'a quote that cannot be parsed', policies: BOTH, change: { intel_quote: '00'.repeat(100) }, failure: /could not be parsed/ },
  { name: 'a quote that is not a string', policies: BOTH, change: { intel_quote: 42 }, failure: /could not be parsed/ },
  { name: 'a quote that cannot be parsed, leaving no REPORTDATA', policies: ['E2EE'], change: { intel_quote: '00'.repeat(100) }, failure: /REPORTDATA was not available/ },
  { name: 'a non-TDX TEE type', policies: BOTH, change: { intel_quote: buildTdxQuote({ reportData: signingAddress, teeType: 0 }) }, failure: /could not be parsed/ },
  {
    name: 'a debug-mode TD',
    policies: BOTH,
    change: { intel_quote: buildTdxQuote({ reportData: signingAddress, tdAttributes: DEBUG_TD_ATTRIBUTES }) },
    failure: /debug mode/,
  },
  { name: 'no server verification details', policies: BOTH, change: { server_verification: undefined }, failure: /Server verification details were not returned/ },
  {
    name: 'a nonce that the server did not bind',
    policies: BOTH,
    change: { server_verification: { ...serverVerification, nonceBinding: { bound: false } } },
    failure: /Client nonce was not bound/,
  },
  {
    name: 'a failed TDX verification',
    policies: BOTH,
    change: { server_verification: { ...serverVerification, tdx: { valid: false } } },
    failure: /Intel TDX attestation verification did not pass/,
  },
  { name: 'NVIDIA evidence without a passing NVIDIA verification', policies: BOTH, change: { nvidia_payload: NVIDIA_PAYLOAD }, failure: /NVIDIA GPU attestation verification did not pass/ },
  {
    name: 'no hardware verification results',
    policies: BOTH,
    change: { server_verification: { nonceBinding: { bound: true }, verifiedAt: '', verificationDurationMs: 0 } },
    failure: /No hardware attestation verification results/,
  },
  { name: 'an NVIDIA payload that is not JSON', policies: BOTH, change: { nvidia_payload: 'not json' }, failure: /NVIDIA GPU attestation payload is not a valid JSON object/ },
  { name: 'an NVIDIA payload that is not an object', policies: BOTH, change: { nvidia_payload: '[]' }, failure: /NVIDIA GPU attestation payload is not a valid JSON object/ },
  { name: 'no signing key', policies: ['E2EE'], change: { signing_key: undefined }, failure: /did not include a signing public key/ },
  { name: 'a signing key that is not an uncompressed secp256k1 key', policies: ['E2EE'], change: { signing_key: `04${'11'.repeat(10)}` }, failure: /not a valid uncompressed secp256k1 key/ },
  { name: 'a signing key that is not a string', policies: ['E2EE'], change: { signing_key: 7 }, failure: /not a valid uncompressed secp256k1 key/ },
  {
    name: 'REPORTDATA bound to another key',
    policies: ['E2EE'],
    change: { intel_quote: buildTdxQuote({ reportData: otherAddress }) },
    failure: /does not match the TDX REPORTDATA binding/,
  },
  { name: 'a reported signing address for another key', policies: ['E2EE'], change: { signing_address: otherAddress }, failure: /Reported signing address does not match/ },
];

test('a well-formed attestation passes both policies', () => {
  assert.deepEqual(evaluate('E2EE', passingResponse()), { passed: true, failures: [] });
  assert.deepEqual(evaluate('TEE', passingResponse()), { passed: true, failures: [] });
});

test('the TEE policy does not require a signing key', () => {
  const response = { ...passingResponse(), signing_key: undefined, signing_address: undefined };
  assert.deepEqual(evaluate('TEE', response), { passed: true, failures: [] });
});

for (const { name, policies, change, failure } of brokenFields) {
  for (const policy of policies) {
    test(`the ${policy} policy rejects ${name}`, () => {
      const evaluation = evaluate(policy, { ...passingResponse(), ...change } as TeeAttestationResponse);
      assert.equal(evaluation.passed, false);
      assert.ok(
        evaluation.failures.some((message) => failure.test(message)),
        `expected ${failure} in:\n${evaluation.failures.join('\n')}`
      );
    });
  }
}

test('buildTeeVerificationResult falls back to signing_public_key', () => {
  const response = { ...passingResponse(), signing_key: undefined, signing_public_key: enclave.publicKeyHex };
  const attestation = buildTeeVerificationResult(response, CLIENT_NONCE, MODEL);
  assert.equal(attestation.signingKey, enclave.publicKeyHex);
  assert.deepEqual(evaluateE2EEAttestationPolicy(attestation, MODEL), { passed: true, failures: [] });
});

test('buildTeeVerificationResult records the client nonce and the server verdict', () => {
  const attestation = buildTeeVerificationResult(
    { ...passingResponse(), nonce: 'echoed', verified: 'true' as unknown as boolean },
    CLIENT_NONCE,
    MODEL
  );
  assert.equal(attestation.clientNonce, CLIENT_NONCE);
  assert.equal(attestation.nonce, 'echoed');
  assert.equal(attestation.serverVerified, false);
  assert.equal(attestation.nvidiaPayloadInvalid, false);
});
