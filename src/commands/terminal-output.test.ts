import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const OSC52 = `\x1b]52;c;${Buffer.from('echo copied').toString('base64')}\x07`;
const OSC8 = '\x1b]8;;https://example.com/other\x1b\\link text\x1b]8;;\x1b\\';
const C1_OSC = '\u009d0;title\u009c';
const BIDI = 'safe\u202Etxt.exe\u202C';
const PAYLOAD = `${OSC52}${OSC8}\x1b[2K${C1_OSC}\u009b2J${BIDI}`;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type Routes = Record<string, (url: URL) => unknown>;

async function withApi<T>(routes: Routes, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routes[`${req.method} ${url.pathname.replace(/^\/api\/v1/, '')}`];
    req.resume();
    req.on('end', () => {
      const body = route?.(url);
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const { status = 200, json, headers = {} } = body as {
        status?: number;
        json: unknown;
        headers?: Record<string, string>;
      };
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}/api/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface RunOptions {
  home: string;
  baseUrl?: string;
  cwd?: string;
  /** Redirects stdout and stderr to regular files, as `> out 2> err` does. */
  toFiles?: boolean;
  /**
   * A bash script that runs the CLI as "$@". Node's 'pipe' stdio is a socket,
   * and opening /dev/stdout on a socket fails; bash joins `|` with real pipes.
   */
  bash?: string;
}

function runCli(args: string[], options: RunOptions): Promise<CliResult> {
  const [command, commandArgs]: [string, string[]] = options.bash
    ? ['bash', ['-o', 'pipefail', '-c', options.bash, 'bash', process.execPath, cliPath, ...args]]
    : [process.execPath, [cliPath, ...args]];
  const filesDir = options.toFiles ? mkdtempSync(join(tmpdir(), 'venice-terminal-output-files-')) : undefined;
  // Appending, as `>>` does, so a write through /dev/stdout is not overwritten by later output.
  const files = filesDir ? ['stdout', 'stderr'].map((name) => openSync(join(filesDir, name), 'a')) : [];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? options.home,
      env: {
        ...process.env,
        HOME: options.home,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: options.baseUrl ?? 'http://127.0.0.1:9/api/v1',
        VENICE_API_KEY: 'test-key',
      },
      stdio: ['ignore', files[0] ?? 'pipe', files[1] ?? 'pipe'],
    });
    files.forEach((fd) => closeSync(fd));
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      if (filesDir) {
        stdout = readFileSync(join(filesDir, 'stdout'), 'utf8');
        stderr = readFileSync(join(filesDir, 'stderr'), 'utf8');
        rmSync(filesDir, { recursive: true, force: true });
      }
      resolve({ status, stdout, stderr });
    });
  });
}

const ok = (json: unknown) => () => ({ json });

function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'venice-terminal-output-'));
  return run(home).finally(() => rmSync(home, { recursive: true, force: true }));
}

function assertClean(output: string, label: string): void {
  assert.doesNotMatch(output, UNSAFE, `${label}: ${JSON.stringify(output)}`);
}

test('history output strips control sequences stored in history.json unless redirected to a file', async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.venice', 'history.json'), JSON.stringify([{
      id: 'conv-1',
      timestamp: '2026-08-15T00:00:00.000Z',
      model: `model${PAYLOAD}`,
      character: `character${PAYLOAD}`,
      privacy: 'plain',
      messages: [
        { role: 'user', content: `question${PAYLOAD}` },
        { role: 'assistant', content: `answer${PAYLOAD}` },
      ],
    }]));

    for (const args of [['history', 'show'], ['history', 'show', '-f', 'markdown'], ['history'], ['history', 'list']]) {
      const result = await runCli(args, { home });
      assert.equal(result.status, 0, result.stderr);
      assertClean(result.stdout, args.join(' '));
      assert.match(result.stdout, /modellink textsafetxt\.exe/, args.join(' '));
    }
    const shown = await runCli(['history', 'show'], { home });
    assert.match(shown.stdout, /User: questionlink textsafetxt\.exe/);
    assert.match(shown.stdout, /Assistant: answerlink textsafetxt\.exe/);
    assert.match(shown.stdout, /Character: characterlink textsafetxt\.exe/);

    const redirected = await runCli(['history', 'show'], { home, toFiles: true });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.ok(redirected.stdout.includes(`Assistant: answer${PAYLOAD}`), 'output redirected to a file is unchanged');

    const json = await runCli(['history', 'show', '-f', 'json'], { home });
    assertClean(json.stdout.replace(/\n/g, ''), 'history show -f json');
    assert.equal(JSON.parse(json.stdout).messages[1].content, `answer${PAYLOAD}`);

    const exported = await runCli(['history', 'export', 'export.json'], { home });
    assert.equal(exported.status, 0, exported.stderr);
    const exportedJson = readFileSync(join(home, 'export.json'), 'utf8');
    assertClean(exportedJson, 'history export');
    assert.equal(JSON.parse(exportedJson)[0].messages[1].content, `answer${PAYLOAD}`);
  });
});

