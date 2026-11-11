import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reply, runCli, type RecordedRequest } from '../lib/test-cli.js';

const HOSTILE = 'evil\u001b]0;pwned\u0007\u001b[31mred\u202e';

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'kimi-k2-5',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'message',
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }, { type: 'output_text', text: ' world' }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    ...overrides,
  };
}

function responsesApi(body: unknown = responseBody()) {
  return ({ method, path }: RecordedRequest): unknown =>
    method === 'POST' && path === '/responses' ? body : undefined;
}

const sentBody = (requests: RecordedRequest[]) => JSON.parse(requests[0].body);

test('responses posts the input with the default model and prints the output text', async () => {
  const result = await runCli(['responses', 'Say', 'hello'], responsesApi());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.map((request) => [request.method, request.path]), [['POST', '/responses']]);
  assert.deepEqual(sentBody(result.requests), { model: 'kimi-k2-5', input: 'Say hello' });
  assert.equal(result.stdout, 'Hello world\n');
});

test('responses sends sampling and reasoning options', async () => {
  const result = await runCli([
    'responses', '-m', 'zai-org-glm-5-1',
    '--max-output-tokens', '256',
    '--temperature', '0.7',
    '--top-p', '0.9',
    '--reasoning-effort', 'HIGH',
    'hi',
  ], responsesApi());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sentBody(result.requests), {
    model: 'zai-org-glm-5-1',
    input: 'hi',
    max_output_tokens: 256,
    temperature: 0.7,
    top_p: 0.9,
    reasoning: { effort: 'high' },
  });
});

test('responses prefers output_text and prints the full response as JSON', async () => {
  const body = responseBody({ output_text: 'From output_text' });
  const raw = await runCli(['responses', '-f', 'raw', 'hi'], responsesApi(body));
  assert.equal(raw.status, 0, raw.stderr);
  assert.equal(raw.stdout, 'From output_text\n');

  const json = await runCli(['responses', '-f', 'json', 'hi'], responsesApi(body));
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), body);
});

test('responses reads piped stdin before the positional input, like chat', async () => {
  const piped = await runCli(['responses', 'summarise this'], responsesApi(), { stdin: 'log line\n' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(sentBody(piped.requests).input, 'log line\n\nsummarise this');

  const only = await runCli(['responses'], responsesApi(), { stdin: 'just stdin' });
  assert.equal(only.status, 0, only.stderr);
  assert.equal(sentBody(only.requests).input, 'just stdin');
});

test('responses sends local images as data URLs in a user message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-responses-image-'));
  const image = join(dir, 'pixel.png');
  writeFileSync(image, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]));
  try {
    const result = await runCli(['responses', '--image', image, 'what is this?'], responsesApi());
    assert.equal(result.status, 0, result.stderr);
    const { input } = sentBody(result.requests);
    assert.equal(input.length, 1);
    assert.equal(input[0].role, 'user');
    assert.deepEqual(input[0].content[0], { type: 'input_text', text: 'what is this?' });
    assert.equal(input[0].content[1].type, 'input_image');
    assert.match(input[0].content[1].image_url, /^data:image\/png;base64,iVBORw0KGgo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('responses refuses invalid input before sending a request', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['responses', '-m', 'e2ee-qwen3-5-122b-a10b', 'hi'], /does not support E2EE models/],
    [['responses', '--temperature', '3', 'hi'], /--temperature must be a number between 0 and 2/],
    [['responses', '--top-p', '1.5', 'hi'], /--top-p must be a number between 0 and 1/],
    [['responses', '--max-output-tokens', '0', 'hi'], /--max-output-tokens must be a positive integer/],
    [['responses', '--reasoning-effort', 'huge', 'hi'], /Invalid --reasoning-effort "huge"/],
    [['responses', '--image', 'missing.png', 'hi'], /Image not found: missing\.png/],
    [['responses'], /No input provided/],
  ];
  for (const [args, message] of cases) {
    const result = await runCli(args, responsesApi());
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    assert.deepEqual(result.requests, [], args.join(' '));
  }
});

test('responses sanitises the model output in a terminal-bound stream', async () => {
  const result = await runCli(['responses', 'hi'], responsesApi(responseBody({ output_text: HOSTILE })));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /evil/);
  assert.doesNotMatch(result.stdout, /[\u001b\u0007\u202e]/);
});

test('responses reports failed, incomplete and malformed responses', async () => {
  const failed = await runCli(['responses', 'hi'], responsesApi(responseBody({
    status: 'failed',
    output: [],
    error: { code: 'server_error', message: 'upstream broke' },
  })));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /The response failed: upstream broke/);

  const incomplete = await runCli(['responses', 'hi'], responsesApi(responseBody({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  })));
  assert.equal(incomplete.status, 0, incomplete.stderr);
  assert.equal(incomplete.stdout, 'Hello world\n');
  assert.match(incomplete.stderr, /incomplete \(max_output_tokens\)/);

  const malformed = await runCli(['responses', 'hi'], () => reply(200, { status: 'completed' }));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Unexpected response from Venice: the response has no output/);
});
