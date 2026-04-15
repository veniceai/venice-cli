/**
 * Agentic Loop - Multi-pass tool execution loop
 *
 * Wraps chatCompletionStream() in a loop that keeps calling the API
 * until the model stops requesting tool calls or max iterations is reached.
 */

import { chatCompletionStream } from './api.js';
import { getCodingTool } from '../tools/index.js';
import { createThinkingState, processThinkingChunk, stripThinkingBlocks } from './thinking.js';
import { truncateMessages } from './context-manager.js';
import type { Message, ToolCall, ToolDefinition, CodingTool, ToolContext, AgentEvent } from '../types/index.js';

const DEFAULT_MAX_ITERATIONS = 25;

// --- Shared types extracted from chat.ts ---

export interface StreamToolCallDelta {
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

// --- Shared utility functions ---

export function reconstructStreamToolCalls(toolCallDeltas: StreamToolCallDelta[]): ToolCall[] {
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
        function: { name: '', arguments: '' },
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
      if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
      if (a.index !== undefined) return -1;
      if (b.index !== undefined) return 1;
      return a.order - b.order;
    })
    .map((tc, position): ToolCall => ({
      id: tc.id || `stream_tool_call_${tc.index ?? position}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
}

export function parseToolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  const rawArgs = toolCall.function.arguments?.trim();
  if (!rawArgs) return {};

  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON arguments for tool "${toolCall.function.name}" (id: ${toolCall.id}): ${reason}`
    );
  }
}

// --- Agent Loop ---

export interface AgentLoopOptions {
  model: string;
  fastModel?: string; // for simple queries that don't need tools
  tools: CodingTool[];
  toolContext: ToolContext;
  veniceParams?: Record<string, unknown>;
  maxIterations?: number;
  maxBudgetTokens?: number;
  parallelToolExecution?: boolean; // run read-only tools concurrently
}

