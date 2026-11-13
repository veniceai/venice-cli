import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, type FakeApi } from '../lib/test-cli.js';

const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24, 7)]);

const generated: FakeApi = (request) =>
  request.path === '/image/generate' ? { id: 'image-1', images: [WEBP_BYTES.toString('base64')] } : undefined;

test('image refuses --base64 together with -o before sending anything', { timeout: 20_000 }, async () => {
  const run = await runCli(['image', 'a red cube', '--base64', '-o', 'cube.png'], generated);

  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /--base64 prints the image instead of saving it, so it can't be used with -o/);
  assert.equal(run.requests.length, 0);
});

test('image -f json saves the file under the format Venice returned and prints its path, size and type', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-image-output-'));
  try {
    const run = await runCli(['image', 'a red cube', '-f', 'json'], generated, { cwd: dir });

    assert.equal(run.status, 0, run.stderr);
    const [image] = JSON.parse(run.stdout).images as Array<{ output: string; size_bytes: number; content_type: string }>;
    assert.match(image?.output ?? '', /^image_\d+\.webp$/);
    assert.equal(image?.size_bytes, WEBP_BYTES.length);
    assert.equal(image?.content_type, 'image/webp');
    assert.deepEqual(readdirSync(dir), [image?.output]);
    assert.equal(readFileSync(join(dir, image?.output ?? '')).equals(WEBP_BYTES), true);

    const base64 = await runCli(['image', 'a red cube', '--base64'], generated, { cwd: dir });
    assert.equal(base64.status, 0, base64.stderr);
    assert.deepEqual(JSON.parse(base64.stdout), { images: [{ b64_json: WEBP_BYTES.toString('base64') }] });
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
