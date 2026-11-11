import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli, type RecordedRequest } from '../lib/test-cli.js';

const HOSTILE = 'evil\u001b]0;pwned\u0007\u001b[31mred\u202e';

const textModels = [
  {
    id: 'zeta-chat',
    type: 'text',
    owned_by: 'venice.ai',
    model_spec: {
      name: 'Zeta Chat',
      description: 'A private foo model',
      privacy: 'private',
      availableContextTokens: 131072,
      traits: ['default'],
      capabilities: { supportsVision: true, supportsReasoning: false },
      pricing: { input: { usd: 0.5, diem: 0.5 }, output: { usd: 2, diem: 2 } },
    },
  },
  {
    id: 'alpha-chat',
    type: 'text',
    model_spec: { description: 'An anonymous foo model', privacy: 'anonymized' },
  },
];

const videoModels = [
  {
    id: 'Wan-Video',
    type: 'video',
    model_spec: {
      description: 'Video model',
      constraints: { durations: ['5s', '10s'], resolutions: ['720p'] },
    },
  },
];

function catalogApi(overrides: Record<string, unknown> = {}) {
  return ({ path }: RecordedRequest): unknown => {
    if (path in overrides) return overrides[path];
    if (path === '/models') return { data: textModels };
    if (path === '/models?type=video') return { data: videoModels };
    if (path.startsWith('/models?type=')) return { data: [] };
    return undefined;
  };
}

const ids = (stdout: string) => JSON.parse(stdout).map((model: { id: string }) => model.id);

test('venice models still lists, filters and searches the catalog', async () => {
  const all = await runCli(['models', '-f', 'json'], catalogApi());
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(ids(all.stdout), ['alpha-chat', 'Wan-Video', 'zeta-chat']);

  const video = await runCli(['models', '-t', 'video', '-f', 'json'], catalogApi());
  assert.equal(video.status, 0, video.stderr);
  assert.deepEqual(ids(video.stdout), ['Wan-Video']);

  const search = await runCli(['models', '-s', 'foo', '--privacy', '-f', 'json'], catalogApi());
  assert.equal(search.status, 0, search.stderr);
  assert.deepEqual(ids(search.stdout), ['zeta-chat']);

  const pretty = await runCli(['models'], catalogApi());
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.match(pretty.stdout, /Available Models \(3\)/);
  assert.match(pretty.stdout, /zeta-chat/);
});

test('models show finds a model across all types, ignoring case', async () => {
  const result = await runCli(['models', 'show', 'wan-video', '-f', 'json'], catalogApi());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), videoModels[0]);
  assert.ok(result.requests.some((request) => request.path === '/models'));
});

test('models show reads -t and -f wherever they are placed', async () => {
  for (const args of [
    ['models', 'show', 'Wan-Video', '-t', 'video', '-f', 'json'],
    ['models', 'show', '-t', 'video', 'Wan-Video', '--format=json'],
    ['models', '-t', 'video', '-f', 'json', 'show', 'Wan-Video'],
    ['models', 'show', 'Wan-Video', '--type', 'VIDEO', '--format', 'json'],
  ]) {
    const result = await runCli(args, catalogApi());
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).id, 'Wan-Video', args.join(' '));
    assert.deepEqual(result.requests.map((request) => request.path), ['/models?type=video'], args.join(' '));
  }
});

test('models show explains how to find ids when the model is missing', async () => {
  const result = await runCli(['models', 'show', 'nope', '-t', 'image'], catalogApi());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No model "nope" in the "image" catalog/);
  assert.match(result.stderr, /venice models -t <type>/);
  assert.equal(result.stdout, '');
});

test('models show prints capabilities, constraints and pricing readably', async () => {
  const result = await runCli(['models', 'show', 'zeta-chat', '-f', 'pretty'], catalogApi());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zeta-chat — Zeta Chat/);
  assert.match(result.stdout, /Owned by: venice\.ai/);
  assert.match(result.stdout, /availableContextTokens: 131072/);
  assert.match(result.stdout, /supportsVision: yes/);
  assert.match(result.stdout, /input\.usd: 0\.5/);

  const video = await runCli(['models', 'show', 'Wan-Video', '-f', 'pretty'], catalogApi());
  assert.equal(video.status, 0, video.stderr);
  assert.match(video.stdout, /Constraints\n.*\n {2}durations: 5s, 10s/);
});

test('models show sanitises every server string in pretty output', async () => {
  const hostile = {
    id: `bad-${HOSTILE}`,
    type: HOSTILE,
    owned_by: HOSTILE,
    model_spec: {
      name: HOSTILE,
      description: HOSTILE,
      traits: [HOSTILE],
      [HOSTILE]: HOSTILE,
      capabilities: { [HOSTILE]: true },
      constraints: { list: [{ value: HOSTILE }] },
      pricing: { input: { [HOSTILE]: HOSTILE } },
    },
  };
  const result = await runCli(
    ['models', 'show', `bad-${HOSTILE}`, '-f', 'pretty'],
    catalogApi({ '/models': { data: [hostile] } })
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /evil/);
  assert.doesNotMatch(result.stdout, /[\u001b\u0007\u202e]/);
});

test('models traits and compat fetch the mapping for a type', async () => {
  const api = catalogApi({
    '/models/traits?type=image': { data: { default: 'flux-2-pro', fastest: HOSTILE }, object: 'list', type: 'image' },
    '/models/compatibility_mapping': { data: { 'gpt-4o': 'zeta-chat' }, object: 'list', type: 'text' },
  });

  const traits = await runCli(['models', 'traits', '-t', 'image', '-f', 'pretty'], api);
  assert.equal(traits.status, 0, traits.stderr);
  assert.deepEqual(traits.requests.map((request) => request.path), ['/models/traits?type=image']);
  assert.match(traits.stdout, /Model traits \(image\)/);
  assert.match(traits.stdout, /default\s+flux-2-pro/);
  assert.doesNotMatch(traits.stdout, /[\u001b\u0007\u202e]/);

  const compat = await runCli(['models', 'compat', '-f', 'json'], api);
  assert.equal(compat.status, 0, compat.stderr);
  assert.deepEqual(compat.requests.map((request) => request.path), ['/models/compatibility_mapping']);
  assert.deepEqual(JSON.parse(compat.stdout), { data: { 'gpt-4o': 'zeta-chat' }, object: 'list', type: 'text' });

  const placed = await runCli(['models', '-f', 'json', 'traits', '--type', 'image'], api);
  assert.equal(placed.status, 0, placed.stderr);
  assert.equal(JSON.parse(placed.stdout).type, 'image');
});

test('models traits rejects a malformed mapping', async () => {
  const result = await runCli(
    ['models', 'traits'],
    catalogApi({ '/models/traits': { data: { default: 42 } } })
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected response from Venice: the model traits is missing or malformed/);
});
