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

interface RecordedRequest {
  method?: string;
  url?: string;
  body: string;
}

async function runAgainstStub(args: string[]): Promise<{
  status: number | null;
  stderr: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'stub' } }));
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-numeric-options-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: homeDir,
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_KEY: 'test-key',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    });
    return { ...result, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('malformed numeric options are rejected before any request is sent', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['search', '-n', '1e1', 'q'], /--results must be an integer between 1 and 20 \(got "1e1"\)/],
    [['search', '-n', '2.9', 'q'], /--results must be/],
    [['search', '--raw', '-n', '12abc', 'q'], /--results must be/],
    [['image', '--cfg-scale', '0x10', 'p'], /--cfg-scale must be a number greater than 0 and at most 20/],
    [['image', '-n', ' 2 ', 'p'], /--count must be/],
    [['upscale', 'in.png', '-s', '2.9'], /--scale must be 2 or 4/],
    [['tts', '--temperature', '', 'hello'], /--temperature must be a number between 0 and 2 \(got ""\)/],
    [['tts', '-s', ' 3 ', 'hello'], /--speed must be/],
    [['music', 'generate', '-d', '0x10', 'p'], /--duration must be a positive integer/],
    [['music', 'quote', '--character-count', '1e3'], /--character-count must be/],
    [['video', 'upscale', 'https://media.example/v.mp4', '--factor', '2.9', '--no-wait'], /--factor must be 1, 2, or 4/],
    [['video', 'quote', '-m', 'topaz-video-upscale', '--factor', ''], /--factor must be/],
    [['video', 'status', 'q1', '-m', 'm1', '--wait', '--timeout', '1e309'], /--timeout must be/],
    [['video', 'status', 'q1', '-m', 'm1', '--wait', '--timeout', '86401'], /--timeout must be a number greater than 0 and at most 86400/],
    [['music', 'status', 'mq1', '--wait', '--timeout', '0x10'], /--timeout must be a number greater than 0 and at most 86400/],
    [['music', 'status', 'mq1', '--wait', '--timeout', '86401'], /--timeout must be/],
    [['keys', 'create', '-n', 'k', '-o', 'key.txt', '--usd-limit', '0x10'], /--usd-limit must be/],
    [['characters', '--limit', '1e1'], /--limit must be an integer between 1 and 100/],
    [['billing', 'usage', '--days', '7d'], /--days must be/],
    [['history', 'list', '-n', '0'], /--limit must be a positive integer/],
    [['usage', '-d', 'abc'], /--days must be/],
  ];

  for (let i = 0; i < cases.length; i += 5) {
    const batch = cases.slice(i, i + 5);
    const results = await Promise.all(batch.map(([args]) => runAgainstStub(args)));
    results.forEach((result, index) => {
      const [args, message] = batch[index];
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, message, args.join(' '));
      assert.deepEqual(result.requests, [], args.join(' '));
    });
  }
});

test('valid numeric options are sent as typed', async () => {
  const image = await runAgainstStub(['image', '--cfg-scale', '7.5', '--steps', '12', '-n', '2', 'p']);
  const imageRequest = image.requests.find((request) => request.url === '/api/v1/image/generate');
  assert.ok(imageRequest, image.stderr);
  const imageBody = JSON.parse(imageRequest.body) as Record<string, unknown>;
  assert.equal(imageBody.cfg_scale, 7.5);
  assert.equal(imageBody.steps, 12);
  assert.equal(imageBody.variants, 2);

  const speech = await runAgainstStub(['tts', '-s', '.5', '--temperature', '0', 'hello']);
  const speechRequest = speech.requests.find((request) => request.url === '/api/v1/audio/speech');
  assert.ok(speechRequest, speech.stderr);
  const speechBody = JSON.parse(speechRequest.body) as Record<string, unknown>;
  assert.equal(speechBody.speed, 0.5);
  assert.equal(speechBody.temperature, 0);
});
