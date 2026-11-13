import assert from 'node:assert/strict';
import test from 'node:test';
import { reply, runCli, type FakeApi } from '../lib/test-cli.js';

const DEPRECATED = { 'x-venice-deprecated': 'true', 'x-venice-deprecated-replacement': 'new-model' };

const deprecatedModel: FakeApi = (request) => {
  if (request.path === '/video/queue') return reply(200, { queue_id: 'q1', model: 'test-model' }, DEPRECATED);
  if (request.path === '/video/quote') return reply(200, { quote: 1 }, DEPRECATED);
  return undefined;
};

const warning = {
  type: 'deprecated_model',
  model: 'test-model',
  replacement: 'new-model',
  message: 'test-model is deprecated; switch to new-model.',
};

test('a JSON result carries the deprecation warnings Venice sent, and nothing repeats them on stderr', { timeout: 20_000 }, async () => {
  const run = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '-f', 'json'], deprecatedModel);

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).warnings, [warning]);
  assert.equal(run.stderr, '');
});

test('deprecation warnings go to stderr: as text, or as one JSON line when the JSON result has no warnings field', { timeout: 20_000 }, async () => {
  const pretty = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '-f', 'pretty'], deprecatedModel);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.match(pretty.stderr, /test-model is deprecated; switch to new-model\./);

  const quote = await runCli(['video', 'quote', '-m', 'test-model', '-f', 'json'], deprecatedModel);
  assert.equal(quote.status, 0, quote.stderr);
  assert.deepEqual(JSON.parse(quote.stderr), { warnings: [warning] });
});
