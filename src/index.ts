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
import { registerChatCommand } from './commands/chat.js';
import { registerResponsesCommand } from './commands/responses.js';
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
import { registerMusicCommands } from './commands/music.js';
import { registerTeeCommand } from './commands/tee.js';
import { registerRpcCommand } from './commands/rpc.js';
import { registerBillingCommand } from './commands/billing.js';
import { registerKeysCommand } from './commands/keys.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerAugmentCommands } from './commands/augment.js';
import { formatError, formatJson, formatWarning, getChalk, reportError } from './lib/output.js';
import { undeliveredWarnings } from './lib/warnings.js';
import { runInterruptCleanups } from './lib/interrupt.js';
import { getVersion } from './lib/version.js';
import type { OutputFormat } from './types/index.js';

// Known once the command's options are parsed, so the errors a command doesn't
// catch itself follow its output format too.
let errorFormat: OutputFormat | undefined;

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
    .hook('preAction', (thisCommand, actionCommand) => {
      // Handle global --no-color flag
      if (thisCommand.opts().color === false) {
        process.env.NO_COLOR = '1';
      }
      const options = actionCommand.opts();
      if (options.format === 'json' || options.json === true) errorFormat = 'json';
    })
    .hook('postAction', (_thisCommand, actionCommand) => {
      const pending = undeliveredWarnings();
      if (pending.length === 0) return;
      const options = actionCommand.opts();
      if (options.format === 'json' || options.json === true) {
        console.error(formatJson({ warnings: pending }, 0));
      } else {
        for (const warning of pending) console.error(formatWarning(warning.message));
      }
    });

  // Register all commands
  registerChatCommand(program);
  registerResponsesCommand(program);
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
  registerMusicCommands(program);
  registerTeeCommand(program);
  registerRpcCommand(program);
  registerBillingCommand(program);
  registerKeysCommand(program);
  registerAugmentCommands(program);
  registerUpdateCommand(program);

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
    reportError(error, errorFormat);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason: unknown) => {
  reportError(reason, errorFormat);
  process.exit(1);
});

// Remove partial files, then exit with the shell's 128 + signal number
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    if (process.stderr.isTTY) process.stderr.write('\n');
    runInterruptCleanups();
    process.exit(exitCode);
  });
}

main();
