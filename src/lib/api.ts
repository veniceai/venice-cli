/**
 * Venice AI API Client
 * 
 * Handles all API communication with retry logic and error handling.
 */

import { requireApiKey, trackUsage, type UsageEntry } from './config.js';
import { startSpinner, stopSpinner } from './output.js';
import { ServerSentEventParser } from './sse.js';
import { getVersion } from './version.js';
import { Readable } from 'stream';
import type { ReadableStreamReadResult } from 'stream/web';
import { randomBytes, randomUUID } from 'crypto';
import type {
  Message,
  ToolDefinition,
  Model,
  Character,
  CharacterReviewsPage,
  ImageGenerationOptions,
} from '../types/index.js';
import type {
  PromptCacheRetention,
  ReasoningEffort,
  ResponseFormat,
} from './structured-output.js';
import {
  MAX_AUDIO_DOWNLOAD_BYTES,
  MAX_IMAGE_EDIT_BYTES,
  MAX_IMAGE_DOWNLOAD_BYTES,
  MAX_UPSCALE_IMAGE_BYTES,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_DOCUMENT_PARSE_BYTES,
  MAX_VOICE_SAMPLE_BYTES,
  MAX_VIDEO_DOWNLOAD_BYTES,
  assertFileSizeWithinLimit,
  formatBytes,
  mimeTypeFromPath,
  readWithInactivityTimeout,
  streamResponseToFile,
} from './media.js';
import { checkMp4Header } from './mp4.js';

// Never allow production environment variables to redirect bearer credentials.
const VENICE_API =
  process.env.NODE_ENV === 'test' && process.env.VENICE_API_BASE_URL
    ? process.env.VENICE_API_BASE_URL
    : 'https://api.venice.ai/api/v1';

