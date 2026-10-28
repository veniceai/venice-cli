import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAudioCommands } from './audio.js';
import { registerAugmentCommands } from './augment.js';
import { registerBillingCommand } from './billing.js';
import { registerCharactersCommand } from './characters.js';
import { registerChatCommand } from './chat.js';
import {
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
  registerCompletionsCommand,
} from './completions.js';
import { registerConfigCommand } from './config.js';
import { registerEmbeddingsCommand } from './embeddings.js';
import { registerHistoryCommand } from './history.js';
import { registerImageCommand } from './image.js';
import { registerKeysCommand } from './keys.js';
import { registerModelsCommand } from './models.js';
import { registerMusicCommands } from './music.js';
import { registerRpcCommand } from './rpc.js';
import { registerSearchCommand } from './search.js';
import { registerTeeCommand } from './tee.js';
import { registerUsageCommand } from './usage.js';
import { registerVideoCommands } from './video.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

type Shell = 'bash' | 'zsh' | 'fish';

interface TreeCommand {
  label: string;
  path: string[];
  flags: string[];
  subcommands: string[];
}

function buildProgram(): Command {
  const program = new Command()
    .name('venice')
    .version('0.0.0-test')
    .option('--no-color', 'Disable colored output');
  for (const register of [
    registerChatCommand,
    registerSearchCommand,
    registerImageCommand,
    registerAudioCommands,
    registerModelsCommand,
    registerEmbeddingsCommand,
    registerHistoryCommand,
    registerUsageCommand,
    registerConfigCommand,
    registerCharactersCommand,
    registerCompletionsCommand,
    registerVideoCommands,
    registerMusicCommands,
    registerTeeCommand,
    registerRpcCommand,
    registerBillingCommand,
    registerKeysCommand,
    registerAugmentCommands,
  ]) {
    register(program);
  }
  return program;
}

function commandTree(program: Command): TreeCommand[] {
  const commands: TreeCommand[] = [];
  const visit = (command: Command, path: string[]) => {
    const help = command.createHelp();
    const subcommands = help.visibleCommands(command);
    commands.push({
      label: ['venice', ...path].join(' '),
      path,
      flags: help.visibleOptions(command).flatMap((option) =>
        [option.short, option.long].filter((flag): flag is string => flag !== undefined)
      ),
      subcommands: subcommands.flatMap((sub) => [sub.name(), ...sub.aliases()]),
    });
    for (const sub of subcommands) {
      visit(sub, [...path, sub.name()]);
    }
  };
  visit(program, []);
  return commands;
}

const program = buildProgram();
const tree = commandTree(program);
const scripts: Record<Shell, string> = {
  bash: generateBashCompletion(program),
  zsh: generateZshCompletion(program),
  fish: generateFishCompletion(program),
};

const sorted = (words: string[]) => [...words].sort();
const words = (line: string | undefined) => (line ?? '').split(' ').filter(Boolean);
const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

