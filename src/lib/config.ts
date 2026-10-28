/**
 * Configuration Management for Venice CLI
 * 
 * Stores config in ~/.venice/config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Message, VeniceConfig } from '../types/index.js';
import { sanitizeMessagesForHistory } from '../types/index.js';
import { writeFileAtomic } from './safe-write.js';

const CONFIG_DIR = path.join(os.homedir(), '.venice');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json');

export function ensureConfigDir(): void {
  if (fs.existsSync(CONFIG_DIR)) {
    const stat = fs.lstatSync(CONFIG_DIR);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Config path is not a directory: ${CONFIG_DIR}`);
    }
  } else {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(CONFIG_DIR, 0o700);
}

export function loadConfig(): VeniceConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }

  assertRegularConfigFile();

  let content: string;
  try {
    content = fs.readFileSync(CONFIG_FILE, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw configFileError(`could not be read (${code})`);
  }

  // The JSON.parse message can quote file contents, which include the API key.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw configFileError('is not valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configFileError('must contain a JSON object');
  }
  return parsed as VeniceConfig;
}

function configFileError(reason: string): Error {
  return new Error(
    `Config file ${CONFIG_FILE} ${reason}.\n` +
    'Fix or remove the file, then run "venice config set api_key" if needed.'
  );
}

// For display-only settings read while formatting errors, so they must not throw.
function loadConfigOrDefaults(): VeniceConfig {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

export function saveConfig(config: VeniceConfig): void {
  // Refuse to replace a file we cannot parse, or its api_key would be lost.
  loadConfig();

  const temporaryFile = path.join(
    CONFIG_DIR,
    `.config-${process.pid}-${randomUUID()}.tmp`
  );
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.fchmodSync(fileDescriptor, 0o600);
    fs.writeFileSync(fileDescriptor, JSON.stringify(config, null, 2));
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryFile, CONFIG_FILE);
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

function assertRegularConfigFile(): void {
  const stat = fs.lstatSync(CONFIG_FILE);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Config path is not a regular file: ${CONFIG_FILE}`);
  }
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
      '  1. venice config set api_key (prompts without showing the key)\n' +
      '  2. venice config set api_key --stdin (reads the key from standard input)\n' +
      '  3. export VENICE_API_KEY=<your-key>\n\n' +
      'Get your API key at: https://venice.ai/settings/api'
    );
  }
  return key;
}

export function getDefaultModel(): string {
  const config = loadConfig();
  return config.default_model || 'kimi-k2-5';
}

export function getDefaultImageModel(): string {
  const config = loadConfig();
  return config.default_image_model || 'flux-2-pro';
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
  const config = loadConfigOrDefaults();
  // Disable color if no_color is set or NO_COLOR env is set or not a TTY
  if (config.no_color) return false;
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

export function shouldShowUsage(): boolean {
  const config = loadConfigOrDefaults();
  return config.show_usage ?? true;
}

// History management
export interface ConversationEntry {
  id: string;
  timestamp: string;
  messages: Message[];
  model: string;
  character?: string;
  privacy?: 'plain' | 'e2ee' | 'tee';
}

/**
 * A history or usage file that exists but cannot be used. A missing file
 * loads as an empty list instead, so callers can tell the two apart.
 */
export class DataFileError extends Error {
  constructor(readonly filePath: string, label: string, reason: string) {
    super(`${label} file ${filePath} ${reason}.\nFix or remove the file.`);
    this.name = 'DataFileError';
  }
}

