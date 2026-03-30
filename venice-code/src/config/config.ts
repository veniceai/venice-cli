/**
 * Configuration management for Venice Code
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import type { Config, PartialConfig } from '../types/index.js';
import { DEFAULT_CONFIG, CONFIG_DIR, CONFIG_PATH } from './defaults.js';

let cachedConfig: Config | null = null;

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load configuration from file
 */
export async function loadConfig(): Promise<Config> {
  if (cachedConfig) {
    return cachedConfig;
  }

  await ensureConfigDir();

  if (!existsSync(CONFIG_PATH)) {
    // Create default config file
    cachedConfig = { ...DEFAULT_CONFIG };
    await saveConfig(cachedConfig);
    return cachedConfig;
  }

  try {
    const content = await readFile(CONFIG_PATH, 'utf-8');
    const loaded = JSON.parse(content) as PartialConfig;
    
    // Merge with defaults to handle missing keys
    cachedConfig = {
      ...DEFAULT_CONFIG,
      ...loaded,
    };
    
    return cachedConfig;
  } catch (error) {
    throw new Error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  
  try {
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    cachedConfig = config;
  } catch (error) {
    throw new Error(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Update specific config values
 */
export async function updateConfig(updates: PartialConfig): Promise<Config> {
  const current = await loadConfig();
  const updated = { ...current, ...updates };
  await saveConfig(updated);
  return updated;
}

/**
 * Get a specific config value
 */
export async function getConfigValue<K extends keyof Config>(key: K): Promise<Config[K]> {
  const config = await loadConfig();
  return config[key];
}

/**
 * Set a specific config value
 */
export async function setConfigValue<K extends keyof Config>(
  key: K,
  value: Config[K]
): Promise<void> {
  await updateConfig({ [key]: value } as PartialConfig);
}

/**
 * Get API key from config or environment
 */
export async function getApiKey(): Promise<string> {
  // Check environment variable first
  const envKey = process.env.VENICE_API_KEY;
  if (envKey) {
    return envKey;
  }

  // Check config file
  const config = await loadConfig();
  if (config.api_key) {
    return config.api_key;
  }

  throw new Error(
    'No API key found. Set VENICE_API_KEY environment variable or run: venice-code init'
  );
}

/**
 * Check if API key is configured
 */
export async function hasApiKey(): Promise<boolean> {
  try {
    await getApiKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Reset config to defaults
 */
export async function resetConfig(): Promise<Config> {
  const config = { ...DEFAULT_CONFIG };
  await saveConfig(config);
  return config;
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