test('models output strips control sequences, and JSON escapes them', async () => {
  const models = [{
    id: `model${PAYLOAD}`,
    type: 'text',
    model_spec: { description: `description ${PAYLOAD} end` },
  }];
  await withApi({ 'GET /models': ok({ data: models }) }, (baseUrl) => withHome(async (home) => {
    const pretty = await runCli(['models'], { home, baseUrl });
    assert.equal(pretty.status, 0, pretty.stderr);
    assertClean(pretty.stdout, 'models');
    assert.match(pretty.stdout, /modellink textsafetxt\.exe/);
    assert.match(pretty.stdout, /description link textsafetxt\.exe end/);

    const json = await runCli(['models', '-f', 'json'], { home, baseUrl });
    assert.equal(json.status, 0, json.stderr);
    assertClean(json.stdout.replace(/\n/g, ''), 'models -f json');
    assert.equal(JSON.parse(json.stdout)[0].id, models[0].id);
  }));
});

test('API error text is sanitised unless stderr is a regular file', async () => {
  const error = () => ({ status: 400, json: { error: { message: `bad request ${PAYLOAD}` } } });
  await withApi({ 'GET /models': error }, (baseUrl) => withHome(async (home) => {
    const piped = await runCli(['models'], { home, baseUrl });
    assert.equal(piped.status, 1);
    assert.equal(piped.stderr, 'Error: bad request link textsafetxt.exe\n');

    const redirected = await runCli(['models'], { home, baseUrl, toFiles: true });
    assert.equal(redirected.status, 1);
    assert.equal(redirected.stderr, `Error: bad request ${PAYLOAD}\n`);
  }));
});

test('search, scrape, parse and transcribe strip control sequences unless redirected to a file', async () => {
  const routes: Routes = {
    'POST /augment/search': ok({
      query: 'q',
      results: [{ title: `title${PAYLOAD}`, url: `https://example.com/${PAYLOAD}`, content: `content${PAYLOAD}`, date: `date${PAYLOAD}` }],
    }),
    'POST /augment/scrape': ok({ url: 'https://example.com/', content: `page${PAYLOAD}`, format: 'markdown' }),
    'POST /augment/text-parser': ok({ text: `parsed${PAYLOAD}`, tokens: `7${PAYLOAD}` }),
    'POST /audio/transcriptions': ok({
      text: `said${PAYLOAD}`,
      duration: 1,
      timestamps: { segment: [{ text: `segment${PAYLOAD}`, start: 0, end: 1 }] },
    }),
    'POST /chat/completions': ok({
      choices: [{ message: { content: `synthesis${PAYLOAD}` }, finish_reason: 'stop' }],
    }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    writeFileSync(join(home, 'doc.txt'), 'document');
    writeFileSync(join(home, 'clip.wav'), 'RIFF....WAVE');

    const runs: Array<[string[], RegExp]> = [
      [['search', '--raw', '-f', 'pretty', 'q'], /titlelink textsafetxt\.exe[\s\S]*contentlink textsafetxt\.exe/],
      [['search', 'q'], /synthesislink textsafetxt\.exe/],
      [['scrape', 'https://example.com/'], /pagelink textsafetxt\.exe/],
      [['parse', 'doc.txt', '-f', 'pretty'], /parsedlink textsafetxt\.exe[\s\S]*Tokens: 7link textsafetxt\.exe/],
      [['transcribe', 'clip.wav', '-f', 'pretty', '--timestamps'], /saidlink textsafetxt\.exe[\s\S]*segmentlink textsafetxt\.exe/],
    ];
    for (const [args, expected] of runs) {
      const result = await runCli(args, { home, baseUrl });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assertClean(result.stdout, args.join(' '));
      assert.match(result.stdout, expected, args.join(' '));
    }

    const redirected = await runCli(['scrape', 'https://example.com/'], { home, baseUrl, toFiles: true });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.equal(redirected.stdout, `page${PAYLOAD}\n`);
  }));
});

