/**
 * Core type definitions for Venice Code
 */

// ============================================================================
// API Types
// ============================================================================

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
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
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: Message;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface Config {
  api_key?: string;
  default_model: string;
  embeddings_model: string;
  auto_approve: boolean;
  backup_enabled: boolean;
  index_path: string;
  max_file_size: number;
  ignore_patterns: string[];
  verbose: boolean;
}

export type PartialConfig = Partial<Config>;

// ============================================================================
// Tool Types
// ============================================================================

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
  execute: (args: any) => Promise<string>;
}

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolResult {
  tool_call_id: string;
  output: string;
  error?: string;
}

// ============================================================================
// File System Types
// ============================================================================

export interface FileInfo {
  path: string;
  content: string;
  size: number;
  modified: Date;
}

export interface SearchMatch {
  path: string;
  line: number;
  content: string;
  match: string;
}

export interface PatchLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
}

export interface Patch {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
}

export interface PatchResult {
  success: boolean;
  file: string;
  error?: string;
  backup?: string;
}

// ============================================================================
// Embeddings & Vector Store Types
// ============================================================================

export interface FileChunk {
  id: string;
  file: string;
  content: string;
  start_line: number;
  end_line: number;
  embedding?: number[];
}

export interface VectorStoreEntry {
  id: string;
  file: string;
  chunk: string;
  start_line: number;
  end_line: number;
  embedding: number[];
  updated: string;
}

export interface VectorStore {
  version: string;
  entries: VectorStoreEntry[];
  indexed_at: string;
}

export interface SearchResult {
  file: string;
  chunk: string;
  start_line: number;
  end_line: number;
  similarity: number;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentContext {
  messages: Message[];
  tools: Tool[];
  config: Config;
  projectPath: string;
}

export interface AgentStep {
  type: 'message' | 'tool_call' | 'tool_result' | 'final';
  content: any;
  timestamp: Date;
}

export interface AgentResult {
  success: boolean;
  message: string;
  steps: AgentStep[];
  error?: string;
}

// ============================================================================
// Command Types
// ============================================================================

export interface CommandOptions {
  model?: string;
  autoApprove?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface ExplainOptions extends CommandOptions {
  format?: 'text' | 'markdown';
}

export interface FixOptions extends CommandOptions {
  test?: boolean;
}

export interface RefactorOptions extends CommandOptions {
  pattern?: string;
}

export interface EditOptions extends CommandOptions {
  files?: string[];
}

// ============================================================================
// Utility Types
// ============================================================================

export interface SpinnerOptions {
  text: string;
  color?: string;
}

export interface LogLevel {
  level: 'info' | 'warn' | 'error' | 'debug' | 'success';
  message: string;
  timestamp: Date;
}
