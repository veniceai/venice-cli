import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFishCompletion } from './completions.js';

test('Fish model filters target top-level models regardless of preceding global options', () => {
  const completion = generateFishCompletion();
  const condition =
    '__fish_seen_subcommand_from models; and not __fish_seen_subcommand_from video';

  for (const option of ['privacy', 'tee', 'e2ee']) {
    assert.match(
      completion,
      new RegExp(
        `complete -c venice -n "${condition}" -l ${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
      )
    );
  }

  assert.doesNotMatch(completion, /commandline -opc\)\[2\] = models/);
});
