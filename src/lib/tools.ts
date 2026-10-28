/**
 * Built-in Tools for Function Calling
 * 
 * These tools can be used with --tools flag in chat command.
 */

import type { ToolDefinition } from '../types/index.js';
import { randomInt, randomUUID } from 'crypto';
import { escapeInvisible, getChalk } from './output.js';
import { confirm } from './prompt.js';

// Built-in tool definitions
export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  calculator: {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Perform mathematical calculations. Supports basic arithmetic, powers, roots, and common math functions.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)", "sin(3.14)")',
          },
        },
        required: ['expression'],
      },
    },
  },

  weather: {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Get current weather information for a location. Note: This is a simulated tool for demonstration.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name or location (e.g., "San Francisco, CA")',
          },
          units: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: 'Temperature units',
          },
        },
        required: ['location'],
      },
    },
  },

  datetime: {
    type: 'function',
    function: {
      name: 'datetime',
      description: 'Get current date and time information',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'Timezone (e.g., "America/New_York", "UTC")',
          },
          format: {
            type: 'string',
            description: 'Output format: "full", "date", "time", or custom strftime format',
          },
        },
        required: [],
      },
    },
  },

  random: {
    type: 'function',
    function: {
      name: 'random',
      description: 'Generate random numbers or make random selections',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['number', 'choice', 'uuid'],
            description: 'Type of random value to generate',
          },
          min: {
            type: 'integer',
            description: 'Minimum value (for number type)',
          },
          max: {
            type: 'integer',
            description: 'Maximum value (for number type)',
          },
          choices: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of choices to pick from (for choice type)',
          },
        },
        required: ['type'],
      },
    },
  },

  base64: {
    type: 'function',
    function: {
      name: 'base64',
      description: 'Encode or decode base64 strings',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['encode', 'decode'],
            description: 'Whether to encode or decode',
          },
          text: {
            type: 'string',
            description: 'Text to encode or decode',
          },
        },
        required: ['action', 'text'],
      },
    },
  },

  hash: {
    type: 'function',
    function: {
      name: 'hash',
      description: 'Generate hash of text',
      parameters: {
        type: 'object',
        properties: {
          algorithm: {
            type: 'string',
            enum: ['md5', 'sha1', 'sha256', 'sha512'],
            description: 'Hash algorithm to use',
          },
          text: {
            type: 'string',
            description: 'Text to hash',
          },
        },
        required: ['algorithm', 'text'],
      },
    },
  },
};

export const MAX_CALCULATOR_EXPRESSION_LENGTH = 1024;

// Safe math expression evaluator without eval/Function. Grammar, loosest first:
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/' | '%') unary)*
//   unary      := ('+' | '-') unary | power
//   power      := primary ('^' unary)?
//   primary    := number | constant | function '(' expression (',' expression)* ')' | '(' expression ')'
// so -2^2 is -(2^2), 2^-2 is 2^(-2), and ^ is right-associative.
function safeEvaluateMath(expression: string): number {
  if (expression.length > MAX_CALCULATOR_EXPRESSION_LENGTH) {
    throw new Error(
      `Expression exceeds the ${MAX_CALCULATOR_EXPRESSION_LENGTH}-character limit`
    );
  }
  return new MathParser(tokenize(expression)).parse();
}

type Token =
  | { type: 'number'; value: number; text: string }
  | { type: 'name'; value: string }
  | { type: 'symbol'; value: string };

interface MathFunction {
  // Omitted for functions that take one or more arguments.
  arity?: number;
  apply: (args: number[]) => number;
}

const MATH_FUNCTIONS: Record<string, MathFunction> = {
  sqrt: { arity: 1, apply: ([x]) => Math.sqrt(x) },
  sin: { arity: 1, apply: ([x]) => Math.sin(x) },
  cos: { arity: 1, apply: ([x]) => Math.cos(x) },
  tan: { arity: 1, apply: ([x]) => Math.tan(x) },
  log: { arity: 1, apply: ([x]) => Math.log(x) },
  log10: { arity: 1, apply: ([x]) => Math.log10(x) },
  exp: { arity: 1, apply: ([x]) => Math.exp(x) },
  abs: { arity: 1, apply: ([x]) => Math.abs(x) },
  pow: { arity: 2, apply: ([x, y]) => Math.pow(x, y) },
  floor: { arity: 1, apply: ([x]) => Math.floor(x) },
  ceil: { arity: 1, apply: ([x]) => Math.ceil(x) },
  round: { arity: 1, apply: ([x]) => Math.round(x) },
  min: { apply: (args) => args.reduce((a, b) => Math.min(a, b)) },
  max: { apply: (args) => args.reduce((a, b) => Math.max(a, b)) },
};

