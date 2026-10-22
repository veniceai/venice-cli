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

  const promptCount = () => outputText.split(REPL_PROMPT).length - 1;
  const send = async (line: string) => {
    const before = promptCount();
    input.write(`${line}\n`);
    while (promptCount() === before) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  await send('hello');
  await send('');
  await send('/help');
  await send('next turn');
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

test('runChatRepl routes question answers to the turn instead of starting a new turn', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const turns: string[] = [];
  const answers: string[] = [];
  let markAsked: (() => void) | undefined;
  const asked = new Promise<void>((resolve) => {
    markAsked = resolve;
  });

  const done = runChatRepl({
    input,
    output,
    onTurn: async (line, _signal, askQuestion) => {
      turns.push(line);
      if (line === 'needs approval') {
        const answer = askQuestion('Approve? ');
        markAsked?.();
        answers.push(await answer);
      }
    },
  });

  input.write('needs approval\n');
  await asked;
  input.write('y\n');
  while (turns.length === 1 && answers.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  input.write('next turn\n');
  input.write('exit\n');
  input.end();

  await done;
  assert.deepEqual(turns, ['needs approval', 'next turn']);
  assert.deepEqual(answers, ['y']);
});

test('runChatRepl drops lines entered while a turn runs instead of queueing them', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk) => {
    outputText += chunk.toString();
  });
  const turns: string[] = [];
  let finishTurn: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const done = runChatRepl({
    input,
    output,
    onTurn: async (line) => {
      turns.push(line);
      if (turns.length === 1) {
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
      }
    },
  });

  input.write('slow turn\n');
  await started;
  input.write('typed while busy\n');
  input.write('y\n');
  await new Promise((resolve) => setImmediate(resolve));
  finishTurn?.();
  await new Promise((resolve) => setImmediate(resolve));
  input.write('exit\n');
  input.end();
  await done;

  assert.deepEqual(turns, ['slow turn']);
  assert.match(outputText, /Ignored 2 lines entered while the response was running/);
});

test('runChatRepl rejects a pending question when input closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let questionError: unknown;
  let markAsked: (() => void) | undefined;
  const asked = new Promise<void>((resolve) => {
    markAsked = resolve;
  });

  const done = runChatRepl({
    input,
    output,
    onTurn: async (_line, _signal, askQuestion) => {
      const answer = askQuestion('Approve? ');
      markAsked?.();
      try {
        await answer;
      } catch (error) {
        questionError = error;
      }
    },
  });

  input.write('needs approval\n');
  await asked;
  input.end();
  await done;

  assert.ok(questionError instanceof Error);
});
