import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatUserMessages } from './chat.js';

test('buildChatUserMessages uses prompt when only args are provided', () => {
  const messages = buildChatUserMessages('find the root cause');
  assert.deepEqual(messages, [{ role: 'user', content: 'find the root cause' }]);
});

test('buildChatUserMessages uses stdin when prompt is empty', () => {
  const messages = buildChatUserMessages('', 'error line 1\nerror line 2');
  assert.deepEqual(messages, [{ role: 'user', content: 'error line 1\nerror line 2' }]);
});

test('buildChatUserMessages merges stdin and prompt into one message', () => {
  const messages = buildChatUserMessages('find the root cause', 'stack trace...');
  assert.deepEqual(messages, [{ role: 'user', content: 'stack trace...\n\nfind the root cause' }]);
});

test('buildChatUserMessages returns empty array when both inputs are empty', () => {
  const messages = buildChatUserMessages('', '');
  assert.deepEqual(messages, []);
});
