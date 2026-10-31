import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  ApiKeyCreationError,
  ApiKeyMetadata,
  ConsumptionLimits,
  assertApiKeyId,
  createApiKey,
  deleteApiKey,
  getApiKeyRateLimits,
  listApiKeys,
} from '../lib/account-api.js';
import { onInterrupt } from '../lib/interrupt.js';
import {
  detectOutputFormat,
  formatSuccess,
  formatTable,
  formatWarning,
  getChalk,
} from '../lib/output.js';

const KEY_TYPES = ['INFERENCE', 'ADMIN'] as const;
const LIMIT_PERIODS = ['EPOCH', 'MONTH', 'LIFETIME'] as const;

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command('keys')
    .description('Manage Venice API keys (requires an admin API key)');

  keys
    .command('list')
    .description('List API keys without exposing key material')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const apiKeys = await listApiKeys();
      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify(apiKeys.map(toSafeApiKeyMetadata), null, 2));
        return;
      }

      if (apiKeys.length === 0) {
        console.log(getChalk().dim('No active API keys.'));
        return;
      }

      console.log(formatTable(apiKeys.map((key) => ({
        id: key.id,
        name: key.description ?? '',
        type: key.apiKeyType,
        suffix: `…${key.last6Chars}`,
        created: key.createdAt ?? '',
        expires: key.expiresAt ?? 'never',
        lastUsed: key.lastUsedAt ?? 'never',
      })), [
        { key: 'id', label: 'ID', width: 36 },
        { key: 'name', label: 'Name', width: 20 },
        { key: 'type', label: 'Type', width: 10 },
        { key: 'suffix', label: 'Key', width: 8 },
        { key: 'expires', label: 'Expires', width: 24 },
        { key: 'lastUsed', label: 'Last used', width: 24 },
      ]));
    });

  keys
    .command('create')
    .description('Create an API key and save its secret to a restrictive file')
    .requiredOption('-n, --name <name>', 'Key name/description (max 64 characters)')
    .requiredOption('-o, --output <file>', 'New file in which to save the API key secret')
    .option('-t, --type <type>', 'Key type (INFERENCE|ADMIN)', 'INFERENCE')
    .option('--expires <date>', 'Expiration date (YYYY-MM-DD or ISO 8601 UTC)')
    .option('--usd-limit <amount>', 'USD consumption limit')
    .option('--diem-limit <amount>', 'DIEM consumption limit')
    .option('--limit-period <period>', 'Limit reset period (EPOCH|MONTH|LIFETIME)', 'EPOCH')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const description = String(options.name).trim();
      if (description.length === 0 || description.length > 64) {
        throw new Error('name must contain between 1 and 64 characters');
      }

      const apiKeyType = parseEnum(options.type, KEY_TYPES, 'type');
      const limitPeriod = parseEnum(options.limitPeriod, LIMIT_PERIODS, 'limit-period');
      const consumptionLimit: ConsumptionLimits = {};
      if (options.usdLimit !== undefined) {
        consumptionLimit.usd = parseLimit(options.usdLimit, 'usd-limit');
      }
      if (options.diemLimit !== undefined) {
        consumptionLimit.diem = parseLimit(options.diemLimit, 'diem-limit');
      }
      if (options.expires !== undefined) validateExpiration(options.expires);

      const secretFile = prepareSecretFile(String(options.output));
      const stopInterruptNotice = onInterrupt(() => {
        console.error(formatWarning(keyMayExistNotice(description)));
      });
      let created: Awaited<ReturnType<typeof createApiKey>>;
      let saveWarning: string | undefined;
      try {
        try {
          created = await createApiKey({
            apiKeyType,
            description,
            ...(options.expires ? { expiresAt: options.expires } : {}),
            ...(Object.keys(consumptionLimit).length > 0
              ? { consumptionLimit, limitPeriod }
              : {}),
          });
        } catch (error) {
          const failure = cleanUpAfterFailure(secretFile, error, '');
          if (!(error instanceof ApiKeyCreationError)) {
            throw new Error(failure);
          }
          if (error.keyId === undefined) {
            throw new Error(`${failure}\n${keyMayExistNotice(description)}`);
          }
          throw await deleteUnsavedKey(error.keyId, failure, '');
        }

        try {
          saveWarning = secretFile.commit(created.apiKey);
        } catch (saveError) {
          const saveFailure = cleanUpAfterFailure(secretFile, saveError, created.apiKey);
          throw await deleteUnsavedKey(
            created.id,
            `Failed to save the API key secret (${saveFailure})`,
            created.apiKey
          );
        }
      } finally {
        stopInterruptNotice();
      }

      if (saveWarning !== undefined) {
        console.error(formatWarning(saveWarning));
      }

      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify({
          ...toSafeApiKeyMetadata(created),
          secretFile: secretFile.path,
        }, null, 2));
        return;
      }

      console.log(formatSuccess(`Created ${created.apiKeyType} API key "${created.description ?? description}"`));
      console.log(`ID: ${created.id}`);
      console.log(`Secret saved to: ${secretFile.path}`);
      console.error(formatWarning('The API key secret is never printed and Venice will not show it again.'));
    });

  keys
    .command('delete <id>')
    .description('Permanently delete an API key')
    .option('--force', 'Delete without an interactive confirmation')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (id: string, options) => {
      const normalizedId = id.trim();
      assertApiKeyId(normalizedId);

      if (!options.force) {
        if (!stdin.isTTY || !stdout.isTTY) {
          throw new Error('Refusing to delete non-interactively without --force');
        }
        const readline = createInterface({ input: stdin, output: stdout });
        try {
          const answer = await readline.question(
            `Permanently delete API key ${normalizedId}? Type "delete" to confirm: `
          );
          if (answer !== 'delete') {
            console.log('Deletion cancelled.');
            return;
          }
        } finally {
          readline.close();
        }
      }

      await deleteApiKey(normalizedId);
      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify({ success: true, id: normalizedId }));
      } else {
        console.log(formatSuccess(`Deleted API key ${normalizedId}`));
      }
    });

  keys
    .command('rate-limits')
    .description('Show balances and rate limits for the current API key')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const limits = await getApiKeyRateLimits();
      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify(limits, null, 2));
        return;
      }

      const c = getChalk();
      console.log(c.bold('\nAPI Key Access\n'));
      console.log(`Access permitted: ${limits.accessPermitted ? c.green('yes') : c.red('no')}`);
      console.log(`Tier: ${limits.apiTier.id}`);
      console.log(`Charged: ${limits.apiTier.isCharged ? 'yes' : 'no'}`);
      console.log(`USD balance: ${limits.balances.USD}`);
      console.log(`DIEM balance: ${limits.balances.DIEM}`);
      console.log(`Key expiration: ${limits.keyExpiration ?? 'never'}`);
      console.log(`Next epoch: ${limits.nextEpochBegins}`);

      const rows = limits.rateLimits.flatMap((model) =>
        model.rateLimits.map((limit) => ({
          model: model.apiModelId ?? 'all',
          type: limit.type,
          amount: limit.amount,
        }))
      );
      if (rows.length > 0) {
        console.log(`\n${formatTable(rows, [
          { key: 'model', label: 'Model', width: 34 },
          { key: 'type', label: 'Limit', width: 10 },
          { key: 'amount', label: 'Amount', width: 12 },
        ])}`);
      }
    });
}

