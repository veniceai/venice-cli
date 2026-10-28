/**
 * Structured output helpers for chat completions.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Ajv,
  type ErrorObject,
  type SchemaValidateFunction,
  type ValidateFunction,
} from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';

export const MAX_SCHEMA_FILE_BYTES = 1024 * 1024;
export const MAX_SCHEMA_NODES = 1000;
export const MAX_SCHEMA_DEPTH = 64;
export const MAX_SCHEMA_ENUM_VALUES = 1000;
export const MAX_STRUCTURED_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_FORMAT_NAME_LENGTH = 64;
const RESPONSE_FORMAT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const URL_FORMAT_PROTOCOLS = new Set(['http:', 'https:', 'ftp:']);

// Keyed by schema object: loading the schema, building each request and
// validating the reply all pass the same object, so a run compiles it once.
const compiledSchemas = new WeakMap<object, ValidateFunction>();

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const PROMPT_CACHE_RETENTIONS = ['default', 'extended', '24h'] as const;
export type PromptCacheRetention = (typeof PROMPT_CACHE_RETENTIONS)[number];

export interface JsonSchemaWrapper {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

export interface ResponseFormat {
  type: 'json_schema' | 'json_object' | 'text';
  json_schema?: JsonSchemaWrapper;
}

export const JSON_OBJECT_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

export function resolveResponseFormat(options: {
  json?: boolean;
  jsonSchema?: string;
}): ResponseFormat | undefined {
  if (options.json && options.jsonSchema) {
    throw new Error('Cannot combine --json and --json-schema');
  }
  if (options.jsonSchema) {
    return loadResponseFormat(options.jsonSchema);
  }
  if (options.json) {
    return JSON_OBJECT_RESPONSE_FORMAT;
  }
  return undefined;
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function isPromptCacheRetention(value: string): value is PromptCacheRetention {
  return (PROMPT_CACHE_RETENTIONS as readonly string[]).includes(value);
}

export function loadResponseFormat(filePath: string): ResponseFormat {
  const resolved = resolve(filePath);
  let descriptor: number;
  try {
    descriptor = openSync(resolved, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`JSON schema file not found: ${filePath}`);
    }
    throw new Error(`Unable to open JSON schema file "${filePath}": ${errorMessage(error)}`);
  }

  let raw: string;
  try {
    const initialSize = fstatSync(descriptor).size;
    if (initialSize > MAX_SCHEMA_FILE_BYTES) {
      throw schemaSizeError(filePath);
    }

    // The fixed-size buffer and MAX+1 read limit enforce the cap even if the
    // file grows after fstatSync. No race can cause an unbounded allocation.
    const buffer = Buffer.allocUnsafe(MAX_SCHEMA_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead <= MAX_SCHEMA_FILE_BYTES) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        MAX_SCHEMA_FILE_BYTES + 1 - bytesRead,
        null
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_SCHEMA_FILE_BYTES) {
      throw schemaSizeError(filePath);
    }
    raw = buffer.toString('utf8', 0, bytesRead);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('JSON schema file exceeds')) {
      throw error;
    }
    throw new Error(`Unable to read JSON schema file "${filePath}": ${errorMessage(error)}`);
  } finally {
    closeSync(descriptor);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in schema file "${filePath}": ${errorMessage(error)}`);
  }

  return normalizeResponseFormat(parsed, filePath);
}

export function normalizeResponseFormat(parsed: unknown, source = 'schema'): ResponseFormat {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSON schema in "${source}" must be an object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.type === 'json_object') {
    return { type: 'json_object' };
  }

  if (obj.type === 'json_schema' && obj.json_schema && typeof obj.json_schema === 'object') {
    if (Array.isArray(obj.json_schema)) {
      throw new Error(`JSON schema wrapper in "${source}" must be an object`);
    }
    return {
      type: 'json_schema',
      json_schema: normalizeJsonSchemaWrapper(obj.json_schema as Record<string, unknown>, source),
    };
  }

  if (obj.schema && typeof obj.schema === 'object' && !Array.isArray(obj.schema)) {
    return {
      type: 'json_schema',
      json_schema: normalizeJsonSchemaWrapper(obj, source),
    };
  }

  // Any remaining object is a raw JSON Schema. Compilation is the authority:
  // valid schemas using enum/const/$ref/composition do not need a top-level type.
  compileSchema(obj, source);
  return {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      strict: true,
      schema: obj,
    },
  };
}

function normalizeJsonSchemaWrapper(
  wrapper: Record<string, unknown>,
  source: string
): JsonSchemaWrapper {
  const schema = wrapper.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`JSON schema wrapper in "${source}" is missing a schema object`);
  }

  let name = 'response';
  if (wrapper.name !== undefined) {
    if (typeof wrapper.name !== 'string' || !wrapper.name.trim()) {
      throw new Error(`JSON schema name in "${source}" must be a non-empty string`);
    }
    name = wrapper.name.trim();
  }
  if (
    name.length > MAX_RESPONSE_FORMAT_NAME_LENGTH ||
    !RESPONSE_FORMAT_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `JSON schema name in "${source}" must be 1-${MAX_RESPONSE_FORMAT_NAME_LENGTH} characters using only letters, numbers, "_" or "-"`
    );
  }
  if (wrapper.strict !== undefined && typeof wrapper.strict !== 'boolean') {
    throw new Error(`JSON schema strict setting in "${source}" must be a boolean`);
  }

  compileSchema(schema as Record<string, unknown>, source);

  return {
    name,
    strict: wrapper.strict === false ? false : true,
    schema: schema as Record<string, unknown>,
  };
}

export function parseStructuredContent(content: string): unknown {
  if (Buffer.byteLength(content, 'utf8') > MAX_STRUCTURED_RESPONSE_BYTES) {
    throw new Error(
      `Model response exceeds the ${MAX_STRUCTURED_RESPONSE_BYTES}-byte (1 MiB) structured output limit.`
    );
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Model returned an empty response; expected JSON.');
  }

  const extracted = extractJson(trimmed);
  try {
    return JSON.parse(extracted);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Model response was not valid JSON: ${reason}`);
  }
}

function extractJson(text: string): string {
  const fence = '```';
  const open = text.indexOf(fence);
  if (open === -1) {
    return text;
  }
  let start = open + fence.length;
  if (text.slice(start, start + 4).toLowerCase() === 'json') {
    start += 4;
  }
  const close = text.indexOf(fence, start);
  if (close === -1) {
    return text;
  }
  return text.slice(start, close).trim() || text;
}

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>
): string[] {
  const validate = compileSchema(schema, 'response schema');
  return validate(value) ? [] : formatValidationErrors(validate.errors);
}

function compileSchema(
  schema: Record<string, unknown>,
  source: string
): ValidateFunction {
  const cached = compiledSchemas.get(schema);
  if (cached) {
    return cached;
  }
  assertSchemaWithinLimits(schema, source);

  const schemaUri = typeof schema.$schema === 'string' ? schema.$schema : '';
  const options = {
    allErrors: true,
    strict: true,
    validateSchema: true,
    allowUnionTypes: true,
    inlineRefs: false,
    logger: false,
  } as const;
  const ajv = schemaUri.includes('2020-12')
    ? new Ajv2020(options)
    : schemaUri.includes('2019-09')
      ? new Ajv2019(options)
      : new Ajv(options);
  const addFormats = formatsModule.default as unknown as
    (instance: typeof ajv) => typeof ajv;
  addFormats(ajv);
  // ajv-formats' "url" regex and ajv's pairwise uniqueItems are quadratic in
  // the reply. The replacement keyword also covers the meta-schema's check
  // that enum values are unique.
  ajv.addFormat('url', isUrl);
  ajv.removeKeyword('uniqueItems');
  ajv.addKeyword({
    keyword: 'uniqueItems',
    type: 'array',
    schemaType: 'boolean',
    validate: validateUniqueItems,
  });

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`Invalid or unsupported JSON schema in "${source}": ${errorMessage(error)}`);
  }
  compiledSchemas.set(schema, validate);
  return validate;
}

// ajv's compile time and stack use grow faster than linearly with the
// number of sibling subschemas, so bound the schema before compiling it.
function assertSchemaWithinLimits(schema: Record<string, unknown>, source: string): void {
  const pending: Array<{ value: object; depth: number }> = [{ value: schema, depth: 1 }];
  let nodes = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    nodes++;
    if (nodes > MAX_SCHEMA_NODES) {
      throw new Error(
        `JSON schema in "${source}" has more than ${MAX_SCHEMA_NODES} objects and arrays.`
      );
    }
    if (next.depth > MAX_SCHEMA_DEPTH) {
      throw new Error(
        `JSON schema in "${source}" is nested more than ${MAX_SCHEMA_DEPTH} levels deep.`
      );
    }

    const children = Array.isArray(next.value) ? next.value : Object.values(next.value);
    if (!Array.isArray(next.value)) {
      const enumValues = (next.value as Record<string, unknown>).enum;
      if (Array.isArray(enumValues) && enumValues.length > MAX_SCHEMA_ENUM_VALUES) {
        throw new Error(
          `JSON schema in "${source}" has an enum with more than ${MAX_SCHEMA_ENUM_VALUES} values.`
        );
      }
    }
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        pending.push({ value: child, depth: next.depth + 1 });
      }
    }
  }
}

function isUrl(value: string): boolean {
  if (/\s/.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return URL_FORMAT_PROTOCOLS.has(url.protocol) && url.hostname !== '';
  } catch {
    return false;
  }
}

const validateUniqueItems: SchemaValidateFunction = (unique: boolean, data: unknown[]) => {
  validateUniqueItems.errors = undefined;
  if (!unique) {
    return true;
  }
  const seen = new Map<string, number>();
  for (const [i, item] of data.entries()) {
    const key = canonicalJson(item);
    const j = seen.get(key);
    if (j !== undefined) {
      validateUniqueItems.errors = [{
        keyword: 'uniqueItems',
        message: `must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
        params: { i, j },
      }];
      return false;
    }
    seen.set(key, i);
  }
  return true;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const path = error.instancePath ? `$${error.instancePath}` : '$';
    if (error.keyword === 'required') {
      return `${path}: missing required property "${String(error.params.missingProperty)}"`;
    }
    if (error.keyword === 'additionalProperties') {
      return `${path}: unexpected property "${String(error.params.additionalProperty)}"`;
    }
    return `${path}: ${error.message ?? `failed ${error.keyword} validation`}`;
  });
}

function schemaSizeError(filePath: string): Error {
  return new Error(
    `JSON schema file exceeds the ${MAX_SCHEMA_FILE_BYTES}-byte (1 MiB) limit: ${filePath}`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
