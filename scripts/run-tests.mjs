/**
 * Runs the compiled tests in dist/ with `node --test`.
 *
 * Node 20 does not expand globs in `node --test` arguments, so the test files
 * are listed here. The tests get a temporary HOME so they never read or write
 * the developer's ~/.venice. Extra arguments are passed to `node --test`.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function findTestFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findTestFiles(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}

const files = findTestFiles(join(root, 'dist'))
  .map((file) => relative(root, file))
  .sort();

if (files.length === 0) {
  console.error('No test files found in dist/. Run "npm run build" first.');
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'venice-cli-test-home-'));
const removeHome = () => rmSync(home, { recursive: true, force: true });

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'test',
    NO_COLOR: '1',
  },
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  removeHome();
  console.error(`Could not start the test runner: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  removeHome();
  process.exit(code ?? 1);
});
