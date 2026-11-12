import assert from 'node:assert/strict';
import test from 'node:test';
import { getBillingUsage, getBillingUsageCsv, type BillingUsageEntry } from './account-api.js';

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
      /Usage history has more than 100 pages; refusing to fetch more\. Use a shorter time range\./
    );
    assert.equal(pageCount(), 100);
  });
});

test('billing usage that stops at 100 small pages suggests a larger page size', async () => {
  await withUsagePages((page) => `cursor-${page}`, async () => {
    await assert.rejects(
      getBillingUsage({ ...range, pageSize: 10 }),
      /Use a shorter time range or a larger --page-size \(at most 1000\)\./
    );
  });
});

interface CsvPage {
  body: string;
  nextCursor?: string;
  contentType?: string;
}

async function withCsvPages(
  pages: CsvPage[],
  run: (requests: Array<{ url: URL; accept: string | null }>) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const requests: Array<{ url: URL; accept: string | null }> = [];

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: new URL(String(input)),
      accept: new Headers(init?.headers).get('accept'),
    });
    const page = pages[requests.length - 1];
    if (!page) throw new Error('unexpected extra page');
    const headers: Record<string, string> = { 'Content-Type': page.contentType ?? 'text/csv; charset=utf-8' };
    if (page.nextCursor) headers['X-Next-Cursor'] = page.nextCursor;
    return new Response(page.body, { headers });
  }) as typeof fetch;

  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
}

test('billing usage CSV stitches pages with one header row', async () => {
  await withCsvPages([
    { body: 'timestamp,sku,amount\r\n2026-10-21T00:00:00Z,a,1\r\n', nextCursor: 'c1' },
    { body: 'timestamp,sku,amount\r\n2026-10-22T00:00:00Z,b,2', nextCursor: 'c2' },
    { body: 'timestamp,sku,amount\r\n' },
  ], async (requests) => {
    const csv = await getBillingUsageCsv({ ...range, currency: 'USD', pageSize: 10 });
    assert.equal(
      csv,
      'timestamp,sku,amount\r\n2026-10-21T00:00:00Z,a,1\r\n2026-10-22T00:00:00Z,b,2\n'
    );
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.accept === 'text/csv'));
    assert.equal(requests[0].url.searchParams.get('startTimestamp'), range.startTimestamp);
    assert.equal(requests[0].url.searchParams.get('currency'), 'USD');
    assert.equal(requests[0].url.searchParams.get('pageSize'), '10');
    assert.deepEqual([...requests[1].url.searchParams.entries()], [['cursor', 'c1']]);
    assert.deepEqual([...requests[2].url.searchParams.entries()], [['cursor', 'c2']]);
  });
});

test('billing usage CSV rejects a repeated cursor', async () => {
  await withCsvPages([
    { body: 'h\n1\n', nextCursor: 'same' },
    { body: 'h\n2\n', nextCursor: 'same' },
  ], async (requests) => {
    await assert.rejects(getBillingUsageCsv(range), /repeated cursor/);
    assert.equal(requests.length, 2);
  });
});

test('billing usage CSV stops after 100 pages', async () => {
  const pages = Array.from({ length: 101 }, (_, index) => ({ body: 'h\n1\n', nextCursor: `c${index}` }));
  await withCsvPages(pages, async (requests) => {
    await assert.rejects(getBillingUsageCsv(range), /more than 100 pages/);
    assert.equal(requests.length, 100);
  });
});

test('billing usage CSV rejects non-CSV pages and mismatched headers', async () => {
  await withCsvPages([{ body: '{"data":[]}', contentType: 'application/json' }], async () => {
    await assert.rejects(getBillingUsageCsv(range), /did not return CSV \(received: application\/json\)/);
  });
  await withCsvPages([
    { body: 'a,b\n1,2\n', nextCursor: 'c1' },
    { body: 'a,c\n3,4\n' },
  ], async () => {
    await assert.rejects(getBillingUsageCsv(range), /different header rows/);
  });
});
