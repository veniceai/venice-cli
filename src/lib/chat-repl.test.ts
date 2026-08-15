import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  isReplExitCommand,
  isReplHelpCommand,
  REPL_HELP,
  REPL_PROMPT,
  runChatRepl,
  shouldEnterRepl,
} from './chat-repl.js';

test('shouldEnterRepl only when there is no prompt and stdin is a TTY', () => {
  assert.equal(shouldEnterRepl('', true), true);
  assert.equal(shouldEnterRepl('   ', true), true);
  assert.equal(shouldEnterRepl('', false), false);
  assert.equal(shouldEnterRepl('', undefined), false);
  assert.equal(shouldEnterRepl('hello', true), false);
});

test('isReplExitCommand accepts exit and quit', () => {
  assert.equal(isReplExitCommand('exit'), true);
  assert.equal(isReplExitCommand('QUIT'), true);
  assert.equal(isReplExitCommand('  quit  '), true);
  assert.equal(isReplExitCommand('hello'), false);
});

test('isReplHelpCommand only accepts /help', () => {
  assert.equal(isReplHelpCommand('/HELP'), true);
  assert.equal(isReplHelpCommand('help'), false);
});

test('runChatRepl collects turns until exit without requiring a TTY', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const turns: string[] = [];
  const signals: AbortSignal[] = [];
  let outputText = '';
  output.on('data', (chunk) => {
    outputText += chunk.toString();
  });

  const done = runChatRepl({
    input,
    output,
    onTurn: async (line, signal) => {
      turns.push(line);
      signals.push(signal);
    },
  });

  input.write('hello\n');
  input.write('\n');
  input.write('/help\n');
  input.write('next turn\n');
  input.write('exit\n');
  input.end();

  await done;
  assert.deepEqual(turns, ['hello', 'next turn']);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.match(outputText, new RegExp(REPL_PROMPT));
  assert.match(outputText, new RegExp(REPL_HELP));
});

test('runChatRepl aborts the active turn when input closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let activeSignal: AbortSignal | undefined;
  let abortEvents = 0;
  let markTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });

  const done = runChatRepl({
    input,
    output,
    onTurn: async (_line, signal) => {
      activeSignal = signal;
      markTurnStarted?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          abortEvents++;
          resolve();
        }, { once: true });
      });
    },
  });

  input.write('stall\n');
  await turnStarted;
  input.end();
  await done;

  assert.equal(activeSignal?.aborted, true);
  assert.equal(abortEvents, 1);
});