// Test runs may shorten back-off and stall timeouts; production ignores these.
function durationFromTestEnv(name: string, fallback: number): number {
  if (process.env.NODE_ENV !== 'test') return fallback;
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = durationFromTestEnv('VENICE_TEST_RETRY_DELAY_MS', 1000);
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes default timeout
const STREAM_IDLE_TIMEOUT_MS = durationFromTestEnv('VENICE_TEST_STREAM_IDLE_TIMEOUT_MS', 120000);
const DOCUMENT_PARSE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DOCUMENT_PARSE_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_STATUS_BYTES = 1024 * 1024;
const MAX_AUDIO_STATUS_BYTES = 1024 * 1024;
const AUDIO_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 120000;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_MODELS_RESPONSE_BYTES = 32 * 1024 * 1024;
// Up to four base64-encoded images of MAX_IMAGE_DOWNLOAD_BYTES each.
const MAX_IMAGE_GENERATION_RESPONSE_BYTES =
  Math.ceil((MAX_IMAGE_DOWNLOAD_BYTES * 4 * 4) / 3) + 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const MAX_EVENT_STREAM_LINE_LENGTH = 1024 * 1024;
const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const MAY_HAVE_BEEN_PROCESSED =
  'The request may already have been processed, so it was not retried. ' +
  'Check before running it again; paid requests appear in `venice billing usage`.';
const REDIRECT_REFUSED =
  'The Venice API answered with a redirect. API requests do not follow redirects.';

function truncateErrorMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… (truncated)`
    : message;
}

export class VeniceApiError extends Error {
  retryAfterMs?: number;

  constructor(
    message: string,
    public statusCode?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'VeniceApiError';
  }

  static fromResponse(status: number, body: string): VeniceApiError {
    let message: unknown;
    let code: unknown;
    try {
      const json = JSON.parse(body);
      const error = json?.error;
      message = typeof error === 'string' ? error : error?.message || json?.message;
      code = error?.code;
    } catch {
      // Not JSON: the body text is the message.
    }
    const text = typeof message === 'string' && message.trim()
      ? message
      : body.trim() || `HTTP ${status}`;
    return new VeniceApiError(
      truncateErrorMessage(text),
      status,
      typeof code === 'string' ? code : undefined
    );
  }

  isRetryable(): boolean {
    // Retry on network errors and 5xx
    if (!this.statusCode) return true;
    return this.statusCode >= 500 && this.statusCode < 600;
  }

  isAuthError(): boolean {
    return this.statusCode === 401;
  }

  isForbidden(): boolean {
    return this.statusCode === 403;
  }

  isRateLimited(): boolean {
    return this.statusCode === 429;
  }
}

function withProcessedNote<E extends Error>(error: E): E {
  error.message = `${error.message}\n${MAY_HAVE_BEEN_PROCESSED}`;
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// undici reports socket, DNS and redirect failures as a TypeError with a cause.
function isNetworkError(error: unknown): error is TypeError {
  return error instanceof TypeError && error.cause !== undefined;
}

// True only when the request provably never left the machine.
function isConnectError(error: TypeError): boolean {
  const failures = error.cause instanceof AggregateError ? error.cause.errors : [error.cause];
  return failures.length > 0 && failures.every((failure) => {
    const { code, syscall } = (failure ?? {}) as NodeJS.ErrnoException;
    return (typeof code === 'string' && CONNECT_ERROR_CODES.has(code)) ||
      syscall === 'connect' ||
      syscall === 'getaddrinfo';
  });
}

function isRedirectError(error: TypeError): boolean {
  return error.cause instanceof Error && error.cause.message === 'unexpected redirect';
}

function networkFailureMessage(error: TypeError): string {
  const cause = error.cause;
  const detail =
    cause instanceof AggregateError && cause.errors[0] instanceof Error
      ? cause.errors[0].message
      : cause instanceof Error
        ? cause.message || (cause as NodeJS.ErrnoException).code
        : undefined;
  return `Connection to the Venice API failed (${detail || error.message}).`;
}

function paidRequestError(error: unknown, timeoutMessage: string): unknown {
  if (isAbortError(error)) {
    return new Error(`${timeoutMessage}\n${MAY_HAVE_BEEN_PROCESSED}`);
  }
  if (error instanceof ResponseValidationError) {
    return withProcessedNote(error);
  }
  if (error instanceof VeniceApiError) {
    return error.isRetryable() ? withProcessedNote(error) : error;
  }
  if (isNetworkError(error)) {
    if (isRedirectError(error)) return new Error(REDIRECT_REFUSED);
    const failure = new Error(networkFailureMessage(error));
    return isConnectError(error) ? failure : withProcessedNote(failure);
  }
  return error;
}

export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now()
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function retryDelayMs(error: VeniceApiError, attempt: number): number | undefined {
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs <= MAX_RETRY_AFTER_MS ? error.retryAfterMs : undefined;
  }
  return RETRY_DELAY_MS * (attempt + 1) * (error.isRateLimited() ? 2 : 1);
}

function getHeaders(
  authenticated = true,
  contentType = 'application/json'
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `venice-cli/${getVersion()}`,
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  if (authenticated) {
    headers.Authorization = `Bearer ${requireApiKey()}`;
  }
  return headers;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkOnline(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(`${VENICE_API}/models`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  retries?: number;
  // Safe to send again after a 5xx, a dropped connection, or an unreadable
  // response. Defaults to false for POST: set it only for POSTs that are reads
  // or that carry an Idempotency-Key.
  idempotent?: boolean;
  showSpinner?: boolean;
  spinnerText?: string;
  timeoutMs?: number;
  additionalHeaders?: Record<string, string>;
  authenticated?: boolean;
  onHeaders?: (headers: Headers) => void;
} & (
  | {
      responseType?: 'json';
      stream?: boolean;
      maxResponseBytes?: number;
      responseLabel?: never;
      expectedContentType?: never;
    }
  | {
      // Resolves to { value, text }: the parsed body and the exact text it was parsed from.
      responseType: 'jsonText';
      stream?: false;
      maxResponseBytes: number;
      responseLabel: string;
      expectedContentType?: never;
    }
  | {
      responseType: 'arrayBuffer';
      stream?: false;
      maxResponseBytes: number;
      responseLabel: string;
      expectedContentType: 'image';
    }
);

class ResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseValidationError';
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const {
    method = 'GET',
    body,
    stream = false,
    retries = MAX_RETRIES,
    idempotent = method !== 'POST',
    showSpinner = true,
    spinnerText = 'Processing...',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    additionalHeaders = {},
    onHeaders,
    authenticated = true,
    maxResponseBytes = MAX_JSON_RESPONSE_BYTES,
  } = options;

  const binaryOptions = options.responseType === 'arrayBuffer' ? options : undefined;
  if (binaryOptions && stream) {
    throw new ResponseValidationError(
      'Binary responses cannot be returned as an unvalidated stream.'
    );
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new ResponseValidationError('Responses require a positive, finite byte limit.');
  }

  const headers = { ...getHeaders(authenticated), ...additionalHeaders };
  const requestBody = body ? JSON.stringify(body) : undefined;
  const responseLabel = `Response from ${endpoint.split('?')[0]}`;
  let spinner = showSpinner && !stream ? startSpinner(spinnerText) : null;
  let connectionChecked = false;

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let responded = false;

    try {
      const response = await fetch(`${VENICE_API}${endpoint}`, {
        method,
        headers,
        body: requestBody,
        signal: controller.signal,
        redirect: 'error',
      });
      responded = true;

      if (!response.ok) {
        const error = VeniceApiError.fromResponse(response.status, await readErrorBody(response));
        error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw error;
      }

      onHeaders?.(response.headers);

      let result: T;
      if (stream) {
        result = response as unknown as T;
      } else if (binaryOptions) {
        const bytes = await readResponseBodyWithLimit(
          response,
          binaryOptions.maxResponseBytes,
          binaryOptions.responseLabel
        );
        if (bytes.length === 0) {
          throw new ResponseValidationError(
            `${binaryOptions.responseLabel} response was empty.`
          );
        }

        const contentType = response.headers.get('content-type');
        if (binaryOptions.expectedContentType === 'image' && !isImageContentType(contentType)) {
          throw new ResponseValidationError(
            `${binaryOptions.responseLabel} did not return an image Content-Type ` +
            `(received: ${contentType || 'missing'}).`
          );
        }
        if (binaryOptions.expectedContentType === 'image' && !looksLikeImageBytes(bytes)) {
          throw new ResponseValidationError(
            `${binaryOptions.responseLabel} did not contain a supported PNG, JPEG, or WebP image.`
          );
        }
        result = Uint8Array.from(bytes).buffer as T;
      } else if (options.responseType === 'jsonText') {
        result = await readJsonText(response, maxResponseBytes, options.responseLabel) as T;
      } else {
        result = await readJsonResponse<T>(response, maxResponseBytes, responseLabel);
      }

      clearTimeout(timeoutId);
      if (spinner) {
        stopSpinner(true);
        spinner = null;
      }
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (isAbortError(error)) {
        if (spinner) stopSpinner(false, 'Request timed out');
        throw new Error(
          `Request timed out after ${timeoutMs / 1000} seconds.\n` +
          (idempotent ? 'The server may be overloaded. Please try again later.' : MAY_HAVE_BEEN_PROCESSED)
        );
      }

      if (error instanceof VeniceApiError) {
        if (error.isAuthError()) {
          if (spinner) stopSpinner(false, 'Authentication failed');
          throw new Error(
            'Authentication failed. Please check your API key.\n' +
            'Update with: venice config set api_key'
          );
        }

        if (error.isForbidden()) {
          if (spinner) stopSpinner(false, 'Permission denied');
          throw new VeniceApiError(`Permission denied: ${error.message}`, 403, error.code);
        }

        const retryable = error.isRateLimited() || (idempotent && error.isRetryable());
        const delayMs = retryable && canRetry ? retryDelayMs(error, attempt) : undefined;
        if (delayMs !== undefined) {
          if (spinner) {
            spinner.text = error.isRateLimited()
              ? `Rate limited, waiting... (attempt ${attempt + 2}/${retries + 1})`
              : `Retrying... (attempt ${attempt + 2}/${retries + 1})`;
          }
          await sleep(delayMs);
          continue;
        }

        if (spinner) stopSpinner(false);
        if (retryable && error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_AFTER_MS) {
          error.message +=
            `\nThe server asked to wait ${Math.ceil(error.retryAfterMs / 1000)} seconds before retrying.`;
        }
        throw !idempotent && error.isRetryable() ? withProcessedNote(error) : error;
      }

      if (error instanceof ResponseValidationError) {
        if (spinner) stopSpinner(false);
        throw idempotent ? error : withProcessedNote(error);
      }

      if (!isNetworkError(error)) {
        if (spinner) stopSpinner(false);
        throw error;
      }

      if (isRedirectError(error)) {
        if (spinner) stopSpinner(false);
        throw new Error(REDIRECT_REFUSED);
      }

      const neverSent = !responded && isConnectError(error);
      if (canRetry && (idempotent || neverSent)) {
        if (!responded && !connectionChecked) {
          connectionChecked = true;
          if (!(await checkOnline())) {
            if (spinner) stopSpinner(false, 'Network error');
            throw new Error(
              'Unable to connect to Venice API.\n' +
              'Please check your internet connection.'
            );
          }
        }
        if (spinner) spinner.text = `Connection error, retrying... (attempt ${attempt + 2}/${retries + 1})`;
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }

      if (spinner) stopSpinner(false, 'Network error');
      const failure = new Error(networkFailureMessage(error));
      throw idempotent || neverSent ? failure : withProcessedNote(failure);
    }
  }
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      totalBytes += value.byteLength;
    }
  } catch {
    // Report the status with whatever part of the body arrived.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf-8');
}

async function readJsonResponse<T>(
  response: Response,
  maxBytes: number,
  label: string
): Promise<T> {
  const bytes = await readResponseBodyWithLimit(response, maxBytes, label);
  try {
    return JSON.parse(bytes.toString('utf-8')) as T;
  } catch {
    throw new ResponseValidationError(`${label} was not valid JSON.`);
  }
}

// Invalid UTF-8 is rejected rather than replaced, so the text matches the bytes received.
async function readJsonText(
  response: Response,
  maxBytes: number,
  label: string
): Promise<{ value: unknown; text: string }> {
  const bytes = await readResponseBodyWithLimit(response, maxBytes, label);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(text) as unknown, text };
  } catch {
    throw new ResponseValidationError(`${label} was not valid JSON.`);
  }
}

export interface ChatCompletionRequestOptions {
  model?: string;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  venice_parameters?: Record<string, unknown>;
  additionalHeaders?: Record<string, string>;
  response_format?: ResponseFormat;
  reasoning_effort?: ReasoningEffort;
  prompt_cache_key?: string;
  prompt_cache_retention?: PromptCacheRetention;
  recordUsage?: boolean;
}

function tokenCounts(
  usage: unknown
): Pick<UsageEntry, 'prompt_tokens' | 'completion_tokens' | 'total_tokens'> {
  const counts: Pick<UsageEntry, 'prompt_tokens' | 'completion_tokens' | 'total_tokens'> = {};
  if (usage === null || typeof usage !== 'object') return counts;
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const value = (usage as Record<string, unknown>)[field];
    if (Number.isSafeInteger(value) && (value as number) >= 0) {
      counts[field] = value as number;
    }
  }
  return counts;
}

function recordChatUsage(usage: unknown, options: ChatCompletionRequestOptions): void {
  if (!usage || options.recordUsage === false) return;
  trackUsage({
    ...tokenCounts(usage),
    command: 'chat',
    model: options.model || 'kimi-k2-5',
  });
}

export function buildChatCompletionBody(
  messages: Message[],
  options: ChatCompletionRequestOptions,
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model || 'kimi-k2-5',
    messages,
    stream,
  };

  if (stream) {
    body.stream_options = { include_usage: true };
  }

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }

  if (options.venice_parameters) {
    body.venice_parameters = options.venice_parameters;
  }

  if (options.response_format) {
    body.response_format = options.response_format;
  }

  if (options.reasoning_effort) {
    body.reasoning_effort = options.reasoning_effort;
  }

  if (options.prompt_cache_key) {
    body.prompt_cache_key = options.prompt_cache_key;
  }

  if (options.prompt_cache_retention) {
    body.prompt_cache_retention = options.prompt_cache_retention;
  }

  return body;
}

// Chat completion (non-streaming)
export async function chatCompletion(
  messages: Message[],
  options: ChatCompletionRequestOptions = {}
): Promise<{
  content: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason: string;
}> {
  const body = buildChatCompletionBody(messages, options, false);

  const response = await apiRequest<{
    choices: Array<{
      message: { content: string; reasoning_content?: string; tool_calls?: any[] };
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

  recordChatUsage(usage, options);

  return {
    content: choice?.message?.content || '',
    reasoning_content: choice?.message?.reasoning_content,
    tool_calls: choice?.message?.tool_calls,
    usage,
    finish_reason: choice?.finish_reason || 'stop',
  };
}

// Chat completion (streaming)
export async function* chatCompletionStream(
  messages: Message[],
  options: ChatCompletionRequestOptions = {}
): AsyncGenerator<{
  content?: string;
  reasoning_content?: string;
  tool_calls?: any[];
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  completionId?: string;
  done: boolean;
}> {
  const body = buildChatCompletionBody(messages, options, true);

  const response = await apiRequest<Response>('/chat/completions', {
    method: 'POST',
    body,
    stream: true,
    showSpinner: false,
    additionalHeaders: options.additionalHeaders,
  });

  const contentType = response.headers.get('content-type');
  if ((contentType || '').split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Chat stream returned Content-Type ${contentType || '(missing)'} instead of text/event-stream.`
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  const parser = new ServerSentEventParser(MAX_EVENT_STREAM_LINE_LENGTH);
  let totalUsage: any = null;
  let completionId: string | undefined;
  // Only data events push the deadline back; keepalive comments do not.
  let deadline = Date.now() + STREAM_IDLE_TIMEOUT_MS;

  try {
    while (true) {
      const { done, value } = await readBeforeDeadline(reader, deadline);
      const events = done
        ? parser.end(decoder.decode())
        : parser.push(decoder.decode(value, { stream: true }));

      for (const event of events) {
        if (event.type === 'error') {
          throw new Error(`Chat stream failed: ${streamErrorMessage(event.data)}`);
        }

        const data = event.data.trim();
        if (!data) continue;
        if (data === '[DONE]') {
          recordChatUsage(totalUsage, options);
          yield { done: true, usage: totalUsage, completionId };
          return;
        }

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          throw new Error('Chat stream sent an event that is not valid JSON.');
        }
        if (json === null || typeof json !== 'object' || Array.isArray(json)) {
          throw new Error('Chat stream sent an event that is not a JSON object.');
        }
        if (json.error) {
          throw new Error(`Chat stream failed: ${streamErrorMessage(data)}`);
        }
        deadline = Date.now() + STREAM_IDLE_TIMEOUT_MS;

        const choice = json.choices?.[0];
        const delta = choice?.delta;

        // Capture completion ID for E2EE signature verification
        if (json.id && !completionId) {
          completionId = json.id;
        }

        if (json.usage) {
          totalUsage = json.usage;
        }

        if (delta?.reasoning_content) {
          yield { reasoning_content: delta.reasoning_content, done: false, completionId };
        }

        if (delta?.content) {
          yield { content: delta.content, done: false, completionId };
        }

        if (delta?.tool_calls) {
          yield { tool_calls: delta.tool_calls, done: false, completionId };
        }

        if (choice?.finish_reason) {
          yield { finish_reason: choice.finish_reason, done: false, completionId };
        }
      }

      if (done) break;
    }
  } catch (error) {
    throw isNetworkError(error) ? new Error(networkFailureMessage(error)) : error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  throw new Error('Chat stream ended before the response was complete.');
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(
            `Chat stream stalled: no data for ${STREAM_IDLE_TIMEOUT_MS / 1000} seconds.`
          ));
        }, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function streamErrorMessage(data: string): string {
  let payload: unknown = data;
  try {
    payload = JSON.parse(data);
  } catch {
    // Plain-text error event.
  }
  const error = (payload as { error?: unknown } | null)?.error ?? payload;
  const message = typeof error === 'string'
    ? error
    : (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim()
    ? truncateErrorMessage(message)
    : 'the server reported an error.';
}

// Image generation (Venice-native endpoint)
export function buildImageGenerationBody(
  prompt: string,
  options: Omit<ImageGenerationOptions, 'output'> = {}
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model || 'flux-2-pro',
    prompt,
    format: options.format || 'png',
  };

  const optionalFields: Array<[keyof Omit<ImageGenerationOptions, 'output'>, string]> = [
    ['width', 'width'],
    ['height', 'height'],
    ['aspectRatio', 'aspect_ratio'],
    ['resolution', 'resolution'],
    ['quality', 'quality'],
    ['stylePreset', 'style_preset'],
    ['styleReferences', 'style_references'],
    ['negativePrompt', 'negative_prompt'],
    ['seed', 'seed'],
    ['cfgScale', 'cfg_scale'],
    ['steps', 'steps'],
    ['loraStrength', 'lora_strength'],
    ['hideWatermark', 'hide_watermark'],
    ['safeMode', 'safe_mode'],
    ['embedExifMetadata', 'embed_exif_metadata'],
  ];

  for (const [optionName, fieldName] of optionalFields) {
    const value = options[optionName];
    if (value !== undefined) {
      body[fieldName] = value;
    }
  }
  if (options.count !== undefined && options.count > 1) {
    body.variants = options.count;
  }

  return body;
}

