/**
 * Fix command - debug and fix issues
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { runAgent } from '../../agent/agent.js';
import { getSystemPrompt } from '../../agent/prompts.js';
import { logError, chalk } from '../../utils/logger.js';
import type { Message, AgentContext } from '../../types/index.js';

export function registerFixCommand(program: Command): void {
  program
    .command('fix <target>')
    .description('Find and fix issues in code')
    .option('-m, --model <model>', 'Model to use')
    .option('--issue <description>', 'Describe the specific issue to fix')
    .option('--dry-run', 'Preview fixes without applying')
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

        let userMessage = `Please analyze and fix issues in: ${target}`;
        
        if (options.issue) {
          userMessage += `\n\nSpecific issue to fix: ${options.issue}`;
        }

        if (options.dryRun) {
          userMessage += '\n\nIMPORTANT: This is a dry-run. Show what you would fix but do not apply changes.';
        }

        const messages: Message[] = [
          {
            role: 'system',
            content: getSystemPrompt('fix'),
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

        console.log(chalk.bold(`\nFixing issues in: ${target}\n`));

        const result = await runAgent(context, {
          stream: true,
          onChunk: (chunk) => {
            process.stdout.write(chunk);
          },
        });

        console.log('\n');

        if (!result.success) {
          logError(result.error || 'Fix failed');
          process.exit(1);
        }
      } catch (error) {
        logError(`Fix failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
