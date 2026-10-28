import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { askHidden, confirm } from './prompt.js';

type FakeInput = PassThrough & { isTTY?: boolean; rawModes: boolean[]; setRawMode(mode: boolean): FakeInput };

function fakeInput(isTTY: boolean): FakeInput {
  const input = new PassThrough() as FakeInput;
  input.isTTY = isTTY;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.rawModes.push(mode);
    return input;
  };
  return input;
}

function collector(): Writable & { text(): string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as Writable & { text(): string };
  output.text = () => chunks.join('');
  return output;
}

test('askHidden reads a line in raw mode without writing it to the output', async () => {
  const input = fakeInput(true);
  const output = collector();

  const answer = askHidden('API Key: ', { input, output });
  input.write('sk-secret-1234567890\r');

  assert.equal(await answer, 'sk-secret-1234567890');
  assert.equal(output.text(), 'API Key: \n');
  assert.deepEqual(input.rawModes, [true, false]);
});

test('askHidden rejects when input ends before a line is entered', async () => {
  const input = fakeInput(true);
  const output = collector();

  const answer = askHidden('API Key: ', { input, output });
  input.write('sk-partial');
  input.end();

  await assert.rejects(answer, /Input ended before the prompt was answered/);
  assert.equal(output.text(), 'API Key: \n');
});

test('confirm accepts only y or yes', async () => {
  for (const [typed, expected] of [['y\n', true], [' YES \n', true], ['n\n', false], ['\n', false], ['yep\n', false]] as const) {
    const input = fakeInput(true);
    const output = collector();
    const answer = confirm('Continue? [y/N] ', { input, output });
    input.write(typed);
    assert.equal(await answer, expected, JSON.stringify(typed));
    assert.equal(output.text(), 'Continue? [y/N] ');
  }
});

test('confirm rejects when input ends without an answer', async () => {
  const input = fakeInput(true);
  const answer = confirm('Continue? [y/N] ', { input, output: collector() });
  input.end();
  await assert.rejects(answer, /Input ended before the prompt was answered/);
});

test('prompts refuse input that is not a terminal', async () => {
  await assert.rejects(confirm('Continue? ', { input: fakeInput(false), output: collector() }), /stdin is not a terminal/);
  await assert.rejects(askHidden('Key: ', { input: fakeInput(false), output: collector() }), /stdin is not a terminal/);
});
