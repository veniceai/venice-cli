/**
 * Output formatting and display utilities
 */

import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { isColorEnabled, shouldShowUsage } from './config.js';
import type { OutputFormat } from '../types/index.js';

// Conditional chalk - returns identity functions when color is disabled
function createChalk() {
  if (!isColorEnabled()) {
    const noop = (s: string) => s;
    return {
      bold: noop,
      dim: noop,
      green: noop,
      red: noop,
      yellow: noop,
      blue: noop,
      cyan: noop,
      magenta: noop,
      gray: noop,
      white: noop,
      italic: noop,
    };
  }
  return chalk;
}

export function getChalk() {
  return createChalk();
}

// Spinner wrapper
let currentSpinner: Ora | null = null;

export function startSpinner(text: string): Ora | null {
  if (!process.stdout.isTTY) return null;
  
  currentSpinner = ora({
    text,
    color: 'cyan',
    spinner: 'dots',
  }).start();
  
  return currentSpinner;
}

export function stopSpinner(success = true, text?: string): void {
  if (currentSpinner) {
    if (success) {
      currentSpinner.succeed(text);
    } else {
      currentSpinner.fail(text);
    }
    currentSpinner = null;
  }
}

export function clearSpinner(): void {
  if (currentSpinner) {
    currentSpinner.stop();
    currentSpinner = null;
  }
}

// Format content based on output format
export function formatOutput(
  content: unknown,
  format: OutputFormat,
  _options: { label?: string } = {}
): string {
  const c = getChalk();

  switch (format) {
    case 'json':
      return JSON.stringify(content, null, 2);
    
    case 'raw':
      if (typeof content === 'string') return content;
      return JSON.stringify(content);
    
    case 'markdown':
      // Just return as-is, assuming content is markdown
      return String(content);
    
    case 'pretty':
    default:
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        return content.map((item, i) => {
          if (typeof item === 'object') {
            return formatObject(item, c);
          }
          return `  ${c.dim(`${i + 1}.`)} ${item}`;
        }).join('\n');
      }
      if (typeof content === 'object' && content !== null) {
        return formatObject(content as Record<string, unknown>, c);
      }
      return String(content);
  }
}

function formatObject(obj: Record<string, unknown>, c: ReturnType<typeof getChalk>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const formattedKey = c.cyan(key);
    if (typeof value === 'object') {
      lines.push(`${formattedKey}:`);
      lines.push(`  ${JSON.stringify(value, null, 2).split('\n').join('\n  ')}`);
    } else {
      lines.push(`${formattedKey}: ${value}`);
    }
  }
  return lines.join('\n');
}

// Error formatting
export function formatError(error: Error | string): string {
  const c = getChalk();
  const message = typeof error === 'string' ? error : error.message;
  return `${c.red('Error:')} ${message}`;
}

// Success message
export function formatSuccess(message: string): string {
  const c = getChalk();
  return `${c.green('✓')} ${message}`;
}

// Warning message
export function formatWarning(message: string): string {
  const c = getChalk();
  return `${c.yellow('⚠')} ${message}`;
}

// Info message
export function formatInfo(message: string): string {
  const c = getChalk();
  return `${c.blue('ℹ')} ${message}`;
}

// Usage display
export function formatUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): string {
  if (!shouldShowUsage()) return '';
  if (!usage.total_tokens) return '';

  const c = getChalk();
  const parts: string[] = [];
  
  if (usage.prompt_tokens) {
    parts.push(`${c.dim('prompt:')} ${usage.prompt_tokens}`);
  }
  if (usage.completion_tokens) {
    parts.push(`${c.dim('completion:')} ${usage.completion_tokens}`);
  }
  if (usage.total_tokens) {
    parts.push(`${c.dim('total:')} ${c.bold(String(usage.total_tokens))}`);
  }

  return `\n${c.dim('📊 Tokens:')} ${parts.join(' | ')}`;
}

// Table formatting
export function formatTable(
  rows: Array<Record<string, unknown>>,
  columns: Array<{ key: string; label: string; width?: number }>
): string {
  const c = getChalk();
  const lines: string[] = [];

  // Calculate column widths
  const widths = columns.map(col => {
    const maxDataWidth = Math.max(
      ...rows.map(row => String(row[col.key] || '').length),
      col.label.length
    );
    return col.width || Math.min(maxDataWidth, 50);
  });

  // Header
  const header = columns.map((col, i) => 
    c.bold(col.label.padEnd(widths[i]))
  ).join('  ');
  lines.push(header);
  
  // Separator
  lines.push(widths.map(w => c.dim('─'.repeat(w))).join('  '));

  // Data rows
  for (const row of rows) {
    const line = columns.map((col, i) => {
      const value = String(row[col.key] || '');
      const truncated = value.length > widths[i] 
        ? value.slice(0, widths[i] - 1) + '…'
        : value.padEnd(widths[i]);
      return truncated;
    }).join('  ');
    lines.push(line);
  }

  return lines.join('\n');
}

// Progress indicator for non-TTY
export function logProgress(message: string): void {
  if (process.stdout.isTTY) return;
  console.error(`[${new Date().toISOString()}] ${message}`);
}

// Check if output is being piped
export function isPiped(): boolean {
  return !process.stdout.isTTY;
}

// Detect best output format based on context
export function detectOutputFormat(explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  if (isPiped()) return 'raw';
  return 'pretty';
}
