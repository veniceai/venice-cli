import { spawn } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getVersion } from '../lib/version.js';
import { compareVersions, fetchLatestVersion } from './update.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const UPDATE_COMMAND = 'npm install -g veniceai-cli@latest';
const MAX_RESPONSE_BYTES = 256 * 1024;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RegistryContext {
  url: string;
  homeDir: string;
  requests: IncomingMessage[];
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function testEnv(homeDir: string, checkUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    VENICE_API_KEY: 'test-key',
    VENICE_UPDATE_CHECK_URL: checkUrl,
  };
}

async function withRegistry(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (context: RegistryContext) => Promise<void>
): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-update-test-'));
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    await callback({ url: `http://127.0.0.1:${address.port}`, homeDir, requests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function sendManifest(response: ServerResponse, manifest: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(manifest));
}

test('compareVersions orders releases and prereleases by SemVer precedence', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.2.0',
    '1.10.0',
    '2.0.0',
    '10.0.0',
    '99999999999999999999.0.0',
  ];
  for (const [i, left] of ordered.entries()) {
    for (const [j, right] of ordered.entries()) {
      assert.equal(Math.sign(compareVersions(left, right)), Math.sign(i - j), `${left} vs ${right}`);
    }
  }
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1+build.5', '1.0.0-rc.1+build.6'), 0);
});

test('compareVersions rejects strings that are not semantic versions', () => {
  const invalid = ['', '1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0-01', 'latest', `1.0.0-${'a'.repeat(300)}`];
  for (const version of invalid) {
    assert.throws(() => compareVersions(version, '1.0.0'), /Cannot compare versions/, version);
  }
});

