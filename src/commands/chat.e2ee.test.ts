import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decryptChunk, deriveSigningAddressFromKey, encryptMessage, generateEphemeralKeyPair } from '../lib/e2ee.js';
import type { Message, Model } from '../types/index.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const MODEL = 'e2ee-test-model';
const BANNER = /Response decrypted end-to-end/;
const DEBUG_TD_ATTRIBUTES = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);

const enclave = generateEphemeralKeyPair();
const signingAddress = deriveSigningAddressFromKey(enclave.publicKeyHex) ?? '';
const otherAddress = deriveSigningAddressFromKey(generateEphemeralKeyPair().publicKeyHex) ?? '';

const e2eeModel: Model = {
  id: MODEL,
  type: 'text',
  model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
};

interface CompletionRequest {
  headers: IncomingHttpHeaders;
  raw: string;
  body: { messages: Message[]; tools?: unknown; venice_parameters?: Record<string, unknown> };
}

interface ChatRun {
  status: number | null;
  stdout: string;
  stderr: string;
  attestationRequests: number;
  completions: CompletionRequest[];
  history?: string;
}

interface Stub {
  models?: (type: string | null) => Model[];
  attestation?: (nonce: string) => Record<string, unknown>;
  reply?: (clientPublicKey: string) => string[];
}

