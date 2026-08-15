import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  apiRequest,
  chatCompletion,
  chatCompletionStream,
  completeVideo,
  cryptoRpc,
  dedicatedWebSearch,
  getCharacter,
  getCharacterReviews,
  listCharacters,
  listCryptoNetworks,
  listModels,
  parseDocument,
  queueVideoGeneration,
  queueVideoUpscale,
  quoteVideoGeneration,
  scrapeWebPage,
  transcribeVideo,
  videoUrlFromStatus,
  RequestCancelledError,
  VeniceApiError,
} from './api.js';
import type { Character, CharacterReviewsPage } from '../types/index.js';

function trackAbortListeners(signal: AbortSignal): {
  active: () => number;
  restore: () => void;
} {
  const listeners = new Set<Parameters<AbortSignal['addEventListener']>[1]>();
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);

  signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
    const [type, listener] = args;
    if (type === 'abort') listeners.add(listener);
    originalAdd(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    const [type, listener] = args;
    if (type === 'abort') listeners.delete(listener);
    originalRemove(...args);
  }) as typeof signal.removeEventListener;

  return {
    active: () => listeners.size,
    restore: () => {
      signal.addEventListener = originalAdd;
      signal.removeEventListener = originalRemove;
    },
  };
}

function stalledResponse(signal?: AbortSignal): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('chat cancellation aborts non-streaming response body consumption', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const controller = new AbortController();
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input, init) =>
    stalledResponse(init?.signal ?? undefined)) as typeof fetch;

  try {
    const completion = chatCompletion(
      [{ role: 'user', content: 'wait' }],
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(completion, RequestCancelledError);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('chat cancellation remains active while a streaming body is consumed', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const controller = new AbortController();
  const listenerTracker = trackAbortListeners(controller.signal);
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input, init) =>
    stalledResponse(init?.signal ?? undefined)) as typeof fetch;

  try {
    const stream = chatCompletionStream(
      [{ role: 'user', content: 'wait' }],
      { signal: controller.signal }
    );
    const nextChunk = stream.next();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(nextChunk, RequestCancelledError);
    assert.equal(listenerTracker.active(), 0);
  } finally {
    listenerTracker.restore();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('stream request timeout ends after headers while cancellation listener lasts through body', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const controller = new AbortController();
  const listenerTracker = trackAbortListeners(controller.signal);
  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = (async (_input, init) => {
    const requestSignal = init?.signal ?? undefined;
    return new Response(new ReadableStream({
      start(streamController) {
        const delayedChunk = setTimeout(() => {
          streamController.enqueue(new TextEncoder().encode('data: healthy\n\n'));
          streamController.close();
        }, 40);
        requestSignal?.addEventListener('abort', () => {
          clearTimeout(delayedChunk);
          streamController.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    }));
  }) as typeof fetch;

  try {
    const response = await apiRequest<Response>('/stream-timeout-test', {
      stream: true,
      showSpinner: false,
      retries: 0,
      timeoutMs: 10,
      signal: controller.signal,
    });
    assert.equal(listenerTracker.active(), 1);
    assert.equal(await response.text(), 'data: healthy\n\n');
    assert.equal(listenerTracker.active(), 0);
  } finally {
    listenerTracker.restore();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('JSON request timeout ends after headers while a healthy body is consumed', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input, init) => delayedResponse(
    JSON.stringify({ status: 'healthy' }),
    40,
    init?.signal ?? undefined
  )) as typeof fetch;

  try {
    const startedAt = Date.now();
    const result = await apiRequest<{ status: string }>('/delayed-json-test', {
      showSpinner: false,
      retries: 0,
      timeoutMs: 10,
    });
    assert.deepEqual(result, { status: 'healthy' });
    assert.ok(Date.now() - startedAt >= 30);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('VENICE_API_KEY', originalApiKey);
  }
});

test('JSON request timeout ends after headers while an HTTP error body is consumed', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input, init) => delayedResponse(
    JSON.stringify({ error: { message: 'Delayed rejection', code: 'delayed_error' } }),
    40,
    init?.signal ?? undefined,
    400
  )) as typeof fetch;

  try {
    const startedAt = Date.now();
    await assert.rejects(
      apiRequest('/delayed-error-test', {
        showSpinner: false,
        retries: 0,
        timeoutMs: 10,
      }),
      (error: unknown) => {
        assert.ok(error instanceof VeniceApiError);
        assert.equal(error.message, 'Delayed rejection');
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 'delayed_error');
        return true;
      }
    );
    assert.ok(Date.now() - startedAt >= 30);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('VENICE_API_KEY', originalApiKey);
  }
});

