/**
 * Config Command - Manage Venice CLI configuration
 */

import { Command } from 'commander';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import {
  loadConfig,
  setConfigValue,
  deleteConfigValue,
  getConfigPath,
} from '../lib/config.js';
import { formatSuccess, formatError, getChalk } from '../lib/output.js';
import type { VeniceConfig } from '../types/index.js';

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage Venice CLI configuration')
    .action(() => {
      // Default to showing config
      const cfg = loadConfig();
      const c = getChalk();
      
      console.log(c.bold('Venice CLI Configuration\n'));
      console.log(`${c.dim('Config file:')} ${getConfigPath()}\n`);

      const keys: Array<keyof VeniceConfig> = [
        'api_key',
        'default_model',
        'default_image_model',
        'default_voice',
        'output_format',
        'no_color',
        'show_usage',
      ];

      for (const key of keys) {
        const value = cfg[key];
        const displayValue = key === 'api_key' && value
          ? maskApiKey(value as string)
          : value ?? c.dim('(not set)');
        console.log(`  ${c.cyan(key.padEnd(20))} ${displayValue}`);
      }

      console.log(`\n${c.dim('Run "venice config --help" for available subcommands')}`);
    });

  // Show all config
  config
    .command('show')
    .description('Show current configuration')
    .option('--format <format>', 'Output format (pretty|json)', 'pretty')
    .action((options) => {
      const cfg = loadConfig();
      const c = getChalk();
      
      if (options.format === 'json') {
        const maskedCfg: VeniceConfig = { ...cfg };
        if (typeof maskedCfg.api_key === 'string' && maskedCfg.api_key.length > 0) {
          maskedCfg.api_key = maskApiKey(maskedCfg.api_key);
        }
        console.log(JSON.stringify(maskedCfg, null, 2));
        return;
      }

      console.log(c.bold('Venice CLI Configuration\n'));
      console.log(`${c.dim('Config file:')} ${getConfigPath()}\n`);

      const keys: Array<keyof VeniceConfig> = [
        'api_key',
        'default_model',
        'default_image_model',
        'default_voice',
        'output_format',
        'no_color',
        'show_usage',
      ];

      for (const key of keys) {
        const value = cfg[key];
        const displayValue = key === 'api_key' && value
          ? maskApiKey(value as string)
          : value ?? c.dim('(not set)');
        console.log(`  ${c.cyan(key.padEnd(20))} ${displayValue}`);
      }

      console.log(`\n${c.dim('Tip: Use "venice config set <key> <value>" to update settings')}`);
    });

  // Set a config value
  config
    .command('set <key> [value]')
    .description('Set a configuration value')
    .option('--stdin', 'Read the API key from standard input')
    .action(async (key: string, value: string | undefined, options: { stdin?: boolean }) => {
      const validKeys: Array<keyof VeniceConfig> = [
        'api_key',
        'default_model',
        'default_image_model',
        'default_voice',
        'output_format',
        'no_color',
        'show_usage',
      ];

      if (!validKeys.includes(key as keyof VeniceConfig)) {
        console.error(formatError(
          `Invalid config key: ${key}\n\nValid keys: ${validKeys.join(', ')}`
        ));
        process.exit(1);
      }

      if (options.stdin && key !== 'api_key') {
        throw new Error('--stdin is only supported for api_key');
      }

      if (options.stdin && value !== undefined) {
        throw new Error('Do not provide a value when using --stdin');
      }

      // Fail before prompting if the existing config cannot be updated safely.
      loadConfig();

      if (key === 'api_key') {
        if (options.stdin) {
          value = await readStdin();
        } else if (value === undefined) {
          if (!process.stdin.isTTY) {
            throw new Error(
              'Interactive API key input requires a terminal. Pipe the key using --stdin instead.'
            );
          }
          value = await askHiddenQuestion(
            'API Key (get from https://venice.ai/settings/api): '
          );
        } else {
          console.error(
            'Warning: passing an API key as an argument may expose it. ' +
            'Use "venice config set api_key" or "--stdin" instead.'
          );
        }
      } else if (value === undefined) {
        throw new Error(`Missing value for ${key}`);
      }

      value = value.trim();
      if (!value) {
        throw new Error(`Value for ${key} cannot be empty`);
      }

      setConfigValue(key as keyof VeniceConfig, value);
      
      const displayValue = key === 'api_key' ? maskApiKey(value) : value;
      console.log(formatSuccess(`Set ${key} = ${displayValue}`));
    });

  // Get a config value
  config
    .command('get <key>')
    .description('Get a configuration value')
    .action((key: string) => {
      const cfg = loadConfig();
      const value = (cfg as any)[key];
      
      if (value === undefined) {
        console.log('(not set)');
      } else if (key === 'api_key') {
        console.log(maskApiKey(value));
      } else {
        console.log(value);
      }
    });

  // Unset a config value
  config
    .command('unset <key>')
    .description('Remove a configuration value')
    .action((key: string) => {
      deleteConfigValue(key as keyof VeniceConfig);
      console.log(formatSuccess(`Removed ${key}`));
    });

  // Show config path
  config
    .command('path')
    .description('Show configuration file path')
    .action(() => {
      console.log(getConfigPath());
    });

  // Initialize config
  config
    .command('init')
    .description('Initialize configuration interactively')
    .action(async () => {
      const c = getChalk();
      let rl: readline.Interface | undefined;

      loadConfig();

      console.log(c.bold('\nVenice CLI Setup\n'));
      console.log(`Config will be saved to: ${getConfigPath()}\n`);

      try {
        let apiKey: string;
        if (process.stdin.isTTY) {
          apiKey = await askHiddenQuestion(
            'API Key (get from https://venice.ai/settings/api): '
          );
        } else {
          rl = createQuestionInterface();
          apiKey = await question(
            rl,
            'API Key (get from https://venice.ai/settings/api): '
          );
        }

        if (apiKey.trim()) {
          setConfigValue('api_key', apiKey.trim());
          console.log(formatSuccess('API key saved'));
        }

        rl ??= createQuestionInterface();

        const model = await question(rl, 'Default chat model [kimi-k2-5]: ');
        if (model.trim()) {
          setConfigValue('default_model', model.trim());
        }

        const imageModel = await question(rl, 'Default image model [flux-2-pro]: ');
        if (imageModel.trim()) {
          setConfigValue('default_image_model', imageModel.trim());
        }

        const showUsage = await question(rl, 'Show token usage after requests? [Y/n]: ');
        if (showUsage.toLowerCase() === 'n') {
          setConfigValue('show_usage', 'false');
        }

        console.log(formatSuccess('\nConfiguration complete!'));
        console.log(c.dim('Run "venice config show" to view your settings.'));
      } finally {
        rl?.close();
      }
    });
}

function createQuestionInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function askHiddenQuestion(prompt: string): Promise<string> {
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });

  process.stderr.write(prompt);

  return new Promise((resolve, reject) => {
    rl.once('SIGINT', () => {
      rl.close();
      reject(new Error('Input cancelled'));
    });
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function readStdin(): Promise<string> {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
