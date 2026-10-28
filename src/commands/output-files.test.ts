import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function withApi(
  callback: (baseUrl: string, homeDir: string, workDir: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url === '/audio/speech') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end('ID3-speech');
        return;
      }
      if (request.url === '/embeddings') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ embedding: [0.25, 0.5], index: 0 }] }));
        return;
      }
      if (request.url === '/augment/scrape') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          url: 'https://example.com/',
          content: '# Scraped',
          format: 'markdown',
        }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-output-home-'));
  const workDir = mkdtempSync(join(tmpdir(), 'venice-output-cwd-'));

  try {
    await callback(`http://127.0.0.1:${port}`, homeDir, workDir);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function runCli(
  args: string[],
  baseUrl: string,
  homeDir: string,
  workDir: string
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: workDir,
      env: {
        ...process.env,
        HOME: homeDir,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: baseUrl,
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
}

function speechStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

test('tts without --output writes a new speech file and never replaces or follows an existing one', () =>
  withApi(async (baseUrl, homeDir, workDir) => {
    const outside = join(homeDir, 'outside.txt');
    writeFileSync(outside, 'ORIGINAL');
    symlinkSync(outside, join(workDir, 'output.mp3'));
    const taken: string[] = [];
    for (let offset = -1; offset <= 15; offset++) {
      const name = `speech-${speechStamp(new Date(Date.now() + offset * 1000))}.mp3`;
      writeFileSync(join(workDir, name), 'EXISTING');
      taken.push(name);
    }

    const result = await runCli(['tts', 'hello'], baseUrl, homeDir, workDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(outside, 'utf8'), 'ORIGINAL');
    for (const name of taken) {
      assert.equal(readFileSync(join(workDir, name), 'utf8'), 'EXISTING', name);
    }
    const created = readdirSync(workDir).filter((name) => /^speech-\d{8}-\d{6}-1\.mp3$/.test(name));
    assert.equal(created.length, 1, readdirSync(workDir).join(', '));
    assert.equal(readFileSync(join(workDir, created[0]), 'utf8'), 'ID3-speech');
    assert.ok(result.stdout.includes(`Saved audio to ${created[0]}`), result.stdout);
  }));

test('embeddings and scrape --output replace a link at the output path instead of writing through it', () =>
  withApi(async (baseUrl, homeDir, workDir) => {
    const target = join(homeDir, 'target.txt');
    writeFileSync(target, 'TARGET');
    symlinkSync(target, join(workDir, 'vectors.json'));
    symlinkSync(target, join(workDir, 'page.md'));

    const embeddings = await runCli(
      ['embeddings', 'hello', '--output', 'vectors.json'],
      baseUrl,
      homeDir,
      workDir
    );
    const scrape = await runCli(
      ['scrape', 'https://example.com/', '--output', 'page.md'],
      baseUrl,
      homeDir,
      workDir
    );

    assert.equal(embeddings.status, 0, embeddings.stderr);
    assert.equal(scrape.status, 0, scrape.stderr);
    assert.equal(readFileSync(target, 'utf8'), 'TARGET');
    assert.equal(lstatSync(join(workDir, 'vectors.json')).isFile(), true);
    assert.deepEqual(JSON.parse(readFileSync(join(workDir, 'vectors.json'), 'utf8')), [
      { embedding: [0.25, 0.5], index: 0 },
    ]);
    assert.equal(lstatSync(join(workDir, 'page.md')).isFile(), true);
    assert.equal(readFileSync(join(workDir, 'page.md'), 'utf8'), '# Scraped');
  }));
