#!/usr/bin/env node
/**
 * Venice Code - AI Coding Assistant CLI
 * 
 * A full-featured coding assistant built on Venice AI with autonomous
 * file operations, patch generation, embeddings-based search, and agent workflows.
 */

import { Command } from 'commander';
import { registerInitCommand } from './cli/commands/init.js';
import { registerIndexCommand } from './cli/commands/index-project.js';
import { registerChatCommand } from './cli/commands/chat.js';
import { registerExplainCommand } from './cli/commands/explain.js';
import { registerFixCommand } from './cli/commands/fix.js';
import { registerEditCommand } from './cli/commands/edit.js';
import { registerRefactorCommand } from './cli/commands/refactor.js';
import { registerTestgenCommand } from './cli/commands/testgen.js';
import { registerSearchCommand } from './cli/commands/search.js';
import { chalk } from './utils/logger.js';

const VERSION = '1.0.0';

async function main() {
  const program = new Command();

  program
    .name('venice-code')
    .version(VERSION)
    .description(
      chalk.bold('Venice Code') + ' — AI-powered coding assistant\n\n' +
      'Built on Venice AI with autonomous coding capabilities:\n' +
      '  • Read/write project files\n' +
      '  • Multi-file refactoring\n' +
      '  • Patch generation and application\n' +
      '  • Semantic code search\n' +
      '  • Agent-style workflows\n' +
      '  • Shell command execution\n' +
      '  • Git integration'
    );

  // Register all commands
  registerInitCommand(program);
  registerIndexCommand(program);
  registerChatCommand(program);
  registerExplainCommand(program);
  registerFixCommand(program);
  registerEditCommand(program);
  registerRefactorCommand(program);
  registerTestgenCommand(program);
  registerSearchCommand(program);

  // Show help if no arguments
  if (process.argv.length === 2) {
    program.help();
  }

  try {
    await program.parseAsync(process.argv);
  } catch (error: any) {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      process.exit(0);
    }

    if (error.code === 'commander.unknownCommand') {
      console.error(chalk.red('✖') + ` Unknown command: ${error.message}`);
      console.error('\nRun "venice-code --help" for available commands.');
      process.exit(1);
    }

    console.error(chalk.red('✖') + ` ${error.message || String(error)}`);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason: any) => {
  console.error(chalk.red('✖') + ` Unhandled error: ${reason?.message || String(reason)}`);
  process.exit(1);
});

// Handle SIGINT gracefully
process.on('SIGINT', () => {
  console.log('\n');
  process.exit(0);
});

main();
