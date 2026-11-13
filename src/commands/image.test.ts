import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import {
  imageOutputPath,
  MAX_STYLE_REFERENCE_BYTES,
  parseImageFileFormat,
  parseImageGenerationOptions,
  parseImageResolution,
  registerImageCommand,
} from './image.js';
import { buildImageGenerationBody } from '../lib/api.js';

const baseOptions = {
  count: '1',
  styleReference: [],
};

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

async function runImageCommand(args: string[]): Promise<string[]> {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(' '));

  try {
    const program = new Command();
    registerImageCommand(program);
    await program.parseAsync(['node', 'venice', ...args]);
    return output;
  } finally {
    console.log = originalLog;
  }
}

test('does not force pixel dimensions when no sizing flags are provided', () => {
  const options = parseImageGenerationOptions(baseOptions);
  const body = buildImageGenerationBody('a canal at sunset', options);

  assert.equal('width' in body, false);
  assert.equal('height' in body, false);
  assert.equal('style_references' in body, false);
  assert.equal(body.variants, undefined);
});

test('maps ratio-tier and advanced generation options to API fields', () => {
  const options = parseImageGenerationOptions({
    ...baseOptions,
    model: 'nano-banana-pro',
    aspectRatio: '16:9',
    resolution: '2k',
    quality: 'MEDIUM',
    style: '3D Model',
    styleReference: ['https://example.com/style.png::0.75'],
    negative: 'clouds, rain',
    seed: '123',
    cfgScale: '7.5',
    steps: '12',
    loraStrength: '50',
    hideWatermark: true,
    safeMode: false,
    embedExifMetadata: true,
    count: '2',
  });

  assert.deepEqual(buildImageGenerationBody('a canal at sunset', options), {
    model: 'nano-banana-pro',
    prompt: 'a canal at sunset',
    format: 'png',
    aspect_ratio: '16:9',
    resolution: '2K',
    quality: 'medium',
    style_preset: '3D Model',
    style_references: [{ image: 'https://example.com/style.png', strength: 0.75 }],
    negative_prompt: 'clouds, rain',
    seed: 123,
    cfg_scale: 7.5,
    steps: 12,
    lora_strength: 50,
    hide_watermark: true,
    safe_mode: false,
    embed_exif_metadata: true,
    variants: 2,
  });
});

test('rejects mixed sizing modes', () => {
  assert.throws(
    () => parseImageGenerationOptions({
      ...baseOptions,
      width: '1024',
      height: '1024',
      aspectRatio: '1:1',
    }),
    /sizing modes cannot be combined/
  );
});

test('requires paired pixel dimensions and an aspect ratio for resolution', () => {
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, width: '1024' }),
    /Width and height must be provided together/
  );
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, resolution: '4K' }),
    /Resolution requires --aspect-ratio/
  );
});

test('validates enum and numeric generation options', () => {
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, quality: 'ultra' }),
    /Quality must be one of/
  );
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, cfgScale: '21' }),
    /--cfg-scale must be/
  );
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, cfgScale: '0' }),
    /--cfg-scale must be/
  );
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, cfgScale: '-1' }),
    /--cfg-scale must be/
  );
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, seed: '1.5' }),
    /--seed must be an integer/
  );
  assert.throws(
    () => parseImageGenerationOptions({
      ...baseOptions,
      styleReference: ['https://example.com/style.png::2'],
    }),
    /--style-reference strength must be/
  );
});

test('preserves IPv6 style reference URLs without a strength suffix', () => {
  const options = parseImageGenerationOptions({
    ...baseOptions,
    styleReference: ['http://[::1]/style.png'],
  });

  assert.deepEqual(options.styleReferences, [{ image: 'http://[::1]/style.png' }]);
});

test('omits prompt, web search and file format controls unless set', () => {
  const body = buildImageGenerationBody('a canal', parseImageGenerationOptions({ ...baseOptions, promptThinking: true }));

  assert.equal(body.format, 'png');
  for (const field of ['enhance_prompt', 'enable_web_search', 'disable_prompt_optimization_thinking']) {
    assert.equal(field in body, false, field);
  }
});

