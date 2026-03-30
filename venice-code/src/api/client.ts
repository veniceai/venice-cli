/**
 * Venice API client for chat completions and embeddings
 */

import { getApiKey } from '../config/config.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types/index.js';

const VENICE_API_BASE = process.env.VENICE_API_BASE_URL || 'https://api.venice.ai/api/v1';
const REQUEST_TIMEOUT = 120000; // 2 minutes

export class VeniceApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'VeniceApiError';
  }
}

/**
 * Make a request to Venice API
 */
async function makeRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    stream?: boolean;
  } = {}
): Promise<T> {
  const apiKey = await getApiKey();
  const { method = 'POST', body, stream = false } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${VENICE_API_BASE}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = errorText;
      
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorText;
      } catch {
        // Use raw error text
      }

      throw new VeniceApiError(
        errorMessage || `HTTP ${response.status}`,
        response.status
      );
    }

    if (stream) {
      return response as unknown as T;
    }

    const data = await response.json();
    return data as T;
  } catch (error) {
    clearTimeout(timeout);
    
    if (error instanceof VeniceApiError) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new VeniceApiError('Request timeout');
      }
      throw new VeniceApiError(error.message);
    }

    throw new VeniceApiError('Unknown error occurred');
  }
}

/**
 * Create a chat completion
 */
export async function createChatCompletion(
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  return makeRequest<ChatCompletionResponse>('/chat/completions', {
    method: 'POST',
    body: request,
  });
}

/**
 * Create a streaming chat completion
 */
export async function createChatCompletionStream(
  request: ChatCompletionRequest
): Promise<ReadableStream<Uint8Array>> {
  const response = await makeRequest<Response>('/chat/completions', {
    method: 'POST',
    body: { ...request, stream: true },
    stream: true,
  });

  if (!response.body) {
    throw new VeniceApiError('No response body for streaming');
  }

  return response.body;
}

/**
 * Parse SSE stream chunks
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ChatCompletionResponse, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        
        if (!trimmed || trimmed === 'data: [DONE]') {
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data);
            yield parsed as ChatCompletionResponse;
          } catch (error) {
            console.error('Failed to parse SSE data:', data);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Create embeddings
 */
export async function createEmbedding(
  request: EmbeddingRequest
): Promise<EmbeddingResponse> {
  return makeRequest<EmbeddingResponse>('/embeddings', {
    method: 'POST',
    body: request,
  });
}

/**
 * Test API connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const apiKey = await getApiKey();
    const response = await fetch(`${VENICE_API_BASE}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