export async function generateImage(
  prompt: string,
  options: Omit<ImageGenerationOptions, 'output'> = {}
): Promise<string[]> {
  const body = buildImageGenerationBody(prompt, options);

  const response = await apiRequest<{
    id: string;
    images: string[];
  }>('/image/generate', {
    method: 'POST',
    body,
    spinnerText: 'Generating image...',
    maxResponseBytes: MAX_IMAGE_GENERATION_RESPONSE_BYTES,
  });

  trackUsage({
    command: 'image',
    model: options.model || 'flux-2-pro',
  });

  return response.images;
}

type ImageEditOptions = {
  model?: string;
  aspectRatio?: string;
  enhancePrompt?: boolean;
  safeMode?: boolean;
};

async function readImageAsBase64(imagePath: string): Promise<string> {
  const fs = await import('fs');

  if (!fs.existsSync(imagePath)) {
    throw new Error(`File not found: ${imagePath}`);
  }
  assertFileSizeWithinLimit(imagePath, MAX_IMAGE_EDIT_BYTES, 'Image file');
  return (await fs.promises.readFile(imagePath)).toString('base64');
}

// Edit a single local image
export async function editImage(
  imagePath: string,
  prompt: string,
  options: ImageEditOptions = {}
): Promise<ArrayBuffer> {
  const body: Record<string, unknown> = {
    image: await readImageAsBase64(imagePath),
    prompt,
  };
  if (options.model) body.model = options.model;
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
  if (options.enhancePrompt) body.enhance_prompt = true;
  if (options.safeMode === false) body.safe_mode = false;

  const response = await apiRequest<ArrayBuffer>('/image/edit', {
    method: 'POST',
    body,
    responseType: 'arrayBuffer',
    maxResponseBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    responseLabel: 'Edited image',
    expectedContentType: 'image',
    spinnerText: 'Editing image...',
  });

  trackUsage({ command: 'image edit', model: options.model || 'default' });
  return response;
}

