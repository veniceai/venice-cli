import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpendCap, quoteWithinCap } from './spend-cap.js';

test('quoteWithinCap only quotes an uncapped job when the price is wanted, and tolerates a failed quote', async () => {
  let quotes = 0;
  const quoted = async () => {
    quotes++;
    return { quote: 2 };
  };

  assert.equal(await quoteWithinCap(quoted, { kind: 'uncapped' }, { wantPrice: false }), undefined);
  assert.equal(quotes, 0);
  assert.equal(await quoteWithinCap(quoted, { kind: 'uncapped' }, { wantPrice: true }), 2);
  assert.equal(await quoteWithinCap(async () => { throw new Error('down'); }, { kind: 'uncapped' }, { wantPrice: true }), undefined);
});

test('quoteWithinCap refuses a capped job that costs more than the cap or cannot be quoted', async () => {
  const cap = parseSpendCap('1.5');

  assert.equal(await quoteWithinCap(async () => ({ quote: 1.5 }), cap, { wantPrice: false }), 1.5);
  await assert.rejects(
    quoteWithinCap(async () => ({ quote: 1.51 }), cap, { wantPrice: false }),
    /quoted at \$1\.51, above --max-usd 1\.5, so nothing was queued/
  );
  await assert.rejects(
    quoteWithinCap(async () => { throw new Error('quote service down'); }, cap, { wantPrice: true }),
    /Couldn't get a price to check against --max-usd, so nothing was queued\. quote service down/
  );
});

test('parseSpendCap rejects caps that are not positive numbers', () => {
  assert.deepEqual(parseSpendCap(undefined), { kind: 'uncapped' });
  for (const value of ['0', '-1', 'abc', '1e2', '']) {
    assert.throws(() => parseSpendCap(value), /--max-usd must be a number greater than 0/, value);
  }
});
