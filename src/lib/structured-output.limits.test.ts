import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_STRUCTURED_RESPONSE_BYTES,
  parseStructuredContent,
  validateAgainstSchema,
} from './structured-output.js';

function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

test('parseStructuredContent extracts the first fenced block', () => {
  assert.deepEqual(parseStructuredContent('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStructuredContent('```JSON {"a":1} ```'), { a: 1 });
  assert.deepEqual(parseStructuredContent('Here you go:\n```\n[1, 2]\n```\nDone.'), [1, 2]);
  assert.deepEqual(parseStructuredContent('```json\n{"a":1}\n``` and ```{"b":2}```'), { a: 1 });
  assert.deepEqual(parseStructuredContent('  {"plain": true}  '), { plain: true });
  assert.throws(() => parseStructuredContent('```json\n{"a":1}'), /not valid JSON/);
  assert.throws(() => parseStructuredContent('``````'), /not valid JSON/);
});

test('an unclosed code fence fails promptly', () => {
  const reply = `\`\`\`json${' '.repeat(256 * 1024)}{}`;
  const ms = elapsedMs(() => {
    assert.throws(() => parseStructuredContent(reply), /Model response was not valid JSON/);
  });
  assert.ok(ms < 250, `parsing took ${ms.toFixed(0)} ms`);
});

test('structured replies over 1 MiB are rejected before parsing', () => {
  const atLimit = JSON.stringify('a'.repeat(MAX_STRUCTURED_RESPONSE_BYTES - 2));
  assert.equal((parseStructuredContent(atLimit) as string).length, MAX_STRUCTURED_RESPONSE_BYTES - 2);

  assert.throws(
    () => parseStructuredContent(JSON.stringify('a'.repeat(MAX_STRUCTURED_RESPONSE_BYTES))),
    /exceeds the 1048576-byte \(1 MiB\) structured output limit/
  );
  // The limit counts UTF-8 bytes, not UTF-16 code units.
  assert.throws(
    () => parseStructuredContent(JSON.stringify('é'.repeat(MAX_STRUCTURED_RESPONSE_BYTES / 2))),
    /exceeds/
  );
});

test('format "url" accepts http, https and ftp URLs only', () => {
  const schema = { type: 'string', format: 'url' };
  for (const value of [
    'https://example.com',
    'http://example.com:8080/a/b?c=d#e',
    'ftp://files.example.org/pub',
    'HTTPS://EXAMPLE.COM',
  ]) {
    assert.deepEqual(validateAgainstSchema(value, schema), [], value);
  }
  for (const value of [
    'example.com',
    'http://',
    'mailto:someone@example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://exa mple.com',
    ' http://example.com',
    'http://example.com/a b',
    '',
  ]) {
    assert.deepEqual(validateAgainstSchema(value, schema), ['$: must match format "url"'], value);
  }
});

test('format "url" validation is linear in the string length', () => {
  const schema = { type: 'string', format: 'url' };
  const value = `http://${':'.repeat(100 * 1024)}`;
  const ms = elapsedMs(() => {
    assert.deepEqual(validateAgainstSchema(value, schema), ['$: must match format "url"']);
  });
  assert.ok(ms < 250, `validation took ${ms.toFixed(0)} ms`);
});

test('uniqueItems compares items by value in linear time', () => {
  const objectItems = { type: 'array', items: { type: 'object' }, uniqueItems: true };
  const items = Array.from({ length: 16_000 }, (_, i) => ({ a: i, b: [i, { c: 'x' }] }));
  const ms = elapsedMs(() => {
    assert.deepEqual(validateAgainstSchema(items, objectItems), []);
    assert.deepEqual(validateAgainstSchema([...items, { b: [5, { c: 'x' }], a: 5 }], objectItems), [
      '$: must NOT have duplicate items (items ## 5 and 16000 are identical)',
    ]);
  });
  assert.ok(ms < 500, `validation took ${ms.toFixed(0)} ms`);

  const untyped = { type: 'array', uniqueItems: true };
  assert.deepEqual(validateAgainstSchema([1, '1', true, null, [1], { a: 1 }], untyped), []);
  assert.equal(validateAgainstSchema([0, -0], untyped).length, 1);
  assert.equal(validateAgainstSchema([[1, 2], [1, 2]], untyped).length, 1);
  assert.equal(validateAgainstSchema([{ a: 1, b: 2 }, { b: 2, a: 1 }], untyped).length, 1);
  assert.deepEqual(validateAgainstSchema([1, 1], { type: 'array', uniqueItems: false }), []);
});

test('enum values must still be unique in draft-07 schemas', () => {
  assert.throws(
    () => validateAgainstSchema('a', { enum: ['a', 'b', 'a'] }),
    /enum must NOT have duplicate items/
  );
});
