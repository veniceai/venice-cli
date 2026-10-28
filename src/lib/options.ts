/**
 * Strict parsers for numeric command-line options. Values must be plain
 * decimal numbers: no hex, exponents, padding, blanks or trailing text.
 */

const INTEGER_PATTERN = /^-?\d+$/;
const DECIMAL_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

export interface NumberOptionRange {
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  allowed?: readonly number[];
}

export function parseIntegerOption(value: string, option: string, range?: NumberOptionRange): number;
export function parseIntegerOption(
  value: string | undefined,
  option: string,
  range?: NumberOptionRange
): number | undefined;
export function parseIntegerOption(
  value: string | undefined,
  option: string,
  range: NumberOptionRange = {}
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = INTEGER_PATTERN.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || !isInRange(parsed, range)) {
    throw invalidOption(option, value, 'an integer', range);
  }
  return parsed;
}

export function parseDecimalOption(value: string, option: string, range?: NumberOptionRange): number;
export function parseDecimalOption(
  value: string | undefined,
  option: string,
  range?: NumberOptionRange
): number | undefined;
export function parseDecimalOption(
  value: string | undefined,
  option: string,
  range: NumberOptionRange = {}
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = DECIMAL_PATTERN.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !isInRange(parsed, range)) {
    throw invalidOption(option, value, 'a number', range);
  }
  return parsed;
}

function isInRange(value: number, range: NumberOptionRange): boolean {
  if (range.allowed && !range.allowed.includes(value)) return false;
  if (range.min !== undefined && (range.exclusiveMin ? value <= range.min : value < range.min)) {
    return false;
  }
  return range.max === undefined || value <= range.max;
}

function invalidOption(option: string, value: string, kind: string, range: NumberOptionRange): Error {
  return new Error(`${option} must be ${describeRange(kind, range)} (got ${JSON.stringify(value)}).`);
}

function describeRange(kind: string, range: NumberOptionRange): string {
  const { min, max, exclusiveMin, allowed } = range;
  if (allowed) {
    return allowed.length > 2
      ? `${allowed.slice(0, -1).join(', ')}, or ${allowed[allowed.length - 1]}`
      : allowed.join(' or ');
  }
  if (min !== undefined && max !== undefined) {
    return exclusiveMin
      ? `${kind} greater than ${min} and at most ${max}`
      : `${kind} between ${min} and ${max}`;
  }
  if (min !== undefined) {
    if (exclusiveMin) return `${kind} greater than ${min}`;
    return kind === 'an integer' && min === 1 ? 'a positive integer' : `${kind} of at least ${min}`;
  }
  return max !== undefined ? `${kind} of at most ${max}` : kind;
}
