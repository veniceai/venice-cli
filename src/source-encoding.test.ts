import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_FILE = /\.(ts|js|mjs|cjs|json|py|sh)$/;

function sourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

test('source files are UTF-8 without a byte order mark and use LF line endings', () => {
  const files = ['src', 'scripts', 'examples'].flatMap((dir) => sourceFiles(join(root, dir)));
  const names = files.map((file) => relative(root, file).split('\\').join('/'));
  assert.ok(names.includes('src/lib/e2ee.ts') && names.includes('src/lib/tee.ts'));

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const problems: string[] = [];
  files.forEach((file, index) => {
    const bytes = readFileSync(file);
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      problems.push(`${names[index]}: not valid UTF-8`);
      return;
    }
    if (text.startsWith('\ufeff')) problems.push(`${names[index]}: starts with a byte order mark`);
    if (text.includes('\0')) problems.push(`${names[index]}: contains NUL bytes`);
    if (text.includes('\r')) problems.push(`${names[index]}: contains CR line endings`);
  });
  assert.deepEqual(problems, []);
});
