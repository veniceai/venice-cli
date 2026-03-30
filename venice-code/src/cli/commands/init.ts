/**
 * Init command - initial setup
 */

import { Command } from 'commander';
import { loadConfig, saveConfig, hasApiKey } from '../../config/config.js';
import { logInfo, logSuccess, logError, chalk } from '../../utils/logger.js';
import * as readline from 'readline';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize venice-code configuration')
    .action(async () => {
      try {
        logInfo('Setting up venice-code configuration...\n');

        const config = await loadConfig();

        // Check if API key is already set
        if (await hasApiKey()) {
          console.log(chalk.green('✓') + ' API key is already configured\n');
        } else {
          console.log('You need a Venice AI API key to use venice-code.');
          console.log('Get your API key from: https://venice.ai/settings/api\n');

          // Check if VENICE_API_KEY env var is set
          const envApiKey = process.env.VENICE_API_KEY;
          if (envApiKey && envApiKey.trim()) {
            config.api_key = envApiKey.trim();
            await saveConfig(config);
            logSuccess('API key loaded from VENICE_API_KEY environment variable\n');
          } else {
            // Warn about security
            console.log(chalk.yellow('⚠ Warning: ') + 'API key input will be echoed to your terminal.');
            console.log('For better security, set the VENICE_API_KEY environment variable instead.\n');

            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });

            const apiKey = await new Promise<string>((resolve) => {
              rl.question('Enter your Venice API key: ', (answer) => {
                rl.close();
                resolve(answer.trim());
              });
            });

            if (apiKey) {
              config.api_key = apiKey;
              await saveConfig(config);
              logSuccess('API key saved\n');
            } else {
              logError('No API key provided');
              process.exit(1);
            }
          }
        }

        // Show configuration
        console.log('Current configuration:');
        console.log(chalk.cyan('  Default model:') + ` ${config.default_model}`);
        console.log(chalk.cyan('  Embeddings model:') + ` ${config.embeddings_model}`);
        console.log(chalk.cyan('  Auto-approve:') + ` ${config.auto_approve}`);
        console.log(chalk.cyan('  Backups:') + ` ${config.backup_enabled}`);
        console.log(chalk.cyan('  Index path:') + ` ${config.index_path}\n`);

        logSuccess('venice-code is configured and ready to use!');
        console.log('\nNext steps:');
        console.log('  1. Index your project: ' + chalk.bold('venice-code index'));
        console.log('  2. Start chatting: ' + chalk.bold('venice-code chat "explain this project"'));
        console.log('  3. Get help: ' + chalk.bold('venice-code --help'));
      } catch (error) {
        logError(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
