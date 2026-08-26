import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { generateFishCompletion } from './completions.js';

const fishAvailable = spawnSync('fish', ['--version'], { encoding: 'utf8' }).status === 0;

test('Fish model filters use the first non-option command token', () => {
  const completion = generateFishCompletion();
  const condition = '__venice_using_command models';

  assert.match(completion, /function __venice_using_command\b/);
  assert.match(completion, /for token in \$tokens\[2\.\.-1\]/);
  assert.match(completion, /string match -q -- '-\*' "\$token"/);

  for (const option of ['privacy', 'tee', 'e2ee']) {
    assert.match(
      completion,
      new RegExp(
        `complete -c venice -n "${condition}" -l ${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
      )
    );
  }
});

test('generated Fish completion is valid Fish syntax', { skip: !fishAvailable }, () => {
  const result = spawnSync('fish', ['-n'], {
    input: generateFishCompletion(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
});

test('Fish model filter recognizes only top-level models command lines', { skip: !fishAvailable }, () => {
  const completion = generateFishCompletion();
  const probe = `${completion}
function __venice_probe_models
    if __venice_using_command models
        echo __venice_models_match >&2
    end
    return 1
end
complete -c venice -n "__venice_probe_models" -a __venice_probe
complete -C "$VENICE_TEST_COMMANDLINE"
`;

  for (const commandLine of [
    'venice models',
    'venice --no-color models',
    'venice models --type video',
    'venice models --search video',
  ]) {
    const result = spawnSync('fish', ['-c', probe], {
      encoding: 'utf8',
      env: { ...process.env, VENICE_TEST_COMMANDLINE: commandLine },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^__venice_models_match$/m, commandLine);
  }

  const nestedResult = spawnSync('fish', ['-c', probe], {
    encoding: 'utf8',
    env: { ...process.env, VENICE_TEST_COMMANDLINE: 'venice video models' },
  });

  assert.equal(nestedResult.status, 0, nestedResult.stderr);
  assert.doesNotMatch(nestedResult.stderr, /^__venice_models_match$/m);
});
