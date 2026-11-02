import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { streamChat } from './chat.js';
import { getToolDefinitions } from '../lib/tools.js';
import type { Message } from '../types/index.js';

process.env.NO_COLOR = '1';

type CompletionStream = NonNullable<NonNullable<Parameters<typeof streamChat>[5]>['completionStream']>;

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// `fd` stands in for the descriptor behind stdout, such as a regular file.
async function captureStdout(
  stdout: { isTTY: boolean; fd?: number },
  run: () => Promise<void>
): Promise<string> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const descriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    fd: Object.getOwnPropertyDescriptor(process.stdout, 'fd'),
  };
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout.isTTY, configurable: true });
  if (stdout.fd !== undefined) {
    Object.defineProperty(process.stdout, 'fd', { value: stdout.fd, configurable: true });
  }
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
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        Object.defineProperty(process.stdout, name, descriptor);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)[name];
      }
    }
  }
  return writes.join('');
}

async function withDescriptor<T>(path: string, run: (fd: number) => Promise<T>): Promise<T> {
  const fd = openSync(path, 'w');
  try {
    return await run(fd);
  } finally {
    closeSync(fd);
  }
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
  const output = await captureStdout({ isTTY: true }, () =>
    streamChat(messages, 'test-model', [], false, 'pretty', { quiet: true, completionStream: splitSequences })
  );

  assert.doesNotMatch(output, UNSAFE, JSON.stringify(output));
  assert.match(output, /thinking {2}more/);
  assert.match(output, /💭 plan done\n/);
  assert.match(output, /Hello world red/);
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'Hello \u009b2Jworld \x1b[31mred\u202e' });
});

test('streamed chat strips control sequences when stdout is not a regular file', async () => {
  const output = await withDescriptor(devNull, (fd) => captureStdout({ isTTY: false, fd }, () =>
    streamChat([{ role: 'user', content: 'hi' }], 'test-model', [], false, 'raw', {
      quiet: true,
      completionStream: splitSequences,
    })
  ));

  assert.doesNotMatch(output, UNSAFE, JSON.stringify(output));
  assert.ok(output.startsWith('thinking  more'), JSON.stringify(output));
  assert.ok(output.includes('Hello world red'), JSON.stringify(output));
});

test('streamed chat writes model text unchanged when stdout is a regular file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-chat-stdout-'));
  try {
    const output = await withDescriptor(join(dir, 'stdout.txt'), (fd) => captureStdout({ isTTY: false, fd }, () =>
      streamChat([{ role: 'user', content: 'hi' }], 'test-model', [], false, 'raw', {
        quiet: true,
        completionStream: splitSequences,
      })
    ));

    assert.ok(output.startsWith('thinking \x1b]52;c;Zm9v\x07 more'), JSON.stringify(output));
    assert.ok(output.includes('plan \x1b]0;title\x07done'), JSON.stringify(output));
    assert.ok(output.includes('Hello \u009b2Jworld \x1b[31mred\u202e'), JSON.stringify(output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  const output = await captureStdout({ isTTY: true }, () =>
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
