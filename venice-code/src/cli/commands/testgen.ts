/**
 * Test generation command
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { runAgent } from '../../agent/agent.js';
import { getSystemPrompt } from '../../agent/prompts.js';
import { logError, chalk } from '../../utils/logger.js';
import type { Message, AgentContext } from '../../types/index.js';

export function registerTestgenCommand(program: Command): void {
  program
    .command('testgen <target>')
    .description('Generate tests for code')
    .option('-m, --model <model>', 'Model to use')
    .option('-o, --output <file>', 'Output test file path')
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

        let userMessage = `Please generate comprehensive tests for: ${target}`;
        
        if (options.output) {
          userMessage += `\n\nSave the tests to: ${options.output}`;
        }

        const messages: Message[] = [
          {
            role: 'system',
            content: getSystemPrompt('testgen'),
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

        console.log(chalk.bold(`\nGenerating tests for: ${target}\n`));

        const result = await runAgent(context, {
          stream: true,
          onChunk: (chunk) => {
            process.stdout.write(chunk);
          },
        });

        console.log('\n');

        if (!result.success) {
          logError(result.error || 'Test generation failed');
          process.exit(1);
        }
      } catch (error) {
        logError(`Testgen failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
