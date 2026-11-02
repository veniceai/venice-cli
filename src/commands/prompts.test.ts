import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));
const commandModules = {
  chat: [new URL('./chat.js', import.meta.url).href, 'registerChatCommand'],
  config: [new URL('./config.js', import.meta.url).href, 'registerConfigCommand'],
  history: [new URL('./history.js', import.meta.url).href, 'registerHistoryCommand'],
  keys: [new URL('./keys.js', import.meta.url).href, 'registerKeysCommand'],
} as const;
const KEY = 'sk-typed-0123456789abcdef';
const API_KEY_ID = 'e28e82dc-9df2-4b47-b726-d0a222ef2ab5';

async function withHome(run: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'venice-prompts-'));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function cliEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
  delete env.VENICE_API_KEY;
  return { ...env, ...extra };
}

// Runs a command in a child whose stdin is a fake terminal, so the prompts
// take their terminal path without a real pseudo-terminal. stderr is a pipe
// unless `setup` says otherwise.
function runOnFakeTerminal(
  home: string,
  args: [keyof typeof commandModules, ...string[]],
  setup: string,
  env: NodeJS.ProcessEnv = {}
) {
  const [moduleUrl, register] = commandModules[args[0]];
  const script = `
    import { PassThrough } from 'node:stream';
    const input = new PassThrough();
    input.isTTY = true;
    const rawModes = [];
    input.setRawMode = (mode) => { rawModes.push(mode); return input; };
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    ${setup}
    const { Command } = await import('commander');
    const { ${register}: register } = await import(${JSON.stringify(moduleUrl)});
    const program = new Command();
    register(program);
    await program.parseAsync(['node', 'venice', ...${JSON.stringify(args)}]);
    process.stderr.write('raw modes: ' + JSON.stringify(rawModes) + '\\n');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: cliEnv(home, env),
    timeout: 10_000,
  });
}

// Setup that makes `stream` report itself as a terminal.
function markTerminal(stream: 'stdout' | 'stderr'): string {
  return `Object.defineProperty(process.${stream}, 'isTTY', { value: true, configurable: true });`;
}

// Setup that makes `stream` report itself as a terminal and answers `answer`
// the first time `prompt` is written to it.
function answerOnTerminal(stream: 'stdout' | 'stderr', answer: string, prompt = '[y/N] '): string {
  return `
    ${markTerminal(stream)}
    let answered = false;
    const write = process.${stream}.write.bind(process.${stream});
    process.${stream}.write = (chunk, ...rest) => {
      if (!answered && String(chunk).includes(${JSON.stringify(prompt)})) {
        answered = true;
        setTimeout(() => input.write(${JSON.stringify(answer)}), 20);
      }
      return write(chunk, ...rest);
    };
  `;
}

test('config init refuses to run without a terminal and saves nothing', () => withHome((home) => {
  const result = spawnSync(process.execPath, [cliPath, 'config', 'init'], {
    encoding: 'utf8',
    input: `${KEY}\nmodel-x\n\nn\n`,
    env: cliEnv(home),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /stdin is not a terminal/);
  assert.match(result.stderr, /venice config set api_key --stdin/);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  assert.equal(existsSync(join(home, '.venice', 'config.json')), false);
}));

test('config set api_key --stdin reads a key typed at a terminal without echo', () => withHome((home) => {
  const result = runOnFakeTerminal(
    home,
    ['config', 'set', 'api_key', '--stdin'],
    `
      ${markTerminal('stderr')}
      setTimeout(() => { input.write(${JSON.stringify(`${KEY}\r`)}); input.end(); }, 50);
    `
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /API Key \(get from https:\/\/venice\.ai\/settings\/api\): \n/);
  assert.match(result.stderr, /raw modes: \[true,false\]/);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  assert.equal(JSON.parse(readFileSync(join(home, '.venice', 'config.json'), 'utf8')).api_key, KEY);
}));

test('config init on a terminal saves its answers without echoing the key', () => withHome((home) => {
  const result = runOnFakeTerminal(home, ['config', 'init'], `
    ${markTerminal('stdout')}
    ${markTerminal('stderr')}
    const answers = [${JSON.stringify(`${KEY}\r`)}, 'model-x\\n', '\\n', 'n\\n'];
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, ...rest) => {
        if (String(chunk).endsWith(': ') && answers.length > 0) {
          const answer = answers.shift();
          setTimeout(() => input.write(answer), 20);
        }
        return write(chunk, ...rest);
      };
    }
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /raw modes: \[true,false,true,false\]/);
  assert.match(result.stdout, /Configuration complete!/);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  const config = JSON.parse(readFileSync(join(home, '.venice', 'config.json'), 'utf8'));
  assert.deepEqual(config, { api_key: KEY, default_model: 'model-x', show_usage: false });
}));

