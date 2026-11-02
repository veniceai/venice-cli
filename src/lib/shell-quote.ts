/**
 * Commands printed for the user to paste into a shell
 */

// Words made only of these characters mean the same unquoted in POSIX shells and fish.
const PLAIN_WORD = /^[A-Za-z0-9._:/-]+$/;
const API_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const INVALID_ID_HINT = '<not shown: an ID returned by the API looked invalid>';

/**
 * Quotes a value for POSIX shells and fish. fish still reads \\ and \' as
 * escapes inside single quotes, so backslashes and quotes are written outside
 * the quotes, where every shell reads them the same way.
 */
export function shellQuote(value: string): string {
  if (PLAIN_WORD.test(value)) return value;
  return `'${value.replace(/['\\]/g, (char) => `'\\${char}'`)}'`;
}

export interface ApiId {
  readonly apiId: unknown;
}

/** Marks a value from the API that must look like an ID to be printed. */
export function apiId(value: unknown): ApiId {
  return { apiId: value };
}

export function isApiId(value: unknown): value is string {
  return typeof value === 'string' && API_ID.test(value);
}

/**
 * Template tag for a command the user may paste. Every interpolated value is
 * shell-quoted; if a value marked with apiId() does not look like an ID, the
 * whole command is replaced with INVALID_ID_HINT.
 */
export function shellCommand(literals: TemplateStringsArray, ...values: Array<string | ApiId>): string {
  let command = literals[0];
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' && !isApiId(value.apiId)) return INVALID_ID_HINT;
    const text = typeof value === 'string' ? value : value.apiId as string;
    command += shellQuote(text) + literals[index + 1];
  }
  return command;
}
