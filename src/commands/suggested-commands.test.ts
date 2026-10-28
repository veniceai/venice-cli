import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const INVALID = '<not shown: an ID returned by the API looked invalid>';
const INJECTED = 'q1; touch marker #';

type Routes = Partial<Record<string, () => unknown>>;

async function runWithApi(routes: Routes, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routes[`${req.method} ${url.pathname.replace(/^\/api\/v1/, '')}`];
    req.resume();
    req.on('end', () => {
      res.writeHead(route ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route ? route() : { error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const home = mkdtempSync(join(tmpdir(), 'venice-suggested-'));
  writeFileSync(join(home, 'sample.wav'), 'RIFF....WAVE');

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
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
    rmSync(home, { recursive: true, force: true });
  }
}

function hint(stdout: string, label: string): string | undefined {
  return stdout.split('\n').find((line) => line.startsWith(label))?.slice(label.length);
}

test('video and music generate print a status command only for IDs that look valid', async () => {
  for (const [command, endpoint, model] of [
    ['video', 'POST /video/queue', 'wan-2.6-text-to-video'],
    ['music', 'POST /audio/queue', 'elevenlabs-music'],
  ]) {
    const valid = await runWithApi(
      { [endpoint]: () => ({ queue_id: 'q-123', model, status: 'QUEUED' }) },
      [command, 'generate', 'a prompt']
    );
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(hint(valid.stdout, 'Check status with: '), `venice ${command} status q-123 -m ${model}`);

    for (const response of [{ queue_id: INJECTED, model }, { queue_id: 'q-123', model: `${model} $(id)` }]) {
      const invalid = await runWithApi({ [endpoint]: () => ({ ...response, status: 'QUEUED' }) }, [command, 'generate', 'a prompt']);
      assert.equal(invalid.status, 0, invalid.stderr);
      assert.equal(hint(invalid.stdout, 'Check status with: '), INVALID, command);
    }
  }
});

test('voice clone prints a tts command only for a voice ID and model that look valid', async () => {
  const valid = await runWithApi(
    { 'POST /audio/voices': () => ({ id: 'voice-1', model: 'tts-chatterbox-hd' }) },
    ['voice', 'clone', 'sample.wav']
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(hint(valid.stdout, 'Use: '), 'venice tts -m tts-chatterbox-hd -v voice-1 "Hello"');

  const invalid = await runWithApi(
    { 'POST /audio/voices': () => ({ id: INJECTED, model: 'tts-chatterbox-hd' }) },
    ['voice', 'clone', 'sample.wav']
  );
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(hint(invalid.stdout, 'Use: '), INVALID);
});

test('characters show prints a chat command only for a slug that looks valid', async () => {
  const character = (slug: string) => ({
    data: {
      slug, name: 'Sample', description: 'd', tags: [], modelId: 'm',
      featured: false, adult: false, stats: { averageRating: 5, ratingCount: 1 },
    },
  });

  const valid = await runWithApi({ 'GET /characters/sample': () => character('alan-watts') }, ['characters', 'show', 'sample']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(hint(valid.stdout, 'Usage: '), 'venice chat -c alan-watts "Your message"');

  const invalid = await runWithApi({ 'GET /characters/sample': () => character(`alan-watts; touch marker #`) }, ['characters', 'show', 'sample']);
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(hint(invalid.stdout, 'Usage: '), INVALID);
});
