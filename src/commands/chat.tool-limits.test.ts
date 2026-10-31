import assert from 'node:assert/strict';
import test from 'node:test';
import { nonStreamChat, streamChat } from './chat.js';
import { getToolDefinitions, MAX_TOOL_ARGUMENTS_BYTES } from '../lib/tools.js';
import type { Message } from '../types/index.js';

type Completion = NonNullable<NonNullable<Parameters<typeof nonStreamChat>[5]>['completion']>;
type CompletionStream = NonNullable<NonNullable<Parameters<typeof streamChat>[5]>['completionStream']>;

function base64Call(argumentsJson: string) {
  return {
    id: 'call-1',
    type: 'function' as const,
    function: { name: 'base64', arguments: argumentsJson },
  };
}

function toolRoundThenDone(argumentsJson: string): { completion: Completion; calls: () => number } {
  let calls = 0;
  const completion: Completion = async () => {
    calls++;
    return calls === 1
      ? { content: '', tool_calls: [base64Call(argumentsJson)], finish_reason: 'tool_calls' }
      : { content: 'done', finish_reason: 'stop' };
  };
  return { completion, calls: () => calls };
}

async function silenced<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
}

test('oversized tool arguments stop the chat before the tool runs or the round is resent', async () => {
  const oversized = JSON.stringify({ action: 'encode', text: 'a'.repeat(MAX_TOOL_ARGUMENTS_BYTES) });
  const { completion, calls } = toolRoundThenDone(oversized);

  await assert.rejects(
    silenced(() => nonStreamChat(
      [{ role: 'user', content: 'encode this' }],
      'test-model',
      getToolDefinitions(['base64']),
      false,
      'raw',
      { quiet: true, completion }
    )),
    new RegExp(`Arguments for tool "base64" \\(id: call-1\\) exceed the ${MAX_TOOL_ARGUMENTS_BYTES}-byte limit`)
  );
  assert.equal(calls(), 1);
});

test('streaming chat applies the same tool argument limit', async () => {
  const oversized = JSON.stringify({ action: 'encode', text: 'a'.repeat(MAX_TOOL_ARGUMENTS_BYTES) });
  let calls = 0;
  const completionStream: CompletionStream = async function* () {
    calls++;
    yield { tool_calls: [{ index: 0, ...base64Call(oversized) }], done: false };
    yield { finish_reason: 'tool_calls', done: false };
    yield { done: true };
  };

  await assert.rejects(
    silenced(() => streamChat(
      [{ role: 'user', content: 'encode this' }],
      'test-model',
      getToolDefinitions(['base64']),
      false,
      'raw',
      { quiet: true, completionStream }
    )),
    /exceed the 65536-byte limit/
  );
  assert.equal(calls, 1);
});

test('a non-string tool argument becomes an error result instead of an expanded buffer', async () => {
  const messages: Message[] = [{ role: 'user', content: 'encode this' }];
  const { completion, calls } = toolRoundThenDone('{"action":"encode","text":{"length":3000000}}');

  await silenced(() => nonStreamChat(
    messages,
    'test-model',
    getToolDefinitions(['base64']),
    false,
    'raw',
    { quiet: true, completion }
  ));

  assert.equal(calls(), 2);
  assert.equal(
    messages.find((message) => message.role === 'tool')?.content,
    'Tool error: invalid arguments for base64: /text must be string'
  );
});
