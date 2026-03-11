/**
 * Chat Command - Interactive chat with AI models
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import {
  chatCompletion,
  chatCompletionStream,
} from '../lib/api.js';
import {
  getDefaultModel,
  addConversation,
  getLastConversation,
} from '../lib/config.js';
import {
  getToolDefinitions,
  executeTool,
  formatToolsHelp,
} from '../lib/tools.js';
import {
  formatUsage,
  formatError,
  getChalk,
  startSpinner,
  clearSpinner,
  detectOutputFormat,
  isPiped,
} from '../lib/output.js';
import type { Message, OutputFormat, ToolCall } from '../types/index.js';

export function registerChatCommand(program: Command): void {
  program
    .command('chat [prompt...]')
    .description('Chat with an AI model')
    .option('-m, --model <model>', 'Model to use')
    .option('-s, --system <prompt>', 'System prompt')
    .option('-c, --character <name>', 'Character/persona to use')
    .option('-t, --tools <tools>', 'Comma-separated list of tools to enable')
    .option('--interactive-tools', 'Require approval for each tool call')
    .option('--continue', 'Continue the last conversation')
    .option('--no-stream', 'Disable streaming output')
    .option('--web-search', 'Enable web search for current information')
    .option('--no-thinking', 'Disable reasoning/thinking on reasoning models')
    .option('--strip-thinking', 'Strip thinking blocks from response')
    .option('--no-venice-prompt', 'Disable Venice system prompts')
    .option('--search-results-in-stream', 'Include search results in stream (when web-search enabled)')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .option('--list-tools', 'List available tools')
    .action(async (promptParts: string[], options) => {
      const c = getChalk();

      // Handle --list-tools
      if (options.listTools) {
        console.log(formatToolsHelp());
        return;
      }

      // Get prompt from args and optionally stdin
      let prompt = promptParts.join(' ');
      let pipedInput = '';

      if (!process.stdin.isTTY) {
        pipedInput = await readStdin();
      }

      const userMessage = buildChatUserMessage(prompt, pipedInput);
      if (!userMessage) {
        console.error(formatError('No prompt provided. Usage: venice chat "Your message"'));
        process.exit(1);
      }

      const model = options.model || getDefaultModel();
      const format = detectOutputFormat(options.format);
      const shouldStream = options.stream !== false && !isPiped() && format === 'pretty';

      // Build messages array
      const messages: Message[] = [];

      // Handle --continue flag
      if (options.continue) {
        const lastConv = getLastConversation();
        if (lastConv) {
          // Cast messages to proper type
          for (const msg of lastConv.messages) {
            messages.push(msg as Message);
          }
          if (format === 'pretty') {
            console.log(c.dim(`Continuing conversation (${lastConv.messages.length} previous messages)\n`));
          }
        }
      }

      // Add system prompt
      if (options.system) {
        messages.push({ role: 'system', content: options.system });
      } else if (options.character) {
        const systemPrompt = getCharacterPrompt(options.character);
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
      }

      // Add user message from stdin/args
      messages.push(userMessage);

      // Get tool definitions
      const toolNames = options.tools?.split(',').map((t: string) => t.trim()) || [];
      const tools = getToolDefinitions(toolNames);

      // Build venice_parameters
      const veniceParams: Record<string, unknown> = {};
      if (options.webSearch) {
        veniceParams.enable_web_search = 'on';
      }
      if (options.thinking === false) {
        veniceParams.disable_thinking = true;
      }
      if (options.stripThinking) {
        veniceParams.strip_thinking_response = true;
      }
      if (options.venicePrompt === false) {
        veniceParams.include_venice_system_prompt = false;
      }
      if (options.searchResultsInStream) {
        veniceParams.include_search_results_in_stream = true;
      }

      try {
        if (shouldStream) {
          await streamChat(messages, model, tools, options.interactiveTools, format, veniceParams);
        } else {
          await nonStreamChat(messages, model, tools, options.interactiveTools, format, veniceParams);
        }

        // Save to history
        addConversation({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          messages,
          model,
          character: options.character,
        });
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

async function streamChat(
  messages: Message[],
  model: string,
  tools: ReturnType<typeof getToolDefinitions>,
  interactiveTools: boolean,
  format: OutputFormat,
  veniceParams?: Record<string, unknown>
): Promise<void> {
  const c = getChalk();
  const spinner = startSpinner('Thinking...');

  let fullContent = '';
  let collectedToolCalls: StreamToolCallDelta[] = [];
  let usage: any = null;

  try {
    const streamOptions: { model: string; tools?: typeof tools; venice_parameters?: Record<string, unknown> } = { model, tools };
    if (veniceParams && Object.keys(veniceParams).length > 0) {
      streamOptions.venice_parameters = veniceParams;
    }
    for await (const chunk of chatCompletionStream(messages, streamOptions)) {
      if (chunk.content) {
        if (spinner) clearSpinner();
        process.stdout.write(chunk.content);
        fullContent += chunk.content;
      }

      if (chunk.tool_calls) {
        collectedToolCalls.push(...(chunk.tool_calls as StreamToolCallDelta[]));
      }

      if (chunk.usage) {
        usage = chunk.usage;
      }

      if (chunk.done) {
        break;
      }
    }

    // Handle tool calls
    if (collectedToolCalls.length > 0) {
      console.log('\n');
      const toolCalls = reconstructStreamToolCalls(collectedToolCalls);

      for (const toolCall of toolCalls) {
        if (!toolCall.function.name) {
          throw new Error(`Incomplete tool call received for id "${toolCall.id}"`);
        }

        const args = parseToolCallArguments(toolCall);
        const result = await executeTool(toolCall.function.name, args, { interactive: interactiveTools });

        console.log(c.dim(`\n[Tool: ${toolCall.function.name}]`));
        console.log(result);

        // Add tool result and get follow-up
        messages.push({
          role: 'assistant',
          content: fullContent,
          tool_calls: [toolCall],
        });
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });

        // Get follow-up response
        console.log('\n');
        for await (const chunk of chatCompletionStream(messages, { model })) {
          if (chunk.content) {
            process.stdout.write(chunk.content);
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
      }
    }

    console.log('\n');

    // Show usage
    if (usage && format === 'pretty') {
      console.log(formatUsage(usage));
    }
  } catch (error) {
    clearSpinner();
    throw error;
  }
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface AccumulatedStreamToolCall {
  order: number;
  index?: number;
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
}

function reconstructStreamToolCalls(toolCallDeltas: StreamToolCallDelta[]): ToolCall[] {
  const callsByIndex = new Map<number, AccumulatedStreamToolCall>();
  const callsById = new Map<string, AccumulatedStreamToolCall>();
  const orderedCalls: AccumulatedStreamToolCall[] = [];

  for (const [position, delta] of toolCallDeltas.entries()) {
    const index = typeof delta.index === 'number' ? delta.index : undefined;
    const id = typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : undefined;

    let accumulated: AccumulatedStreamToolCall | undefined;
    if (index !== undefined) {
      accumulated = callsByIndex.get(index);
    }
    if (!accumulated && id) {
      accumulated = callsById.get(id);
    }
    if (!accumulated && index !== undefined && orderedCalls[index] && orderedCalls[index].index === undefined) {
      accumulated = orderedCalls[index];
    }

    if (!accumulated) {
      accumulated = {
        order: position,
        index,
        id,
        function: {
          name: '',
          arguments: '',
        },
      };
      orderedCalls.push(accumulated);
    }

    if (index !== undefined) {
      accumulated.index = index;
      callsByIndex.set(index, accumulated);
    }

    if (id) {
      accumulated.id = id;
      callsById.set(id, accumulated);
    }

    if (delta.function?.name) {
      accumulated.function.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      accumulated.function.arguments += delta.function.arguments;
    }
  }

  return orderedCalls
    .sort((a, b) => {
      if (a.index !== undefined && b.index !== undefined) {
        return a.index - b.index;
      }
      if (a.index !== undefined) return -1;
      if (b.index !== undefined) return 1;
      return a.order - b.order;
    })
    .map((toolCall, position): ToolCall => ({
      id: toolCall.id || `stream_tool_call_${toolCall.index ?? position}`,
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }));
}

function parseToolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  const rawArgs = toolCall.function.arguments?.trim();
  if (!rawArgs) {
    return {};
  }

  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON arguments for tool "${toolCall.function.name}" (id: ${toolCall.id}): ${reason}`
    );
  }
}

async function nonStreamChat(
  messages: Message[],
  model: string,
  tools: ReturnType<typeof getToolDefinitions>,
  interactiveTools: boolean,
  format: OutputFormat,
  veniceParams?: Record<string, unknown>
): Promise<void> {
  const chatOptions: { model: string; tools?: typeof tools; venice_parameters?: Record<string, unknown> } = { model, tools };
  if (veniceParams && Object.keys(veniceParams).length > 0) {
    chatOptions.venice_parameters = veniceParams;
  }
  const response = await chatCompletion(messages, chatOptions);

  // Handle tool calls
  if (response.tool_calls?.length) {
    for (const toolCall of response.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments || '{}');
      const result = await executeTool(toolCall.function.name, args, { interactive: interactiveTools });

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: [toolCall],
      });
      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: toolCall.id,
      });
    }

    // Get follow-up
    const followUp = await chatCompletion(messages, { model });
    outputResponse(followUp.content, format);
    
    if (followUp.usage && format === 'pretty') {
      console.log(formatUsage(followUp.usage));
    }
  } else {
    outputResponse(response.content, format);
    
    if (response.usage && format === 'pretty') {
      console.log(formatUsage(response.usage));
    }
  }
}

function outputResponse(content: string, format: OutputFormat): void {
  switch (format) {
    case 'json':
      console.log(JSON.stringify({ content }, null, 2));
      break;
    case 'raw':
    case 'markdown':
      console.log(content);
      break;
    case 'pretty':
    default:
      console.log(content);
      break;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function buildChatUserMessage(prompt: string, pipedInput?: string): Message | null {
  if (pipedInput && prompt) {
    return { role: 'user', content: `${pipedInput}\n\n${prompt}` };
  }
  if (pipedInput) {
    return { role: 'user', content: pipedInput };
  }
  if (prompt) {
    return { role: 'user', content: prompt };
  }

  return null;
}

// Character prompts
const CHARACTER_PROMPTS: Record<string, string> = {
  pirate: 'You are a pirate captain. Respond in pirate speak with nautical terms, "arr"s, and maritime metaphors. Be adventurous and bold.',
  
  wizard: 'You are a wise wizard. Speak in mystical terms, reference ancient knowledge, and occasionally make cryptic prophecies. Use archaic language.',
  
  scientist: 'You are a brilliant scientist. Explain things with precision, reference data and studies, and maintain intellectual rigor. Be curious and analytical.',
  
  poet: 'You are a romantic poet. Express yourself with beautiful language, metaphors, and emotional depth. Find beauty in everything.',
  
  coder: 'You are a senior software engineer. Be practical, reference best practices, and provide code examples when relevant. Value clean, maintainable solutions.',
  
  teacher: 'You are a patient teacher. Explain concepts clearly, use examples, and check for understanding. Encourage learning and curiosity.',
  
  comedian: 'You are a stand-up comedian. Find humor in everything, make jokes, use wordplay, and keep things light. But still be helpful!',
  
  philosopher: 'You are a deep philosopher. Question assumptions, explore ideas from multiple angles, and ponder the nature of existence. Be thoughtful and profound.',
};

function getCharacterPrompt(character: string): string | undefined {
  return CHARACTER_PROMPTS[character.toLowerCase()];
}

export function getAvailableCharacters(): string[] {
  return Object.keys(CHARACTER_PROMPTS);
}
