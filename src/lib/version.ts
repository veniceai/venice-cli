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
