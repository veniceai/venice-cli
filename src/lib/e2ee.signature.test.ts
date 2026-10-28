import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveSigningAddressFromKey, recoverSignerAddress } from './e2ee.js';

const SIGNER_PUBLIC_KEY =
  '044e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e47fd35c4215d1edf53e6f83de344615ce719bdb0fd878f6ed76f06dd277956de';
const SIGNER_ADDRESS = '2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const MESSAGE = 'Some data';
const SIGNATURE =
  '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';
const COMPACT_SIGNATURE = SIGNATURE.slice(2, 130);

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
