import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool, MAX_CALCULATOR_EXPRESSION_LENGTH } from './tools.js';

async function calculate(expression: string): Promise<string> {
  return executeTool(
    'calculator',
    { expression },
    { allowedTools: new Set(['calculator']) }
  );
}

test('calculator rejects malformed numbers instead of truncating them', async () => {
  for (const expression of ['1.2.3 + 1', '1..2', '5.', '.', '1.2.3']) {
    assert.match(await calculate(expression), /^Error evaluating expression: Invalid number/, expression);
  }
  assert.equal(await calculate('.5 + 0.5'), 'Result: 1');
});

test('calculator treats whitespace as a separator, never as a join', async () => {
  assert.match(await calculate('1 2 + 3'), /^Error evaluating expression:/);
  assert.match(await calculate('log 10 (100)'), /^Error evaluating expression:/);
  assert.equal(await calculate(' 2 +\t2 '), 'Result: 4');
  assert.equal(await calculate('sqrt (16)'), 'Result: 4');
  assert.equal(await calculate('log10(100)'), 'Result: 2');
});

test('calculator rejects postfix, implicit, and out-of-place operands', async () => {
  for (const expression of [
    '16 sqrt',
    '(1)(2)+',
    '(2)(3)^',
    '(1)+(2)(3)*',
    '3max(,2)',
    '(2)(3)max(,)',
    '2(3)',
    'pi(2)',
    '1e3',
    '2 +* 3',
    ')',
    '(',
    '(1',
    '1)',
  ]) {
    assert.match(await calculate(expression), /^Error evaluating expression:/, expression);
  }
});

test('calculator functions take a fixed number of arguments', async () => {
  for (const expression of ['sqrt(4, 9)', 'pow(2,3,4)', 'pow(2)', 'sqrt()', 'min()', 'sqrt 16', 'max']) {
    assert.match(await calculate(expression), /^Error evaluating expression:/, expression);
  }
  assert.equal(await calculate('min(5)'), 'Result: 5');
  assert.equal(await calculate('max(1, 7, 3)'), 'Result: 7');
});

test('calculator only knows its own functions and constants', async () => {
  for (const expression of ['__proto__^0', 'constructor^0', 'constructor', 'Constructor+1', 'toString', 'hasOwnProperty(1)']) {
    assert.match(await calculate(expression), /^Error evaluating expression: Unknown identifier/, expression);
  }
  assert.equal(await calculate('PI'), `Result: ${Math.PI}`);
  assert.equal(await calculate('e'), `Result: ${Math.E}`);
  assert.equal(await calculate('SQRT(9)'), 'Result: 3');
});

test('calculator keeps precedence, associativity, and its error results', async () => {
  const expected: Record<string, string> = {
    '2^3^2': 'Result: 512',
    '-2^2': 'Result: -4',
    '2^-2': 'Result: 0.25',
    '2^-2^2': 'Result: 0.0625',
    '2*-3': 'Result: -6',
    '8/2/2': 'Result: 2',
    '2-3-4': 'Result: -5',
    '7%4*2': 'Result: 6',
    '1+2*3^2': 'Result: 19',
    'min(1, max(2, 3), 4)': 'Result: 1',
    '-sqrt(4)': 'Result: -2',
    '1/0': 'Error evaluating expression: Division by zero',
    '1%0': 'Error: Result is NaN',
    '10^400': 'Error: Result is Infinity',
  };
  for (const [expression, output] of Object.entries(expected)) {
    assert.equal(await calculate(expression), output, expression);
  }
});

test('calculator caps expression length and handles the largest expressions quickly', async () => {
  const atLimit = `max(${'1,'.repeat((MAX_CALCULATOR_EXPRESSION_LENGTH - 6) / 2)}1)`;
  assert.ok(atLimit.length <= MAX_CALCULATOR_EXPRESSION_LENGTH);
  const nested = `${'('.repeat(500)}1${')'.repeat(500)}`;
  const unary = `${'-'.repeat(MAX_CALCULATOR_EXPRESSION_LENGTH - 1)}1`;
  const oversized = `max(${'1,'.repeat(50_000)}1)`;

  const started = performance.now();
  assert.equal(await calculate(atLimit), 'Result: 1');
  assert.equal(await calculate(nested), 'Result: 1');
  assert.equal(await calculate(unary), 'Result: -1');
  assert.equal(
    await calculate(oversized),
    `Error evaluating expression: Expression exceeds the ${MAX_CALCULATOR_EXPRESSION_LENGTH}-character limit`
  );
  assert.ok(performance.now() - started < 500, 'calculator took too long');
});
