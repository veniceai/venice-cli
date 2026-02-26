/**
 * Config Command - Manage Venice CLI configuration
 */

import { Command } from 'commander';
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
        console.log(JSON.stringify(cfg, null, 2));
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
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action((key: string, value: string) => {
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
      const readline = await import('readline');
      const c = getChalk();

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
          rl.question(prompt, resolve);
        });
      };

      console.log(c.bold('\nVenice CLI Setup\n'));
      console.log(`Config will be saved to: ${getConfigPath()}\n`);

      try {
        const apiKey = await question('API Key (get from https://venice.ai/settings/api): ');
        if (apiKey.trim()) {
          setConfigValue('api_key', apiKey.trim());
          console.log(formatSuccess('API key saved'));
        }

        const model = await question('Default chat model [kimi-k2-5]: ');
        if (model.trim()) {
          setConfigValue('default_model', model.trim());
        }

        const imageModel = await question('Default image model [flux-2-pro]: ');
        if (imageModel.trim()) {
          setConfigValue('default_image_model', imageModel.trim());
        }

        const showUsage = await question('Show token usage after requests? [Y/n]: ');
        if (showUsage.toLowerCase() === 'n') {
          setConfigValue('show_usage', 'false');
        }

        console.log(formatSuccess('\nConfiguration complete!'));
        console.log(c.dim('Run "venice config show" to view your settings.'));
      } finally {
        rl.close();
      }
    });
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
