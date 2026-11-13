import assert from 'node:assert/strict';
import test from 'node:test';
import { reply, runCli, type FakeApi } from '../lib/test-cli.js';

const rejected: FakeApi = (request) => request.path === '/video/queue'
  ? reply(400, {
    error: { message: 'The prompt was rejected', code: 'PROMPT_REJECTED' },
    credits_refunded: 0.5,
    suggested_prompt: 'a kitten playing',
    recommended_model: 'wan-2.6-text-to-video',
  })
  : undefined;

test("JSON mode prints an API error as one line of JSON on stderr, with Venice's next-step fields", { timeout: 20_000 }, async () => {
  const run = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '-f', 'json'], rejected);

  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(run.stderr), {
    error: {
      message: 'The prompt was rejected',
      status: 400,
      code: 'PROMPT_REJECTED',
      credits_refunded: 0.5,
      suggested_prompt: 'a kitten playing',
      recommended_model: 'wan-2.6-text-to-video',
    },
  });
});

test("JSON mode covers errors a command doesn't catch itself, and a 401 keeps its status", { timeout: 20_000 }, async () => {
  const refused: FakeApi = () => reply(401, { error: { message: 'bad key' } });

  for (const args of [['keys', 'list'], ['billing', 'balance']]) {
    const json = await runCli([...args, '-f', 'json'], refused);
    assert.equal(json.status, 1, args.join(' '));
    assert.equal(json.stdout, '', args.join(' '));
    assert.deepEqual(JSON.parse(json.stderr), {
      error: {
        message: 'Authentication failed. Please check your API key.\nUpdate with: venice config set api_key',
        status: 401,
      },
    }, args.join(' '));
  }

  const pretty = await runCli(['keys', 'list'], refused);
  assert.equal(pretty.status, 1);
  assert.match(pretty.stderr, /^Error: Authentication failed\. Please check your API key\./);
});

test('JSON mode prints a local validation error as JSON too, and other modes keep plain text', { timeout: 20_000 }, async () => {
  const json = await runCli(['video', 'generate', 'a cat', '-o', 'clip.mp4', '-f', 'json'], rejected);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stderr), { error: { message: '--output needs --wait.' } });

  const pretty = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '-f', 'pretty'], rejected);
  assert.equal(pretty.status, 1);
  assert.equal(pretty.stdout, '');
  assert.match(pretty.stderr, /^Error: The prompt was rejected/);
});
