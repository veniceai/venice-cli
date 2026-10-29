import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decryptChunk,
  deriveSigningAddressFromKey,
  encryptMessage,
  generateEphemeralKeyPair,
} from './lib/e2ee.js';

const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url));
const MODEL = 'e2ee-qwen3-5-122b-a10b';
const PROMPT = 'Summarise my private notes';
const ATTESTATION_PASSED = /✅ Attestation report passed/;
const BANNER = /🔐 Response decrypted/;

type Json = Record<string, unknown>;
type SseEvent = string | Json;

interface Enclave {
  privateKey: Uint8Array;
  signingKey: string;
  signingAddress: string;
}

interface Scenario {
  enclave?: Enclave;
  attestation?: (passing: Json, enclave: Enclave) => Json;
  reply?: (encrypt: (text: string) => string) => SseEvent[];
  done?: boolean;
  contentType?: string;
}

interface StubRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  proxyRequests: string[];
  requests: StubRequest[];
  enclave: Enclave;
}

interface Example {
  name: string;
  skip: string | false;
  command: string;
  args: string[];
  env: (proxyPort: number) => Record<string, string>;
}

// Fails every fetch that would leave the machine, so no run can reach the real API.
const FETCH_GUARD = `data:text/javascript,${encodeURIComponent(`
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== '127.0.0.1') {
    process.stderr.write('blocked fetch: ' + url.href + '\\n');
    throw new Error('network access is blocked in tests');
  }
  return realFetch(input, init);
};
`)}`;

const python = process.env.PYTHON || 'python3';
const pythonImports = spawnSync(python, ['-c', 'import cryptography, requests'], {
  env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), PYTHONDONTWRITEBYTECODE: '1' },
});

const examples: Example[] = [
  {
    name: 'e2ee_chat.mjs',
    skip: false,
    command: process.execPath,
    args: [`--import=${FETCH_GUARD}`, join(examplesDir, 'e2ee_chat.mjs')],
    env: () => ({}),
  },
  {
    name: 'e2ee_chat.py',
    skip: pythonImports.status === 0
      ? false
      : `${python} cannot import cryptography and requests; set PYTHON to an interpreter that can`,
    command: python,
    args: [join(examplesDir, 'e2ee_chat.py')],
    // requests honours these, so anything not addressed to the stub reaches only the refusing proxy.
    env: (proxyPort) => ({
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: '127.0.0.1',
    }),
  },
];

function makeEnclave(): Enclave {
  const { privateKey, publicKeyHex } = generateEphemeralKeyPair();
  const signingAddress = deriveSigningAddressFromKey(publicKeyHex);
  assert.ok(signingAddress);
  return { privateKey, signingKey: publicKeyHex, signingAddress };
}

// An enclave whose 64-byte key (without the 04 prefix) itself starts with 04.
function makeEnclaveWithAmbiguousPrefix(): Enclave {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const enclave = makeEnclave();
    if (enclave.signingKey.startsWith('0404')) return enclave;
  }
  throw new Error('no key with an X coordinate starting with 04 was found');
}

interface QuoteOptions {
  reportDataAddress: string;
  version?: number;
  teeType?: number;
  bodyType?: number;
  debug?: boolean;
  signatureBytes?: number;
  declaredSignatureLength?: number;
  trailingBytes?: number;
}

function buildTdxQuote(options: QuoteOptions): string {
  const { version = 4, teeType = 0x81, bodyType = 2, debug = false, signatureBytes = 64, trailingBytes = 0 } = options;
  const header = Buffer.alloc(48);
  header.writeUInt16LE(version, 0);
  header.writeUInt16LE(2, 2);
  header.writeUInt32LE(teeType, 4);
  const body = Buffer.alloc(bodyType === 3 ? 648 : 584);
  if (debug) body[120] = 0x01;
  Buffer.from(options.reportDataAddress, 'hex').copy(body, 520);
  const descriptor = Buffer.alloc(6);
  descriptor.writeUInt16LE(bodyType, 0);
  descriptor.writeUInt32LE(body.length, 2);
  const signatureLength = Buffer.alloc(4);
  signatureLength.writeUInt32LE(options.declaredSignatureLength ?? signatureBytes, 0);
  return Buffer.concat([
    header,
    version === 5 ? descriptor : Buffer.alloc(0),
    body,
    signatureLength,
    Buffer.alloc(signatureBytes, 0xab),
    Buffer.alloc(trailingBytes),
  ]).toString('hex');
}

function passingAttestation(enclave: Enclave, nonce: string): Json {
  return {
    verified: true,
    nonce,
    model: MODEL,
    tee_provider: 'test-provider',
    signing_key: enclave.signingKey,
    signing_address: enclave.signingAddress,
    intel_quote: buildTdxQuote({ reportDataAddress: enclave.signingAddress }),
    server_verification: {
      tdx: { valid: true },
      nonceBinding: { bound: true },
      verifiedAt: new Date().toISOString(),
      verificationDurationMs: 1,
    },
  };
}

