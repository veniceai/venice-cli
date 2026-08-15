import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildChatUserMessage,
  MAX_TOOL_ROUNDS,
  nonStreamChat,
  requestedCapabilityError,
  runTransactionalChatTurn,
  streamChat,
} from './chat.js';
import { getToolDefinitions } from '../lib/tools.js';
import { encryptMessage, generateEphemeralKeyPair } from '../lib/e2ee.js';
import { buildUserMessageContent } from '../lib/chat-attachments.js';
import type { Message } from '../types/index.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const catalogCharacterSlug = 'test-catalog-character';

interface ChatRequest {
  messages: Message[];
  tools?: Array<{ function: { name: string } }>;
  venice_parameters?: Record<string, unknown>;
  reasoning_effort?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
}

function runCli(args: string[], homeDir: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 3_000,
    env: {
      ...process.env,
      HOME: homeDir,
      NO_COLOR: '1',
    },
  });
}

test('chat --help lists structured output, reasoning, and X search flags', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-help-'));

  try {
    const result = runCli(['chat', '--help'], homeDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--json-schema/);
    assert.match(result.stdout, /--json(?!-)/);
    assert.match(result.stdout, /--reasoning-effort/);
    assert.match(result.stdout, /--x-search/);
    assert.match(result.stdout, /--prompt-cache-key/);
    assert.match(result.stdout, /--prompt-cache-retention/);
    assert.match(result.stdout, /--image/);
    assert.match(result.stdout, /--file/);
    assert.match(result.stdout, /--audio/);
    assert.match(result.stdout, /--video/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat rejects combining --json and --json-schema', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-json-conflict-'));

  try {
    const schemaPath = join(homeDir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify({ type: 'object' }));
    const result = runCli(
      ['chat', '--json', '--json-schema', schemaPath, 'extract the fields'],
      homeDir
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Cannot combine --json and --json-schema/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat --json-schema fails before the API when the file is missing', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-schema-'));

  try {
    const result = runCli(
      ['chat', '--json-schema', join(homeDir, 'missing.json'), 'extract the fields'],
      homeDir
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /not found/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat preserves options and enforces the allowlist across tool rounds', async () => {
  const requests: ChatRequest[] = [];
  let completionRound = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/models')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        data: [{
          id: 'test-model',
          type: 'text',
          model_spec: {
            capabilities: {
              supportsReasoningEffort: true,
            },
          },
        }],
      }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/v1/chat/completions') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest);
      completionRound++;

      const toolCall = completionRound === 1
        ? {
            id: 'call-disabled',
            type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"2 + 2"}' },
          }
        : {
            id: 'call-enabled',
            type: 'function',
            function: { name: 'datetime', arguments: '{"format":"date"}' },
          };
      const body = completionRound < 3
        ? {
            choices: [{
              message: { content: '', tool_calls: [toolCall] },
              finish_reason: completionRound === 1 ? 'stop' : 'tool_calls',
            }],
          }
        : {
            choices: [{
              message: { content: 'done' },
              finish_reason: 'stop',
            }],
          };

      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body));
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-test-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          cliPath,
          'chat',
          '--no-stream',
          '--model',
          'test-model',
          '--tools',
          'datetime',
          '--character',
          catalogCharacterSlug,
          '--web-search',
          '--reasoning-effort',
          'high',
          '--prompt-cache-key',
          'session-123',
          '--prompt-cache-retention',
          '24h',
          'Use two tools',
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
            NODE_ENV: 'test',
            NO_COLOR: '1',
            VENICE_API_KEY: 'test-key',
            VENICE_API_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /done/);
    assert.equal(requests.length, 3);

    for (const request of requests) {
      assert.deepEqual(
        request.tools?.map((tool) => tool.function.name),
        ['datetime']
      );
      assert.equal(request.venice_parameters?.enable_web_search, 'on');
      assert.equal(
        request.venice_parameters?.character_slug,
        catalogCharacterSlug
      );
      assert.equal(request.reasoning_effort, 'high');
      assert.equal(request.prompt_cache_key, 'session-123');
      assert.equal(request.prompt_cache_retention, '24h');
    }

    assert.equal(
      requests[1].messages.at(-1)?.content,
      'Tool not enabled: calculator'
    );
    assert.equal(requests[2].messages.at(-1)?.role, 'tool');
    assert.notEqual(
      requests[2].messages.at(-1)?.content,
      'Tool not enabled: datetime'
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat --json-schema fails before the API when the file is invalid JSON', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-bad-schema-'));

  try {
    const schemaPath = join(homeDir, 'schema.json');
    writeFileSync(schemaPath, '{not-json');
    const result = runCli(['chat', '--json-schema', schemaPath, 'extract the fields'], homeDir);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Invalid JSON/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat --reasoning-effort rejects unknown values', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-effort-'));

  try {
    const result = runCli(['chat', '--reasoning-effort', 'ludicrous', 'solve this'], homeDir);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /reasoning-effort|ludicrous/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('capability-gated options fail closed without an advertised model capability', () => {
  const requested = {
    model: 'test-model',
    responseFormatRequested: true,
    reasoningEffortRequested: false,
    xSearchRequested: false,
  };
  assert.match(
    requestedCapabilityError({ ...requested, catalogFailed: true }) || '',
    /could not fetch.*catalog/i
  );
  assert.match(
    requestedCapabilityError({ ...requested, catalogFailed: false }) || '',
    /absent from the model catalog/i
  );
  assert.match(
    requestedCapabilityError({
      ...requested,
      catalogFailed: false,
      modelInfo: { id: 'test-model', type: 'text' },
    }) || '',
    /does not support structured output/i
  );
  assert.equal(
    requestedCapabilityError({
      ...requested,
      catalogFailed: false,
      modelInfo: {
        id: 'test-model',
        type: 'text',
        model_spec: { capabilities: { supportsResponseSchema: true } },
      },
    }),
    undefined
  );
});

test('chat rejects --no-thinking with a non-none reasoning effort', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-conflict-'));

  try {
    const result = runCli(
      ['chat', '--no-thinking', '--reasoning-effort', 'high', 'solve this'],
      homeDir
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Cannot combine --no-thinking/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat with no prompt on piped stdin does not start a REPL', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-piped-'));

  try {
    const result = runCli(['chat'], homeDir);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /No prompt provided/i);
    assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /you>/);
    assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /Interactive chat/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat --image fails before the API when the file is missing', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-image-'));

  try {
    const result = runCli(
      ['chat', '--image', join(homeDir, 'missing.jpg'), 'what is in this picture?'],
      homeDir
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Image not found/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat rejects explicit E2EE attachments before any API request or file read', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-e2ee-attachment-'));
  try {
    const imagePath = join(homeDir, 'photo.png');
    writeFileSync(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ));
    const result = runCli([
      'chat',
      '--e2ee',
      '--model',
      'test-model',
      '--image',
      imagePath,
      'describe this',
    ], homeDir);

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /No attachment data was read or sent/i
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('chat rejects prompt caching and reasoning with E2EE before completion', async () => {
  let completionRequests = 0;
  const requestUrls: string[] = [];
  const server = createServer((request, response) => {
    requestUrls.push(`${request.method} ${request.url}`);
    if (request.method === 'GET' && request.url?.startsWith('/api/v1/models')) {
      const requestedType = new URL(request.url, 'http://localhost').searchParams.get('type');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        data: !requestedType || requestedType === 'text' ? [{
          id: 'e2ee-test-model',
          type: 'text',
          model_spec: {
            capabilities: {
              supportsE2EE: true,
              supportsTeeAttestation: true,
              supportsReasoningEffort: true,
            },
          },
        }] : [],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/chat/completions') {
      completionRequests++;
    }
    response.statusCode = 500;
    response.end();
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-e2ee-options-'));

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [
        cliPath,
        'chat',
        '--model',
        'e2ee-test-model',
        '--reasoning-effort',
        'high',
        '--prompt-cache-key',
        'secret-cache',
        'hello',
      ], {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_KEY: 'test-key',
          VENICE_API_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /not supported with E2EE/i,
      requestUrls.join('\n')
    );
    assert.equal(completionRequests, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('streaming chat preserves options and handles sequential tool rounds', async () => {
  const messages: Message[] = [{ role: 'user', content: 'Use two tools' }];
  const seenOptions: Array<{
    tools?: Array<{ function: { name: string } }>;
    venice_parameters?: Record<string, unknown>;
    reasoning_effort?: string;
    prompt_cache_key?: string;
    prompt_cache_retention?: string;
  }> = [];
  let round = 0;
  const completionStream: NonNullable<NonNullable<Parameters<typeof streamChat>[5]>['completionStream']> =
    async function* (_messages, options) {
      seenOptions.push(options || {});
      round++;

      if (round === 1) {
        yield {
          tool_calls: [{
            index: 0,
            id: 'call-disabled',
            type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"2 + 2"}' },
          }],
          done: false,
        };
        // Some compatible APIs mislabel streamed tool calls as stopped.
        yield { finish_reason: 'stop', done: false };
        yield { done: true };
        return;
      }

      if (round === 2) {
        yield {
          tool_calls: [{
            index: 0,
            id: 'call-enabled',
            type: 'function',
            function: { name: 'datetime', arguments: '{"format":"date"}' },
          }],
          done: false,
        };
        yield { finish_reason: 'tool_calls', done: false };
        yield { done: true };
        return;
      }

      yield { content: 'done', done: false };
      yield { finish_reason: 'stop', done: false };
      yield { done: true };
    };

  await streamChat(
    messages,
    'test-model',
    getToolDefinitions(['datetime']),
    false,
    'raw',
    {
      veniceParams: {
        enable_web_search: 'on',
        character_slug: catalogCharacterSlug,
      },
      quiet: true,
      reasoningEffort: 'high',
      promptCacheKey: 'session-123',
      promptCacheRetention: '24h',
      completionStream,
    }
  );

  assert.equal(round, 3);
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'done' });
  assert.equal(
    messages.find((message) => message.tool_call_id === 'call-disabled')?.content,
    'Tool not enabled: calculator'
  );
  assert.notEqual(
    messages.find((message) => message.tool_call_id === 'call-enabled')?.content,
    'Tool not enabled: datetime'
  );
  for (const options of seenOptions) {
    assert.deepEqual(
      options.tools?.map((tool) => tool.function.name),
      ['datetime']
    );
    assert.equal(options.venice_parameters?.enable_web_search, 'on');
    assert.equal(
      options.venice_parameters?.character_slug,
      catalogCharacterSlug
    );
    assert.equal(options.reasoning_effort, 'high');
    assert.equal(options.prompt_cache_key, 'session-123');
    assert.equal(options.prompt_cache_retention, '24h');
  }
});

test('--strip-thinking excludes hidden content from streaming tool follow-up context', async () => {
  const messages: Message[] = [{ role: 'user', content: 'Use a tool' }];
  let round = 0;
  let followUpMessages: Message[] | undefined;

  await streamChat(
    messages,
    'test-model',
    [],
    false,
    'raw',
    {
      quiet: true,
      stripThinking: true,
      completionStream: async function* (roundMessages) {
        round++;
        if (round === 1) {
          yield { content: 'visible <thi', done: false };
          yield { content: 'nk>hidden plan</think> answer', done: false };
          yield {
            tool_calls: [{
              index: 0,
              id: 'call-disabled',
              type: 'function',
              function: { name: 'disabled', arguments: '{}' },
            }],
            done: false,
          };
          yield { finish_reason: 'tool_calls', done: false };
          yield { done: true };
          return;
        }
        followUpMessages = structuredClone(roundMessages);
        yield { content: 'done', done: false };
        yield { finish_reason: 'stop', done: false };
        yield { done: true };
      },
    }
  );

  assert.ok(followUpMessages);
  const toolCallMessage = followUpMessages.find((message) => message.role === 'assistant');
  assert.equal(toolCallMessage?.content, 'visible  answer');
  assert.doesNotMatch(JSON.stringify(followUpMessages), /hidden plan|<think>/);
});

test('--strip-thinking excludes hidden content from the next streaming REPL turn', async () => {
  const messages: Message[] = [{ role: 'user', content: 'first prompt' }];
  await streamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    stripThinking: true,
    completionStream: async function* () {
      yield { reasoning_content: 'redacted reasoning', done: false };
      yield { content: '<think>hidden reasoning</think>safe answer', done: false };
      yield { finish_reason: 'stop', done: false };
      yield { done: true };
    },
  });

  messages.push({ role: 'user', content: 'second prompt' });
  let nextTurnMessages: Message[] | undefined;
  await streamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    stripThinking: true,
    completionStream: async function* (roundMessages) {
      nextTurnMessages = structuredClone(roundMessages);
      yield { content: 'second answer', done: false };
      yield { finish_reason: 'stop', done: false };
      yield { done: true };
    },
  });

  assert.ok(nextTurnMessages);
  assert.equal(
    nextTurnMessages.find((message) => message.role === 'assistant')?.content,
    'safe answer'
  );
  assert.doesNotMatch(
    JSON.stringify(nextTurnMessages),
    /hidden reasoning|redacted reasoning|<think>/
  );
});

