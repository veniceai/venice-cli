import assert from 'node:assert/strict';
import test from 'node:test';
import { clearModelsCache, listModels } from './api.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('listModels returns defensive copies of the cached model array', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  let fetchCount = 0;

  clearModelsCache();
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCount++;
    const url = new URL(String(input));
    if (url.searchParams.has('type')) {
      return jsonResponse({ data: [] });
    }
    return jsonResponse({
      data: [
        { id: 'zeta', type: 'text' },
        { id: 'alpha', type: 'text' },
      ],
    });
  }) as typeof fetch;

  try {
    const first = await listModels({ showSpinner: false });
    first.sort((a, b) => a.id.localeCompare(b.id));
    first.splice(0, 1);

    const second = await listModels({ showSpinner: false });

    assert.notStrictEqual(first, second);
    assert.deepEqual(second.map((model) => model.id), ['zeta', 'alpha']);
    assert.equal(fetchCount, 9);
  } finally {
    clearModelsCache();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});
