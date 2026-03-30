/**
 * Edit command - make specific code changes
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { runAgent } from '../../agent/agent.js';
import { getSystemPrompt } from '../../agent/prompts.js';
import { logError, chalk } from '../../utils/logger.js';
import type { Message, AgentContext } from '../../types/index.js';

export function registerEditCommand(program: Command): void {
  program
    .command('edit <instruction>')
    .description('Make specific code changes based on instructions')
    .option('-f, --files <files>', 'Comma-separated list of files to edit')
    .option('-m, --model <model>', 'Model to use')
    .option('--dry-run', 'Preview changes without applying')
    .option('-v, --verbose', 'Verbose output')
    .action(async (instruction: string, options) => {
      try {
        const config = await loadConfig();
        
        if (options.model) {
          config.default_model = options.model;
        }
        
        if (options.verbose) {
          config.verbose = true;
        }

        let userMessage = `Please make the following changes:\n\n${instruction}`;
        
        if (options.files) {
          userMessage += `\n\nFocus on these files: ${options.files}`;
        }

        if (options.dryRun) {
          userMessage += '\n\nIMPORTANT: This is a dry-run. Show what you would change but do not apply changes.';
        }

        const messages: Message[] = [
          {
            role: 'system',
            content: getSystemPrompt('edit'),
          },
          {
            role: 'user',
            content: userMessage,
          },
        ];

        const context: AgentContext = {
          messages,
          tools: [],
          config,
          projectPath: process.cwd(),
        };

        console.log(chalk.bold('\nMaking changes...\n'));

        const result = await runAgent(context, {
          stream: true,
          onChunk: (chunk) => {
            process.stdout.write(chunk);
          },
        });

        console.log('\n');

        if (!result.success) {
          logError(result.error || 'Edit failed');
          process.exit(1);
        }
      } catch (error) {
        logError(`Edit failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
