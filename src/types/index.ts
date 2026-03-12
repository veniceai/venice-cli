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

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
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
  format?: OutputFormat;
}

export interface TTSOptions {
  voice?: string;
  model?: string;
  output?: string;
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

export interface ConversationEntry {
  id: string;
  timestamp: string;
  messages: Message[];
  model: string;
  character?: string;
}

export interface UsageRecord {
  timestamp: string;
  command: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface Model {
  id: string;
  type?: string;
  model_spec?: {
    description?: string;
    capabilities?: {
      privacy?: boolean;
    };
  };
}

export interface Character {
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
}

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}
