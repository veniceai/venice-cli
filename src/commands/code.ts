/**
 * Code Command - Agentic coding assistant with tool execution
 *
 * Supports single-shot mode (venice code "do something") and
 * interactive REPL mode (venice code, then type prompts).
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  requireApiKey,
  getDefaultModel,
  addConversation,
  getLastConversation,
} from '../lib/config.js';
import {
  formatUsage,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import { agentLoop } from '../lib/agent-loop.js';
import { CODING_TOOLS } from '../tools/index.js';
import { setSandboxMode } from '../tools/bash.js';
import { createApprover } from '../lib/permissions.js';
import { buildSystemPrompt, findProjectRoot } from '../lib/system-prompt.js';
import { clearUndoHistory } from '../lib/undo.js';
import { retrieveContext } from '../lib/context-retrieval.js';
import { saveSession, loadSession } from '../lib/session.js';
import { getSandboxInfo } from '../lib/sandbox.js';
import { colorDiff } from '../lib/diff-display.js';
import type { Message, PermissionMode, AgentEvent } from '../types/index.js';

const MAX_DISPLAY_RESULT = 2000;

export function registerCodeCommand(program: Command): void {
  program
    .command('code [prompt...]')
    .description('Agentic coding assistant with file editing, shell execution, and web search')
    .option('-m, --model <model>', 'Model to use')
    .option('-s, --system <prompt>', 'Additional system prompt instructions')
    .option('--yes', 'Auto-approve all tool executions')
    .option('--read-only', 'Only allow read operations (deny writes and shell execution)')
    .option('--max-iterations <n>', 'Max agentic loop iterations', '25')
    .option('--budget <tokens>', 'Max total tokens for the session')
    .option('--continue', 'Continue the last code conversation')
    .option('--resume', 'Resume the last session from .venice/session.json')
    .option('--init', 'Initialize .venice/ project directory')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .option('--web-search', 'Enable web search for current information')
    .option('--sandbox <mode>', 'Sandbox mode for bash: auto, firejail, docker, none (default: none)')
    .option('--fast-model <model>', 'Fast model for simple queries without tool use')
    .option('--no-context', 'Disable automatic context retrieval')
    .action(async (promptParts: string[], options) => {
      const c = getChalk();

      // Handle --init
      if (options.init) {
        await initProjectDir(process.cwd());
        return;
      }

      requireApiKey();

      const model = options.model || getDefaultModel();
      const fastModel = options.fastModel;
      const format = detectOutputFormat(options.format);
      const maxIterations = parseInt(options.maxIterations, 10) || 25;
      const maxBudgetTokens = options.budget ? parseInt(options.budget, 10) : undefined;

      let permissionMode: PermissionMode = 'prompt';
      if (options.yes) permissionMode = 'auto';
      if (options.readOnly) permissionMode = 'read-only';

      // Configure sandbox
      if (options.sandbox) {
        setSandboxMode(options.sandbox);
      }

      const cwd = process.cwd();
      const approve = createApprover(permissionMode);
      const systemPrompt = await buildSystemPrompt(CODING_TOOLS, cwd, options.system);

      const veniceParams: Record<string, unknown> = {};
      if (options.webSearch) {
        veniceParams.enable_web_search = 'on';
      }

      // Build initial messages
      const messages: Message[] = [];

      // Resume session from .venice/session.json
      if (options.resume) {
        const session = await loadSession(cwd);
        if (session) {
          for (const msg of session.messages) {
            messages.push(msg as Message);
          }
          if (format === 'pretty') {
            console.log(c.dim(`Resumed session (${session.messages.length} messages, ${session.totalTokensUsed} tokens used)\n`));
          }
        }
      } else if (options.continue) {
        const lastConv = getLastConversation();
        if (lastConv) {
          for (const msg of lastConv.messages) {
            messages.push(msg as Message);
          }
          if (format === 'pretty') {
            console.log(c.dim(`Continuing conversation (${lastConv.messages.length} previous messages)\n`));
          }
        }
      }

      messages.push({ role: 'system', content: systemPrompt });

      // Resolve initial prompt
      let prompt = promptParts.join(' ');
      if (!prompt && !process.stdin.isTTY) {
        prompt = await readStdin();
      }

      // If no prompt and TTY available, enter REPL mode
      if (!prompt && process.stdin.isTTY) {
        if (format === 'pretty') {
          console.log(c.dim(`Sandbox: ${getSandboxInfo()}`));
        }
        await replMode(messages, {
          model, fastModel, format, maxIterations, maxBudgetTokens,
          cwd, approve, veniceParams, c,
        });
        return;
      }

      if (!prompt) {
        console.error(formatError('No prompt provided. Usage: venice code "your task" or just venice code for interactive mode'));
        process.exit(1);
      }

      // Smart context retrieval
      if (options.context !== false) {
        const autoContext = await retrieveContext(prompt, cwd);
        if (autoContext) {
          messages.push({ role: 'system', content: autoContext });
        }
      }

      // Single-shot mode
      messages.push({ role: 'user', content: prompt });
      await runAgentAndRender(messages, {
        model, fastModel, format, maxIterations, maxBudgetTokens,
        cwd, approve, veniceParams, c,
      });

      saveConversation(messages, model);
      await saveSession(cwd, { id: randomUUID(), model, messages });
    });
}

// --- REPL Mode ---

interface RunOptions {
  model: string;
  fastModel?: string;
  format: string;
  maxIterations: number;
  maxBudgetTokens?: number;
  cwd: string;
  approve: (toolName: string, summary: string) => Promise<boolean>;
  veniceParams: Record<string, unknown>;
  c: ReturnType<typeof getChalk>;
}

async function replMode(messages: Message[], opts: RunOptions): Promise<void> {
  const { c } = opts;

  console.log(c.bold('Venice Code') + c.dim(' - Interactive Mode'));
  console.log(c.dim('Type your prompt, then press Enter. Type /exit to quit, /clear to reset.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan('> '),
  });

  rl.prompt();

  let closed = false;
  rl.on('close', () => { closed = true; });

  for await (const line of rl) {
    if (closed) break;
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    // REPL commands
    if (input === '/exit' || input === '/quit') {
      saveConversation(messages, opts.model);
      console.log(c.dim('Session saved. Goodbye.'));
      break;
    }
    if (input === '/clear') {
      // Keep system prompt, clear everything else
      const systemMsg = messages.find((m) => m.role === 'system');
      messages.length = 0;
      if (systemMsg) messages.push(systemMsg);
      clearUndoHistory();
      console.log(c.dim('Conversation cleared.\n'));
      rl.prompt();
      continue;
    }
    if (input === '/history') {
      const count = messages.filter((m) => m.role === 'user').length;
      const toolCalls = messages.filter((m) => m.role === 'tool').length;
      console.log(c.dim(`${count} messages, ${toolCalls} tool results\n`));
      rl.prompt();
      continue;
    }
    if (input === '/undo') {
      const { undoLastEdit } = await import('../lib/undo.js');
      const result = await undoLastEdit();
      console.log(result.restored ? c.green(result.message) : c.yellow(result.message));
      console.log('');
      rl.prompt();
      continue;
    }

    messages.push({ role: 'user', content: input });

    await runAgentAndRender(messages, opts);

    if (!closed) rl.prompt();
  }

  saveConversation(messages, opts.model);
  rl.close();
}

// --- Agent Execution and Rendering ---

async function runAgentAndRender(messages: Message[], opts: RunOptions): Promise<void> {
  const { model, fastModel, format, maxIterations, maxBudgetTokens, cwd, approve, veniceParams, c } = opts;

  try {
    const events = agentLoop(messages, {
      model,
      fastModel,
      tools: CODING_TOOLS,
      toolContext: { cwd, approve },
      veniceParams: Object.keys(veniceParams).length > 0 ? veniceParams : undefined,
      maxIterations,
      maxBudgetTokens,
      parallelToolExecution: true,
    });

    let lastUsage: AgentEvent['data'] | undefined;

    for await (const event of events) {
      switch (event.type) {
        case 'content':
          if (format !== 'json') {
            process.stdout.write(event.text || '');
          }
          break;

        case 'thinking':
          if (format === 'pretty') {
            console.log(c.dim(`  ${event.text}`));
          }
          break;

        case 'tool_call':
          if (format !== 'json') {
            const argsSummary = formatArgsSummary(event.args || {});
            console.log(`\n${c.cyan(`[${event.name}]`)} ${c.dim(argsSummary)}`);
          }
          break;

        case 'tool_result':
          if (format !== 'json' && event.result) {
            let display = event.result.output.length > MAX_DISPLAY_RESULT
              ? event.result.output.slice(0, MAX_DISPLAY_RESULT) + c.dim(`\n... (${event.result.output.length} chars total)`)
              : event.result.output;
            // Colorize diff output
            if (display.includes('\n-') && display.includes('\n+')) {
              display = colorDiff(display, c);
            } else if (event.result.error) {
              display = c.red(display);
            } else {
              display = c.dim(display);
            }
            console.log(display);
            console.log('');
          }
          break;

        case 'usage':
          lastUsage = event.data;
          break;

        case 'done':
          console.log('\n');
          if (lastUsage && format === 'pretty') {
            console.log(formatUsage(lastUsage));
          }
          break;

        case 'max_iterations':
          console.log(c.yellow(`\nReached maximum iterations (${event.count}). Stopping.`));
          break;

        case 'error':
          console.error(c.red(`\nError: ${event.message}`));
          break;
      }
    }

    if (format === 'json') {
      console.log(JSON.stringify(messages, null, 2));
    }
  } catch (error) {
    console.error(formatError(error instanceof Error ? error.message : String(error)));
  }
}

// --- Project Init ---

async function initProjectDir(cwd: string): Promise<void> {
  const c = getChalk();
  const veniceDir = path.join(cwd, '.venice');

  try {
    await fs.mkdir(veniceDir, { recursive: true });

    const contextPath = path.join(veniceDir, 'context.md');
    try {
      await fs.access(contextPath);
      console.log(c.dim(`${contextPath} already exists, skipping.`));
    } catch {
      await fs.writeFile(contextPath, `# Project Context

<!-- This file is included in the system prompt when running venice code. -->
<!-- Add project-specific instructions, conventions, and context here. -->

## Overview

<!-- What does this project do? -->

## Conventions

<!-- Coding standards, naming conventions, etc. -->

## Important Notes

<!-- Anything the AI should know when working on this codebase. -->
`, 'utf-8');
      console.log(`Created ${contextPath}`);
    }

    // Add .venice/ to .gitignore if git repo
    const projectRoot = await findProjectRoot(cwd);
    if (projectRoot) {
      const gitignorePath = path.join(projectRoot, '.gitignore');
      try {
        const existing = await fs.readFile(gitignorePath, 'utf-8');
        if (!existing.includes('.venice/')) {
          await fs.appendFile(gitignorePath, '\n# Venice CLI\n.venice/\n');
          console.log(`Added .venice/ to ${gitignorePath}`);
        }
      } catch {
        // No .gitignore, create one
        await fs.writeFile(gitignorePath, '# Venice CLI\n.venice/\n', 'utf-8');
        console.log(`Created ${gitignorePath} with .venice/ entry`);
      }
    }

    console.log(c.green('\nProject initialized. Edit .venice/context.md to add project-specific instructions.'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(formatError(`Failed to initialize: ${msg}`));
    process.exit(1);
  }
}

// --- Helpers ---

function formatArgsSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => {
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      const truncated = str.length > 80 ? str.slice(0, 80) + '...' : str;
      return `${key}=${truncated}`;
    })
    .join(' ');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data.trim()); });
    process.stdin.resume();
  });
}

function saveConversation(messages: Message[], model: string): void {
  addConversation({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    messages,
    model,
  });
}
