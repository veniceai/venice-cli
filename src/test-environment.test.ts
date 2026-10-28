import assert from 'node:assert/strict';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getConfigPath } from './lib/config.js';

function accountHomeDirectory(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

test('the suite runs with a temporary HOME instead of the account home directory', () => {
  assert.notEqual(
    homedir(),
    accountHomeDirectory(),
    'Run the tests with "npm test", which gives them a temporary HOME.'
  );
  assert.equal(getConfigPath(), join(homedir(), '.venice', 'config.json'));
});
