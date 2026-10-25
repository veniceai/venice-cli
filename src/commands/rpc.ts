/**
 * RPC Command - Proxy JSON-RPC requests to blockchain nodes
 */

import { Command } from 'commander';
import * as fs from 'fs';
import {
  cryptoRpc,
  listCryptoNetworks,
  validateIdempotencyKey,
  type CryptoRpcResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../lib/api.js';
import {
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import type { OutputFormat } from '../types/index.js';

export const MAX_RPC_BATCH = 100;
export const MAX_RPC_BATCH_BYTES = 1024 * 1024;

export function registerRpcCommand(program: Command): void {
  program
    .command('rpc [network] [method] [params...]')
    .description('Proxy JSON-RPC requests to blockchain nodes')
    .option('--batch <file>', 'JSON array of JSON-RPC requests (max 100 items, 1 MiB)')
    .option(
      '--idempotency-key <key>',
      'Reuse a key ([A-Za-z0-9_-], max 255) to safely retry across invocations'
    )
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .addHelpText(
      'after',
      `
Examples:
  $ venice rpc networks
  $ venice rpc ethereum-mainnet eth_blockNumber
  $ venice rpc base-mainnet eth_getBalance 0x... latest
  $ venice rpc ethereum-mainnet --batch reqs.json
  $ venice rpc base-mainnet eth_sendRawTransaction 0x... --idempotency-key tx-42`
    )
    .action(async (network: string | undefined, method: string | undefined, params: string[], options) => {
      const format = detectOutputFormat(options.format);

      try {
        if (options.idempotencyKey !== undefined) {
          validateIdempotencyKey(options.idempotencyKey);
        }

        if (!network || network === 'networks') {
          if (options.batch) {
            console.error(formatError('Network is required for --batch. Usage: venice rpc <network> --batch <file>'));
            process.exit(1);
          }
          if (options.idempotencyKey !== undefined) {
            console.error(formatError('--idempotency-key applies only to RPC calls, not "venice rpc networks".'));
            process.exit(1);
          }
          await printNetworks(format);
          return;
        }

        if (options.batch && method) {
          console.error(formatError('Use either a method or --batch, not both.'));
          process.exit(1);
        }

        let body: JsonRpcRequest | JsonRpcRequest[];

        if (options.batch) {
          body = readBatchFile(options.batch);
        } else if (!method) {
          console.error(formatError('Missing JSON-RPC method.'));
          console.error('Usage: venice rpc <network> <method> [params...]');
          console.error('       venice rpc <network> --batch <file>');
          console.error('       venice rpc networks');
          process.exit(1);
        } else {
          body = buildJsonRpcRequest(method, params);
        }

        const result = await cryptoRpc(network, body, {
          idempotencyKey: options.idempotencyKey,
        });
        printRpcResult(result, format);

        if (jsonRpcHasError(result.body)) {
          process.exit(1);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

async function printNetworks(format: OutputFormat): Promise<void> {
  const networks = await listCryptoNetworks();
  const c = getChalk();

  if (format === 'json') {
    console.log(JSON.stringify({ networks }, null, 2));
    return;
  }

  if (format === 'raw') {
    console.log(networks.join('\n'));
    return;
  }

  if (networks.length === 0) {
    console.log(c.yellow('No RPC networks returned.'));
    return;
  }

  console.log(c.bold(`\nSupported RPC networks (${networks.length})\n`));
  for (const slug of networks) {
    console.log(`  ${c.cyan(slug)}`);
  }
}

export function parseRpcParam(token: string): unknown {
  const trimmed = token.trim();
  if (!looksLikeJson(trimmed)) {
    return token;
  }

  validateRawJsonNumbers(trimmed, 'parameter');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`Invalid JSON parameter: ${token}`);
  }

  return parsed;
}

function validateRawJsonNumbers(json: string, context: 'parameter' | 'batch file'): void {
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  for (let index = 0; index < json.length;) {
    if (json[index] === '"') {
      index++;
      while (index < json.length) {
        if (json[index] === '\\') {
          index += 2;
        } else if (json[index] === '"') {
          index++;
          break;
        } else {
          index++;
        }
      }
      continue;
    }

    numberPattern.lastIndex = index;
    const match = numberPattern.exec(json);
    if (!match) {
      index++;
      continue;
    }

    const literal = match[0];
    const value = Number(literal);
    if (
      !Number.isFinite(value) ||
      exceedsSafeIntegerMagnitude(literal)
    ) {
      throw new Error(
        `Unsafe numeric literal in JSON ${context}: ${literal}. ` +
        'Quote it as a string or use a chain-native hex quantity.'
      );
    }
    index += literal.length;
  }
}

function exceedsSafeIntegerMagnitude(literal: string): boolean {
  const unsigned = literal.startsWith('-') ? literal.slice(1) : literal;
  const [mantissa, exponentText] = unsigned.toLowerCase().split('e');
  const [integerPart, fractionPart = ''] = mantissa.split('.');
  const digits = integerPart + fractionPart;
  const firstSignificantIndex = digits.search(/[1-9]/);

  if (firstSignificantIndex === -1) {
    return false;
  }

  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (exponent === Number.POSITIVE_INFINITY) {
    return true;
  }
  if (exponent === Number.NEGATIVE_INFINITY) {
    return false;
  }

  const significantIntegerDigits =
    integerPart.length + exponent - firstSignificantIndex;
  const maxSafeDigits = String(Number.MAX_SAFE_INTEGER);

  if (significantIntegerDigits !== maxSafeDigits.length) {
    return significantIntegerDigits > maxSafeDigits.length;
  }

  const significantDigits = digits.slice(firstSignificantIndex);
  const integerDigits = significantDigits.slice(0, maxSafeDigits.length)
    .padEnd(maxSafeDigits.length, '0');

  if (integerDigits !== maxSafeDigits) {
    return integerDigits > maxSafeDigits;
  }

  return /[1-9]/.test(significantDigits.slice(maxSafeDigits.length));
}

function looksLikeJson(token: string): boolean {
  if (
    token.startsWith('{') ||
    token.startsWith('[') ||
    token.startsWith('"') ||
    token === 'true' ||
    token === 'false' ||
    token === 'null'
  ) {
    return true;
  }

  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token);
}

export function buildJsonRpcRequest(method: string, params: string[] = []): JsonRpcRequest {
  validateRpcMethod(method);
  return {
    jsonrpc: '2.0',
    method,
    params: params.map(parseRpcParam),
    id: 1,
  };
}

export function readBatchFile(filePath: string): JsonRpcRequest[] {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Batch file not found: ${filePath}`);
    }
    throw error;
  }

  let rawJson: string;
  try {
    assertBatchFileSize(fs.fstatSync(descriptor).size);

    const fileContents = Buffer.allocUnsafe(MAX_RPC_BATCH_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < fileContents.byteLength) {
      const bytesRead = fs.readSync(
        descriptor,
        fileContents,
        totalBytesRead,
        fileContents.byteLength - totalBytesRead,
        null
      );
      if (bytesRead === 0) {
        break;
      }
      totalBytesRead += bytesRead;
    }
    assertBatchFileSize(totalBytesRead);
    rawJson = fileContents.toString('utf-8', 0, totalBytesRead);
  } finally {
    fs.closeSync(descriptor);
  }

  validateRawJsonNumbers(rawJson, 'batch file');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`Batch file is not valid JSON: ${filePath}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Batch file must contain a JSON array of JSON-RPC requests');
  }

  if (parsed.length === 0) {
    throw new Error('Batch file is empty');
  }

  if (parsed.length > MAX_RPC_BATCH) {
    throw new Error(`Batch requests are limited to ${MAX_RPC_BATCH} items (got ${parsed.length})`);
  }

  for (const [index, item] of parsed.entries()) {
    validateBatchItem(item, index);
  }

  return parsed as JsonRpcRequest[];
}

function assertBatchFileSize(bytes: number): void {
  if (bytes > MAX_RPC_BATCH_BYTES) {
    throw new Error(
      `Batch file exceeds the ${MAX_RPC_BATCH_BYTES}-byte (1 MiB) limit (got ${bytes} bytes)`
    );
  }
}

function validateRpcMethod(method: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(method)) {
    throw new Error(`Invalid JSON-RPC method: ${method}`);
  }
}

function validateBatchItem(item: unknown, index: number): void {
  const label = `Batch item ${index + 1}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label} must be a JSON-RPC object`);
  }

  const request = item as Partial<JsonRpcRequest>;
  if (request.jsonrpc !== '2.0') {
    throw new Error(`${label} must set jsonrpc to "2.0"`);
  }
  if (typeof request.method !== 'string' || !request.method) {
    throw new Error(`${label} is missing a method`);
  }
  validateRpcMethod(request.method);
  if (
    typeof request.id !== 'string' &&
    (typeof request.id !== 'number' || !Number.isSafeInteger(request.id))
  ) {
    throw new Error(`${label} must have a string or safe-integer id`);
  }
  if (
    request.params !== undefined &&
    (!request.params || typeof request.params !== 'object')
  ) {
    throw new Error(`${label} params must be an array or object`);
  }
}

