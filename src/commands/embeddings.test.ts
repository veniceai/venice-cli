import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { registerEmbeddingsCommand } from './embeddings.js';

test('embeddings accepts omitted text for stdin input', () => {
  const program = new Command();
  registerEmbeddingsCommand(program);

  const command = program.commands.find((candidate) => candidate.name() === 'embeddings');
  const textArgument = command?.registeredArguments[0];

  assert.ok(textArgument);
  assert.equal(textArgument.required, false);
  assert.equal(textArgument.variadic, true);
});

test('embeddings output creates nested directories', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalLog = console.log;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-embeddings-cli-test-'));
  const outputPath = join(tempDir, 'nested', 'vectors.json');
  const data = [{ embedding: [0.1, 0.2], index: 0 }];

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = async () => Response.json({ data });
  console.log = () => {};

  try {
    const program = new Command();
    registerEmbeddingsCommand(program);
    await program.parseAsync(['node', 'venice', 'embeddings', 'hello', '--output', outputPath]);

    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), data);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function runEmbeddings(
  args: string[],
  respond: (body: Record<string, unknown>) => unknown
): Promise<{ bodies: Array<Record<string, unknown>>; stdout: string; stderr: string; exitCode?: number }> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const bodies: Array<Record<string, unknown>> = [];
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return Response.json(respond(body));
  }) as typeof fetch;
  console.log = (...values: unknown[]) => { stdout += `${values.join(' ')}\n`; };
  console.error = (...values: unknown[]) => { stderr += `${values.join(' ')}\n`; };
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('process.exit');
  }) as typeof process.exit;

  try {
    const program = new Command();
    registerEmbeddingsCommand(program);
    await program.parseAsync(['node', 'venice', 'embeddings', ...args]).catch((error: Error) => {
      if (error.message !== 'process.exit') throw error;
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
  return { bodies, stdout, stderr, exitCode };
}

test('embeddings --encoding-format base64 sends encoding_format and decodes float32 vectors', async () => {
  const vector = Buffer.alloc(12);
  [1, 2, 3].forEach((value, index) => vector.writeFloatLE(value, index * 4));
  const result = await runEmbeddings(
    ['--encoding-format', 'base64', '-f', 'pretty', 'hello'],
    () => ({ data: [{ embedding: vector.toString('base64'), index: 0 }] })
  );

  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal(result.bodies[0].encoding_format, 'base64');
  assert.match(result.stdout, /Dimension: 3/);
  assert.match(result.stdout, /First 5 values: \[1\.0000, 2\.0000, 3\.0000\.\.\.\]/);
  assert.match(result.stdout, /Magnitude: 3\.741657/);
});

test('embeddings omits encoding_format unless it is given', async () => {
  const result = await runEmbeddings(['-f', 'json', 'hello'], () => ({ data: [{ embedding: [0.5], index: 0 }] }));
  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal('encoding_format' in result.bodies[0], false);
});

test('embeddings rejects an unknown --encoding-format before any request', async () => {
  const result = await runEmbeddings(['--encoding-format', 'int8', 'hello'], () => ({ data: [] }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--encoding-format must be float or base64/);
  assert.equal(result.bodies.length, 0);
});

test('embeddings rejects base64 that is not float32 data', async () => {
  const result = await runEmbeddings(
    ['--encoding-format', 'base64', 'hello'],
    () => ({ data: [{ embedding: 'AAAAAAA=', index: 0 }] })
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no embedding vectors were returned/);
});
