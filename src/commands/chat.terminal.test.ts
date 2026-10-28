import assert from 'node:assert/strict';
import test from 'node:test';
import { streamChat } from './chat.js';
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
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(chunk.toString());
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
