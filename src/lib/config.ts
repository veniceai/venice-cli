/**
 * Configuration Management for Venice CLI
 * 
 * Stores config in ~/.venice/config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { VeniceConfig } from '../types/index.js';

const CONFIG_DIR = path.join(os.homedir(), '.venice');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json');

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): VeniceConfig {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Return empty config on error
  }
  return {};
}

export function saveConfig(config: VeniceConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getConfigValue(key: keyof VeniceConfig): unknown {
  const config = loadConfig();
  return config[key];
}

export function setConfigValue(key: keyof VeniceConfig, value: string): void {
  const config = loadConfig();
  
  // Handle boolean conversions
  if (key === 'no_color' || key === 'show_usage') {
    (config as any)[key] = value === 'true' || value === '1';
  } else {
    (config as any)[key] = value;
  }
  
  saveConfig(config);
}

export function deleteConfigValue(key: keyof VeniceConfig): void {
  const config = loadConfig();
  delete config[key];
  saveConfig(config);
}

export function getApiKey(): string | undefined {
  // Priority: env var > config file
  const envKey = process.env.VENICE_API_KEY;
  if (envKey) return envKey;
  
  const config = loadConfig();
  return config.api_key;
}

export function requireApiKey(): string {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      'No API key found.\n\n' +
      'Set your API key using one of these methods:\n' +
      '  1. venice config set api_key <your-key>\n' +
      '  2. export VENICE_API_KEY=<your-key>\n\n' +
      'Get your API key at: https://venice.ai/settings/api'
    );
  }
  return key;
}

export function getDefaultModel(): string {
  const config = loadConfig();
  return config.default_model || 'llama-3.3-70b';
}

export function getDefaultImageModel(): string {
  const config = loadConfig();
  return config.default_image_model || 'fluently-xl';
}

export function getDefaultVoice(): string {
  const config = loadConfig();
  return config.default_voice || 'af_sky';
}

export function getOutputFormat(): string {
  const config = loadConfig();
  return config.output_format || 'pretty';
}

export function isColorEnabled(): boolean {
  const config = loadConfig();
  // Disable color if no_color is set or NO_COLOR env is set or not a TTY
  if (config.no_color) return false;
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

export function shouldShowUsage(): boolean {
  const config = loadConfig();
  return config.show_usage ?? true;
}

// History management
export interface ConversationEntry {
  id: string;
  timestamp: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
  character?: string;
}

export function loadHistory(): ConversationEntry[] {
  ensureConfigDir();
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Return empty on error
  }
  return [];
}

export function saveHistory(history: ConversationEntry[]): void {
  ensureConfigDir();
  // Keep only last 100 conversations
  const trimmed = history.slice(-100);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
}

export function addConversation(entry: ConversationEntry): void {
  const history = loadHistory();
  history.push(entry);
  saveHistory(history);
}

export function getLastConversation(): ConversationEntry | undefined {
  const history = loadHistory();
  return history[history.length - 1];
}

export function clearHistory(): void {
  ensureConfigDir();
  if (fs.existsSync(HISTORY_FILE)) {
    fs.unlinkSync(HISTORY_FILE);
  }
}

// Usage tracking
export interface UsageEntry {
  timestamp: string;
  command: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export function loadUsage(): UsageEntry[] {
  ensureConfigDir();
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const content = fs.readFileSync(USAGE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Return empty on error
  }
  return [];
}

export function saveUsage(usage: UsageEntry[]): void {
  ensureConfigDir();
  // Keep only last 30 days of usage
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const filtered = usage.filter(u => new Date(u.timestamp) > thirtyDaysAgo);
  fs.writeFileSync(USAGE_FILE, JSON.stringify(filtered, null, 2), { mode: 0o600 });
}

export function trackUsage(entry: Omit<UsageEntry, 'timestamp'>): void {
  const usage = loadUsage();
  usage.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  saveUsage(usage);
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
