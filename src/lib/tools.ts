/**
 * Built-in Tools for Function Calling
 * 
 * These tools can be used with --tools flag in chat command.
 */

import type { ToolDefinition } from '../types/index.js';
import * as readline from 'readline';
import { getChalk } from './output.js';

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
            type: 'number',
            description: 'Minimum value (for number type)',
          },
          max: {
            type: 'number',
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

// Safe math expression evaluator without eval/Function
function safeEvaluateMath(expression: string): number {
  const tokens = tokenize(expression);
  const rpn = shuntingYard(tokens);
  return evaluateRPN(rpn);
}

type Token = { type: 'number'; value: number } | { type: 'operator'; value: string } | { type: 'function'; value: string } | { type: 'lparen' } | { type: 'rparen' } | { type: 'comma' };

const MATH_FUNCTIONS: Record<string, (args: number[]) => number> = {
  sqrt: (args) => Math.sqrt(args[0]),
  sin: (args) => Math.sin(args[0]),
  cos: (args) => Math.cos(args[0]),
  tan: (args) => Math.tan(args[0]),
  log: (args) => Math.log(args[0]),
  log10: (args) => Math.log10(args[0]),
  exp: (args) => Math.exp(args[0]),
  abs: (args) => Math.abs(args[0]),
  pow: (args) => Math.pow(args[0], args[1]),
  floor: (args) => Math.floor(args[0]),
  ceil: (args) => Math.ceil(args[0]),
  round: (args) => Math.round(args[0]),
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
};

const MATH_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const OPERATORS: Record<string, { precedence: number; assoc: 'left' | 'right' }> = {
  '+': { precedence: 1, assoc: 'left' },
  '-': { precedence: 1, assoc: 'left' },
  '*': { precedence: 2, assoc: 'left' },
  '/': { precedence: 2, assoc: 'left' },
  '%': { precedence: 2, assoc: 'left' },
  '^': { precedence: 3, assoc: 'right' },
};

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.replace(/\s+/g, '');

  while (i < s.length) {
    const char = s[i];

    if (/[0-9.]/.test(char)) {
      let num = '';
      while (i < s.length && /[0-9.]/.test(s[i])) {
        num += s[i++];
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      let name = '';
      while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) {
        name += s[i++];
      }
      const lower = name.toLowerCase();
      if (MATH_CONSTANTS[lower] !== undefined) {
        tokens.push({ type: 'number', value: MATH_CONSTANTS[lower] });
      } else if (MATH_FUNCTIONS[lower]) {
        tokens.push({ type: 'function', value: lower });
      } else {
        throw new Error(`Unknown identifier: ${name}`);
      }
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }

    if (char === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }

    if (OPERATORS[char]) {
      tokens.push({ type: 'operator', value: char });
      i++;
      continue;
    }

    throw new Error(`Unexpected character: ${char}`);
  }

  return tokens;
}

function shuntingYard(tokens: Token[]): (Token | { type: 'function'; value: string; argCount: number })[] {
  const output: (Token | { type: 'function'; value: string; argCount: number })[] = [];
  const opStack: (Token | { argCount: number })[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'number') {
      output.push(token);
    } else if (token.type === 'function') {
      opStack.push({ ...token, argCount: 1 });
    } else if (token.type === 'comma') {
      while (opStack.length > 0 && (opStack[opStack.length - 1] as Token).type !== 'lparen') {
        output.push(opStack.pop() as Token);
      }
      const fnToken = opStack.find((t): t is Token & { argCount: number } => 
        'argCount' in t && t.type === 'function'
      );
      if (fnToken) {
        fnToken.argCount++;
      }
    } else if (token.type === 'operator') {
      const o1 = OPERATORS[token.value];
      while (opStack.length > 0) {
        const top = opStack[opStack.length - 1] as Token;
        if (top.type !== 'operator') break;
        const o2 = OPERATORS[top.value];
        if (o2.precedence > o1.precedence || (o2.precedence === o1.precedence && o1.assoc === 'left')) {
          output.push(opStack.pop() as Token);
        } else {
          break;
        }
      }
      opStack.push(token);
    } else if (token.type === 'lparen') {
      opStack.push(token);
    } else if (token.type === 'rparen') {
      while (opStack.length > 0 && (opStack[opStack.length - 1] as Token).type !== 'lparen') {
        output.push(opStack.pop() as Token);
      }
      if (opStack.length === 0) throw new Error('Mismatched parentheses');
      opStack.pop();
      if (opStack.length > 0 && (opStack[opStack.length - 1] as Token).type === 'function') {
        output.push(opStack.pop() as Token & { argCount: number });
      }
    }
  }

  while (opStack.length > 0) {
    const top = opStack.pop() as Token;
    if (top.type === 'lparen' || top.type === 'rparen') {
      throw new Error('Mismatched parentheses');
    }
    output.push(top);
  }

  return output;
}

function evaluateRPN(tokens: (Token | { type: 'function'; value: string; argCount: number })[]): number {
  const stack: number[] = [];

  for (const token of tokens) {
    if (token.type === 'number') {
      stack.push(token.value);
    } else if (token.type === 'operator') {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('Invalid expression');
      switch (token.value) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': 
          if (b === 0) throw new Error('Division by zero');
          stack.push(a / b); 
          break;
        case '%': stack.push(a % b); break;
        case '^': stack.push(Math.pow(a, b)); break;
      }
    } else if (token.type === 'function') {
      const fn = MATH_FUNCTIONS[token.value];
      const argCount = 'argCount' in token ? token.argCount : 1;
      const args: number[] = [];
      for (let i = 0; i < argCount; i++) {
        const arg = stack.pop();
        if (arg === undefined) throw new Error(`Not enough arguments for ${token.value}`);
        args.unshift(arg);
      }
      stack.push(fn(args));
    }
  }

  if (stack.length !== 1) throw new Error('Invalid expression');
  return stack[0];
}

// Tool execution functions
const toolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  async calculator(args: { expression: string }): Promise<string> {
    try {
      const result = safeEvaluateMath(args.expression);
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
        if (min > max) return 'Error: min cannot be greater than max';
        const result = Math.floor(Math.random() * (max - min + 1)) + min;
        return `Random number between ${min} and ${max}: ${result}`;
      }
      case 'choice': {
        if (!choices?.length) {
          return 'Error: No choices provided';
        }
        const choice = choices[Math.floor(Math.random() * choices.length)];
        return `Random choice: ${choice}`;
      }
      case 'uuid': {
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
        return `UUID: ${uuid}`;
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
  options: { interactive?: boolean } = {}
): Promise<string> {
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
    return await executor(args);
  } catch (error) {
    return `Tool error: ${error}`;
  }
}

async function promptForApproval(name: string, args: unknown): Promise<boolean> {
  const c = getChalk();
  
  console.log('\n' + c.yellow('⚡ Tool Call Request'));
  console.log(`${c.cyan('Tool:')} ${name}`);
  console.log(`${c.cyan('Args:')} ${JSON.stringify(args, null, 2)}`);
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(c.yellow('\nApprove? [y/N] '), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
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
