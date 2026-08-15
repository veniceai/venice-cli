import { spawn as spawnPty, type IPty } from 'node-pty';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveSigningAddressFromKey, generateEphemeralKeyPair } from '../lib/e2ee.js';
import type { Message } from '../types/index.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const E2EE_MODEL = 'e2ee-pty-model';
const TEE_MODEL = 'tee-pty-model';
const PLAIN_MODEL = 'plain-pty-model';
const PROMPT = 'you> ';
const TEST_TIMEOUT_MS = 8_000;

interface CapturedRequest {
  messages: Message[];
  venice_parameters?: Record<string, unknown>;
}

interface PtySession {
  terminal: IPty;
  output: string;
  exit: Promise<{ exitCode: number; signal?: number }>;
}

function createQuote(reportAddress?: string): string {
  const quote = Buffer.alloc(632);
  quote.writeUInt32LE(0x81, 4);
  if (reportAddress) {
    Buffer.from(reportAddress, 'hex').copy(quote, 48 + 520);
  }
  return quote.toString('hex');
}

function startMockApi(options: {
  failFirstToolTurn?: boolean;
  stallFirstCompletion?: boolean;
} = {}): {
  server: Server;
  requests: CapturedRequest[];
  completionWasCancelled: () => boolean;
  listen: () => Promise<number>;
} {
  const requests: CapturedRequest[] = [];
  const signingKeys = generateEphemeralKeyPair();
  const signingAddress = deriveSigningAddressFromKey(signingKeys.publicKeyHex);
  assert.ok(signingAddress);
  const e2eeQuote = createQuote(signingAddress);
  const teeQuote = createQuote();
  let reply = 0;
  let completionCancelled = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        data: [
          {
            id: PLAIN_MODEL,
            type: 'text',
            model_spec: { capabilities: { supportsVision: true } },
          },
          {
            id: E2EE_MODEL,
            type: 'text',
            model_spec: {
              capabilities: { supportsE2EE: true, supportsTeeAttestation: true },
            },
          },
          {
            id: TEE_MODEL,
            type: 'text',
            model_spec: {
              capabilities: { supportsTeeAttestation: true },
            },
          },
        ],
      }));
      return;
    }

    if (request.method === 'GET' && url.pathname.endsWith('/tee/attestation')) {
      const model = url.searchParams.get('model') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const isE2EE = model === E2EE_MODEL;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        verified: true,
        nonce,
        model,
        intel_quote: isE2EE ? e2eeQuote : teeQuote,
        signing_key: isE2EE ? signingKeys.publicKeyHex : undefined,
        server_verification: {
          nonceBinding: { bound: true },
          tdx: { valid: true },
          verifiedAt: '2026-08-15T00:00:00.000Z',
          verificationDurationMs: 1,
        },
        tee_provider: 'mock-tdx',
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
        CapturedRequest & { stream?: boolean };
      requests.push(body);
      if (options.stallFirstCompletion && requests.length === 1) {
        const markCancelled = () => {
          completionCancelled = true;
        };
        request.once('aborted', markCancelled);
        response.once('close', markCancelled);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        return;
      }
      if (options.failFirstToolTurn && requests.length === 1) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'partial-tool-call',
                type: 'function',
                function: { name: 'datetime', arguments: '{invalid-json' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }));
        return;
      }
      reply++;
      const content = `mock-reply-${reply}`;

      if (body.stream) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.write(`data: ${JSON.stringify({
          choices: [{ delta: { content }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
        }));
      }
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  return {
    server,
    requests,
    completionWasCancelled: () => completionCancelled,
    listen: async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      return address.port;
    },
  };
}

function startPty(args: string[], homeDir: string, port: number): PtySession {
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: homeDir,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      VENICE_API_KEY: 'test-key',
      VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const terminal = spawnPty(process.execPath, [cliPath, ...args], {
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env,
  });
  const session: PtySession = {
    terminal,
    output: '',
    exit: new Promise((resolve) => {
      terminal.onExit(resolve);
    }),
  };
  terminal.onData((data) => {
    session.output += data;
  });
  return session;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function waitFor(
  session: PtySession,
  predicate: (output: string) => boolean,
  description: string
): Promise<void> {
  if (predicate(session.output)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error(`Timed out waiting for ${description}.\nOutput:\n${session.output}`));
    }, TEST_TIMEOUT_MS);
    const listener = session.terminal.onData(() => {
      if (predicate(session.output)) {
        clearTimeout(timer);
        listener.dispose();
        resolve();
      }
    });
  });
}

async function waitForExit(session: PtySession): Promise<{ exitCode: number; signal?: number }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      session.exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          session.terminal.kill();
          reject(new Error(`PTY process did not exit.\nOutput:\n${session.output}`));
        }, TEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertNoHistory(homeDir: string): void {
  const historyPath = join(homeDir, '.venice', 'history.json');
  if (!existsSync(historyPath)) return;
  assert.deepEqual(JSON.parse(readFileSync(historyPath, 'utf8')), []);
}

function writeExistingHistory(homeDir: string): string {
  const configDir = join(homeDir, '.venice');
  const historyPath = join(configDir, 'history.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(historyPath, JSON.stringify([{
    id: 'existing-conversation',
    timestamp: '2026-08-15T00:00:00.000Z',
    model: PLAIN_MODEL,
    privacy: 'plain',
    messages: [
      { role: 'user', content: 'prior question' },
      { role: 'assistant', content: 'prior answer' },
    ],
  }]));
  return historyPath;
}

async function waitForCondition(
  predicate: () => boolean,
  description: string
): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('actual PTY chat keeps context, handles commands, and exits cleanly', async () => {
  const mock = startMockApi();
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-pty-'));
  try {
    const port = await mock.listen();
    const session = startPty(
      ['chat', '--model', PLAIN_MODEL, '--web-search', '--system', 'Keep context'],
      homeDir,
      port
    );

    await waitFor(session, (output) => occurrences(output, PROMPT) >= 1, 'initial prompt');
    session.terminal.write('/help\r');
    await waitFor(session, (output) => /Commands: \/help/.test(output), 'REPL help');
    await waitFor(session, (output) => occurrences(output, PROMPT) >= 2, 'prompt after help');

    session.terminal.write('first turn\r');
    await waitFor(session, (output) => output.includes('mock-reply-1'), 'first response');
    await waitFor(session, (output) => occurrences(output, PROMPT) >= 3, 'second turn prompt');
    session.terminal.write('second turn\r');
    await waitFor(session, (output) => output.includes('mock-reply-2'), 'second response');
    await waitFor(session, (output) => occurrences(output, PROMPT) >= 4, 'exit prompt');
    session.terminal.write('exit\r');

    const result = await waitForExit(session);
    assert.equal(result.exitCode, 0, session.output);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].messages.at(-1)?.content, 'second turn');
    assert.ok(mock.requests[1].messages.some((message) =>
      message.role === 'assistant' && message.content === 'mock-reply-1'
    ));
    for (const request of mock.requests) {
      assert.equal(request.venice_parameters?.enable_web_search, 'on');
      assert.equal(request.messages[0]?.content, 'Keep context');
    }
  } finally {
    await closeServer(mock.server);
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('actual REPL failure rolls back the turn before retry', async () => {
  const mock = startMockApi({ failFirstToolTurn: true });
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-pty-retry-'));
  try {
    const port = await mock.listen();
    const imagePath = join(homeDir, 'retry.png');
    writeFileSync(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    ));
    const session = startPty(
      [
        'chat',
        '--model',
        PLAIN_MODEL,
        '--no-stream',
        '--tools',
        'datetime',
        '--image',
        imagePath,
      ],
      homeDir,
      port
    );

    await waitFor(session, (output) => occurrences(output, PROMPT) >= 1, 'retry initial prompt');
    session.terminal.write('failed prompt\r');
    await waitFor(session, (output) => output.includes('Invalid JSON arguments'), 'turn error');
    await waitFor(session, (output) => occurrences(output, PROMPT) >= 2, 'retry prompt');
    unlinkSync(imagePath);
    session.terminal.write('successful retry\r');
    await waitFor(session, (output) => output.includes('mock-reply-1'), 'retry response');
    await waitFor(session, (output) => occurrences(output, PROMPT) >= 3, 'retry exit prompt');
    session.terminal.write('exit\r');

    const result = await waitForExit(session);
    assert.equal(result.exitCode, 0, session.output);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(mock.requests[1].messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'successful retry' },
          ...(mock.requests[0].messages[0].content as Exclude<Message['content'], string>).slice(1),
        ],
      },
    ]);
  } finally {
    await closeServer(mock.server);
    rmSync(homeDir, { recursive: true, force: true });
  }
});

for (const privacy of ['e2ee', 'tee'] as const) {
  for (const path of ['one-shot', 'repl'] as const) {
    test(`${privacy.toUpperCase()} ${path} chat never persists history`, async () => {
      const mock = startMockApi();
      const homeDir = mkdtempSync(join(tmpdir(), `venice-chat-${privacy}-${path}-`));
      try {
        const port = await mock.listen();
        const model = privacy === 'e2ee' ? E2EE_MODEL : TEE_MODEL;
        const args = ['chat', '--model', model];
        if (path === 'one-shot') args.push('private one-shot');
        const session = startPty(args, homeDir, port);

        if (path === 'repl') {
          await waitFor(session, (output) => occurrences(output, PROMPT) >= 1, 'private REPL prompt');
          session.terminal.write('private repl turn\r');
        }
        await waitFor(session, (output) => output.includes('mock-reply-1'), 'private response');
        if (path === 'repl') {
          await waitFor(session, (output) => occurrences(output, PROMPT) >= 2, 'private exit prompt');
          session.terminal.write('exit\r');
        }

        const result = await waitForExit(session);
        assert.equal(result.exitCode, 0, session.output);
        assertNoHistory(homeDir);
      } finally {
        await closeServer(mock.server);
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  }
}

for (const [name, input] of [['Ctrl-C', '\x03'], ['EOF', '\x04']] as const) {
  test(`actual PTY ${name} closes the REPL without hanging`, async () => {
    const mock = startMockApi();
    const homeDir = mkdtempSync(join(tmpdir(), `venice-chat-${name.toLowerCase()}-`));
    try {
      const port = await mock.listen();
      const session = startPty(['chat', '--model', PLAIN_MODEL], homeDir, port);
      await waitFor(session, (output) => occurrences(output, PROMPT) >= 1, `${name} prompt`);
      session.terminal.write(input);
      const result = await waitForExit(session);
      assert.equal(result.exitCode, 0, session.output);
      assert.equal(mock.requests.length, 0);
      assertNoHistory(homeDir);
    } finally {
      await closeServer(mock.server);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
}

for (const [name, inputs] of [
  ['exit', ['exit\r']],
  ['help then exit', ['/help\r', 'exit\r']],
  ['Ctrl-C', ['\x03']],
  ['EOF', ['\x04']],
] as const) {
  test(`--continue with ${name} does not duplicate existing history`, async () => {
    const mock = startMockApi();
    const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-continue-no-turn-'));
    try {
      const historyPath = writeExistingHistory(homeDir);
      const port = await mock.listen();
      const session = startPty(
        ['chat', '--model', PLAIN_MODEL, '--continue'],
        homeDir,
        port
      );
      await waitFor(session, (output) => occurrences(output, PROMPT) >= 1, 'continued prompt');
      for (const input of inputs) {
        session.terminal.write(input);
        if (input.startsWith('/help')) {
          await waitFor(
            session,
            (output) => occurrences(output, PROMPT) >= 2,
            'prompt after continued help'
          );
        }
      }

      const result = await waitForExit(session);
      assert.equal(result.exitCode, 0, session.output);
      assert.equal(mock.requests.length, 0);
      const history = JSON.parse(readFileSync(historyPath, 'utf8')) as unknown[];
      assert.equal(history.length, 1);
    } finally {
      await closeServer(mock.server);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
}

for (const [name, input] of [['Ctrl-C', '\x03'], ['Ctrl-D', '\x04']] as const) {
  test(`${name} aborts a stalled in-flight completion without saving or retrying`, async () => {
    const mock = startMockApi({ stallFirstCompletion: true });
    const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-cancel-turn-'));
    try {
      const port = await mock.listen();
      const session = startPty(['chat', '--model', PLAIN_MODEL], homeDir, port);
      await waitFor(session, (output) => occurrences(output, PROMPT) >= 1, 'cancellation prompt');
      session.terminal.write('stall this turn\r');
      await waitForCondition(() => mock.requests.length === 1, 'stalled completion request');

      const startedAt = Date.now();
      session.terminal.write(input);
      const result = await waitForExit(session);

      assert.equal(result.exitCode, 0, session.output);
      assert.ok(Date.now() - startedAt < 2_000, `Cancellation was too slow:\n${session.output}`);
      await waitForCondition(mock.completionWasCancelled, 'server-side connection close');
      assert.equal(mock.requests.length, 1);
      assert.deepEqual(mock.requests[0].messages, [
        { role: 'user', content: 'stall this turn' },
      ]);
      assertNoHistory(homeDir);
    } finally {
      await closeServer(mock.server);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
}
