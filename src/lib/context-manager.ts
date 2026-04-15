/**
 * Context Window Manager
 *
 * Estimates token usage and truncates old tool results to stay within
 * model context limits.
 */

import type { Message } from '../types/index.js';

// Conservative token estimate: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;

// Default context window sizes by model family
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'kimi-k2': 256_000,
  'deepseek': 128_000,
  'llama-3.3': 128_000,
  'qwen3': 128_000,
  'grok': 128_000,
  'openai-gpt': 128_000,
  'mercury': 32_000,
  'gemma': 128_000,
  'claude': 200_000,
};

const DEFAULT_LIMIT = 128_000;
const TRUNCATION_THRESHOLD = 0.75; // Start truncating at 75% of limit
const TOOL_RESULT_PLACEHOLDER = '[Previous tool output truncated to save context. Re-read the file if needed.]';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || '');
    // Overhead per message (role, formatting)
    total += 4;
    if (msg.tool_calls) {
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

export function getModelContextLimit(model: string): number {
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) return limit;
  }
  return DEFAULT_LIMIT;
}

/**
 * Truncate old tool result messages to fit within the context window.
 * Preserves system prompt, recent messages, and the structure of the conversation.
 * Replaces the content of old tool messages with a placeholder.
 */
export function truncateMessages(messages: Message[], model: string): { messages: Message[]; truncated: number } {
  const limit = getModelContextLimit(model);
  const threshold = Math.floor(limit * TRUNCATION_THRESHOLD);
  let truncated = 0;

  let currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= threshold) {
    return { messages, truncated: 0 };
  }

  // Find tool result messages to truncate, oldest first.
  // Never truncate: system messages, the last 6 messages (recent context).
  const protectedCount = 6;
  const candidates: number[] = [];

  for (let i = 0; i < messages.length - protectedCount; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && msg.content.length > TOOL_RESULT_PLACEHOLDER.length) {
      candidates.push(i);
    }
  }

  // Truncate from oldest until under threshold
  for (const idx of candidates) {
    if (currentTokens <= threshold) break;

    const oldTokens = estimateTokens(messages[idx].content);
    messages[idx] = {
      ...messages[idx],
      content: TOOL_RESULT_PLACEHOLDER,
    };
    const newTokens = estimateTokens(TOOL_RESULT_PLACEHOLDER);
    currentTokens -= (oldTokens - newTokens);
    truncated++;
  }

  return { messages, truncated };
}
