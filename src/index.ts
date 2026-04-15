#!/usr/bin/env node
/**
 * Venice CLI — Command Line Interface for Venice AI
 * 
 * A comprehensive, privacy-first CLI for interacting with Venice AI.
 * Supports chat, image generation, text-to-speech, transcription, and more.
 * 
 * @author Venice AI
 * @license MIT
 */

import { Command } from 'commander';
import updateNotifier from 'update-notifier';
import { registerChatCommand } from './commands/chat.js';
import { registerSearchCommand } from './commands/search.js';
import { registerImageCommand } from './commands/image.js';
import { registerAudioCommands } from './commands/audio.js';
import { registerModelsCommand } from './commands/models.js';
import { registerEmbeddingsCommand } from './commands/embeddings.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerUsageCommand } from './commands/usage.js';
import { registerConfigCommand } from './commands/config.js';
import { registerCharactersCommand } from './commands/characters.js';
import { registerCompletionsCommand } from './commands/completions.js';
import { registerVideoCommands } from './commands/video.js';
import { registerTeeCommand } from './commands/tee.js';
import { registerCodeCommand } from './commands/code.js';
import { formatError, getChalk } from './lib/output.js';
import { getVersion } from './lib/version.js';

// Check for updates in the background (non-blocking, checks once per day)
const pkg = { name: 'veniceai-cli', version: getVersion() };
updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 }).notify({
  isGlobal: true,
  message: 'Update available {currentVersion} → {latestVersion}\nRun {updateCommand} to update',
});

async function main() {
  const program = new Command();
  const c = getChalk();

  program
    .name('venice')
    .version(getVersion())
    .description(
      `${c.bold('Venice CLI')} — Privacy-first AI from the command line\n\n` +
      `Chat with AI models, generate images, convert text to speech, and more.\n` +
      `All with Venice's privacy-preserving infrastructure.`
    )
    .option('--no-color', 'Disable colored output')
    .hook('preAction', (thisCommand) => {
      // Handle global --no-color flag
      if (thisCommand.opts().color === false) {
        process.env.NO_COLOR = '1';
      }
    });

  // Register all commands
  registerChatCommand(program);
  registerSearchCommand(program);
  registerImageCommand(program);
  registerAudioCommands(program);
  registerModelsCommand(program);
  registerEmbeddingsCommand(program);
  registerHistoryCommand(program);
  registerUsageCommand(program);
  registerConfigCommand(program);
  registerCharactersCommand(program);
  registerCompletionsCommand(program);
  registerVideoCommands(program);
  registerTeeCommand(program);
  registerCodeCommand(program);

  // Handle errors gracefully
  program.exitOverride();

  try {
    await program.parseAsync(process.argv);
  } catch (error: any) {
    // Commander throws on help/version, which is fine
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      process.exit(0);
    }

    // Handle missing command gracefully
    if (error.code === 'commander.unknownCommand') {
      console.error(formatError(`Unknown command: ${error.message}`));
      console.error('\nRun "venice --help" for available commands.');
      process.exit(1);
    }

    // Handle missing arguments
    if (error.code === 'commander.missingArgument') {
      console.error(formatError(error.message));
      process.exit(1);
    }

    // Log other errors
    console.error(formatError(error.message || String(error)));
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason: any) => {
  console.error(formatError(reason?.message || String(reason)));
  process.exit(1);
});

// Handle SIGINT gracefully
process.on('SIGINT', () => {
  console.log('\n');
  process.exit(0);
});

main();
