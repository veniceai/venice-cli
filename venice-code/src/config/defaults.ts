/**
 * Default configuration values
 */

import type { Config } from '../types/index.js';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_CONFIG: Config = {
  default_model: 'qwen-3-235b-a10b',
  embeddings_model: 'text-embedding-3-large',
  auto_approve: false,
  backup_enabled: true,
  index_path: join(homedir(), '.config', 'venice-code', 'index.json'),
  max_file_size: 1048576, // 1MB
  ignore_patterns: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.output',
    '.vscode',
    '.idea',
    '*.log',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ],
  verbose: false,
};

export const CONFIG_DIR = join(homedir(), '.config', 'venice-code');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const BACKUP_DIR = join(CONFIG_DIR, 'backups');
