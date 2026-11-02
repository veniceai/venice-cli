import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CONTEXT_REPLY_CHARS, nonStreamChat, stripThinkingForContext } from './chat.js';
import type { Message } from '../types/index.js';

test('stripThinkingForContext matches each block with its first closing tag', () => {
  assert.equal(stripThinkingForContext('a<think>b<think>c</think>d'), 'ad');
  assert.equal(stripThinkingForContext('</think>x<think>y'), '</think>x');
  assert.equal(stripThinkingForContext('<think>a</think>b<think>c'), 'b');
  assert.equal(stripThinkingForContext('x<think></think>y</think>z'), 'xy</think>z');
  assert.equal(stripThinkingForContext(''), '');
});

test('stripThinkingForContext stays linear on unclosed and repeated tags', () => {
  const size = 256 * 1024;
  const inputs = [
    '<think>'.repeat(Math.ceil(size / 7)),
    `answer${'<think>x'.repeat(Math.ceil(size / 8))}`,
    '<think>x</think>y'.repeat(Math.ceil(size / 16)),
    '</think>'.repeat(Math.ceil(size / 8)),
  ];
  const started = performance.now();
  const outputs = inputs.map(stripThinkingForContext);
  const elapsed = performance.now() - started;

  assert.equal(outputs[0], '');
  assert.equal(outputs[1], 'answer');
  assert.equal(outputs[2], 'y'.repeat(Math.ceil(size / 16)));
  assert.equal(outputs[3], inputs[3]);
  assert.ok(elapsed < 250, `stripping took ${elapsed.toFixed(0)} ms`);
});

test('the reply kept in the conversation is capped', async () => {
  const messages: Message[] = [{ role: 'user', content: 'Write a lot' }];
  const reply = 'x'.repeat(MAX_CONTEXT_REPLY_CHARS + 10);
  const originalLog = console.log;
  console.log = () => {};
  try {
    await nonStreamChat(messages, 'test-model', [], false, 'raw', {
      quiet: true,
      completion: async () => ({ content: reply, finish_reason: 'stop' }),
    });
  } finally {
    console.log = originalLog;
  }

  const kept = messages.at(-1);
  assert.equal(kept?.role, 'assistant');
  assert.equal(kept?.content, `${'x'.repeat(MAX_CONTEXT_REPLY_CHARS)}\n[reply truncated]`);
});
