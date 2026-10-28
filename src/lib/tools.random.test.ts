import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool } from './tools.js';

async function random(args: Record<string, unknown>): Promise<string> {
  return executeTool('random', args, { allowedTools: new Set(['random']) });
}

async function withConstantMathRandom(run: () => Promise<void>): Promise<void> {
  const original = Math.random;
  Math.random = () => 0.5;
  try {
    await run();
  } finally {
    Math.random = original;
  }
}

test('random UUIDs are version 4 and do not come from Math.random', async () => {
  await withConstantMathRandom(async () => {
    const uuids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const output = await random({ type: 'uuid' });
      const match = /^UUID: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(output);
      assert.ok(match, output);
      uuids.add(match[1]);
    }
    assert.equal(uuids.size, 5);
  });
});

test('random numbers and choices do not come from Math.random', async () => {
  await withConstantMathRandom(async () => {
    const numbers = new Set<string>();
    const picks = new Set<string>();
    const choices = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    for (let i = 0; i < 10; i++) {
      numbers.add(await random({ type: 'number', min: 1, max: 1_000_000_000 }));
      picks.add(await random({ type: 'choice', choices }));
    }
    assert.ok(numbers.size > 1, 'numbers repeated');
    assert.ok(picks.size > 1, 'choices repeated');
  });
});

test('random numbers stay inside an inclusive integer range', async () => {
  for (let i = 0; i < 20; i++) {
    const output = await random({ type: 'number', min: -2, max: 2 });
    const match = /^Random number between -2 and 2: (-?\d+)$/.exec(output);
    assert.ok(match, output);
    const value = Number(match[1]);
    assert.ok(value >= -2 && value <= 2, output);
  }
  assert.equal(await random({ type: 'number', min: 7, max: 7 }), 'Random number between 7 and 7: 7');
  assert.equal(await random({ type: 'number', min: 5, max: 1 }), 'Error: min cannot be greater than max');
  assert.match(
    await random({ type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER }),
    /^Error: max - min must be less than 2\^48/
  );
});