test('streaming empty replies preserve assistant role before the next turn', async () => {
  const messages: Message[] = [{ role: 'user', content: 'first prompt' }];
  await streamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    completionStream: async function* () {
      yield { finish_reason: 'stop', done: false };
      yield { done: true };
    },
  });

  assert.deepEqual(messages.at(-1), { role: 'assistant', content: '' });
  messages.push({ role: 'user', content: 'second prompt' });

  let nextTurnMessages: Message[] | undefined;
  await streamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    completionStream: async function* (roundMessages) {
      nextTurnMessages = structuredClone(roundMessages);
      yield { finish_reason: 'stop', done: false };
      yield { done: true };
    },
  });

  assert.deepEqual(nextTurnMessages?.map((message) => message.role), [
    'user',
    'assistant',
    'user',
  ]);
});

test('non-streaming fully stripped replies preserve an empty assistant turn', async () => {
  const messages: Message[] = [{ role: 'user', content: 'first prompt' }];
  await nonStreamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    stripThinking: true,
    completion: async () => ({
      content: '<think>hidden reasoning</think>',
      finish_reason: 'stop',
    }),
  });

  assert.deepEqual(messages.at(-1), { role: 'assistant', content: '' });
  messages.push({ role: 'user', content: 'second prompt' });

  let nextTurnMessages: Message[] | undefined;
  await nonStreamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    completion: async (roundMessages) => {
      nextTurnMessages = structuredClone(roundMessages);
      return { content: '', finish_reason: 'stop' };
    },
  });

  assert.deepEqual(nextTurnMessages?.map((message) => message.role), [
    'user',
    'assistant',
    'user',
  ]);
  assert.equal(nextTurnMessages?.[1].content, '');
});

