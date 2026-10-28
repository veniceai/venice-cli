import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDecimalOption, parseIntegerOption } from './options.js';

test('parseIntegerOption accepts plain integers inside the range', () => {
  assert.equal(parseIntegerOption('7', '--n'), 7);
  assert.equal(parseIntegerOption('-3', '--n', { min: -5 }), -3);
  assert.equal(parseIntegerOption('007', '--n'), 7);
  assert.equal(parseIntegerOption('20', '--n', { min: 1, max: 20 }), 20);
  assert.equal(parseIntegerOption('4', '--n', { allowed: [1, 2, 4] }), 4);
  assert.equal(parseIntegerOption(undefined, '--n'), undefined);
});

test('parseIntegerOption rejects anything but a plain integer', () => {
  for (const value of [
    '', ' ', ' 3 ', '3 ', '1e1', '1E1', '2.9', '2.0', '12abc', '0x10', '0b1', '0o7',
    'NaN', 'Infinity', '-Infinity', '+3', '--3', '1_000', '1,000', '9007199254740992', '١٢',
  ]) {
    assert.throws(
      () => parseIntegerOption(value, '--results', { min: 1, max: 20 }),
      { message: `--results must be an integer between 1 and 20 (got ${JSON.stringify(value)}).` },
      JSON.stringify(value)
    );
  }
});

test('parseIntegerOption enforces the range and names the option', () => {
  assert.throws(() => parseIntegerOption('0', '--limit', { min: 1 }), /^Error: --limit must be a positive integer \(got "0"\)\.$/);
  assert.throws(() => parseIntegerOption('-1', '--offset', { min: 0 }), /^Error: --offset must be an integer of at least 0 \(got "-1"\)\.$/);
  assert.throws(() => parseIntegerOption('21', '--results', { min: 1, max: 20 }), /--results must be an integer between 1 and 20/);
  assert.throws(() => parseIntegerOption('3', '--factor', { allowed: [1, 2, 4] }), /^Error: --factor must be 1, 2, or 4 \(got "3"\)\.$/);
  assert.throws(() => parseIntegerOption('3', '--scale', { allowed: [2, 4] }), /^Error: --scale must be 2 or 4 \(got "3"\)\.$/);
});

test('parseDecimalOption accepts plain decimals inside the range', () => {
  assert.equal(parseDecimalOption('1.25', '--speed'), 1.25);
  assert.equal(parseDecimalOption('.5', '--speed'), 0.5);
  assert.equal(parseDecimalOption('5.', '--speed'), 5);
  assert.equal(parseDecimalOption('-0.5', '--x', { min: -1 }), -0.5);
  assert.equal(parseDecimalOption('20', '--cfg-scale', { min: 0, max: 20, exclusiveMin: true }), 20);
  assert.equal(parseDecimalOption(undefined, '--temperature'), undefined);
});

test('parseDecimalOption rejects anything but a plain decimal', () => {
  for (const value of ['', ' 3 ', '1e1', '1e309', '0x10', '12abc', 'NaN', 'Infinity', '.', '-', '1.2.3', '+1']) {
    assert.throws(
      () => parseDecimalOption(value, '--temperature', { min: 0, max: 2 }),
      { message: `--temperature must be a number between 0 and 2 (got ${JSON.stringify(value)}).` },
      JSON.stringify(value)
    );
  }
  assert.throws(
    () => parseDecimalOption('0', '--cfg-scale', { min: 0, max: 20, exclusiveMin: true }),
    /^Error: --cfg-scale must be a number greater than 0 and at most 20 \(got "0"\)\.$/
  );
  assert.throws(
    () => parseDecimalOption('9'.repeat(400), '--usd-limit', { min: 0, max: 9_999_999_999 }),
    /--usd-limit must be a number between 0 and 9999999999/
  );
});
