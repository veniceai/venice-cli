/**
 * Version utility - single source of truth for CLI version
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(join(__dirname, '../../package.json')) as { version: string };
    cachedVersion = pkg.version;
    return cachedVersion;
  } catch {
    return '0.0.0';
  }
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A skill name that is safe to send in the User-Agent as `skill/<name>`. */
export type SkillName = string & { readonly brand: 'SkillName' };

export function parseSkillName(value: string, source: string): SkillName {
  if (!SKILL_NAME.test(value)) {
    throw new Error(
      `${source} must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit (got "${value}").`
    );
  }
  return value as SkillName;
}

// Only for requests to the Venice API: downloads from other hosts must not send it.
export function getUserAgent(): string {
  const skill = process.env.VENICE_SKILL;
  const product = `veniceai-cli/${getVersion()}`;
  return skill ? `${product} skill/${parseSkillName(skill, 'VENICE_SKILL')}` : product;
}
