import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli, type RecordedRequest } from '../lib/test-cli.js';

const MODELS = { data: [{ id: 'kimi-k2-5', type: 'text', model_spec: { capabilities: {} } }] };

function completionApi(...completions: unknown[]) {
  let round = 0;
  return ({ method, path }: RecordedRequest): unknown => {
    if (method === 'GET' && path.startsWith('/models')) return MODELS;
    if (method === 'POST' && path === '/chat/completions') return completions[round++];
    return undefined;
  };
}

test('non-streaming chat fails on a completion without a usable first choice', async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['empty choices', { choices: [] }, /no choices/],
    ['missing choices', { usage: { total_tokens: 1 } }, /no choices/],
    ['choice without a message', { choices: [{ finish_reason: 'stop' }] }, /choices\[0\]\.message is not an object/],
    ['missing finish_reason', { choices: [{ message: { content: 'ok' } }] }, /finish_reason is not a string/],
    ['missing content', { choices: [{ message: {}, finish_reason: 'stop' }] }, /content is not a string/],
    ['null content without tool calls', { choices: [{ message: { content: null }, finish_reason: 'stop' }] }, /content is not a string/],
    ['tool_calls that is not an array', { choices: [{ message: { content: '', tool_calls: {} }, finish_reason: 'stop' }] }, /tool_calls is not an array/],
  ];
  for (const [name, completion, expected] of cases) {
    const result = await runCli(['chat', '--no-stream', 'hello'], completionApi(completion));
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Unexpected response from Venice \(\/chat\/completions\)/, name);
    assert.match(result.stderr, expected, name);
    assert.equal(result.stdout, '', name);
  }
});

test('non-streaming chat still prints normal and empty replies', async () => {
  for (const [content, expected] of [['ok', 'ok\n'], ['', '\n']]) {
    const result = await runCli(
      ['chat', '--no-stream', 'hello'],
      completionApi({ choices: [{ message: { content }, finish_reason: 'stop' }] })
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test('non-streaming chat runs tools from a reply whose content is null', async () => {
  const toolCall = { id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } };
  const result = await runCli(
    ['chat', '--no-stream', '-t', 'calculator', '2+2'],
    completionApi(
      { choices: [{ message: { content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: 'It is 4' }, finish_reason: 'stop' }] }
    )
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /It is 4/);
  const completions = result.requests.filter((request) => request.path === '/chat/completions');
  assert.equal(completions.length, 2);
  assert.match(completions[1].body, /"role":"tool"/);
});