test('--strip-thinking preserves an unclosed thinking tag in assistant context', async () => {
  const messages: Message[] = [{ role: 'user', content: 'prompt' }];
  await streamChat(messages, 'test-model', [], false, 'raw', {
    quiet: true,
    stripThinking: true,
    completionStream: async function* () {
      yield { content: 'before <think>unfinished', done: false };
      yield { done: true };
    },
  });

  assert.deepEqual(messages.at(-1), {
    role: 'assistant',
    content: 'before <think>unfinished',
  });
});

test('E2EE streaming strips server-side controls from the request', async () => {
  let seenOptions: Record<string, unknown> | undefined;
  const clientKeys = generateEphemeralKeyPair();
  const encryptedContent = encryptMessage('normal-content', clientKeys.publicKeyHex);
  const completionStream: NonNullable<NonNullable<Parameters<typeof streamChat>[5]>['completionStream']> =
    async function* (_messages, options) {
    seenOptions = options as unknown as Record<string, unknown>;
    yield { reasoning_content: 'secret-reasoning', done: false };
    yield { content: encryptedContent, done: false };
    yield { done: true };
  };
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    await streamChat(
      [],
      'e2ee-test-model',
      getToolDefinitions(['datetime']),
      false,
      'raw',
      {
        e2eeContext: {
          privateKey: clientKeys.privateKey,
          publicKeyHex: clientKeys.publicKeyHex,
          modelPublicKey: '00',
          attestation: {} as never,
        },
        quiet: true,
        veniceParams: {
          enable_web_search: 'on',
          enable_x_search: true,
          include_search_results_in_stream: true,
          include_venice_system_prompt: true,
          character_slug: catalogCharacterSlug,
        },
        reasoningEffort: 'high',
        promptCacheKey: 'must-not-leak',
        promptCacheRetention: '24h',
        completionStream,
      }
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.ok(seenOptions);
  assert.equal(seenOptions.tools, undefined);
  const params = seenOptions.venice_parameters as Record<string, unknown>;
  assert.equal(params.enable_web_search, undefined);
  assert.equal(params.enable_x_search, undefined);
  assert.equal(params.include_search_results_in_stream, undefined);
  assert.equal(params.include_venice_system_prompt, false);
  assert.equal(params.character_slug, undefined);
  assert.equal(seenOptions.reasoning_effort, undefined);
  assert.equal(seenOptions.prompt_cache_key, undefined);
  assert.equal(seenOptions.prompt_cache_retention, undefined);
  assert.match(output.join(''), /^normal-content/);
  assert.doesNotMatch(output.join(''), /secret-reasoning/);
});

test('structured non-streaming output stays valid JSON across tool rounds', async () => {
  const seenOptions: Array<Record<string, unknown>> = [];
  let round = 0;
  const completion: NonNullable<NonNullable<Parameters<typeof nonStreamChat>[5]>['completion']> =
    async (_messages, options) => {
    seenOptions.push(options as unknown as Record<string, unknown>);
    round++;
    if (round === 1) {
      return {
        content: '',
        tool_calls: [{
          id: 'call-disabled',
          type: 'function' as const,
          function: { name: 'calculator', arguments: '{"expression":"2 + 2"}' },
        }],
        finish_reason: 'tool_calls',
      };
    }
    return {
      content: '{"answer":4}',
      finish_reason: 'stop',
    };
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(' '));

  try {
    await nonStreamChat(
      [{ role: 'user', content: 'Return JSON' }],
      'test-model',
      [],
      false,
      'raw',
      {
        responseFormat: { type: 'json_object' },
        reasoningEffort: 'high',
        promptCacheKey: 'session-123',
        promptCacheRetention: '24h',
        veniceParams: { enable_x_search: true },
        completion,
      }
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(JSON.parse(output.join('\n')), { answer: 4 });
  assert.equal(seenOptions.length, 2);
  for (const options of seenOptions) {
    assert.deepEqual(options.response_format, { type: 'json_object' });
    assert.equal(options.reasoning_effort, 'high');
    assert.equal(options.prompt_cache_key, 'session-123');
    assert.equal(options.prompt_cache_retention, '24h');
    assert.deepEqual(options.venice_parameters, { enable_x_search: true });
  }
});

test('non-streaming tool rounds reuse encoded attachments without rereading files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-chat-round-attachment-'));
  const imagePath = join(dir, 'photo.png');
  writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));

  try {
    const content = await buildUserMessageContent('describe this', {
      images: [imagePath],
      files: [],
      audio: [],
      videos: [],
    });
    rmSync(imagePath);
    const messages: Message[] = [{ role: 'user', content }];
    const seenUserContent: Message['content'][] = [];
    let round = 0;

    await nonStreamChat(messages, 'test-model', [], false, 'raw', {
      quiet: true,
      completion: async (roundMessages) => {
        seenUserContent.push(roundMessages[0].content);
        round++;
        if (round === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'call-disabled',
              type: 'function',
              function: { name: 'disabled', arguments: '{}' },
            }],
            finish_reason: 'tool_calls',
          };
        }
        return { content: 'done', finish_reason: 'stop' };
      },
    });

    assert.equal(round, 2);
    assert.deepEqual(seenUserContent, [content, content]);
    assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'done' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct non-streaming chat rejects an invalid schema before completion', async () => {
  let completionCalled = false;
  await assert.rejects(
    nonStreamChat(
      [{ role: 'user', content: 'Return JSON' }],
      'test-model',
      [],
      false,
      'raw',
      {
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema: { type: 'object', unsupportedKeyword: true },
          },
        },
        completion: async () => {
          completionCalled = true;
          return { content: '{}', finish_reason: 'stop' };
        },
      }
    ),
    /Invalid or unsupported JSON schema.*unknown keyword/i
  );
  assert.equal(completionCalled, false);
});