test('update --check reports a newer release and how to install it', async () => {
  await withRegistry((_request, response) => {
    sendManifest(response, { name: 'veniceai-cli', version: '99.0.0' });
  }, async ({ url, homeDir, requests }) => {
    const result = await runCli(['update', '--check'], testEnv(homeDir, `${url}/veniceai-cli/latest`));

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Current version: ${getVersion()}`), result.stdout);
    assert.match(result.stdout, /Latest version: +99\.0\.0/);
    assert.match(result.stdout, /Update available/);
    assert.ok(result.stdout.includes(UPDATE_COMMAND), result.stdout);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, '/veniceai-cli/latest');
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers.cookie, undefined);
    assert.doesNotMatch(JSON.stringify(requests[0].headers), /test-key/);
  });
});

test('update --check -f json reports whether a newer release exists', async () => {
  const current = getVersion();
  const cases = [
    { latest: '99.0.0', updateAvailable: true },
    { latest: current, updateAvailable: false },
    { latest: `${current}-rc.1`, updateAvailable: false },
    { latest: '0.0.1', updateAvailable: false },
  ];

  for (const { latest, updateAvailable } of cases) {
    await withRegistry((_request, response) => {
      sendManifest(response, { name: 'veniceai-cli', version: latest });
    }, async ({ url, homeDir }) => {
      const result = await runCli(['update', '--check', '-f', 'json'], testEnv(homeDir, url));

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        currentVersion: current,
        latestVersion: latest,
        updateAvailable,
        updateCommand: updateAvailable ? UPDATE_COMMAND : null,
      });
    });
  }
});

test('update --check says when no newer release is available', async () => {
  await withRegistry((_request, response) => {
    sendManifest(response, { name: 'veniceai-cli', version: getVersion() });
  }, async ({ url, homeDir }) => {
    const result = await runCli(['update', '--check'], testEnv(homeDir, url));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No newer release is available/);
    assert.ok(!result.stdout.includes(UPDATE_COMMAND), result.stdout);
  });
});

test('update --check exits non-zero when the registry response is unusable', async () => {
  const cases: Array<{
    name: string;
    handler: (response: ServerResponse) => void;
    expected: RegExp;
  }> = [
    {
      name: 'HTTP error',
      handler: (response) => {
        response.writeHead(500);
        response.end();
      },
      expected: /returned HTTP 500/,
    },
    {
      name: 'invalid JSON',
      handler: (response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"version":');
      },
      expected: /invalid JSON/,
    },
    {
      name: 'missing version',
      handler: (response) => sendManifest(response, { name: 'veniceai-cli' }),
      expected: /did not return a valid version/,
    },
    {
      name: 'malformed version',
      handler: (response) => sendManifest(response, { version: '\u001b[31m9.9.9' }),
      expected: /did not return a valid version/,
    },
    {
      name: 'declared oversized body',
      handler: (response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20));
      },
      expected: /exceeded 256 KB/,
    },
    {
      name: 'streamed oversized body',
      handler: (response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(Buffer.alloc(MAX_RESPONSE_BYTES, 0x20));
        response.end(Buffer.alloc(1024, 0x20));
      },
      expected: /exceeded 256 KB/,
    },
    {
      name: 'redirect',
      handler: (response) => {
        response.writeHead(302, { Location: '/elsewhere' });
        response.end();
      },
      expected: /could not reach the npm registry/,
    },
  ];

  for (const testCase of cases) {
    await withRegistry((_request, response) => testCase.handler(response), async ({ url, homeDir, requests }) => {
      const result = await runCli(['update', '--check', '-f', 'json'], testEnv(homeDir, url));

      assert.equal(result.status, 1, `${testCase.name}: ${result.stderr}`);
      assert.equal(result.stdout, '', testCase.name);
      assert.match(result.stderr, testCase.expected, testCase.name);
      assert.doesNotMatch(result.stderr, /\u001b/, testCase.name);
      assert.equal(requests.length, 1, testCase.name);
    });
  }
});

test('update without --check prints a hint, exits 1, and makes no request', async () => {
  await withRegistry((_request, response) => {
    sendManifest(response, { version: '99.0.0' });
  }, async ({ url, homeDir, requests }) => {
    const result = await runCli(['update'], testEnv(homeDir, url));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /venice update --check/);
    assert.equal(requests.length, 0);
  });
});

test('fetchLatestVersion times out while waiting for headers or the body', async () => {
  const stalls: Array<(response: ServerResponse) => void> = [
    () => {},
    (response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"version":');
    },
  ];

  for (const stall of stalls) {
    await withRegistry((_request, response) => stall(response), async ({ url }) => {
      await assert.rejects(fetchLatestVersion(url, 50), /timed out after 0.05 seconds/);
    });
  }
});

test('update --check uses the public registry and sends no credentials', async () => {
  await withRegistry((_request, response) => {
    sendManifest(response, { version: '99.0.0' });
  }, async ({ url, homeDir, requests }) => {
    const fetchLog = join(homeDir, 'fetch.json');
    const preloadPath = join(homeDir, 'record-fetch.cjs');
    writeFileSync(preloadPath, `
const fs = require('node:fs');
globalThis.fetch = async (input, init = {}) => {
  const { signal: _signal, ...rest } = init;
  fs.writeFileSync(process.env.VENICE_TEST_FETCH_LOG, JSON.stringify({ url: String(input), init: rest }));
  return new Response(JSON.stringify({ version: '0.0.1' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
`);

    const result = await runCli(['update', '--check', '-f', 'json'], {
      PATH: process.env.PATH,
      HOME: homeDir,
      NO_COLOR: '1',
      NODE_OPTIONS: `--require=${preloadPath}`,
      VENICE_API_KEY: 'test-key',
      VENICE_TEST_FETCH_LOG: fetchLog,
      VENICE_UPDATE_CHECK_URL: url,
    }, homeDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).latestVersion, '0.0.1');
    const recorded = JSON.parse(readFileSync(fetchLog, 'utf8'));
    assert.equal(recorded.url, 'https://registry.npmjs.org/veniceai-cli/latest');
    assert.equal(recorded.init.redirect, 'error');
    assert.deepEqual(recorded.init.headers, { Accept: 'application/json' });
    assert.doesNotMatch(JSON.stringify(recorded), /test-key/);
    assert.equal(requests.length, 0);
  });
});

test('starting the CLI makes no network request and writes nothing outside ~/.venice', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-startup-home-'));
  const workDir = mkdtempSync(join(tmpdir(), 'venice-startup-work-'));
  try {
    const fetchLog = join(workDir, 'fetch.log');
    const preloadPath = join(workDir, 'record-fetch.cjs');
    writeFileSync(preloadPath, `
const fs = require('node:fs');
globalThis.fetch = async (input) => {
  fs.appendFileSync(process.env.VENICE_TEST_FETCH_LOG, String(input) + '\\n');
  throw new Error('network access is blocked in this test');
};
`);

    const result = await runCli(['--version'], {
      PATH: process.env.PATH,
      HOME: homeDir,
      NO_COLOR: '1',
      NODE_OPTIONS: `--require=${preloadPath}`,
      VENICE_API_KEY: 'test-key',
      VENICE_TEST_FETCH_LOG: fetchLog,
    }, workDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), getVersion());
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(fetchLog), false);
    assert.deepEqual(readdirSync(homeDir).filter((name) => name !== '.venice'), []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