test(
  'parse and scrape -o strip control sequences unless the destination is a regular file',
  { skip: process.platform === 'win32' },
  async () => {
    const routes: Routes = {
      'POST /augment/scrape': ok({ url: 'https://example.com/', content: `page${PAYLOAD}`, format: 'markdown' }),
      'POST /augment/text-parser': ok({ text: `parsed${PAYLOAD}`, tokens: 7 }),
    };
    await withApi(routes, (baseUrl) => withHome(async (home) => {
      writeFileSync(join(home, 'doc.txt'), 'document');

      for (const [args, text] of [[['parse', 'doc.txt'], 'parsed'], [['scrape', 'https://example.com/'], 'page']] as const) {
        for (const script of ['"$@" -o /dev/stdout | cat', '"$@" -o >(cat)']) {
          const label = `${args[0]}: ${script}`;
          const piped = await runCli([...args], { home, baseUrl, bash: script });
          assert.equal(piped.status, 0, `${label}: ${piped.stderr}`);
          assertClean(piped.stdout, label);
          assert.ok(piped.stdout.includes(`${text}link textsafetxt.exe`), `${label}: ${JSON.stringify(piped.stdout)}`);
        }

        const redirected = await runCli([...args, '-o', '/dev/stdout'], { home, baseUrl, toFiles: true });
        assert.equal(redirected.status, 0, redirected.stderr);
        assert.ok(redirected.stdout.startsWith(`${text}${PAYLOAD}`), JSON.stringify(redirected.stdout));

        const saved = await runCli([...args, '-o', 'out.txt'], { home, baseUrl });
        assert.equal(saved.status, 0, saved.stderr);
        assert.equal(readFileSync(join(home, 'out.txt'), 'utf8'), `${text}${PAYLOAD}`);
      }
    }));
  }
);

test('voices and characters show strip control sequences from catalog fields unless redirected to a file', async () => {
  const routes: Routes = {
    'GET /models': ok({
      data: [{
        id: `tts-model${PAYLOAD}`,
        type: 'tts',
        model_spec: {
          voices: [`voice${PAYLOAD}`],
          default_voice: 'other',
          voice_cloning: { mode: 'zero_shot', accepted_formats: [], min_sample_seconds: 1, retention_days: `30${PAYLOAD}` },
        },
      }],
    }),
    'GET /characters/sample': ok({
      data: {
        slug: 'sample',
        name: `name${PAYLOAD}`,
        description: `description${PAYLOAD}`,
        tags: [`tag${PAYLOAD}`],
        modelId: `model${PAYLOAD}`,
        featured: false,
        adult: false,
        shareUrl: `https://example.com/${PAYLOAD}`,
        stats: { averageRating: `4.9${PAYLOAD}`, ratingCount: `3${PAYLOAD}` },
      },
    }),
    'GET /characters/sample/reviews': ok({
      object: 'list',
      data: [{ username: `user${PAYLOAD}`, message: `message${PAYLOAD}`, rating: 5 }],
      pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 },
      summary: { averageRating: `5${PAYLOAD}`, totalReviews: `1${PAYLOAD}` },
    }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const voices = await runCli(['voices'], { home, baseUrl });
    assert.equal(voices.status, 0, voices.stderr);
    assertClean(voices.stdout, 'voices');
    assert.match(voices.stdout, /tts-modellink textsafetxt\.exe · cloning \(30link textsafetxt\.exe-day handles\)/);
    assert.match(voices.stdout, /voicelink textsafetxt\.exe/);

    const character = await runCli(['characters', 'show', 'sample'], { home, baseUrl });
    assert.equal(character.status, 0, character.stderr);
    assertClean(character.stdout, 'characters show');
    assert.match(character.stdout, /Rating: 4\.9link textsafetxt\.exe \(3link textsafetxt\.exe ratings\)/);
    assert.match(character.stdout, /Average 5link textsafetxt\.exe · 1link textsafetxt\.exe review/);
    assert.match(character.stdout, /userlink textsafetxt\.exe/);

    const redirected = await runCli(['characters', 'show', 'sample'], { home, baseUrl, toFiles: true });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.ok(redirected.stdout.includes(`name${PAYLOAD}`), 'output redirected to a file is unchanged');
  }));
});

