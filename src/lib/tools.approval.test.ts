import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { escapeInvisible } from './output.js';
import { executeTool } from './tools.js';

process.env.NO_COLOR = '1';

type FakeInput = PassThrough & { isTTY?: boolean };

function fakeInput(isTTY: boolean): FakeInput {
  const input = new PassThrough() as FakeInput;
  input.isTTY = isTTY;
  return input;
}

async function withStdin(input: FakeInput, run: () => Promise<void>): Promise<string> {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const writes: string[] = [];
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  // The test runner reports through stdout with binary writes; let those through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      return (originalWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    writes.push(`${args.join(' ')}\n`);
  };
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    if (stdin) Object.defineProperty(process, 'stdin', stdin);
  }
  return writes.join('');
}

test('escapeInvisible escapes characters that do not render visibly', () => {
  const visible = 'Hello world\nnaïve 日本 👍 "quoted" \\ back';
  assert.equal(escapeInvisible(visible), visible);
  assert.equal(
    escapeInvisible('a\tb\u00a0c\u200bd\u200de\ufe0ff\u3164g\u2028h\ud800i\ue000j\u0085k\u202el'),
    'a\\u0009b\\u00a0c\\u200bd\\u200de\\ufe0ff\\u3164g\\u2028h\\ud800i\\ue000j\\u0085k\\u202el'
  );
  assert.equal(escapeInvisible('tag\u{e0041}'), 'tag\\udb40\\udc41');
});

test('the tool approval prompt shows control, bidi and invisible characters as escapes', async () => {
  const text = 'A\u009b2J\u009d0;t\u009cB\u202Egnp.exe\u202C\u200b\u2028\x1b[2K\u{e0041}';
  const input = fakeInput(true);
  const output = await withStdin(input, async () => {
    const pending = executeTool('base64', { action: 'encode', text }, {
      interactive: true,
      allowedTools: ['base64'],
    });
    setImmediate(() => input.write('n\n'));
    assert.equal(await pending, 'Tool execution cancelled by user');
  });

  assert.match(output, /Tool: base64\n/);
  assert.ok(
    output.includes('"text": "A\\u009b2J\\u009d0;t\\u009cB\\u202egnp.exe\\u202c\\u200b\\u2028\\u001b[2K\\udb40\\udc41"'),
    JSON.stringify(output)
  );
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u2028\u202a-\u202e]/);
});

test('the tool approval prompt refuses to ask without a terminal', { timeout: 5000 }, async () => {
  const input = fakeInput(false);
  const output = await withStdin(input, async () => {
    const pending = executeTool('calculator', { expression: '2+2' }, {
      interactive: true,
      allowedTools: ['calculator'],
    });
    input.end();
    await assert.rejects(pending, /stdin is not a terminal/);
  });
  assert.equal(output, '');
});

test('the tool approval prompt fails when input ends without an answer', { timeout: 5000 }, async () => {
  const input = fakeInput(true);
  await withStdin(input, async () => {
    const pending = executeTool('calculator', { expression: '2+2' }, {
      interactive: true,
      allowedTools: ['calculator'],
    });
    setImmediate(() => input.end());
    await assert.rejects(pending, /Input ended before the prompt was answered/);
  });
});
