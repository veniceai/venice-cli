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

export interface ModelCapabilities {
  privacy?: boolean;
  supportsTeeAttestation?: boolean;
  supportsE2EE?: boolean;
}

export interface Model {
  id: string;
  type?: string;
  model_spec?: {
    description?: string;
    capabilities?: ModelCapabilities;
  };
}

export const isE2EEModel = (model: Model): boolean =>
  model.type === 'text' && model.model_spec?.capabilities?.supportsE2EE === true;

export const isTEEModel = (model: Model): boolean =>
  model.model_spec?.capabilities?.supportsTeeAttestation === true;

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

// --- Codex Tool System ---

export type PermissionMode = 'prompt' | 'auto' | 'read-only';

export interface ToolContext {
  cwd: string;
  approve: (toolName: string, summary: string) => Promise<boolean>;
}

export interface ToolResult {
  output: string;
  error?: boolean;
}

export interface CodingTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  isReadOnly: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface AgentEvent {
  type: 'content' | 'tool_call' | 'tool_result' | 'thinking' | 'usage' | 'done' | 'error' | 'max_iterations';
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: ToolResult;
  data?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  message?: string;
  count?: number;
}
