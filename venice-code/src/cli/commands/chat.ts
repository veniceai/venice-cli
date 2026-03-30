/**
 * Chat command - project-aware conversational coding
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { runAgent } from '../../agent/agent.js';
import { getSystemPrompt } from '../../agent/prompts.js';
import { loadVectorStore, searchVectorStore } from '../../embeddings/vector-store.js';
import { logError, chalk } from '../../utils/logger.js';
import type { Message, AgentContext } from '../../types/index.js';
import * as readline from 'readline';

export function registerChatCommand(program: Command): void {
  program
    .command('chat [message]')
    .description('Chat with AI about your codebase (project-aware)')
    .option('-m, --model <model>', 'Model to use')
    .option('--no-context', 'Disable automatic context from embeddings')
    .option('-v, --verbose', 'Verbose output')
    .action(async (message: string | undefined, options) => {
      try {
        const config = await loadConfig();
        
        if (options.model) {
          config.default_model = options.model;
        }
        
        if (options.verbose) {
          config.verbose = true;
        }

        // Interactive mode if no message provided
        if (!message) {
          await runInteractiveChatMode(config, options.context);
          return;
        }

        // Single message mode
        await runSingleChat(message, config, options.context);
      } catch (error) {
        logError(`Chat failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}

async function runSingleChat(
  userMessage: string,
  config: any,
  includeContext: boolean
): Promise<void> {
  const messages: Message[] = [];

  // Add system prompt
  messages.push({
    role: 'system',
    content: getSystemPrompt('chat', { cwd: process.cwd() }),
  });

  // Add relevant context from embeddings if enabled
  if (includeContext) {
    try {
      const store = await loadVectorStore(config.index_path);
      if (store) {
        const results = await searchVectorStore(store, userMessage, {
          topK: 3,
          minSimilarity: 0.7,
        });

        if (results.length > 0) {
          let contextMessage = 'Relevant code from the project:\n\n';
          for (const result of results) {
            contextMessage += `File: ${result.file} (lines ${result.start_line}-${result.end_line})\n`;
            contextMessage += '```\n' + result.chunk + '\n```\n\n';
          }
          
          messages.push({
            role: 'system',
            content: contextMessage,
          });
        }
      }
    } catch {
      // Continue without context if loading fails
    }
  }

  // Add user message
  messages.push({
    role: 'user',
    content: userMessage,
  });

  // Run agent
  const context: AgentContext = {
    messages,
    tools: [],
    config,
    projectPath: process.cwd(),
  };

  console.log(); // Blank line before response

  const result = await runAgent(context, {
    stream: true,
    onChunk: (chunk) => {
      process.stdout.write(chunk);
    },
  });

  console.log('\n'); // Blank line after response

  if (!result.success) {
    logError(result.error || 'Chat failed');
    process.exit(1);
  }
}

async function runInteractiveChatMode(config: any, _includeContext: boolean): Promise<void> {
  console.log(chalk.bold('\nVenice Code Interactive Chat'));
  console.log(chalk.gray('Type your messages below. Type "exit" or "quit" to exit.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const conversationMessages: Message[] = [
    {
      role: 'system',
      content: getSystemPrompt('chat', { cwd: process.cwd() }),
    },
  ];

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(chalk.cyan('You: '), (answer) => {
        resolve(answer.trim());
      });
    });
  };

  while (true) {
    const userInput = await askQuestion();

    if (!userInput) {
      continue;
    }

    if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
      console.log(chalk.gray('\nGoodbye!\n'));
      rl.close();
      break;
    }

    conversationMessages.push({
      role: 'user',
      content: userInput,
    });

    console.log(chalk.green('\nAssistant: '));

    const context: AgentContext = {
      messages: [...conversationMessages],
      tools: [],
      config,
      projectPath: process.cwd(),
    };

    const result = await runAgent(context, {
      stream: true,
      onChunk: (chunk) => {
        process.stdout.write(chunk);
      },
    });

    console.log('\n');

    if (result.success) {
      conversationMessages.push({
        role: 'assistant',
        content: result.message,
      });
    } else {
      logError(result.error || 'Failed to get response');
    }
  }
}
