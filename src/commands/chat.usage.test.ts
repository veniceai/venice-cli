import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveSigningAddressFromKey, encryptMessage, generateEphemeralKeyPair } from '../lib/e2ee.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const E2EE_MODEL = 'e2ee-usage-model';
const PLAIN_MODEL = 'plain-usage-model';

function buildTdxQuote(signingAddress: string): string {
  const quote = Buffer.alloc(48 + 584 + 4);
  quote.writeUInt16LE(4, 0);
  quote.writeUInt16LE(2, 2);
  quote.writeUInt32LE(0x81, 4);
  Buffer.from(signingAddress, 'hex').copy(quote, 48 + 520);
  return quote.toString('hex');
}

async function runChat(
  args: string[],
  usage: Record<string, unknown>
): Promise<{ status: number | null; stderr: string; usageEntries: Array<Record<string, unknown>> }> {
  const signingKey = generateEphemeralKeyPair().publicKeyHex;
  const signingAddress = deriveSigningAddressFromKey(signingKey);
  assert.ok(signingAddress);

  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/api/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        data: url.searchParams.has('type') ? [] : [
          {
            id: E2EE_MODEL,
            type: 'text',
            model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
          },
          { id: PLAIN_MODEL, type: 'text' },
        ],
      }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/tee/attestation') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        model: E2EE_MODEL,
        nonce: url.searchParams.get('nonce'),
        verified: true,
        signing_key: signingKey,
        signing_address: signingAddress,
        intel_quote: buildTdxQuote(signingAddress),
        server_verification: {
          tdx: { valid: true },
          nonceBinding: { bound: true },
          verifiedAt: new Date().toISOString(),
          verificationDurationMs: 1,
        },
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      const clientPublicKey = request.headers['x-venice-tee-client-pub-key'];
      if (typeof clientPublicKey === 'string') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = { content: encryptMessage('private reply', clientPublicKey) };
        response.write(`data: ${JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'cmpl-1', choices: [], usage })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'cmpl-2',
        choices: [{ message: { content: 'reply' }, finish_reason: 'stop' }],
        usage,
      }));
      return;
    }

    response.writeHead(404).end();
  });

  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-usage-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'chat', ...args], {
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
      child.stdout.resume();
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stderr }));
    });
    const usageFile = join(homeDir, '.venice', 'usage.json');
    const usageEntries = existsSync(usageFile) ? JSON.parse(readFileSync(usageFile, 'utf8')) : [];
    return { ...result, usageEntries };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

const usage = { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 };

test('a plain chat records only validated token counts under the requested model', async () => {
  const result = await runChat(['--model', PLAIN_MODEL, 'hello'], {
    ...usage,
    command: 'server-command',
    model: 'server-model',
    extra: 'kept?',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.usageEntries.length, 1);
  const { timestamp, ...entry } = result.usageEntries[0];
  assert.equal(typeof timestamp, 'string');
  assert.deepEqual(entry, { ...usage, command: 'chat', model: PLAIN_MODEL });
});
