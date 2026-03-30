/**
 * AI Agent with tool-calling loop
 */

import type { Message, ToolCall, AgentContext, AgentResult, AgentStep } from '../types/index.js';
import { createChatCompletion, createChatCompletionStream, parseSSEStream } from '../api/client.js';
import { getAllToolDefinitions, executeTool } from '../tools/index.js';
import { logInfo, logDebug, startSpinner, stopSpinner } from '../utils/logger.js';

const MAX_ITERATIONS = 10;

/**
 * Run agent loop with tool calling
 */
export async function runAgent(
  context: AgentContext,
  options: {
    stream?: boolean;
    maxIterations?: number;
    onStep?: (step: AgentStep) => void;
    onChunk?: (content: string) => void;
  } = {}
): Promise<AgentResult> {
  const {
    stream = true,
    maxIterations = MAX_ITERATIONS,
    onStep,
    onChunk,
  } = options;

  const { messages, config } = context;
  const steps: AgentStep[] = [];
  const conversationMessages: Message[] = [...messages];

  let iteration = 0;
  let finalMessage = '';

  try {
    while (iteration < maxIterations) {
      iteration++;

      logDebug(`Agent iteration ${iteration}/${maxIterations}`, config.verbose);

      // Get tool definitions
      const tools = getAllToolDefinitions();

      // Create chat completion
      if (stream && iteration === 1) {
        // Stream only the first user-facing response
        const streamResponse = await createChatCompletionStream({
          model: config.default_model,
          messages: conversationMessages,
          tools,
          tool_choice: 'auto',
          temperature: 0.7,
        });

        let currentMessage = '';
        let currentToolCalls: ToolCall[] = [];

        for await (const chunk of parseSSEStream(streamResponse)) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          
          const delta = (choice as any).delta;

          if (delta?.content) {
            currentMessage += delta.content;
            if (onChunk) {
              onChunk(delta.content);
            }
          }

          if (delta?.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index || 0;
              
              if (!currentToolCalls[index]) {
                currentToolCalls[index] = {
                  id: toolCall.id || '',
                  type: 'function',
                  function: {
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '',
                  },
                };
              } else {
                // Update ID if it arrives in a later delta
                if (toolCall.id && !currentToolCalls[index].id) {
                  currentToolCalls[index].id = toolCall.id;
                }
                // Only concatenate arguments (name should be set once)
                if (toolCall.function?.arguments) {
                  currentToolCalls[index].function.arguments += toolCall.function.arguments;
                }
              }
            }
          }

          const finishReason = chunk.choices[0]?.finish_reason;
          if (finishReason) {
            if (finishReason === 'stop') {
              finalMessage = currentMessage;
              
              steps.push({
                type: 'final',
                content: currentMessage,
                timestamp: new Date(),
              });

              if (onStep) {
                onStep(steps[steps.length - 1]);
              }

              return {
                success: true,
                message: finalMessage,
                steps,
              };
            } else if (finishReason === 'tool_calls') {
              // Handle tool calls
              conversationMessages.push({
                role: 'assistant',
                content: currentMessage || '',
                tool_calls: currentToolCalls.filter(tc => tc.id),
              });

              steps.push({
                type: 'tool_call',
                content: currentToolCalls,
                timestamp: new Date(),
              });

              if (onStep) {
                onStep(steps[steps.length - 1]);
              }

              // Execute tools
              await executeToolCalls(currentToolCalls, conversationMessages, steps, config.verbose, onStep);
              
              // Continue loop for next iteration
              break;
            }
          }
        }
      } else {
        // Non-streaming request
        startSpinner('Thinking...');

        const response = await createChatCompletion({
          model: config.default_model,
          messages: conversationMessages,
          tools,
          tool_choice: 'auto',
          temperature: 0.7,
        });

        stopSpinner(true);

        const message = response.choices[0].message;
        const finishReason = response.choices[0].finish_reason;

        if (finishReason === 'stop') {
          finalMessage = message.content;
          
          steps.push({
            type: 'final',
            content: message.content,
            timestamp: new Date(),
          });

          if (onStep) {
            onStep(steps[steps.length - 1]);
          }

          return {
            success: true,
            message: finalMessage,
            steps,
          };
        } else if (finishReason === 'tool_calls' && message.tool_calls) {
          conversationMessages.push(message);

          steps.push({
            type: 'tool_call',
            content: message.tool_calls,
            timestamp: new Date(),
          });

          if (onStep) {
            onStep(steps[steps.length - 1]);
          }

          // Execute tools
          await executeToolCalls(message.tool_calls, conversationMessages, steps, config.verbose, onStep);
        } else {
          // Unexpected finish reason
          return {
            success: false,
            message: 'Unexpected response from model',
            steps,
            error: `Unexpected finish reason: ${finishReason}`,
          };
        }
      }
    }

    return {
      success: false,
      message: 'Max iterations reached',
      steps,
      error: 'Agent exceeded maximum iterations',
    };
  } catch (error) {
    return {
      success: false,
      message: '',
      steps,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute tool calls and add results to conversation
 */
async function executeToolCalls(
  toolCalls: ToolCall[],
  messages: Message[],
  steps: AgentStep[],
  verbose: boolean,
  onStep?: (step: AgentStep) => void
): Promise<void> {
  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    let args: any;

    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    logInfo(`Executing tool: ${toolName}`);
    logDebug(`Tool args: ${JSON.stringify(args, null, 2)}`, verbose);

    const result = await executeTool(toolName, args);

    logDebug(`Tool result: ${result.slice(0, 200)}...`, verbose);

    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: result,
    });

    const step: AgentStep = {
      type: 'tool_result',
      content: { tool: toolName, args, result },
      timestamp: new Date(),
    };

    steps.push(step);

    if (onStep) {
      onStep(step);
    }
  }
}
