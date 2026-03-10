/**
 * Venice AI API Client
 * 
 * Handles all API communication with retry logic and error handling.
 */

import { requireApiKey, trackUsage } from './config.js';
import { startSpinner, stopSpinner } from './output.js';
import { getVersion } from './version.js';
import { Readable } from 'stream';
import type { Message, ToolDefinition, Model, Character } from '../types/index.js';
import {
  MAX_UPSCALE_IMAGE_BYTES,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  assertFileSizeWithinLimit,
  mimeTypeFromPath,
} from './media.js';

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

// Image generation (Venice-native endpoint)
export async function generateImage(
  prompt: string,
  options: {
    model?: string;
    width?: number;
    height?: number;
    n?: number;
    format?: 'png' | 'jpeg' | 'webp';
  } = {}
): Promise<string[]> {
  const body: Record<string, unknown> = {
    model: options.model || 'flux-2-pro',
    prompt,
    width: options.width || 1024,
    height: options.height || 1024,
    format: options.format || 'png',
  };

  if (options.n && options.n > 1) {
    body.variants = options.n;
  }

  const response = await apiRequest<{
    id: string;
    images: string[];
  }>('/image/generate', {
    method: 'POST',
    body,
    spinnerText: 'Generating image...',
  });

  trackUsage({
    command: 'image',
    model: options.model || 'flux-2-pro',
  });

  return response.images;
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

  if (!fs.existsSync(imagePath)) {
    throw new Error(`File not found: ${imagePath}`);
  }

  assertFileSizeWithinLimit(imagePath, MAX_UPSCALE_IMAGE_BYTES, 'Image file for upscaling');

  const imageData = await fs.promises.readFile(imagePath);
  const base64 = imageData.toString('base64');
  const mimeType = mimeTypeFromPath(imagePath, 'image/png');

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

// Transcription (STT) -- requires multipart/form-data upload
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
  const crypto = await import('crypto');

  if (!fs.existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  const fileSize = assertFileSizeWithinLimit(
    audioPath,
    MAX_TRANSCRIPTION_AUDIO_BYTES,
    'Audio file for transcription'
  );
  const filename = path.basename(audioPath);
  const mimeType = mimeTypeFromPath(audioPath, 'application/octet-stream');

  const boundary = `----venice-cli-${crypto.randomUUID()}`;
  const CRLF = '\r\n';
  const escapeField = (value: string): string => value.replace(/"/g, '\\"');

  const formFields: Array<[string, string]> = [
    ['model', options.model || 'nvidia/parakeet-tdt-0.6b-v3'],
    ['response_format', 'json'],
  ];
  if (options.language) {
    formFields.push(['language', options.language]);
  }
  if (options.timestamps) {
    formFields.push(['timestamp_granularities[]', 'word']);
    formFields.push(['timestamp_granularities[]', 'segment']);
  }

  const fieldsPrefix = formFields
    .map(([name, value]) =>
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${escapeField(name)}"${CRLF}${CRLF}` +
      `${value}${CRLF}`
    )
    .join('');
  const fileHeader =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${escapeField(filename)}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`;
  const closingBoundary = `${CRLF}--${boundary}--${CRLF}`;

  const headerBuffer = Buffer.from(fieldsPrefix + fileHeader, 'utf-8');
  const footerBuffer = Buffer.from(closingBoundary, 'utf-8');
  const contentLength = headerBuffer.length + fileSize + footerBuffer.length;

  const multipartBody = Readable.from((async function* () {
    yield headerBuffer;
    for await (const chunk of fs.createReadStream(audioPath)) {
      yield chunk;
    }
    yield footerBuffer;
  })());

  const spinner = startSpinner('Transcribing...');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${requireApiKey()}`,
        'User-Agent': `venice-cli/${getVersion()}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
      },
      body: multipartBody as unknown as RequestInit['body'],
      duplex: 'half',
      signal: controller.signal,
    };

    const res = await fetch(`${VENICE_API}/audio/transcriptions`, {
      ...requestInit,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorBody = await res.text();
      throw VeniceApiError.fromResponse(res.status, errorBody);
    }

    if (spinner) stopSpinner(true);

    const response = await res.json() as {
      text: string;
      duration?: number;
      timestamps?: {
        word?: Array<{ word: string; start: number; end: number }>;
        segment?: Array<{ text: string; start: number; end: number }>;
      };
    };

    trackUsage({
      command: 'transcribe',
      model: options.model || 'nvidia/parakeet-tdt-0.6b-v3',
    });

    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (spinner) stopSpinner(false);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Transcription request timed out. Try a shorter audio file.');
    }
    throw error;
  }
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
  const modelTypes = ['text', 'asr', 'embedding', 'image', 'tts', 'upscale', 'inpaint', 'video'];
  const merged = new Map<string, Model>();

  // API defaults to text-only when no type is provided, so iterate known types
  const requests: Array<{ endpoint: string; requestedType?: string; showSpinner: boolean }> = [
    { endpoint: '/models', showSpinner: true },
    ...modelTypes.map((type) => ({
      endpoint: `/models?type=${encodeURIComponent(type)}`,
      requestedType: type,
      showSpinner: false,
    })),
  ];

  for (const request of requests) {
    try {
      const response = await apiRequest<{ data: Model[] }>(request.endpoint, {
        method: 'GET',
        spinnerText: 'Fetching models...',
        showSpinner: request.showSpinner,
      });

      for (const model of response.data || []) {
        const normalized: Model = { ...model };

        // Some API responses still label type as text; preserve requested typed endpoint info
        if (
          request.requestedType &&
          (!normalized.type || normalized.type.toLowerCase() === 'text')
        ) {
          normalized.type = request.requestedType;
        }

        const key = normalized.id || JSON.stringify(normalized);
        const existing = merged.get(key);

        if (!existing) {
          merged.set(key, normalized);
          continue;
        }

        // Prefer non-text type metadata when deduplicating
        const existingType = (existing.type || '').toLowerCase();
        const normalizedType = (normalized.type || '').toLowerCase();
        if (existingType === 'text' && normalizedType && normalizedType !== 'text') {
          merged.set(key, normalized);
        }
      }
    } catch (error) {
      // Keep typed fallback resilient. If the base endpoint fails, surface the error.
      if (!request.requestedType) {
        throw error;
      }
    }
  }

  return Array.from(merged.values());
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
    model: options.model || 'wan-2.6-text-to-video',
    prompt,
    duration: options.duration || '5s',
    aspect_ratio: options.aspectRatio || '16:9',
  };
  if (options.imageUrl) {
    body.image_url = options.imageUrl;
  }

  const response = await apiRequest<{
    queue_id: string;
    model: string;
  }>('/video/queue', {
    method: 'POST',
    body,
    spinnerText: 'Queueing video generation...',
  });

  trackUsage({
    command: 'video',
    model: options.model || 'wan-2.6-text-to-video',
  });

  return response;
}

// Video generation - check status / retrieve result
export async function getVideoStatus(
  queueId: string,
  model: string
): Promise<{
  status: 'PROCESSING' | 'completed' | 'failed';
  average_execution_time?: number;
  execution_duration?: number;
  video_url?: string;
  error?: string;
}> {
  return apiRequest('/video/retrieve', {
    method: 'POST',
    body: { queue_id: queueId, model },
    spinnerText: 'Checking video status...',
  });
}

// Video generation - retrieve video
export async function retrieveVideo(
  queueId: string,
  model: string
): Promise<{
  video_url?: string;
  status?: string;
  model: string;
  duration?: number;
}> {
  return apiRequest('/video/retrieve', {
    method: 'POST',
    body: { queue_id: queueId, model, delete_media_on_completion: false },
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
