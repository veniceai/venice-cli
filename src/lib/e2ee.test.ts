import assert from 'node:assert/strict';
import test from 'node:test';
import { hexToBytes, parseHex } from './e2ee.js';

test('hexToBytes decodes even-length hex with an optional 0x prefix and rejects anything else', () => {
  assert.deepEqual(hexToBytes('00ff10Ab'), Uint8Array.from([0x00, 0xff, 0x10, 0xab]));
  assert.deepEqual(hexToBytes('0x0aB1'), Uint8Array.from([0x0a, 0xb1]));
  assert.deepEqual(hexToBytes(''), new Uint8Array());

  for (const invalid of ['zz00gg11', 'abc', '0x0', ' 00', '00 ', '+0', '-1', '1g', '0x0x00', '0X00']) {
    assert.throws(() => hexToBytes(invalid), /Invalid hex string/, invalid);
    assert.equal(parseHex(invalid), undefined, invalid);
  }
});
