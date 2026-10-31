import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const KEY_ID = 'e28e82dc-9df2-4b47-b726-d0a222ef2ab5';
const SECRET = 'venice-secret-0123456789';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function createKey(handler: Handler): Promise<CliResult & {
  methods: string[];
  leftovers: string[];
  secretSaved: boolean;
}> {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? '');
    request.resume();
    request.on('end', () => handler(request, response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-keys-create-'));
  const secretFile = join(homeDir, 'ci.key');

  try {
    const result = await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, 'keys', 'create', '--name', 'ci', '--output', secretFile],
        {
          cwd: homeDir,
          env: {
            ...process.env,
            HOME: homeDir,
            NODE_ENV: 'test',
            NO_COLOR: '1',
            VENICE_API_BASE_URL: `http://127.0.0.1:${port}`,
            VENICE_API_KEY: 'test-admin-key',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
    return {
      ...result,
      methods,
      leftovers: readdirSync(homeDir).filter((name) => name.endsWith('.tmp')),
      secretSaved: existsSync(secretFile),
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function assertKeyMayExist(result: CliResult): void {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /The API key "ci" may have been created, but its secret was not saved/);
  assert.match(result.stderr, /venice keys list/);
  assert.match(result.stderr, /venice keys delete <id>/);
}

test('keys create says the key may exist when the connection drops after the request', async () => {
  const result = await createKey((request) => request.socket.destroy());

  assertKeyMayExist(result);
  assert.deepEqual(result.methods, ['POST']);
  assert.equal(result.secretSaved, false);
  assert.deepEqual(result.leftovers, []);
});

test('keys create says the key may exist after a truncated response without echoing it', async () => {
  const body = JSON.stringify({ data: { id: KEY_ID, apiKey: SECRET, apiKeyType: 'INFERENCE' } });
  const result = await createKey((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    });
    response.write(body.slice(0, body.indexOf(SECRET) + 12));
    setTimeout(() => response.socket?.destroy(), 20);
  });

  assertKeyMayExist(result);
  assert.match(result.stderr, /No valid response was received/);
  assert.doesNotMatch(result.stderr, /venice-secret/);
  assert.deepEqual(result.methods, ['POST']);
  assert.equal(result.secretSaved, false);
  assert.deepEqual(result.leftovers, []);
});

test('keys create says the key may exist after a server error', async () => {
  const result = await createKey((_request, response) => {
    sendJson(response, 503, { error: { message: 'upstream unavailable' } });
  });

  assertKeyMayExist(result);
  assert.match(result.stderr, /upstream unavailable/);
  assert.deepEqual(result.methods, ['POST']);
});

test('keys create does not suggest the key exists when Venice refuses the request', async () => {
  for (const [status, message] of [[400, 'description is invalid'], [401, 'bad key']] as const) {
    const result = await createKey((_request, response) => {
      sendJson(response, status, { error: { message } });
    });

    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /may have been created/);
    assert.equal(result.secretSaved, false);
    assert.deepEqual(result.leftovers, []);
  }
});

test('keys create deletes a key whose secret is missing from the response and fails', async () => {
  for (const apiKey of [undefined, '', 42]) {
    const result = await createKey((request, response) => {
      if (request.method === 'POST') {
        sendJson(response, 200, {
          data: { id: KEY_ID, apiKey, apiKeyType: 'INFERENCE', description: 'ci' },
        });
        return;
      }
      sendJson(response, 200, { success: true });
    });

    assert.equal(result.status, 1, `${String(apiKey)}: ${result.stderr}`);
    assert.match(result.stderr, /Venice did not return the secret for the new API key/);
    assert.match(result.stderr, new RegExp(`New API key ${KEY_ID} was deleted`));
    assert.doesNotMatch(result.stdout, /Secret saved/);
    assert.deepEqual(result.methods, ['POST', 'DELETE']);
    assert.equal(result.secretSaved, false);
    assert.deepEqual(result.leftovers, []);
  }
});

test('keys create gives a recovery command when deleting a key without a secret fails', async () => {
  const result = await createKey((request, response) => {
    if (request.method === 'POST') {
      sendJson(response, 200, { data: { id: KEY_ID, apiKeyType: 'INFERENCE' } });
      return;
    }
    sendJson(response, 500, { error: { message: 'deletion failed' } });
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Automatic deletion also failed/);
  assert.match(result.stderr, new RegExp(`venice keys delete ${KEY_ID} --force`));
  assert.deepEqual(result.methods, ['POST', 'DELETE']);
  assert.equal(result.secretSaved, false);
});

test('keys create refuses a response without a valid key ID and does not save its secret', async () => {
  for (const data of [{ id: 'key-id', apiKey: SECRET }, { apiKey: SECRET }, null]) {
    const result = await createKey((_request, response) => {
      sendJson(response, 200, { data });
    });

    assertKeyMayExist(result);
    assert.match(result.stderr, /did not return a valid ID/);
    assert.doesNotMatch(result.stderr, /venice-secret/);
    assert.deepEqual(result.methods, ['POST']);
    assert.equal(result.secretSaved, false);
    assert.deepEqual(result.leftovers, []);
  }
});
