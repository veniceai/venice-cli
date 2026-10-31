import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadResponseFormat,
  MAX_SCHEMA_FILE_BYTES,
  normalizeResponseFormat,
  parseStructuredContent,
  resolveResponseFormat,
  validateAgainstSchema,
} from './structured-output.js';

const mathSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          output: { type: 'string' },
        },
        required: ['explanation', 'output'],
        additionalProperties: false,
      },
    },
    final_answer: { type: 'string' },
  },
  required: ['steps', 'final_answer'],
  additionalProperties: false,
};

test('normalizeResponseFormat wraps a raw JSON Schema', () => {
  const format = normalizeResponseFormat(mathSchema);

  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema?.name, 'response');
  assert.equal(format.json_schema?.strict, true);
  assert.deepEqual(format.json_schema?.schema, mathSchema);
});

test('normalizeResponseFormat accepts a named schema wrapper', () => {
  const format = normalizeResponseFormat({
    name: 'math_response',
    strict: true,
    schema: mathSchema,
  });

  assert.equal(format.json_schema?.name, 'math_response');
  assert.deepEqual(format.json_schema?.schema, mathSchema);
});

test('normalizeResponseFormat accepts a full response_format object', () => {
  const format = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: {
      name: 'math_response',
      schema: mathSchema,
    },
  });

  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema?.strict, true);
  assert.equal(format.json_schema?.name, 'math_response');
});

test('resolveResponseFormat accepts --json and rejects combining it with --json-schema', () => {
  const format = resolveResponseFormat({ json: true });
  assert.deepEqual(format, { type: 'json_object' });
  assert.equal(resolveResponseFormat({}), undefined);
  assert.throws(
    () => resolveResponseFormat({ json: true, jsonSchema: 'schema.json' }),
    /Cannot combine --json and --json-schema/
  );
});

test('loadResponseFormat reads a schema file and rejects missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-schema-'));

  try {
    const schemaPath = join(dir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(mathSchema));

    const format = loadResponseFormat(schemaPath);
    assert.equal(format.type, 'json_schema');
    assert.deepEqual(format.json_schema?.schema, mathSchema);

    assert.throws(
      () => loadResponseFormat(join(dir, 'missing.json')),
      /not found/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResponseFormat rejects schema files over 1 MiB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-schema-large-'));
  try {
    const schemaPath = join(dir, 'schema.json');
    writeFileSync(schemaPath, Buffer.alloc(MAX_SCHEMA_FILE_BYTES + 1, 0x20));
    assert.throws(() => loadResponseFormat(schemaPath), /exceeds.*1 MiB/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadResponseFormat remains bounded if the schema file grows after its size check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-schema-growing-'));
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, '{}');
  const originalReadSync = fs.readSync;
  let grew = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    if (!grew) {
      grew = true;
      appendFileSync(schemaPath, Buffer.alloc(MAX_SCHEMA_FILE_BYTES + 1, 0x20));
    }
    return originalReadSync(...args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();

  try {
    assert.throws(() => loadResponseFormat(schemaPath), /exceeds.*1 MiB/i);
    assert.equal(grew, true);
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeResponseFormat rejects unsafe wrappers and schemas before use', () => {
  assert.throws(
    () => normalizeResponseFormat({ name: '../unsafe', schema: mathSchema }),
    /name.*letters.*numbers/i
  );
  assert.throws(
    () => normalizeResponseFormat({ name: 'safe', strict: 'yes', schema: mathSchema }),
    /strict.*boolean/i
  );
  assert.throws(
    () => normalizeResponseFormat({ type: 'object', unknownKeyword: true }),
    /Invalid or unsupported JSON schema.*unknown keyword/i
  );
  assert.throws(
    () => normalizeResponseFormat({ type: 'text' }),
    /Invalid or unsupported JSON schema/i
  );
  assert.throws(
    () => normalizeResponseFormat({ type: 'definitely-not-a-json-schema-type' }),
    /Invalid or unsupported JSON schema/i
  );
});

test('parseStructuredContent extracts JSON from fenced responses', () => {
  const parsed = parseStructuredContent('```json\n{"final_answer":"4"}\n```');
  assert.deepEqual(parsed, { final_answer: '4' });
});

test('validateAgainstSchema reports missing and extra fields', () => {
  const valid = {
    steps: [{ explanation: 'add', output: '2+2' }],
    final_answer: '4',
  };
  assert.deepEqual(validateAgainstSchema(valid, mathSchema), []);

  const missing = { steps: [] };
  const missingErrors = validateAgainstSchema(missing, mathSchema);
  assert.ok(missingErrors.some((error) => error.includes('final_answer')));

  const extra = { ...valid, extra: true };
  const extraErrors = validateAgainstSchema(extra, mathSchema);
  assert.ok(extraErrors.some((error) => error.includes('unexpected property')));
});

test('validateAgainstSchema enforces modern constraints, composition, and local refs', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      tag: { type: 'string', minLength: 2, maxLength: 5, pattern: '^[a-z]+$' },
    },
    type: 'object',
    properties: {
      status: { enum: ['ready', 'done'] },
      version: { const: 2 },
      score: { type: 'number', minimum: 0, maximum: 10 },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        items: { $ref: '#/$defs/tag' },
      },
      choice: {
        oneOf: [
          { type: 'string', minLength: 3 },
          { type: 'integer', minimum: 100 },
        ],
      },
      nested: {
        allOf: [{
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          additionalProperties: false,
        }],
      },
    },
    required: ['status', 'version', 'score', 'tags', 'choice', 'nested'],
    additionalProperties: false,
  };

  const valid = {
    status: 'ready',
    version: 2,
    score: 7,
    tags: ['ok'],
    choice: 101,
    nested: { enabled: true },
  };
  assert.deepEqual(validateAgainstSchema(valid, schema), []);

  const violations: Array<[Record<string, unknown>, string]> = [
    [{ status: 'waiting' }, 'allowed values'],
    [{ version: 1 }, 'equal to constant'],
    [{ score: 11 }, '<= 10'],
    [{ tags: ['ab', 'cd', 'ef'] }, 'more than 2 items'],
    [{ tags: ['ab', 'ab'] }, 'duplicate items'],
    [{ tags: ['AB'] }, 'must match pattern'],
    [{ choice: 'x' }, 'oneOf'],
    [{ nested: {} }, 'missing required property "enabled"'],
    [{ nested: { enabled: true, extra: true } }, 'unexpected property "extra"'],
  ];
  for (const [change, expected] of violations) {
    const errors = validateAgainstSchema({ ...valid, ...change }, schema);
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `${JSON.stringify(change)}: ${errors.join('; ')}`
    );
  }
});
