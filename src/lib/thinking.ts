/**
 * Thinking Block Parser
 *
 * Handles <think>...</think> tags in streaming responses from reasoning models.
 * Buffers thinking content, strips from final output, yields separately.
 */

export interface ThinkingState {
  inThinkingBlock: boolean;
  thinkingBuffer: string;
  tagBuffer: string; // partial tags at chunk boundaries
}

export function createThinkingState(): ThinkingState {
  return { inThinkingBlock: false, thinkingBuffer: '', tagBuffer: '' };
}

export interface ParsedChunk {
  content: string;    // visible content to display
  thinking: string;   // thinking content (dimmed or hidden)
}

export function processThinkingChunk(text: string, state: ThinkingState): ParsedChunk {
  let content = '';
  let thinking = '';

  // Prepend any buffered partial tag from previous chunk
  const input = state.tagBuffer + text;
  state.tagBuffer = '';

  let i = 0;
  while (i < input.length) {
    if (state.inThinkingBlock) {
      // Look for </think>
      const closeIdx = input.indexOf('</think>', i);
      if (closeIdx !== -1) {
        thinking += input.slice(i, closeIdx);
        state.thinkingBuffer += input.slice(i, closeIdx);
        state.inThinkingBlock = false;
        i = closeIdx + '</think>'.length;
      } else {
        // Check for partial closing tag at end
        const remaining = input.slice(i);
        const partialClose = findPartialTag(remaining, '</think>');
        if (partialClose > 0) {
          thinking += remaining.slice(0, -partialClose);
          state.thinkingBuffer += remaining.slice(0, -partialClose);
          state.tagBuffer = remaining.slice(-partialClose);
          break;
        }
        thinking += remaining;
        state.thinkingBuffer += remaining;
        break;
      }
    } else {
      // Look for <think>
      const openIdx = input.indexOf('<think>', i);
      if (openIdx !== -1) {
        content += input.slice(i, openIdx);
        state.inThinkingBlock = true;
        i = openIdx + '<think>'.length;
      } else {
        // Check for partial opening tag at end
        const remaining = input.slice(i);
        const partialOpen = findPartialTag(remaining, '<think>');
        if (partialOpen > 0) {
          content += remaining.slice(0, -partialOpen);
          state.tagBuffer = remaining.slice(-partialOpen);
          break;
        }
        content += remaining;
        break;
      }
    }
  }

  return { content, thinking };
}

/**
 * Check if the end of `text` could be the start of `tag`.
 * Returns the number of characters that match, or 0.
 */
function findPartialTag(text: string, tag: string): number {
  for (let len = Math.min(text.length, tag.length - 1); len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Strip thinking blocks from a complete string (for message history cleanup).
 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
