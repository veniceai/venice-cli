import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message, Model } from '../types/index.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const TEE_MODEL = 'tee-test-model';
const E2EE_MODEL = 'e2ee-test-model';
const REPLY = 'tee reply';
const DEBUG_TD_ATTRIBUTES = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);

const catalog: Model[] = [
  { id: TEE_MODEL, type: 'text', model_spec: { capabilities: { supportsTeeAttestation: true } } },
  { id: E2EE_MODEL, type: 'text', model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } } },
];

interface CompletionRequest {
  headers: IncomingHttpHeaders;
  body: { messages: Message[]; stream?: boolean; venice_parameters?: Record<string, unknown> };
}

interface ChatRun {
  status: number | null;
  stdout: string;
  stderr: string;
  attestationRequests: number;
  completions: CompletionRequest[];
  history?: string;
}

function buildTdxQuote(options: { teeType?: number; tdAttributes?: Buffer } = {}): string {
  const signatureData = Buffer.alloc(64);
  const quote = Buffer.alloc(636 + signatureData.length);
  quote.writeUInt16LE(4, 0);
  quote.writeUInt16LE(2, 2);
  quote.writeUInt32LE(options.teeType ?? 0x81, 4);
  options.tdAttributes?.copy(quote, 168);
  quote.writeUInt32LE(signatureData.length, 632);
  signatureData.copy(quote, 636);
  return quote.toString('hex');
}

const serverVerification = {
  tdx: { valid: true },
  nonceBinding: { bound: true },
  verifiedAt: '2026-01-01T00:00:00.000Z',
  verificationDurationMs: 1,
};

// No signing key: TEE mode must keep working for attestations without one.
function passingAttestation(model: string, nonce: string): Record<string, unknown> {
  return {
    model,
    nonce,
    verified: true,
    tee_provider: 'test',
    intel_quote: buildTdxQuote(),
    server_verification: serverVerification,
  };
}

async function runChat(
  args: string[],
  attestation: (model: string, nonce: string) => Record<string, unknown> = passingAttestation
): Promise<ChatRun> {
  const completions: CompletionRequest[] = [];
  let attestationRequests = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));

    if (request.method === 'GET' && url.pathname === '/api/v1/models') {
      const type = url.searchParams.get('type');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: !type || type === 'text' ? catalog : [] }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/tee/attestation') {
      attestationRequests++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(attestation(
        url.searchParams.get('model') ?? '',
        url.searchParams.get('nonce') ?? ''
      )));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      completions.push({ headers: request.headers, body });
      if (body.stream) {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`${chunk({ content: REPLY }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'cmpl-1',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-tee-'));

  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'chat', ...args], {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
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
    const historyPath = join(homeDir, '.venice', 'history.json');
    const history = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : undefined;
    return { ...result, attestationRequests, completions, history };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

test('TEE-only chat sends one request after a passing attestation and keeps no history', async () => {
  const result = await runChat(['--model', TEE_MODEL, 'TEE-PROMPT']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${REPLY}\n`);
  assert.equal(result.attestationRequests, 1);
  assert.equal(result.completions.length, 1);
  const [request] = result.completions;
  assert.equal(request.body.messages.at(-1)?.content, 'TEE-PROMPT');
  assert.equal(request.headers['x-venice-tee-client-pub-key'], undefined);
  assert.equal(result.history, undefined);
});

