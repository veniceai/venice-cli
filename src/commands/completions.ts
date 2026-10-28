/**
 * Completions Command - Generate shell completion scripts
 */

import { Argument, Command, Option } from 'commander';
import { getChalk } from '../lib/output.js';

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions')
    .description('Generate shell completion script (bash|zsh|fish)')
    .argument('<shell>', 'Shell to generate the script for (bash|zsh|fish)')
    .action((shell: string) => {
      switch (shell.toLowerCase()) {
        case 'bash':
          console.log(generateBashCompletion(program));
          printHint('# Add to ~/.bashrc:', '# eval "$(venice completions bash)"');
          break;

        case 'zsh':
          console.log(generateZshCompletion(program));
          printHint(
            '# Add to ~/.zshrc after compinit:',
            '# eval "$(venice completions zsh)"',
            '# Or save it as _venice in a directory on $fpath before compinit runs.'
          );
          break;

        case 'fish':
          console.log(generateFishCompletion(program));
          printHint('# Save to ~/.config/fish/completions/venice.fish');
          break;

        default:
          console.error(`Unknown shell: ${shell}`);
          console.error('Supported shells: bash, zsh, fish');
          process.exit(1);
      }
    });
}

// Shells print stderr from eval "$(venice completions ...)" at every start, so only hint on a terminal.
function printHint(...lines: string[]): void {
  if (!process.stdout.isTTY) return;
  const c = getChalk();
  console.error('');
  for (const line of lines) {
    console.error(c.dim(line));
  }
}

interface CompletionOption {
  flags: string[];
  description: string;
  takesValue: boolean;
  optionalValue: boolean;
  valueName: string;
  choices: string[];
  files: boolean;
  repeatable: boolean;
  excludes: string[];
}

interface CompletionArgument {
  name: string;
  required: boolean;
  variadic: boolean;
  choices: string[];
  files: boolean;
}

interface CompletionCommand {
  path: string[];
  names: string[];
  description: string;
  options: CompletionOption[];
  args: CompletionArgument[];
  subcommands: CompletionCommand[];
}

// Names, flags and values are written into the scripts without shell escaping.
const WORD = /^[A-Za-z0-9][\w.+-]*$/;
const FLAG = /^--?[A-Za-z0-9][\w-]*$/;
const FILE_VALUES = new Set(['audio', 'document', 'file', 'image', 'images', 'path', 'source']);

function describeCommand(command: Command, path: string[]): CompletionCommand {
  const help = command.createHelp();
  const options = help.visibleOptions(command);
  const subcommands = help.visibleCommands(command).filter((sub) => WORD.test(sub.name()));
  const siblingNames = subcommands
    .filter((sub) => command.commands.includes(sub))
    .flatMap(commandNames);

  return {
    path,
    names: commandNames(command),
    description: cleanText(command.description()),
    options: options
      .map((option) => describeOption(option, options))
      .filter((option) => option.flags.length > 0),
    args: command.registeredArguments.map(describeArgument),
    subcommands: subcommands.map((sub) => {
      const described = describeCommand(sub, [...path, sub.name()]);
      // commander's implicit help command takes the name of a sibling command.
      if (!command.commands.includes(sub) && described.args.length > 0) {
        described.args[0].choices = siblingNames;
      }
      return described;
    }),
  };
}

function describeOption(option: Option, all: readonly Option[]): CompletionOption {
  const takesValue = option.required || option.optional;
  const valueName = /[<[]([^>\]]+?)(?:\.\.\.)?[>\]]/.exec(option.flags)?.[1] ?? 'value';
  const repeatable = option.variadic || Array.isArray(option.defaultValue);
  return {
    flags: optionFlags(option),
    description: cleanText(option.description),
    takesValue,
    optionalValue: option.optional,
    valueName,
    choices: takesValue ? safeWords(option.argChoices ?? choicesIn(option.description)) : [],
    files: takesValue && FILE_VALUES.has(valueName),
    repeatable,
    excludes: repeatable
      ? []
      : all
        .filter((other) => other.attributeName() === option.attributeName())
        .flatMap(optionFlags),
  };
}

function describeArgument(argument: Argument): CompletionArgument {
  return {
    name: argument.name(),
    required: argument.required,
    variadic: argument.variadic,
    choices: safeWords(argument.argChoices ?? choicesIn(argument.description)),
    files: FILE_VALUES.has(argument.name()),
  };
}

function commandNames(command: Command): string[] {
  return [command.name(), ...command.aliases()].filter((name) => WORD.test(name));
}

function optionFlags(option: Option): string[] {
  return [option.short, option.long].filter(
    (flag): flag is string => typeof flag === 'string' && FLAG.test(flag)
  );
}

