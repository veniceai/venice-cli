/**
 * Refactor command - improve code quality
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { runAgent } from '../../agent/agent.js';
import { getSystemPrompt } from '../../agent/prompts.js';
import { logError, chalk } from '../../utils/logger.js';
import type { Message, AgentContext } from '../../types/index.js';

export function registerRefactorCommand(program: Command): void {
  program
    .command('refactor <target>')
    .description('Refactor code for better quality and maintainability')
    .option('-m, --model <model>', 'Model to use')
    .option('-p, --pattern <pattern>', 'Specific refactoring pattern to apply')
    .option('--dry-run', 'Preview refactoring without applying')
    .option('-v, --verbose', 'Verbose output')
    .action(async (target: string, options) => {
      try {
        const config = await loadConfig();
        
        if (options.model) {
          config.default_model = options.model;
        }
        
        if (options.verbose) {
          config.verbose = true;
        }

        let userMessage = `Please refactor the code in: ${target}`;
        
        if (options.pattern) {
          userMessage += `\n\nApply this specific pattern: ${options.pattern}`;
        }

        if (options.dryRun) {
          userMessage += '\n\nIMPORTANT: This is a dry-run. Show what you would refactor but do not apply changes.';
        }

        const messages: Message[] = [
          {
            role: 'system',
            content: getSystemPrompt('refactor'),
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

        console.log(chalk.bold(`\nRefactoring: ${target}\n`));

        const result = await runAgent(context, {
          stream: true,
          onChunk: (chunk) => {
            process.stdout.write(chunk);
          },
        });

        console.log('\n');

        if (!result.success) {
          logError(result.error || 'Refactoring failed');
          process.exit(1);
        }
      } catch (error) {
        logError(`Refactor failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
