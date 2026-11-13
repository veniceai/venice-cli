import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli, type FakeApi } from './test-cli.js';
import { getUserAgent, getVersion } from './version.js';

test('getUserAgent adds the skill named by VENICE_SKILL and rejects a name that is not a safe token', () => {
  const original = process.env.VENICE_SKILL;
  try {
    delete process.env.VENICE_SKILL;
    assert.equal(getUserAgent(), `veniceai-cli/${getVersion()}`);

    process.env.VENICE_SKILL = 'my-skill';
    assert.equal(getUserAgent(), `veniceai-cli/${getVersion()} skill/my-skill`);

    for (const name of ['my skill', '-skill', 'a/b', 'x'.repeat(65), 'ad\r\nX-Injected: 1']) {
      process.env.VENICE_SKILL = name;
      assert.throws(() => getUserAgent(), /VENICE_SKILL must be 1 to 64 letters, digits, dots, dashes or underscores/, name);
    }
  } finally {
    if (original === undefined) delete process.env.VENICE_SKILL;
    else process.env.VENICE_SKILL = original;
  }
});

const quoted: FakeApi = (request) => (request.path === '/video/quote' ? { quote: 1 } : undefined);

test('--skill adds skill/<name> to the User-Agent wherever it appears, and a bad name sends nothing', { timeout: 20_000 }, async () => {
  for (const args of [
    ['--skill', 'my-skill', 'video', 'quote', '-m', 'test-model'],
    ['video', 'quote', '-m', 'test-model', '--skill', 'my-skill'],
  ]) {
    const run = await runCli(args, quoted);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.requests[0]?.headers['user-agent'], `veniceai-cli/${getVersion()} skill/my-skill`, args.join(' '));
  }

  const bad = await runCli(['--skill', 'my skill', 'video', 'quote', '-m', 'test-model'], quoted);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stderr, /--skill must be 1 to 64 letters/);
  assert.equal(bad.requests.length, 0);
});
