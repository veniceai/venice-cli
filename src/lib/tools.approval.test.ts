import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { escapeInvisible } from './output.js';
import { executeTool, formatToolApprovalRequest } from './tools.js';

process.env.NO_COLOR = '1';

type FakeInput = PassThrough & { isTTY?: boolean };

const TEXT = 'A\u009b2J\u009d0;t\u009cB\u202Egnp.exe\u202C\u200b\u2028\x1b[2K\u{e0041}';
const ESCAPED_TEXT = '"text": "A\\u009b2J\\u009d0;t\\u009cB\\u202egnp.exe\\u202c\\u200b\\u2028\\u001b[2K\\udb40\\udc41"';

function fakeInput(isTTY: boolean): FakeInput {
  const input = new PassThrough() as FakeInput;
  input.isTTY = isTTY;
  return input;
}

// Replaces stdin with `input`, sets whether stdout and stderr report
// themselves as terminals, and records what is written to each.
async function withTerminal(
  input: FakeInput,
  terminals: { stdout: boolean; stderr: boolean },
  run: () => Promise<void>
): Promise<{ stdout: string; stderr: string }> {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const isTTY = {
    stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
  };
  const originalWrites = { stdout: process.stdout.write, stderr: process.stderr.write };
  const originalLog = console.log;
  const originalError = console.error;
  const writes = { stdout: [] as string[], stderr: [] as string[] };
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = process[name];
    const originalWrite = originalWrites[name];
    Object.defineProperty(stream, 'isTTY', { value: terminals[name], configurable: true });
    // The test runner reports through stdout with binary writes; let those through.
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk !== 'string') {
        return (originalWrite as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
      }
      writes[name].push(chunk);
      return true;
    }) as typeof stream.write;
  }
  console.log = (...args: unknown[]) => {
    writes.stdout.push(`${args.join(' ')}\n`);
  };
  console.error = (...args: unknown[]) => {
    writes.stderr.push(`${args.join(' ')}\n`);
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const name of ['stdout', 'stderr'] as const) {
      process[name].write = originalWrites[name];
      const descriptor = isTTY[name];
      if (descriptor) {
        Object.defineProperty(process[name], 'isTTY', descriptor);
      } else {
        delete (process[name] as { isTTY?: boolean }).isTTY;
      }
    }
    if (stdin) Object.defineProperty(process, 'stdin', stdin);
  }
  return { stdout: writes.stdout.join(''), stderr: writes.stderr.join('') };
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

test('the tool approval request shows control, bidi and invisible characters as escapes', () => {
  const request = formatToolApprovalRequest('base64', { action: 'encode', text: TEXT });

  assert.match(request, /^\n⚡ Tool Call Request\nTool: base64\nArgs: \{\n/);
  assert.ok(request.includes(ESCAPED_TEXT), JSON.stringify(request));
  assert.doesNotMatch(request, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u2028\u202a-\u202e]/);
});

test('tool approval asks on stderr, so stdout can be redirected', async () => {
  const input = fakeInput(true);
  const output = await withTerminal(input, { stdout: false, stderr: true }, async () => {
    const pending = executeTool('base64', { action: 'encode', text: TEXT }, {
      interactive: true,
      allowedTools: ['base64'],
    });
    setImmediate(() => input.write('n\n'));
    assert.equal(await pending, 'Tool execution cancelled by user');
  });

  assert.equal(output.stdout, '');
  assert.ok(output.stderr.includes(ESCAPED_TEXT), JSON.stringify(output.stderr));
  assert.match(output.stderr, /Approve\? \[y\/N\] /);
});

test('tool approval asks on stdout when only stdout is a terminal', async () => {
  const input = fakeInput(true);
  const output = await withTerminal(input, { stdout: true, stderr: false }, async () => {
    const pending = executeTool('calculator', { expression: '2+2' }, {
      interactive: true,
      allowedTools: ['calculator'],
    });
    setImmediate(() => input.write('y\n'));
    assert.equal(await pending, 'Result: 4');
  });

  assert.equal(output.stderr, '');
  assert.match(output.stdout, /Tool Call Request\nTool: calculator\n/);
  assert.match(output.stdout, /Approve\? \[y\/N\] /);
});

test('the tool approval prompt refuses to ask without a terminal', { timeout: 5000 }, async () => {
  for (const [stdinIsTTY, outputsAreTTYs, refusal] of [
    [false, true, /stdin is not a terminal/],
    [true, false, /neither stdout nor stderr is a terminal/],
  ] as const) {
    const input = fakeInput(stdinIsTTY);
    const terminals = { stdout: outputsAreTTYs, stderr: outputsAreTTYs };
    const output = await withTerminal(input, terminals, async () => {
      const pending = executeTool('calculator', { expression: '2+2' }, {
        interactive: true,
        allowedTools: ['calculator'],
      });
      input.end();
      await assert.rejects(pending, refusal);
    });
    assert.deepEqual(output, { stdout: '', stderr: '' });
  }
});

test('the tool approval prompt fails when input ends without an answer', { timeout: 5000 }, async () => {
  const input = fakeInput(true);
  await withTerminal(input, { stdout: false, stderr: true }, async () => {
    const pending = executeTool('calculator', { expression: '2+2' }, {
      interactive: true,
      allowedTools: ['calculator'],
    });
    setImmediate(() => input.end());
    await assert.rejects(pending, /Input ended before the prompt was answered/);
  });
});
