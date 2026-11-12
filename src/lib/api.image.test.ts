import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  apiRequest,
  editImage,
  generateImage,
  listImageStyles,
  multiEditImage,
  removeImageBackground,
} from './api.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

test('image APIs send the endpoint-specific payloads', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-image-api-test-'));
  const firstImage = join(tempDir, 'first.png');
  const secondImage = join(tempDir, 'second.jpg');
  writeFileSync(firstImage, 'first image');
  writeFileSync(secondImage, 'second image');

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  process.env.VENICE_API_KEY = 'test-key';

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });

    if (url.endsWith('/image/generate')) {
      return Response.json({ id: 'generated', images: ['generated-image'] });
    }
    if (url.endsWith('/image/styles')) {
      return Response.json({ data: ['Cinematic', 'Comic Book'], object: 'list' });
    }
    return new Response(PNG_BYTES, {
      headers: { 'Content-Type': 'image/png' },
    });
  };

  try {
    assert.deepEqual(
      await generateImage('A canal', { model: 'test-model', stylePreset: 'Cinematic' }),
      ['generated-image']
    );
    assert.deepEqual(
      new Uint8Array(await editImage(firstImage, 'Remove the sign', {
        enhancePrompt: true,
        safeMode: false,
      })),
      new Uint8Array(PNG_BYTES)
    );
    await multiEditImage([firstImage, secondImage], 'Combine them', { model: 'layer-model' });
    await removeImageBackground(firstImage);
    assert.deepEqual(await listImageStyles(), ['Cinematic', 'Comic Book']);

    const requestFor = (suffix: string) => {
      const request = requests.find(({ url }) => url.endsWith(suffix));
      assert.ok(request, `Missing request for ${suffix}`);
      return request;
    };
    const bodyFor = (suffix: string): Record<string, unknown> =>
      JSON.parse(String(requestFor(suffix).init?.body));

    assert.equal(bodyFor('/image/generate').style_preset, 'Cinematic');
    assert.deepEqual(bodyFor('/image/edit'), {
      image: Buffer.from('first image').toString('base64'),
      prompt: 'Remove the sign',
      enhance_prompt: true,
      safe_mode: false,
    });
    assert.deepEqual(bodyFor('/image/multi-edit'), {
      images: [
        Buffer.from('first image').toString('base64'),
        Buffer.from('second image').toString('base64'),
      ],
      prompt: 'Combine them',
      modelId: 'layer-model',
    });
    assert.deepEqual(bodyFor('/image/background-remove'), {
      image: Buffer.from('first image').toString('base64'),
    });
    assert.equal(
      (requestFor('/image/styles').init?.headers as Record<string, string>).Authorization,
      undefined
    );
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

test('image edit APIs send resolution, quality and output format when set', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'venice-image-edit-options-test-'));
  const imagePath = join(tempDir, 'input.png');
  writeFileSync(imagePath, 'input image');

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.VENICE_API_KEY;
  const bodies = new Map<string, Record<string, unknown>>();
  process.env.VENICE_API_KEY = 'test-key';
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    bodies.set(url.slice(url.lastIndexOf('/') + 1), JSON.parse(String(init?.body)));
    if (url.endsWith('/image/generate')) {
      return Response.json({ id: 'generated', images: ['generated-image'] });
    }
    return new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } });
  };

  try {
    await editImage(imagePath, 'Brighten', { resolution: '2K', outputFormat: 'webp' });
    await multiEditImage([imagePath], 'Combine', { resolution: '4K', quality: 'high', outputFormat: 'jpeg' });
    await generateImage('A canal', {
      format: 'webp',
      enhancePrompt: false,
      enableWebSearch: true,
      disablePromptOptimizationThinking: true,
    });

    assert.equal(bodies.get('edit')?.resolution, '2K');
    assert.equal(bodies.get('edit')?.output_format, 'webp');
    assert.equal('quality' in (bodies.get('edit') ?? {}), false);
    assert.equal(bodies.get('multi-edit')?.resolution, '4K');
    assert.equal(bodies.get('multi-edit')?.quality, 'high');
    assert.equal(bodies.get('multi-edit')?.output_format, 'jpeg');
    const generated = bodies.get('generate') ?? {};
    assert.equal(generated.format, 'webp');
    assert.equal(generated.enhance_prompt, false);
    assert.equal(generated.enable_web_search, true);
    assert.equal(generated.disable_prompt_optimization_thinking, true);
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

test('multi-edit rejects more than three images before requesting', async () => {
  await assert.rejects(
    multiEditImage(['one', 'two', 'three', 'four'], 'Prompt'),
    /between 1 and 3 images/
  );
});

const binaryImageOptions = {
  responseType: 'arrayBuffer' as const,
  maxResponseBytes: 16,
  responseLabel: 'Test image',
  expectedContentType: 'image' as const,
  showSpinner: false,
  authenticated: false,
};

test('bounded image responses reject oversized declared and streamed bodies', async () => {
  const originalFetch = globalThis.fetch;
  let declaredBodyCancelled = false;
  const cases = [
    {
      response: () => new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(PNG_BYTES);
        },
        cancel() {
          declaredBodyCancelled = true;
        },
      }), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': '17',
        },
      }),
      expected: /too large.*17 B.*16 B/,
    },
    {
      response: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(PNG_BYTES);
          controller.enqueue(Buffer.alloc(8));
          controller.close();
        },
      }), {
        headers: { 'Content-Type': 'image/png' },
      }),
      expected: /exceeded the limit of 16 B/,
    },
  ];

  try {
    for (const testCase of cases) {
      let requestCount = 0;
      let onlineCheckCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input) === 'https://api.venice.ai/api/v1/models') {
          onlineCheckCount++;
          throw new Error('Unexpected online check');
        }
        requestCount++;
        return testCase.response();
      };

      await assert.rejects(
        apiRequest<ArrayBuffer>('/test-image', binaryImageOptions),
        testCase.expected
      );
      assert.equal(requestCount, 1);
      assert.equal(onlineCheckCount, 0);
    }
    assert.equal(declaredBodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bounded image response validation failures are not retried', async () => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{
    response: () => Response;
    expected: RegExp;
  }> = [
    {
      response: () => new Response(null, { headers: { 'Content-Type': 'image/png' } }),
      expected: /response was empty/,
    },
    {
      response: () => new Response(PNG_BYTES, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
      expected: /did not return an image Content-Type.*application\/octet-stream/,
    },
    {
      response: () => new Response(PNG_BYTES),
      expected: /did not return an image Content-Type.*missing/,
    },
    {
      response: () => new Response(Buffer.from('not an image'), {
        headers: { 'Content-Type': 'image/png' },
      }),
      expected: /did not contain a supported PNG, JPEG, or WebP image/,
    },
  ];

  try {
    for (const testCase of cases) {
      let requestCount = 0;
      let onlineCheckCount = 0;
      globalThis.fetch = async (input) => {
        if (String(input) === 'https://api.venice.ai/api/v1/models') {
          onlineCheckCount++;
          throw new Error('Unexpected online check');
        }
        requestCount++;
        return testCase.response();
      };

      await assert.rejects(
        apiRequest<ArrayBuffer>('/test-image', binaryImageOptions),
        testCase.expected
      );
      assert.equal(requestCount, 1);
      assert.equal(onlineCheckCount, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid binary response configuration fails before requesting', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    throw new Error('Unexpected request');
  };

  try {
    await assert.rejects(
      apiRequest<ArrayBuffer>('/test-image', {
        ...binaryImageOptions,
        maxResponseBytes: 0,
      } as unknown as Parameters<typeof apiRequest<ArrayBuffer>>[1]),
      /positive, finite byte limit/
    );
    await assert.rejects(
      apiRequest<ArrayBuffer>('/test-image', {
        ...binaryImageOptions,
        stream: true,
      } as unknown as Parameters<typeof apiRequest<ArrayBuffer>>[1]),
      /cannot be returned as an unvalidated stream/
    );
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('binary response timeout remains active while reading the body', async () => {
  const originalFetch = globalThis.fetch;
  let bodyAborted = false;

  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => {
          bodyAborted = true;
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      },
    }), {
      headers: { 'Content-Type': 'image/png' },
    });
  };

  try {
    await assert.rejects(
      apiRequest<ArrayBuffer>('/test-image', {
        ...binaryImageOptions,
        timeoutMs: 10,
      }),
      /Request timed out after 0.01 seconds/
    );
    assert.equal(bodyAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