const MATH_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const NUMBER_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const SYMBOLS = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',']);

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const char = expression[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = i + 1;
      while (end < expression.length && /[0-9.]/.test(expression[end])) end++;
      const text = expression.slice(i, end);
      if (!NUMBER_PATTERN.test(text)) {
        throw new Error(`Invalid number: ${text}`);
      }
      tokens.push({ type: 'number', value: Number(text), text });
      i = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = i + 1;
      while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) end++;
      tokens.push({ type: 'name', value: expression.slice(i, end) });
      i = end;
      continue;
    }

    if (SYMBOLS.has(char)) {
      tokens.push({ type: 'symbol', value: char });
      i++;
      continue;
    }

    throw new Error(`Unexpected character: ${char}`);
  }

  return tokens;
}

function describeToken(token: Token): string {
  return token.type === 'number' ? token.text : token.value;
}

class MathParser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.parseExpression();
    const extra = this.tokens[this.position];
    if (extra) {
      throw new Error(`Unexpected "${describeToken(extra)}"`);
    }
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (this.peekSymbol('+') || this.peekSymbol('-')) {
      const operator = this.next().value;
      const right = this.parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    while (this.peekSymbol('*') || this.peekSymbol('/') || this.peekSymbol('%')) {
      const operator = this.next().value;
      const right = this.parseUnary();
      if (operator === '*') {
        value *= right;
      } else if (operator === '/') {
        if (right === 0) throw new Error('Division by zero');
        value /= right;
      } else {
        value %= right;
      }
    }
    return value;
  }

  private parseUnary(): number {
    if (this.peekSymbol('-')) {
      this.position++;
      return -this.parseUnary();
    }
    if (this.peekSymbol('+')) {
      this.position++;
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    if (this.peekSymbol('^')) {
      this.position++;
      return Math.pow(base, this.parseUnary());
    }
    return base;
  }

  private parsePrimary(): number {
    const token = this.next();

    if (token.type === 'number') {
      return token.value;
    }

    if (token.type === 'name') {
      const name = token.value.toLowerCase();
      if (Object.hasOwn(MATH_FUNCTIONS, name)) {
        return this.parseCall(name);
      }
      if (Object.hasOwn(MATH_CONSTANTS, name)) {
        return MATH_CONSTANTS[name];
      }
      throw new Error(`Unknown identifier: ${token.value}`);
    }

    if (token.value === '(') {
      const value = this.parseExpression();
      this.expectSymbol(')');
      return value;
    }

    throw new Error(`Unexpected "${token.value}"`);
  }

  private parseCall(name: string): number {
    this.expectSymbol('(');
    const args = [this.parseExpression()];
    while (this.peekSymbol(',')) {
      this.position++;
      args.push(this.parseExpression());
    }
    this.expectSymbol(')');

    const fn = MATH_FUNCTIONS[name];
    if (fn.arity !== undefined && args.length !== fn.arity) {
      throw new Error(
        `${name} takes ${fn.arity} argument${fn.arity === 1 ? '' : 's'}, got ${args.length}`
      );
    }
    return fn.apply(args);
  }

  private peekSymbol(symbol: string): boolean {
    const token = this.tokens[this.position];
    return token?.type === 'symbol' && token.value === symbol;
  }

  private expectSymbol(symbol: string): void {
    const token = this.tokens[this.position];
    if (token?.type !== 'symbol' || token.value !== symbol) {
      throw new Error(
        token ? `Expected "${symbol}" but found "${describeToken(token)}"` : `Expected "${symbol}"`
      );
    }
    this.position++;
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (!token) {
      throw new Error('Unexpected end of expression');
    }
    this.position++;
    return token;
  }
}

