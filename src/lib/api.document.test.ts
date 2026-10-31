import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from './api.js';

const DOCUMENT_PARSE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DOCUMENT_PARSE_RESPONSE_BYTES = 50 * 1024 * 1024;

function createDocument(filename = 'document.txt'): {
  path: string;
  remove: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'venice-document-parse-test-'));
  const path = join(directory, filename);
  writeFileSync(path, 'private document contents');
  return {
    path,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('parseDocument keeps its timeout active while reading the response body', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalApiKey = process.env.VENICE_API_KEY;
  const document = createDocument();
  let bodyAborted = false;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => originalSetTimeout(
    callback,
    delay === DOCUMENT_PARSE_TIMEOUT_MS ? 10 : delay,
    ...args
  )) as typeof setTimeout;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          bodyAborted = true;
          controller.error(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      },
    }));
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => parseDocument(document.path),
      /Document parsing timed out after 10 minutes/
    );
    assert.equal(bodyAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
    document.remove();
  }
});

test('parseDocument reads only the start of an oversized error response', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const document = createDocument();
  let bytesPulled = 0;
  let bodyCancelled = false;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = new Uint8Array(16 * 1024).fill(0x41);
      bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      bodyCancelled = true;
    },
  }), {
    status: 413,
    headers: {
      'Content-Length': String(MAX_DOCUMENT_PARSE_RESPONSE_BYTES + 1),
    },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => parseDocument(document.path),
      (error: Error) => {
        assert.equal(error.message, `${'A'.repeat(1000)}… (truncated)`);
        return true;
      }
    );
    assert.equal(bodyCancelled, true);
    assert.ok(bytesPulled <= 128 * 1024, `pulled ${bytesPulled} bytes`);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
    document.remove();
  }
});

test('parseDocument rejects oversized chunked success responses', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const document = createDocument();
  const chunk = new Uint8Array(1024 * 1024);
  let bodyCancelled = false;

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      bodyCancelled = true;
    },
  }))) as typeof fetch;

  try {
    await assert.rejects(
      () => parseDocument(document.path),
      /Document parse response exceeded the limit of 50\.0 MB/
    );
    assert.equal(bodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
    document.remove();
  }
});

test('parseDocument rejects empty and malformed JSON responses clearly', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const document = createDocument();
  const responses = [
    new Response(' \r\n\t'),
    new Response('{"text":'),
  ];

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => parseDocument(document.path),
      /Document parse response was empty; expected JSON/
    );
    await assert.rejects(
      () => parseDocument(document.path),
      /Document parse response contained malformed JSON/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
    document.remove();
  }
});

test('parseDocument sanitizes hostile multipart filenames', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const document = createDocument('report"\r\nX-Injected: yes.txt');
  let multipartBody = '';

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const chunks: Buffer[] = [];
    for await (const chunk of init?.body as unknown as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }
    multipartBody = Buffer.concat(chunks).toString('utf-8');
    return new Response(JSON.stringify({ text: 'parsed', tokens: 1 }));
  }) as typeof fetch;

  try {
    assert.deepEqual(
      await parseDocument(document.path),
      { text: 'parsed', tokens: 1 }
    );
    assert.match(
      multipartBody,
      /filename="report___X-Injected: yes\.txt"\r\nContent-Type: text\/plain/
    );
    assert.doesNotMatch(multipartBody, /filename="[^"]*"\r\nX-Injected:/);
    assert.equal(multipartBody.includes(document.path), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalApiKey;
    document.remove();
  }
});
