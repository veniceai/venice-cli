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

test('JSON mode prints every local validation error as one line of JSON before any request', { timeout: 60_000 }, async () => {
  const rpcUsage =
    'Usage: venice rpc <network> <method> [params...]\n' +
    '       venice rpc <network> --batch <file>\n' +
    '       venice rpc networks';
  const cases: Array<[string[], string | RegExp]> = [
    [['embeddings', '-f', 'json', '--encoding-format', 'xml', 'hi'], '--encoding-format must be float or base64'],
    [['embeddings', '-f', 'json', '--file', 'missing.txt'], 'File not found: missing.txt'],
    [['history', 'show', '-f', 'json', 'nosuchid'], 'Conversation not found: nosuchid'],
    [['chat', '-f', 'json', '--reasoning-effort', 'bogus', 'hi'], /^Invalid --reasoning-effort "bogus"\. Use one of: /],
    [['chat', '-f', 'json', '--no-thinking', '--reasoning-effort', 'high', 'hi'], 'Cannot combine --no-thinking with --reasoning-effort (except "none").'],
    [['chat', '-f', 'json', '--prompt-cache-retention', 'forever', 'hi'], /^Invalid --prompt-cache-retention "forever"\./],
    [['transcribe', '-f', 'json', '--response-format', 'xml', 'clip.mp3'], /--response-format must be json or text/],
    [['transcribe', '-f', 'json', 'missing.mp3'], 'File not found: missing.mp3'],
    [['tts', '--json'], 'No text provided. Usage: venice tts "Your text"'],
    [['upscale', '-f', 'json', 'missing.png'], 'File not found: missing.png'],
    [['rpc', 'networks', '--batch', 'calls.json', '-f', 'json'], 'Network is required for --batch. Usage: venice rpc <network> --batch <file>'],
    [['rpc', 'ethereum-mainnet', '-f', 'json'], `Missing JSON-RPC method.\n${rpcUsage}`],
  ];

  for (const [args, expected] of cases) {
    const label = args.join(' ');
    const run = await runCli(args, () => undefined);
    assert.equal(run.status, 1, label);
    assert.equal(run.stdout, '', label);
    assert.equal(run.stderr.trim().split('\n').length, 1, `${label}: ${run.stderr}`);
    const { error } = JSON.parse(run.stderr);
    assert.deepEqual(Object.keys(error), ['message'], label);
    if (typeof expected === 'string') {
      assert.equal(error.message, expected, label);
    } else {
      assert.match(error.message, expected, label);
    }
    assert.deepEqual(run.requests, [], label);
  }

  const pretty = await runCli(['embeddings', '--encoding-format', 'xml', 'hi'], () => undefined);
  assert.equal(pretty.status, 1);
  assert.equal(pretty.stderr, 'Error: --encoding-format must be float or base64\n');

  const prettyRpc = await runCli(['rpc', 'ethereum-mainnet'], () => undefined);
  assert.equal(prettyRpc.status, 1);
  assert.equal(prettyRpc.stderr, `Error: Missing JSON-RPC method.\n${rpcUsage}\n`);
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
