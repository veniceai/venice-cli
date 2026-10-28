import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      const { status = 200, json } = body as { status?: number; json: unknown };
      res.writeHead(status, { 'content-type': 'application/json' });
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

function runCli(
  args: string[],
  options: { home: string; baseUrl?: string; terminal?: boolean; cwd?: string }
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? options.home,
      env: {
        ...process.env,
        HOME: options.home,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        VENICE_API_BASE_URL: options.baseUrl ?? 'http://127.0.0.1:9/api/v1',
        VENICE_API_KEY: 'test-key',
        VENICE_TEST_TERMINAL_OUTPUT: options.terminal ? '1' : '',
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
}

const ok = (json: unknown) => () => ({ json });

function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'venice-terminal-output-'));
  return run(home).finally(() => rmSync(home, { recursive: true, force: true }));
}

function assertClean(output: string, label: string): void {
  assert.doesNotMatch(output, UNSAFE, `${label}: ${JSON.stringify(output)}`);
}

test('history output on a terminal strips control sequences stored in history.json', async () => {
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
      const result = await runCli(args, { home, terminal: true });
      assert.equal(result.status, 0, result.stderr);
      assertClean(result.stdout, args.join(' '));
      assert.match(result.stdout, /modellink textsafetxt\.exe/, args.join(' '));
    }
    const shown = await runCli(['history', 'show'], { home, terminal: true });
    assert.match(shown.stdout, /User: questionlink textsafetxt\.exe/);
    assert.match(shown.stdout, /Assistant: answerlink textsafetxt\.exe/);
    assert.match(shown.stdout, /Character: characterlink textsafetxt\.exe/);

    const piped = await runCli(['history', 'show'], { home });
    assert.equal(piped.status, 0, piped.stderr);
    assert.ok(piped.stdout.includes(`Assistant: answer${PAYLOAD}`), 'piped output is unchanged');

    const json = await runCli(['history', 'show', '-f', 'json'], { home, terminal: true });
    assertClean(json.stdout.replace(/\n/g, ''), 'history show -f json');
    assert.equal(JSON.parse(json.stdout).messages[1].content, `answer${PAYLOAD}`);
  });
});

test('models output on a terminal strips control sequences, and JSON escapes them', async () => {
  const models = [{
    id: `model${PAYLOAD}`,
    type: 'text',
    model_spec: { description: `description ${PAYLOAD} end` },
  }];
  await withApi({ 'GET /models': ok({ data: models }) }, (baseUrl) => withHome(async (home) => {
    const pretty = await runCli(['models'], { home, baseUrl, terminal: true });
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

test('API error text is sanitised only when stderr is a terminal', async () => {
  const error = () => ({ status: 400, json: { error: { message: `bad request ${PAYLOAD}` } } });
  await withApi({ 'GET /models': error }, (baseUrl) => withHome(async (home) => {
    const terminal = await runCli(['models'], { home, baseUrl, terminal: true });
    assert.equal(terminal.status, 1);
    assert.equal(terminal.stderr, 'Error: bad request link textsafetxt.exe\n');

    const piped = await runCli(['models'], { home, baseUrl });
    assert.equal(piped.status, 1);
    assert.equal(piped.stderr, `Error: bad request ${PAYLOAD}\n`);
  }));
});

test('search, scrape, parse and transcribe strip control sequences on a terminal', async () => {
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
      const result = await runCli(args, { home, baseUrl, terminal: true });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assertClean(result.stdout, args.join(' '));
      assert.match(result.stdout, expected, args.join(' '));
    }

    const saved = await runCli(['parse', 'doc.txt', '-o', 'out.txt'], { home, baseUrl, terminal: true });
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(readFileSync(join(home, 'out.txt'), 'utf8'), `parsed${PAYLOAD}`);
  }));
});

test('voices and characters show strip control sequences from catalog fields on a terminal', async () => {
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
    const voices = await runCli(['voices'], { home, baseUrl, terminal: true });
    assert.equal(voices.status, 0, voices.stderr);
    assertClean(voices.stdout, 'voices');
    assert.match(voices.stdout, /tts-modellink textsafetxt\.exe · cloning \(30link textsafetxt\.exe-day handles\)/);
    assert.match(voices.stdout, /voicelink textsafetxt\.exe/);

    const character = await runCli(['characters', 'show', 'sample'], { home, baseUrl, terminal: true });
    assert.equal(character.status, 0, character.stderr);
    assertClean(character.stdout, 'characters show');
    assert.match(character.stdout, /Rating: 4\.9link textsafetxt\.exe \(3link textsafetxt\.exe ratings\)/);
    assert.match(character.stdout, /Average 5link textsafetxt\.exe · 1link textsafetxt\.exe review/);
    assert.match(character.stdout, /userlink textsafetxt\.exe/);

    const piped = await runCli(['characters', 'show', 'sample'], { home, baseUrl });
    assert.ok(piped.stdout.includes(`name${PAYLOAD}`), 'piped output is unchanged');
  }));
});

test('non-streaming chat output is sanitised on a terminal and unchanged when piped', async () => {
  const routes: Routes = {
    'GET /models': ok({ data: [{ id: 'test-model', type: 'text' }] }),
    'POST /chat/completions': ok({
      choices: [{ message: { content: `reply${PAYLOAD}` }, finish_reason: 'stop' }],
    }),
  };
  await withApi(routes, (baseUrl) => withHome(async (home) => {
    const terminal = await runCli(['chat', '-m', 'test-model', 'hi'], { home, baseUrl, terminal: true });
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.equal(terminal.stdout, 'replylink textsafetxt.exe\n');

    const piped = await runCli(['chat', '-m', 'test-model', 'hi'], { home, baseUrl });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(piped.stdout, `reply${PAYLOAD}\n`);

    const json = await runCli(['chat', '-m', 'test-model', '-f', 'json', 'hi'], { home, baseUrl });
    assert.equal(json.status, 0, json.stderr);
    assertClean(json.stdout.replace(/\n/g, ''), 'chat -f json');
    assert.deepEqual(JSON.parse(json.stdout), { content: `reply${PAYLOAD}` });
  }));
});
