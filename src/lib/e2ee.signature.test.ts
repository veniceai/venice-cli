import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { deriveSigningAddressFromKey, recoverSignerAddress, verifySignature } from './e2ee.js';

const SIGNER_PUBLIC_KEY =
  '044e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e47fd35c4215d1edf53e6f83de344615ce719bdb0fd878f6ed76f06dd277956de';
const SIGNER_ADDRESS = '2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const MESSAGE = 'Some data';
const SIGNATURE =
  '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';
const COMPACT_SIGNATURE = SIGNATURE.slice(2, 130);

const REQUEST = '{"messages":[{"role":"user","content":"Résumé, please"}]}';
const REPLY = 'Here is your résumé ✓';

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function makeSigner() {
  const privateKey = secp256k1.utils.randomSecretKey();
  const address = deriveSigningAddressFromKey(Buffer.from(secp256k1.getPublicKey(privateKey, false)).toString('hex'));
  assert.ok(address);

  return {
    address,
    sign(signedText: string) {
      const message = new TextEncoder().encode(signedText);
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
      const signature = secp256k1.sign(keccak_256(Buffer.concat([prefix, message])), privateKey);
      const v = (27 + signature.recovery).toString(16);
      return {
        signedText,
        signatureHex: `0x${Buffer.from(signature.toBytes('compact')).toString('hex')}${v}`,
        expectedSigningAddress: address,
      };
    },
  };
}

test('recoverSignerAddress recovers the EIP-191 signer of an r||s||v signature', () => {
  assert.equal(deriveSigningAddressFromKey(SIGNER_PUBLIC_KEY), SIGNER_ADDRESS);
  assert.equal(recoverSignerAddress(MESSAGE, SIGNATURE), SIGNER_ADDRESS);
  assert.equal(recoverSignerAddress(MESSAGE, SIGNATURE.slice(2)), SIGNER_ADDRESS);
  assert.equal(recoverSignerAddress(MESSAGE, `${COMPACT_SIGNATURE}01`), SIGNER_ADDRESS);
  assert.notEqual(recoverSignerAddress(`${MESSAGE}.`, SIGNATURE), SIGNER_ADDRESS);
});

test('recoverSignerAddress returns null for a signature it cannot recover', () => {
  const cases: Record<string, string> = {
    'v of 29': `${COMPACT_SIGNATURE}1d`,
    'v of 2': `${COMPACT_SIGNATURE}02`,
    'missing v': COMPACT_SIGNATURE,
    'trailing byte': `${SIGNATURE}00`,
    'non-hex digits': `${COMPACT_SIGNATURE.slice(0, -2)}zz1c`,
    'zero r': `${'00'.repeat(32)}${COMPACT_SIGNATURE.slice(64)}1c`,
    short: '0xdeadbeef',
  };

  for (const [name, signature] of Object.entries(cases)) {
    assert.equal(recoverSignerAddress(MESSAGE, signature), null, name);
  }
});

test('verifySignature accepts a signature over exactly the expected reply', () => {
  const signer = makeSigner();

  assert.deepEqual(verifySignature({ ...signer.sign(REPLY), expectedContent: REPLY }), { verified: true });
  assert.deepEqual(
    verifySignature({ ...signer.sign(REPLY), expectedSigningAddress: `0x${signer.address.toUpperCase()}`, expectedContent: REPLY }),
    { verified: true }
  );
});

test('verifySignature accepts a signed hash pair only when it matches the expected request and reply', () => {
  const signer = makeSigner();
  const pair = `${sha256Hex(REQUEST)}:${sha256Hex(REPLY)}`;

  assert.deepEqual(
    verifySignature({ ...signer.sign(pair), expectedRequest: REQUEST, expectedContent: REPLY }),
    { verified: true }
  );

  const rejected: Record<string, ReturnType<typeof signer.sign>> = {
    'hash of another request': signer.sign(`${sha256Hex(`${REQUEST} `)}:${sha256Hex(REPLY)}`),
    'hash of another reply': signer.sign(`${sha256Hex(REQUEST)}:${sha256Hex(`${REPLY}.`)}`),
    'halves swapped': signer.sign(`${sha256Hex(REPLY)}:${sha256Hex(REQUEST)}`),
    'upper-case hex': signer.sign(pair.toUpperCase()),
    'reply hash alone': signer.sign(sha256Hex(REPLY)),
  };
  for (const [name, signed] of Object.entries(rejected)) {
    const result = verifySignature({ ...signed, expectedRequest: REQUEST, expectedContent: REPLY });
    assert.equal(result.verified, false, name);
    assert.match(result.error ?? '', /do not match the expected request and response/, name);
  }
});

test('verifySignature does not accept a signed hash in place of the expected reply', () => {
  const signer = makeSigner();

  for (const signedText of [sha256Hex(REPLY), `${sha256Hex(REQUEST)}:${sha256Hex(REPLY)}`, 'ab'.repeat(32)]) {
    const result = verifySignature({ ...signer.sign(signedText), expectedContent: REPLY });
    assert.equal(result.verified, false, signedText);
    assert.match(result.error ?? '', /does not match expected content/, signedText);
  }
});

test('verifySignature compares the signed text without normalising whitespace', () => {
  const signer = makeSigner();
  const cases: Array<[string, string]> = [
    ['one two', 'one\ntwo'],
    ['one  two', 'one two'],
    ['  indented\nline', 'indented\nline'],
    ['line\n', 'line'],
    ['tab\tseparated', 'tab separated'],
  ];

  for (const [signedText, shown] of cases) {
    const result = verifySignature({ ...signer.sign(signedText), expectedContent: shown });
    assert.equal(result.verified, false, JSON.stringify(shown));
  }
});

test('verifySignature does not accept a signature over the reasoning or reasoning plus reply', () => {
  const signer = makeSigner();
  const reasoning = 'Thinking about the request.';

  for (const signedText of [reasoning, `${reasoning}${REPLY}`, `${reasoning}\n${REPLY}`, `${REPLY}\n${reasoning}`]) {
    const params = { ...signer.sign(signedText), expectedContent: REPLY, expectedReasoningContent: reasoning };
    assert.equal(verifySignature(params).verified, false, JSON.stringify(signedText));
  }
});

test('verifySignature rejects another signer and an unrecoverable signature', () => {
  const signer = makeSigner();
  const other = makeSigner();

  const wrongSigner = verifySignature({ ...other.sign(REPLY), expectedSigningAddress: signer.address, expectedContent: REPLY });
  assert.equal(wrongSigner.verified, false);
  assert.match(wrongSigner.error ?? '', new RegExp(`${other.address} does not match expected ${signer.address}`));

  const unrecoverable = verifySignature({ ...signer.sign(REPLY), signatureHex: '0xdeadbeef', expectedContent: REPLY });
  assert.deepEqual(unrecoverable, { verified: false, error: 'Failed to recover signer address from signature' });
});