test('external abort remains active during JSON body consumption and cleans up', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const controller = new AbortController();
  const listenerTracker = trackAbortListeners(controller.signal);
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input, init) => delayedResponse(
    JSON.stringify({ status: 'too late' }),
    100,
    init?.signal ?? undefined
  )) as typeof fetch;

  try {
    const request = apiRequest('/cancel-delayed-json-test', {
      showSpinner: false,
      retries: 0,
      timeoutMs: 5,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(request, RequestCancelledError);
    assert.equal(listenerTracker.active(), 0);
  } finally {
    listenerTracker.restore();
    globalThis.fetch = originalFetch;
    restoreEnv('VENICE_API_KEY', originalApiKey);
  }
});

test('cancelling a streaming response removes its external abort listener', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const controller = new AbortController();
  const listenerTracker = trackAbortListeners(controller.signal);
  let sourceCancelled = false;
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(new ReadableStream({
    cancel() {
      sourceCancelled = true;
    },
  }))) as typeof fetch;

  try {
    const response = await apiRequest<Response>('/stream-cancel-test', {
      stream: true,
      showSpinner: false,
      retries: 0,
      timeoutMs: 10,
      signal: controller.signal,
    });
    assert.equal(listenerTracker.active(), 1);
    await response.body?.cancel();
    assert.equal(sourceCancelled, true);
    assert.equal(listenerTracker.active(), 0);
  } finally {
    listenerTracker.restore();
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('augment API helpers send the documented requests', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-augment-test-'));
  const documentPath = join(tempDir, 'notes.txt');
  const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];

  process.env.VENICE_API_KEY = 'test-key';
  writeFileSync(documentPath, 'private document contents');

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    let body = '';
    if (init?.body && typeof init.body === 'string') {
      body = init.body;
    } else if (init?.body) {
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks).toString('utf-8');
    }

    const url = String(input);
    requests.push({ url, init, body });

    if (url.endsWith('/augment/search')) {
      return jsonResponse({
        query: 'privacy news',
        results: [{
          title: 'Result',
          url: 'https://example.com/result',
          content: 'Snippet',
          date: '2026-08-14',
        }],
      });
    }
    if (url.endsWith('/augment/scrape')) {
      return jsonResponse({
        url: 'https://example.com',
        content: '# Example',
        format: 'markdown',
      });
    }
    return jsonResponse({ text: 'private document contents', tokens: 3 });
  }) as typeof fetch;

  try {
    const search = await dedicatedWebSearch('privacy news', {
      limit: 7,
      provider: 'google',
    });
    const scrape = await scrapeWebPage('https://example.com');
    const parsed = await parseDocument(documentPath);

    assert.equal(search.results[0].title, 'Result');
    assert.equal(scrape.content, '# Example');
    assert.deepEqual(parsed, { text: 'private document contents', tokens: 3 });

    assert.deepEqual(JSON.parse(requests[0].body), {
      query: 'privacy news',
      limit: 7,
      search_provider: 'google',
    });
    assert.deepEqual(JSON.parse(requests[1].body), {
      url: 'https://example.com',
    });
    assert.match(requests[2].body, /name="response_format"\r\n\r\njson/);
    assert.match(requests[2].body, /filename="notes.txt"/);
    assert.match(requests[2].body, /private document contents/);
    assert.match(
      String((requests[2].init?.headers as Record<string, string>)['Content-Type']),
      /^multipart\/form-data; boundary=/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const sampleCharacter: Character = {
  id: '2f460055-7595-4640-9cb6-c442c4c869b0',
  slug: 'alan-watts',
  name: 'Alan Watts',
  description: 'British and American writer and speaker.',
  tags: ['Philosophy', 'Buddhism'],
  adult: false,
  featured: true,
  modelId: 'venice-uncensored-1-2',
  author: 'k3x9q',
  createdAt: '2024-12-20T21:28:08.934Z',
  updatedAt: '2025-02-09T03:23:53.708Z',
  webEnabled: true,
  shareUrl: 'https://venice.ai/c/alan-watts',
  photoUrl: null,
  stats: {
    averageRating: 4.7,
    imports: 112,
    ratingCount: 24,
    ratingSum: 113,
    userRating: null,
  },
};

const sampleReviews: CharacterReviewsPage = {
  object: 'list',
  data: [{
    id: '1e38fb78-043f-4ce2-b3bc-966089c25467',
    characterId: sampleCharacter.id,
    createdAt: '2025-02-09T03:23:53.708Z',
    isOwner: false,
    locale: 'en',
    message: 'Thoughtful and practical.',
    rating: 5,
    userAvatarUrl: null,
    username: 'product_user_42',
  }],
  pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
  summary: { averageRating: 4.7, totalReviews: 1 },
};

test('character API helpers send documented requests and surface errors', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const requests: Array<{ url: string; method?: string }> = [];

  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method });

    const parsed = new URL(url);

    if (parsed.pathname.endsWith('/characters/missing')) {
      return new Response(JSON.stringify({ error: { message: 'Character not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (parsed.pathname.endsWith('/characters/alan-watts/reviews')) {
      return jsonResponse(sampleReviews);
    }

    if (parsed.pathname.endsWith('/characters/alan-watts')) {
      return jsonResponse({ object: 'character', data: sampleCharacter });
    }

    if (parsed.pathname.endsWith('/characters')) {
      return jsonResponse({ object: 'list', data: [sampleCharacter] });
    }

    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    const listed = await listCharacters({
      search: 'philosophy',
      limit: 200,
      offset: 10,
      showSpinner: false,
    });
    assert.equal(listed[0].slug, 'alan-watts');

    const character = await getCharacter('alan-watts', { showSpinner: false });
    assert.equal(character.name, 'Alan Watts');
    assert.equal(character.modelId, 'venice-uncensored-1-2');

    const reviews = await getCharacterReviews('alan-watts', {
      page: 1,
      pageSize: 20,
      showSpinner: false,
    });
    assert.equal(reviews.data[0].rating, 5);
    assert.equal(reviews.summary.totalReviews, 1);

    await assert.rejects(
      () => getCharacter('missing', { showSpinner: false }),
      /Character not found/
    );

    const listUrl = new URL(requests[0].url);
    assert.equal(listUrl.searchParams.get('search'), 'philosophy');
    assert.equal(listUrl.searchParams.get('limit'), '100');
    assert.equal(listUrl.searchParams.get('offset'), '10');
    assert.match(requests[0].url, /\/characters\?/);

    assert.match(requests[1].url, /\/characters\/alan-watts$/);
    assert.match(requests[2].url, /\/characters\/alan-watts\/reviews\?/);
    const reviewsUrl = new URL(requests[2].url);
    assert.equal(reviewsUrl.searchParams.get('page'), '1');
    assert.equal(reviewsUrl.searchParams.get('pageSize'), '20');

    const defaults = await listCharacters({ showSpinner: false });
    assert.equal(defaults[0].slug, 'alan-watts');
    const defaultUrl = new URL(requests[4].url);
    assert.equal(defaultUrl.searchParams.get('limit'), '50');
    assert.equal(defaultUrl.searchParams.get('offset'), '0');
    assert.equal(defaultUrl.searchParams.has('search'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});

test('video API helpers send documented requests and support live discovery', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body && typeof init.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    requests.push({ url, body });

    if (url.includes('/video/quote')) return jsonResponse({ quote: 0.12 });
    if (url.includes('/video/complete')) return jsonResponse({ success: true });
    if (url.includes('/video/transcriptions')) {
      return jsonResponse({ transcript: 'hello from the clip', lang: 'en' });
    }
    if (url.includes('/video/queue')) {
      return jsonResponse({ queue_id: 'q-1', model: body.model });
    }
    if (url.includes('/models?type=video')) {
      return jsonResponse({ data: [{ id: 'veo3-fast-text-to-video', type: 'video' }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    assert.equal(videoUrlFromStatus({ status: 'completed', url: 'https://video' }), 'https://video');
    assert.equal((await quoteVideoGeneration({
      model: 'veo3-fast-text-to-video',
      duration: '5s',
      aspectRatio: '16:9',
    })).quote, 0.12);
    assert.equal((await completeVideo('q-1', 'veo3-fast-text-to-video')).success, true);
    assert.equal((await transcribeVideo('https://example.com/clip.mp4')).lang, 'en');
    assert.equal((await queueVideoGeneration('sunset')).queue_id, 'q-1');
    assert.equal((await queueVideoUpscale('https://example.com/clip.mp4', {
      upscaleFactor: 2,
    })).model, 'topaz-video-upscale');
    assert.equal((await listModels({ type: 'video', showSpinner: false }))[0].type, 'video');

    assert.deepEqual(requests[0].body, {
      model: 'veo3-fast-text-to-video',
      duration: '5s',
      aspect_ratio: '16:9',
    });
    assert.deepEqual(requests[3].body, {
      model: 'wan-2.6-text-to-video',
      prompt: 'sunset',
      duration: '5s',
    });
    assert.deepEqual(requests[4].body, {
      model: 'topaz-video-upscale',
      video_url: 'https://example.com/clip.mp4',
      upscale_factor: 2,
    });
    assert.match(requests[5].url, /\/models\?type=video$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function delayedResponse(
  body: string,
  delayMs: number,
  signal?: AbortSignal,
  status = 200
): Response {
  return new Response(new ReadableStream({
    start(controller) {
      const delayedChunk = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }, delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(delayedChunk);
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('listCryptoNetworks is a public GET without Authorization', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalHome = process.env.HOME;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-rpc-networks-'));
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.HOME = tempDir;
  delete process.env.VENICE_API_KEY;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      networks: ['base-mainnet', 'ethereum-mainnet'],
    });
  }) as typeof fetch;

  try {
    const networks = await listCryptoNetworks();
    assert.deepEqual(networks, ['base-mainnet', 'ethereum-mainnet']);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/crypto\/rpc\/networks$/);
    assert.equal(requests[0].init?.method ?? 'GET', 'GET');
    assert.equal(getHeader(requests[0].init, 'Authorization'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('VENICE_API_KEY', originalApiKey);
    restoreEnv('HOME', originalHome);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cryptoRpc posts JSON-RPC with an API key and captures cost headers', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const requests: Array<{ url: string; init?: RequestInit; body: string }> = [];

  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init, body: readBody(init) });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Venice-RPC-Credits': '20',
          'X-Venice-RPC-Cost-USD': '0.00001250',
        },
      }
    );
  }) as typeof fetch;

  try {
    const result = await cryptoRpc('ethereum-mainnet', {
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1,
    });

    assert.deepEqual(result.body, { jsonrpc: '2.0', id: 1, result: '0x1' });
    assert.equal(result.credits, '20');
    assert.equal(result.costUsd, '0.00001250');
    assert.match(requests[0].url, /\/crypto\/rpc\/ethereum-mainnet$/);
    assert.equal(requests[0].init?.method, 'POST');
    assert.equal(getHeader(requests[0].init, 'Authorization'), 'Bearer test-key');
    assert.deepEqual(JSON.parse(requests[0].body), {
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('VENICE_API_KEY', originalApiKey);
  }
});

test('cryptoRpc rejects malformed network slugs before routing', async () => {
  await assert.rejects(
    () => cryptoRpc('../ethereum-mainnet', {
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1,
    }),
    /Invalid RPC network slug/
  );
});

function readBody(init?: RequestInit): string {
  if (!init?.body) return '';
  if (typeof init.body === 'string') return init.body;
  return String(init.body);
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return match?.[1];
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? record[key] : undefined;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
