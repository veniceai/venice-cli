import assert from 'node:assert/strict';
import test from 'node:test';
import { streamChat } from './chat.js';
import { getToolDefinitions } from '../lib/tools.js';
import type { Message } from '../types/index.js';

process.env.NO_COLOR = '1';

type CompletionStream = NonNullable<NonNullable<Parameters<typeof streamChat>[5]>['completionStream']>;

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

async function captureStdout(isTTY: boolean, run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
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
    if (descriptor) {
      Object.defineProperty(process.stdout, 'isTTY', descriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  }
  return writes.join('');
}

const splitSequences: CompletionStream = async function* () {
  yield { reasoning_content: 'thinking \x1b]52;c;', done: false };
  yield { reasoning_content: 'Zm9v\x07 more', done: false };
  yield { content: '<think>plan \x1b]0;ti', done: false };
  yield { content: 'tle\x07done</think>Hello \u009b', done: false };
  yield { content: '2Jworld \x1b', done: false };
  yield { content: '[31mred\u202e', done: false };
  yield { done: true };
};

test('streamed chat on a terminal strips control sequences split across chunks', async () => {
  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  const output = await captureStdout(true, () =>
    streamChat(messages, 'test-model', [], false, 'pretty', { quiet: true, completionStream: splitSequences })
  );

  assert.doesNotMatch(output, UNSAFE, JSON.stringify(output));
  assert.match(output, /thinking {2}more/);
  assert.match(output, /💭 plan done\n/);
  assert.match(output, /Hello world red/);
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'Hello \u009b2Jworld \x1b[31mred\u202e' });
});

test('streamed chat writes model text unchanged when stdout is not a terminal', async () => {
  const output = await captureStdout(false, () =>
    streamChat([{ role: 'user', content: 'hi' }], 'test-model', [], false, 'raw', {
      quiet: true,
      completionStream: splitSequences,
    })
  );

  assert.ok(output.startsWith('thinking \x1b]52;c;Zm9v\x07 more'), JSON.stringify(output));
  assert.ok(output.includes('plan \x1b]0;title\x07done'), JSON.stringify(output));
  assert.ok(output.includes('Hello \u009b2Jworld \x1b[31mred\u202e'), JSON.stringify(output));
});

test('streamed chat shows only enabled tools and sanitises their results on a terminal', async () => {
  const decoded = `before\x1b]52;c;${Buffer.from('echo copied').toString('base64')}\x07after`;
  const disabledName = 'calc\x1b]0;title\x07';
  let round = 0;
  const completionStream: CompletionStream = async function* () {
    round++;
    if (round === 1) {
      yield {
        tool_calls: [
          {
            index: 0,
            id: 'call-enabled',
            type: 'function',
            function: {
              name: 'base64',
              arguments: JSON.stringify({ action: 'decode', text: Buffer.from(decoded).toString('base64') }),
            },
          },
          { index: 1, id: 'call-disabled', type: 'function', function: { name: disabledName, arguments: '{}' } },
        ],
        done: false,
      };
      yield { finish_reason: 'tool_calls', done: false };
      yield { done: true };
      return;
    }
    yield { content: 'final answer', done: false };
    yield { done: true };
  };
  const messages: Message[] = [{ role: 'user', content: 'hi' }];

  const output = await captureStdout(true, () =>
    streamChat(messages, 'test-model', getToolDefinitions(['base64']), false, 'pretty', {
      quiet: true,
      completionStream,
    })
  );

  assert.doesNotMatch(output, UNSAFE, JSON.stringify(output));
  assert.match(output, /\[Tool: base64\]\nbeforeafter\n/);
  assert.doesNotMatch(output, /calc|Tool not enabled/);
  assert.match(output, /final answer/);
  assert.deepEqual(
    messages.filter((message) => message.role === 'tool').map((message) => message.content),
    [decoded, `Tool not enabled: ${disabledName}`]
  );
});
