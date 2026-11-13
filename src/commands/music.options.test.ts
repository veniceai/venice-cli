import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, type FakeApi } from '../lib/test-cli.js';

function withSpec(spec: Record<string, unknown>): FakeApi {
  return (request) => {
    if (request.path === '/models?type=music') return { data: [{ id: 'test-music', type: 'music', model_spec: spec }] };
    if (request.path === '/audio/queue') return { queue_id: 'mq1', model: 'test-music' };
    return undefined;
  };
}

const capable = {
  supports_lyrics_optimizer: true,
  supports_loop: true,
  supports_force_instrumental: true,
  supports_speed: true,
  min_speed: 0.5,
  max_speed: 2,
  voices: ['Aria', 'Roger'],
  supports_custom_voice_id: false,
};

test('music generate sends the lyrics optimizer, loop, voice and speed the model supports', { timeout: 20_000 }, async () => {
  const run = await runCli(
    ['music', 'generate', 'a jingle', '-m', 'test-music', '--lyrics-optimizer', '--loop', '--voice', 'Roger', '--speed', '1.5', '-f', 'json'],
    withSpec(capable)
  );

  assert.equal(run.status, 0, run.stderr);
  const queued = run.requests.find((request) => request.path === '/audio/queue');
  assert.deepEqual(JSON.parse(queued?.body ?? '{}'), {
    model: 'test-music',
    prompt: 'a jingle',
    lyrics_optimizer: true,
    loop: true,
    voice: 'Roger',
    speed: 1.5,
  });
});

test('music generate accepts a custom voice ID only where the model takes one', { timeout: 20_000 }, async () => {
  const custom = await runCli(
    ['music', 'generate', 'hello', '-m', 'test-music', '--voice', 'pNInz6obpgDQGcFmaJgB'],
    withSpec({ ...capable, supports_custom_voice_id: true })
  );
  assert.equal(custom.status, 0, custom.stderr);

  const listedOnly = await runCli(['music', 'generate', 'hello', '-m', 'test-music', '--voice', 'Nobody'], withSpec(capable));
  assert.equal(listedOnly.status, 1);
  assert.match(listedOnly.stderr, /Invalid --voice "Nobody" for test-music\. Use one of: Aria, Roger/);
});

test('music generate rejects options the model does not support before queueing', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-music-options-'));
  const lyrics = join(dir, 'lyrics.txt');
  writeFileSync(lyrics, 'la la la');
  const unsupported = { voices: [] };
  const cases: Array<[Record<string, unknown>, string[], RegExp]> = [
    [capable, ['--lyrics-optimizer', '--lyrics', lyrics], /--lyrics-optimizer writes the lyrics from the prompt, so it can't be used with --lyrics/],
    [unsupported, ['--lyrics-optimizer'], /test-music can't write lyrics from the prompt/],
    [unsupported, ['--loop'], /test-music can't render a seamless loop/],
    [unsupported, ['--instrumental'], /test-music has no instrumental mode/],
    [unsupported, ['--speed', '1'], /test-music doesn't take a speed/],
    [capable, ['--speed', '3'], /--speed for test-music must be between 0\.5 and 2/],
    [unsupported, ['--voice', 'Aria'], /test-music doesn't take a voice/],
  ];
  try {
    for (const [spec, flags, message] of cases) {
      const run = await runCli(['music', 'generate', 'a song', '-m', 'test-music', ...flags], withSpec(spec));
      assert.equal(run.status, 1, `${flags.join(' ')}: ${run.stdout}`);
      assert.match(run.stderr, message, flags.join(' '));
      assert.equal(run.requests.some((request) => request.path === '/audio/queue'), false, flags.join(' '));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
