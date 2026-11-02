/**
 * Venice CLI Type Definitions
 */

export interface VeniceConfig {
  api_key?: string;
  default_model?: string;
  default_image_model?: string;
  default_voice?: string;
  output_format?: OutputFormat;
  no_color?: boolean;
  show_usage?: boolean;
}

export type OutputFormat = 'pretty' | 'json' | 'markdown' | 'raw';

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export interface InputAudioContentPart {
  type: 'input_audio';
  input_audio: { data: string; format: string };
}

export interface VideoUrlContentPart {
  type: 'video_url';
  video_url: { url: string };
}

export interface FileContentPart {
  type: 'file';
  file: { file_data: string; filename?: string };
}

export type ContentPart =
  | TextContentPart
  | ImageUrlContentPart
  | InputAudioContentPart
  | VideoUrlContentPart
  | FileContentPart;

export type MessageContent = string | ContentPart[];

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'image_url':
          return '[image]';
        case 'input_audio':
          return '[audio]';
        case 'video_url':
          return '[video]';
        case 'file': {
          const filename = safeAttachmentFilename(part.file.filename);
          return filename ? `[file: ${filename}]` : '[file]';
        }
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join(' ');
}

function safeAttachmentFilename(filename: string | undefined): string | undefined {
  if (!filename || /^(?:data|https?):/i.test(filename)) return undefined;
  const safe = filename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .trim()
    .slice(0, 255);
  return safe || undefined;
}

export function sanitizeMessagesForHistory(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: messageContentToText(message.content),
  }));
}

export function isTextMessageContent(content: MessageContent): content is string {
  return typeof content === 'string';
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ChatCompletionOptions {
  model?: string;
  stream?: boolean;
  system?: string;
  format?: OutputFormat;
  character?: string;
  tools?: string[];
  continue?: boolean;
  conversationId?: string;
}

export interface ImageGenerationOptions {
  model?: string;
  output?: string;
  width?: number;
  height?: number;
  count?: number;
  format?: 'jpeg' | 'png' | 'webp';
  aspectRatio?: string;
  resolution?: '1K' | '2K' | '4K';
  quality?: 'low' | 'medium' | 'high';
  stylePreset?: string;
  styleReferences?: ImageStyleReference[];
  negativePrompt?: string;
  seed?: number;
  cfgScale?: number;
  steps?: number;
  loraStrength?: number;
  hideWatermark?: boolean;
  safeMode?: boolean;
  embedExifMetadata?: boolean;
}

export interface ImageStyleReference {
  image: string;
  strength?: number;
}

export interface TTSOptions {
  voice?: string;
  model?: string;
  output?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
  speed?: number;
  temperature?: number;
  streaming?: boolean;
}

export interface TranscribeOptions {
  model?: string;
  format?: OutputFormat;
}

export interface SearchOptions {
  model?: string;
  results?: number;
  format?: OutputFormat;
}

export type ConversationPrivacy = 'plain' | 'e2ee' | 'tee';

export interface ConversationEntry {
  id: string;
  timestamp: string;
  messages: Message[];
  model: string;
  character?: string;
  privacy?: ConversationPrivacy;
}

export interface UsageRecord {
  timestamp: string;
  command: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ModelCapabilities {
  privacy?: boolean;
  supportsTeeAttestation?: boolean;
  supportsE2EE?: boolean;
  supportsResponseSchema?: boolean;
  supportsReasoning?: boolean;
  supportsReasoningEffort?: boolean;
  supportsXSearch?: boolean;
  supportsVision?: boolean;
  supportsMultipleImages?: boolean;
  maxImages?: number;
  supportsAudioInput?: boolean;
  supportsVideoInput?: boolean;
  maxVideos?: number;
}

export interface Model {
  id: string;
  type?: string;
  model_spec?: {
    description?: string;
    capabilities?: ModelCapabilities;
    voices?: string[];
    default_voice?: string;
    supported_formats?: string[];
    default_format?: string;
    supports_custom_voice_id?: boolean;
    voice_cloning?: {
      mode: 'zero_shot' | 'persistent';
      accepted_formats: string[];
      min_sample_seconds: number;
      retention_days: number;
    };
  };
}

export const isE2EEModel = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsE2EE === true;

export const isTEEModel = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsTeeAttestation === true;

export const supportsResponseSchema = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsResponseSchema === true;

export const supportsReasoningEffort = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsReasoningEffort === true;

export const supportsXSearch = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsXSearch === true;

export const supportsVision = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsVision === true;

export const supportsMultipleImages = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsMultipleImages === true;

export const supportsAudioInput = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsAudioInput === true;

export const supportsVideoInput = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsVideoInput === true;

export interface CharacterStats {
  averageRating: number;
  imports: number;
  ratingCount: number;
  ratingSum: number;
  userRating: number | null;
}

export interface Character {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  adult: boolean;
  featured: boolean;
  modelId: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  webEnabled: boolean;
  shareUrl: string | null;
  photoUrl: string | null;
  stats: CharacterStats;
}

export interface CharacterReview {
  id: string;
  characterId: string;
  createdAt: string;
  isOwner: boolean;
  locale: string | null;
  message: string | null;
  rating: number;
  userAvatarUrl: string | null;
  username: string;
}

export interface CharacterReviewsPage {
  data: CharacterReview[];
  object: 'list';
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  summary: {
    averageRating: number;
    totalReviews: number;
  };
}

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}