function buildTdxQuote(options: { reportData?: string; teeType?: number; tdAttributes?: Buffer } = {}): string {
  const signatureData = Buffer.alloc(64);
  const quote = Buffer.alloc(636 + signatureData.length);
  quote.writeUInt16LE(4, 0);
  quote.writeUInt16LE(2, 2);
  quote.writeUInt32LE(options.teeType ?? 0x81, 4);
  options.tdAttributes?.copy(quote, 168);
  if (options.reportData) Buffer.from(options.reportData, 'hex').copy(quote, 568);
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

function passingAttestation(nonce: string): Record<string, unknown> {
  return {
    model: MODEL,
    nonce,
    verified: true,
    tee_provider: 'test',
    signing_key: enclave.publicKeyHex,
    signing_address: signingAddress,
    intel_quote: buildTdxQuote({ reportData: signingAddress }),
    server_verification: serverVerification,
  };
}

const frame = (delta: Record<string, unknown>, finishReason: string | null = null) =>
  `data: ${JSON.stringify({ id: 'cmpl-1', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const FINISH = frame({}, 'stop');
const DONE = 'data: [DONE]\n\n';

function encryptedReply(...texts: string[]) {
  return (clientPublicKey: string) => [
    ...texts.map((text) => frame({ content: encryptMessage(text, clientPublicKey) })),
    FINISH,
    DONE,
  ];
}

async function runChat(args: string[], stub: Stub = {}): Promise<ChatRun> {
  const models = stub.models ?? ((type) => (!type || type === 'text' ? [e2eeModel] : []));
  const attestation = stub.attestation ?? passingAttestation;
  const reply = stub.reply ?? encryptedReply('Hello ', 'from the enclave');
  const completions: CompletionRequest[] = [];
  let attestationRequests = 0;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');

    if (request.method === 'GET' && url.pathname === '/api/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: models(url.searchParams.get('type')) }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/tee/attestation') {
      attestationRequests++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(attestation(url.searchParams.get('nonce') ?? '')));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      const body = JSON.parse(raw);
      completions.push({ headers: request.headers, raw, body });
      const clientPublicKey = request.headers['x-venice-tee-client-pub-key'];
      // A CLI that wrongly falls back to plaintext still gets a well-formed reply.
      if (!body.stream || typeof clientPublicKey !== 'string') {
        response.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
        response.end(body.stream
          ? `${frame({ content: 'plaintext reply' })}${FINISH}${DONE}`
          : JSON.stringify({ choices: [{ message: { content: 'plaintext reply' }, finish_reason: 'stop' }] }));
        return;
      }
      const events = reply(clientPublicKey).join('');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(events);
      return;
    }
    response.writeHead(404).end();
  };
  // A handler error must still end the response, or the CLI waits on it.
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-chat-e2ee-'));

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

function tamperLastHexDigit(ciphertext: string): string {
  const last = ciphertext.at(-1) === '0' ? '1' : '0';
  return ciphertext.slice(0, -1) + last;
}

test('E2EE chat encrypts every user and system message to the attested key', async () => {
  const result = await runChat(['--model', MODEL, '-s', 'SYSTEM-SECRET', 'USER-SECRET']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Hello from the enclave\n');
  assert.equal(result.completions.length, 1);
  const [request] = result.completions;
  assert.deepEqual(request.body.messages.map((message) => message.role), ['system', 'user']);
  assert.deepEqual(
    request.body.messages.map((message) => decryptChunk(String(message.content), enclave.privateKey)),
    ['SYSTEM-SECRET', 'USER-SECRET']
  );
  assert.doesNotMatch(request.raw, /SYSTEM-SECRET|USER-SECRET/);
  assert.equal(request.body.venice_parameters?.enable_e2ee, true);
  assert.match(String(request.headers['x-venice-tee-client-pub-key']), /^04[0-9a-f]{128}$/);
  assert.equal(request.headers['x-venice-tee-signing-algo'], 'ecdsa');
  assert.equal(request.headers['x-venice-tee-model-pub-key'], enclave.publicKeyHex);
  assert.equal(result.history, undefined);
});

test('E2EE chat prints the decrypted banner only after a complete reply', async () => {
  const result = await runChat(['--model', MODEL, '-f', 'pretty', 'hello']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hello from the enclave[\s\S]*Response decrypted end-to-end/);
  assert.match(result.stdout, /Server attestation report passed the CLI's consistency checks/);
  assert.match(result.stdout, /quote signature and enclave measurements are not verified client-side/);
  assert.doesNotMatch(result.stdout, /TEE attestation verified/);
});

test('E2EE chat stops at a plaintext chunk and exits 1 without the banner', async () => {
  const result = await runChat(['--model', MODEL, '-f', 'pretty', 'hello'], {
    reply: (clientPublicKey) => [
      frame({ content: encryptMessage('Hello ', clientPublicKey) }),
      frame({ content: 'INJECTED ' }),
      frame({ content: encryptMessage('world', clientPublicKey) }),
      FINISH,
      DONE,
    ],
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Hello /);
  assert.doesNotMatch(result.stdout, /INJECTED|world/);
  assert.doesNotMatch(result.stdout, BANNER);
  assert.match(result.stderr, /E2EE response rejected: a response chunk was not encrypted/);
});

test('E2EE chat stops at a chunk that fails to decrypt and exits 1 without the banner', async () => {
  const stranger = generateEphemeralKeyPair();
  const badChunks: Record<string, (clientPublicKey: string) => string> = {
    'a tampered GCM tag': (clientPublicKey) => tamperLastHexDigit(encryptMessage('world', clientPublicKey)),
    'a chunk for another client key': () => encryptMessage('world', stranger.publicKeyHex),
    'an odd-length hex chunk': (clientPublicKey) => `${encryptMessage('world', clientPublicKey)}0`,
  };

  for (const [label, badChunk] of Object.entries(badChunks)) {
    const result = await runChat(['--model', MODEL, '-f', 'pretty', 'hello'], {
      reply: (clientPublicKey) => [
        frame({ content: encryptMessage('Hello ', clientPublicKey) }),
        frame({ content: badChunk(clientPublicKey) }),
        frame({ content: encryptMessage('again', clientPublicKey) }),
        FINISH,
        DONE,
      ],
    });

    assert.equal(result.status, 1, label);
    assert.match(result.stdout, /Hello /, label);
    assert.doesNotMatch(result.stdout, /world|again/, label);
    assert.doesNotMatch(result.stdout, BANNER, label);
    assert.match(result.stderr, /E2EE response rejected: a response chunk (could not be decrypted|was not encrypted)/, label);
  }
});

test('E2EE chat rejects a stream that ends without a finish reason', async () => {
  for (const format of ['pretty', 'raw', 'json']) {
    const result = await runChat(['--model', MODEL, '-f', format, 'hello'], {
      reply: (clientPublicKey) => [
        frame({ content: encryptMessage('Hello ', clientPublicKey) }),
        frame({ content: encryptMessage('from the enclave', clientPublicKey) }),
        DONE,
      ],
    });

    assert.equal(result.status, 1, format);
    assert.doesNotMatch(result.stdout, BANNER, format);
    assert.match(result.stderr, /E2EE response rejected: the stream ended without a finish reason/, format);
    if (format === 'json') assert.equal(result.stdout, '');
  }
});

test('E2EE chat sends exactly one completion request when the stream asks for tools', async () => {
  const result = await runChat(['--model', MODEL, '--tools', 'calculator', 'hello'], {
    reply: (clientPublicKey) => [
      frame({ content: encryptMessage('done', clientPublicKey) }),
      frame(
        { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } }] },
        'tool_calls'
      ),
      DONE,
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'done\n');
  assert.equal(result.completions.length, 1);
  assert.equal(result.completions[0].body.tools, undefined);
});

test('an e2ee model id fails closed when the catalog does not advertise supportsE2EE', async () => {
  const catalogs: Record<string, Model> = {
    'TEE only': { id: MODEL, type: 'text', model_spec: { capabilities: { supportsTeeAttestation: true } } },
    'supportsE2EE: false': { id: MODEL, type: 'text', model_spec: { capabilities: { supportsE2EE: false, supportsTeeAttestation: true } } },
    'no capabilities': { id: MODEL, type: 'text' },
  };

  for (const [label, entry] of Object.entries(catalogs)) {
    for (const extraArgs of [[], ['-q']]) {
      const result = await runChat(['--model', MODEL, ...extraArgs, 'USER-SECRET'], {
        models: (type) => (!type || type === 'text' ? [entry] : []),
      });

      assert.equal(result.status, 1, label);
      assert.match(result.stderr, /does not support E2EE encryption/, label);
      assert.equal(result.completions.length, 0, label);
      assert.equal(result.attestationRequests, 0, label);
      assert.equal(result.stdout, '', label);
    }
  }
});

test('E2EE stays on when the catalog types the model as something other than text', async () => {
  const stubs: Record<string, Stub['models']> = {
    'a non-text type': (type) => (!type || type === 'chat' ? [{ ...e2eeModel, type: 'chat' }] : []),
    'a server that ignores ?type=': () => [e2eeModel],
  };

  for (const [label, models] of Object.entries(stubs)) {
    const result = await runChat(['--model', MODEL, 'USER-SECRET'], { models });

    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.equal(result.completions.length, 1, label);
    const [request] = result.completions;
    assert.equal(request.body.venice_parameters?.enable_e2ee, true, label);
    assert.equal(decryptChunk(String(request.body.messages.at(-1)?.content), enclave.privateKey), 'USER-SECRET', label);
  }
});

const brokenAttestations: Array<[string, Record<string, unknown>, RegExp]> = [
  ['verified: false', { verified: false }, /did not report this attestation as verified/],
  ['a nonce that is not the client nonce', { nonce: 'f'.repeat(64) }, /nonce mismatch/],
  ['no evidence', { intel_quote: undefined }, /No attestation evidence/],
  ['another attested model', { model: 'other-model' }, /does not match requested model/],
  ['no signing key', { signing_key: undefined }, /did not include a signing public key/],
  ['an invalid signing key', { signing_key: `04${'11'.repeat(10)}` }, /not a valid uncompressed secp256k1 key/],
  [
    'NVIDIA evidence but no Intel TDX quote',
    {
      intel_quote: undefined,
      nvidia_payload: JSON.stringify({ arch: 'HOPPER', evidence_list: [] }),
      server_verification: { ...serverVerification, nvidia: { valid: true } },
    },
    /did not include an Intel TDX quote/,
  ],
  ['an unparseable quote', { intel_quote: '00'.repeat(100) }, /could not be parsed[\s\S]*REPORTDATA was not available/],
  ['a non-TDX TEE type', { intel_quote: buildTdxQuote({ reportData: signingAddress, teeType: 0 }) }, /Unexpected TEE type/],
  ['a debug-mode TD', { intel_quote: buildTdxQuote({ reportData: signingAddress, tdAttributes: DEBUG_TD_ATTRIBUTES }) }, /debug mode/],
  ['no server verification', { server_verification: undefined }, /Server verification details were not returned/],
  ['an unbound nonce', { server_verification: { ...serverVerification, nonceBinding: { bound: false } } }, /Client nonce was not bound/],
  ['a failed TDX verification', { server_verification: { ...serverVerification, tdx: { valid: false } } }, /Intel TDX attestation verification did not pass/],
  ['NVIDIA evidence that was not verified', { nvidia_payload: JSON.stringify({ arch: 'HOPPER', evidence_list: [] }) }, /NVIDIA GPU attestation verification did not pass/],
  [
    'no hardware verification results',
    { server_verification: { nonceBinding: { bound: true }, verifiedAt: '', verificationDurationMs: 0 } },
    /No hardware attestation verification results/,
  ],
  ['a malformed NVIDIA payload', { nvidia_payload: '{not json' }, /NVIDIA GPU attestation payload is not a valid JSON object/],
  ['REPORTDATA bound to another key', { intel_quote: buildTdxQuote({ reportData: otherAddress }) }, /does not match the TDX REPORTDATA binding/],
  ['a reported signing address for another key', { signing_address: otherAddress }, /Reported signing address does not match/],
];

test('E2EE chat exits 1 without a completion request for each broken attestation field', async () => {
  for (const [label, change, failure] of brokenAttestations) {
    const result = await runChat(['--model', MODEL, 'USER-SECRET'], {
      attestation: (nonce) => ({ ...passingAttestation(nonce), ...change }),
    });

    assert.equal(result.status, 1, label);
    assert.equal(result.completions.length, 0, label);
    assert.match(result.stderr, /E2EE attestation policy failed/, label);
    assert.match(result.stderr, failure, label);
    assert.equal(result.stdout, '', label);
  }
});
