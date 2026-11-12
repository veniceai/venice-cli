import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/test-env.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function withApiServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (run: (args: string[]) => Promise<CliResult>) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-characters-options-test-'));
  const run = (args: string[]) => new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: childEnv({
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        VENICE_API_KEY: 'test-key',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });

  try {
    await callback(run);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function reviewsPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'list',
    data: [],
    pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
    summary: { averageRating: 0, totalReviews: 0 },
    ...overrides,
  };
}

test('characters sends repeatable filters and only the booleans that were given', async () => {
  const urls: URL[] = [];
  await withApiServer((request, response) => {
    urls.push(new URL(request.url ?? '/', 'http://localhost'));
    sendJson(response, { data: [] });
  }, async (run) => {
    const result = await run([
      'characters',
      '--tag', 'philosophy', '--tag', 'zen', '--tag', 'philosophy',
      '--category', 'education', '--category', 'history',
      '--model', 'venice-uncensored', '--model', 'qwen3-235b',
      '--no-adult', '--pro',
      '--sort', 'highestRating', '--order', 'desc',
      '-f', 'json',
    ]);
    assert.equal(result.status, 0, result.stderr);

    const plain = await run(['characters', '-f', 'json']);
    assert.equal(plain.status, 0, plain.stderr);
  });

  const query = urls[0].searchParams;
  assert.equal(urls[0].pathname, '/api/v1/characters');
  assert.deepEqual(query.getAll('tags'), ['philosophy', 'zen']);
  assert.deepEqual(query.getAll('categories'), ['education', 'history']);
  assert.deepEqual(query.getAll('modelId'), ['venice-uncensored', 'qwen3-235b']);
  assert.equal(query.get('isAdult'), 'false');
  assert.equal(query.get('isPro'), 'true');
  assert.equal(query.has('isWebEnabled'), false);
  assert.equal(query.get('sortBy'), 'highestRating');
  assert.equal(query.get('sortOrder'), 'desc');

  assert.equal(urls[1].search, '?limit=50&offset=0');
});

test('characters rejects invalid filters before any request', async () => {
  let requests = 0;
  await withApiServer((_request, response) => {
    requests++;
    sendJson(response, { data: [] });
  }, async (run) => {
    const tooManyTags = Array.from({ length: 21 }, (_, index) => ['--tag', `t${index}`]).flat();
    const cases: Array<[string[], RegExp]> = [
      [['--sort', 'popular'], /--sort must be one of: featured, highestRating/],
      [['--order', 'up'], /--order must be asc or desc/],
      [tooManyTags, /--tag can be given at most 20 times/],
      [['--category', 'c'.repeat(101)], /--category values must be 1-100 characters/],
      [['--model', ''], /--model values must be 1-200 characters/],
      [['--search', 's'.repeat(201)], /--search must be at most 200 characters/],
    ];
    for (const [args, message] of cases) {
      const result = await run(['characters', ...args]);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
    }
  });
  assert.equal(requests, 0);
});

test('characters reviews sends page and pageSize and prints JSON wherever -f is placed', async () => {
  const urls: string[] = [];
  await withApiServer((request, response) => {
    urls.push(request.url ?? '');
    sendJson(response, reviewsPage());
  }, async (run) => {
    for (const args of [
      ['characters', 'reviews', 'alan-watts', '--page', '2', '--page-size', '25', '-f', 'json'],
      ['characters', '-f', 'json', 'reviews', 'alan-watts', '--page', '2', '--page-size', '25'],
    ]) {
      const result = await run(args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout).summary, { averageRating: 0, totalReviews: 0 });
    }
    const defaults = await run(['characters', 'reviews', 'alan-watts', '-f', 'json']);
    assert.equal(defaults.status, 0, defaults.stderr);
  });

  assert.deepEqual(urls, [
    '/api/v1/characters/alan-watts/reviews?page=2&pageSize=25',
    '/api/v1/characters/alan-watts/reviews?page=2&pageSize=25',
    '/api/v1/characters/alan-watts/reviews',
  ]);
});

test('characters reviews rejects invalid input before any request', async () => {
  let requests = 0;
  await withApiServer((_request, response) => {
    requests++;
    sendJson(response, reviewsPage());
  }, async (run) => {
    const cases: Array<[string[], RegExp]> = [
      [['../admin'], /Character slug must be 1-200 letters/],
      [['alan-watts', '--page', '0'], /--page must be a positive integer/],
      [['alan-watts', '--page-size', '101'], /--page-size must be an integer between 1 and 100/],
    ];
    for (const [args, message] of cases) {
      const result = await run(['characters', 'reviews', ...args]);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
    }
  });
  assert.equal(requests, 0);
});

test('characters reviews pretty output sanitises review text and hints the next page', async () => {
  await withApiServer((_request, response) => {
    sendJson(response, reviewsPage({
      data: [{
        id: 'r1',
        characterId: 'c1',
        createdAt: '2026-10-01T00:00:00Z',
        isOwner: false,
        locale: null,
        message: 'Great\u001b[2J\u001b]0;title\u0007 chat\u202e',
        rating: 4,
        userAvatarUrl: null,
        username: 'eve\u009b31m',
      }],
      pagination: { page: 2, pageSize: 1, total: 3, totalPages: 3 },
      summary: { averageRating: '4.5\u001b[31m', totalReviews: 3 },
    }));
  }, async (run) => {
    const result = await run(['characters', 'reviews', 'alan-watts', '--page', '2', '--page-size', '1', '-f', 'pretty']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Reviews for alan-watts/);
    assert.match(result.stdout, /Page 2 of 3/);
    assert.match(result.stdout, /★★★★☆ {2}eve/);
    assert.match(result.stdout, /Great chat/);
    assert.match(result.stdout, /Next page: venice characters reviews alan-watts --page 3 --page-size 1/);
    assert.doesNotMatch(result.stdout, /[\u001b\u0007\u009b\u202e]/);
  });
});
