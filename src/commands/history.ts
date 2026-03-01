/**
 * History Command - View and manage conversation history
 */

import { Command } from 'commander';
import * as fs from 'fs';
import {
  loadHistory,
  clearHistory,
  ConversationEntry,
} from '../lib/config.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';

export function registerHistoryCommand(program: Command): void {
  const history = program
    .command('history')
    .description('View and manage conversation history')
    .action(() => {
      // Default: list recent conversations
      const c = getChalk();
      const conversations = loadHistory();

      if (conversations.length === 0) {
        console.log(c.dim('No conversation history found.'));
        console.log(c.dim('\nStart a conversation with: venice chat "Hello"'));
        return;
      }

      const recent = conversations.slice(-10).reverse();

      console.log(c.bold(`\n📜 Recent Conversations (${recent.length}/${conversations.length})\n`));

      for (const conv of recent) {
        const date = new Date(conv.timestamp);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const firstUser = conv.messages.find(m => m.role === 'user');
        const preview = firstUser?.content?.slice(0, 50) || '(no content)';
        const truncated = preview.length >= 50 ? preview + '...' : preview;

        console.log(`${c.dim(dateStr)} ${c.dim(timeStr)} ${c.cyan(conv.model)}`);
        console.log(`  ${truncated}`);
        if (conv.character) {
          console.log(`  ${c.dim(`Character: ${conv.character}`)}`);
        }
        console.log('');
      }

      console.log(c.dim('Run "venice history --help" for more options'));
    });

  // List conversations
  history
    .command('list')
    .alias('ls')
    .description('List recent conversations')
    .option('-n, --limit <number>', 'Number of conversations to show', '10')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action((options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      const limit = parseInt(options.limit, 10);

      const conversations = loadHistory();

      if (conversations.length === 0) {
        console.log(c.dim('No conversation history found.'));
        return;
      }

      const recent = conversations.slice(-limit).reverse();

      if (format === 'json') {
        console.log(JSON.stringify(recent, null, 2));
        return;
      }

      console.log(c.bold(`\n📜 Recent Conversations (${recent.length}/${conversations.length})\n`));

      for (const conv of recent) {
        const date = new Date(conv.timestamp);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Get first user message as preview
        const firstUser = conv.messages.find(m => m.role === 'user');
        const preview = firstUser?.content?.slice(0, 50) || '(no content)';
        const truncated = preview.length >= 50 ? preview + '...' : preview;

        console.log(`${c.dim(dateStr)} ${c.dim(timeStr)} ${c.cyan(conv.model)}`);
        console.log(`  ${truncated}`);
        if (conv.character) {
          console.log(`  ${c.dim(`Character: ${conv.character}`)}`);
        }
        console.log('');
      }

      console.log(c.dim(`Tip: Use "venice history show <id>" to see full conversation`));
    });

  // Show specific conversation
  history
    .command('show [id]')
    .description('Show a conversation (default: last conversation)')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown)')
    .action((id: string | undefined, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      const conversations = loadHistory();

      if (conversations.length === 0) {
        console.log(c.dim('No conversation history found.'));
        return;
      }

      let conv: ConversationEntry | undefined;

      if (id) {
        conv = conversations.find(c => c.id === id || c.id.startsWith(id));
        if (!conv) {
          console.error(formatError(`Conversation not found: ${id}`));
          process.exit(1);
        }
      } else {
        conv = conversations[conversations.length - 1];
      }

      if (format === 'json') {
        console.log(JSON.stringify(conv, null, 2));
        return;
      }

      const date = new Date(conv.timestamp);

      console.log(c.bold(`\n📜 Conversation ${conv.id.slice(0, 8)}`));
      console.log(c.dim(`Date: ${date.toLocaleString()}`));
      console.log(c.dim(`Model: ${conv.model}`));
      if (conv.character) {
        console.log(c.dim(`Character: ${conv.character}`));
      }
      console.log(c.dim('─'.repeat(50)));
      console.log('');

      for (const msg of conv.messages) {
        const roleColor = msg.role === 'user' ? c.green : msg.role === 'assistant' ? c.cyan : c.yellow;
        const roleName = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);

        if (format === 'markdown') {
          console.log(`**${roleName}:** ${msg.content}\n`);
        } else {
          console.log(`${roleColor(roleName + ':')} ${msg.content}\n`);
        }
      }
    });

  // Clear history
  history
    .command('clear')
    .description('Clear all conversation history')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options) => {
      const c = getChalk();

      if (!options.yes) {
        const readline = await import('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(c.yellow('Are you sure you want to clear all history? [y/N] '), resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          console.log('Cancelled.');
          return;
        }
      }

      clearHistory();
      console.log(formatSuccess('Conversation history cleared.'));
    });

  // Export history
  history
    .command('export <file>')
    .description('Export history to a JSON file')
    .action((file: string) => {
      const conversations = loadHistory();

      fs.writeFileSync(file, JSON.stringify(conversations, null, 2));
      console.log(formatSuccess(`Exported ${conversations.length} conversations to ${file}`));
    });
}
