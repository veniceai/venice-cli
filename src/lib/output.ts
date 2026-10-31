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

interface TerminalStream {
  isTTY?: boolean;
  columns?: number;
}

// Spinner wrapper
let currentSpinner: Ora | null = null;

export function canShowSpinner(stream: TerminalStream): boolean {
  return stream.isTTY === true && (stream.columns ?? 0) > 0;
}

export function startSpinner(
  text: string,
  stream: NodeJS.WritableStream & TerminalStream = process.stderr
): Ora | null {
  // ora divides by the stream's width, and a pseudo-terminal can report 0 columns.
  if (!process.stdout.isTTY || !canShowSpinner(stream)) return null;

  currentSpinner = ora({
    text,
    color: 'cyan',
    spinner: 'dots',
    stream,
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
      return formatJson(content);
    
    case 'raw':
      if (typeof content === 'string') return terminalSafe(content);
      return formatJson(content, 0);
    
    case 'markdown':
      // Just return as-is, assuming content is markdown
      return terminalSafe(content);
    
    case 'pretty':
    default:
      if (typeof content === 'string') {
        return terminalSafe(content);
      }
      if (Array.isArray(content)) {
        return content.map((item, i) => {
          if (typeof item === 'object') {
            return formatObject(item, c);
          }
          return `  ${c.dim(`${i + 1}.`)} ${terminalSafe(item)}`;
        }).join('\n');
      }
      if (typeof content === 'object' && content !== null) {
        return formatObject(content as Record<string, unknown>, c);
      }
      return terminalSafe(content);
  }
}

function formatObject(obj: Record<string, unknown>, c: ReturnType<typeof getChalk>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const formattedKey = c.cyan(terminalSafe(key));
    if (typeof value === 'object') {
      lines.push(`${formattedKey}:`);
      lines.push(`  ${formatJson(value).split('\n').join('\n  ')}`);
    } else {
      lines.push(`${formattedKey}: ${terminalSafe(value)}`);
    }
  }
  return lines.join('\n');
}

type SequenceState = 'text' | 'escape' | 'escape-intermediate' | 'csi' | 'string' | 'string-escape';

// C0 controls except tab and newline, DEL, C1 controls, bidi controls, and
// the Unicode line and paragraph separators.
const UNSAFE_TERMINAL_TEXT =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const isBidiControlOrSeparator = (code: number): boolean =>
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  code === 0x2028 ||
  code === 0x2029 ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * Removes terminal control sequences and controls from untrusted text, keeping
 * newlines and tabs. Escape sequences (CSI, OSC, DCS, SOS, PM, APC and
 * two-byte escapes, in their ESC and 8-bit C1 forms) are dropped whole, so
 * their payloads never reach the terminal. State carries over between
 * write() calls, so a sequence split across chunks is removed too.
 */
export class TerminalTextSanitizer {
  private state: SequenceState = 'text';
  private belEndsString = false;

  write(chunk: string): string {
    if (this.state === 'text' && !UNSAFE_TERMINAL_TEXT.test(chunk)) return chunk;

    let output = '';
    let runStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (!this.keep(chunk.charCodeAt(index))) {
        output += chunk.slice(runStart, index);
        runStart = index + 1;
      }
    }
    return output + chunk.slice(runStart);
  }

  // Advances by one UTF-16 code unit and reports whether it is printable text.
  private keep(code: number): boolean {
    switch (this.state) {
      case 'text':
        return this.keepText(code);
      case 'escape':
        return this.afterEscape(code);
      case 'escape-intermediate':
        if (code >= 0x20 && code <= 0x2f) return false;
        this.state = 'text';
        return code >= 0x30 && code <= 0x7e ? false : this.keepText(code);
      case 'csi':
        if (code >= 0x20 && code <= 0x3f) return false;
        this.state = 'text';
        return code >= 0x40 && code <= 0x7e ? false : this.keepText(code);
      case 'string':
        if (code === 0x1b) {
          this.state = 'string-escape';
        } else if (
          code === 0x9c ||
          code === 0x18 ||
          code === 0x1a ||
          (code === 0x07 && this.belEndsString)
        ) {
          this.state = 'text';
        }
        return false;
      case 'string-escape':
        if (code === 0x5c) {
          this.state = 'text';
          return false;
        }
        return this.afterEscape(code);
    }
  }

  private afterEscape(code: number): boolean {
    this.state = 'text';
    if (code === 0x5b) {
      this.state = 'csi';
    } else if (code === 0x5d) {
      this.startString(true);
    } else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
      this.startString(false);
    } else if (code >= 0x20 && code <= 0x2f) {
      this.state = 'escape-intermediate';
    } else if (code < 0x30 || code > 0x7e) {
      return this.keepText(code);
    }
    return false;
  }

  private keepText(code: number): boolean {
    if (code === 0x1b) {
      this.state = 'escape';
      return false;
    }
    if (code === 0x9b) {
      this.state = 'csi';
      return false;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      // Only OSC may end with BEL; DCS, SOS, PM and APC need ST.
      this.startString(code === 0x9d);
      return false;
    }
    if (code === 0x09 || code === 0x0a) return true;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
    return !isBidiControlOrSeparator(code);
  }

  private startString(belEndsString: boolean): void {
    this.state = 'string';
    this.belEndsString = belEndsString;
  }
}