test('maps prompt, web search and file format controls to API fields', () => {
  const body = buildImageGenerationBody('a canal', parseImageGenerationOptions({
    ...baseOptions,
    enhancePrompt: false,
    webSearch: true,
    promptThinking: false,
    imageFormat: 'JPG',
  }));

  assert.equal(body.format, 'jpeg');
  assert.equal(body.enhance_prompt, false);
  assert.equal(body.enable_web_search, true);
  assert.equal(body.disable_prompt_optimization_thinking, true);
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, imageFormat: 'gif' }),
    /Image format must be one of: png, jpeg, webp/
  );
});

test('image file format sets the default extension and replaces a conflicting -o extension', () => {
  assert.equal(parseImageFileFormat(undefined), undefined);
  assert.equal(parseImageFileFormat(' webp '), 'webp');
  assert.match(imageOutputPath(undefined, 'image', undefined), /^image_\d+\.png$/);
  assert.match(imageOutputPath(undefined, 'edited', 'jpeg'), /^edited_\d+\.jpg$/);
  assert.match(imageOutputPath(undefined, 'multi_edited', 'webp'), /^multi_edited_\d+\.webp$/);
  assert.equal(imageOutputPath('out.png', 'image', undefined), 'out.png');
  assert.equal(imageOutputPath('out.jpeg', 'image', 'jpeg'), 'out.jpeg');
  assert.equal(imageOutputPath('OUT.JPG', 'image', 'jpeg'), 'OUT.JPG');
  assert.equal(imageOutputPath('dir/out.png', 'image', 'webp'), 'dir/out.webp');
  assert.equal(imageOutputPath('out', 'image', 'png'), 'out.png');
});

test('local style reference files are sent inline as base64', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-style-reference-test-'));
  const stylePath = join(tempDir, 'style.png');
  writeFileSync(stylePath, PNG_BYTES);

  try {
    const options = parseImageGenerationOptions({
      ...baseOptions,
      styleReference: [stylePath, `${stylePath}::0.5`, 'data:image/png;base64,AAAA', 'QUJD'],
    });
    assert.deepEqual(options.styleReferences, [
      { image: PNG_BYTES.toString('base64') },
      { image: PNG_BYTES.toString('base64'), strength: 0.5 },
      { image: 'data:image/png;base64,AAAA' },
      { image: 'QUJD' },
    ]);
    assert.throws(
      () => parseImageGenerationOptions({ ...baseOptions, styleReference: [join(tempDir, 'missing.png')] }),
      /Style reference file not found/
    );

    const largePath = join(tempDir, 'large.png');
    writeFileSync(largePath, Buffer.alloc(MAX_STYLE_REFERENCE_BYTES + 1));
    assert.throws(
      () => parseImageGenerationOptions({ ...baseOptions, styleReference: [largePath] }),
      /Style reference image is too large/
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('image edit commands validate resolution, quality and file format before requesting', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalError = console.error;
  const originalExit = process.exit;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-edit-validation-test-'));
  const inputPath = join(tempDir, 'input.png');
  const errors: string[] = [];
  let requests = 0;

  writeFileSync(inputPath, PNG_BYTES);
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = async () => {
    requests++;
    return new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } });
  };
  console.error = (...values: unknown[]) => errors.push(values.join(' '));
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit;

  try {
    const cases: Array<[string[], RegExp]> = [
      [['image-edit', inputPath, 'Fix', '--resolution', '1080p'], /Resolution must be a tier such as 1K, 1.5K, 2K or 4K/],
      [['image-edit', inputPath, 'Fix', '--image-format', 'bmp'], /Image format must be one of/],
      [['image-multi-edit', inputPath, '-p', 'Fix', '--quality', 'ultra'], /Quality must be one of/],
      [['image-multi-edit', inputPath, '-p', 'Fix', '--resolution', ' '], /Resolution must not be blank/],
      [['image-multi-edit', inputPath, '-p', 'Fix', '--image-format', 'tiff'], /Image format must be one of/],
      [['upscale', inputPath, '--creativity', '0.03'], /--creativity must be a number between 0 and 0.02/],
    ];
    for (const [args, message] of cases) {
      await assert.rejects(runImageCommand(args), /exit 1/, args.join(' '));
      assert.match(errors.at(-1) ?? '', message, args.join(' '));
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    process.exit = originalExit;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('image commands save with the requested file format extension', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-image-format-test-'));
  const inputPath = join(tempDir, 'input.png');
  const bodies: Array<Record<string, unknown>> = [];

  writeFileSync(inputPath, PNG_BYTES);
  process.env.VENICE_API_KEY = 'test-key';
  process.chdir(tempDir);
  globalThis.fetch = async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (String(input).endsWith('/image/generate')) {
      return Response.json({ id: 'image-id', images: [PNG_BYTES.toString('base64')] });
    }
    return new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } });
  };

  try {
    await runImageCommand(['image', 'a cube', '--image-format', 'webp', '-o', 'cube.png']);
    await runImageCommand(['image-edit', inputPath, 'Fix', '--image-format', 'jpeg', '--resolution', '2k']);
    await runImageCommand([
      'image-multi-edit', inputPath, '-p', 'Fix', '--image-format', 'webp', '--quality', 'LOW', '-o', 'layers',
    ]);

    assert.equal(bodies[0].format, 'webp');
    assert.equal(bodies[1].output_format, 'jpeg');
    assert.equal(bodies[1].resolution, '2K');
    assert.equal(bodies[2].output_format, 'webp');
    assert.equal(bodies[2].quality, 'low');
    const files = readdirSync(tempDir).sort();
    assert.ok(files.includes('cube.webp'), files.join(', '));
    assert.ok(files.includes('layers.webp'), files.join(', '));
    assert.ok(files.some((file) => /^edited_\d+\.jpg$/.test(file)), files.join(', '));
    assert.equal(files.includes('cube.png'), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects a blank aspect ratio', () => {
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, aspectRatio: '   ' }),
    /Aspect ratio must not be blank/
  );
});

