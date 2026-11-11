import assert from 'node:assert/strict';
import test from 'node:test';
import { reply, runCli, type RecordedRequest } from '../lib/test-cli.js';

const KEY_ID = 'e28e82dc-9df2-4b47-b726-d0a222ef2ab5';
const SECRET = 'venice-secret-0123456789';
const HOSTILE = 'evil\u001b]0;pwned\u0007\u001b[31mred\u202e';

const keyDetails = {
  apiKeyType: 'INFERENCE',
  consumptionLimits: { usd: 50, diem: null },
  limitPeriod: 'MONTH',
  modelPrivacy: 'PRIVATE_TEXT',
  createdAt: '2026-01-01T00:00:00Z',
  description: 'ci',
  expiresAt: null,
  id: KEY_ID,
  ipAllowlist: ['11.22.33.0/24'],
  last6Chars: '2V2jNW',
  lastUsedAt: '2026-02-01T00:00:00Z',
  usage: { trailingSevenDays: { usd: '10.2424', diem: '4.2231', vcu: '42.2315' } },
  currentPeriodUsage: { usd: '5.1234', diem: '2.5000' },
};

function keyApi(data: unknown) {
  return ({ path }: RecordedRequest): unknown =>
    path === `/api_keys/${KEY_ID}` ? { data } : undefined;
}

test('keys show requests one key and prints its metadata, limits and usage', async () => {
  const result = await runCli(['keys', 'show', KEY_ID, '-f', 'pretty'], keyApi(keyDetails));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests.map((request) => [request.method, request.path]), [['GET', `/api_keys/${KEY_ID}`]]);
  assert.match(result.stdout, /API Key ci/);
  assert.match(result.stdout, /Type: INFERENCE/);
  assert.match(result.stdout, /Key: …2V2jNW/);
  assert.match(result.stdout, /Expires: never/);
  assert.match(result.stdout, /Model privacy: PRIVATE_TEXT/);
  assert.match(result.stdout, /IP allowlist: 11\.22\.33\.0\/24/);
  assert.match(result.stdout, /USD limit: 50\nDIEM limit: none\nLimit period: MONTH/);
  assert.match(result.stdout, /Current period: 5\.1234 USD, 2\.5000 DIEM/);
  assert.match(result.stdout, /Last 7 days: 10\.2424 USD, 4\.2231 DIEM/);
});

test('keys show never prints a key secret or unknown fields', async () => {
  const leaky = { ...keyDetails, apiKey: SECRET, key: SECRET, secretNote: SECRET };
  for (const format of ['json', 'pretty']) {
    const result = await runCli(['keys', 'show', KEY_ID, '-f', format], keyApi(leaky));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /venice-secret/, format);
    if (format === 'json') {
      const printed = JSON.parse(result.stdout);
      assert.equal(printed.id, KEY_ID);
      assert.equal(printed.modelPrivacy, 'PRIVATE_TEXT');
      assert.deepEqual(printed.ipAllowlist, ['11.22.33.0/24']);
      assert.deepEqual(printed.currentPeriodUsage, keyDetails.currentPeriodUsage);
      assert.equal('apiKey' in printed, false);
    }
  }
});

test('keys show sanitises server strings in pretty output', async () => {
  const hostile = {
    ...keyDetails,
    description: HOSTILE,
    last6Chars: HOSTILE,
    modelPrivacy: HOSTILE,
    ipAllowlist: [HOSTILE],
    usage: { trailingSevenDays: { usd: HOSTILE, diem: HOSTILE } },
  };
  const result = await runCli(['keys', 'show', KEY_ID, '-f', 'pretty'], keyApi(hostile));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /evil/);
  assert.doesNotMatch(result.stdout, /[\u001b\u0007\u202e]/);
});

test('keys show refuses an invalid key ID without a request', async () => {
  const result = await runCli(['keys', 'show', SECRET], keyApi(keyDetails));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid API key ID/);
  assert.deepEqual(result.requests, []);
});

test('keys show rejects malformed key details', async () => {
  const result = await runCli(['keys', 'show', KEY_ID], keyApi({ ...keyDetails, id: 42 }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the API key details are missing or malformed/);
});

test('keys rate-limit-logs prints a table, or the entries as JSON', async () => {
  const entry = {
    apiKeyId: KEY_ID,
    modelId: 'zai-org-glm-5-1',
    rateLimitTier: 'paid',
    rateLimitType: 'RPM',
    timestamp: '2026-03-01T12:00:00Z',
  };
  const api = ({ path }: RecordedRequest) =>
    path === '/api_keys/rate_limits/log' ? { data: [entry], object: 'list' } : undefined;

  const pretty = await runCli(['keys', 'rate-limit-logs', '-f', 'pretty'], api);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.deepEqual(pretty.requests.map((request) => request.path), ['/api_keys/rate_limits/log']);
  assert.match(pretty.stdout, /Time\s+Key ID\s+Model\s+Limit\s+Tier/);
  assert.match(pretty.stdout, new RegExp(`2026-03-01T12:00:00Z\\s+${KEY_ID}\\s+zai-org-glm-5-1\\s+RPM\\s+paid`));

  const json = await runCli(['keys', 'rate-limit-logs', '-f', 'json'], api);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), [entry]);
});

test('keys rate-limit-logs sanitises entries and handles an empty log', async () => {
  const hostile = {
    apiKeyId: HOSTILE,
    modelId: HOSTILE,
    rateLimitTier: HOSTILE,
    rateLimitType: HOSTILE,
    timestamp: HOSTILE,
  };
  const result = await runCli(
    ['keys', 'rate-limit-logs', '-f', 'pretty'],
    () => ({ data: [hostile], object: 'list' })
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /[\u001b\u0007\u202e]/);

  const empty = await runCli(['keys', 'rate-limit-logs'], () => ({ data: [], object: 'list' }));
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No exceeded rate limits recorded/);

  const malformed = await runCli(['keys', 'rate-limit-logs'], () => reply(200, { data: [{ modelId: 1 }] }));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /the rate limit logs are missing or malformed/);
});