test('non-streaming chat stops after the maximum tool rounds', async () => {
  const messages: Message[] = [{ role: 'user', content: 'Keep calling tools' }];
  let completionCalls = 0;
  const completion: NonNullable<NonNullable<Parameters<typeof nonStreamChat>[5]>['completion']> =
    async () => {
      completionCalls++;
      return {
        content: '',
        tool_calls: [{
          id: `call-${completionCalls}`,
          type: 'function',
          function: { name: 'datetime', arguments: '{}' },
        }],
        finish_reason: 'tool_calls',
      };
    };

  await assert.rejects(
    nonStreamChat(
      messages,
      'test-model',
      getToolDefinitions(['datetime']),
      false,
      'raw',
      { quiet: true, completion }
    ),
    new RegExp(`limit of ${MAX_TOOL_ROUNDS} rounds`)
  );
  assert.equal(completionCalls, MAX_TOOL_ROUNDS + 1);
});

test('streaming chat stops after the maximum tool rounds', async () => {
  const messages: Message[] = [{ role: 'user', content: 'Keep calling tools' }];
  let completionCalls = 0;
  const completionStream: NonNullable<NonNullable<Parameters<typeof streamChat>[5]>['completionStream']> =
    async function* () {
      completionCalls++;
      yield {
        tool_calls: [{
          index: 0,
          id: `call-${completionCalls}`,
          type: 'function',
          function: { name: 'disabled', arguments: '{}' },
        }],
        done: false,
      };
      yield { finish_reason: 'tool_calls', done: false };
      yield { done: true };
    };

  await assert.rejects(
    streamChat(
      messages,
      'test-model',
      [],
      false,
      'raw',
      { quiet: true, completionStream }
    ),
    new RegExp(`limit of ${MAX_TOOL_ROUNDS} rounds`)
  );
  assert.equal(completionCalls, MAX_TOOL_ROUNDS + 1);
});