test('non-streaming chat output is sanitised unless redirected to a file', async () => {
  const routes: Routes = {
    'GET /models': ok({ data: [{ id: 'test-model', type: 'text' }] }),
    'POST /chat/completions': ok({
      choices: [{ message: { content: `reply${PAYLOAD}` }, finish_reason: 'stop' }],
    }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const piped = await runCli(['chat', '-m', 'test-model', 'hi'], { home, baseUrl });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(piped.stdout, 'replylink textsafetxt.exe\n');

    const redirected = await runCli(['chat', '-m', 'test-model', 'hi'], { home, baseUrl, toFiles: true });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.equal(redirected.stdout, `reply${PAYLOAD}\n`);

    const json = await runCli(['chat', '-m', 'test-model', '-f', 'json', 'hi'], { home, baseUrl });
    assert.equal(json.status, 0, json.stderr);
    assertClean(json.stdout.replace(/\n/g, ''), 'chat -f json');
    assert.deepEqual(JSON.parse(json.stdout), { content: `reply${PAYLOAD}` });
  }));
});

test('tee output strips control sequences from server fields, and JSON escapes them', async () => {
  const attestation = {
    model: `model${PAYLOAD}`,
    tee_provider: `provider${PAYLOAD}`,
    verified: false,
    signing_address: `address${PAYLOAD}`,
    nvidia_payload: JSON.stringify({ arch: `arch${PAYLOAD}`, evidence_list: [] }),
    server_verification: {
      tdx: { valid: false, error: `tdx error ${PAYLOAD}` },
      nvidia: { valid: false, error: `gpu error ${PAYLOAD}` },
      verifiedAt: `time${PAYLOAD}`,
      verificationDurationMs: `duration${PAYLOAD}`,
    },
  };
  const signature = {
    model: `model${PAYLOAD}`,
    request_id: 'cmpl-1',
    tee_provider: `provider${PAYLOAD}`,
    tee_hardware: `hardware${PAYLOAD}`,
    signing_address: `address${PAYLOAD}`,
    text: `signed${PAYLOAD}`,
    signature: `0x${'ab'.repeat(65)}`,
    payload: { request_hash: `request${PAYLOAD}`, response_hash: `response${PAYLOAD}`, timestamp: `time${PAYLOAD}` },
  };
  const routes: Routes = {
    'GET /tee/attestation': ok(attestation),
    'GET /tee/signature': ok(signature),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const cases: Array<[string[], number]> = [
      [['tee', 'attestation', 'tee-model', '--verbose'], 0],
      [['tee', 'verify', 'tee-model'], 1],
      [['tee', 'signature', 'tee-model', 'cmpl-1'], 0],
    ];
    for (const [args, status] of cases) {
      const label = args.join(' ');
      const output = await runCli(args, { home, baseUrl });
      assert.equal(output.status, status, `${label}: ${output.stderr}`);
      assertClean(output.stdout, label);
      assert.match(output.stdout, /link textsafetxt\.exe/, label);

      const json = await runCli([...args, '-f', 'json'], { home, baseUrl });
      assert.equal(json.status, status, `${label} -f json: ${json.stderr}`);
      assertClean(json.stdout.replace(/\n/g, ''), `${label} -f json`);
      JSON.parse(json.stdout);
    }
  }));
});

test('video, music and image style output strips control sequences, and JSON escapes them', async () => {
  const routes: Routes = {
    'POST /video/retrieve': ok({
      status: `queued${PAYLOAD}`,
      video_url: `https://media.example/v.mp4${PAYLOAD}`,
      error: `video error ${PAYLOAD}`,
    }),
    'POST /audio/retrieve': ok({ status: `queued${PAYLOAD}`, error: `audio error ${PAYLOAD}` }),
    'GET /models': ok({
      data: [{ id: `model${PAYLOAD}`, type: 'music', model_spec: { description: `description${PAYLOAD}` } }],
    }),
    'GET /image/styles': ok({ data: [`style${PAYLOAD}`] }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const commands = [
      ['video', 'status', 'q1', '-m', 'm1'],
      ['video', 'models'],
      ['music', 'status', 'mq1'],
      ['music', 'models'],
      ['image-styles'],
    ];
    for (const args of commands) {
      const label = args.join(' ');
      const pretty = await runCli([...args, '-f', 'pretty'], { home, baseUrl });
      assert.equal(pretty.status, 0, `${label}: ${pretty.stderr}`);
      assertClean(pretty.stdout, label);
      assertClean(pretty.stderr, `${label} (stderr)`);
      assert.match(pretty.stdout, /link textsafetxt\.exe/, label);

      const json = await runCli([...args, '-f', 'json'], { home, baseUrl });
      assert.equal(json.status, 0, `${label} -f json: ${json.stderr}`);
      assertClean(json.stdout.replace(/\n/g, ''), `${label} -f json`);
      JSON.parse(json.stdout);
    }
  }));
});

