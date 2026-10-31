/**
 * Update Command - Check the npm registry for a newer release
 */

import { Command } from 'commander';
import { detectOutputFormat, getChalk } from '../lib/output.js';
import { getVersion } from '../lib/version.js';

const PACKAGE_NAME = 'veniceai-cli';
const UPDATE_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;
// Only tests may point the check at another server.
const LATEST_RELEASE_URL =
  process.env.NODE_ENV === 'test' && process.env.VENICE_UPDATE_CHECK_URL
    ? process.env.VENICE_UPDATE_CHECK_URL
    : `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_VERSION_LENGTH = 256;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  updateCommand: string | null;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check the npm registry for a newer release')
    .option('--check', 'Compare this version with the latest release on npm')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      if (!options.check) {
        console.error('Run "venice update --check" to check the npm registry for a newer release.');
        process.exitCode = 1;
        return;
      }

      const result = await checkForUpdate();
      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const c = getChalk();
      console.log(`${c.dim('Current version:')} ${result.currentVersion}`);
      console.log(`${c.dim('Latest version:')}  ${result.latestVersion}`);
      if (result.updateAvailable) {
        console.log(`\n${c.yellow('Update available.')} To install it, run:\n  ${UPDATE_COMMAND}`);
      } else {
        console.log(`\n${c.green('No newer release is available.')}`);
      }
    });
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getVersion();
  const latestVersion = await fetchLatestVersion();
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    updateCommand: updateAvailable ? UPDATE_COMMAND : null,
  };
}

/**
 * Reads the version of the latest release with a plain GET: no credentials
 * and no redirects.
 */
export async function fetchLatestVersion(
  url = LATEST_RELEASE_URL,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Update check failed: the npm registry returned HTTP ${response.status}.`);
    }
    return parseLatestVersion(await readLimitedText(response, MAX_RESPONSE_BYTES));
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Update check timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (error instanceof TypeError) {
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      throw new Error(`Update check failed: could not reach the npm registry${cause ? ` (${cause})` : ''}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = `Update check failed: the npm registry response exceeded ${maxBytes / 1024} KB.`;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    throw new Error(tooLarge);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(tooLarge);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseLatestVersion(body: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error('Update check failed: the npm registry returned invalid JSON.');
  }

  const version = (manifest as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || !parseVersion(version)) {
    throw new Error('Update check failed: the npm registry did not return a valid version.');
  }
  return version;
}

interface ParsedVersion {
  core: string[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  if (version.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

// Numeric identifiers have no leading zeros, so a longer one is larger.
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC_IDENTIFIER.test(a);
  const bNumeric = NUMERIC_IDENTIFIER.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two semantic versions by SemVer precedence, ignoring build
 * metadata. Returns a negative number, zero, or a positive number.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`Cannot compare versions "${a}" and "${b}".`);
  }

  for (let i = 0; i < 3; i++) {
    const result = compareNumeric(left.core[i], right.core[i]);
    if (result !== 0) return result;
  }

  // A release has higher precedence than any of its prereleases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const result = compareIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (result !== 0) return result;
  }
  return left.prerelease.length - right.prerelease.length;
}
