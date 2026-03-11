import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatUserMessage } from './chat.js';

test('buildChatUserMessage uses prompt when only args are provided', () => {
  const message = buildChatUserMessage('find the root cause');
  assert.deepEqual(message, { role: 'user', content: 'find the root cause' });
});

test('buildChatUserMessage uses stdin when prompt is empty', () => {
  const message = buildChatUserMessage('', 'error line 1\nerror line 2');
  assert.deepEqual(message, { role: 'user', content: 'error line 1\nerror line 2' });
});

test('buildChatUserMessage merges stdin and prompt into one message', () => {
  const message = buildChatUserMessage('find the root cause', 'stack trace...');
  assert.deepEqual(message, { role: 'user', content: 'stack trace...\n\nfind the root cause' });
});

test('buildChatUserMessage returns null when both inputs are empty', () => {
  const message = buildChatUserMessage('', '');
  assert.equal(message, null);
});