// Edit using one to three local image layers
export async function multiEditImage(
  imagePaths: string[],
  prompt: string,
  options: ImageEditOptions = {}
): Promise<ArrayBuffer> {
  if (imagePaths.length < 1 || imagePaths.length > 3) {
    throw new Error('Multi-edit requires between 1 and 3 images.');
  }

  const body: Record<string, unknown> = {
    images: await Promise.all(imagePaths.map(readImageAsBase64)),
    prompt,
  };
  if (options.model) body.modelId = options.model;
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
  if (options.enhancePrompt) body.enhance_prompt = true;
  if (options.safeMode === false) body.safe_mode = false;

  const response = await apiRequest<ArrayBuffer>('/image/multi-edit', {
    method: 'POST',
    body,
    responseType: 'arrayBuffer',
    maxResponseBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    responseLabel: 'Edited image',
    expectedContentType: 'image',
    spinnerText: 'Editing image layers...',
  });

  trackUsage({ command: 'image multi-edit', model: options.model || 'default' });
  return response;
}

// Remove the background from a local image
export async function removeImageBackground(imagePath: string): Promise<ArrayBuffer> {
  const response = await apiRequest<ArrayBuffer>('/image/background-remove', {
    method: 'POST',
    body: { image: await readImageAsBase64(imagePath) },
    responseType: 'arrayBuffer',
    maxResponseBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    responseLabel: 'Background removal image',
    expectedContentType: 'image',
    spinnerText: 'Removing background...',
  });

  trackUsage({ command: 'image bg-remove', model: 'background-remove' });
  return response;
}

// List style presets accepted by image generation
export async function listImageStyles(): Promise<string[]> {
  const response = await apiRequest<{ data: string[] }>('/image/styles', {
    showSpinner: false,
    authenticated: false,
  });
  return response.data || [];
}

export type UpscaleImageResult = {
  bytes: Buffer;
  contentType: string;
};

export function isImageContentType(contentType: string | null | undefined): boolean {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  return type.startsWith('image/');
}

export function looksLikeImageBytes(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return true;
  }
  return false;
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength >= 0 && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseValidationError(
        `${label} is too large (${formatBytes(contentLength)}). ` +
        `Maximum allowed size is ${formatBytes(maxBytes)}.`
      );
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseValidationError(
          `${label} exceeded the limit of ${formatBytes(maxBytes)}.`
        );
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

// Image upscale
export async function upscaleImage(
  imagePath: string,
  options: {
    model?: string;
    scale?: number;
  } = {}
): Promise<UpscaleImageResult> {
  const fs = await import('fs');

  if (!fs.existsSync(imagePath)) {
    throw new Error(`File not found: ${imagePath}`);
  }

  assertFileSizeWithinLimit(imagePath, MAX_UPSCALE_IMAGE_BYTES, 'Image file for upscaling');

  const imageData = await fs.promises.readFile(imagePath);
  const body = {
    image: imageData.toString('base64'),
    scale: options.scale || 2,
    ...(options.model ? { model: options.model } : {}),
  };

  const spinner = startSpinner('Upscaling image...');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${VENICE_API}/image/upscale`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });

    if (!response.ok) {
      throw VeniceApiError.fromResponse(response.status, await readErrorBody(response));
    }

    const bytes = await readResponseBodyWithLimit(
      response,
      MAX_IMAGE_DOWNLOAD_BYTES,
      'Upscaled image response'
    );

    const contentType = response.headers.get('content-type') || '';

    if (!isImageContentType(contentType) && !looksLikeImageBytes(bytes)) {
      const preview = bytes.subarray(0, 200).toString('utf-8');
      throw new Error(
        `Upscale did not return an image (content-type: ${contentType || 'unknown'}). ` +
        `Response preview: ${preview}`
      );
    }

    if (spinner) stopSpinner(true);

    trackUsage({
      command: 'upscale',
      model: options.model || 'upscaler',
    });

    return {
      bytes,
      contentType: contentType.split(';')[0].trim() || 'image/png',
    };
  } catch (error) {
    if (spinner) stopSpinner(false);
    throw paidRequestError(error, 'Image upscale request timed out. Please try again later.');
  } finally {
    clearTimeout(timeoutId);
  }
}

// Text to speech
export async function textToSpeech(
  text: string,
  options: {
    model?: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
    speed?: number;
    temperature?: number;
    streaming?: boolean;
  } = {}
): Promise<{ audio: ArrayBuffer; contentType?: string }> {
  const body: Record<string, unknown> = {
    model: options.model || 'tts-kokoro',
    input: text,
    voice: options.voice || 'af_sky',
  };
  if (options.format !== undefined) {
    body.response_format = options.format;
  }
  if (options.speed !== undefined) {
    body.speed = options.speed;
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  if (options.streaming !== undefined) {
    body.streaming = options.streaming;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${VENICE_API}/audio/speech`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });

    if (!response.ok) {
      throw VeniceApiError.fromResponse(response.status, await readErrorBody(response));
    }

    const contentType = response.headers.get('content-type')?.split(';')[0].trim();
    if (
      !contentType ||
      (!contentType.toLowerCase().startsWith('audio/') &&
        contentType.toLowerCase() !== 'application/octet-stream')
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Text-to-speech returned an unexpected Content-Type: ${contentType || 'missing'}.`
      );
    }
    const bytes = await readResponseBodyWithLimit(
      response,
      MAX_AUDIO_DOWNLOAD_BYTES,
      'Text-to-speech audio'
    );
    if (bytes.length === 0) {
      throw new Error('Text-to-speech response was empty.');
    }

    trackUsage({
      command: 'tts',
      model: options.model || 'tts-kokoro',
    });

    return {
      audio: Uint8Array.from(bytes).buffer,
      contentType,
    };
  } catch (error) {
    throw paidRequestError(error, 'Text-to-speech request timed out. Please try with shorter text.');
  } finally {
    clearTimeout(timeoutId);
  }
}

// Create a model-specific voice handle from a reference audio sample
export async function cloneVoice(
  audioPath: string,
  options: { model?: string } = {}
): Promise<{ id: string; model: string }> {
  const fs = await import('fs');
  const path = await import('path');

  if (!fs.existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  const acceptedExtensions = new Set(['.mp3', '.wav', '.flac', '.mp4']);
  const extension = path.extname(audioPath).toLowerCase();
  if (!acceptedExtensions.has(extension)) {
    throw new Error(
      `Unsupported voice sample format "${extension || '(none)'}". ` +
      'Use MP3, WAV, FLAC, or MP4.'
    );
  }

  assertFileSizeWithinLimit(
    audioPath,
    MAX_VOICE_SAMPLE_BYTES,
    'Voice reference sample'
  );
  const audioData = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append('model', options.model || 'tts-chatterbox-hd');
  form.append(
    'file',
    new Blob([new Uint8Array(audioData)], { type: mimeTypeFromPath(audioPath) }),
    path.basename(audioPath)
  );

  const spinner = startSpinner('Cloning voice...');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${VENICE_API}/audio/voices`, {
      method: 'POST',
      headers: getHeaders(true, ''),
      body: form,
      signal: controller.signal,
      redirect: 'error',
    });

    if (!response.ok) {
      throw VeniceApiError.fromResponse(response.status, await readErrorBody(response));
    }

    const voice = await readJsonResponse<{ id: string; model: string }>(
      response,
      MAX_JSON_RESPONSE_BYTES,
      'Voice cloning response'
    );
    if (spinner) stopSpinner(true);
    return voice;
  } catch (error) {
    if (spinner) stopSpinner(false);
    throw paidRequestError(error, 'Voice cloning request timed out. Try a shorter audio sample.');
  } finally {
    clearTimeout(timeoutId);
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
      redirect: 'error',
    };

    const res = await fetch(`${VENICE_API}/audio/transcriptions`, {
      ...requestInit,
    });

    if (!res.ok) {
      throw VeniceApiError.fromResponse(res.status, await readErrorBody(res));
    }

    const response = await readJsonResponse<{
      text: string;
      duration?: number;
      timestamps?: {
        word?: Array<{ word: string; start: number; end: number }>;
        segment?: Array<{ text: string; start: number; end: number }>;
      };
    }>(res, MAX_JSON_RESPONSE_BYTES, 'Transcription response');

    if (spinner) stopSpinner(true);

    trackUsage({
      command: 'transcribe',
      model: options.model || 'nvidia/parakeet-tdt-0.6b-v3',
    });

    return response;
  } catch (error) {
    if (spinner) stopSpinner(false);
    throw paidRequestError(error, 'Transcription request timed out. Try a shorter audio file.');
  } finally {
    clearTimeout(timeoutId);
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

const MODELS_CACHE_TTL_MS = 60_000;
let modelsCache: { models: Model[]; fetchedAt: number } | null = null;

export function clearModelsCache(): void {
  modelsCache = null;
}

// The first listing of a model wins, so a typed query can never re-type a
// model the base (text) list already returned: E2EE detection needs type text.
function mergeModel(merged: Map<string, Model>, model: Model, requestedType?: string): void {
  const normalized: Model = { ...model };

  if (requestedType && (!normalized.type || normalized.type.toLowerCase() === 'text')) {
    normalized.type = requestedType;
  }

  const key = normalized.id || JSON.stringify(normalized);
  if (!merged.has(key)) {
    merged.set(key, normalized);
  }
}

// List models
export async function listModels(
  options: { showSpinner?: boolean; type?: string } = {}
): Promise<Model[]> {
  const { showSpinner: showSpinnerOption = true, type } = options;

  if (type) {
    const response = await apiRequest<{ data: Model[] }>(
      `/models?type=${encodeURIComponent(type)}`,
      {
        method: 'GET',
        spinnerText: 'Fetching models...',
        showSpinner: showSpinnerOption,
        maxResponseBytes: MAX_MODELS_RESPONSE_BYTES,
      }
    );
    return (response.data || []).map((model) =>
      !model.type || model.type.toLowerCase() === 'text'
        ? { ...model, type }
        : model
    );
  }

  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return [...modelsCache.models];
  }

  // The base list is the text catalog; other types are best-effort extras.
  const modelTypes = ['asr', 'embedding', 'image', 'tts', 'upscale', 'inpaint', 'video', 'music'];
  const merged = new Map<string, Model>();

  const base = apiRequest<{ data: Model[] }>('/models', {
    method: 'GET',
    spinnerText: 'Fetching models...',
    showSpinner: showSpinnerOption,
    maxResponseBytes: MAX_MODELS_RESPONSE_BYTES,
  });

  const typed = modelTypes.map((type) =>
    apiRequest<{ data: Model[] }>(`/models?type=${encodeURIComponent(type)}`, {
      method: 'GET',
      showSpinner: false,
      retries: 0,
      maxResponseBytes: MAX_MODELS_RESPONSE_BYTES,
    })
      .then((response) => ({ type, response }))
      .catch(() => null)
  );

  const [baseResponse, ...typedResponses] = await Promise.all([base, ...typed]);

  for (const model of baseResponse.data || []) {
    mergeModel(merged, model);
  }

  for (const entry of typedResponses) {
    if (!entry) continue;
    for (const model of entry.response.data || []) {
      mergeModel(merged, model, entry.type);
    }
  }

  const models = Array.from(merged.values());
  modelsCache = { models, fetchedAt: Date.now() };
  return [...models];
}

