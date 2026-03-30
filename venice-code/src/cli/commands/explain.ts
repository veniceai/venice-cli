/**
 * Explain command - explain code
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { runAgent } from '../../agent/agent.js';
import { getSystemPrompt } from '../../agent/prompts.js';
import { logError, chalk } from '../../utils/logger.js';
import type { Message, AgentContext } from '../../types/index.js';

export function registerExplainCommand(program: Command): void {
  program
    .command('explain <target>')
    .description('Explain code in a file or directory')
    .option('-m, --model <model>', 'Model to use')
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

        const messages: Message[] = [
          {
            role: 'system',
            content: getSystemPrompt('explain'),
          },
          {
            role: 'user',
            content: `Please read and explain the code in: ${target}`,
          },
        ];

        const context: AgentContext = {
          messages,
          tools: [],
          config,
          projectPath: process.cwd(),
        };

        console.log(chalk.bold(`\nExplaining: ${target}\n`));

        const result = await runAgent(context, {
          stream: true,
          onChunk: (chunk) => {
            process.stdout.write(chunk);
          },
        });

        console.log('\n');

        if (!result.success) {
          logError(result.error || 'Explanation failed');
          process.exit(1);
        }
      } catch (error) {
        logError(`Explain failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
