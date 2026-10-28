import assert from 'node:assert/strict';
import test from 'node:test';
import { getBillingUsage, type BillingUsageEntry } from './account-api.js';

const entry: BillingUsageEntry = {
  amount: 0.01,
  currency: 'USD',
  inferenceDetails: null,
  notes: '',
  pricePerUnitUsd: 0.01,
  sku: 'test-sku',
  timestamp: '2026-10-26T00:00:00Z',
  units: 1,
};

const range = {
  startTimestamp: '2026-10-21T00:00:00Z',
  endTimestamp: '2026-10-28T00:00:00Z',
};

async function withUsagePages(
  nextCursor: (page: number) => string | null,
  run: (pageCount: () => number) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  let pages = 0;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => {
    pages++;
    if (pages > 1000) throw new Error('runaway pagination');
    return new Response(JSON.stringify({ data: [entry], nextCursor: nextCursor(pages) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await run(() => pages);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
}

test('billing usage follows cursors until the last page', async () => {
  await withUsagePages((page) => (page < 3 ? `cursor-${page}` : null), async (pageCount) => {
    const entries = await getBillingUsage(range);
    assert.equal(entries.length, 3);
    assert.equal(pageCount(), 3);
  });
});

test('billing usage stops after 100 pages of fresh cursors', async () => {
  await withUsagePages((page) => `cursor-${page}`, async (pageCount) => {
    await assert.rejects(
      getBillingUsage(range),
      /Usage history has more than 100 pages; refusing to fetch more\. Use a shorter --days range\./
    );
    assert.equal(pageCount(), 100);
  });
});
