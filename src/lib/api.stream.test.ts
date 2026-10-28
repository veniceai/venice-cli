import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

let handler: Handler = (_request, response) => {
  response.writeHead(404).end();
};

const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  response.on('error', () => undefined);
  await handler(request, response);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const homeDir = mkdtempSync(join(tmpdir(), 'venice-stream-test-'));

process.env.HOME = homeDir;
process.env.NODE_ENV = 'test';
process.env.VENICE_API_BASE_URL = `${origin}/api/v1`;
process.env.VENICE_API_KEY = 'test-key';
process.env.VENICE_TEST_STREAM_IDLE_TIMEOUT_MS = '300';
const api = await import('./api.js');

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(homeDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta }], ...extra });
}

function serveEvents(parts: string[], contentType = 'text/event-stream'): void {
  handler = async (_request, response) => {
    response.writeHead(200, { 'Content-Type': contentType });
    for (const part of parts) {
      if (response.destroyed) return;
      response.write(part);
      await sleep(5);
    }
    response.end();
  };
}

type StreamChunk = Record<string, unknown>;

async function collect(
  options: Parameters<typeof api.chatCompletionStream>[1] = {},
  chunks: StreamChunk[] = []
): Promise<StreamChunk[]> {
  for await (const value of api.chatCompletionStream(
    [{ role: 'user', content: 'hello' }],
    { model: 'stream-model', ...options }
  )) {
    chunks.push(value);
  }
  return chunks;
}

function content(chunks: StreamChunk[]): string {
  return chunks.map((value) => String(value.content ?? '')).join('');
}

test('spec-valid framing is parsed: optional space, CR line endings, multi-line data', async () => {
  const split = chunk({ content: 'B' });
  const cut = split.indexOf('"choices"');
  serveEvents([
    `data:${chunk({ content: 'A' })}\r\r`,
    `data: ${split.slice(0, cut)}\ndata: ${split.slice(cut)}\n\n`,
    ': keepalive\r\n\r\n',
    `data: ${chunk({ content: 'C' })}\r\n\r\ndata: [DONE]\n\n`,
  ]);

  assert.equal(content(await collect()), 'ABC');
});

test('a stream that ends without [DONE] is an error', async () => {
  serveEvents([`data: ${chunk({ content: 'first half' })}\n\n`]);
  const chunks: StreamChunk[] = [];
  await assert.rejects(collect({}, chunks), /Chat stream ended before the response was complete/);
  assert.equal(content(chunks), 'first half');
});

test('an error event fails the stream with the server message', async () => {
  serveEvents([
    `data: ${chunk({ content: 'partial ' })}\n\n`,
    'event: error\ndata: {"error":{"message":"UPSTREAM-CRASHED","code":"E500"}}\n\n',
    'data: [DONE]\n\n',
  ]);
  await assert.rejects(collect(), (error: Error) => {
    assert.equal(error.message, 'Chat stream failed: UPSTREAM-CRASHED');
    return true;
  });
});

test('an error payload fails the stream even when [DONE] follows', async () => {
  serveEvents([
    `data: ${chunk({ content: 'partial ' })}\n\n`,
    'data: {"error":{"message":"CONTEXT-OVERFLOW","type":"server_error"}}\n\ndata: [DONE]\n\n',
  ]);
  await assert.rejects(collect(), /Chat stream failed: CONTEXT-OVERFLOW/);
});

test('an event that is not valid JSON fails the stream', async () => {
  serveEvents([
    `data: ${chunk({ content: 'before ' })}\n\n`,
    'data: {"choices":[{"delta":{"content":"LOST\n\n',
    `data: ${chunk({ content: 'after' })}\n\ndata: [DONE]\n\n`,
  ]);
  await assert.rejects(collect(), /Chat stream sent an event that is not valid JSON/);
});

test('a response that is not text/event-stream is rejected', async () => {
  serveEvents([`data: ${chunk({ content: 'hi' })}\n\ndata: [DONE]\n\n`], 'application/json');
  await assert.rejects(
    collect(),
    /Chat stream returned Content-Type application\/json instead of text\/event-stream/
  );
});

test('keepalive comments do not keep a stalled stream alive', { timeout: 10_000 }, async () => {
  handler = async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${chunk({ content: 'partial' })}\n\n`);
    const stopAt = Date.now() + 5000;
    while (!response.destroyed && Date.now() < stopAt) {
      response.write(': keepalive\n\n');
      await sleep(50);
    }
    if (!response.destroyed) response.end();
  };

  const chunks: StreamChunk[] = [];
  const started = Date.now();
  await assert.rejects(collect({}, chunks), /Chat stream stalled: no data for 0\.3 seconds/);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(content(chunks), 'partial');
});

test('data events keep a slow stream alive past the idle timeout', { timeout: 10_000 }, async () => {
  handler = async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const word of ['one ', 'two ', 'three ', 'four ', 'five']) {
      response.write(`data: ${chunk({ content: word })}\n\n`);
      await sleep(150);
    }
    response.end('data: [DONE]\n\n');
  };

  assert.equal(content(await collect()), 'one two three four five');
});

test('an unterminated line longer than 1 MiB is rejected', { timeout: 10_000 }, async () => {
  handler = async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${chunk({ content: 'before ' })}\n\ndata: `);
    const block = Buffer.alloc(64 * 1024, 0x61);
    for (let sent = 0; sent < 2 * 1024 * 1024 && !response.destroyed; sent += block.length) {
      if (!response.write(block)) {
        await new Promise<void>((resolve) => {
          const resume = () => {
            response.off('drain', resume);
            response.off('close', resume);
            resolve();
          };
          response.on('drain', resume);
          response.on('close', resume);
        });
      }
    }
    if (!response.destroyed) response.end(`\n\ndata: ${chunk({ content: 'after' })}\n\ndata: [DONE]\n\n`);
  };

  await assert.rejects(collect(), /Event stream line exceeded the limit of 1\.0 MB/);
});

test('finish_reason, usage and the completion id are still yielded', async () => {
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  serveEvents([
    `data: ${JSON.stringify({ id: 'cmpl-9', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'cmpl-9', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'cmpl-9', choices: [], usage })}\n\n`,
    'data: [DONE]\n\n',
  ]);

  assert.deepEqual(await collect(), [
    { content: 'Hi', done: false, completionId: 'cmpl-9' },
    { finish_reason: 'stop', done: false, completionId: 'cmpl-9' },
    { done: true, usage, completionId: 'cmpl-9' },
  ]);
});