// List TTS models and their model-specific voice catalogs
export async function listTtsModels(): Promise<Model[]> {
  const response = await apiRequest<{ data: Model[] }>('/models?type=tts', {
    method: 'GET',
    spinnerText: 'Fetching voices...',
  });

  if (!Array.isArray(response.data)) {
    throw new Error('Unexpected response from Venice: the TTS model list is missing.');
  }
  return response.data.map((model) => ({
    ...model,
    type: model.type && model.type.toLowerCase() !== 'text' ? model.type : 'tts',
  }));
}

export type ListCharactersOptions = {
  search?: string;
  limit?: number;
  offset?: number;
  showSpinner?: boolean;
};

function clampCharacterLimit(limit?: number): number {
  const value = limit ?? 50;
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

function clampCharacterOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}

export async function listCharacters(
  options: ListCharactersOptions = {}
): Promise<Character[]> {
  const params = new URLSearchParams();
  params.set('limit', String(clampCharacterLimit(options.limit)));
  params.set('offset', String(clampCharacterOffset(options.offset)));
  if (options.search) {
    params.set('search', options.search);
  }

  const response = await apiRequest<{ data: Character[] }>(`/characters?${params}`, {
    method: 'GET',
    spinnerText: 'Fetching characters...',
    showSpinner: options.showSpinner ?? true,
  });
  return response.data || [];
}

export async function getCharacter(
  slug: string,
  options: { showSpinner?: boolean } = {}
): Promise<Character> {
  const response = await apiRequest<{ data: Character }>(
    `/characters/${encodeURIComponent(slug)}`,
    {
      method: 'GET',
      spinnerText: 'Fetching character...',
      showSpinner: options.showSpinner ?? true,
    }
  );
  return response.data;
}

export async function getCharacterReviews(
  slug: string,
  options: { page?: number; pageSize?: number; showSpinner?: boolean } = {}
): Promise<CharacterReviewsPage> {
  const params = new URLSearchParams();
  if (options.page !== undefined) {
    params.set('page', String(options.page));
  }
  if (options.pageSize !== undefined) {
    params.set('pageSize', String(options.pageSize));
  }
  const query = params.toString();
  const endpoint = `/characters/${encodeURIComponent(slug)}/reviews${query ? `?${query}` : ''}`;

  return apiRequest<CharacterReviewsPage>(endpoint, {
    method: 'GET',
    spinnerText: 'Fetching reviews...',
    showSpinner: options.showSpinner ?? true,
  });
}

export type VideoStatusResult = {
  status: string;
  average_execution_time?: number;
  execution_duration?: number;
  video_url?: string;
  url?: string;
  download_url?: string;
  error?: string;
  model?: string;
  duration?: number;
};

export type VideoRetrieveResult =
  | { kind: 'status'; status: VideoStatusResult }
  | { kind: 'video'; bytesWritten: number; contentType: string };

export function classifyVideoRetrieveContentType(
  contentType: string | null | undefined
): 'json' | 'video' | 'unknown' {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!type) return 'unknown';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type.startsWith('video/') || type === 'application/octet-stream') return 'video';
  return 'unknown';
}

export function videoUrlFromStatus(status: VideoStatusResult): string | undefined {
  return status.video_url || status.url || status.download_url;
}

class UnexpectedResponseError extends Error {}

type FieldTypes = Record<string, 'string' | 'number' | 'boolean'>;

const VIDEO_STATUS_FIELDS: FieldTypes = {
  average_execution_time: 'number',
  execution_duration: 'number',
  video_url: 'string',
  url: 'string',
  download_url: 'string',
  error: 'string',
};

const AUDIO_STATUS_FIELDS: FieldTypes = {
  average_execution_time: 'number',
  execution_duration: 'number',
  error: 'string',
};