test('billing and keys output strips control sequences, and JSON escapes them', async () => {
  const routes: Routes = {
    'GET /billing/balance': ok({
      canConsume: true,
      consumptionCurrency: `USD${PAYLOAD}`,
      balances: { usd: `12.5${PAYLOAD}`, diem: null },
      diemEpochAllocation: `7${PAYLOAD}`,
    }),
    'GET /billing/usage-history': ok({
      data: [{
        amount: `1${PAYLOAD}`,
        currency: 'USD',
        inferenceDetails: null,
        notes: '',
        pricePerUnitUsd: 0,
        sku: `sku${PAYLOAD}`,
        timestamp: '2026-11-01T00:00:00Z',
        units: `2${PAYLOAD}`,
      }],
      nextCursor: null,
    }),
    'GET /api_keys/rate_limits': ok({
      data: {
        accessPermitted: true,
        apiTier: { id: `tier${PAYLOAD}`, isCharged: false },
        balances: { USD: 1.5 },
        keyExpiration: `expiry${PAYLOAD}`,
        nextEpochBegins: `epoch${PAYLOAD}`,
        rateLimits: [{ apiModelId: `model${PAYLOAD}`, rateLimits: [{ type: 'RPM', amount: 10 }] }],
      },
    }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const runs: Array<[string[], RegExp]> = [
      [['billing', 'balance'], /USD: 12\.5link textsafetxt\.exe[\s\S]*DIEM epoch allocation: 7link textsafetxt\.exe/],
      [['billing', 'usage'], /skulink textsafetxt\.exe/],
      [['keys', 'rate-limits'], /Tier: tierlink textsafetxt\.exe[\s\S]*Next epoch: epochlink textsafetxt\.exe/],
    ];
    for (const [args, expected] of runs) {
      const label = args.join(' ');
      const pretty = await runCli([...args, '-f', 'pretty'], { home, baseUrl });
      assert.equal(pretty.status, 0, `${label}: ${pretty.stderr}`);
      assertClean(pretty.stdout, label);
      assert.match(pretty.stdout, expected, label);

      const json = await runCli([...args, '-f', 'json'], { home, baseUrl });
      assert.equal(json.status, 0, `${label} -f json: ${json.stderr}`);
      assertClean(json.stdout.replace(/\n/g, ''), `${label} -f json`);
      JSON.parse(json.stdout);
    }

    const redirected = await runCli(['billing', 'balance', '-f', 'pretty'], { home, baseUrl, toFiles: true });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.ok(redirected.stdout.includes(`USD: 12.5${PAYLOAD}`), 'output redirected to a file is unchanged');
  }));
});

test('rpc output strips control sequences, and response JSON is escaped unless redirected to a file', async () => {
  const response = { jsonrpc: '2.0', id: 1, result: `value${PAYLOAD}` };
  const routes: Routes = {
    'POST /crypto/rpc/test-net': () => ({ json: response, headers: { 'x-venice-rpc-credits': '1\u009b2J' } }),
    'GET /crypto/rpc/networks': ok({ networks: [`net${PAYLOAD}`] }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const pretty = await runCli(['rpc', 'test-net', 'eth_test', '-f', 'pretty'], { home, baseUrl });
    assert.equal(pretty.status, 0, pretty.stderr);
    assertClean(pretty.stdout, 'rpc -f pretty');
    assert.match(pretty.stdout, /valuelink textsafetxt\.exe/);
    assert.match(pretty.stdout, /Credits: 1\n/);

    const piped = await runCli(['rpc', 'test-net', 'eth_test', '-f', 'json'], { home, baseUrl });
    assert.equal(piped.status, 0, piped.stderr);
    assertClean(piped.stdout.replace(/\n/g, ''), 'rpc -f json');
    assert.deepEqual(JSON.parse(piped.stdout), response);

    const redirected = await runCli(['rpc', 'test-net', 'eth_test', '-f', 'json'], { home, baseUrl, toFiles: true });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.equal(redirected.stdout, `${JSON.stringify(response)}\n`);

    for (const format of ['raw', 'pretty']) {
      const networks = await runCli(['rpc', 'networks', '-f', format], { home, baseUrl });
      assert.equal(networks.status, 0, networks.stderr);
      assertClean(networks.stdout, `rpc networks -f ${format}`);
      assert.match(networks.stdout, /netlink textsafetxt\.exe/);
    }
  }));
});