export function sanitizeTerminalText(value: string): string {
  return new TerminalTextSanitizer().write(value);
}

function isTerminal(stream: TerminalStream): boolean {
  if (stream.isTTY) return true;
  // CLI tests always pipe stdout and stderr; this lets them reach the terminal path.
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.VENICE_TEST_TERMINAL_OUTPUT === '1' &&
    (stream === process.stdout || stream === process.stderr)
  );
}

/**
 * Server, model, third-party or history text to print on `stream`: sanitised
 * when the stream is a terminal, unchanged when it is piped or redirected.
 */
export function terminalSafe(value: unknown, stream: TerminalStream = process.stdout): string {
  const text = String(value);
  return isTerminal(stream) ? sanitizeTerminalText(text) : text;
}

/**
 * terminalSafe for text printed in chunks; one filter per stream of text.
 */
export function terminalFilter(stream: TerminalStream = process.stdout): (chunk: string) => string {
  if (!isTerminal(stream)) return (chunk) => chunk;
  const sanitizer = new TerminalTextSanitizer();
  return (chunk) => sanitizer.write(chunk);
}

// JSON.stringify escapes C0 controls but leaves these as raw characters.
const JSON_RAW_CONTROLS = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const unicodeEscape = (unit: string): string =>
  `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * JSON.stringify, with DEL, C1 and bidi controls and U+2028/U+2029 written as
 * \uXXXX escapes. Parsed values are unchanged.
 */
export function formatJson(value: unknown, indent = 2): string {
  return String(JSON.stringify(value, null, indent)).replace(JSON_RAW_CONTROLS, unicodeEscape);
}

// Controls, format and private-use characters, unassigned code points,
// separators other than the space, variation selectors, the combining
// grapheme joiner and the blank Hangul fillers.
const INVISIBLE_CHARACTERS =
  /(?![\n ])[\p{C}\p{Z}\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/**
 * Escapes every character that does not render visibly (except newline and
 * space) as \uXXXX, so text shown for review matches what will be used.
 */
export function escapeInvisible(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, (char) => char.split('').map(unicodeEscape).join(''));
}

// Error formatting
export function formatError(error: Error | string): string {
  const c = getChalk();
  const message = typeof error === 'string' ? error : error.message;
  return `${c.red('Error:')} ${terminalSafe(message, process.stderr)}`;
}

// Success message
export function formatSuccess(message: string): string {
  const c = getChalk();
  return `${c.green('✓')} ${terminalSafe(message)}`;
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
  prompt_tokens_details?: { cached_tokens?: number };
}): string {
  if (!shouldShowUsage()) return '';
  if (!usage.total_tokens) return '';

  const c = getChalk();
  const parts: string[] = [];
  
  if (usage.prompt_tokens) {
    parts.push(`${c.dim('prompt:')} ${terminalSafe(usage.prompt_tokens)}`);
  }
  if (usage.prompt_tokens_details?.cached_tokens) {
    parts.push(`${c.dim('cached:')} ${terminalSafe(usage.prompt_tokens_details.cached_tokens)}`);
  }
  if (usage.completion_tokens) {
    parts.push(`${c.dim('completion:')} ${terminalSafe(usage.completion_tokens)}`);
  }
  if (usage.total_tokens) {
    parts.push(`${c.dim('total:')} ${c.bold(terminalSafe(usage.total_tokens))}`);
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
  const cell = (row: Record<string, unknown>, key: string) => terminalSafe(row[key] || '');

  // Calculate column widths
  const widths = columns.map(col => {
    const maxDataWidth = Math.max(
      ...rows.map(row => cell(row, col.key).length),
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
      const value = cell(row, col.key);
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
  const formats: OutputFormat[] = ['pretty', 'json', 'markdown', 'raw'];
  if (explicit !== undefined && !formats.includes(explicit)) {
    throw new Error(`Invalid --format "${explicit}". Use one of: ${formats.join(', ')}`);
  }
  if (explicit) return explicit;
  if (isPiped()) return 'raw';
  return 'pretty';
}