function unexpectedResponse(endpoint: string, problem: string): UnexpectedResponseError {
  return new UnexpectedResponseError(`Unexpected response from Venice (${endpoint}): ${problem}.`);
}

function parseJsonText(text: string, endpoint: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw unexpectedResponse(endpoint, 'the body is not valid JSON');
  }
}

function jsonObject(value: unknown, endpoint: string, optionalFields: FieldTypes = {}): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw unexpectedResponse(endpoint, 'expected a JSON object');
  }

  const record = value as Record<string, unknown>;
  for (const [field, type] of Object.entries(optionalFields)) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== type) {
      throw unexpectedResponse(endpoint, `"${field}" is not a ${type}`);
    }
  }
  return record;
}

function parseQueueResponse(
  value: unknown,
  endpoint: string,
  requestedModel: string
): { queue_id: string; model: string; status?: string } {
  const record = jsonObject(value, endpoint, { model: 'string', status: 'string' });
  if (typeof record.queue_id !== 'string' || !record.queue_id) {
    throw unexpectedResponse(endpoint, 'missing queue_id');
  }
  return {
    ...record,
    queue_id: record.queue_id,
    model: typeof record.model === 'string' && record.model ? record.model : requestedModel,
  };
}

function parseQuoteResponse(value: unknown, endpoint: string): { quote: number } {
  const record = jsonObject(value, endpoint);
  if (typeof record.quote !== 'number' || !Number.isFinite(record.quote) || record.quote < 0) {
    throw unexpectedResponse(endpoint, 'missing or invalid quote');
  }
  return { ...record, quote: record.quote };
}

function parseCompleteResponse(value: unknown, endpoint: string): { success: boolean } {
  const record = jsonObject(value, endpoint);
  if (typeof record.success !== 'boolean') {
    throw unexpectedResponse(endpoint, 'missing success flag');
  }
  return { ...record, success: record.success };
}

function parseJobStatus<T extends { status: string }>(
  value: unknown,
  endpoint: string,
  optionalFields: FieldTypes
): T {
  const record = jsonObject(value, endpoint, optionalFields);
  if (typeof record.status !== 'string' || !record.status.trim()) {
    throw unexpectedResponse(endpoint, 'missing status');
  }
  return record as T;
}

async function retrieveVideoResponse(
  queueId: string,
  model: string,
  options: {
    spinnerText?: string;
    statusOnly?: boolean;
    outputPath?: string;
    maxBytes?: number;
  } = {}
): Promise<VideoRetrieveResult> {
  const spinner = startSpinner(options.spinnerText || 'Checking video status...');
  // Retrieval must never delete the remote media. Callers can explicitly
  // complete the job only after the response is safely persisted locally.
  const body: Record<string, unknown> = {
    queue_id: queueId,
    model,
    delete_media_on_completion: false,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let fileWriteStarted = false;
    let requestTimeoutActive = true;
    const clearRequestTimeout = () => {
      if (requestTimeoutActive) {
        clearTimeout(timeoutId);
        requestTimeoutActive = false;
      }
    };

    try {
      const response = await fetch(`${VENICE_API}/video/retrieve`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });

      if (!response.ok) {
        throw VeniceApiError.fromResponse(response.status, await readErrorBody(response));
      }

      const inspected = await inspectVideoRetrieveResponse(response);
      if (inspected.kind === 'status') {
        if (spinner) stopSpinner(true);
        return inspected;
      }

      // The request deadline bounds headers and body inspection only. Once an
      // MP4 is confirmed, chunk-level inactivity timeouts protect the download.
      clearRequestTimeout();

      if (options.statusOnly) {
        await inspected.reader.cancel();
        inspected.reader.releaseLock();
        if (spinner) stopSpinner(true);
        return { kind: 'status', status: { status: 'completed' } };
      }

      if (!options.outputPath) {
        await inspected.reader.cancel();
        inspected.reader.releaseLock();
        throw new VideoRetrieveValidationError(
          'An output path is required to save the retrieved video.'
        );
      }

      fileWriteStarted = true;
      const saved = await streamResponseToFile(
        response,
        inspected.reader,
        inspected.initialChunks,
        options.outputPath,
        {
          maxBytes: options.maxBytes ?? MAX_VIDEO_DOWNLOAD_BYTES,
          label: 'Video',
        }
      );
      if (spinner) stopSpinner(true);
      return { kind: 'video', ...saved };
    } catch (error) {
      if (isNetworkError(error) && isRedirectError(error)) {
        if (spinner) stopSpinner(false);
        throw new Error(REDIRECT_REFUSED);
      }
      const retryable =
        !fileWriteStarted &&
        attempt < MAX_RETRIES &&
        !(error instanceof VideoRetrieveValidationError) &&
        !(error instanceof UnexpectedResponseError) &&
        (
          !(error instanceof VeniceApiError) ||
          error.isRetryable() ||
          error.isRateLimited()
        );

      if (retryable) {
        await sleep(RETRY_DELAY_MS * (attempt + 1) * (
          error instanceof VeniceApiError && error.isRateLimited() ? 2 : 1
        ));
        continue;
      }

      if (spinner) stopSpinner(false);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Video retrieve request timed out. Please try again later.');
      }
      throw error;
    } finally {
      clearRequestTimeout();
    }
  }

  if (spinner) stopSpinner(false);
  throw new Error('Video retrieve request failed after retries.');
}

type InspectedVideoResponse =
  | { kind: 'status'; status: VideoStatusResult }
  | {
      kind: 'video';
      reader: ReadableStreamDefaultReader<Uint8Array>;
      initialChunks: Buffer[];
    };

class VideoRetrieveValidationError extends Error {}

async function inspectVideoRetrieveResponse(
  response: Response
): Promise<InspectedVideoResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new VideoRetrieveValidationError('Video retrieve response had no body.');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let readingJson = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      chunks.push(chunk);
      totalBytes += chunk.length;
      const buffered = Buffer.concat(chunks, totalBytes);

      if (!readingJson) {
        const mp4Header = checkMp4Header(buffered);
        if (mp4Header === 'valid') {
          return { kind: 'video', reader, initialChunks: chunks };
        }

        if (mp4Header === 'invalid') {
          const firstNonWhitespace = buffered.find((byte) => byte > 0x20);
          if (firstNonWhitespace === 0x7b) {
            readingJson = true;
          } else if (firstNonWhitespace !== undefined) {
            throw unexpectedVideoRetrieveType(response);
          }
        }
      }

      if (totalBytes > MAX_VIDEO_STATUS_BYTES) {
        throw new VideoRetrieveValidationError(
          'Video status response exceeded the maximum expected size.'
        );
      }
    }

    const buffered = Buffer.concat(chunks, totalBytes);
    const firstNonWhitespace = buffered.find((byte) => byte > 0x20);
    if (readingJson || firstNonWhitespace === 0x7b) {
      const status = parseJobStatus<VideoStatusResult>(
        parseJsonText(buffered.toString('utf-8'), '/video/retrieve'),
        '/video/retrieve',
        VIDEO_STATUS_FIELDS
      );
      reader.releaseLock();
      return { kind: 'status', status };
    }
    throw unexpectedVideoRetrieveType(response);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
}

function unexpectedVideoRetrieveType(response: Response): Error {
  return new VideoRetrieveValidationError(
    `Unexpected video retrieve content type "${response.headers.get('content-type') || 'unknown'}": ` +
    'response is neither JSON nor a valid MP4.'
  );
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
  };
  if (options.aspectRatio) {
    body.aspect_ratio = options.aspectRatio;
  }
  if (options.imageUrl) {
    body.image_url = options.imageUrl;
  }

  const response = await apiRequest<unknown>('/video/queue', {
    method: 'POST',
    body,
    spinnerText: 'Queueing video generation...',
  });
  const queued = parseQueueResponse(response, '/video/queue', String(body.model));

  trackUsage({
    command: 'video',
    model: options.model || 'wan-2.6-text-to-video',
  });

  return queued;
}