const withQuote = (options: Omit<QuoteOptions, 'reportDataAddress'>) => (attestation: Json, enclave: Enclave) => ({
  ...attestation,
  intel_quote: buildTdxQuote({ reportDataAddress: enclave.signingAddress, ...options }),
});

const withServerVerification = (overrides: Json) => (attestation: Json) => ({
  ...attestation,
  server_verification: { ...(attestation.server_verification as Json), ...overrides },
});

function chunk(content?: unknown, finishReason: string | null = null, extra: Json = {}): Json {
  return {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finishReason }],
    ...extra,
  };
}

const finished = chunk(undefined, 'stop');
const defaultReply = (encrypt: (text: string) => string) => [
  chunk(encrypt('Hello ')),
  chunk(encrypt('from the enclave')),
  finished,
];

async function startStub(scenario: Scenario) {
  const enclave = scenario.enclave ?? makeEnclave();
  const requests: StubRequest[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let body = '';
    for await (const data of request) body += data;
    requests.push({ method: request.method ?? '', url, headers: request.headers, body });

    if (request.method === 'GET' && url.pathname === '/api/v1/tee/attestation') {
      const passing = passingAttestation(enclave, url.searchParams.get('nonce') ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(scenario.attestation ? scenario.attestation(passing, enclave) : passing));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      const clientPublicKey = String(request.headers['x-venice-tee-client-pub-key'] ?? '');
      const events = (scenario.reply ?? defaultReply)((text) => encryptMessage(text, clientPublicKey));
      response.writeHead(200, { 'Content-Type': scenario.contentType ?? 'text/event-stream' });
      for (const event of events) {
        response.write(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`);
      }
      response.end(scenario.done === false ? undefined : 'data: [DONE]\n\n');
      return;
    }

    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    enclave,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

// Records the request line of anything sent through it, then drops the connection.
async function startRefusingProxy() {
  const requestLines: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', (data) => {
      requestLines.push(data.toString('latin1').split('\r\n')[0]);
      socket.destroy();
    });
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    requestLines,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function runExample(example: Example, scenario: Scenario, { testMode = true } = {}): Promise<RunResult> {
  const stub = await startStub(scenario);
  const proxy = await startRefusingProxy();
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-example-'));

  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      NO_COLOR: '1',
      VENICE_API_KEY: 'test-key',
      VENICE_API_BASE_URL: stub.baseUrl,
      ...(testMode ? { NODE_ENV: 'test' } : {}),
      ...example.env(proxy.port),
    };
    const result = await new Promise<Pick<RunResult, 'status' | 'stdout' | 'stderr'>>((resolve, reject) => {
      const child = spawn(example.command, example.args, { cwd: homeDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
      child.once('error', reject);
      child.once('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
      child.stdin.end(`${PROMPT}\n`);
    });
    return { ...result, proxyRequests: proxy.requestLines, requests: stub.requests, enclave: stub.enclave };
  } finally {
    await Promise.all([stub.close(), proxy.close()]);
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function requestsTo(result: RunResult, method: string, pathname: string): StubRequest[] {
  return result.requests.filter((request) => request.method === method && request.url.pathname === pathname);
}

function assertCompleted(result: RunResult): void {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, ATTESTATION_PASSED);
  assert.match(result.stdout, /Hello from the enclave\n-{50}\n\n🔐 Response decrypted \(2 encrypted chunks, finish_reason: "stop"\)/);

  const [chat] = requestsTo(result, 'POST', '/api/v1/chat/completions');
  assert.ok(chat, 'the example sent the chat request');
  const body = JSON.parse(chat.body);
  assert.equal(decryptChunk(body.messages[0].content, result.enclave.privateKey), PROMPT);
}

function assertAttestationRejected(result: RunResult): string[] {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, ATTESTATION_PASSED);
  assert.doesNotMatch(result.stdout, BANNER);
  assert.deepEqual(requestsTo(result, 'POST', '/api/v1/chat/completions'), [], 'no prompt was sent');
  const failures = /Attestation rejected: (.*)/.exec(result.stderr)?.[1]?.split('; ');
  assert.ok(failures, result.stderr);
  return failures;
}

const acceptedAttestations: Array<{ name: string; scenario: () => Scenario }> = [
  {
    name: 'a version 5 quote with a TD report 1.0 body',
    scenario: () => ({ attestation: withQuote({ version: 5, bodyType: 2 }) }),
  },
  {
    name: 'a version 5 quote with a TD report 1.5 body',
    scenario: () => ({ attestation: withQuote({ version: 5, bodyType: 3 }) }),
  },
  {
    name: 'a 64-byte signing key that itself starts with 04',
    scenario: () => {
      const enclave = makeEnclaveWithAmbiguousPrefix();
      return { enclave, attestation: (attestation) => ({ ...attestation, signing_key: enclave.signingKey.slice(2) }) };
    },
  },
  {
    name: 'a 0x-prefixed upper-case signing_address',
    scenario: () => ({
      attestation: (attestation, enclave) => ({ ...attestation, signing_address: `0x${enclave.signingAddress.toUpperCase()}` }),
    }),
  },
];

const rejectedAttestations: Array<{ name: string; attestation: Scenario['attestation']; failure: RegExp }> = [
  {
    name: 'verified is not true',
    attestation: (attestation) => ({ ...attestation, verified: 'true' }),
    failure: /did not report verified: true/,
  },
  {
    name: 'the nonce is not echoed',
    attestation: (attestation) => ({ ...attestation, nonce: '0'.repeat(64) }),
    failure: /does not echo our nonce/,
  },
  {
    name: 'another model is attested',
    attestation: (attestation) => ({ ...attestation, model: 'e2ee-other-model' }),
    failure: /attested model "e2ee-other-model" is not e2ee-qwen3-5-122b-a10b/,
  },
  {
    name: 'there is no Intel quote',
    attestation: (attestation) => ({ ...attestation, intel_quote: undefined }),
    failure: /no Intel TDX quote/,
  },
  {
    name: 'the quote is not hex',
    attestation: (attestation) => ({ ...attestation, intel_quote: 'zz' }),
    failure: /TDX quote is not valid hex/,
  },
  {
    name: 'the quote is only a header',
    attestation: (attestation, enclave) => ({
      ...attestation,
      intel_quote: buildTdxQuote({ reportDataAddress: enclave.signingAddress }).slice(0, 96),
    }),
    failure: /TDX quote is truncated/,
  },
  {
    name: 'the quote has another TEE type',
    attestation: withQuote({ teeType: 0 }),
    failure: /unexpected TEE type 0x0/,
  },
  {
    name: 'the quote version is unsupported',
    attestation: withQuote({ version: 3 }),
    failure: /unsupported TDX quote version 3/,
  },
  {
    name: 'a version 5 quote carries no TD report',
    attestation: withQuote({ version: 5, bodyType: 1 }),
    failure: /unexpected body \(type 1/,
  },
  {
    name: 'the signature data is cut short',
    attestation: withQuote({ declaredSignatureLength: 65 }),
    failure: /does not match its signature data length/,
  },
  {
    name: 'bytes follow the signature data',
    attestation: withQuote({ trailingBytes: 1 }),
    failure: /does not match its signature data length/,
  },
  {
    name: 'the TD debug bit is set',
    attestation: withQuote({ debug: true }),
    failure: /TD debug bit/,
  },
  {
    name: 'the server did not validate the quote',
    attestation: withServerVerification({ tdx: { valid: false } }),
    failure: /tdx\.valid is not true/,
  },
  {
    name: 'the server did not bind the nonce',
    attestation: withServerVerification({ nonceBinding: { bound: false } }),
    failure: /nonceBinding\.bound is not true/,
  },
  {
    name: 'an NVIDIA payload was not validated',
    attestation: (attestation) => ({ ...attestation, nvidia_payload: '{}' }),
    failure: /nvidia\.valid is not true/,
  },
  {
    name: 'the signing key is not on the curve',
    attestation: (attestation) => ({ ...attestation, signing_key: `04${'ff'.repeat(64)}` }),
    failure: /not a valid uncompressed secp256k1 public key/,
  },
  {
    name: 'the signing key is compressed',
    attestation: (attestation, enclave) => ({ ...attestation, signing_key: `02${enclave.signingKey.slice(2, 66)}` }),
    failure: /not a 64- or 65-byte uncompressed secp256k1 public key/,
  },
  {
    name: 'REPORTDATA binds a different key',
    attestation: (attestation) => ({
      ...attestation,
      intel_quote: buildTdxQuote({ reportDataAddress: makeEnclave().signingAddress }),
    }),
    failure: /does not match the address in the TDX REPORTDATA/,
  },
  {
    name: 'signing_address names a different key',
    attestation: (attestation) => ({ ...attestation, signing_address: `0x${'11'.repeat(20)}` }),
    failure: /signing_address does not match the signing key/,
  },
];

const strangerKey = generateEphemeralKeyPair().publicKeyHex;

const rejectedStreams: Array<{ name: string; scenario: Scenario; error: RegExp; withheld?: string }> = [
  {
    name: 'a plaintext content chunk',
    scenario: { reply: (encrypt) => [chunk(encrypt('Hello ')), chunk('INJECTED '), chunk(encrypt('world')), finished] },
    error: /not E2EE ciphertext/,
    withheld: 'INJECTED',
  },
  {
    name: 'a hex chunk too short to be ciphertext',
    scenario: { reply: () => [chunk('deadbeef'), finished] },
    error: /not E2EE ciphertext/,
  },
  {
    name: 'a chunk encrypted to another key',
    scenario: {
      reply: (encrypt) => [
        chunk(encrypt('Pay ')),
        chunk(encryptMessage('NOT ', strangerKey)),
        chunk(encrypt('the invoice.')),
        finished,
      ],
    },
    error: /Could not decrypt a content chunk/,
    withheld: 'the invoice.',
  },
  {
    name: 'a stream that ends before data: [DONE]',
    scenario: { done: false },
    error: /Stream ended before data: \[DONE\]/,
  },
  {
    name: 'a stream without a finish_reason',
    scenario: { reply: (encrypt) => [chunk(encrypt('Hello ')), chunk(encrypt('from the enclave'))] },
    error: /Stream ended without a finish_reason/,
  },
  {
    name: 'an error event',
    scenario: { reply: (encrypt) => [chunk(encrypt('Hello ')), { error: { message: 'upstream failed' } }] },
    error: /Server reported an error mid-stream/,
  },
  {
    name: 'an event that is not JSON',
    scenario: { reply: (encrypt) => [chunk(encrypt('Hello ')), 'data: {"choices": [\n\n'] },
    error: /not valid JSON/,
  },
  {
    name: 'a reply that is not an event stream',
    scenario: { contentType: 'application/json' },
    error: /Expected an event stream/,
  },
];

for (const example of examples) {
  describe(`examples/${example.name}`, { skip: example.skip, concurrency: 4 }, () => {
    test('encrypts to the attested key and decrypts a complete stream', async () => {
      const result = await runExample(example, {});

      assertCompleted(result);
      const [attestation] = requestsTo(result, 'GET', '/api/v1/tee/attestation');
      assert.equal(attestation.url.searchParams.get('model'), MODEL);
      assert.match(attestation.url.searchParams.get('nonce') ?? '', /^[0-9a-f]{64}$/);
      const [chat] = requestsTo(result, 'POST', '/api/v1/chat/completions');
      assert.equal(chat.headers.authorization, 'Bearer test-key');
      assert.match(String(chat.headers['x-venice-tee-client-pub-key']), /^04[0-9a-f]{128}$/);
      assert.equal(chat.headers['x-venice-tee-model-pub-key'], result.enclave.signingKey);
      assert.equal(JSON.parse(chat.body).model, MODEL);
      assert.deepEqual(result.proxyRequests, []);
    });

    test('processes events that mention [DONE] inside their JSON', async () => {
      const result = await runExample(example, {
        reply: (encrypt) => [
          chunk(encrypt('Hello '), null, { id: 'cmpl-[DONE]' }),
          chunk(encrypt('from the enclave')),
          finished,
        ],
      });

      assertCompleted(result);
    });

    for (const { name, scenario } of acceptedAttestations) {
      test(`accepts ${name}`, async () => {
        assertCompleted(await runExample(example, scenario()));
      });
    }

    test('rejects an attestation that only has verified, nonce and signing_key', async () => {
      const result = await runExample(example, {
        attestation: (attestation, enclave) => ({
          verified: true,
          nonce: attestation.nonce,
          signing_key: enclave.signingKey,
        }),
      });

      assert.ok(assertAttestationRejected(result).length > 1, result.stderr);
    });

    for (const { name, attestation, failure } of rejectedAttestations) {
      test(`rejects the attestation when ${name}`, async () => {
        const failures = assertAttestationRejected(await runExample(example, { attestation }));

        assert.equal(failures.length, 1, failures.join('\n'));
        assert.match(failures[0], failure);
      });
    }

    for (const { name, scenario, error, withheld } of rejectedStreams) {
      test(`exits 1 without the banner on ${name}`, async () => {
        const result = await runExample(example, scenario);

        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, ATTESTATION_PASSED);
        assert.doesNotMatch(result.stdout, BANNER);
        assert.match(result.stderr, error);
        if (withheld) assert.ok(!result.stdout.includes(withheld), result.stdout);
      });
    }

    test('ignores VENICE_API_BASE_URL unless NODE_ENV=test', async () => {
      const result = await runExample(example, {}, { testMode: false });

      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('API: https://api.venice.ai/api/v1\n'), result.stdout);
      assert.deepEqual(result.requests, [], 'the API key was not sent to VENICE_API_BASE_URL');
      const attempts = [...result.stderr.split('\n'), ...result.proxyRequests];
      assert.ok(
        attempts.some((line) =>
          line.startsWith('blocked fetch: https://api.venice.ai/api/v1/tee/attestation?')
          || line.startsWith('CONNECT api.venice.ai:443 ')
        ),
        attempts.join('\n')
      );
    });
  });
}
