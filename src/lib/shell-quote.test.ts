import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { INVALID_ID_HINT, apiId, isApiId, shellCommand, shellQuote } from './shell-quote.js';
import { buildGpuAttestationCurl } from './tee.js';

const SHELLS: Array<[string, string[]]> = [
  ['sh', ['-c']],
  ['bash', ['--norc', '--noprofile', '-c']],
  ['zsh', ['-f', '-c']],
  ['fish', ['--no-config', '-c']],
];

const available = SHELLS.filter(([shell]) => !spawnSync(shell, ['-c', 'exit 0']).error);

// Runs in an empty working directory; HOME is elsewhere because shells may
// write their own state there.
function runInShell(shell: string, flags: string[], command: string, dir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(shell, [...flags, command], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: join(dir, '..'), LANG: 'C.UTF-8', ...env },
    timeout: 10_000,
  });
}

function withDir(run: (dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'venice-shell-quote-'));
  const dir = join(root, 'cwd');
  mkdirSync(dir);
  try {
    run(dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TRICKY_VALUES = [
  '',
  'plain-id_1.2:3',
  'nvidia/parakeet-tdt-0.6b-v3',
  'two words',
  "it's",
  "'",
  "''",
  '\\',
  "\\'",
  "a\\'b",
  "\\'; touch marker; echo \\'",
  "x'; touch marker; echo '",
  '$(touch marker)',
  '`touch marker`',
  'q1; touch marker #',
  'a\nb',
  '*',
  '~',
  '{a,b}',
  '!!',
  '=ls',
  '%self',
  '-m',
  'naïve 日本',
  '{"nonce":"x\\"y","list":["\\u001b"]}',
];

test('shellQuote leaves plain words alone and single-quotes everything else', () => {
  assert.equal(shellQuote('wan-2.6-text-to-video'), 'wan-2.6-text-to-video');
  assert.equal(shellQuote('nvidia/parakeet-tdt-0.6b-v3'), 'nvidia/parakeet-tdt-0.6b-v3');
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('two words'), "'two words'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('a\\b'), "'a'\\\\'b'");
});

for (const [shell, flags] of SHELLS) {
  const skip = !available.some(([name]) => name === shell) && `${shell} is not installed`;
  test(`shellQuote round-trips values through ${shell}`, { skip }, () => {
    withDir((dir) => {
      for (const value of TRICKY_VALUES) {
        const result = runInShell(shell, flags, `printf '%s' ${shellQuote(value)}`, dir);
        assert.equal(result.status, 0, `${JSON.stringify(value)}: ${result.stderr}`);
        assert.equal(result.stdout, value, JSON.stringify(value));
      }
      assert.deepEqual(readdirSync(dir), []);
    });
  });
}

test('shellCommand quotes values and refuses API values that do not look like IDs', () => {
  assert.equal(
    shellCommand`venice video status ${apiId('q-1:2.3_4')} -m ${apiId('wan-2.6-text-to-video')}`,
    'venice video status q-1:2.3_4 -m wan-2.6-text-to-video'
  );
  assert.equal(shellCommand`venice video retrieve ${'my job'} -m ${'model'}`, "venice video retrieve 'my job' -m model");
  assert.equal(shellCommand`venice chat -c ${apiId('alan-watts')} "Your message"`, 'venice chat -c alan-watts "Your message"');

  for (const value of ['q1; touch marker #', '', 'a'.repeat(129), 'a/b', 'a b', '$(id)', 'ä', 42, null, undefined, {}]) {
    assert.equal(shellCommand`venice video status ${apiId(value)} -m ${apiId('model')}`, INVALID_ID_HINT, String(value));
  }
  assert.equal(isApiId('a'.repeat(128)), true);
});

for (const [shell, flags] of SHELLS) {
  const skip = !available.some(([name]) => name === shell) && `${shell} is not installed`;
  test(`the invalid-ID hint does not run anything in ${shell}`, { skip }, () => {
    withDir((dir) => {
      const result = runInShell(shell, flags, INVALID_ID_HINT, dir);
      assert.notEqual(result.status, 0);
      assert.deepEqual(readdirSync(dir), []);
    });
  });
}

for (const [shell, flags] of SHELLS) {
  const skip = !available.some(([name]) => name === shell) && `${shell} is not installed`;
  test(`the GPU attestation curl passes the evidence to curl unchanged in ${shell}`, { skip }, () => {
    withDir((dir) => {
      const bin = join(dir, '..', 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nfor arg; do printf \'%s\\0\' "$arg"; done > "$CURL_ARGS"\n');
      chmodSync(join(bin, 'curl'), 0o755);
      const argsFile = join(dir, '..', 'args');
      const payload = {
        nonce: "x'; touch marker; echo '\\'",
        evidence_list: [{ certificate: 'c\\"\'', evidence: '\u009d52;c;Zm9v\u009c', arch: 'HOPPER\u202e' }],
        arch: 'HOPPER',
      };

      const command = buildGpuAttestationCurl(payload);
      assert.doesNotMatch(command, /[\u0080-\u009f\u202a-\u202e]/);
      const result = runInShell(shell, flags, command, dir, {
        PATH: `${bin}:${process.env.PATH}`,
        CURL_ARGS: argsFile,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(dir, 'marker')), false);
      assert.deepEqual(readdirSync(dir), []);
      const args = readFileSync(argsFile, 'utf8').split('\0').slice(0, -1);
      assert.deepEqual(JSON.parse(args[args.indexOf('--data') + 1]), payload);
    });
  });
}
