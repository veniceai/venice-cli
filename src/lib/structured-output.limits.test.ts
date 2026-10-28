import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ajv } from 'ajv';
import {
  loadResponseFormat,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_ENUM_VALUES,
  MAX_SCHEMA_NODES,
  MAX_STRUCTURED_RESPONSE_BYTES,
  normalizeResponseFormat,
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

test('a schema file is compiled once for loading, every request, and validation', () => {
  const core = Object.getPrototypeOf(Ajv.prototype) as { compile: (...args: unknown[]) => unknown };
  const originalCompile = core.compile;
  let compiles = 0;
  core.compile = function (this: unknown, ...args: unknown[]) {
    compiles++;
    return originalCompile.apply(this, args);
  };
  const dir = mkdtempSync(join(tmpdir(), 'venice-schema-once-'));
  try {
    const schemaPath = join(dir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    }));

    const format = loadResponseFormat(schemaPath);
    normalizeResponseFormat(format, 'response format');
    normalizeResponseFormat(format, 'response format');
    const schema = format.json_schema?.schema ?? {};
    assert.deepEqual(validateAgainstSchema({ n: 1 }, schema), []);
    assert.deepEqual(validateAgainstSchema({ n: 'x' }, schema), ['$/n: must be integer']);
    assert.equal(compiles, 1);
  } finally {
    core.compile = originalCompile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a definition referenced from many places is not inlined at each reference', () => {
  const definition = { type: 'object', properties: {} as Record<string, unknown> };
  const schema = { $defs: { s: definition }, type: 'object', properties: {} as Record<string, unknown> };
  for (let i = 0; i < 200; i++) {
    definition.properties[`a${i}`] = { type: 'string' };
    schema.properties[`p${i}`] = { $ref: '#/$defs/s' };
  }
  const ms = elapsedMs(() => normalizeResponseFormat(schema, 'refs'));
  assert.ok(ms < 400, `compiling took ${ms.toFixed(0)} ms`);
});

test('schemas over the size, depth, or enum limits are rejected before compiling', () => {
  const properties = (count: number) => Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`p${i}`, { type: 'string' }])
  );
  const nested = (levels: number) => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < levels; i++) schema = { type: 'array', items: schema };
    return schema;
  };
  const enumOf = (count: number) => ({
    type: 'string',
    enum: Array.from({ length: count }, (_, i) => `v${i}`),
  });

  assert.throws(
    () => normalizeResponseFormat({ type: 'object', properties: properties(MAX_SCHEMA_NODES) }, 'wide'),
    /JSON schema in "wide" has more than 1000 objects and arrays/
  );
  assert.throws(
    () => normalizeResponseFormat(nested(MAX_SCHEMA_DEPTH), 'deep'),
    /JSON schema in "deep" is nested more than 64 levels deep/
  );
  assert.throws(
    () => normalizeResponseFormat(enumOf(MAX_SCHEMA_ENUM_VALUES + 1), 'enum'),
    /JSON schema in "enum" has an enum with more than 1000 values/
  );

  const ms = elapsedMs(() => {
    normalizeResponseFormat({ type: 'object', properties: properties(MAX_SCHEMA_NODES - 2) }, 'wide');
    normalizeResponseFormat(nested(MAX_SCHEMA_DEPTH - 1), 'deep');
    normalizeResponseFormat(enumOf(MAX_SCHEMA_ENUM_VALUES), 'enum');
  });
  assert.ok(ms < 1500, `compiling schemas at the limits took ${ms.toFixed(0)} ms`);
});