// Tool execution functions
const toolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  async calculator(args: Record<string, unknown>): Promise<string> {
    try {
      const expression = args.expression as string;
      const result = safeEvaluateMath(expression);
      if (!Number.isFinite(result)) {
        return `Error: Result is ${result}`;
      }
      return `Result: ${result}`;
    } catch (error) {
      return `Error evaluating expression: ${error instanceof Error ? error.message : String(error)}`;
    }
  },

  async weather(args: Record<string, unknown>): Promise<string> {
    const location = args.location as string;
    const units = (args.units as string) || 'fahrenheit';
    
    // Simulated weather data - clearly marked as demonstration
    const temp = units === 'celsius' 
      ? Math.round(15 + Math.random() * 20)
      : Math.round(60 + Math.random() * 30);
    const conditions = ['sunny', 'partly cloudy', 'cloudy', 'light rain', 'clear'];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    
    return JSON.stringify({
      location,
      temperature: `${temp}°${units === 'celsius' ? 'C' : 'F'}`,
      conditions: condition,
      humidity: `${Math.round(40 + Math.random() * 40)}%`,
      simulated: true,
      note: 'This is simulated data for demonstration. Integrate a real weather API for production use.',
    }, null, 2);
  },

  async datetime(args: Record<string, unknown>): Promise<string> {
    const now = new Date();
    const timezone = args.timezone as string | undefined;
    const format = args.format as string | undefined;
    
    if (timezone) {
      try {
        return now.toLocaleString('en-US', { timeZone: timezone });
      } catch {
        return `Invalid timezone: ${timezone}. Using local time: ${now.toLocaleString()}`;
      }
    }
    
    switch (format) {
      case 'date':
        return now.toLocaleDateString();
      case 'time':
        return now.toLocaleTimeString();
      case 'full':
      default:
        return now.toLocaleString();
    }
  },

  async random(args: Record<string, unknown>): Promise<string> {
    const type = args.type as string;
    const min = typeof args.min === 'number' ? args.min : 0;
    const max = typeof args.max === 'number' ? args.max : 100;
    const choices = args.choices as string[] | undefined;

    switch (type) {
      case 'number': {
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
          return 'Error: min and max must be safe integers';
        }
        if (min > max) return 'Error: min cannot be greater than max';
        // crypto.randomInt draws from [min, max) and needs max - min < 2^48.
        if (max - min >= 2 ** 48 - 1) {
          return 'Error: max - min must be less than 2^48 - 1';
        }
        const result = randomInt(min, max + 1);
        return `Random number between ${min} and ${max}: ${result}`;
      }
      case 'choice': {
        if (!choices?.length) {
          return 'Error: No choices provided';
        }
        const choice = choices[randomInt(choices.length)];
        return `Random choice: ${choice}`;
      }
      case 'uuid': {
        return `UUID: ${randomUUID()}`;
      }
      default:
        return `Unknown random type: ${type}`;
    }
  },

  async base64(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const text = args.text as string;
    
    if (action === 'encode') {
      return Buffer.from(text).toString('base64');
    } else {
      try {
        return Buffer.from(text, 'base64').toString('utf-8');
      } catch {
        return 'Error: Invalid base64 string';
      }
    }
  },

  async hash(args: Record<string, unknown>): Promise<string> {
    const algorithm = args.algorithm as string;
    const text = args.text as string;
    const validAlgorithms = ['md5', 'sha1', 'sha256', 'sha512'];
    
    if (!validAlgorithms.includes(algorithm)) {
      return `Error: Invalid hash algorithm "${algorithm}". Use one of: ${validAlgorithms.join(', ')}`;
    }
    
    const crypto = await import('crypto');
    const hash = crypto.createHash(algorithm);
    hash.update(text);
    return hash.digest('hex');
  },
};

export function getToolDefinitions(toolNames: string[]): ToolDefinition[] {
  return toolNames
    .map(name => BUILTIN_TOOLS[name])
    .filter(Boolean);
}

export function listAvailableTools(): string[] {
  return Object.keys(BUILTIN_TOOLS);
}

export async function executeTool(
  name: string,
  args: unknown,
  options: {
    interactive?: boolean;
    allowedTools?: ReadonlySet<string> | readonly string[];
  } = {}
): Promise<string> {
  const allowedTools = options.allowedTools;
  if (allowedTools) {
    const isAllowed = Array.isArray(allowedTools)
      ? allowedTools.includes(name)
      : (allowedTools as ReadonlySet<string>).has(name);
    if (!isAllowed) {
      return `Tool not enabled: ${name}`;
    }
  }

  const executor = toolExecutors[name];
  if (!executor) {
    return `Unknown tool: ${name}`;
  }

  // Interactive approval mode
  if (options.interactive) {
    const approved = await promptForApproval(name, args);
    if (!approved) {
      return 'Tool execution cancelled by user';
    }
  }

  try {
    return await executor(args as Record<string, unknown>);
  } catch (error) {
    return `Tool error: ${error}`;
  }
}

async function promptForApproval(name: string, args: unknown): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Tool calls need approval on a terminal, but stdin is not a terminal. ' +
      'Run the command in a terminal, or omit --interactive-tools.'
    );
  }
  const c = getChalk();
  
  console.log('\n' + c.yellow('⚡ Tool Call Request'));
  console.log(`${c.cyan('Tool:')} ${escapeInvisible(name)}`);
  console.log(`${c.cyan('Args:')} ${escapeInvisible(String(JSON.stringify(args, null, 2)))}`);

  return confirm(c.yellow('\nApprove? [y/N] '));
}

export function formatToolsHelp(): string {
  const c = getChalk();
  const lines: string[] = [
    c.bold('Available Tools:'),
    '',
  ];

  for (const [name, def] of Object.entries(BUILTIN_TOOLS)) {
    lines.push(`  ${c.cyan(name)}`);
    lines.push(`    ${def.function.description}`);
    lines.push('');
  }

  lines.push(c.dim('Usage: venice chat "prompt" --tools calculator,weather'));
  
  return lines.join('\n');
}
