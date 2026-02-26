/**
 * Venice AI API Client
 * 
 * Handles all API communication with retry logic and error handling.
 */

import { requireApiKey, trackUsage } from './config.js';
import { startSpinner, stopSpinner } from './output.js';
import { getVersion } from './version.js';
import type { Message, ToolDefinition, Model, Character } from '../types/index.js';

const VENICE_API = 'https://api.venice.ai/api/v1';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes default timeout

export class VeniceApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'VeniceApiError';
  }

  static fromResponse(status: number, body: string): VeniceApiError {
    try {
      const json = JSON.parse(body);
      const message = json.error?.message || json.message || body;
      const code = json.error?.code;
      return new VeniceApiError(message, status, code);
    } catch {
      return new VeniceApiError(body || `HTTP ${status}`, status);
    }
  }

  isRetryable(): boolean {
    // Retry on network errors and 5xx
    if (!this.statusCode) return true;
    return this.statusCode >= 500 && this.statusCode < 600;
  }

  isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  isRateLimited(): boolean {
    return this.statusCode === 429;
  }
}

function getHeaders(): Record<string, string> {
  return {
    'Authorization': `Bearer ${requireApiKey()}`,
    'Content-Type': 'application/json',
    'User-Agent': `venice-cli/${getVersion()}`,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkOnline(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    await fetch('https://api.venice.ai/api/v1/models', {
      method: 'HEAD',
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    stream?: boolean;
    retries?: number;
    showSpinner?: boolean;
    spinnerText?: string;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const {
    method = 'GET',
    body,
    stream = false,
    retries = MAX_RETRIES,
    showSpinner = true,
    spinnerText = 'Processing...',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  let spinner = showSpinner && !stream ? startSpinner(spinnerText) : null;
  let lastError: VeniceApiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${VENICE_API}${endpoint}`, {
        method,
        headers: getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        throw VeniceApiError.fromResponse(response.status, errorBody);
      }

      if (spinner) {
        stopSpinner(true);
        spinner = null;
      }

      if (stream) {
        return response as unknown as T;
      }

      return await response.json() as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        if (spinner) stopSpinner(false, 'Request timed out');
        throw new Error(
          `Request timed out after ${timeoutMs / 1000} seconds.\n` +
          'The server may be overloaded. Please try again later.'
        );
      }

      if (error instanceof VeniceApiError) {
        lastError = error;

        if (error.isAuthError()) {
          if (spinner) stopSpinner(false, 'Authentication failed');
          throw new Error(
            'Authentication failed. Please check your API key.\n' +
            'Update with: venice config set api_key <your-key>'
          );
        }

        if (error.isRateLimited()) {
          if (spinner) spinner.text = `Rate limited, waiting... (attempt ${attempt + 1}/${retries + 1})`;
          await sleep(RETRY_DELAY_MS * (attempt + 1) * 2);
          continue;
        }

        if (error.isRetryable() && attempt < retries) {
          if (spinner) spinner.text = `Retrying... (attempt ${attempt + 2}/${retries + 1})`;
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
      } else if (error instanceof Error) {
        if (attempt < retries) {
          const online = await checkOnline();
          if (!online) {
            if (spinner) stopSpinner(false, 'Network error');
            throw new Error(
              'Unable to connect to Venice API.\n' +
              'Please check your internet connection.'
            );
          }
          if (spinner) spinner.text = `Connection error, retrying... (attempt ${attempt + 2}/${retries + 1})`;
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        lastError = new VeniceApiError(error.message);
      }

      if (spinner) stopSpinner(false);
      throw lastError || error;
    }
  }

  if (spinner) stopSpinner(false);
  throw lastError || new Error('Request failed after retries');
}

// Chat completion (non-streaming)
export async function chatCompletion(
  messages: Message[],
  options: {
    model?: string;
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    venice_parameters?: Record<string, unknown>;
  } = {}
): Promise<{
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason: string;
}> {
  const body: Record<string, unknown> = {
    model: options.model || 'kimi-k2-5',
    messages,
    stream: false,
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }

  if (options.venice_parameters) {
    body.venice_parameters = options.venice_parameters;
  }

  const response = await apiRequest<{
    choices: Array<{
      message: { content: string; tool_calls?: any[] };
      finish_reason: string;
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>('/chat/completions', {
    method: 'POST',
    body,
    spinnerText: 'Thinking...',
  });

  const choice = response.choices?.[0];
  const usage = response.usage;

  // Track usage
  if (usage) {
    trackUsage({
      command: 'chat',
      model: options.model || 'kimi-k2-5',
      ...usage,
    });
  }

  return {
    content: choice?.message?.content || '',
    tool_calls: choice?.message?.tool_calls,
    usage,
    finish_reason: choice?.finish_reason || 'stop',
  };
}

// Chat completion (streaming)
export async function* chatCompletionStream(
  messages: Message[],
  options: {
    model?: string;
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    venice_parameters?: Record<string, unknown>;
  } = {}
): AsyncGenerator<{
  content?: string;
  tool_calls?: any[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  done: boolean;
}> {
  const body: Record<string, unknown> = {
    model: options.model || 'kimi-k2-5',
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }

  if (options.venice_parameters) {
    body.venice_parameters = options.venice_parameters;
  }

  const response = await apiRequest<Response>('/chat/completions', {
    method: 'POST',
    body,
    stream: true,
    showSpinner: false,
  });

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let totalUsage: any = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            if (totalUsage) {
              trackUsage({
                command: 'chat',
                model: options.model || 'kimi-k2-5',
                ...totalUsage,
              });
            }
            yield { done: true, usage: totalUsage };
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            
            if (json.usage) {
              totalUsage = json.usage;
            }

            if (delta?.content) {
              yield { content: delta.content, done: false };
            }

            if (delta?.tool_calls) {
              yield { tool_calls: delta.tool_calls, done: false };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { done: true, usage: totalUsage };
}

// Image generation
export async function generateImage(
  prompt: string,
  options: {
    model?: string;
    width?: number;
    height?: number;
    n?: number;
  } = {}
): Promise<{ url: string; revised_prompt?: string }[]> {
  const body = {
    model: options.model || 'flux-2-pro',
    prompt,
    width: options.width || 1024,
    height: options.height || 1024,
    n: options.n || 1,
  };

  const response = await apiRequest<{
    data: Array<{ url: string; revised_prompt?: string }>;
  }>('/images/generations', {
    method: 'POST',
    body,
    spinnerText: 'Generating image...',
  });

  trackUsage({
    command: 'image',
    model: options.model || 'flux-2-pro',
  });

  return response.data;
}

// Image upscale
export async function upscaleImage(
  imagePath: string,
  options: {
    model?: string;
    scale?: number;
  } = {}
): Promise<{ url: string }> {
  const fs = await import('fs');
  const path = await import('path');

  if (!fs.existsSync(imagePath)) {
    throw new Error(`File not found: ${imagePath}`);
  }

  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = path.extname(imagePath).slice(1) || 'png';
  const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

  const body = {
    model: options.model || 'upscaler',
    image: `data:${mimeType};base64,${base64}`,
    scale: options.scale || 2,
  };

  const response = await apiRequest<{
    data: Array<{ url: string }>;
  }>('/images/upscale', {
    method: 'POST',
    body,
    spinnerText: 'Upscaling image...',
  });

  trackUsage({
    command: 'upscale',
    model: options.model || 'upscaler',
  });

  return response.data[0];
}

// Text to speech
export async function textToSpeech(
  text: string,
  options: {
    model?: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
  } = {}
): Promise<ArrayBuffer> {
  const body = {
    model: options.model || 'tts-kokoro',
    input: text,
    voice: options.voice || 'af_sky',
    response_format: options.format || 'mp3',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${VENICE_API}/audio/speech`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      throw VeniceApiError.fromResponse(response.status, error);
    }

    trackUsage({
      command: 'tts',
      model: options.model || 'tts-kokoro',
    });

    return response.arrayBuffer();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Text-to-speech request timed out. Please try with shorter text.');
    }
    throw error;
  }
}

// Transcription (STT)
export async function transcribe(
  audioPath: string,
  options: {
    model?: string;
    language?: string;
    timestamps?: boolean;
  } = {}
): Promise<{
  text: string;
  duration?: number;
  timestamps?: {
    word?: Array<{ word: string; start: number; end: number }>;
    segment?: Array<{ text: string; start: number; end: number }>;
  };
}> {
  const fs = await import('fs');
  const path = await import('path');

  if (!fs.existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  const audioData = fs.readFileSync(audioPath);
  const base64 = audioData.toString('base64');
  const ext = path.extname(audioPath).slice(1) || 'mp3';

  const body: Record<string, unknown> = {
    model: options.model || 'nvidia/parakeet-tdt-0.6b-v3',
    file: `data:audio/${ext};base64,${base64}`,
    response_format: 'json',
  };

  if (options.language) {
    body.language = options.language;
  }

  if (options.timestamps) {
    body.timestamps = true;
  }

  const response = await apiRequest<{
    text: string;
    duration?: number;
    timestamps?: {
      word?: Array<{ word: string; start: number; end: number }>;
      segment?: Array<{ text: string; start: number; end: number }>;
    };
  }>('/audio/transcriptions', {
    method: 'POST',
    body,
    spinnerText: 'Transcribing...',
  });

  trackUsage({
    command: 'transcribe',
    model: options.model || 'nvidia/parakeet-tdt-0.6b-v3',
  });

  return response;
}

// Embeddings
export async function generateEmbeddings(
  input: string | string[],
  options: {
    model?: string;
  } = {}
): Promise<{ embedding: number[]; index: number }[]> {
  const body = {
    model: options.model || 'text-embedding-ada-002',
    input: Array.isArray(input) ? input : [input],
  };

  const response = await apiRequest<{
    data: Array<{ embedding: number[]; index: number }>;
  }>('/embeddings', {
    method: 'POST',
    body,
    spinnerText: 'Generating embeddings...',
  });

  trackUsage({
    command: 'embeddings',
    model: options.model || 'text-embedding-ada-002',
  });

  return response.data;
}

// List models
export async function listModels(): Promise<Model[]> {
  const response = await apiRequest<{
    data: Model[];
  }>('/models', {
    method: 'GET',
    spinnerText: 'Fetching models...',
  });

  return response.data || [];
}

// List characters (if Venice supports this endpoint)
export async function listCharacters(): Promise<Character[]> {
  try {
    const response = await apiRequest<{
      data: Character[];
    }>('/characters', {
      method: 'GET',
      spinnerText: 'Fetching characters...',
      retries: 0,
    });
    return response.data || [];
  } catch {
    // Characters endpoint might not exist
    return [];
  }
}

// Video generation - queue job
export async function queueVideoGeneration(
  prompt: string,
  options: {
    model?: string;
    duration?: string;
    aspectRatio?: string;
    imageUrl?: string;
  } = {}
): Promise<{ queue_id: string; model: string }> {
  const body: Record<string, unknown> = {
    model: options.model || 'wan-2.6-image-to-video',
    prompt,
  };

  if (options.duration) {
    body.duration = options.duration;
  }
  if (options.aspectRatio) {
    body.aspect_ratio = options.aspectRatio;
  }
  if (options.imageUrl) {
    body.image_url = options.imageUrl;
  }

  const response = await apiRequest<{
    queue_id: string;
    model: string;
  }>('/video/generate', {
    method: 'POST',
    body,
    spinnerText: 'Queueing video generation...',
  });

  trackUsage({
    command: 'video',
    model: options.model || 'wan-2.6-image-to-video',
  });

  return response;
}

// Video generation - check status
export async function getVideoStatus(
  queueId: string
): Promise<{
  status: 'pending' | 'processing' | 'completed' | 'failed';
  video_url?: string;
  error?: string;
  progress?: number;
}> {
  return apiRequest(`/video/status/${queueId}`, {
    method: 'GET',
    spinnerText: 'Checking video status...',
  });
}

// Video generation - retrieve video
export async function retrieveVideo(
  queueId: string
): Promise<{
  video_url: string;
  model: string;
  duration?: number;
}> {
  return apiRequest(`/video/retrieve/${queueId}`, {
    method: 'GET',
    spinnerText: 'Retrieving video...',
  });
}

// Web search via chat
export async function webSearch(
  query: string,
  options: {
    model?: string;
    maxResults?: number;
    enableCitations?: boolean;
    enableScraping?: boolean;
  } = {}
): Promise<{
  content: string;
  citations?: Array<{ title: string; url: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const veniceParams: Record<string, unknown> = {
    enable_web_search: 'on',
  };

  if (options.maxResults) {
    veniceParams.web_search_max_results = options.maxResults;
  }
  if (options.enableCitations) {
    veniceParams.enable_web_citations = true;
  }
  if (options.enableScraping) {
    veniceParams.enable_web_scraping = true;
  }

  const response = await chatCompletion(
    [{ role: 'user', content: query }],
    {
      model: options.model,
      venice_parameters: veniceParams,
    }
  );

  return {
    content: response.content,
    usage: response.usage,
  };
}
