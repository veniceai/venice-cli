import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli, type RecordedRequest } from '../lib/test-cli.js';

function searchApi({ method, path }: RecordedRequest): unknown {
  if (method !== 'POST') return undefined;
  if (path === '/augment/search') {
    return { query: 'q', results: [{ title: 'Result', url: 'https://example.com', content: 'Body', date: '' }] };
  }
  if (path === '/chat/completions') {
    return { choices: [{ message: { content: 'Synthesis' }, finish_reason: 'stop' }] };
  }
  return undefined;
}

const sentBody = (requests: RecordedRequest[]) => JSON.parse(requests[0].body);

test('search --raw sends each provider to the dedicated search API', async () => {
  for (const provider of ['brave', 'google', 'exa']) {
    const result = await runCli(['search', '--raw', '--provider', provider, '-n', '3', '-f', 'json', 'q'], searchApi);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sentBody(result.requests), { query: 'q', limit: 3, search_provider: provider });
  }
});

test('search --raw defaults to brave and five results', async () => {
  const result = await runCli(['search', '--raw', '-f', 'json', 'q'], searchApi);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sentBody(result.requests), { query: 'q', limit: 5, search_provider: 'brave' });
});

test('search without --raw sends its options to chat completions', async () => {
  const result = await runCli(['search', '-m', 'test-model', '--citations', '--scrape', '-n', '4', 'q'], searchApi);
  assert.equal(result.status, 0, result.stderr);
  const body = sentBody(result.requests);
  assert.equal(body.model, 'test-model');
  assert.deepEqual(body.venice_parameters, {
    enable_web_search: 'on',
    web_search_max_results: 4,
    enable_web_citations: true,
    enable_web_scraping: true,
  });
  assert.equal(result.stdout, 'Synthesis\n');
});

test('search rejects flags that do not apply to the chosen mode before calling the API', async () => {
  const runs: Array<[string[], RegExp]> = [
    [['search', '--provider', 'exa', 'q'], /--provider can only be used with --raw/],
    [['search', '--raw', '--provider', 'bing', 'q'], /Allowed choices are brave, google, exa/],
    [['search', '--raw', '-m', 'test-model', 'q'], /'--raw' cannot be used with option '-m, --model/],
    [['search', '--raw', '--citations', 'q'], /'--raw' cannot be used with option '--citations'/],
    [['search', '--raw', '--scrape', 'q'], /'--raw' cannot be used with option '--scrape'/],
    [['search', '-f', 'yaml', 'q'], /Invalid --format "yaml"/],
  ];
  for (const [args, expected] of runs) {
    const result = await runCli(args, searchApi);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, expected, args.join(' '));
    assert.equal(result.requests.length, 0, args.join(' '));
  }
});