test('trims resolution and quality and rejects blank values', () => {
  const options = parseImageGenerationOptions({
    ...baseOptions,
    aspectRatio: '16:9',
    resolution: ' 2k ',
    quality: ' medium ',
  });

  assert.equal(options.resolution, '2K');
  assert.equal(options.quality, 'medium');
  assert.equal(parseImageResolution('1.5k'), '1.5K');
  for (const invalid of ['1080p', 'K', '2', '1.K', '2K4K']) {
    assert.throws(() => parseImageResolution(invalid), /Resolution must be a tier/, invalid);
  }
  assert.throws(
    () => parseImageGenerationOptions({
      ...baseOptions,
      aspectRatio: '1:1',
      resolution: ' ',
    }),
    /Resolution must not be blank/
  );
  assert.throws(
    () => parseImageGenerationOptions({ ...baseOptions, quality: ' ' }),
    /Quality must not be blank/
  );
});

test('upscale JSON saves the file and prints its path, while --base64 prints the image instead', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-upscale-cli-test-'));
  const inputPath = join(tempDir, 'input.png');
  const jsonOutputPath = join(tempDir, 'json.png');
  const prettyOutputPath = join(tempDir, 'pretty.png');

  writeFileSync(inputPath, PNG_BYTES);
  process.env.VENICE_API_KEY = 'test-key';
  process.chdir(tempDir);
  globalThis.fetch = (async () => new Response(PNG_BYTES, {
    headers: { 'Content-Type': 'image/png' },
  })) as typeof fetch;

  try {
    const jsonOutput = await runImageCommand([
      'upscale',
      inputPath,
      '--format',
      'json',
      '--output',
      jsonOutputPath,
    ]);
    assert.deepEqual(JSON.parse(jsonOutput.join('\n')), {
      images: [{ output: jsonOutputPath, size_bytes: PNG_BYTES.length, content_type: 'image/png' }],
    });
    assert.equal(readFileSync(jsonOutputPath).equals(PNG_BYTES), true);

    const base64Output = await runImageCommand(['upscale', inputPath, '--base64']);
    assert.deepEqual(JSON.parse(base64Output.join('\n')), {
      images: [{
        b64_json: PNG_BYTES.toString('base64'),
        content_type: 'image/png',
        bytes: PNG_BYTES.length,
      }],
    });
    assert.deepEqual(readdirSync(tempDir).sort(), ['input.png', 'json.png']);

    await runImageCommand([
      'upscale',
      inputPath,
      '--format',
      'pretty',
      '--output',
      prettyOutputPath,
    ]);
    assert.equal(readFileSync(prettyOutputPath).equals(PNG_BYTES), true);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('image edit JSON saves the file and prints its path, and pretty output creates nested directories', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-edit-cli-test-'));
  const inputPath = join(tempDir, 'input.png');
  const jsonOutputPath = join(tempDir, 'json', 'result.png');
  const nestedOutputPath = join(tempDir, 'nested', 'images', 'result.png');

  writeFileSync(inputPath, PNG_BYTES);
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(PNG_BYTES, {
    headers: { 'Content-Type': 'image/png' },
  });

  try {
    const jsonOutput = await runImageCommand([
      'image-edit',
      inputPath,
      'Improve',
      'it',
      '--format',
      'json',
      '--output',
      jsonOutputPath,
    ]);
    assert.deepEqual(JSON.parse(jsonOutput.join('\n')), {
      image: { output: jsonOutputPath, size_bytes: PNG_BYTES.length, content_type: 'image/png' },
    });
    assert.equal(readFileSync(jsonOutputPath).equals(PNG_BYTES), true);

    await runImageCommand([
      'image-edit',
      inputPath,
      'Improve',
      'it',
      '--output',
      nestedOutputPath,
    ]);
    assert.equal(readFileSync(nestedOutputPath).equals(PNG_BYTES), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('image generate JSON saves the file and pretty output creates nested directories', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-generate-cli-test-'));
  const jsonOutputPath = join(tempDir, 'json', 'out.png');
  const nestedOutputPath = join(tempDir, 'nested', 'out.png');

  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = async () =>
    Response.json({ id: 'image-id', images: [PNG_BYTES.toString('base64')] });

  try {
    const jsonOutput = await runImageCommand(['image', 'a red cube', '--format', 'json', '--output', jsonOutputPath]);
    assert.deepEqual(JSON.parse(jsonOutput.join('\n')), {
      images: [{ output: jsonOutputPath, size_bytes: PNG_BYTES.length, content_type: 'image/png' }],
    });
    assert.equal(readFileSync(jsonOutputPath).equals(PNG_BYTES), true);

    await runImageCommand(['image', 'a red cube', '--output', nestedOutputPath]);
    assert.equal(readFileSync(nestedOutputPath).equals(PNG_BYTES), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('image generate and edit reject empty image payloads without writing files', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const originalError = console.error;
  const originalExit = process.exit;
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-empty-image-test-'));
  const inputPath = join(tempDir, 'input.png');
  const generatePath = join(tempDir, 'generated.png');
  const editPath = join(tempDir, 'edited.png');
  const errors: string[] = [];

  writeFileSync(inputPath, PNG_BYTES);
  process.env.VENICE_API_KEY = 'test-key';
  console.error = (...values: unknown[]) => errors.push(values.join(' '));
  process.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit;

  try {
    globalThis.fetch = async () => Response.json({ id: 'image-id', images: [''] });
    await assert.rejects(
      runImageCommand(['image', 'a red cube', '--output', generatePath]),
      /exit 1/
    );

    globalThis.fetch = async () => new Response(new Uint8Array(), {
      headers: { 'Content-Type': 'image/png' },
    });
    await assert.rejects(
      runImageCommand(['image-edit', inputPath, 'Improve', '--output', editPath]),
      /exit 1/
    );

    assert.equal(errors.length, 2);
    assert.match(errors[0], /Generated image response was empty/);
    assert.match(errors[1], /Edited image response was empty/);
    assert.equal(existsSync(generatePath), false);
    assert.equal(existsSync(editPath), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    process.exit = originalExit;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('image-styles honors its output format option', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output: string[] = [];

  globalThis.fetch = async (): Promise<Response> =>
    Response.json({ data: ['Cinematic'], object: 'list' });
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(' '));
  };

  try {
    const program = new Command();
    program.exitOverride();
    registerImageCommand(program);
    await program.parseAsync(['node', 'venice', 'image-styles', '--format', 'json']);

    assert.deepEqual(JSON.parse(output.join('\n')), {
      data: ['Cinematic'],
      object: 'list',
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('image generation accepts prompts beginning with editing command words', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalApiKey = process.env.VENICE_API_KEY;
  let requestBody: Record<string, unknown> = {};
  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = async (_input, init): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ id: 'image-id', images: ['generated-image'] });
  };
  console.log = () => {};

  try {
    const program = new Command();
    program.exitOverride();
    registerImageCommand(program);
    await program.parseAsync([
      'node',
      'venice',
      'image',
      'edit',
      'the',
      'lighting',
      '--base64',
    ]);

    assert.equal(requestBody.prompt, 'edit the lighting');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) {
      delete process.env.VENICE_API_KEY;
    } else {
      process.env.VENICE_API_KEY = originalApiKey;
    }
  }
});