test('TEE-only status says what was checked and stays off stdout outside pretty output', async () => {
  for (const format of ['raw', 'markdown']) {
    const result = await runChat(['--model', TEE_MODEL, '-f', format, 'hello']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${REPLY}\n`, format);
    assert.match(result.stderr, /TEE mode: not end-to-end encrypted; Venice's proxy can read the prompt/, format);
    assert.match(result.stderr, /not bound to this request/, format);
    assert.match(result.stderr, /quote signature and enclave measurements are not verified client-side/, format);
    assert.doesNotMatch(result.stderr, /TEE attestation verified|running in Trusted Execution Environment/, format);
  }

  const pretty = await runChat(['--model', TEE_MODEL, '-f', 'pretty', 'hello']);
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.match(pretty.stdout, /TEE mode: not end-to-end encrypted[\s\S]*tee reply/);
  assert.equal(pretty.stderr, '');

  const quiet = await runChat(['--model', TEE_MODEL, '-q', 'hello']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, `${REPLY}\n`);
  assert.equal(quiet.stderr, '');

  const json = await runChat(['--model', TEE_MODEL, '-f', 'json', 'hello']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { content: REPLY });
});

test('--no-e2ee on an E2EE model announces the downgrade on stderr, even with -q', async () => {
  for (const extraArgs of [[], ['-q']]) {
    const result = await runChat(['--model', E2EE_MODEL, '--no-e2ee', ...extraArgs, 'hello']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${REPLY}\n`);
    assert.match(result.stderr, /--no-e2ee: end-to-end encryption is off for this E2EE model/);
    assert.equal(result.attestationRequests, 1);
    assert.equal(result.completions.length, 1);
    const [request] = result.completions;
    assert.equal(request.body.venice_parameters?.enable_e2ee, false);
    assert.equal(request.headers['x-venice-tee-client-pub-key'], undefined);
  }
});

const nvidiaPayload = JSON.stringify({ arch: 'HOPPER', evidence_list: [] });

const brokenAttestations: Array<[string, Record<string, unknown>, RegExp]> = [
  ['verified: false', { verified: false }, /did not report this attestation as verified/],
  ['a nonce that is not the client nonce', { nonce: 'f'.repeat(64) }, /nonce mismatch/],
  ['no evidence', { intel_quote: undefined }, /No attestation evidence/],
  ['another attested model', { model: 'other-model' }, /does not match requested model/],
  [
    'NVIDIA evidence but no Intel TDX quote',
    { intel_quote: undefined, nvidia_payload: nvidiaPayload, server_verification: { ...serverVerification, nvidia: { valid: true } } },
    /did not include an Intel TDX quote/,
  ],
  ['an unparseable quote', { intel_quote: '00'.repeat(100) }, /could not be parsed/],
  ['a non-TDX TEE type', { intel_quote: buildTdxQuote({ teeType: 0 }) }, /Unexpected TEE type/],
  ['a debug-mode TD', { intel_quote: buildTdxQuote({ tdAttributes: DEBUG_TD_ATTRIBUTES }) }, /debug mode/],
  ['no server verification', { server_verification: undefined }, /Server verification details were not returned/],
  ['an unbound nonce', { server_verification: { ...serverVerification, nonceBinding: { bound: false } } }, /Client nonce was not bound/],
  ['a failed TDX verification', { server_verification: { ...serverVerification, tdx: { valid: false } } }, /Intel TDX attestation verification did not pass/],
  ['NVIDIA evidence that was not verified', { nvidia_payload: nvidiaPayload }, /NVIDIA GPU attestation verification did not pass/],
  [
    'no hardware verification results',
    { server_verification: { nonceBinding: { bound: true }, verifiedAt: '', verificationDurationMs: 0 } },
    /No hardware attestation verification results/,
  ],
  ['a malformed NVIDIA payload', { nvidia_payload: '{not json' }, /NVIDIA GPU attestation payload is not a valid JSON object/],
];

test('TEE-only chat exits 1 without a completion request for each broken attestation field', async () => {
  for (const [label, change, failure] of brokenAttestations) {
    const result = await runChat(['--model', TEE_MODEL, 'TEE-PROMPT'], (model, nonce) => ({
      ...passingAttestation(model, nonce),
      ...change,
    }));

    assert.equal(result.status, 1, label);
    assert.equal(result.completions.length, 0, label);
    assert.match(result.stderr, /TEE attestation policy failed/, label);
    assert.match(result.stderr, failure, label);
    assert.equal(result.stdout, '', label);
  }
});
