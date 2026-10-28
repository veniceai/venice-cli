import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { clearModelsCache, listModels } from './api.js';
import type { Model } from '../types/index.js';

const e2eeModel: Model = {
  id: 'e2ee-catalog-model',
  type: 'text',
  model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
};

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.VENICE_API_KEY;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function serveCatalog(respond: (type: string | null) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return respond(url.searchParams.get('type'));
  }) as typeof fetch;
}

beforeEach(() => {
  clearModelsCache();
  process.env.VENICE_API_KEY = 'test-key';
});

afterEach(() => {
  clearModelsCache();
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
  else process.env.VENICE_API_KEY = originalApiKey;
});

test('the catalog accepts responses larger than the default JSON limit', async () => {
  serveCatalog((type) => jsonResponse(
    type === null
      ? { data: [e2eeModel], padding: 'x'.repeat(17 * 1024 * 1024) }
      : { data: [] }
  ));

  const models = await listModels({ showSpinner: false });

  assert.deepEqual(models.map((model) => model.id), [e2eeModel.id]);
});
