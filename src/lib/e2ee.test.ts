import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptChunk, encryptMessage, generateEphemeralKeyPair, hexToBytes, parseHex, zeroFill } from './e2ee.js';

const KNOWN_ANSWERS = [
  {
    recipientPrivateKey: 'aeed27e139dcc31d3ad1408d986051554aed96685ded8ad50f11e1b72b7a5e8f',
    plaintext: 'Known answer: café ☕ 🔐 — naïve façade',
    ciphertext:
      '04ecda73796a443e5e7b1669701a0f0327100217968eee75fd9e5a257d0d4edaf995c7b07eed212da3a03955c7f56de50a1fdede7b5caabe2f232a08ffb052010bc721b1c15375c1502057bd82fd5c106fa5992291470d1220a9c71d1b61aff7ec5ddbe27782e3a2e16e86ea1d553517c465cba347add3f96f9115b53a0343392dc1bb86ede6a3e21a68f755',
  },
  {
    recipientPrivateKey: 'd96969640452476e580393dec11f945f1108a264b8e4145431db87676023bf8e',
    plaintext: 'Hello from the enclave',
    ciphertext:
      '0482d2c1a1fb51872e751d2b6e9367f9c18fc251deef3a2b5c682f07dcb85cb7778ee0b61cd949831eb8dc93ae99b3b3bfe6ce5e03844c23fe77ba31db97d4c000374644a390c1f50fc4b52f030105b6ae2d4a7c8ab5d5427a1cf37b9fb59cba0a7e67c943fadce8cc677065adf24796a743e8',
  },
];

function aesKeyFromSharedX(sharedX: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedX, Buffer.alloc(0), 'ecdsa_encryption', 32));
}

test('hexToBytes decodes even-length hex with an optional 0x prefix and rejects anything else', () => {
  assert.deepEqual(hexToBytes('00ff10Ab'), Uint8Array.from([0x00, 0xff, 0x10, 0xab]));
  assert.deepEqual(hexToBytes('0x0aB1'), Uint8Array.from([0x0a, 0xb1]));
  assert.deepEqual(hexToBytes(''), new Uint8Array());

  for (const invalid of ['zz00gg11', 'abc', '0x0', ' 00', '00 ', '+0', '-1', '1g', '0x0x00', '0X00']) {
    assert.throws(() => hexToBytes(invalid), /Invalid hex string/, invalid);
    assert.equal(parseHex(invalid), undefined, invalid);
  }
});

test('generateEphemeralKeyPair returns a wipeable private key and its uncompressed public key', () => {
  const { privateKey, publicKeyHex } = generateEphemeralKeyPair();

  assert.ok(privateKey instanceof Uint8Array);
  assert.equal(privateKey.length, 32);
  assert.match(publicKeyHex, /^04[0-9a-f]{128}$/);
  const reference = createECDH('secp256k1');
  reference.setPrivateKey(privateKey);
  assert.equal(reference.getPublicKey('hex', 'uncompressed'), publicKeyHex);

  zeroFill(privateKey);
  assert.deepEqual(privateKey, new Uint8Array(32));
  assert.notEqual(generateEphemeralKeyPair().publicKeyHex, publicKeyHex);
});

test('node:crypto decrypts what encryptMessage produces', () => {
  const recipient = createECDH('secp256k1');
  recipient.generateKeys();
  const recipientKeyHex = recipient.getPublicKey('hex', 'uncompressed');
  const plaintext = 'Known answer: café ☕ 🔐';

  for (const modelPublicKeyHex of [recipientKeyHex, recipientKeyHex.slice(2), `0x${recipientKeyHex}`]) {
    const raw = Buffer.from(encryptMessage(plaintext, modelPublicKeyHex), 'hex');
    const ephemeralPublicKey = raw.subarray(0, 65);
    const nonce = raw.subarray(65, 77);
    const encrypted = raw.subarray(77, -16);
    const tag = raw.subarray(-16);
    assert.equal(ephemeralPublicKey[0], 0x04);
    assert.equal(encrypted.length, Buffer.byteLength(plaintext));

    const decipher = createDecipheriv('aes-256-gcm', aesKeyFromSharedX(recipient.computeSecret(ephemeralPublicKey)), nonce);
    decipher.setAuthTag(tag);
    assert.equal(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'), plaintext);
  }
});

test('decryptChunk decrypts what node:crypto produces', () => {
  const client = generateEphemeralKeyPair();
  const sender = createECDH('secp256k1');
  sender.generateKeys();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    aesKeyFromSharedX(sender.computeSecret(Buffer.from(client.publicKeyHex, 'hex'))),
    nonce
  );
  const plaintext = 'Hello from the enclave ☕';
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const chunk = Buffer.concat([sender.getPublicKey(), nonce, encrypted]).toString('hex');

  assert.equal(decryptChunk(chunk, client.privateKey), plaintext);
  assert.equal(decryptChunk(chunk.toUpperCase(), client.privateKey), plaintext);
});

test('decryptChunk decrypts known-answer ciphertexts in the E2EE wire format', () => {
  for (const { recipientPrivateKey, plaintext, ciphertext } of KNOWN_ANSWERS) {
    assert.equal(decryptChunk(ciphertext, hexToBytes(recipientPrivateKey)), plaintext);
  }
});

test('E2EE key generation, encryption and decryption work without the WebCrypto global', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-e2ee-'));
  // Node 18 has no WebCrypto global unless it is enabled with a flag.
  const preload = join(dir, 'no-webcrypto.cjs');
  const script = join(dir, 'round-trip.mjs');
  writeFileSync(preload, 'delete globalThis.crypto;\n');
  writeFileSync(
    script,
    [
      `const e2ee = await import(${JSON.stringify(new URL('./e2ee.js', import.meta.url).href)});`,
      'const { privateKey, publicKeyHex } = e2ee.generateEphemeralKeyPair();',
      "process.stdout.write(`${typeof crypto}:${e2ee.decryptChunk(e2ee.encryptMessage('round trip', publicKeyHex), privateKey)}`);",
    ].join('\n')
  );

  try {
    const result = spawnSync(process.execPath, ['--require', preload, script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'undefined:round trip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
