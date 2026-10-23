import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool } from './tools.js';

test('executeTool refuses a built-in tool outside the allowlist', async () => {
  const result = await executeTool(
    'calculator',
    { expression: '2 + 2' },
    { allowedTools: new Set(['datetime']) }
  );

  assert.equal(result, 'Tool not enabled: calculator');
});

test('executeTool runs a tool inside the allowlist', async () => {
  const result = await executeTool(
    'calculator',
    { expression: '2 + 2' },
    { allowedTools: new Set(['calculator']) }
  );

  assert.equal(result, 'Result: 4');
});

async function calculate(expression: string): Promise<string> {
  return executeTool(
    'calculator',
    { expression },
    { allowedTools: new Set(['calculator']) }
  );
}

test('calculator counts arguments per nested function call', async () => {
  assert.equal(await calculate('min(max(1,2),3)'), 'Result: 2');
  assert.equal(await calculate('max(1, min(2,3))'), 'Result: 2');
  assert.equal(await calculate('max(min(1,2),3)'), 'Result: 3');
  assert.equal(await calculate('pow(max(1,2), min(3,4))'), 'Result: 8');
});

test('calculator still evaluates flat expressions', async () => {
  assert.equal(await calculate('min(1,2,3)'), 'Result: 1');
  assert.equal(await calculate('pow(2,3)'), 'Result: 8');
  assert.equal(await calculate('2 + 2'), 'Result: 4');
});

test('calculator returns an error string for invalid expressions', async () => {
  assert.match(await calculate('2+'), /^Error evaluating expression:/);
  assert.match(await calculate('(1,2)'), /^Error evaluating expression:/);
  assert.match(await calculate('--'), /^Error evaluating expression:/);
  assert.match(await calculate('2*'), /^Error evaluating expression:/);
});

test('calculator supports unary minus and plus', async () => {
  assert.equal(await calculate('-5'), 'Result: -5');
  assert.equal(await calculate('2 + -3'), 'Result: -1');
  assert.equal(await calculate('(-5)+3'), 'Result: -2');
  assert.equal(await calculate('abs(-4)'), 'Result: 4');
  assert.equal(await calculate('max(-1,-2)'), 'Result: -1');
  assert.equal(await calculate('+5'), 'Result: 5');
  assert.equal(await calculate('2 * -3'), 'Result: -6');
  assert.equal(await calculate('--5'), 'Result: 5');
});

test('calculator keeps binary minus distinct from unary minus', async () => {
  assert.equal(await calculate('5-3'), 'Result: 2');
  assert.equal(await calculate('5 - -3'), 'Result: 8');
  assert.equal(await calculate('(1)-1'), 'Result: 0');
});

test('calculator binds unary minus looser than powers', async () => {
  assert.equal(await calculate('-2^2'), 'Result: -4');
  assert.equal(await calculate('(-2)^2'), 'Result: 4');
  assert.equal(await calculate('2^-1'), 'Result: 0.5');
  assert.equal(await calculate('-2*3'), 'Result: -6');
});
