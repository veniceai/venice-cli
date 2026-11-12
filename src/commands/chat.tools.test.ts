import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../lib/test-cli.js';

test('chat refuses unknown --tools names before sending any request', async () => {
  for (const tools of ['calculater', 'calculator,bogus']) {
    const result = await runCli(['chat', '--no-stream', '-t', tools, '2+2'], () => ({}));
    assert.equal(result.status, 1, tools);
    assert.match(result.stderr, /Unknown tools? in --tools/, tools);
    assert.deepEqual(result.requests, [], tools);
  }
});