export async function* agentLoop(
  messages: Message[],
  options: AgentLoopOptions
): AsyncGenerator<AgentEvent> {
  const {
    model,
    fastModel,
    tools,
    toolContext,
    veniceParams,
    parallelToolExecution = true,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxBudgetTokens,
  } = options;

  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  let totalTokensUsed = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Context window management: truncate old tool results if needed
    const { truncated } = truncateMessages(messages, model);
    if (truncated > 0) {
      yield { type: 'thinking', text: `[Truncated ${truncated} old tool results to fit context window]` };
    }

    let fullContent = '';
    let rawContent = ''; // includes thinking blocks for history
    const collectedToolCalls: StreamToolCallDelta[] = [];
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

    // Thinking block state for this iteration
    const thinkingState = createThinkingState();

    // Model routing: use fast model for follow-up iterations (tool results -> response)
    // First iteration uses the main model; subsequent iterations can use fast model
    // if one is configured, since the heavy reasoning was already done.
    const iterationModel = (iteration > 0 && fastModel) ? fastModel : model;

    // Stream one API response
    const streamOptions: {
      model: string;
      tools?: ToolDefinition[];
      venice_parameters?: Record<string, unknown>;
    } = { model: iterationModel };

    if (toolDefs.length > 0) {
      streamOptions.tools = toolDefs;
    }
    if (veniceParams && Object.keys(veniceParams).length > 0) {
      streamOptions.venice_parameters = veniceParams;
    }

    for await (const chunk of chatCompletionStream(messages, streamOptions)) {
      if (chunk.content) {
        rawContent += chunk.content;

        // Parse thinking blocks
        const parsed = processThinkingChunk(chunk.content, thinkingState);
        if (parsed.thinking) {
          yield { type: 'thinking', text: parsed.thinking };
        }
        if (parsed.content) {
          fullContent += parsed.content;
          yield { type: 'content', text: parsed.content };
        }
      }

      if (chunk.tool_calls) {
        collectedToolCalls.push(...(chunk.tool_calls as StreamToolCallDelta[]));
      }

      if (chunk.usage) {
        usage = chunk.usage;
      }

      if (chunk.done) break;
    }

    // Track budget
    if (usage) {
      totalTokensUsed += usage.total_tokens;
    }

    // No tool calls -- model is done
    if (collectedToolCalls.length === 0) {
      if (fullContent) {
        // Store stripped content in history to save context
        messages.push({ role: 'assistant', content: stripThinkingBlocks(rawContent) });
      }
      if (usage) {
        yield { type: 'usage', data: { ...usage, total_tokens: totalTokensUsed } };
      }
      yield { type: 'done' };
      return;
    }

    // Reconstruct tool calls from streaming deltas
    const toolCalls = reconstructStreamToolCalls(collectedToolCalls);

    // Push the assistant message with tool_calls (strip thinking from stored content)
    messages.push({
      role: 'assistant',
      content: stripThinkingBlocks(rawContent),
      tool_calls: toolCalls,
    });

    // Partition tool calls into read-only (parallelizable) and write (sequential)
    const parsed: Array<{ toolCall: ToolCall; args: Record<string, unknown>; tool: CodingTool | undefined }> = [];
    for (const toolCall of toolCalls) {
      if (!toolCall.function.name) {
        yield { type: 'error', message: `Incomplete tool call received (id: "${toolCall.id}")` };
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = parseToolCallArguments(toolCall);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: msg };
        messages.push({ role: 'tool', content: `Error: ${msg}`, tool_call_id: toolCall.id });
        continue;
      }
      parsed.push({ toolCall, args, tool: getCodingTool(toolCall.function.name) });
    }

    // Check if all tools are read-only for parallel execution
    const allReadOnly = parallelToolExecution && parsed.length > 1 &&
      parsed.every((p) => p.tool?.isReadOnly);

    if (allReadOnly) {
      // Execute all read-only tools in parallel
      for (const p of parsed) {
        yield { type: 'tool_call', name: p.toolCall.function.name, args: p.args };
      }
      const results = await Promise.all(
        parsed.map(async (p) => {
          if (!p.tool) return { name: p.toolCall.function.name, id: p.toolCall.id, output: `Unknown tool: ${p.toolCall.function.name}`, error: true };
          try {
            const result = await p.tool.execute(p.args, toolContext);
            return { name: p.toolCall.function.name, id: p.toolCall.id, ...result };
          } catch (err) {
            return { name: p.toolCall.function.name, id: p.toolCall.id, output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, error: true };
          }
        })
      );
      for (const result of results) {
        yield { type: 'tool_result', name: result.name, result: { output: result.output, error: result.error } };
        messages.push({ role: 'tool', content: result.output, tool_call_id: result.id });
      }
    } else {
      // Execute sequentially
      for (const { toolCall, args, tool } of parsed) {
        yield { type: 'tool_call', name: toolCall.function.name, args };

        if (!tool) {
          const errMsg = `Unknown tool: ${toolCall.function.name}`;
          yield { type: 'tool_result', name: toolCall.function.name, result: { output: errMsg, error: true } };
          messages.push({ role: 'tool', content: errMsg, tool_call_id: toolCall.id });
          continue;
        }

        try {
          const result = await tool.execute(args, toolContext);
          yield { type: 'tool_result', name: toolCall.function.name, result };
          messages.push({ role: 'tool', content: result.output, tool_call_id: toolCall.id });
        } catch (err) {
          const errMsg = `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
          yield { type: 'tool_result', name: toolCall.function.name, result: { output: errMsg, error: true } };
          messages.push({ role: 'tool', content: errMsg, tool_call_id: toolCall.id });
        }
      }
    }

    if (usage) {
      yield { type: 'usage', data: { ...usage, total_tokens: totalTokensUsed } };
    }

    // Budget check
    if (maxBudgetTokens && totalTokensUsed >= maxBudgetTokens) {
      yield { type: 'error', message: `Token budget exhausted (${totalTokensUsed}/${maxBudgetTokens} tokens used). Stopping.` };
      return;
    }
    if (maxBudgetTokens && totalTokensUsed >= maxBudgetTokens * 0.8) {
      yield { type: 'thinking', text: `[Budget warning: ${totalTokensUsed}/${maxBudgetTokens} tokens used (${Math.round(totalTokensUsed / maxBudgetTokens * 100)}%)]` };
    }

    // Loop continues -- next iteration will call the API again with tool results
  }

  // Hit max iterations
  yield { type: 'max_iterations', count: maxIterations };
}
