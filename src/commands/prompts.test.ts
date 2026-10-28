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
const configCommandUrl = new URL('./config.js', import.meta.url).href;
const KEY = 'sk-typed-0123456789abcdef';

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

// Runs the config command in a child whose stdin is a fake terminal, so the
// prompts take their terminal path without a real pseudo-terminal.
function runConfigOnFakeTerminal(home: string, args: string[], setup: string) {
  const script = `
    import { PassThrough } from 'node:stream';
    const input = new PassThrough();
    input.isTTY = true;
    const rawModes = [];
    input.setRawMode = (mode) => { rawModes.push(mode); return input; };
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    ${setup}
    const { Command } = await import('commander');
    const { registerConfigCommand } = await import(${JSON.stringify(configCommandUrl)});
    const program = new Command();
    registerConfigCommand(program);
    await program.parseAsync(['node', 'venice', ...${JSON.stringify(args)}]);
    process.stderr.write('raw modes: ' + JSON.stringify(rawModes) + '\\n');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: cliEnv(home),
    timeout: 10_000,
  });
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
  const result = runConfigOnFakeTerminal(
    home,
    ['config', 'set', 'api_key', '--stdin'],
    `setTimeout(() => { input.write(${JSON.stringify(`${KEY}\r`)}); input.end(); }, 50);`
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /API Key \(get from https:\/\/venice\.ai\/settings\/api\): \n/);
  assert.match(result.stderr, /raw modes: \[true,false\]/);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  assert.equal(JSON.parse(readFileSync(join(home, '.venice', 'config.json'), 'utf8')).api_key, KEY);
}));

test('config init on a terminal saves its answers without echoing the key', () => withHome((home) => {
  const result = runConfigOnFakeTerminal(home, ['config', 'init'], `
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
  assert.match(result.stdout, /Configuration complete!/);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  const config = JSON.parse(readFileSync(join(home, '.venice', 'config.json'), 'utf8'));
  assert.deepEqual(config, { api_key: KEY, default_model: 'model-x', show_usage: false });
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