test('config init asks its questions on stderr, so they show when stdout is redirected', () => withHome((home) => {
  const result = runOnFakeTerminal(home, ['config', 'init'], `
    ${markTerminal('stderr')}
    const answers = [${JSON.stringify(`${KEY}\r`)}, 'model-x\\n', '\\n', 'n\\n'];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      if (String(chunk).endsWith(': ') && answers.length > 0) {
        const answer = answers.shift();
        setTimeout(() => input.write(answer), 20);
      }
      return write(chunk, ...rest);
    };
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Venice CLI Setup[\s\S]*API Key \(get from[\s\S]*Default chat model \[kimi-k2-5\]: /);
  assert.match(result.stderr, /Show token usage after requests\? \[Y\/n\]: /);
  assert.doesNotMatch(result.stdout, /Venice CLI Setup|API Key \(get from|Default chat model|Show token usage/);
  assert.match(result.stdout, /Configuration complete!/);
  const config = JSON.parse(readFileSync(join(home, '.venice', 'config.json'), 'utf8'));
  assert.deepEqual(config, { api_key: KEY, default_model: 'model-x', show_usage: false });
}));

test('config init and config set api_key refuse when neither stdout nor stderr is a terminal', () => withHome((home) => {
  const commands: Array<Parameters<typeof runOnFakeTerminal>[1]> = [['config', 'init'], ['config', 'set', 'api_key']];
  for (const args of commands) {
    const label = args.join(' ');
    const result = runOnFakeTerminal(home, args, '');

    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, /neither stdout nor stderr is a terminal/, label);
    assert.match(result.stderr, /--stdin/, label);
    assert.doesNotMatch(result.stderr, /API Key \(get from/, label);
  }
  assert.equal(existsSync(join(home, '.venice', 'config.json')), false);
}));

test('history clear without --yes refuses to read a confirmation from a pipe', () => withHome((home) => {
  const historyFile = join(home, '.venice', 'history.json');
  mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
  writeFileSync(historyFile, '[]');

  const refused = spawnSync(process.execPath, [cliPath, 'history', 'clear'], {
    encoding: 'utf8',
    input: 'y\n',
    env: cliEnv(home),
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /stdin is not a terminal/);
  assert.match(refused.stderr, /venice history clear --yes/);
  assert.equal(existsSync(historyFile), true);

  const cleared = spawnSync(process.execPath, [cliPath, 'history', 'clear', '--yes'], {
    encoding: 'utf8',
    env: cliEnv(home),
  });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(existsSync(historyFile), false);
}));

test('history clear asks for confirmation on stderr, so it shows when stdout is redirected', () => withHome((home) => {
  const historyFile = join(home, '.venice', 'history.json');
  mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
  writeFileSync(historyFile, '[]');

  const result = runOnFakeTerminal(home, ['history', 'clear'], answerOnTerminal('stderr', 'y\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Are you sure you want to clear all history\? \[y\/N\] /);
  assert.doesNotMatch(result.stdout, /Are you sure/);
  assert.match(result.stdout, /Conversation history cleared/);
  assert.equal(existsSync(historyFile), false);
}));

test('history clear asks for confirmation on stdout when only stdout is a terminal', () => withHome((home) => {
  const historyFile = join(home, '.venice', 'history.json');
  mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
  writeFileSync(historyFile, '[]');

  const result = runOnFakeTerminal(home, ['history', 'clear'], answerOnTerminal('stdout', 'y\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Are you sure you want to clear all history\? \[y\/N\] /);
  assert.doesNotMatch(result.stderr, /Are you sure/);
  assert.equal(existsSync(historyFile), false);
}));

test('history clear without --yes refuses when neither stdout nor stderr is a terminal', () => withHome((home) => {
  const historyFile = join(home, '.venice', 'history.json');
  mkdirSync(join(home, '.venice'), { recursive: true, mode: 0o700 });
  writeFileSync(historyFile, '[]');

  const result = runOnFakeTerminal(home, ['history', 'clear'], '');

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /neither stdout nor stderr is a terminal/);
  assert.match(result.stderr, /venice history clear --yes/);
  assert.equal(existsSync(historyFile), true);
}));

test('keys delete asks for confirmation on stderr, so it shows when stdout is redirected', () => withHome((home) => {
  const result = runOnFakeTerminal(
    home,
    ['keys', 'delete', API_KEY_ID],
    answerOnTerminal('stderr', 'no\n', 'Type "delete" to confirm: ')
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Permanently delete API key [0-9a-f-]+\? Type "delete" to confirm: /);
  assert.doesNotMatch(result.stdout, /Permanently delete/);
  assert.match(result.stdout, /Deletion cancelled\./);
}));

test('keys delete without --force refuses when neither stdout nor stderr is a terminal', () => withHome((home) => {
  const result = runOnFakeTerminal(home, ['keys', 'delete', API_KEY_ID], '');

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Refusing to delete non-interactively without --force: neither stdout nor stderr is a terminal/);
  assert.doesNotMatch(result.stderr, /Permanently delete/);
}));

test('chat --interactive-tools fails before any request when neither stdout nor stderr is a terminal', () => withHome((home) => {
  const result = runOnFakeTerminal(home, ['chat', '--tools', 'calculator', '--interactive-tools', 'what is 2+2'], '', {
    NODE_ENV: 'test',
    VENICE_API_BASE_URL: 'http://127.0.0.1:9/api/v1',
    VENICE_API_KEY: 'test-key',
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--interactive-tools asks for approval on the terminal, but neither stdout nor stderr is a terminal/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(home, '.venice', 'history.json')), false);
}));

test('chat --interactive-tools fails before any request when stdin is not a terminal', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await withHome(async (home) => {
      for (const args of [[], ['what is 2+2']]) {
        const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [cliPath, 'chat', '--tools', 'calculator', '--interactive-tools', ...args], {
            env: cliEnv(home, {
              NODE_ENV: 'test',
              VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
              VENICE_API_KEY: 'test-key',
            }),
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
          child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
          child.once('error', reject);
          child.once('close', (status) => resolve({ status, stdout, stderr }));
          child.stdin.end('what is 2+2\ny\n');
        });

        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /--interactive-tools asks for approval on the terminal/);
        assert.equal(result.stdout, '');
      }
      assert.deepEqual(requests, []);
      assert.equal(existsSync(join(home, '.venice', 'history.json')), false);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