export function jsonRpcHasError(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(isRpcErrorItem);
  }
  return isRpcErrorItem(body);
}

function isRpcErrorItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return false;
  }
  const error = (item as JsonRpcResponse).error;
  return Boolean(error && typeof error === 'object');
}

function printRpcResult(result: CryptoRpcResult, format: OutputFormat): void {
  const c = getChalk();
  const body = result.body;

  if (format === 'json') {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (format === 'raw') {
    console.log(JSON.stringify(body));
    return;
  }

  const items = Array.isArray(body) ? body : [body];
  const multiple = Array.isArray(body);

  for (const [index, item] of items.entries()) {
    const label = multiple ? `${c.dim(`[${item.id ?? index + 1}]`)} ` : '';
    if (item.error) {
      const code = item.error.code != null ? ` (${item.error.code})` : '';
      console.error(`${label}${c.red('error:')} ${item.error.message || 'RPC error'}${code}`);
      if (item.error.data !== undefined) {
        console.error(c.dim(JSON.stringify(item.error.data, null, 2)));
      }
      continue;
    }

    const value = item.result;
    if (value === undefined) {
      console.log(`${label}${JSON.stringify(item, null, 2)}`);
    } else if (value !== null && typeof value === 'object') {
      const json = JSON.stringify(value, null, 2);
      console.log(multiple ? `${label}\n${json}` : json);
    } else {
      console.log(`${label}${String(value)}`);
    }
  }

  const costParts: string[] = [];
  if (result.credits) {
    costParts.push(`${c.dim('Credits:')} ${result.credits}`);
  }
  if (result.costUsd) {
    costParts.push(`${c.dim('Cost:')} $${result.costUsd}`);
  }
  if (costParts.length > 0) {
    console.log(`\n${costParts.join('  ')}`);
  }
}