// Descriptions such as "Output format (pretty|json)" list the accepted values.
function choicesIn(description: string): string[] {
  return /\(([^()|]+(?:\|[^()|]+)+)\)/.exec(description)?.[1].split('|') ?? [];
}

function safeWords(words: readonly string[]): string[] {
  return words.every((word) => WORD.test(word)) ? [...words] : [];
}

function cleanText(text: string): string {
  return text
    .split('\n')[0]
    .replace(/\u001b\[[\d;]*m/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
}

function allCommands(command: CompletionCommand): CompletionCommand[] {
  return [command, ...command.subcommands.flatMap(allCommands)];
}

function identifier(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, '_');
}

// Words offered for the positional argument at a zero-based index (or from it onwards).
function positionalWords(command: CompletionCommand): Array<{ index: number; orLater: boolean; words: string[] }> {
  const positions = command.args
    .map((arg, index) => ({ index, orLater: arg.variadic, words: arg.choices }))
    .filter((position) => position.words.length > 0);
  if (command.subcommands.length > 0) {
    positions.unshift({ index: 0, orLater: false, words: command.subcommands.flatMap((sub) => sub.names) });
  }
  return positions;
}

function argumentTest(arg: CompletionArgument): string {
  return arg.variadic ? 'args_from' : 'arg';
}

export function generateBashCompletion(program: Command): string {
  const root = describeCommand(program, []);
  const commands = allCommands(root);
  const name = program.name();
  const functionName = `_${identifier(name)}_completion`;
  const label = (command: CompletionCommand, word?: string) =>
    `"${[name, ...command.path, ...(word === undefined ? [] : [word])].join(' ')}"`;
  const patterns = (command: CompletionCommand, words: string[]) =>
    words.map((word) => label(command, word)).join('|');

  const valueOptions = commands.flatMap((command) => {
    const flags = command.options.filter((option) => option.takesValue).flatMap((option) => option.flags);
    return flags.length > 0 ? [`                    ${patterns(command, flags)}) option="$word" ;;`] : [];
  });
  const subcommands = commands.flatMap((command) => command.subcommands.map((sub) =>
    `                        ${patterns(command, sub.names)}) path=${label(sub)}; continue ;;`
  ));
  const optionValues = commands.flatMap((command) => command.options
    .filter((option) => option.choices.length > 0)
    .map((option) =>
      `            ${patterns(command, option.flags)}) candidates="${option.choices.join(' ')}" ;;`
    ));
  const optionNames = commands.flatMap((command) => {
    const flags = command.options.flatMap((option) => option.flags);
    return flags.length > 0 ? [`            ${label(command)}) candidates="${flags.join(' ')}" ;;`] : [];
  });
  const positionals = commands.flatMap((command) => {
    const tests = positionalWords(command).map(({ index, orLater, words }) =>
      `((args ${orLater ? '>=' : '=='} ${index})) && candidates+=" ${words.join(' ')}"`
    );
    return tests.length > 0 ? [`            ${label(command)}) ${tests.join('; ')} ;;`] : [];
  });

  return [
    `# bash completion for ${name} (generated by "${name} completions bash")`,
    `${functionName}() {`,
    `    local cur="\${COMP_WORDS[COMP_CWORD]}" path="${name}" option="" candidates="" word i`,
    '    local -i args=0',
    '    [[ "$cur" == "=" ]] && cur=""',
    '    COMPREPLY=()',
    '',
    '    for ((i = 1; i < COMP_CWORD; i++)); do',
    '        word="${COMP_WORDS[i]}"',
    '        if [[ -n "$option" ]]; then',
    '            [[ "$word" == "=" ]] || option=""',
    '            continue',
    '        fi',
    '        case "$word" in',
    '            -*)',
    '                case "$path $word" in',
    ...valueOptions,
    '                esac',
    '                ;;',
    '            *)',
    '                if ((args == 0)); then',
    '                    case "$path $word" in',
    ...subcommands,
    '                    esac',
    '                fi',
    '                args+=1',
    '                ;;',
    '        esac',
    '    done',
    '',
    '    if [[ -n "$option" ]]; then',
    '        case "$path $option" in',
    ...optionValues,
    '        esac',
    '    elif [[ "$cur" == -* ]]; then',
    '        case "$path" in',
    ...optionNames,
    '        esac',
    '    else',
    '        case "$path" in',
    ...positionals,
    '        esac',
    '    fi',
    '    COMPREPLY=($(compgen -W "$candidates" -- "$cur"))',
    '}',
    '',
    `complete -o default -F ${functionName} ${name}`,
  ].join('\n');
}

export function generateZshCompletion(program: Command): string {
  const root = describeCommand(program, []);
  const name = program.name();
  const functions = new Map<CompletionCommand, string>();
  const used = new Set<string>();
  for (const command of allCommands(root)) {
    const preferred = [`_${identifier(name)}`, ...command.path.map(identifier)].join('_');
    let candidate = preferred;
    for (let suffix = 2; used.has(candidate); suffix++) candidate = `${preferred}_${suffix}`;
    used.add(candidate);
    functions.set(command, candidate);
  }
  const rootFunction = functions.get(root) as string;

  const lines = [
    `#compdef ${name}`,
    `# zsh completion for ${name} (generated by "${name} completions zsh")`,
  ];
  for (const command of allCommands(root)) {
    lines.push('', ...zshFunction(command, name, functions));
  }
  lines.push(
    '',
    '# Autoloaded from $fpath: complete now. Sourced or evaluated: register once compinit has run.',
    `if [[ "\${funcstack[1]}" == ${rootFunction} ]]; then`,
    `  ${rootFunction} "$@"`,
    'elif (( $+functions[compdef] )); then',
    `  compdef ${rootFunction} ${name}`,
    'fi'
  );
  return lines.join('\n');
}

function zshFunction(
  command: CompletionCommand,
  programName: string,
  functions: Map<CompletionCommand, string>
): string[] {
  const functionName = functions.get(command) as string;
  const optionSpecs = command.options.flatMap(zshOptionSpecs);
  const continued = (specs: string[], indent: string) =>
    specs.map((spec) => ` \\\n${indent}${spec}`).join('');

  if (command.subcommands.length === 0) {
    const specs = [...optionSpecs, ...zshArgumentSpecs(command.args)];
    return [`${functionName}() {`, `  _arguments -s -S${continued(specs, '    ')}`, '}'];
  }

  const label = [programName, ...command.path].join(' ');
  const firstArgument = command.args[0];
  const entries = [
    ...command.subcommands.flatMap((sub) => sub.names.map((subName) => `${subName}:${sub.description}`)),
    ...(firstArgument?.choices ?? []).map((choice) => `${choice}:${firstArgument.name}`),
  ];
  const dispatch = command.subcommands.map((sub) =>
    `        ${sub.names.join('|')}) ${functions.get(sub)} && ret=0 ;;`
  );
  if (firstArgument) {
    const rest = zshArgumentSpecs(command.args.slice(1));
    if (firstArgument.variadic) rest.push(zshQuote(`*:${firstArgument.name}:${zshAction(firstArgument)}`));
    dispatch.push(`        *) _arguments -s -S${continued([...optionSpecs, ...rest], '             ')} && ret=0 ;;`);
  }

  return [
    `${functionName}() {`,
    '  local curcontext="$curcontext" state state_descr line ret=1',
    '  typeset -A opt_args',
    '',
    `  _arguments -C${continued([...optionSpecs, "'1: :->command'", "'*:: :->argument'"], '    ')} && ret=0`,
    '',
    '  case $state in',
    '    command)',
    '      local -a subcommands=(',
    ...entries.map((entry) => `        ${zshQuote(entry)}`),
    '      )',
    `      _describe -t commands ${zshQuote(`${label} command`)} subcommands && ret=0`,
    '      ;;',
    '    argument)',
    `      curcontext="\${curcontext%:*:*}:${[programName, ...command.path].join('-')}-$words[1]:"`,
    '      case $words[1] in',
    ...dispatch,
    '      esac',
    '      ;;',
    '  esac',
    '  return ret',
    '}',
  ];
}

function zshOptionSpecs(option: CompletionOption): string[] {
  const exclusions = option.repeatable
    ? '*'
    : option.excludes.length > 1 ? `(${option.excludes.join(' ')})` : '';
  const description = option.description
    ? `[${option.description.replace(/[\\[\]]/g, '\\$&')}]`
    : '';
  const value = option.takesValue
    ? `${option.optionalValue ? '::' : ':'}${option.valueName}:${zshAction(option)}`
    : '';
  return option.flags.map((flag) => {
    const attached = !option.takesValue ? '' : flag.startsWith('--') ? '=' : '+';
    return zshQuote(`${exclusions}${flag}${attached}${description}${value}`);
  });
}

function zshArgumentSpecs(args: CompletionArgument[]): string[] {
  return args.map((arg, index) => {
    const position = arg.variadic ? '*' : String(index + 1);
    const optional = !arg.variadic && !arg.required ? ':' : '';
    return zshQuote(`${position}:${optional}${arg.name}:${zshAction(arg)}`);
  });
}

function zshAction(value: { choices: string[]; files: boolean }): string {
  if (value.choices.length > 0) return `(${value.choices.join(' ')})`;
  return value.files ? '_files' : ' ';
}

function zshQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function generateFishCompletion(program: Command): string {
  const root = describeCommand(program, []);
  const commands = allCommands(root);
  const name = program.name();
  const prefix = `__${identifier(name)}`;
  const label = (command: CompletionCommand) => [name, ...command.path].join(' ');
  const condition = (test: string, command: CompletionCommand, position?: number) =>
    fishQuote(`${prefix}_${test} "${label(command)}"${position === undefined ? '' : ` ${position}`}`);
  const patterns = (command: CompletionCommand, words: string[]) =>
    words.map((word) => fishQuote(`${label(command)} ${word}`)).join(' ');

  const valueOptions = commands.flatMap((command) => {
    const flags = command.options.filter((option) => option.takesValue).flatMap((option) => option.flags);
    return flags.length > 0
      ? [`                    case ${patterns(command, flags)}`, '                        set expect_value 1']
      : [];
  });
  const subcommands = commands.flatMap((command) => command.subcommands.flatMap((sub) => [
    `                case ${patterns(command, sub.names)}`,
    `                    set -g ${prefix}_path ${fishQuote(label(sub))}`,
    '                    continue',
  ]));

  const entries: string[] = [];
  for (const command of commands) {
    entries.push('', `# ${label(command)}`);
    for (const sub of command.subcommands) {
      const description = sub.description ? ` -d ${fishQuote(sub.description)}` : '';
      for (const subName of sub.names) {
        entries.push(`complete -c ${name} -n ${condition('arg', command, 1)} -a ${subName}${description}`);
      }
    }
    for (const option of command.options) {
      entries.push(`complete -c ${name} -n ${condition('is', command)} ${fishOption(option)}`);
    }
    command.args.forEach((arg, index) => {
      const position = condition(argumentTest(arg), command, index + 1);
      if (arg.choices.length > 0) {
        entries.push(`complete -c ${name} -n ${position} -a ${fishQuote(arg.choices.join(' '))}`);
      } else if (arg.files) {
        entries.push(`complete -c ${name} -n ${position} -F`);
      }
    });
  }

  return [
    `# fish completion for ${name} (generated by "${name} completions fish")`,
    '',
    `function ${prefix}_scan`,
    '    set -l line (commandline -pc)',
    `    test "$line" = "$${prefix}_scanned"; and return`,
    `    set -g ${prefix}_scanned $line`,
    `    set -g ${prefix}_path ${fishQuote(name)}`,
    `    set -g ${prefix}_args 0`,
    '    set -l expect_value 0',
    '    set -l tokens (commandline -opc)',
    '    set -e tokens[1]',
    '    for word in $tokens',
    '        if test $expect_value -eq 1',
    '            set expect_value 0',
    '            continue',
    '        end',
    '        switch $word',
    "            case '-*'",
    `                switch "$${prefix}_path $word"`,
    ...valueOptions,
    '                end',
    '                continue',
    '        end',
    `        if test $${prefix}_args -eq 0`,
    `            switch "$${prefix}_path $word"`,
    ...subcommands,
    '            end',
    '        end',
    `        set -g ${prefix}_args (math $${prefix}_args + 1)`,
    '    end',
    'end',
    '',
    `function ${prefix}_is --argument-names command_path`,
    `    ${prefix}_scan`,
    `    test "$${prefix}_path" = "$command_path"`,
    'end',
    '',
    `function ${prefix}_arg --argument-names command_path position`,
    `    ${prefix}_is "$command_path"; and test (math $${prefix}_args + 1) -eq $position`,
    'end',
    '',
    `function ${prefix}_args_from --argument-names command_path position`,
    `    ${prefix}_is "$command_path"; and test (math $${prefix}_args + 1) -ge $position`,
    'end',
    '',
    `complete -c ${name} -e`,
    `complete -c ${name} -f`,
    ...entries,
  ].join('\n');
}

function fishOption(option: CompletionOption): string {
  const parts = option.flags.map((flag) => {
    if (flag.startsWith('--')) return `-l ${flag.slice(2)}`;
    return flag.length === 2 ? `-s ${flag.slice(1)}` : `-o ${flag.slice(1)}`;
  });
  if (option.takesValue && !option.optionalValue) {
    if (option.choices.length > 0) parts.push('-x', '-a', fishQuote(option.choices.join(' ')));
    else parts.push(option.files ? '-r -F' : '-x');
  }
  if (option.description) parts.push('-d', fishQuote(option.description));
  return parts.join(' ');
}

function fishQuote(text: string): string {
  return `'${text.replace(/[\\']/g, '\\$&')}'`;
}