function isInstalled(shell: Shell): boolean {
  const result = spawnSync(shell, ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

function skipUnlessInstalled(shell: Shell): { skip: string | false } {
  return { skip: isInstalled(shell) ? false : `${shell} is not installed` };
}

function runShell(shell: Shell, driver: string) {
  const home = mkdtempSync(join(tmpdir(), 'venice-completions-test-'));
  try {
    const scriptPath = join(home, `venice.${shell}`);
    writeFileSync(scriptPath, scripts[shell]);
    const flags = { bash: ['--norc', '--noprofile'], zsh: ['-f'], fish: ['--no-config'] }[shell];
    const result = spawnSync(shell, [...flags, '-c', driver], {
      cwd: home,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ZDOTDIR: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        TERM: 'dumb',
        COMPLETION_SCRIPT: scriptPath,
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function zshFunctionBody(path: string[]): string {
  const name = ['_venice', ...path.map((part) => part.replace(/[^A-Za-z0-9]/g, '_'))].join('_');
  const start = scripts.zsh.indexOf(`\n${name}() {\n`);
  assert.ok(start >= 0, `zsh function ${name} is missing`);
  return scripts.zsh.slice(start, scripts.zsh.indexOf('\n}\n', start));
}

function zshSpecFlags(text: string): string[] {
  return [...text.matchAll(/^'?(?:\([^)]*\)|\*)?(--?[A-Za-z0-9][\w-]*)[=+['\n]/gm)].map((match) => match[1]);
}

test('the command tree used by these tests includes the commands the old scripts missed', () => {
  const labels = tree.map((command) => command.label);
  assert.ok(labels.includes('venice tee verify'));
  const chat = tree.find((command) => command.label === 'venice chat');
  for (const flag of ['--e2ee', '--no-e2ee', '--tee-verify', '-q', '--quiet']) {
    assert.ok(chat?.flags.includes(flag), flag);
  }
  assert.ok(tree.find((command) => command.label === 'venice rpc')?.flags.includes('--idempotency-key'));
});

test('every command, subcommand and option appears in each generated script', () => {
  const bashLines = scripts.bash.split('\n').map((line) => line.trim());
  const fishLines = scripts.fish.split('\n');

  for (const command of tree) {
    const bashOptions = bashLines.find((line) => line.startsWith(`"${command.label}") candidates="`));
    assert.deepEqual(
      sorted(words(bashOptions?.split('candidates="')[1].split('"')[0])),
      sorted(command.flags),
      `bash options for ${command.label}`
    );

    const zshBody = zshFunctionBody(command.path);
    assert.deepEqual(
      sorted([...new Set(zshSpecFlags(zshBody.split('\n').map((line) => line.trim()).join('\n')))]),
      sorted(command.flags),
      `zsh options for ${command.label}`
    );

    const fishOptions = fishLines
      .filter((line) => line.includes(` -n '__venice_is "${command.label}"' `))
      .flatMap((line) => [...line.split(" -d '")[0].matchAll(/ -([sl]) ([\w-]+)/g)])
      .map(([, kind, flag]) => (kind === 's' ? `-${flag}` : `--${flag}`));
    assert.deepEqual(sorted(fishOptions), sorted(command.flags), `fish options for ${command.label}`);

    for (const sub of command.subcommands) {
      assert.ok(scripts.bash.includes(`"${command.label} ${sub}"`), `bash ${command.label} ${sub}`);
      assert.ok(zshBody.includes(`'${sub}:`), `zsh ${command.label} ${sub}`);
      assert.ok(
        fishLines.some((line) => `${line} `.includes(`-n '__venice_arg "${command.label}" 1' -a ${sub} `)),
        `fish ${command.label} ${sub}`
      );
    }
  }
});

test('bash completion offers every subcommand and option for each command', skipUnlessInstalled('bash'), () => {
  const queries = tree.flatMap((command) => [
    [...command.path, '-'],
    ...(command.subcommands.length > 0 ? [[...command.path, '']] : []),
  ]);
  const result = runShell('bash', [
    'source "$COMPLETION_SCRIPT"',
    'query() { COMP_WORDS=(venice "$@"); COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 )); COMPREPLY=(); ' +
      '_venice_completion; printf "%s\\n" "${COMPREPLY[*]}"; }',
    ...queries.map((query) => `query ${query.map(quote).join(' ')}`),
    'complete -p venice',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.split('\n');
  let index = 0;
  for (const command of tree) {
    assert.deepEqual(sorted(words(lines[index++])), sorted(command.flags), `options for ${command.label}`);
    if (command.subcommands.length > 0) {
      assert.deepEqual(sorted(words(lines[index++])), sorted(command.subcommands), `subcommands of ${command.label}`);
    }
  }
  assert.equal(lines[index], 'complete -o default -F _venice_completion venice');
});

test('bash completion completes option values and skips them when finding subcommands', skipUnlessInstalled('bash'), () => {
  const result = runShell('bash', [
    'source "$COMPLETION_SCRIPT"',
    'query() { COMP_WORDS=(venice "$@"); COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 )); COMPREPLY=(); ' +
      '_venice_completion; printf "%s\\n" "${COMPREPLY[*]}"; }',
    "query te",
    "query chat --format ''",
    'query chat --format = js',
    "query characters --limit 5 ''",
    "query video gen -m wan --f",
    "query completions ''",
    "query chat -m '$(touch pwned)' ''",
    '[[ -e pwned ]] && echo ran || echo clean',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').slice(0, 8), [
    'tee',
    'pretty json markdown raw',
    'json',
    'show',
    '--format',
    'bash zsh fish',
    '',
    'clean',
  ]);
});

test('zsh completion dispatches every command to a function with all of its options', skipUnlessInstalled('zsh'), () => {
  const result = runShell('zsh', [
    'source "$COMPLETION_SCRIPT"',
    'typeset -ga remaining',
    '_arguments() {',
    '  while [[ $1 == -[CsS] ]]; do',
    '    if [[ $1 == -C ]] && (( ${#remaining} )); then',
    '      words=("${remaining[@]}"); shift remaining; state=argument; return 1',
    '    fi',
    '    [[ $1 == -C ]] && state=command',
    '    shift',
    '  done',
    '  print -rl -- "$@"',
    '  return 1',
    '}',
    '_describe() { local entry; for entry in "${(@P)4}"; do print -r -- "subcommand ${entry%%:*}"; done }',
    'query() { print -r -- @@; remaining=("$@"); _venice }',
    ...tree.map((command) => ['query', ...command.path].join(' ')),
    'true',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const blocks = result.stdout.split('@@\n').slice(1);
  assert.equal(blocks.length, tree.length);
  tree.forEach((command, index) => {
    assert.deepEqual(sorted([...new Set(zshSpecFlags(blocks[index]))]), sorted(command.flags), `options for ${command.label}`);
    const subcommands = [...blocks[index].matchAll(/^subcommand (\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(sorted(subcommands), sorted(command.subcommands), `subcommands of ${command.label}`);
  });
});

test('zsh completion registers once compinit has run and is silent before it', skipUnlessInstalled('zsh'), () => {
  const evaluated = runShell(
    'zsh',
    'autoload -Uz compinit && compinit -u -D && eval "$(<$COMPLETION_SCRIPT)"; print -r -- "${_comps[venice]}"'
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.stderr, '');
  assert.equal(evaluated.stdout, '_venice\n');

  const beforeCompinit = runShell('zsh', 'eval "$(<$COMPLETION_SCRIPT)"; print -r -- "${+functions[_venice]}"');
  assert.equal(beforeCompinit.status, 0, beforeCompinit.stderr);
  assert.equal(beforeCompinit.stderr, '');
  assert.equal(beforeCompinit.stdout, '1\n');

  const autoloaded = runShell('zsh', [
    'mkdir -p "$HOME/zfunc" && cp "$COMPLETION_SCRIPT" "$HOME/zfunc/_venice"',
    'fpath=("$HOME/zfunc" $fpath)',
    'autoload -Uz compinit && compinit -u -D',
    'print -r -- "${_comps[venice]}"',
    '_arguments() { print -r -- completing; return 1 }',
    '_venice',
  ].join('\n'));
  assert.equal(autoloaded.status, 1, autoloaded.stderr);
  assert.equal(autoloaded.stderr, '');
  assert.equal(autoloaded.stdout, '_venice\ncompleting\n');
});

test('fish completion offers every subcommand and option for each command', skipUnlessInstalled('fish'), () => {
  const queries = tree.flatMap((command) => [
    ['venice', ...command.path, '-'].join(' '),
    ...(command.subcommands.length > 0 ? [['venice', ...command.path, ''].join(' ')] : []),
  ]);
  const result = runShell('fish', [
    'source $COMPLETION_SCRIPT',
    `for line in ${queries.map(quote).join(' ')}`,
    "    echo (complete -C $line | string replace -r '\\t.*' '')",
    'end',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.split('\n');
  let index = 0;
  for (const command of tree) {
    // fish falls back to substring matches, such as "rate-limits" for "-", when nothing has the prefix.
    const offered = words(lines[index++]).filter((word) => word.startsWith('-'));
    assert.deepEqual(sorted(offered), sorted(command.flags), `options for ${command.label}`);
    if (command.subcommands.length > 0) {
      assert.deepEqual(sorted(words(lines[index++])), sorted(command.subcommands), `subcommands of ${command.label}`);
    }
  }
});

test('fish completion completes option values and files only where they are expected', skipUnlessInstalled('fish'), () => {
  const result = runShell('fish', [
    'source $COMPLETION_SCRIPT',
    'touch clip.wav',
    "for line in 'venice chat -f ' 'venice characters --limit 5 s' 'venice transcribe ' 'venice chat ' 'venice video transcribe -'",
    "    echo (complete -C $line | string replace -r '\\t.*' '' | string match -v -r '^(config|data)/$')",
    'end',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').slice(0, 5), [
    'json markdown pretty raw',
    'show',
    'clip.wav venice.fish',
    '',
    '-f -h --format --help',
  ]);
});

test('completion scripts include commands registered after the completions command', async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (text: string) => { output.push(text); };
  try {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const later = new Command().name('venice');
      registerCompletionsCommand(later);
      later.command('update').description('Registered last').option('--channel <name>', 'Channel (stable|beta)');
      await later.parseAsync(['node', 'venice', 'completions', shell]);
    }
  } finally {
    console.log = originalLog;
  }

  const [bash, zsh, fish] = output;
  assert.ok(bash.includes('"venice update") candidates="--channel -h --help"'));
  assert.ok(bash.includes('"venice update --channel") candidates="stable beta"'));
  assert.ok(zsh.includes("'update:Registered last'"));
  assert.ok(zsh.includes("'--channel=[Channel (stable|beta)]:name:(stable beta)'"));
  assert.ok(fish.includes(`-n '__venice_arg "venice" 1' -a update -d 'Registered last'`));
  assert.ok(fish.includes(`-n '__venice_is "venice update"' -l channel -x -a 'stable beta'`));
});

test('venice completions prints only the script when its output is not a terminal', () => {
  const expected: Record<Shell, string[]> = {
    bash: ['"venice tee verify"', '--no-e2ee', '--tee-verify', '--idempotency-key'],
    zsh: ['_venice_tee_verify() {', '--no-e2ee[', '--tee-verify[', '--idempotency-key=['],
    fish: ['"venice tee verify"', '-l no-e2ee', '-l tee-verify', '-l idempotency-key'],
  };
  const home = mkdtempSync(join(tmpdir(), 'venice-completions-cli-'));
  try {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const result = spawnSync(process.execPath, [cliPath, 'completions', shell], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, NODE_ENV: 'test', NO_COLOR: '1' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '', shell);
      for (const text of expected[shell]) {
        assert.ok(result.stdout.includes(text), `${shell} script includes ${text}`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