export async function queueVideoUpscale(
  videoUrl: string,
  options: {
    model?: string;
    upscaleFactor?: number;
  } = {}
): Promise<{ queue_id: string; model: string }> {
  const model = options.model || 'topaz-video-upscale';
  const response = await apiRequest<unknown>('/video/queue', {
    method: 'POST',
    body: {
      model,
      video_url: videoUrl,
      upscale_factor: options.upscaleFactor ?? 2,
    },
    spinnerText: 'Queueing video upscale...',
  });
  const queued = parseQueueResponse(response, '/video/queue', model);

  trackUsage({ command: 'video', model });
  return queued;
}

export async function quoteVideoGeneration(options: {
  model: string;
  duration: string;
  aspectRatio?: string;
  resolution?: string;
  upscaleFactor?: number;
  audio?: boolean;
  videoUrl?: string;
}): Promise<{ quote: number }> {
  const body: Record<string, unknown> = {
    model: options.model,
    duration: options.duration,
  };
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
  if (options.resolution) body.resolution = options.resolution;
  if (options.upscaleFactor !== undefined) body.upscale_factor = options.upscaleFactor;
  if (options.audio !== undefined) body.audio = options.audio;
  if (options.videoUrl) body.video_url = options.videoUrl;

  const response = await apiRequest<unknown>('/video/quote', {
    method: 'POST',
    body,
    idempotent: true,
    spinnerText: 'Fetching video quote...',
  });
  return parseQuoteResponse(response, '/video/quote');
}

export async function completeVideo(
  queueId: string,
  model: string
): Promise<{ success: boolean }> {
  const response = await apiRequest<unknown>('/video/complete', {
    method: 'POST',
    body: { queue_id: queueId, model },
    spinnerText: 'Cleaning up video...',
  });
  return parseCompleteResponse(response, '/video/complete');
}

export async function transcribeVideo(
  url: string
): Promise<{ transcript: string; lang?: string }> {
  return apiRequest('/video/transcriptions', {
    method: 'POST',
    body: { url, response_format: 'json' },
    spinnerText: 'Transcribing video...',
  });
}

// Video generation - check status / retrieve result
export async function getVideoStatus(
  queueId: string,
  model: string
): Promise<VideoStatusResult> {
  const result = await retrieveVideoResponse(queueId, model, {
    spinnerText: 'Checking video status...',
    statusOnly: true,
  });

  if (result.kind === 'video') {
    return { status: 'completed' };
  }

  return result.status;
}

// Video generation - retrieve video
export async function retrieveVideo(
  queueId: string,
  model: string,
  options: {
    outputPath?: string;
    maxBytes?: number;
  } = {}
): Promise<VideoRetrieveResult> {
  return retrieveVideoResponse(queueId, model, {
    spinnerText: 'Retrieving video...',
    outputPath: options.outputPath,
    maxBytes: options.maxBytes,
  });
}

export interface AudioGenerationOptions {
  model: string;
  durationSeconds?: number;
  lyricsPrompt?: string;
  forceInstrumental?: boolean;
}

export interface AudioProcessingStatus {
  status: string;
  average_execution_time?: number;
  execution_duration?: number;
  error?: string;
}

export type AudioRetrieveResult =
  | { kind: 'processing'; status: AudioProcessingStatus }
  | { kind: 'audio'; response: Response; contentType: string; sizeBytes?: number };

function audioGenerationBody(
  prompt: string,
  options: AudioGenerationOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    prompt,
  };

  if (options.durationSeconds !== undefined) {
    body.duration_seconds = options.durationSeconds;
  }
  if (options.lyricsPrompt !== undefined) {
    body.lyrics_prompt = options.lyricsPrompt;
  }
  if (options.forceInstrumental !== undefined) {
    body.force_instrumental = options.forceInstrumental;
  }

  return body;
}

// Music and sound effects - get a price quote
export async function quoteAudioGeneration(
  model: string,
  options: { durationSeconds?: number; characterCount?: number } = {}
): Promise<{ quote: number }> {
  const body: Record<string, unknown> = { model };
  if (options.durationSeconds !== undefined) {
    body.duration_seconds = options.durationSeconds;
  }
  if (options.characterCount !== undefined) {
    body.character_count = options.characterCount;
  }

  const response = await apiRequest<unknown>('/audio/quote', {
    method: 'POST',
    body,
    idempotent: true,
    spinnerText: 'Fetching audio quote...',
  });
  return parseQuoteResponse(response, '/audio/quote');
}

// Music and sound effects - queue a generation job
export async function queueAudioGeneration(
  prompt: string,
  options: AudioGenerationOptions
): Promise<{ model: string; queue_id: string; status?: string }> {
  const response = await apiRequest<unknown>('/audio/queue', {
    method: 'POST',
    body: audioGenerationBody(prompt, options),
    spinnerText: 'Queueing audio generation...',
  });
  const queued = parseQueueResponse(response, '/audio/queue', options.model);

  trackUsage({ command: 'music', model: options.model });
  return queued;
}

async function readBodyBeforeDeadline(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  label: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const deadline = Date.now() + timeoutMs;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)),
            Math.max(0, deadline - Date.now())
          );
        }),
      ]).finally(() => clearTimeout(timeoutId));
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`${label} exceeded the maximum expected size.`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).toString('utf-8');
}

function withInactivityTimeout(response: Response, timeoutMs: number): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await readWithInactivityTimeout(reader, timeoutMs);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Music and sound effects - retrieve processing status or completed binary audio
export async function retrieveGeneratedAudio(
  queueId: string,
  model: string,
  options: { statusTimeoutMs?: number; inactivityTimeoutMs?: number } = {}
): Promise<AudioRetrieveResult> {
  const response = await apiRequest<Response>('/audio/retrieve', {
    method: 'POST',
    body: { queue_id: queueId, model, delete_media_on_completion: false },
    idempotent: true,
    stream: true,
    showSpinner: false,
  });
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';

  if (contentType === 'application/json') {
    const body = await readBodyBeforeDeadline(
      response,
      MAX_AUDIO_STATUS_BYTES,
      options.statusTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'Audio status response'
    );
    return {
      kind: 'processing',
      status: parseJobStatus<AudioProcessingStatus>(
        parseJsonText(body, '/audio/retrieve'),
        '/audio/retrieve',
        AUDIO_STATUS_FIELDS
      ),
    };
  }

  if (!['audio/mpeg', 'audio/wav', 'audio/flac'].includes(contentType)) {
    throw new Error(
      `Unexpected audio response content type "${contentType || 'missing'}".`
    );
  }

  return {
    kind: 'audio',
    response: withInactivityTimeout(
      response,
      options.inactivityTimeoutMs ?? AUDIO_DOWNLOAD_INACTIVITY_TIMEOUT_MS
    ),
    contentType,
    sizeBytes: (() => {
      const value = response.headers.get('content-length');
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    })(),
  };
}

// Music and sound effects - clean up stored media after a successful download
export async function completeAudioGeneration(
  queueId: string,
  model: string
): Promise<{ success: boolean }> {
  const response = await apiRequest<unknown>('/audio/complete', {
    method: 'POST',
    body: { queue_id: queueId, model },
    spinnerText: 'Cleaning up generated audio...',
  });
  return parseCompleteResponse(response, '/audio/complete');
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

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  date: string;
};

export type DedicatedWebSearchResponse = {
  query: string;
  results: WebSearchResult[];
};

