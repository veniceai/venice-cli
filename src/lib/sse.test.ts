import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerSentEventParser, type ServerSentEvent } from './sse.js';

function parse(chunks: string[], maxLength = 1024): ServerSentEvent[] {
  const parser = new ServerSentEventParser(maxLength);
  const events: ServerSentEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.push(chunk));
  }
  events.push(...parser.end());
  return events;
}

test('the space after the field colon is optional', () => {
  assert.deepEqual(parse(['data:no-space\n\ndata: one-space\n\ndata:  two-spaces\n\n']), [
    { type: 'message', data: 'no-space' },
    { type: 'message', data: 'one-space' },
    { type: 'message', data: ' two-spaces' },
  ]);
});

test('LF, CR and CRLF line endings all end lines', () => {
  const expected = [
    { type: 'message', data: 'first' },
    { type: 'message', data: 'second' },
  ];
  assert.deepEqual(parse(['data: first\n\ndata: second\n\n']), expected);
  assert.deepEqual(parse(['data: first\r\rdata: second\r\r']), expected);
  assert.deepEqual(parse(['data: first\r\n\r\ndata: second\r\n\r\n']), expected);
});

test('a CRLF split across chunks is a single line ending', () => {
  assert.deepEqual(parse(['event: error\r', '\ndata: boom\r', '\n\r', '\n']), [
    { type: 'error', data: 'boom' },
  ]);
});

test('consecutive data lines are joined with a newline', () => {
  assert.deepEqual(parse(['data: {"a":\ndata: 1}\n\n']), [
    { type: 'message', data: '{"a":\n1}' },
  ]);
});

test('comments, unknown fields and empty events are ignored', () => {
  assert.deepEqual(parse([': keepalive\n\nid: 7\nretry: 10\n\nevent: ping\n\ndata: kept\n\n']), [
    { type: 'message', data: 'kept' },
  ]);
});

test('the event field names the event and resets after dispatch', () => {
  assert.deepEqual(parse(['event: error\ndata: {"error":{}}\n\ndata: next\n\n']), [
    { type: 'error', data: '{"error":{}}' },
    { type: 'message', data: 'next' },
  ]);
});

test('lines split across chunks are reassembled', () => {
  assert.deepEqual(parse(['da', 'ta: hel', 'lo\n', '\n']), [
    { type: 'message', data: 'hello' },
  ]);
});

test('at end of stream a cleanly ended event is kept and a cut-off line is dropped', () => {
  assert.deepEqual(parse(['data: [DONE]\n']), [{ type: 'message', data: '[DONE]' }]);
  assert.deepEqual(parse(['data: complete\n\ndata: cut-of']), [
    { type: 'message', data: 'complete' },
  ]);
});

test('an unterminated line longer than the limit is rejected', () => {
  const parser = new ServerSentEventParser(16);
  parser.push('data: 0123456789');
  assert.throws(() => parser.push('abc'), /Event stream line exceeded the limit of 16 B/);
});

test('an event whose data lines together exceed the limit is rejected', () => {
  const parser = new ServerSentEventParser(16);
  assert.throws(
    () => parser.push('data: 0123456789\ndata: 0123456789\n'),
    /Event stream event exceeded the limit of 16 B/
  );
});