// Returns undefined when the file does not exist.
function readDataFile(filePath: string, label: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    if (code === 'ENOENT') return undefined;
    throw new DataFileError(filePath, label, `could not be read (${code})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DataFileError(filePath, label, 'is not a regular file');
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new DataFileError(filePath, label, `could not be read (${code})`);
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new DataFileError(filePath, label, 'is not valid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeDataFileFailure(filePath: string, error: unknown): string {
  if (error instanceof DataFileError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `Could not update ${filePath}: ${message}`;
}

function isConversationEntry(value: unknown): value is ConversationEntry {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.model === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every((message) => isRecord(message) && typeof message.role === 'string');
}

function readHistoryFile(): ConversationEntry[] {
  const parsed = readDataFile(HISTORY_FILE, 'History');
  if (parsed === undefined) return [];

  let history: ConversationEntry[] | undefined;
  if (Array.isArray(parsed) && parsed.every(isConversationEntry)) {
    try {
      history = parsed.map(sanitizeConversationForHistory);
    } catch {
      // Message content in a shape this CLI never writes.
    }
  }
  if (history === undefined) {
    throw new DataFileError(HISTORY_FILE, 'History', 'must contain a JSON array of conversations');
  }
  return history;
}

function writeHistoryFile(history: ConversationEntry[]): void {
  // Keep only last 100 conversations
  const trimmed = history.slice(-100).map(sanitizeConversationForHistory);
  writeFileAtomic(HISTORY_FILE, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
}

export function loadHistory(): ConversationEntry[] {
  ensureConfigDir();
  return removeOlderPrivateConversations(readHistoryFile());
}

// Older builds saved E2EE and TEE chats here, without a privacy field; drop
// them the first time this version loads history.
function removeOlderPrivateConversations(history: ConversationEntry[]): ConversationEntry[] {
  const kept = history.filter((entry) => !isPrivateModeConversation(entry));
  const removed = history.length - kept.length;
  if (removed === 0) return history;

  const count = `${removed} private-mode conversation${removed === 1 ? '' : 's'}`;
  try {
    writeHistoryFile(kept);
    console.error(`Removed ${count} saved by an older version from ${HISTORY_FILE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Warning: could not remove ${count} saved by an older version from ${HISTORY_FILE}: ${message}\n` +
      'Run "venice history clear" to delete all saved history.'
    );
  }
  return kept;
}

function isPrivateModeConversation(entry: ConversationEntry): boolean {
  if (typeof entry.privacy === 'string') {
    return entry.privacy === 'e2ee' || entry.privacy === 'tee';
  }
  const model = entry.model.toLowerCase();
  return model.includes('e2ee') || model.startsWith('tee-') || model.includes('-tee');
}

export function saveHistory(history: ConversationEntry[]): void {
  ensureConfigDir();
  // Refuse to replace a file we cannot parse, or its conversations would be lost.
  readHistoryFile();
  writeHistoryFile(history);
}

// Called after the reply was shown, so a history problem must not fail the chat.
export function addConversation(entry: ConversationEntry): void {
  try {
    const history = loadHistory();
    history.push(sanitizeConversationForHistory(entry));
    saveHistory(history);
  } catch (error) {
    console.error(
      `Warning: the conversation was not saved to history. ${describeDataFileFailure(HISTORY_FILE, error)}`
    );
  }
}

export function sanitizeConversationForHistory(
  entry: ConversationEntry
): ConversationEntry {
  return {
    ...entry,
    messages: sanitizeMessagesForHistory(entry.messages),
  };
}

export function getLastConversation(): ConversationEntry | undefined {
  const history = loadHistory();
  return history[history.length - 1];
}

export function clearHistory(): void {
  ensureConfigDir();
  fs.rmSync(HISTORY_FILE, { force: true });
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

function readUsageFile(): UsageEntry[] {
  const parsed = readDataFile(USAGE_FILE, 'Usage');
  if (parsed === undefined) return [];
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => isRecord(entry) && typeof entry.timestamp === 'string')
  ) {
    throw new DataFileError(USAGE_FILE, 'Usage', 'must contain a JSON array of usage records');
  }
  return parsed as UsageEntry[];
}

export function loadUsage(): UsageEntry[] {
  ensureConfigDir();
  return readUsageFile();
}

export function saveUsage(usage: UsageEntry[]): void {
  ensureConfigDir();
  // Refuse to replace a file we cannot parse, or its records would be lost.
  readUsageFile();
  // Keep only last 30 days of usage
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const filtered = usage.filter(u => new Date(u.timestamp) > thirtyDaysAgo);
  writeFileAtomic(USAGE_FILE, JSON.stringify(filtered, null, 2), { mode: 0o600 });
}

let usageWarningShown = false;

// Called after a paid response, so a usage problem must not fail the command.
export function trackUsage(entry: Omit<UsageEntry, 'timestamp'>): void {
  try {
    const usage = loadUsage();
    usage.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    saveUsage(usage);
  } catch (error) {
    if (usageWarningShown) return;
    usageWarningShown = true;
    console.error(`Warning: usage was not recorded. ${describeDataFileFailure(USAGE_FILE, error)}`);
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