test('failed turn rolls back its user message before a successful retry', async () => {
  const messages: Message[] = [{ role: 'system', content: 'Keep this' }];

  await assert.rejects(
    runTransactionalChatTurn(messages, 'stale prompt', async () => {
      throw new Error('completion failed');
    }),
    /completion failed/
  );
  assert.deepEqual(messages, [{ role: 'system', content: 'Keep this' }]);

  await runTransactionalChatTurn(messages, 'retry prompt', async () => {
    messages.push({ role: 'assistant', content: 'success' });
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'Keep this' },
    { role: 'user', content: 'retry prompt' },
    { role: 'assistant', content: 'success' },
  ]);
});

test('failed turn rolls back partial assistant and tool-call state', async () => {
  const messages: Message[] = [{ role: 'user', content: 'previous successful turn' }];

  await assert.rejects(
    runTransactionalChatTurn(messages, 'failing tool turn', async () => {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'partial-call',
          type: 'function',
          function: { name: 'datetime', arguments: '{}' },
        }],
      });
      messages.push({
        role: 'tool',
        content: 'partial result',
        tool_call_id: 'partial-call',
      });
      throw new Error('follow-up completion failed');
    }),
    /follow-up completion failed/
  );

  assert.deepEqual(messages, [{ role: 'user', content: 'previous successful turn' }]);
});

test('buildChatUserMessage uses prompt when only args are provided', () => {
  const message = buildChatUserMessage('find the root cause');
  assert.deepEqual(message, { role: 'user', content: 'find the root cause' });
});

test('buildChatUserMessage uses stdin when prompt is empty', () => {
  const message = buildChatUserMessage('', 'error line 1\nerror line 2');
  assert.deepEqual(message, { role: 'user', content: 'error line 1\nerror line 2' });
});

test('buildChatUserMessage merges stdin and prompt into one message', () => {
  const message = buildChatUserMessage('find the root cause', 'stack trace...');
  assert.deepEqual(message, { role: 'user', content: 'stack trace...\n\nfind the root cause' });
});

test('buildChatUserMessage returns null when both inputs are empty', () => {
  const message = buildChatUserMessage('', '');
  assert.equal(message, null);
});