function parseEnum<const T extends readonly string[]>(
  value: string,
  allowed: T,
  label: string
): T[number] {
  const normalized = String(value).toUpperCase();
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return normalized as T[number];
}

function parseLimit(value: string, label: string): number {
  if (String(value).trim() === '') throw new Error(`${label} must be a number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9_999_999_999) {
    throw new Error(`${label} must be between 0 and 9999999999`);
  }
  return parsed;
}

function validateExpiration(value: string): void {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const utcDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if ((!dateOnly.test(value) && !utcDateTime.test(value)) || Number.isNaN(Date.parse(value))) {
    throw new Error('expires must be YYYY-MM-DD or an ISO 8601 UTC timestamp');
  }
}

function toSafeApiKeyMetadata(key: ApiKeyMetadata): ApiKeyMetadata {
  return {
    apiKeyType: key.apiKeyType,
    consumptionLimits: key.consumptionLimits,
    limitPeriod: key.limitPeriod,
    createdAt: key.createdAt,
    ...(key.description === undefined ? {} : { description: key.description }),
    expiresAt: key.expiresAt,
    id: key.id,
    last6Chars: key.last6Chars,
    lastUsedAt: key.lastUsedAt,
    ...(key.usage === undefined ? {} : { usage: key.usage }),
    ...(key.currentPeriodUsage === undefined
      ? {}
      : { currentPeriodUsage: key.currentPeriodUsage }),
  };
}

function prepareSecretFile(output: string): {
  path: string;
  commit: (secret: string) => string | undefined;
  cleanup: () => void;
} {
  const requestedDestination = resolve(output);
  const canonicalParent = realpathSync(dirname(requestedDestination));
  const parentStat = lstatSync(canonicalParent);
  if (!parentStat.isDirectory()) {
    throw new Error('API key output directory must be a directory');
  }
  const destination = resolve(canonicalParent, basename(requestedDestination));
  try {
    lstatSync(destination);
    throw new Error(`Refusing to overwrite API key output: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = resolve(
    canonicalParent,
    `.${basename(destination)}-${process.pid}-${randomUUID()}.tmp`
  );
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  let open = true;
  let committed = false;

  const secretFile = {
    path: destination,
    commit(secret: string) {
      writeFileSync(descriptor, `${secret}\n`, { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      open = false;
      linkSync(temporary, destination);
      committed = true;
      stopInterruptCleanup();

      try {
        unlinkSync(temporary);
        return undefined;
      } catch {
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Verify below whether the duplicate still exists.
        }

        try {
          lstatSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
        }

        return (
          `The API key was created and saved, but a 0600 temporary duplicate remains at ` +
          `${temporary}. Remove this temporary file.`
        );
      }
    },
    cleanup() {
      if (committed) return;
      stopInterruptCleanup();
      const failures: string[] = [];
      if (open) {
        try {
          closeSync(descriptor);
          open = false;
        } catch (error) {
          failures.push(describeCleanupFailure('close', error));
        }
      }
      try {
        rmSync(temporary, { force: true });
      } catch (error) {
        failures.push(describeCleanupFailure('remove', error));
      }
      if (failures.length > 0) {
        throw new Error(
          `Failed to clean up temporary API key file ${temporary}: ${failures.join('; ')}`
        );
      }
    },
  };
  const stopInterruptCleanup = onInterrupt(() => secretFile.cleanup());
  return secretFile;
}

// Removes the unused secret file and describes `error`, plus any cleanup failure.
function cleanUpAfterFailure(
  secretFile: ReturnType<typeof prepareSecretFile>,
  error: unknown,
  secret: string
): string {
  const failure = summarizeError(error, secret);
  try {
    secretFile.cleanup();
    return failure;
  } catch (cleanupError) {
    return `${failure}; local temporary-file cleanup failed: ${summarizeError(cleanupError, secret)}`;
  }
}

async function deleteUnsavedKey(keyId: string, failure: string, secret: string): Promise<Error> {
  try {
    await deleteApiKey(keyId);
  } catch (rollbackError) {
    return new Error(
      `${failure}. Automatic deletion also failed (${summarizeError(rollbackError, secret)}). ` +
      `The secret was not saved; delete the newly created key with: ` +
      `venice keys delete ${keyId} --force`
    );
  }
  return new Error(`${failure}. New API key ${keyId} was deleted; the secret was not saved.`);
}

function keyMayExistNotice(description: string): string {
  return (
    `The API key ${JSON.stringify(description)} may have been created, but its secret was not saved. ` +
    'Check with "venice keys list" and delete it with "venice keys delete <id>".'
  );
}

function describeCleanupFailure(operation: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `${operation} failed${typeof code === 'string' ? ` (${code})` : ''}`;
}

function summarizeError(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret.length === 0 ? message : message.split(secret).join('[REDACTED]');
}
