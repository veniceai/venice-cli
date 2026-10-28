import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_STRUCTURED_RESPONSE_BYTES,
  parseStructuredContent,
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
