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
