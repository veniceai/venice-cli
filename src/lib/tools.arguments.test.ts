import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool, getToolDefinitions, MAX_TOOL_RESULT_BYTES } from './tools.js';

const ALL_TOOLS = new Set(['calculator', 'weather', 'datetime', 'random', 'base64', 'hash']);

async function run(name: string, args: unknown): Promise<string> {
  return executeTool(name, args, { allowedTools: ALL_TOOLS });
}

test('tool arguments must match the declared parameter schema', async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['base64', { action: 'encode', text: { length: 16 } }, /\/text must be string/],
    ['base64', { action: 'decode', text: [27, 93, 48, 59, 120, 7] }, /\/text must be string/],
    ['base64', { action: 'decode', text: { length: 4 } }, /\/text must be string/],
    ['base64', { action: 'bogus', text: 'aGk=' }, /\/action must be equal to one of the allowed values/],
    ['hash', { algorithm: 'sha256', text: 42 }, /\/text must be string/],
    ['calculator', { expression: 123 }, /\/expression must be string/],
    ['calculator', {}, /must have required property 'expression'/],
    ['random', { type: 'number', min: 1.5, max: 3 }, /\/min must be integer/],
    ['random', { type: 'choice', choices: ['a', 1] }, /\/choices\/1 must be string/],
    ['weather', { location: 'Paris', units: 'kelvin' }, /\/units must be equal to one of the allowed values/],
    ['datetime', ['date'], /arguments must be object/],
  ];
  for (const [name, args, message] of cases) {
    const output = await run(name, args);
    assert.match(output, new RegExp(`^Tool error: invalid arguments for ${name}: `), `${name} ${JSON.stringify(args)}`);
    assert.match(output, message, `${name} ${JSON.stringify(args)}`);
  }
});

test('valid tool arguments still run', async () => {
  assert.equal(await run('base64', { action: 'encode', text: 'hi' }), 'aGk=');
  assert.equal(await run('base64', { action: 'decode', text: 'aGk=' }), 'hi');
  assert.equal(
    await run('hash', { algorithm: 'sha256', text: '' }),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(await run('calculator', { expression: '2 + 2' }), 'Result: 4');
  assert.match(await run('datetime', {}), /\d/);
});

test('tool results larger than the limit are replaced with an error', async () => {
  const fits = 'a'.repeat((MAX_TOOL_RESULT_BYTES / 4) * 3);
  assert.equal((await run('base64', { action: 'encode', text: fits })).length, MAX_TOOL_RESULT_BYTES);

  const tooLarge = await run('base64', { action: 'encode', text: `${fits}aaa` });
  assert.equal(tooLarge, `Tool error: base64 returned more than the ${MAX_TOOL_RESULT_BYTES}-byte limit`);
});

test('tools are looked up as own properties only', async () => {
  assert.equal(await executeTool('constructor', {}), 'Unknown tool: constructor');
  assert.equal(await executeTool('__proto__', {}), 'Unknown tool: __proto__');
  assert.deepEqual(
    getToolDefinitions(['constructor', 'calculator', 'toString']).map((tool) => tool.function.name),
    ['calculator']
  );
});
