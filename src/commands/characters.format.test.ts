import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const routes: Record<string, unknown> = {
  '/api/v1/characters?limit=50&offset=0': {
    data: [{ slug: 'alan-watts', name: 'Alan Watts', tags: [] }],
  },
  '/api/v1/characters/alan-watts': {
    data: { slug: 'alan-watts', name: 'Alan Watts', description: 'Philosopher', tags: [] },
  },
  '/api/v1/characters/alan-watts/reviews': {
    data: [],
    summary: { averageRating: 0, totalReviews: 0 },
  },
};

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const server = createServer((request, response) => {
    const body = routes[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-characters-test-'));

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          VENICE_API_KEY: 'test-key',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('characters show prints JSON for -f json wherever the flag is placed', async () => {
  for (const args of [
    ['characters', 'show', 'alan-watts', '-f', 'json'],
    ['characters', 'show', 'alan-watts', '--format', 'json'],
    ['characters', 'show', 'alan-watts', '--format=json'],
    ['characters', 'show', '-f', 'json', 'alan-watts'],
    ['characters', '-f', 'json', 'show', 'alan-watts'],
  ]) {
    const result = await runCli(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.slug, 'alan-watts', args.join(' '));
    assert.deepEqual(parsed.reviews.summary, { averageRating: 0, totalReviews: 0 }, args.join(' '));
  }
});

test('characters show keeps pretty output for -f pretty', async () => {
  const result = await runCli(['characters', 'show', 'alan-watts', '-f', 'pretty']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\nalan-watts — Alan Watts\n/);
});

test('characters still lists the catalog as JSON with -f json', async () => {
  const result = await runCli(['characters', '-f', 'json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map((character: { slug: string }) => character.slug), ['alan-watts']);
});
