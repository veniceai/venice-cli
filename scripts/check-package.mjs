/**
 * Fails if `npm pack` would publish a file outside the allowlist: compiled
 * modules and declarations in dist/ (but not tests), examples/, README.md,
 * LICENSE, and package.json. Run it after `npm run build`.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/index.js'];
const TEST_PATH = /(?:^|[/._-])(?:tests?|fixtures?)(?:[/._-]|$)/;

function isAllowed(path) {
  if (['package.json', 'README.md', 'LICENSE'].includes(path)) return true;
  if (path.startsWith('examples/')) return true;
  return /^dist\/.+\.(?:js|d\.ts)$/.test(path) && !TEST_PATH.test(path.slice('dist/'.length));
}

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const files = JSON.parse(output)[0].files.map((file) => file.path);

const unexpected = files.filter((path) => !isAllowed(path));
const missing = REQUIRED.filter((path) => !files.includes(path));

if (unexpected.length > 0) {
  console.error('npm pack would publish files outside the allowlist:');
  for (const path of unexpected) console.error(`  ${path}`);
}
if (missing.length > 0) {
  console.error(`npm pack is missing required files: ${missing.join(', ')}`);
  if (missing.includes('dist/index.js')) console.error('Run "npm run build" first.');
}
if (unexpected.length > 0 || missing.length > 0) {
  process.exit(1);
}

console.log(`Package contents OK (${files.length} files).`);