// Web search without model inference
export async function dedicatedWebSearch(
  query: string,
  options: {
    limit?: number;
    provider?: 'brave' | 'google';
  } = {}
): Promise<DedicatedWebSearchResponse> {
  return apiRequest<DedicatedWebSearchResponse>('/augment/search', {
    method: 'POST',
    body: {
      query,
      limit: options.limit ?? 10,
      search_provider: options.provider ?? 'brave',
    },
    spinnerText: 'Searching the web...',
  });
}

export type WebScrapeResponse = {
  url: string;
  content: string;
  format: 'markdown';
};

// Scrape a public page to Markdown without model inference
export async function scrapeWebPage(url: string): Promise<WebScrapeResponse> {
  return apiRequest<WebScrapeResponse>('/augment/scrape', {
    method: 'POST',
    body: { url },
    spinnerText: 'Scraping page...',
  });
}

export type DocumentParseResponse = {
  text: string;
  tokens: number;
};

function sanitizeMultipartFilename(filename: string): string {
  return filename.replace(/[\u0000-\u001f\u007f"\\]/g, '_');
}

// Parse a document without model inference
export async function parseDocument(filePath: string): Promise<DocumentParseResponse> {
  const fs = await import('fs');
  const path = await import('path');
  const crypto = await import('crypto');

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileSize = assertFileSizeWithinLimit(
    filePath,
    MAX_DOCUMENT_PARSE_BYTES,
    'Document'
  );
  const filename = path.basename(filePath);
  const mimeType = mimeTypeFromPath(filePath);
  const boundary = `----venice-cli-${crypto.randomUUID()}`;
  const CRLF = '\r\n';
  const safeFilename = sanitizeMultipartFilename(filename);
  const headerBuffer = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
    `json${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${safeFilename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`,
    'utf-8'
  );
  const footerBuffer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf-8');
  const contentLength = headerBuffer.length + fileSize + footerBuffer.length;
  const multipartBody = Readable.from((async function* () {
    yield headerBuffer;
    for await (const chunk of fs.createReadStream(filePath)) {
      yield chunk;
    }
    yield footerBuffer;
  })());

  const spinner = startSpinner('Parsing document...');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOCUMENT_PARSE_TIMEOUT_MS);

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
      redirect: 'error',
    };
    const response = await fetch(`${VENICE_API}/augment/text-parser`, requestInit);

    if (!response.ok) {
      throw VeniceApiError.fromResponse(response.status, await readErrorBody(response));
    }

    const responseBytes = await readResponseBodyWithLimit(
      response,
      MAX_DOCUMENT_PARSE_RESPONSE_BYTES,
      'Document parse response'
    );
    const responseBody = responseBytes.toString('utf-8');
    if (responseBody.trim().length === 0) {
      throw new ResponseValidationError('Document parse response was empty; expected JSON.');
    }

    let parsedResponse: DocumentParseResponse;
    try {
      parsedResponse = JSON.parse(responseBody) as DocumentParseResponse;
    } catch {
      throw new ResponseValidationError('Document parse response contained malformed JSON.');
    }

    if (spinner) stopSpinner(true);
    return parsedResponse;
  } catch (error) {
    if (spinner) stopSpinner(false);
    throw paidRequestError(
      error,
      'Document parsing timed out after 10 minutes. ' +
      'Check your connection or try a smaller document.'
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

// TEE Attestation types
export type TeeAttestationResponse = {
  verified?: boolean;
  nonce: string;
  model: string;
  intel_quote?: string;
  signing_address?: string;
  signing_key?: string;
  signing_public_key?: string;
  nvidia_payload?: string;
  server_verification?: {
    tdx?: { valid: boolean; error?: string };
    nvidia?: { valid: boolean; error?: string };
    signingAddressBinding?: { bound: boolean; error?: string };
    nonceBinding?: { bound: boolean; method?: 'sha256' | 'raw'; error?: string };
    verifiedAt: string;
    verificationDurationMs: number;
  };
  tee_provider?: string;
};

export type TeeSignatureResponse = {
  text?: string;
  signature?: string | { algorithm?: string; value?: string; public_key?: string };
  signing_address?: string;
  payload?: { request_hash?: string; response_hash?: string; timestamp?: string };
  model?: string;
  request_id?: string;
  requested_request_id?: string;
  tee_provider?: string;
  tee_hardware?: string;
};

function generateClientNonce(): string {
  return randomBytes(32).toString('hex');
}

// Fetch TEE attestation for a model
export async function fetchTeeAttestation(
  modelId: string,
  options: { showSpinner?: boolean } = {}
): Promise<{
  response: TeeAttestationResponse;
  clientNonce: string;
}> {
  const { showSpinner = true } = options;
  const clientNonce = generateClientNonce();
  const endpoint = `/tee/attestation?model=${encodeURIComponent(modelId)}&nonce=${clientNonce}`;

  const response = await apiRequest<TeeAttestationResponse>(endpoint, {
    method: 'GET',
    showSpinner,
    spinnerText: 'Fetching TEE attestation...',
    retries: 5,
  });

  return { response, clientNonce };
}

// Fetch TEE signature for a completed request
export async function fetchTeeSignature(
  modelId: string,
  completionId: string
): Promise<TeeSignatureResponse> {
  const endpoint = `/tee/signature?request_id=${encodeURIComponent(completionId)}&model=${encodeURIComponent(modelId)}`;

  return apiRequest<TeeSignatureResponse>(endpoint, {
    method: 'GET',
    spinnerText: 'Fetching TEE signature...',
    retries: 1,
  });
}

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: number | string;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: JsonRpcErrorObject;
};

export type CryptoRpcResult = {
  body: JsonRpcResponse | JsonRpcResponse[];
  // The response as sent, so integers beyond 2^53 can be printed exactly.
  text: string;
  credits?: string;
  costUsd?: string;
  requestId?: string;
};

export const MAX_RPC_RESPONSE_BYTES = 32 * 1024 * 1024;

export async function listCryptoNetworks(): Promise<string[]> {
  const response = await apiRequest<{ networks?: string[] }>('/crypto/rpc/networks', {
    method: 'GET',
    authenticated: false,
    spinnerText: 'Fetching RPC networks...',
  });
  return response.networks ?? [];
}

export function validateIdempotencyKey(key: string): void {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(key)) {
    throw new Error(
      'Invalid idempotency key. Use 1-255 characters from A-Z, a-z, 0-9, "_" and "-".'
    );
  }
}

export async function cryptoRpc(
  network: string,
  body: JsonRpcRequest | JsonRpcRequest[],
  options: { idempotencyKey?: string } = {}
): Promise<CryptoRpcResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(network)) {
    throw new Error(
      'Invalid RPC network slug. Use "venice rpc networks" to list supported networks.'
    );
  }

  // The server binds a key to one request body. A batch is a single POST; if
  // batches are ever split across requests, each request needs its own key.
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  validateIdempotencyKey(idempotencyKey);

  let credits: string | undefined;
  let costUsd: string | undefined;
  let requestId: string | undefined;

  const { value, text } = await apiRequest<{ value: JsonRpcResponse | JsonRpcResponse[]; text: string }>(
    `/crypto/rpc/${encodeURIComponent(network)}`,
    {
      method: 'POST',
      body,
      idempotent: true,
      responseType: 'jsonText',
      maxResponseBytes: MAX_RPC_RESPONSE_BYTES,
      responseLabel: 'RPC response',
      spinnerText: 'Sending RPC request...',
      additionalHeaders: { 'Idempotency-Key': idempotencyKey },
      onHeaders: (headers) => {
        credits = headers.get('x-venice-rpc-credits') ?? undefined;
        costUsd = headers.get('x-venice-rpc-cost-usd') ?? undefined;
        requestId = headers.get('x-request-id') ?? undefined;
      },
    }
  );

  return { body: value, text, credits, costUsd, requestId };
}
