import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, type FakeApi, type RecordedRequest } from '../lib/test-cli.js';

const trajectory = [
  { time: 0, azimuth: 0, elevation: 0, distance: 1 },
  { time: 1, azimuth: 90, elevation: 10, distance: 1.2 },
];

function mp4WithSeconds(seconds: number): Buffer {
  const box = (type: string, content: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(content.length + 8, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, content]);
  };
  const mvhd = Buffer.alloc(96);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isommp41', 'latin1')), box('moov', box('mvhd', mvhd))]);
}

async function withScratch(run: (file: (name: string, bytes?: Buffer | string) => string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'venice-video-inputs-'));
  try {
    await run((name, bytes = 'bytes') => {
      const filePath = join(dir, name);
      writeFileSync(filePath, bytes);
      return filePath;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const queueOnly: FakeApi = (request) =>
  request.path === '/video/queue' ? { queue_id: 'q1', model: 'test-model' } : undefined;

function withCatalog(constraints: Record<string, unknown>): FakeApi {
  return (request) => {
    if (request.path === '/models?type=video') {
      return { data: [{ id: 'test-model', type: 'video', model_spec: { constraints } }] };
    }
    return queueOnly(request);
  };
}

function sent(requests: RecordedRequest[], path: string): Record<string, unknown> | undefined {
  const request = requests.find((entry) => entry.path === path);
  return request ? JSON.parse(request.body) as Record<string, unknown> : undefined;
}

const isDataUrl = (value: unknown, mimeType: string) =>
  typeof value === 'string' && value.startsWith(`data:${mimeType};base64,`);

test('video generate sends every media input from local files inline', { timeout: 30_000 }, () => withScratch(async (file) => {
  const args = [
    'video', 'generate', 'a cat', '-m', 'test-model', '-f', 'json',
    '-i', file('start.png'),
    '--end-image', file('end.jpg'),
    '--video', file('source.mp4'),
    '--audio-input', file('music.mp3'),
    '--reference-image', file('ref.webp'),
    '--reference-video', file('ref.mov', mp4WithSeconds(3)),
    '--reference-audio', file('voice.wav'),
    '--image-reference', JSON.stringify({ image: file('alice.png'), type: 'subject', name: 'Alice', audio: file('alice.mp3') }),
    '--video-reference', file('bob.json', JSON.stringify({ video: file('bob.mp4'), name: 'Bob' })),
    '--element', JSON.stringify({ frontal_image: file('front.png'), reference_images: [file('side.png')], video: file('element.mp4') }),
    '--scene-image', file('scene.png'),
    '--camera-trajectory', file('path.json', JSON.stringify(trajectory)),
    '--task-type', 'reference',
    '--negative-prompt', 'blur',
    '-r', '720p',
    '--no-audio',
  ];
  const run = await runCli(args, queueOnly);

  assert.equal(run.status, 0, run.stderr);
  const body = sent(run.requests, '/video/queue') as Record<string, any>;
  assert.ok(isDataUrl(body.image_url, 'image/png'));
  assert.ok(isDataUrl(body.end_image_url, 'image/jpeg'));
  assert.ok(isDataUrl(body.video_url, 'video/mp4'));
  assert.ok(isDataUrl(body.audio_url, 'audio/mpeg'));
  assert.ok(isDataUrl(body.reference_image_urls[0], 'image/webp'));
  assert.ok(isDataUrl(body.reference_video_urls[0], 'video/quicktime'));
  assert.ok(isDataUrl(body.reference_audio_urls[0], 'audio/wav'));
  assert.ok(isDataUrl(body.image_references[0].image_url, 'image/png'));
  assert.ok(isDataUrl(body.image_references[0].audio_url, 'audio/mpeg'));
  assert.deepEqual([body.image_references[0].type, body.image_references[0].ref_name], ['subject', 'Alice']);
  assert.ok(isDataUrl(body.video_references[0].video_url, 'video/mp4'));
  assert.equal(body.video_references[0].ref_name, 'Bob');
  assert.ok(isDataUrl(body.elements[0].frontal_image_url, 'image/png'));
  assert.ok(isDataUrl(body.elements[0].reference_image_urls[0], 'image/png'));
  assert.ok(isDataUrl(body.elements[0].video_url, 'video/mp4'));
  assert.ok(isDataUrl(body.scene_image_urls[0], 'image/png'));
  assert.deepEqual(body.camera_trajectory, trajectory);
  assert.equal(body.omni_reference_task_type, 'reference');
  assert.equal(body.negative_prompt, 'blur');
  assert.equal(body.resolution, '720p');
  assert.equal(body.audio, false);
}));

test('video generate passes every media input given as a URL through unchanged', { timeout: 30_000 }, async () => {
  const url = (name: string) => `https://media.example/${name}`;
  const args = [
    'video', 'generate', 'a cat', '-m', 'test-model', '-f', 'json',
    '-i', url('start.png'),
    '--end-image', url('end.png'),
    '--video', url('source.mp4'),
    '--audio-input', url('music.mp3'),
    '--reference-image', url('ref-1.png'),
    '--reference-image', url('ref-2.png'),
    '--reference-video', url('ref.mp4'),
    '--reference-audio', url('voice.wav'),
    '--image-reference', JSON.stringify({ image: url('alice.png'), type: 'background' }),
    '--video-reference', JSON.stringify({ video: url('bob.mp4'), audio: url('bob.mp3') }),
    '--element', JSON.stringify({ frontal_image: url('front.png') }),
    '--scene-image', url('scene.png'),
    '--camera-trajectory', JSON.stringify(trajectory),
  ];
  const run = await runCli(args, queueOnly);

  assert.equal(run.status, 0, run.stderr);
  const { model: _model, prompt: _prompt, ...inputs } = sent(run.requests, '/video/queue') ?? {};
  assert.deepEqual(inputs, {
    image_url: url('start.png'),
    camera_trajectory: trajectory,
    end_image_url: url('end.png'),
    video_url: url('source.mp4'),
    audio_url: url('music.mp3'),
    reference_image_urls: [url('ref-1.png'), url('ref-2.png')],
    reference_video_urls: [url('ref.mp4')],
    reference_audio_urls: [url('voice.wav')],
    image_references: [{ image_url: url('alice.png'), type: 'background' }],
    video_references: [{ video_url: url('bob.mp4'), audio_url: url('bob.mp3') }],
    elements: [{ frontal_image_url: url('front.png') }],
    scene_image_urls: [url('scene.png')],
  });
});

test('video generate rejects input combinations the API refuses before queueing', { timeout: 60_000 }, () => withScratch(async (file) => {
  const url = 'https://media.example/a.png';
  const cases: Array<[string[], RegExp]> = [
    [['--camera-trajectory', JSON.stringify(trajectory)], /--camera-trajectory needs a start image \(-i\)/],
    [['--reference-audio', 'https://media.example/voice.wav'], /--reference-audio needs a --reference-image or --reference-video/],
    [Array.from({ length: 5 }, () => ['--element', JSON.stringify({ frontal_image: url })]).flat(), /--element accepts at most 4 values/],
    [['--audio-input', file('music.ogg')], /--audio-input: .*music\.ogg must be one of \.wav, \.mp3/],
    [['--reference-video', file('clip.webm')], /--reference-video: .*clip\.webm must be one of \.mp4, \.mov/],
    [['--element', JSON.stringify({ frontal: url })], /--element: unknown field "frontal"/],
    [['--element', JSON.stringify({ reference_images: [url] })], /--element needs a "frontal_image" or a "video"/],
    [['--image-reference', JSON.stringify({ image: url, type: 'face' })], /"type" must be subject or background/],
    [['--video-reference', '{not json'], /--video-reference is not valid JSON/],
    [['-i', 'no-such-start.png'], /-i: no-such-start\.png is not a file or an http\(s\) URL/],
    [['--task-type', 'remix'], /Allowed choices are auto, reference, edit, extend/],
  ];
  for (const [flags, message] of cases) {
    const run = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', ...flags], queueOnly);
    assert.equal(run.status, 1, `${flags.join(' ')}: ${run.stdout}`);
    assert.match(run.stderr, message, flags.join(' '));
    assert.equal(sent(run.requests, '/video/queue'), undefined, flags.join(' '));
  }
}));

test('video generate rejects inputs the catalog says the model cannot take', { timeout: 30_000 }, async () => {
  const cases: Array<[Record<string, unknown>, string[], RegExp]> = [
    [{ video_input: false }, ['--video', 'https://media.example/v.mp4'], /test-model doesn't take a source video \(--video\)/],
    [{ audio_input: false }, ['--audio-input', 'https://media.example/a.mp3'], /test-model doesn't take an audio input/],
    [{ audio: true, audio_configurable: false }, ['--no-audio'], /test-model always generates with audio, so --no-audio can't apply/],
    [
      { per_reference_audio: false },
      ['--image-reference', JSON.stringify({ image: 'https://media.example/a.png', audio: 'https://media.example/a.mp3' })],
      /test-model doesn't take a voice per reference/,
    ],
    [{ resolutions: ['720p'] }, ['-r', '4k'], /Invalid --resolution "4k" for test-model\. Use one of: 720p/],
  ];
  for (const [constraints, flags, message] of cases) {
    const run = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', ...flags], withCatalog(constraints));
    assert.equal(run.status, 1, `${flags.join(' ')}: ${run.stdout}`);
    assert.match(run.stderr, message, flags.join(' '));
    assert.equal(sent(run.requests, '/video/queue'), undefined, flags.join(' '));
  }

  const allowed = await runCli(
    ['video', 'generate', 'a cat', '-m', 'test-model', '--audio', '--video', 'https://media.example/v.mp4'],
    withCatalog({ audio: true, audio_configurable: false, video_input: true })
  );
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('video generate --max-usd refuses a job above the cap, or one it cannot quote, before queueing', { timeout: 30_000 }, async () => {
  const quotedAt = (quote: number): FakeApi => (request) =>
    request.path === '/video/quote' ? { quote } : queueOnly(request);

  const over = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '--max-usd', '1'], quotedAt(2.5));
  assert.equal(over.status, 1, over.stdout);
  assert.match(over.stderr, /quoted at \$2\.5, above --max-usd 1, so nothing was queued/);
  assert.equal(sent(over.requests, '/video/queue'), undefined);

  const unquoted = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '--max-usd', '1', '--wait'], queueOnly);
  assert.equal(unquoted.status, 1, unquoted.stdout);
  assert.match(unquoted.stderr, /Couldn't get a price to check against --max-usd, so nothing was queued/);
  assert.equal(sent(unquoted.requests, '/video/queue'), undefined);

  const within = await runCli(['video', 'generate', 'a cat', '-m', 'test-model', '--max-usd', '3', '-f', 'json'], quotedAt(2.5));
  assert.equal(within.status, 0, within.stderr);
  assert.deepEqual(JSON.parse(within.stdout), { queue_id: 'q1', model: 'test-model', quote_usd: 2.5 });
});

test('quotes include the resolution, audio and the length of local reference videos', { timeout: 30_000 }, () => withScratch(async (file) => {
  const clips = [file('a.mp4', mp4WithSeconds(3)), file('b.mov', mp4WithSeconds(4.5))];

  const waited = await runCli(
    [
      'video', 'generate', 'a cat', '-m', 'test-model', '--wait', '-r', '720p', '--no-audio',
      '--reference-video', clips[0]!, '--reference-video', clips[1]!, '--reference-image', 'https://media.example/a.png',
    ],
    (request) => (request.path === '/video/quote' ? { quote: 1.25 } : undefined)
  );
  assert.equal(waited.status, 1);
  assert.deepEqual(sent(waited.requests, '/video/quote'), {
    model: 'test-model',
    resolution: '720p',
    audio: false,
    reference_video_total_duration: 7.5,
  });

  const quoted = await runCli(
    ['video', 'quote', '-m', 'test-model', '--reference-video', clips[0]!, '--reference-video', clips[1]!, '-f', 'json'],
    (request) => (request.path === '/video/quote' ? { quote: 1.25 } : undefined)
  );
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(sent(quoted.requests, '/video/quote')?.reference_video_total_duration, 7.5);

  const fromUrl = await runCli(
    ['video', 'quote', '-m', 'test-model', '--reference-video', 'https://media.example/a.mp4'],
    () => ({ quote: 1 })
  );
  assert.equal(fromUrl.status, 1);
  assert.match(fromUrl.stderr, /measures reference videos locally, so give a file, not a URL/);
}));
